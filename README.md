# Heatwise — heat risk, season outlook, alerts and supply coordination

Static, framework-free prototypes for heat preparedness in India. No build step and no server code: open the pages over any static host (or run a local web server) and they work.

## Pages

| File | What it does |
| --- | --- |
| `index.html` | Original Heatwise landing page (unchanged apart from navigation links). |
| `heat-risk-model.html` | H + E + V risk score for any city worldwide, with the calculation shown and a historical comparison. |
| `heatwave-outlook.html` | India season outlook: IMD-criteria heatwave days for a city and season, historical baseline, climatological likelihood, "what changed" evidence, hindcast validation. |
| `heat-response.html` | **DEMO** alert and supply coordination: heat zones, role-based views, bilingual alert preview, simulated delivery, supply plan, simulated dispatch and audit log. |

## Run locally

```bash
python3 -m http.server 3000 --bind 0.0.0.0
# then open http://localhost:3000/heat-response.html
```

Weather data comes from the public [Open-Meteo](https://open-meteo.com/) API (CC BY 4.0, ERA5 reanalysis and forecast models). The outlook page fetches one small archive request per baseline year (35 requests, about 35 s on first load, then cached in memory). If the API rate-limits the page, it says so and shows no invented values.

## Demo mode in `heat-response.html`

Everything in the alert and response page is a simulation, labelled **DEMO**:

- Three fictional wards, ten synthetic contacts, four storage units with demo stock.
- Alerts are delivered only to those synthetic recipients, inside the page.
- Dispatch deducts demo inventory and appends a simulated record. No order is placed and no supplier is contacted.
- All demo data lives in this browser's `localStorage`; "Reset demo data" clears it.

### Scenario walkthrough

1. Open **Response team**. Suryapur east ward shows a model **Severe** level from a demo feels-like snapshot.
2. Select a zone, preview the English and Hindi messages, then **Review & send alert**. Confirm the DEMO acknowledgement.
3. Delivery results, retries and duplicate/rate-limit holds appear in **Alert log and delivery**.
4. Scroll to **Supply plan**, review quantities (clearly estimates), then **Review and approve plan** → simulated dispatch and inventory reduction.
5. Switch to **Storage operator** to see the request and edit stock; switch to **Public** to see the alert and guidance.
6. **Administrator** changes thresholds, stale limits, rate limits and the severe-alert second-review rule.

## What is live vs simulated

| Integration | Status |
| --- | --- |
| Weather (Open-Meteo) | Live when "Live weather" is enabled in the admin view; otherwise a clearly labelled demo snapshot. |
| In-app alerts | Works in the browser, with DEMO recipients. |
| SMS | **Not configured.** Simulated adapter only. |
| Email | **Not configured.** Simulated adapter only. |
| Messaging app | **Not configured.** Simulated adapter only. |
| Supply ordering / dispatch | **Simulated.** No external system is contacted. |
| Official IMD warnings | **Not ingested.** The page never claims to show one. |

The page contains no credentials. A production deployment would need a server that reads, for example:

```
HEATWISE_SMS_API_KEY=
HEATWISE_SMS_SENDER=
HEATWISE_EMAIL_API_KEY=
HEATWISE_EMAIL_FROM=
HEATWISE_MESSAGING_TOKEN=
```

along with authentication and role assignment, a database with consent records and encrypted contact storage, and an append-only audit store.

## Limits

- Model zones use apparent temperature thresholds configured in the demo, not official IMD criteria. The IMD reference shown is a grid-cell entry-threshold check only.
- Reanalysis and forecast data are ~25 km grid estimates, not station observations.
- Nothing here predicts deaths, hospitalisations or economic losses, and nothing replaces official warnings, emergency services, medical advice or decisions by local authorities.
