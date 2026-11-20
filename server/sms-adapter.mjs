#!/usr/bin/env node
/**
 * Heatwise SMS adapter — server-side only.
 *
 * The browser sends recipient IDs, never phone numbers. This adapter owns the
 * consent store, resolves each number, re-checks opt-in and area overlap,
 * applies its own rate limit, enforces idempotency, and never logs a full
 * number. Credentials come from environment variables only.
 *
 *   node server/sms-adapter.mjs
 *
 * Endpoints
 *   GET  /api/sms/status  -> {configured, provider, sender, dryRun, costPerSegment, currency, optOutKeyword, maxSegments}
 *   POST /api/sms/send    -> {results:[{id,status,providerMessageId,error}], parts, cost, currency}
 *
 * Safety: HEATWISE_SMS_DRY_RUN defaults to on. Nothing is handed to a provider
 * unless it is explicitly set to "0".
 */

import http from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';

const PORT = Number(process.env.HEATWISE_SMS_PORT || 8788);
const PROVIDER = (process.env.HEATWISE_SMS_PROVIDER || '').toLowerCase();
const API_KEY = process.env.HEATWISE_SMS_API_KEY || '';
const ACCOUNT_ID = process.env.HEATWISE_SMS_ACCOUNT_ID || '';
const SENDER = process.env.HEATWISE_SMS_SENDER || '';
const TEMPLATE_ID = process.env.HEATWISE_SMS_TEMPLATE_ID || '';
const CONTACTS_FILE = process.env.HEATWISE_CONTACTS_FILE || '';
const AUDIT_FILE = process.env.HEATWISE_SMS_AUDIT_FILE || '';
const APP_ORIGIN = (process.env.HEATWISE_APP_ORIGIN || '').replace(/\/$/, '');
const DRY_RUN = process.env.HEATWISE_SMS_DRY_RUN !== '0';
const COST_PER_SEGMENT = Number(process.env.HEATWISE_SMS_COST_PER_SEGMENT || 0.18);
const CURRENCY = process.env.HEATWISE_SMS_CURRENCY || 'INR';
const OPT_OUT_KEYWORD = (process.env.HEATWISE_SMS_OPT_OUT_KEYWORD || 'STOP').toUpperCase();
const MAX_PER_ZONE = Number(process.env.HEATWISE_SMS_MAX_PER_ZONE || 3);
const WINDOW_MS = Number(process.env.HEATWISE_SMS_WINDOW_MIN || 30) * 60000;
const MAX_RECIPIENTS = 200;
const MAX_MESSAGE_CHARS = 640;
const MAX_BODY_BYTES = 64 * 1024;

const SUPPORTED = ['twilio', 'msg91'];

const zoneSends = new Map();     // zoneId -> [timestamps]
const idempotency = new Map();   // key -> {at, response}
const sentMemo = new Map();      // alertId:recipientId -> result
const contactsCache = { at: 0, list: [] };

function configured() {
  return SUPPORTED.includes(PROVIDER) && !!API_KEY && !!SENDER && !!CONTACTS_FILE;
}

function segments(text) {
  const latin = /^[\x00-\x7F]*$/.test(text);
  return latin ? (text.length <= 160 ? 1 : Math.ceil(text.length / 153))
               : (text.length <= 70 ? 1 : Math.ceil(text.length / 67));
}

function mask(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? '••••' + digits.slice(-4) : '••••';
}

function normalisePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? '+' + digits : null;
}

function areaOverlap(contact, zoneAreas) {
  const areas = Array.isArray(contact.areas) ? contact.areas : [];
  return areas.some((a) => zoneAreas.includes(a));
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

async function writeAudit(entry) {
  if (!AUDIT_FILE) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { await appendFile(AUDIT_FILE, line); } catch (err) { console.error('audit write failed:', err.message); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function postJson(url, headers, body, attempt = 1) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) { await sleep(attempt === 1 ? 400 : 1200); return postJson(url, headers, body, attempt + 1); }
    }
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    if (attempt < 3) { await sleep(attempt === 1 ? 400 : 1200); return postJson(url, headers, body, attempt + 1); }
    return { ok: false, status: 0, json: { error: err.message } };
  }
}

