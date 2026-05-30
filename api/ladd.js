/**
 * FIRESTORM LADD-flagged aircraft proxy — global, cached.
 *
 * LADD = Limiting Aircraft Data Displayed (FAA opt-out program). Includes
 * DOI / forestry / contracted-fleet aircraft that don't appear in /point
 * regional queries. ~550 aircraft globally, one shot.
 *
 * Cascade: ADSBx (paid) → airplanes.live → adsb.lol. adsb.fi does NOT
 * expose /v2/ladd (returns HTTP 400) so it's omitted here. With ADSBx out,
 * we get LADD coverage from airplanes.live with adsb.lol as backup —
 * verified 2026-05-29: airplanes.live /v2/ladd returns 547 aircraft with
 * dbFlags=8 (the LADD bitfield), schema-identical to ADSBx.
 *
 * Frontend polls every 30s. 15s server cache.
 *
 * Usage: /api/ladd
 * Returns: same shape as airplanes.live/v2/ladd
 * CORS: Access-Control-Allow-Origin: *
 */

const ADSBX_LADD = 'https://adsbexchange.com/api/aircraft/v2/ladd/';
const AIRPLANES_LIVE_LADD = 'https://api.airplanes.live/v2/ladd';
const ADSB_LOL_LADD = 'https://api.adsb.lol/v2/ladd';
const CACHE_TTL_MS = 15 * 1000;
const UPSTREAM_TIMEOUT_MS = 5000;        // ladd can be slower (550 ac payload)
const COOLDOWN_MS = 30 * 1000;
const ADSBX_KEY = process.env.ADSBX_API_KEY || '';

let cached = null;
const tierBannedUntil = { adsbx: 0, airplaneslive: 0, adsblol: 0 };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchUpstream(url, withKey) {
  const headers = {
    'User-Agent': 'FIRESTORM-proxy/1.2',
    Accept: 'application/json',
  };
  if (withKey && ADSBX_KEY) headers['x-api-key'] = ADSBX_KEY;
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

  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
    return res.status(200).json(cached.data);
  }

  const tiers = [
    { url: ADSBX_LADD,          label: 'adsbx',          key: 'adsbx',         withKey: true,  skip: !ADSBX_KEY || now < tierBannedUntil.adsbx },
    { url: AIRPLANES_LIVE_LADD, label: 'airplanes.live', key: 'airplaneslive', withKey: false, skip: now < tierBannedUntil.airplaneslive },
    { url: ADSB_LOL_LADD,       label: 'adsb.lol',       key: 'adsblol',       withKey: false, skip: now < tierBannedUntil.adsblol },
  ];

  let lastErr = null;
  for (const tier of tiers) {
    if (tier.skip) continue;
    try {
      const r = await fetchUpstream(tier.url, tier.withKey);
      if (r.status === 429 || r.status >= 500) {
        tierBannedUntil[tier.key] = now + COOLDOWN_MS;
        lastErr = `${tier.label} ${r.status}`;
        continue;
      }
      if (!r.ok) { lastErr = `${tier.label} ${r.status}`; continue; }
      const data = await r.json();
      cached = { at: now, data };
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream', tier.label);
      return res.status(200).json(data);
    } catch (e) {
      tierBannedUntil[tier.key] = now + COOLDOWN_MS;
      lastErr = `${tier.label} ${e.message || e.name}`;
    }
  }

  if (cached) {
    res.setHeader('X-Cache', 'STALE');
    res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
    return res.status(200).json(cached.data);
  }
  return res.status(502).json({ error: `all upstreams failed: ${lastErr}` });
}
