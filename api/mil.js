/**
 * FIRESTORM military aircraft proxy — global, cached.
 *
 * Cascade: ADSBx (paid, when key set) → airplanes.live → adsb.fi → adsb.lol.
 * All four sources expose /v2/mil with the same readsb-derived schema
 * (ac[], hex, flight, r, t, lat, lon, dbFlags, ...). ~250 aircraft globally,
 * one shot, no region tiling needed.
 *
 * Frontend polls every 30s — military aircraft are operationally relevant
 * but don't need 5s freshness for SA. 15s server cache so two browsers
 * don't double-poll.
 *
 * Usage: /api/mil
 * Returns: same shape as airplanes.live/v2/mil
 * CORS: Access-Control-Allow-Origin: *
 */

const ADSBX_MIL = 'https://adsbexchange.com/api/aircraft/v2/mil/';
const AIRPLANES_LIVE_MIL = 'https://api.airplanes.live/v2/mil';
const ADSB_FI_MIL = 'https://opendata.adsb.fi/api/v2/mil';
const ADSB_LOL_MIL = 'https://api.adsb.lol/v2/mil';
const CACHE_TTL_MS = 15 * 1000;
const UPSTREAM_TIMEOUT_MS = 4000;
const COOLDOWN_MS = 30 * 1000;
const ADSBX_KEY = process.env.ADSBX_API_KEY || '';

let cached = null;
const tierBannedUntil = { adsbx: 0, airplaneslive: 0, adsbfi: 0, adsblol: 0 };

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
    { url: ADSBX_MIL,          label: 'adsbx',          key: 'adsbx',         withKey: true,  skip: !ADSBX_KEY || now < tierBannedUntil.adsbx },
    { url: AIRPLANES_LIVE_MIL, label: 'airplanes.live', key: 'airplaneslive', withKey: false, skip: now < tierBannedUntil.airplaneslive },
    { url: ADSB_FI_MIL,        label: 'adsb.fi',        key: 'adsbfi',        withKey: false, skip: now < tierBannedUntil.adsbfi },
    { url: ADSB_LOL_MIL,       label: 'adsb.lol',       key: 'adsblol',       withKey: false, skip: now < tierBannedUntil.adsblol },
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
