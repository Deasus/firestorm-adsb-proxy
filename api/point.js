/**
 * FIRESTORM ADS-B proxy — 5-second cached edge function
 *
 * 2026-05-06: PRIMARY is now ADSBx Enterprise (LADD/PIA-immune feeder
 * network — captures DOI + contracted aircraft that airplanes.live filters
 * out). API key kept server-side via process.env.ADSBX_API_KEY (Vercel env).
 * airplanes.live remains as failover #1; adsb.lol as failover #2.
 *
 * Sits between the FIRESTORM frontend and ADSBx. The frontend polls this
 * function every 5s per region; we cache responses for 5s (per-region
 * key) so N UAT users concurrently polling the same region still result
 * in 1 upstream call per 5s.
 *
 * Usage: /api/point?lat=40&lng=-115&radius=500
 * Returns: same shape as airplanes.live/v2/point (keys: ac, msg, now, total)
 * CORS: Access-Control-Allow-Origin: * so the FIRESTORM HTML can call it.
 */

const ADSBX = 'https://adsbexchange.com/api/aircraft/v2';
const FAILOVER1 = 'https://api.airplanes.live/v2/point';
const FAILOVER2 = 'https://api.adsb.lol/v2/point';
const CACHE_TTL_MS = 5000;
const ADSBX_KEY = process.env.ADSBX_API_KEY || '';

// In-memory cache. Vercel may cold-start between invocations, but when the
// function is "warm" (last invoked within ~15 min) the module-scope cache
// persists across requests to the same container. Under UAT load, warm is
// the steady state, so 5s cache is effective.
const cache = new Map();

// Brief a 429 from primary so we don't hammer it. Vercel region isolation
// means this state is per-datacenter; fine for this use case.
let primaryBannedUntil = 0;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchUpstream(base, lat, lng, radius) {
  // ADSBx uses /lat/{lat}/lon/{lng}/dist/{radius}/ + x-api-key header.
  // airplanes.live + adsb.lol use /{lat}/{lng}/{radius} positional + no auth.
  const isAdsbx = base === ADSBX;
  const url = isAdsbx
    ? `${base}/lat/${lat}/lon/${lng}/dist/${radius}/`
    : `${base}/${lat}/${lng}/${radius}`;
  const headers = {
    'User-Agent': 'FIRESTORM-proxy/1.1',
    Accept: 'application/json',
  };
  if (isAdsbx && ADSBX_KEY) headers['x-api-key'] = ADSBX_KEY;
  return fetch(url, { headers });
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

  // Try upstreams in order. ADSBx first (LADD/PIA-immune, paid), then
  // airplanes.live (free), then adsb.lol (free, no CORS but server-side OK).
  // Cool down ADSBx if it 429s (shouldn't on Enterprise, but defensive).
  const tiers = [
    { base: ADSBX,     label: 'adsbx',         skip: !ADSBX_KEY || now < primaryBannedUntil },
    { base: FAILOVER1, label: 'airplanes.live', skip: false },
    { base: FAILOVER2, label: 'adsb.lol',       skip: false },
  ];

  let lastErr = null;
  for (const tier of tiers) {
    if (tier.skip) continue;
    try {
      const r = await fetchUpstream(tier.base, latN, lngN, radiusN);
      if (r.status === 429 && tier.label === 'adsbx') {
        primaryBannedUntil = now + 5 * 60 * 1000;
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
      lastErr = `${tier.label} ${e.message}`;
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
