/**
 * FIRESTORM proxy self-test harness.
 *
 * Runs from the Vercel edge against every upstream the proxy depends on,
 * for every operational endpoint shape (point/mil/ladd/pia). Returns a
 * structured matrix so we can answer "does airplanes.live / adsb.fi work
 * from Vercel's IPs?" without promoting to prod.
 *
 * Calls upstreams DIRECTLY (not through our own /api/* endpoints) so each
 * row is an independent probe — a hung tier doesn't block the others.
 *
 * Usage: GET /api/_selftest          (default region: Idaho 44/-115/500)
 *        GET /api/_selftest?lat=...&lng=...&radius=...
 *
 * NOT exposed to operators. Diagnostic only. Cheap to leave deployed.
 */

const ADSBX_KEY = process.env.ADSBX_API_KEY || '';
const TIMEOUT_MS = 6000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
}

async function probe(url, withKey, label) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = {
    'User-Agent': 'FIRESTORM-proxy-selftest/1.0',
    Accept: 'application/json',
  };
  if (withKey && ADSBX_KEY) headers['x-api-key'] = ADSBX_KEY;
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const dt = Date.now() - t0;
    const text = await r.text();
    let acCount = null;
    let sample = null;
    try {
      const j = JSON.parse(text);
      const ac = j.ac || [];
      acCount = ac.length;
      if (ac[0]) {
        sample = {
          hex: ac[0].hex,
          flight: (ac[0].flight || '').trim(),
          r: ac[0].r,
          t: ac[0].t,
          dbFlags: ac[0].dbFlags,
        };
      }
    } catch (_) {}
    return {
      label,
      url,
      status: r.status,
      ok: r.ok,
      latency_ms: dt,
      bytes: text.length,
      ac_count: acCount,
      sample,
      body_head: r.ok ? null : text.slice(0, 200),
    };
  } catch (e) {
    return {
      label,
      url,
      status: 0,
      ok: false,
      latency_ms: Date.now() - t0,
      error: e.name === 'AbortError' ? 'timeout' : (e.message || e.name),
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const lat = Number(req.query?.lat ?? 44);
  const lng = Number(req.query?.lng ?? -115);
  const radius = Math.min(Number(req.query?.radius ?? 500), 500);
  // Per-source radius caps (matches what the real proxy sends — see point.js).
  // adsb.fi caps at 250nm (over → 400). airplanes.live caps at 250nm (over →
  // 403, not 400, hence the spurious "Forbidden" misdiagnosis on 2026-05-29).
  const fiRadius = Math.min(radius, 250);
  const alRadius = Math.min(radius, 250);

  // Region matrix — sends each source the URL shape the real proxy would use.
  const pointTargets = [
    { label: 'adsbx',          url: `https://adsbexchange.com/api/aircraft/v2/lat/${lat}/lon/${lng}/dist/${radius}/`, key: true },
    { label: 'airplanes.live', url: `https://api.airplanes.live/v2/point/${lat}/${lng}/${alRadius}`,                  key: false },
    { label: 'adsb.fi',        url: `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lng}/dist/${fiRadius}`,         key: false },
    { label: 'adsb.lol',       url: `https://api.adsb.lol/v2/point/${lat}/${lng}/${radius}`,                          key: false },
  ];

  // Global endpoints — exercise mil/ladd/pia cascades.
  const milTargets = [
    { label: 'adsbx',          url: `https://adsbexchange.com/api/aircraft/v2/mil/`, key: true },
    { label: 'airplanes.live', url: `https://api.airplanes.live/v2/mil`,             key: false },
    { label: 'adsb.fi',        url: `https://opendata.adsb.fi/api/v2/mil`,           key: false },
    { label: 'adsb.lol',       url: `https://api.adsb.lol/v2/mil`,                   key: false },
  ];
  const laddTargets = [
    { label: 'adsbx',          url: `https://adsbexchange.com/api/aircraft/v2/ladd/`, key: true },
    { label: 'airplanes.live', url: `https://api.airplanes.live/v2/ladd`,             key: false },
    { label: 'adsb.lol',       url: `https://api.adsb.lol/v2/ladd`,                   key: false },
  ];
  const piaTargets = [
    { label: 'adsbx',          url: `https://adsbexchange.com/api/aircraft/v2/pia/`, key: true },
    { label: 'airplanes.live', url: `https://api.airplanes.live/v2/pia`,             key: false },
    { label: 'adsb.lol',       url: `https://api.adsb.lol/v2/pia`,                   key: false },
  ];

  // /point probes run SEQUENTIALLY — adsb.fi rate-limits at 1 req/sec and
  // parallel fan-out tripped a spurious 429 on 2026-05-29. mil/ladd/pia hit
  // different paths so they're safe to run in parallel with /point.
  const sequential = async (targets) => {
    const out = [];
    for (const t of targets) {
      out.push(await probe(t.url, t.key, t.label));
    }
    return out;
  };
  const [point, mil, ladd, pia] = await Promise.all([
    sequential(pointTargets),
    Promise.all(milTargets.map(t  => probe(t.url, t.key, t.label))),
    Promise.all(laddTargets.map(t => probe(t.url, t.key, t.label))),
    Promise.all(piaTargets.map(t  => probe(t.url, t.key, t.label))),
  ]);

  // Verdict per endpoint = the first tier that returned ok in cascade order.
  const verdict = (rows) => {
    const winner = rows.find(r => r.ok && r.ac_count !== null);
    return winner ? `${winner.label} ${winner.latency_ms}ms ${winner.ac_count}ac` : 'ALL FAILED';
  };

  return res.status(200).json({
    ts: new Date().toISOString(),
    region: { lat, lng, radius, fi_radius: fiRadius },
    adsbx_key_configured: Boolean(ADSBX_KEY),
    summary: {
      point: verdict(point),
      mil: verdict(mil),
      ladd: verdict(ladd),
      pia: verdict(pia),
    },
    point,
    mil,
    ladd,
    pia,
  });
}
