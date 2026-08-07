/**
 * FIRESTORM — LANDFIRE relay (Dr FIRESTORM fuels + canopy)
 *
 * WHY THIS EXISTS. lfps.usgs.gov serves LANDFIRE LF2025 ImageServers that
 * return exactly the data Dr FIRESTORM needs (fuel-model distribution, canopy
 * cover/height/base-height/bulk-density, disturbance) in under a second per
 * layer via getSamples. It is NOT usable from a browser:
 *
 *   • curl — any Origin, any User-Agent (including a full Chrome header set),
 *     and the OPTIONS preflight — all return `Access-Control-Allow-Origin: *`
 *   • a real Chrome fetch — the header is ABSENT and the request is blocked
 *
 * Measured 2026-07-31 and re-confirmed 2026-08-06. The failing response could
 * not be reproduced outside a browser, so the mechanism is UNCONFIRMED (most
 * likely an edge/WAF tier that varies by client fingerprint). What IS confirmed:
 * the browser cannot read that host, and no client-side change fixes it.
 * Note elevation.nationalmap.gov (3DEP, used for AOI elevation) works fine
 * in-browser — this is host-specific, not a USGS-wide policy.
 *
 * So: relay it. Same shape as the other routes here — allowlisted upstream,
 * short edge cache, permissive CORS for the FIRESTORM HTML.
 *
 * SECURITY POSTURE (deliberate, do not loosen):
 *   • The upstream host is HARDCODED. The caller supplies a layer NAME from a
 *     fixed allowlist and an envelope — never a URL. Without that this route
 *     would be an open forward proxy that anyone could point at any host,
 *     including internal AWS metadata endpoints.
 *   • Envelope numbers are parsed and range-checked, so a caller cannot smuggle
 *     query syntax through them.
 *   • No credentials are attached. LANDFIRE is public data; if this ever needs
 *     a key, the key belongs in Secrets Manager and NOT in a query string.
 *   • Read-only: GET/OPTIONS only.
 *
 * Usage:
 *   /api/landfire?layer=FBFM40&xmin=-120.3&ymin=44.7&xmax=-120.1&ymax=44.9
 *                &count=900
 * Returns: the upstream getSamples JSON verbatim (or {error:{message}}).
 */

const LF_HOST = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2025';

// Allowlist: short name -> ImageServer. CONUS only; the Alaska services exist
// (LF2025_*_AK) and can be added when a caller needs them.
const LAYERS = {
  FBFM40: 'LF2025_FBFM40_CONUS',   // 40 Scott & Burgan fire behavior fuel models
  FBFM13: 'LF2025_FBFM13_CONUS',   // 13 Anderson
  CC:     'LF2025_CC_CONUS',       // canopy cover, %
  CH:     'LF2025_CH_CONUS',       // canopy height, m x10
  CBH:    'LF2025_CBH_CONUS',      // canopy base height, m x10
  CBD:    'LF2025_CBD_CONUS',      // canopy bulk density, kg/m3 x100
  FVT:    'LF2025_FVT_CONUS',      // existing vegetation type
  FDist:  'LF2025_FDist_CONUS',    // fuel disturbance
  EVC:    'LF2025_EVC_CONUS',
  EVH:    'LF2025_EVH_CONUS'
};

const CACHE_S = 900;        // LANDFIRE is an annual product; 15 min is generous
const UPSTREAM_TIMEOUT_MS = 8000;

function bad(res, code, msg) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json({ error: { message: msg } });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') return bad(res, 405, 'GET only');

  const q = req.query || {};
  const svc = LAYERS[String(q.layer || '')];
  if (!svc) {
    return bad(res, 400,
      'unknown layer "' + String(q.layer || '') + '" — allowed: ' +
      Object.keys(LAYERS).join(', '));
  }

  // Envelope: parse to numbers so nothing the caller sends reaches the upstream
  // as text. Reject anything outside plausible CONUS-ish bounds.
  const n = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };
  const xmin = n(q.xmin), ymin = n(q.ymin), xmax = n(q.xmax), ymax = n(q.ymax);
  if (xmin === null || ymin === null || xmax === null || ymax === null)
    return bad(res, 400, 'xmin, ymin, xmax, ymax are required and must be numeric');
  if (xmin >= xmax || ymin >= ymax)
    return bad(res, 400, 'envelope is inverted or degenerate');
  if (xmin < -180 || xmax > -60 || ymin < 15 || ymax > 75)
    return bad(res, 400, 'envelope outside supported bounds');
  // A huge envelope with a big sample count is how you accidentally DoS the
  // upstream (and blow the function budget). Cap both.
  if ((xmax - xmin) > 12 || (ymax - ymin) > 12)
    return bad(res, 400, 'envelope too large — max 12 degrees per side');

  let count = parseInt(q.count, 10);
  if (!Number.isFinite(count) || count < 1) count = 600;
  count = Math.min(count, 2000);

  const geometry = JSON.stringify({
    xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 }
  });
  const url = LF_HOST + '/' + svc + '/ImageServer/getSamples'
    + '?geometry=' + encodeURIComponent(geometry)
    + '&geometryType=esriGeometryEnvelope'
    + '&sampleCount=' + count
    + '&returnFirstValueOnly=true&f=json';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const up = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!up.ok) return bad(res, 502, 'LANDFIRE upstream ' + up.status);
    const j = await up.json();
    // ArcGIS returns HTTP 200 with an {error:...} body on a bad request — pass
    // it through as a 502 rather than letting a caller read it as success.
    if (j && j.error)
      return bad(res, 502, 'LANDFIRE: ' + (j.error.message || 'query error'));
    res.setHeader('Cache-Control',
      'public, s-maxage=' + CACHE_S + ', stale-while-revalidate=' + CACHE_S);
    res.status(200).json(j);
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError');
    return bad(res, aborted ? 504 : 502,
      aborted ? 'LANDFIRE upstream timed out' : ('LANDFIRE relay failed: ' + String(e && e.message || e)));
  }
}