async function postForm(url, headers, body, attempt = 1) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: body.toString(),
      signal: AbortSignal.timeout(10000)
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) { await sleep(attempt === 1 ? 400 : 1200); return postForm(url, headers, body, attempt + 1); }
    }
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    if (attempt < 3) { await sleep(attempt === 1 ? 400 : 1200); return postForm(url, headers, body, attempt + 1); }
    return { ok: false, status: 0, json: { error: err.message } };
  }
}

async function sendViaProvider(phone, text) {
  if (DRY_RUN) {
    return { status: 'delivered', providerMessageId: 'DRY-' + Math.random().toString(36).slice(2, 10).toUpperCase() };
  }
  if (PROVIDER === 'twilio') {
    if (!ACCOUNT_ID) return { status: 'failed', error: 'HEATWISE_SMS_ACCOUNT_ID is not set' };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(ACCOUNT_ID)}/Messages.json`;
    const auth = Buffer.from(`${ACCOUNT_ID}:${API_KEY}`).toString('base64');
    const body = new URLSearchParams({ To: phone, From: SENDER, Body: text });
    const res = await postForm(url, { Authorization: `Basic ${auth}` }, body);
    if (!res.ok) {
      return { status: 'failed', error: `provider HTTP ${res.status}${res.json && res.json.code ? ' code ' + res.json.code : ''}` };
    }
    return { status: 'queued', providerMessageId: (res.json && res.json.sid) || null };
  }
  if (PROVIDER === 'msg91') {
    const url = 'https://api.msg91.com/api/v2/sendsms';
    const payload = {
      sender: SENDER,
      route: '4',
      country: '91',
      unicode: 1,
      ...(TEMPLATE_ID ? { template_id: TEMPLATE_ID } : {}),
      sms: [{ message: text, to: [phone.replace(/^\+/, '')] }]
    };
    const res = await postJson(url, { authkey: API_KEY }, payload);
    if (!res.ok) {
      return { status: 'failed', error: `provider HTTP ${res.status}` };
    }
    const id = res.json && Array.isArray(res.json.message) && res.json.message[0] && res.json.message[0].id;
    return { status: 'queued', providerMessageId: id || null };
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

async function handleSend(req, res) {
  if (!configured()) {
    return jsonResponse(res, 503, { error: 'SMS provider is not configured on this server' });
  }
  let body;
  try { body = await readBody(req); } catch (err) { return jsonResponse(res, 400, { error: err.message }); }

  const alertId = String(body.alertId || '');
  const zoneId = String(body.zoneId || '');
  const zoneAreas = Array.isArray(body.zoneAreas) ? body.zoneAreas.map(String) : [];
  const messages = body.messages && typeof body.messages === 'object' ? body.messages : {};
  const requested = Array.isArray(body.recipients) ? body.recipients : [];
  const idemKey = String(body.idempotencyKey || alertId);

  if (!alertId || !zoneId) return jsonResponse(res, 400, { error: 'alertId and zoneId are required' });
  if (!requested.length) return jsonResponse(res, 400, { error: 'no recipients requested' });
  if (requested.length > MAX_RECIPIENTS) return jsonResponse(res, 400, { error: 'too many recipients' });

  const clean = {};
  for (const [lang, text] of Object.entries(messages)) {
    if (typeof text !== 'string') continue;
    const flat = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!flat || flat.length > MAX_MESSAGE_CHARS) {
      return jsonResponse(res, 400, { error: `message for ${lang} is empty or too long` });
    }
    clean[lang] = flat.includes(OPT_OUT_KEYWORD) ? flat : `${flat} Reply ${OPT_OUT_KEYWORD} to opt out.`;
  }
  if (!Object.keys(clean).length) return jsonResponse(res, 400, { error: 'no valid messages' });

  const cached = idempotency.get(idemKey);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return jsonResponse(res, 200, cached.response);

  if (rateLimited(zoneId)) {
    await writeAudit({ event: 'rate_limited', alertId, zoneId, requested: requested.length });
    return jsonResponse(res, 429, { error: `SMS rate limit reached for this zone (${MAX_PER_ZONE} per ${Math.round(WINDOW_MS / 60000)} min)` });
  }
  recordZoneSend(zoneId);

  let contacts;
  try { contacts = await loadContacts(); }
  catch (err) {
    console.error('consent store unreadable:', err.message);
    return jsonResponse(res, 500, { error: 'consent store unavailable' });
  }
  const byId = new Map(contacts.map((c) => [String(c.id), c]));

  const results = [];
  let parts = 0;
  let accepted = 0;

  for (const item of requested) {
    const id = String(item && item.id || '');
    const contact = byId.get(id);
    if (!contact) { results.push({ id, status: 'failed', error: 'unknown recipient' }); continue; }
    if (contact.consent !== true || contact.smsOptIn !== true) {
      results.push({ id, status: 'failed', error: 'not opted in' });
      continue;
    }
    if (!areaOverlap(contact, zoneAreas)) {
      results.push({ id, status: 'failed', error: 'registered area does not overlap the zone' });
      continue;
    }
    const phone = normalisePhone(contact.phone);
    if (!phone) { results.push({ id, status: 'failed', error: 'no usable number on record' }); continue; }
    const lang = String(contact.language || item.language || 'en');
    const text = clean[lang] || clean.en;
    if (!text) { results.push({ id, status: 'failed', error: 'no message for this language' }); continue; }

    const memoKey = `${alertId}:${id}`;
    const memo = sentMemo.get(memoKey);
    if (memo) { results.push({ ...memo, deduplicated: true }); continue; }

    const sent = await sendViaProvider(phone, text);
    const result = {
      id,
      status: sent.status,
      providerMessageId: sent.providerMessageId || null,
      error: sent.error || null
    };
    sentMemo.set(memoKey, result);
    results.push(result);
    if (sent.status !== 'failed') { accepted += 1; parts += segments(text); }
    await writeAudit({
      event: 'send', alertId, zoneId, recipient: id, phone: mask(phone),
      status: sent.status, providerMessageId: result.providerMessageId, error: result.error,
      dryRun: DRY_RUN, provider: PROVIDER
    });
  }

  // Forget memo entries after a day so the map cannot grow without bound.
  if (sentMemo.size > 5000) sentMemo.clear();

  const response = {
    results,
    accepted,
    failed: results.filter((r) => r.status === 'failed').length,
    parts,
    cost: Math.round(parts * COST_PER_SEGMENT * 100) / 100,
    currency: CURRENCY,
    dryRun: DRY_RUN,
    provider: PROVIDER
  };
  idempotency.set(idemKey, { at: Date.now(), response });
  if (idempotency.size > 2000) idempotency.clear();

  await writeAudit({ event: 'batch', alertId, zoneId, requested: requested.length, accepted, failed: response.failed, dryRun: DRY_RUN });
  console.log(`sms batch ${alertId}: ${response.accepted} accepted, ${response.failed} failed${DRY_RUN ? ' (dry run)' : ''}`);
  return jsonResponse(res, 200, response);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/sms/status') {
    return jsonResponse(res, 200, {
      configured: configured(),
      provider: PROVIDER || null,
      sender: SENDER || null,
      dryRun: DRY_RUN,
      costPerSegment: COST_PER_SEGMENT,
      currency: CURRENCY,
      optOutKeyword: OPT_OUT_KEYWORD,
      maxSegments: 4,
      contactsStore: CONTACTS_FILE ? 'configured' : 'missing'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sms/send') {
    if (!sameOrigin(req)) return jsonResponse(res, 403, { error: 'cross-origin request refused' });
    try { return await handleSend(req, res); }
    catch (err) {
      console.error('send failed:', err.message);
      return jsonResponse(res, 500, { error: 'internal error' });
    }
  }

  return jsonResponse(res, 404, { error: 'not found' });
});

if (process.env.HEATWISE_SMS_DISABLE_LISTEN !== '1') {
  if (!APP_ORIGIN) console.warn('HEATWISE_APP_ORIGIN is not set: cross-origin checks are disabled.');
  if (!configured()) console.warn('SMS adapter started but no provider credentials are complete; /api/sms/send will return 503.');
  if (DRY_RUN) console.warn('DRY RUN is on. Set HEATWISE_SMS_DRY_RUN=0 only when you intend to send real SMS.');
  server.listen(PORT, () => console.log(`heatwise sms adapter on http://localhost:${PORT} (dry run: ${DRY_RUN})`));
}

export { server, configured, segments };
