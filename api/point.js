/**
 * FIRESTORM ADS-B proxy — 5-second cached edge function
 *
 * 2026-05-29: cascade is ADSBx (paid, when key set) → adsb.lol →
 * airplanes.live → adsb.fi. Three independent free sources behind ADSBx so
 * a single upstream's outage / rate-limit / outage never reaches the operator.
 * adsb.lol is preferred over airplanes.live / adsb.fi because it's the only
 * free source that honors the full 500nm /point radius (the others silently
 * clamp to 250nm — caught 2026-05-29 when ADSBx 402 exposed visible gaps
 * between regional disks). When ADSBx is healthy, adsb.lol's slot is
 * irrelevant; when ADSBx is out, this ordering keeps full-area coverage.
 * Per-tier in-memory cool-down (30s) skips a source that 429s/5xxs/times
 * out, so the next request doesn't re-burn budget on a known-bad upstream.
 * Per-call timeout (3s via AbortController) so a hung upstream can't eat
 * the whole 10s function budget.
 *
 * Sits between the FIRESTORM frontend and the upstreams. The frontend polls
 * this function every 5s per region; we cache responses for 5s (per-region
 * key) so N UAT users concurrently polling the same region still result
 * in 1 upstream call per 5s.
 *
 * Usage: /api/point?lat=40&lng=-115&radius=500
 * Returns: same shape as airplanes.live/v2/point (keys: ac, msg, now, total)
 * CORS: Access-Control-Allow-Origin: * so the FIRESTORM HTML can call it.
 */

const ADSBX = 'https://adsbexchange.com/api/aircraft/v2';
const AIRPLANES_LIVE = 'https://api.airplanes.live/v2/point';
const ADSB_FI = 'https://opendata.adsb.fi/api/v3';            // /lat/{lat}/lon/{lng}/dist/{r}
const ADSB_LOL = 'https://api.adsb.lol/v2/point';
const OPENSKY_STATES = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const CACHE_TTL_MS = 5000;
const UPSTREAM_TIMEOUT_MS = 3000;
const COOLDOWN_MS = 30 * 1000;
const ADSBX_KEY = process.env.ADSBX_API_KEY || '';

// An entitlement answer (401/402/403) is not a blip: ADSBx says "purchase a key",
// airplanes.live says "contact us". Before this, a 403 was not cooled down at all, so
// EVERY /point request spent a round trip learning the same refusal (measured
// 2026-10-01: airplanes.live 403 on every endpoint, from every network).
const ENTITLEMENT_COOLDOWN_MS = 15 * 60 * 1000;

// ── OpenSky Network — last-resort tier (added 2026-10-01) ──────────────────────
// An INDEPENDENT ADS-B network (its own feeders), so it covers the case where every
// readsb-family aggregator above is down at once. Last, not first, for two reasons:
//   1. CREDITS ARE SHARED. The same OpenSky account feeds the firestorm-aircraft-data
//      states + history pipelines from one 4000-credit daily budget. A bbox call costs
//      1-4 credits by area (a 250 nm disk ~2). The floor below stops this tier from
//      drawing that budget down far enough to starve the pipelines.
//   2. NO REGISTRATION in OpenSky state vectors (`r` is absent), so fleet matching by
//      tail number cannot work on OpenSky-only aircraft. Positions are still shown.
// With OPENSKY_CLIENT_ID/SECRET set in Vercel it authenticates (OAuth2 client
// credentials, the pipeline's proven flow); without them it runs anonymous, which is
// rate-limited per IP and Vercel egress IPs are shared — usable, not dependable.
const OPENSKY_ID = process.env.OPENSKY_CLIENT_ID || '';
const OPENSKY_SECRET = process.env.OPENSKY_CLIENT_SECRET || '';
const OPENSKY_CREDIT_FLOOR = 1500;
const OPENSKY_FLOOR_COOLDOWN_MS = 60 * 60 * 1000;
let openskyToken = { value: '', exp: 0 };

async function openskyAuthHeader() {
  if (!OPENSKY_ID || !OPENSKY_SECRET) return {};
  const now = Date.now();
  if (openskyToken.value && now < openskyToken.exp) return { Authorization: `Bearer ${openskyToken.value}` };
  const r = await fetch(OPENSKY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: OPENSKY_ID, client_secret: OPENSKY_SECRET }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok) return {};                                  // fall back to anonymous
  const j = await r.json();
  openskyToken = { value: j.access_token, exp: now + Math.max(60, (j.expires_in || 1800) - 60) * 1000 };
  return { Authorization: `Bearer ${openskyToken.value}` };
}

