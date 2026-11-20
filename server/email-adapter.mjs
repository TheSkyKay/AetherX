#!/usr/bin/env node
/**
 * Heatwise email adapter — server-side only.
 *
 * The browser sends recipient IDs and rendered message parts, never email
 * addresses. This adapter owns the consent store, resolves each address,
 * re-checks opt-in and area overlap, injects a signed per-recipient
 * unsubscribe link, enforces idempotency and its own rate limit, and never
 * logs a full address. Credentials come from environment variables only.
 *
 *   node server/email-adapter.mjs
 *
 * Endpoints
 *   GET  /api/email/status        -> {configured, provider, from, dryRun, ...}
 *   POST /api/email/send          -> {results:[{id,status,providerMessageId,error}], accepted, failed, dryRun}
 *   GET  /api/email/unsubscribe   -> one-click HTML confirmation (?token=...)
 *   POST /api/email/unsubscribe   -> JSON ({token} in body or query)
 *
 * Safety: HEATWISE_EMAIL_DRY_RUN defaults to on. Nothing is handed to a
 * provider unless it is explicitly set to "0".
 *
 * Supported providers: resend, postmark, sendgrid. Payload shapes follow each
 * provider's public API documentation; verify them against a real account
 * before production use.
 */

import http from 'node:http';
import { createHmac } from 'node:crypto';
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';

const PORT = Number(process.env.HEATWISE_EMAIL_PORT || 8789);
const PROVIDER = (process.env.HEATWISE_EMAIL_PROVIDER || '').toLowerCase();
const API_KEY = process.env.HEATWISE_EMAIL_API_KEY || '';
const FROM = process.env.HEATWISE_EMAIL_FROM || '';
const FROM_NAME = process.env.HEATWISE_EMAIL_FROM_NAME || 'Heatwise alerts';
const REPLY_TO = process.env.HEATWISE_EMAIL_REPLY_TO || '';
const CONTACTS_FILE = process.env.HEATWISE_CONTACTS_FILE || '';
const AUDIT_FILE = process.env.HEATWISE_EMAIL_AUDIT_FILE || '';
const APP_ORIGIN = (process.env.HEATWISE_APP_ORIGIN || '').replace(/\/$/, '');
const UNSUB_SECRET = process.env.HEATWISE_EMAIL_UNSUBSCRIBE_SECRET || '';
const DRY_RUN = process.env.HEATWISE_EMAIL_DRY_RUN !== '0';
const MAX_PER_ZONE = Number(process.env.HEATWISE_EMAIL_MAX_PER_ZONE || 3);
const WINDOW_MS = Number(process.env.HEATWISE_EMAIL_WINDOW_MIN || 30) * 60000;
const MAX_RECIPIENTS = Number(process.env.HEATWISE_EMAIL_MAX_RECIPIENTS || 200);
const MAX_HTML_CHARS = 200000;
const MAX_TEXT_CHARS = 50000;
const MAX_SUBJECT_CHARS = 200;
const MAX_BODY_BYTES = 512 * 1024;

const SUPPORTED = ['resend', 'postmark', 'sendgrid'];

const zoneSends = new Map(); // zoneId -> [timestamps]
const idempotency = new Map(); // key -> {at, response}
const sentMemo = new Map(); // alertId:recipientId -> result
const contactsCache = { at: 0, list: [] };

function configured() {
  return SUPPORTED.includes(PROVIDER) && !!API_KEY && !!FROM && !!CONTACTS_FILE && !!UNSUB_SECRET;
}

function fromHeader() {
  return FROM_NAME ? `${FROM_NAME} <${FROM}>` : FROM;
}

function maskEmail(email) {
  const parts = String(email || '').split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '••••';
  const domain = parts[1].split('.');
  return parts[0].slice(0, 1) + '•••@' + domain[0].slice(0, 1) + '•••' + (domain.length > 1 ? '.' + domain[domain.length - 1] : '');
}

function normaliseEmail(email) {
  const value = String(email || '').trim();
  if (value.length > 254) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value.toLowerCase() : null;
}

