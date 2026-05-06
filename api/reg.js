/**
 * FIRESTORM aircraft registration lookup proxy.
 *
 * Wraps ADSBx Enterprise /v2/registration/{regs}/ so the FIRESTORM frontend
 * can enrich aircraft popups (owner / make / model / type) on click without
 * exposing the ADSBx API key to the browser.
 *
 * Usage: /api/reg?r=N123AB        (single)
 *        /api/reg?r=N123AB,N456CD  (batch, comma-separated)
 *
 * Caches per-reg responses for 30 min — registration data is static enough
 * that we don't need fresh lookups, and we want to keep upstream load light
 * even if every popup click hits us.
 *
 * Returns the same shape as ADSBx /v2/registration/{reg}/:
 *   { ac: [...], msg: 'No error', total: N }
 */

const ADSBX_BASE = 'https://adsbexchange.com/api/aircraft/v2/registration';
const ADSBX_KEY = process.env.ADSBX_API_KEY || '';
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 min — reg data is effectively static

// Module-scope cache, persists across warm invocations on the same Vercel container.
const cache = new Map();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const r = (req.query && req.query.r) || '';
  if (!r || !/^[A-Za-z0-9,\-]+$/.test(r)) {
    return res.status(400).json({ error: 'r= required (registration, alphanumeric/dash/comma only)' });
  }
  if (!ADSBX_KEY) {
    return res.status(500).json({ error: 'ADSBX_API_KEY not configured on proxy' });
  }
  // Normalize to uppercase for cache hits across casings
  const key = r.toUpperCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age-Ms', String(now - cached.at));
    return res.status(200).json(cached.data);
  }

  try {
    const upstream = `${ADSBX_BASE}/${encodeURIComponent(key)}/`;
    const r2 = await fetch(upstream, {
      headers: {
        'x-api-key': ADSBX_KEY,
        'User-Agent': 'FIRESTORM-proxy/1.1',
        Accept: 'application/json',
      },
    });
    if (!r2.ok) {
      return res.status(r2.status).json({ error: `upstream ${r2.status}` });
    }
    const data = await r2.json();
    cache.set(key, { at: now, data });
    if (cache.size > 1000) {
      // Trim oldest 100 entries when cache gets fat
      const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < 100; i++) cache.delete(entries[i][0]);
    }
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Upstream', 'adsbx');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: `proxy error: ${e.message}` });
  }
}