// OpenSky returns positional arrays in SI units; convert to the readsb v2 shape every
// other tier returns, so the frontend parser needs no change.
// Indices: 0 icao24 1 callsign 4 last_contact 5 lon 6 lat 7 baro_alt(m) 8 on_ground
//          9 velocity(m/s) 10 true_track 11 vertical_rate(m/s) 13 geo_alt(m) 14 squawk
export async function fetchOpenSky(lat, lng, radiusNm) {
  const dLat = radiusNm / 60;
  const dLon = radiusNm / (60 * Math.max(Math.cos((lat * Math.PI) / 180), 0.1));
  const q = new URLSearchParams({
    lamin: String(lat - dLat), lamax: String(lat + dLat),
    lomin: String(lng - dLon), lomax: String(lng + dLon),
  });
  const r = await fetch(`${OPENSKY_STATES}?${q}`, {
    headers: { 'User-Agent': 'FIRESTORM-proxy/1.3', Accept: 'application/json', ...(await openskyAuthHeader()) },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS + 2000),
  });
  const remaining = Number(r.headers.get('x-rate-limit-remaining'));
  if (!r.ok) { const e = new Error(`opensky ${r.status}`); e.status = r.status; throw e; }
  const d = await r.json();
  const nowS = d.time || Math.floor(Date.now() / 1000);
  const ac = (d.states || []).filter(s => s[5] != null && s[6] != null).map(s => ({
    hex: String(s[0] || '').toLowerCase(),
    flight: (s[1] || '').trim(),
    lat: s[6], lon: s[5],
    alt_baro: s[8] ? 'ground' : (s[7] == null ? undefined : Math.round(s[7] * 3.28084)),
    alt_geom: s[13] == null ? undefined : Math.round(s[13] * 3.28084),
    gs: s[9] == null ? undefined : Math.round(s[9] * 1.943844 * 10) / 10,
    track: s[10] == null ? undefined : s[10],
    baro_rate: s[11] == null ? undefined : Math.round(s[11] * 196.85),
    squawk: s[14] || undefined,
    seen: s[4] ? Math.max(0, nowS - s[4]) : undefined,
    _src: 'opensky',
  }));
  return { data: { ac, msg: 'No error', now: nowS * 1000, total: ac.length, ctime: Date.now(), ptime: 0 }, remaining };
}

// In-memory cache. Vercel may cold-start between invocations, but when the
// function is "warm" (last invoked within ~15 min) the module-scope cache
// persists across requests to the same container. Under UAT load, warm is
// the steady state, so 5s cache is effective.
const cache = new Map();