function areaOverlap(contact, zoneAreas) {
  const areas = Array.isArray(contact.areas) ? contact.areas : [];
  return areas.some((a) => zoneAreas.includes(a));
}

function baseUrl() {
  return APP_ORIGIN || `http://localhost:${PORT}`;
}

function unsubscribeToken(id) {
  const payload = Buffer.from(String(id), 'utf8').toString('base64url');
  const sig = createHmac('sha256', UNSUB_SECRET || 'missing-secret').update(payload).digest('base64url').slice(0, 32);
  return `${payload}.${sig}`;
}

function verifyUnsubscribeToken(token) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', UNSUB_SECRET || 'missing-secret').update(payload).digest('base64url').slice(0, 32);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

async function loadContacts() {
  if (!CONTACTS_FILE) return [];
  if (Date.now() - contactsCache.at < 30000) return contactsCache.list;
  const raw = await readFile(CONTACTS_FILE, 'utf8');
  const json = JSON.parse(raw);
  const list = Array.isArray(json) ? json : json.recipients || [];
  contactsCache.at = Date.now();
  contactsCache.list = list;
  return list;
}

async function writeContacts(list) {
  if (!CONTACTS_FILE) throw new Error('contacts store is not configured');
  const raw = await readFile(CONTACTS_FILE, 'utf8');
  const json = JSON.parse(raw);
  if (Array.isArray(json)) {
    await writeFile(CONTACTS_FILE, JSON.stringify(list, null, 2) + '\n');
  } else {
    json.recipients = list;
    await writeFile(CONTACTS_FILE, JSON.stringify(json, null, 2) + '\n');
  }
  contactsCache.at = Date.now();
  contactsCache.list = list;
}

async function writeAudit(entry) {
  if (!AUDIT_FILE) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    await appendFile(AUDIT_FILE, line);
  } catch (err) {
    console.error('audit write failed:', err.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(url, headers, body, attempt = 1) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(attempt === 1 ? 500 : 1500);
      return postJson(url, headers, body, attempt + 1);
    }
    return { ok: res.ok, status: res.status, json, text, headers: res.headers };
  } catch (err) {
    if (attempt < 3) {
      await sleep(attempt === 1 ? 500 : 1500);
      return postJson(url, headers, body, attempt + 1);
    }
    return { ok: false, status: 0, json: { error: err.message }, text: '', headers: null };
  }
}

