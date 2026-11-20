// Same-origin gateway for the Heatwise pages.
//
// The static pages fetch weather from Open-Meteo in the browser. Some browsers,
// privacy extensions and networks block third-party requests to those hosts,
// which leaves the heat metrics blank. This function serves the same data from
// the site's own origin so the pages never need a cross-origin request.
//
// Usage: GET /api/open-meteo?kind=forecast|archive|geocoding&<upstream params>
// The upstream host is chosen from a fixed allowlist; query parameters are
// passed through unchanged.

const UPSTREAMS = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
};

const UPSTREAM_TIMEOUT_MS = 12000;
const MAX_QUERY_LENGTH = 4000;

function sendJSON(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (extraHeaders) {
    for (const name of Object.keys(extraHeaders)) res.setHeader(name, extraHeaders[name]);
  }
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJSON(res, 405, { error: 'GET only' });
  }

  const incoming = new URL(req.url, 'http://localhost');
  const kind = incoming.searchParams.get('kind');
  const upstream = Object.prototype.hasOwnProperty.call(UPSTREAMS, kind) ? UPSTREAMS[kind] : null;
  if (!upstream) {
    return sendJSON(res, 400, { error: 'Unknown kind', allowed: Object.keys(UPSTREAMS) });
  }

  const target = new URL(upstream);
  incoming.searchParams.forEach((value, name) => {
    if (name !== 'kind') target.searchParams.set(name, value);
  });

  if (target.search.length > MAX_QUERY_LENGTH) {
    return sendJSON(res, 414, { error: 'Query too long' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(target, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.text();
    const ok = response.ok;
    res.statusCode = ok ? 200 : response.status === 429 ? 429 : 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Heatwise-Upstream', kind);
    res.setHeader(
      'Cache-Control',
      ok ? 'public, max-age=120, s-maxage=300, stale-while-revalidate=600' : 'no-store'
    );
    return res.end(body);
  } catch (error) {
    return sendJSON(
      res,
      502,
      { error: 'Could not reach Open-Meteo', detail: String(error && error.message ? error.message : error) },
      { 'Cache-Control': 'no-store', 'X-Heatwise-Upstream': kind }
    );
  } finally {
    clearTimeout(timer);
  }
};