// Per-tier cool-down. If a source 429s / 5xxs / times out, we skip it for
// COOLDOWN_MS so subsequent requests don't burn budget on a known-bad
// upstream. State is per-Vercel-instance, so other warm instances probe
// independently — that's actually useful (sloppy isolation = some
// instances retry while others avoid, which surfaces recovery quickly).
const tierBannedUntil = { adsbx: 0, airplaneslive: 0, adsbfi: 0, adsblol: 0, opensky: 0 };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchUpstream(base, lat, lng, radius) {
  // Three URL shapes + per-source radius caps:
  //   ADSBx: /lat/{lat}/lon/{lng}/dist/{r}/ + x-api-key. Accepts up to 500nm.
  //   adsb.fi (v3): /lat/{lat}/lon/{lng}/dist/{r}. Caps at 250nm — over-limit
  //     returns 400. Clamp on the way in so the fallback still serves.
  //   airplanes.live: /{lat}/{lng}/{r} positional, no key. Caps at 250nm —
  //     over-limit returns 403 (not 400, hence the spurious "Forbidden"
  //     diagnosis until 2026-05-29). Clamp.
  //   adsb.lol: /{lat}/{lng}/{r} positional, tolerates 500nm in practice.
  let url;
  if (base === ADSBX) {
    url = `${base}/lat/${lat}/lon/${lng}/dist/${radius}/`;
  } else if (base === ADSB_FI) {
    const r = Math.min(radius, 250);
    url = `${base}/lat/${lat}/lon/${lng}/dist/${r}`;
  } else if (base === AIRPLANES_LIVE) {
    const r = Math.min(radius, 250);
    url = `${base}/${lat}/${lng}/${r}`;
  } else {
    url = `${base}/${lat}/${lng}/${radius}`;
  }
  const headers = {
    'User-Agent': 'FIRESTORM-proxy/1.2',
    Accept: 'application/json',
  };
  if (base === ADSBX && ADSBX_KEY) headers['x-api-key'] = ADSBX_KEY;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { lat, lng, radius } = req.query || {};
  if (!lat || !lng || !radius) {
    return res
      .status(400)
      .json({ error: 'lat, lng, radius required as query params' });
  }

  // Normalize so cache keys match (40 vs 40.0 vs "40")
  const latN = Number(lat);
  const lngN = Number(lng);
  const radiusN = Math.min(Number(radius) || 500, 500);
  if (
    !Number.isFinite(latN) ||
    !Number.isFinite(lngN) ||
    !Number.isFinite(radiusN)
  ) {
    return res.status(400).json({ error: 'bad lat/lng/radius' });
  }

  const key = `${latN}|${lngN}|${radiusN}`;
  const cached = cache.get(key);
  const now = Date.now();

  // Serve from cache if fresh. Add response header so browser can see age.
  if (cached && now - cached.at < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
    return res.status(200).json(cached.data);
  }

  // Try upstreams in order. ADSBx first (LADD/PIA-immune, paid + licensed,
  // honors 500nm). Then adsb.lol — also honors full 500nm and is the only
  // free source that does, which matters when ADSBx is on outage (2026-05-29
  // 402 billing block exposed this: airplanes.live + adsb.fi both silently
  // cap /point at 250nm, so disks shrink to ~28% area and the operator sees
  // visible gaps between regional polls). adsb.lol moved ahead of
  // airplanes.live + adsb.fi because of that. Skip any tier in cool-down.
  // ADSBx additionally skipped when key isn't configured.
  const tiers = [
    { base: ADSBX,          label: 'adsbx',          key: 'adsbx',          skip: !ADSBX_KEY || now < tierBannedUntil.adsbx },
    { base: ADSB_LOL,       label: 'adsb.lol',       key: 'adsblol',        skip: now < tierBannedUntil.adsblol },
    { base: AIRPLANES_LIVE, label: 'airplanes.live', key: 'airplaneslive',  skip: now < tierBannedUntil.airplaneslive },
    { base: ADSB_FI,        label: 'adsb.fi',        key: 'adsbfi',         skip: now < tierBannedUntil.adsbfi },
    { base: OPENSKY_STATES, label: 'opensky',        key: 'opensky',        skip: now < tierBannedUntil.opensky },
  ];

  let lastErr = null;
  for (const tier of tiers) {
    if (tier.skip) continue;
    try {
      if (tier.key === 'opensky') {
        const { data, remaining } = await fetchOpenSky(latN, lngN, radiusN);
        if (Number.isFinite(remaining) && remaining < OPENSKY_CREDIT_FLOOR) {
          // Serve this answer, then stand down so the shared pipelines keep their budget.
          tierBannedUntil.opensky = now + OPENSKY_FLOOR_COOLDOWN_MS;
        }
        cache.set(key, { at: now, data });
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Upstream', 'opensky');
        return res.status(200).json(data);
      }
      const r = await fetchUpstream(tier.base, latN, lngN, radiusN);
      if (r.status === 401 || r.status === 402 || r.status === 403) {
        tierBannedUntil[tier.key] = now + ENTITLEMENT_COOLDOWN_MS;
        lastErr = `${tier.label} ${r.status}`;
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        tierBannedUntil[tier.key] = now + COOLDOWN_MS;
        lastErr = `${tier.label} ${r.status}`;
        continue;
      }
      if (!r.ok) { lastErr = `${tier.label} ${r.status}`; continue; }
      const data = await r.json();
      cache.set(key, { at: now, data });
      if (cache.size > 500) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) cache.delete(oldest[0]);
      }
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream', tier.label);
      return res.status(200).json(data);
    } catch (e) {
      // AbortError (timeout) and network errors both fall here — cool down. An OpenSky
      // entitlement/credit refusal (401/403/429) stands down for the long cooldown.
      tierBannedUntil[tier.key] = now + ([401, 403, 429].includes(e.status) ? ENTITLEMENT_COOLDOWN_MS : COOLDOWN_MS);
      lastErr = `${tier.label} ${e.message || e.name}`;
    }
  }

  // All upstreams failed — serve stale if we have it.
  if (cached) {
    res.setHeader('X-Cache', 'STALE');
    res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
    return res.status(200).json(cached.data);
  }
  return res.status(502).json({ error: `all upstreams failed: ${lastErr}` });
}
