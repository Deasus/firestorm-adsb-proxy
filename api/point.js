/**
 * FIRESTORM ADS-B proxy — 5-second cached edge function
 *
 * Sits between the FIRESTORM frontend and airplanes.live. The frontend
 * polls this function every 5s per region; we cache responses for 5s
 * (per-region key) so N UAT users concurrently polling the same region
 * still result in 1 upstream call per 5s. This is what prevents the HTTP
 * 429 rate-limiting we hit when the browser polled airplanes.live directly.
 *
 * Usage: /api/point?lat=40&lng=-115&radius=500
 * Returns: same shape as api.airplanes.live/v2/point (keys: ac, msg, now, total, ctime, ptime)
 * CORS: Access-Control-Allow-Origin: * so the FIRESTORM HTML can call it.
 */

const PRIMARY = 'https://api.airplanes.live/v2/point';
const FAILOVER = 'https://api.adsb.lol/v2/point';
const CACHE_TTL_MS = 5000;

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
  const url = `${base}/${lat}/${lng}/${radius}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'FIRESTORM-proxy/1.0',
      Accept: 'application/json',
    },
  });
  return r;
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

  // Upstream fetch. Try primary unless we've been 429'd recently.
  let base = now < primaryBannedUntil ? FAILOVER : PRIMARY;
  let usedFailover = base === FAILOVER;

  try {
    let r = await fetchUpstream(base, latN, lngN, radiusN);

    // Primary got rate limited — cool it for 5 min + try failover
    if (r.status === 429 && !usedFailover) {
      primaryBannedUntil = now + 5 * 60 * 1000;
      base = FAILOVER;
      usedFailover = true;
      r = await fetchUpstream(base, latN, lngN, radiusN);
    }

    if (!r.ok) {
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream', usedFailover ? 'failover' : 'primary');
      // If we have a stale cache, serve it rather than fail
      if (cached) {
        res.setHeader('X-Cache', 'STALE');
        res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
        return res.status(200).json(cached.data);
      }
      return res
        .status(502)
        .json({ error: `upstream ${r.status}`, via: usedFailover ? 'failover' : 'primary' });
    }

    const data = await r.json();
    cache.set(key, { at: now, data });

    // Opportunistic memory cap so the map doesn't grow forever. Cache entries
    // for rarely-requested (lat,lng,radius) combos expire by LRU (roughly).
    if (cache.size > 500) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Upstream', usedFailover ? 'failover' : 'primary');
    return res.status(200).json(data);
  } catch (e) {
    // Network/DNS failure — if we have ANY cached data for this region, serve it
    if (cached) {
      res.setHeader('X-Cache', 'STALE');
      res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
      return res.status(200).json(cached.data);
    }
    return res.status(502).json({ error: `proxy failed: ${e.message}` });
  }
}