async function sendViaProvider(address, subject, html, text, unsubscribeUrl) {
  if (DRY_RUN) {
    return { status: 'simulated', providerMessageId: 'DRY-EMAIL-' + Math.random().toString(36).slice(2, 10).toUpperCase() };
  }
  const listUnsub = {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
  if (PROVIDER === 'resend') {
    const res = await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${API_KEY}` }, {
      from: fromHeader(),
      to: [address],
      subject,
      html,
      text,
      ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      headers: listUnsub
    });
    if (!res.ok) return { status: 'failed', error: `provider HTTP ${res.status}${res.json && res.json.message ? ': ' + res.json.message : ''}` };
    return { status: 'sent', providerMessageId: (res.json && res.json.id) || null };
  }
  if (PROVIDER === 'postmark') {
    const res = await postJson('https://api.postmarkapp.com/email', {
      'X-Postmark-Server-Token': API_KEY,
      Accept: 'application/json'
    }, {
      From: fromHeader(),
      To: address,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: 'outbound',
      ...(REPLY_TO ? { ReplyTo: REPLY_TO } : {}),
      Headers: Object.keys(listUnsub).map((Name) => ({ Name, Value: listUnsub[Name] }))
    });
    if (!res.ok) return { status: 'failed', error: `provider HTTP ${res.status}${res.json && res.json.Message ? ': ' + res.json.Message : ''}` };
    return { status: 'sent', providerMessageId: (res.json && res.json.MessageID) || null };
  }
  if (PROVIDER === 'sendgrid') {
    const res = await postJson('https://api.sendgrid.com/v3/mail/send', { Authorization: `Bearer ${API_KEY}` }, {
      personalizations: [{ to: [{ email: address }] }],
      from: { email: FROM, ...(FROM_NAME ? { name: FROM_NAME } : {}) },
      ...(REPLY_TO ? { reply_to: { email: REPLY_TO } } : {}),
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html }
      ],
      headers: listUnsub
    });
    if (!res.ok) return { status: 'failed', error: `provider HTTP ${res.status}` };
    const id = res.headers ? res.headers.get('x-message-id') : null;
    return { status: 'sent', providerMessageId: id || null };
  }
  return { status: 'failed', error: 'unsupported provider' };
}

function rateLimited(zoneId) {
  const now = Date.now();
  const list = (zoneSends.get(zoneId) || []).filter((t) => now - t < WINDOW_MS);
  zoneSends.set(zoneId, list);
  return list.length >= MAX_PER_ZONE;
}

function recordZoneSend(zoneId) {
  const list = zoneSends.get(zoneId) || [];
  list.push(Date.now());
  zoneSends.set(zoneId, list);
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function htmlResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sameOrigin(req) {
  if (!APP_ORIGIN) return true; // documented: always set this in a real deployment
  const origin = req.headers.origin;
  if (!origin) return true; // server-to-server or curl
  return origin === APP_ORIGIN;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function withUnsubscribe(html, text, url) {
  const footer = `<p style="margin:16px 0 0;font-size:12px;color:#6a736c">Unsubscribe from heatwave emails: <a href="${url}">${url}</a></p>`;
  const htmlOut = html.includes('{{UNSUBSCRIBE_URL}}')
    ? html.split('{{UNSUBSCRIBE_URL}}').join(url)
    : html + footer;
  const textOut = text.includes('{{UNSUBSCRIBE_URL}}')
    ? text.split('{{UNSUBSCRIBE_URL}}').join(url)
    : `${text}\n\nUnsubscribe: ${url}`;
  return { html: htmlOut, text: textOut };
}

async function handleSend(req, res) {
  if (!configured()) {
    return jsonResponse(res, 503, { error: 'email provider is not configured on this server' });
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return jsonResponse(res, 400, { error: err.message });
  }

  const alertId = String(body.alertId || '');
  const zoneId = String(body.zoneId || '');
  const zoneAreas = Array.isArray(body.zoneAreas) ? body.zoneAreas.map(String) : [];
  const messages = body.messages && typeof body.messages === 'object' ? body.messages : {};
  const requested = Array.isArray(body.recipients) ? body.recipients : [];
  const facts = body.facts && typeof body.facts === 'object' ? body.facts : null;
  const version = String(body.version || '');
  const idemKey = String(body.idempotencyKey || alertId);

  if (!alertId || !zoneId) return jsonResponse(res, 400, { error: 'alertId and zoneId are required' });
  if (!requested.length) return jsonResponse(res, 400, { error: 'no recipients requested' });
  if (requested.length > MAX_RECIPIENTS) return jsonResponse(res, 400, { error: 'too many recipients' });
  if (!zoneAreas.length) return jsonResponse(res, 400, { error: 'zone areas are required to check overlap' });
  if (!facts || !facts.window || !facts.source || !facts.level || !facts.dataUpdatedAt) {
    return jsonResponse(res, 400, { error: 'alert facts are incomplete: window, source, level and dataUpdatedAt are required' });
  }

  const clean = {};
  for (const [lang, msg] of Object.entries(messages)) {
    if (!msg || typeof msg !== 'object') continue;
    const subject = String(msg.subject || '').replace(/[\r\n]+/g, ' ').trim();
    const html = typeof msg.html === 'string' ? msg.html : '';
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!subject || subject.length > MAX_SUBJECT_CHARS) {
      return jsonResponse(res, 400, { error: `subject for ${lang} is empty or too long` });
    }
    if (!html || html.length > MAX_HTML_CHARS || !text || text.length > MAX_TEXT_CHARS) {
      return jsonResponse(res, 400, { error: `body for ${lang} is empty or too long` });
    }
    clean[lang] = { subject, html, text };
  }
  if (!Object.keys(clean).length) return jsonResponse(res, 400, { error: 'no valid messages' });

  const cached = idempotency.get(idemKey);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return jsonResponse(res, 200, cached.response);

  if (rateLimited(zoneId)) {
    await writeAudit({ event: 'rate_limited', alertId, zoneId, requested: requested.length });
    return jsonResponse(res, 429, { error: `email rate limit reached for this zone (${MAX_PER_ZONE} per ${Math.round(WINDOW_MS / 60000)} min)` });
  }
  recordZoneSend(zoneId);

  let contacts;
  try {
    contacts = await loadContacts();
  } catch (err) {
    console.error('consent store unreadable:', err.message);
    return jsonResponse(res, 500, { error: 'consent store unavailable' });
  }
  const byId = new Map(contacts.map((c) => [String(c.id), c]));

  const results = [];
  let accepted = 0;

  for (const item of requested) {
    const id = String((item && item.id) || '');
    const contact = byId.get(id);
    if (!contact) {
      results.push({ id, status: 'failed', error: 'unknown recipient' });
      continue;
    }
    if (contact.consent !== true || contact.emailOptIn !== true) {
      results.push({ id, status: 'failed', error: 'not opted in to email' });
      continue;
    }
    if (!areaOverlap(contact, zoneAreas)) {
      results.push({ id, status: 'failed', error: 'registered area does not overlap the zone' });
      continue;
    }
    const address = normaliseEmail(contact.email);
    if (!address) {
      results.push({ id, status: 'failed', error: 'no usable email address on record' });
      continue;
    }
    const lang = String(contact.language || item.language || 'en');
    const msg = clean[lang] || clean.en;
    if (!msg) {
      results.push({ id, status: 'failed', error: 'no message for this language' });
      continue;
    }

    const memoKey = `${alertId}:${id}`;
    const memo = sentMemo.get(memoKey);
    if (memo) {
      results.push({ ...memo, deduplicated: true });
      continue;
    }

    const unsubUrl = `${baseUrl()}/api/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(id))}`;
    const rendered = withUnsubscribe(msg.html, msg.text, unsubUrl);
    const sent = await sendViaProvider(address, msg.subject, rendered.html, rendered.text, unsubUrl);
    const result = {
      id,
      status: sent.status,
      providerMessageId: sent.providerMessageId || null,
      error: sent.error || null
    };
    sentMemo.set(memoKey, result);
    results.push(result);
    if (sent.status !== 'failed') accepted += 1;
    await writeAudit({
      event: 'send',
      alertId,
      zoneId,
      version,
      recipient: id,
      email: maskEmail(address),
      subject: msg.subject,
      language: lang,
      status: sent.status,
      providerMessageId: result.providerMessageId,
      error: result.error,
      dryRun: DRY_RUN,
      provider: PROVIDER
    });
  }

  if (sentMemo.size > 5000) sentMemo.clear();

  const response = {
    results,
    accepted,
    failed: results.filter((r) => r.status === 'failed').length,
    dryRun: DRY_RUN,
    provider: PROVIDER
  };
  idempotency.set(idemKey, { at: Date.now(), response });
  if (idempotency.size > 2000) idempotency.clear();

  await writeAudit({ event: 'batch', alertId, zoneId, version, requested: requested.length, accepted, failed: response.failed, dryRun: DRY_RUN });
  console.log(`email batch ${alertId}: ${response.accepted} accepted, ${response.failed} failed${DRY_RUN ? ' (dry run)' : ''}`);
  return jsonResponse(res, 200, response);
}

async function applyUnsubscribe(token) {
  if (!configured()) return { ok: false, status: 503, message: 'This server has no email provider or unsubscribe secret configured.' };
  const id = verifyUnsubscribeToken(token);
  if (!id) return { ok: false, status: 400, message: 'This unsubscribe link is not valid.' };
  let contacts;
  try {
    contacts = await loadContacts();
  } catch {
    return { ok: false, status: 500, message: 'The consent store is unavailable.' };
  }
  const contact = contacts.find((c) => String(c.id) === id);
  if (!contact) return { ok: false, status: 404, message: 'This contact is not on record.' };
  if (contact.emailOptIn !== false) {
    contact.emailOptIn = false;
    contact.emailOptOutAt = new Date().toISOString();
    try {
      await writeContacts(contacts);
    } catch (err) {
      console.error('unsubscribe write failed:', err.message);
      return { ok: false, status: 500, message: 'The opt-out could not be saved. Nothing was changed.' };
    }
    await writeAudit({ event: 'unsubscribe', recipient: id, email: maskEmail(contact.email), source: 'link' });
  }
  return { ok: true, status: 200, message: 'You will not receive further heatwave email alerts at this address.' };
}

function unsubscribePage(message, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? 'Unsubscribed' : 'Unsubscribe link'} — Heatwise</title>
<style>body{margin:0;background:#f6f4ef;color:#2b332e;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:520px;margin:12vh auto;background:#fff;border:1px solid #e6dfd0;border-radius:14px;padding:26px 24px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 10px;font-size:14px;color:#4c554e}a{color:#8a3f17}</style></head>
<body><main><h1>${ok ? 'Unsubscribed' : 'This link did not work'}</h1><p>${message}</p>
<p style="font-size:12px;color:#6a736c">Heatwise is a prototype. Official warnings come only from the India Meteorological Department. Emergency: 112 · Ambulance: 108.</p></main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/email/status') {
    return jsonResponse(res, 200, {
      configured: configured(),
      provider: PROVIDER || null,
      from: FROM || null,
      fromName: FROM_NAME || null,
      dryRun: DRY_RUN,
      maxPerZone: MAX_PER_ZONE,
      windowMin: Math.round(WINDOW_MS / 60000),
      unsubscribe: UNSUB_SECRET ? 'configured' : 'missing',
      contactsStore: CONTACTS_FILE ? 'configured' : 'missing'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/email/send') {
    if (!sameOrigin(req)) return jsonResponse(res, 403, { error: 'cross-origin request refused' });
    try {
      return await handleSend(req, res);
    } catch (err) {
      console.error('send failed:', err.message);
      return jsonResponse(res, 500, { error: 'internal error' });
    }
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/email/unsubscribe') {
    let token = url.searchParams.get('token') || '';
    if (!token && req.method === 'POST') {
      try {
        const body = await readBody(req);
        token = String(body.token || '');
      } catch {
        token = '';
      }
    }
    const outcome = await applyUnsubscribe(token);
    if (req.method === 'GET' || (req.headers.accept || '').includes('text/html')) {
      return htmlResponse(res, outcome.status, unsubscribePage(outcome.message, outcome.ok));
    }
    return jsonResponse(res, outcome.status, { ok: outcome.ok, message: outcome.message });
  }

  return jsonResponse(res, 404, { error: 'not found' });
});

if (process.env.HEATWISE_EMAIL_DISABLE_LISTEN !== '1') {
  if (!APP_ORIGIN) console.warn('HEATWISE_APP_ORIGIN is not set: cross-origin checks are disabled and unsubscribe links point at localhost.');
  if (!UNSUB_SECRET) console.warn('HEATWISE_EMAIL_UNSUBSCRIBE_SECRET is not set: unsubscribe links cannot be issued.');
  if (!configured()) console.warn('Email adapter started but no provider credentials are complete; /api/email/send will return 503.');
  if (DRY_RUN) console.warn('DRY RUN is on. Set HEATWISE_EMAIL_DRY_RUN=0 only when you intend to send real email.');
  server.listen(PORT, () => console.log(`heatwise email adapter on http://localhost:${PORT} (dry run: ${DRY_RUN})`));
}

export { server, configured, unsubscribeToken, verifyUnsubscribeToken, maskEmail };
