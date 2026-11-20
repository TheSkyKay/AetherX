# Heatwise — heat risk, season outlook, alerts and supply coordination

Static, framework-free prototypes for heat preparedness in India. No build step and no server code: open the pages over any static host (or run a local web server) and they work.

## Pages

| File | What it does |
| --- | --- |
| `index.html` | Original Heatwise landing page (unchanged apart from navigation links). |
| `heat-risk-model.html` | H + E + V risk score for any city worldwide, with the calculation shown and a historical comparison. |
| `heatwave-outlook.html` | India season outlook: IMD-criteria heatwave days for a city and season, historical baseline, climatological likelihood, "what changed" evidence, hindcast validation. |
| `heat-response.html` | **DEMO** alert and supply coordination: heat zones, role-based views, bilingual in-app and SMS alerts, simulated delivery, supply plan, simulated dispatch and audit log. |
| `heat-safety.html` | Public heat safety guidance: preparing for heat, staying cool, recognising heat illness, first aid, and forecast estimates kept separate from official IMD warnings. English and Hindi, no build step. |

## Run locally

```bash
python3 -m http.server 3000 --bind 0.0.0.0
# then open http://localhost:3000/heat-response.html
```

Weather data comes from the public [Open-Meteo](https://open-meteo.com/) API (CC BY 4.0, ERA5 reanalysis and forecast models). The outlook page fetches one small archive request per baseline year (35 requests, about 35 s on first load, then cached in memory). If the API rate-limits the page, it says so and shows no invented values.

## Demo mode in `heat-response.html`

Everything in the alert and response page is a simulation, labelled **DEMO**:

- Three fictional wards, twelve synthetic contacts, four storage units with demo stock.
- Alerts are delivered only to those synthetic recipients, inside the page.
- SMS goes to synthetic numbers and email goes to synthetic `.invalid` addresses. Both are simulated. SMS messages are prefixed `[SIMULATED]`, email is labelled `DEMO EMAIL`, and numbers and addresses are masked everywhere they are displayed.
- Dispatch deducts demo inventory and appends a simulated record. No order is placed and no supplier is contacted.
- All demo data lives in this browser's `localStorage`; "Reset demo data" clears it.

### Scenario walkthrough

1. Open **Response team**. Suryapur east ward shows a model **Severe** level from a demo feels-like snapshot.
2. Select a zone, preview the English and Hindi messages, then **Review & send alert**. Confirm the DEMO acknowledgement.
3. Delivery results, retries and duplicate/rate-limit holds appear in **Alert log and delivery**.
4. Tick the **SMS** channel to see the synthetic-number preview, the opted-in recipient count, the number of SMS parts per language and the estimated cost. **Review & send alert** shows the same summary before anything is recorded.
5. Or click **Preview the sample SMS** in the *Sample SMS test scenario* card: it selects the demo ward, opens the preview and cost, and after confirmation simulates delivery and shows per-recipient status plus the audit entries.
6. Scroll to **Supply plan**, review quantities (clearly estimates), then **Review and approve plan** → simulated dispatch and inventory reduction.
7. Switch to **Storage operator** to see the request and edit stock; switch to **Public** to see the alert, guidance and SMS opt-in/out controls.
8. Or click **Preview the sample email** in the *Sample email test scenario* card: it selects the demo ward, shows the eligible opted-in email recipients and the full message per language, and after confirmation simulates delivery and shows per-recipient status plus the audit entries.
9. **Administrator** changes thresholds, stale limits, rate limits, cost per SMS part and the severe-alert second-review rule.

## What is live vs simulated

| Integration | Status |
| --- | --- |
| Weather (Open-Meteo) | Live when "Live weather" is enabled in the admin view; otherwise a clearly labelled demo snapshot. |
| In-app alerts | Works in the browser, with DEMO recipients. |
| SMS | **Simulated** until a responder clicks *Check server adapter* and the adapter reports credentials. Then live via `server/sms-adapter.mjs`. |
| Email | **DEMO in the page.** Live delivery via `server/email-adapter.mjs` once a provider, credentials and a sender are configured; the adapter defaults to a dry run. |
| Messaging app | **Not configured.** Simulated adapter only. |
| Supply ordering / dispatch | **Simulated.** No external system is contacted. |
| Official IMD warnings | **Not ingested.** The page never claims to show one. |

The page contains no credentials. A production deployment would need a server that reads, for example:

```
HEATWISE_SMS_PROVIDER=
HEATWISE_SMS_API_KEY=
HEATWISE_SMS_SENDER=
HEATWISE_EMAIL_PROVIDER=
HEATWISE_EMAIL_API_KEY=
HEATWISE_EMAIL_FROM=
HEATWISE_EMAIL_UNSUBSCRIBE_SECRET=
HEATWISE_MESSAGING_TOKEN=
```

along with authentication and role assignment, a database with consent records and encrypted contact storage, and an append-only audit store.

## SMS alerts

SMS is a channel of its own, with its own consent, limits and audit trail.

**Who receives it.** Only contacts who (a) gave general consent, (b) opted in to SMS separately, (c) have a number on record, and (d) are registered in an area that overlaps the affected zone. Overlap is a shared locality name (for example `East colony` inside *Suryapur east ward*), not just the same ward ID, so a contact registered outside every zone is excluded. Language comes from the contact, so each person gets one message in their preferred language.

**What it contains.** Area and district, level, feels-like value, forecast window, one short safety step, the data source, a link to the full alert, and the opt-out keyword. The message states that it is a model estimate and not an official IMD warning. The link is `heat-response.html#alert=<id>` and opens the full alert record in the page.

**Before sending.** The composer shows the text per language, the opted-in recipient count, the number of 160/70-character parts, and the estimated cost (parts × recipients × the configured price per part). The same summary with an explicit confirmation is required again in the dialog. Live sends additionally require a separate authorisation checkbox.

**When it is held.** The composer refuses to send and shows the reason when:

- weather is missing, unavailable or older than the stale limit;
- the zone boundary is approximate and has not been reviewed;
- the forecast window, data source or measure value is missing;
- the message would exceed the configured part limit;
- no opted-in contact overlaps the zone;
- an identical SMS for the same zone and level went out in the last 6 hours;
- the per-zone SMS rate limit is reached (default 3 per 30 minutes);
- live mode is selected but no adapter has been confirmed.

**Privacy.** Demo numbers are synthetic and always rendered masked (`+91 ••••• 4821`). In live mode the browser sends recipient **IDs** and the message text only; the adapter looks each number up in its own consent store, so numbers never reach the browser, the page, the map or the audit log. The adapter never logs a full number either.

## Email alerts

Email is its own channel inside the **Alert and Response** tab, next to in-app and SMS. It has its own opt-in, its own rate limit and its own audit entries.

**Who receives it.** Only registered contacts who (a) gave general consent, (b) opted in to email separately, (c) have an address on record, and (d) are registered in an area that overlaps the affected zone. Language comes from the contact's saved preference, falling back to English. Contacts with no address, an opt-out, or an area outside the zone are excluded and the composer shows the eligible count.

**What the responder sees before approving.** The affected area and district, the alert level, the model measure and threshold, the forecast window, the data source, the data age against the stale limit, the number of eligible opted-in recipients, and the subject plus full HTML/text body per language. A banner in the email itself states that a model estimate is not an official IMD warning; the composer repeats that no IMD warning feed is ingested.

**What the email contains.** Subject with the level and area; alert level, affected area, valid window, last-updated time (with data age), source and measure; level-specific heat-safety steps; when to seek urgent medical help and the cooling-first instruction; a link to the full alert (`heat-response.html#alert=<id>`) and to the public guidance (`heat-safety.html#during`); and an unsubscribe link. No recipient ever sees another recipient's address.

**When sending is blocked.** Stale or missing weather, an unreviewed approximate boundary, a missing forecast window/source/measure, no selected language, no eligible opted-in recipient, an identical alert for the same zone and level within six hours, the per-zone email rate limit, or live mode selected without a confirmed adapter. The reason is shown in the composer and nothing is recorded as sent.

**Approval and audit.** Confirming records who approved, the alert version, the recipient count, the timestamp, per-recipient delivery results, retries and failures. The same idempotency key prevents a repeated request from sending the same alert twice. Demo addresses are masked everywhere (`r•••@example.invalid`).

**Managing the preference and unsubscribing.** In the public view each contact's email opt-in can be changed, and the email carries a one-click unsubscribe link with a signed, single-purpose token that needs no sign-in. Opening the demo link (`heat-response.html#unsubscribe=<token>`) asks for confirmation and records the opt-out.

**DEMO vs live.** With no adapter, the page simulates delivery to synthetic `.invalid` addresses, marks every result as simulated and sends no email. With the adapter running and confirmed, the page switches to live mode: it posts recipient **IDs** and the rendered message parts, and the adapter re-checks consent and overlap, adds the signed unsubscribe link and `List-Unsubscribe` headers, calls the provider, retries 429/5xx responses with backoff, and returns a status only after the provider answers. The page reports `sent`/`accepted` as the provider's answer, and never claims delivery unless the provider accepted the message. A dry run is labelled as such and sends nothing.

### Running the email adapter

```bash
HEATWISE_EMAIL_PROVIDER=resend \
HEATWISE_EMAIL_API_KEY=<provider key> \
HEATWISE_EMAIL_FROM=alerts@your-verified-domain.example \
HEATWISE_EMAIL_UNSUBSCRIBE_SECRET=<long random string> \
HEATWISE_CONTACTS_FILE=/secure/path/contacts.json \
HEATWISE_APP_ORIGIN=https://your-origin.example \
HEATWISE_EMAIL_AUDIT_FILE=/secure/path/email-audit.jsonl \
node server/email-adapter.mjs
```

| Variable | Purpose |
| --- | --- |
| `HEATWISE_EMAIL_PROVIDER` | `resend`, `postmark` or `sendgrid`. |
| `HEATWISE_EMAIL_API_KEY` | Provider secret. Required. |
| `HEATWISE_EMAIL_FROM` | Verified sender address. Required. |
| `HEATWISE_EMAIL_FROM_NAME`, `HEATWISE_EMAIL_REPLY_TO` | Optional display name and reply-to address. |
| `HEATWISE_EMAIL_UNSUBSCRIBE_SECRET` | Signs per-recipient unsubscribe tokens. Required for live use. |
| `HEATWISE_CONTACTS_FILE` | Consent store. Required. Use `server/contacts.example.json` as the shape. |
| `HEATWISE_APP_ORIGIN` | Exact site origin; used for cross-origin checks and absolute unsubscribe links. |
| `HEATWISE_EMAIL_DRY_RUN` | Defaults to on. Set to `0` only when you mean to send real email. |
| `HEATWISE_EMAIL_MAX_PER_ZONE`, `HEATWISE_EMAIL_WINDOW_MIN` | Server-side rate limit, independent of the page. |
| `HEATWISE_EMAIL_AUDIT_FILE` | Optional append-only JSONL audit file (masked addresses only). |
| `HEATWISE_EMAIL_PORT` | Default `8789`. |

The adapter exposes `GET /api/email/status`, `POST /api/email/send`, and `GET|POST /api/email/unsubscribe?token=…`. Route the page's `./api/email/*` calls to it with a reverse proxy on the same origin; the browser never receives a provider credential. In demo mode the page does not call the adapter at all.

### Running the adapter

The page works without it: SMS stays simulated. To enable live delivery, run the adapter next to a server that serves the static files over the same origin:

```bash
HEATWISE_SMS_PROVIDER=twilio \
HEATWISE_SMS_API_KEY=<auth token> \
HEATWISE_SMS_ACCOUNT_ID=<account sid> \
HEATWISE_SMS_SENDER=<sender id or number> \
HEATWISE_CONTACTS_FILE=/secure/path/contacts.json \
HEATWISE_APP_ORIGIN=https://your-origin.example \
HEATWISE_SMS_AUDIT_FILE=/secure/path/sms-audit.jsonl \
node server/sms-adapter.mjs
```

| Variable | Purpose |
| --- | --- |
| `HEATWISE_SMS_PROVIDER` | `twilio` or `msg91`. |
| `HEATWISE_SMS_API_KEY` | Provider secret. Required. |
| `HEATWISE_SMS_ACCOUNT_ID` | Twilio account SID (unused for MSG91). |
| `HEATWISE_SMS_SENDER` | Sender ID or from-number. Required. |
| `HEATWISE_SMS_TEMPLATE_ID` | Optional MSG91/DLT template ID. |
| `HEATWISE_CONTACTS_FILE` | Path to the consent store. Required. Use `server/contacts.example.json` as the shape. |
| `HEATWISE_APP_ORIGIN` | Exact site origin. Cross-origin posts are refused when set. |
| `HEATWISE_SMS_DRY_RUN` | Defaults to on. Set to `0` only when you mean to send real messages. |
| `HEATWISE_SMS_COST_PER_SEGMENT`, `HEATWISE_SMS_CURRENCY` | Cost used for the estimate. |
| `HEATWISE_SMS_OPT_OUT_KEYWORD` | Default `STOP`; appended to any message missing it. |
| `HEATWISE_SMS_MAX_PER_ZONE`, `HEATWISE_SMS_WINDOW_MIN` | Server-side rate limit, independent of the page. |
| `HEATWISE_SMS_AUDIT_FILE` | Optional append-only JSONL audit file. |
| `HEATWISE_SMS_PORT` | Default `8788`. |

`server/contacts.example.json` shows the consent-store shape. Every entry carries its own consent flags, language and registered areas; numbers are fictitious. Keep the real file outside version control.

The adapter exposes `GET /api/sms/status` (no secrets, just whether credentials are complete) and `POST /api/sms/send`. It re-checks consent and area overlap per recipient, refuses opted-out or non-overlapping IDs, deduplicates by alert and recipient, applies its own rate limit, retries provider 429/5xx responses with backoff, and returns per-recipient status. Redirect the page's `./api/sms/*` calls to it with a reverse proxy on the same origin — the browser is never given a provider credential.

Banking on SMS in India also needs DLT registration of the sender and the message template; the adapter accepts `HEATWISE_SMS_TEMPLATE_ID` for that. Provider payloads should be checked against current documentation before production use.

## Limits

- The SMS cost is an estimate from character segments and the configured price. Real operator pricing, taxes and provider fees differ.
- The adapter was exercised in dry-run mode only; no live provider account was used, so its Twilio/MSG91 payload shapes are unverified against a real account.
- The full-alert link is a relative path to this static page. A production deployment would use a public URL with signed, non-guessable alert identifiers.

- Model zones use apparent temperature thresholds configured in the demo, not official IMD criteria. The IMD reference shown is a grid-cell entry-threshold check only.
- Reanalysis and forecast data are ~25 km grid estimates, not station observations.
- Nothing here predicts deaths, hospitalisations or economic losses, and nothing replaces official warnings, emergency services, medical advice or decisions by local authorities.
