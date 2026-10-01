/**
 * FIRESTORM aircraft registration lookup proxy.
 *
 * Enriches aircraft popups (owner / make / model / type) on click. Cascade:
 *
 *   1. ADSBx Enterprise  /v2/registration/{reg}/   — only if ADSBX_API_KEY is set
 *   2. adsb.lol          /v2/reg/{reg}             — free, no key
 *   3. adsb.fi           /api/v2/registration/{reg} — free, no key
 *
 * WHY THE CASCADE EXISTS (2026-10-01). This route used to call ADSBx and nothing else.
 * When ADSBx began answering 402 "Please purchase a key to access this service", the
 * route answered {"error":"upstream 402"} for EVERY lookup, on Prod and AWS DEV alike —
 * while /api/point, which already had a cascade, kept working and made the aviation
 * layer look healthy. Both free endpoints were tested against a live airborne tail
 * before being wired in. All three speak the same readsb v2 shape, so the frontend's
 * parser needs no change.
 *
 * Like ADSBx's, the free endpoints return an aircraft only while it is being tracked —
 * the semantics of this route are unchanged.
 *
 * Usage: /api/reg?r=N123AB        (single)
 *        /api/reg?r=N123AB,N456CD  (batch, comma-separated)
 *
 * Batches are fanned out ONE TAIL PER REQUEST and merged. Measured: a comma list sent
 * to adsb.lol or adsb.fi returns at most one aircraft, so passing it through would
 * silently drop every tail after the first.
 *
 * Caches per-reg responses for 30 min — registration data is static enough that we
 * don't need fresh lookups, and we want to keep upstream load light even if every
 * popup click hits us.
 *
 * Returns { ac: [...], msg, total, now }, plus X-Upstream naming the source(s) used.
 */

const ADSBX_BASE = 'https://adsbexchange.com/api/aircraft/v2/registration';
const ADSBX_KEY = process.env.ADSBX_API_KEY || '';
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 min — reg data is effectively static
// adsb.lol answers in ~0.4-0.9 s but was measured stalling to 12 s. 3.5 s keeps a popup
// lookup tolerable when it stalls, falling through to adsb.fi. Sequential, not raced:
// these are community-run services and a race would double our load on both.
const UPSTREAM_TIMEOUT_MS = 3500;
const MAX_BATCH = 20;

// A 402/401/403 from ADSBx is an ENTITLEMENT answer, not a blip. Without a breaker every
// lookup would spend a round trip learning it again. Re-checked every 15 minutes so a
// renewed key is picked up without a redeploy.
const ADSBX_BREAKER_MS = 15 * 60 * 1000;
let adsbxDeadUntil = 0;

// Module-scope cache, persists across warm invocations on the same Vercel container.
const cache = new Map();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'FIRESTORM-proxy/1.2', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

const SOURCES = [
  {
    label: 'adsbx',
    enabled: () => !!ADSBX_KEY && Date.now() >= adsbxDeadUntil,
    url: reg => `${ADSBX_BASE}/${encodeURIComponent(reg)}/`,
    headers: () => ({ 'x-api-key': ADSBX_KEY }),
    onError: e => { if ([401, 402, 403].includes(e.status)) adsbxDeadUntil = Date.now() + ADSBX_BREAKER_MS; },
  },
  {
    label: 'adsb.lol',
    enabled: () => true,
    url: reg => `https://api.adsb.lol/v2/reg/${encodeURIComponent(reg)}`,
  },
  {
    label: 'adsb.fi',
    enabled: () => true,
    url: reg => `https://opendata.adsb.fi/api/v2/registration/${encodeURIComponent(reg)}`,
  },
];

// One tail through the cascade. A source that answers but has no aircraft is NOT a
// failure — the tail may simply not be airborne — but the next source may track it
// (coverage differs), so keep going until one returns aircraft.
async function lookupOne(reg) {
  const now = Date.now();
  const hit = cache.get(reg);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ac: hit.ac, source: 'cache' };

  const tried = [];
  let answered = null;
  for (const s of SOURCES) {
    if (!s.enabled()) continue;
    try {
      const d = await getJson(s.url(reg), s.headers ? s.headers() : {});
      const ac = Array.isArray(d && d.ac) ? d.ac : [];
      if (ac.length) {
        cache.set(reg, { at: now, ac });
        return { ac, source: s.label };
      }
      answered = answered || s.label;
      tried.push(`${s.label}:empty`);
    } catch (e) {
      if (s.onError) s.onError(e);
      tried.push(`${s.label}:${e.status || (e.name === 'TimeoutError' ? 'timeout' : 'error')}`);
    }
  }
  // Every source failed outright (nothing even answered) -> a real upstream outage.
  if (!answered) {
    const e = new Error('all upstreams failed');
    e.tried = tried;
    throw e;
  }
  return { ac: [], source: answered };   // not airborne anywhere; not an error
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const r = (req.query && req.query.r) || '';
  if (!r || !/^[A-Za-z0-9,\-]+$/.test(r)) {
    return res.status(400).json({ error: 'r= required (registration, alphanumeric/dash/comma only)' });
  }
  const regs = [...new Set(r.toUpperCase().split(',').filter(Boolean))].slice(0, MAX_BATCH);

  const results = await Promise.allSettled(regs.map(lookupOne));
  const ac = [], sources = new Set(), failures = [];
  results.forEach((x, i) => {
    if (x.status === 'fulfilled') { ac.push(...x.value.ac); sources.add(x.value.source); }
    else failures.push({ reg: regs[i], tried: x.reason.tried || [] });
  });

  if (failures.length === regs.length) {
    // Total outage: say so, with what was tried, rather than an opaque 502.
    return res.status(502).json({ error: 'all upstreams failed', tried: failures[0].tried });
  }
  res.setHeader('X-Upstream', [...sources].join(','));
  res.setHeader('X-Cache', sources.size === 1 && sources.has('cache') ? 'HIT' : 'MISS');
  return res.status(200).json({ ac, msg: 'No error', total: ac.length, now: Date.now() });
}
