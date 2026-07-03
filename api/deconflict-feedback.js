/**
 * FIRESTORM VIIRS/MODIS deconfliction — operator verdict capture.
 *
 * The frontend (index.html deconflict IIFE) POSTs a JSON payload here every
 * time an operator taps REAL FIRE / KNOWN INDUSTRIAL / KNOWN VOLCANO /
 * OFFSHORE / UNSURE on a flagged detection popup. We forward each verdict
 * as a GitHub Issue in the private Deasus/firestorm-deconflict-feedback
 * repo. Weekly digest cron aggregates + emails to NASA FIRMS validation
 * team (Louis Giglio at UMD, Wilfrid Schroeder at NOAA NESDIS).
 *
 * Auth model: the browser never sees a GitHub token. This function holds
 * GITHUB_FEEDBACK_TOKEN (a PAT scoped to firestorm-deconflict-feedback
 * with issues:write) as a Vercel env var. CORS is wide open to the
 * FIRESTORM frontend origin (single-file HTML deployed to GH Pages +
 * Vercel dev preview).
 *
 * Best-effort: if GH is down / token missing / rate limit, we return
 * a soft 202 so the operator's action isn't blocked. The frontend keeps
 * a localStorage journal as backup.
 *
 * NOT for high-cardinality data — GitHub Issues has soft limits at
 * ~1000/day per repo. FIRESTORM operator base is small (dozens) so
 * we're well within budget. If usage scales, migrate to a real datastore
 * (Aurora Serverless or a SQLite-on-Turso free tier).
 */

const FEEDBACK_REPO_OWNER = 'Deasus';
const FEEDBACK_REPO_NAME  = 'firestorm-deconflict-feedback';

// Verdict enum matches the frontend button labels. Any other value → 400.
const VALID_VERDICTS = new Set([
  'real_fire',
  'industrial',
  'volcano',
  'offshore',
  'unsure',
]);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

// Trim / clamp free-form strings so we don't get a 100MB Issue body from a
// runaway client. Operator verdicts are structured, this is defense-in-depth.
function _s(v, max = 200) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function _n(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', allowed: ['POST'] });
  }

  // Vercel auto-parses application/json into req.body; guard both shapes.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_json_body' });
  }

  // Validate the verdict enum — everything else is optional context.
  const verdict = String(body.operator_verdict || '').toLowerCase();
  if (!VALID_VERDICTS.has(verdict)) {
    return res.status(400).json({
      error: 'invalid_verdict',
      expected: [...VALID_VERDICTS],
      got: verdict || null,
    });
  }

  const lat = _n(body.lat);
  const lng = _n(body.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'invalid_lat_lng', got: { lat, lng } });
  }

  // Structured verdict record — same shape the weekly digest consumes.
  const record = {
    v: 1,
    verdict,
    lat, lng,
    sensor:              _s(body.sensor, 20),
    acq_date:            _s(body.acq_date, 20),
    acq_time:            _s(body.acq_time, 10),
    pipeline_flag:       _s(body.pipeline_flag, 60),
    nearest_infra:       _s(body.nearest_infra, 200),
    nearest_infra_m:     _n(body.nearest_infra_m),
    nearest_infra_class: _s(body.nearest_infra_class, 60),
    frp:                 _n(body.frp),
    confidence:          _s(body.confidence, 20),
    brightness_k:        _n(body.brightness_k),
    user_agent:          _s(body.user_agent, 400),
    submitted_at:        _s(body.submitted_at, 40) || new Date().toISOString(),
    received_at:         new Date().toISOString(),
  };

  const title = `${verdict.toUpperCase()} ${lat.toFixed(3)},${lng.toFixed(3)} ` +
                `[${record.pipeline_flag || 'clear'}] ${record.sensor || '?'}`;
  const bodyMd = [
    '**Operator verdict** — FIRESTORM VIIRS/MODIS deconfliction feedback loop.',
    '',
    `- Verdict: **${verdict.replace(/_/g, ' ').toUpperCase()}**`,
    `- Location: \`${lat.toFixed(5)}, ${lng.toFixed(5)}\``,
    `- Sensor: \`${record.sensor || 'unknown'}\``,
    `- Detection time: \`${record.acq_date || '?'} ${record.acq_time || ''} UTC\``,
    `- Pipeline flag: \`${record.pipeline_flag || 'clear'}\``,
    `- Confidence: \`${record.confidence || '?'}\`  FRP: \`${record.frp ?? '?'}\` MW  ` +
      `Brightness: \`${record.brightness_k ?? '?'}\` K`,
    record.nearest_infra ? `- Nearest infra: \`${record.nearest_infra}\` ` +
      `(\`${record.nearest_infra_class}\`) at \`${record.nearest_infra_m}m\`` : '',
    '',
    '**Provenance:**',
    `- Submitted: \`${record.submitted_at}\``,
    `- Received:  \`${record.received_at}\``,
    `- Client:    \`${record.user_agent || 'unknown'}\``,
    '',
    '---',
    '**Structured record (parsed by weekly digest script):**',
    '',
    '```json',
    JSON.stringify(record, null, 2),
    '```',
  ].filter(Boolean).join('\n');

  // Labels for easy filtering + digest queries
  const labels = [
    'operator-verdict',
    `verdict:${verdict}`,
    record.pipeline_flag ? `flag:${record.pipeline_flag}` : null,
    record.sensor ? `sensor:${record.sensor.toLowerCase()}` : null,
  ].filter(Boolean);

  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  if (!token) {
    // Soft-fail: return 202 so the frontend doesn't retry indefinitely,
    // but tag the response so ops can see the misconfig in logs.
    console.warn('[deconflict-feedback] GITHUB_FEEDBACK_TOKEN not set — record dropped');
    return res.status(202).json({
      ok: false,
      stored: 'localStorage_only',
      reason: 'server_token_missing',
    });
  }

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${FEEDBACK_REPO_OWNER}/${FEEDBACK_REPO_NAME}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'firestorm-deconflict-feedback/1.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body: bodyMd, labels }),
      },
    );

    if (!ghRes.ok) {
      const errText = await ghRes.text();
      console.warn(`[deconflict-feedback] GitHub API ${ghRes.status}: ${errText.slice(0, 300)}`);
      // Still return 202 — the operator did their part; server issue is ours.
      return res.status(202).json({
        ok: false,
        stored: 'localStorage_only',
        reason: 'github_api_error',
        github_status: ghRes.status,
      });
    }

    const issue = await ghRes.json();
    return res.status(201).json({
      ok: true,
      stored: 'github_issue',
      issue_number: issue.number,
      issue_url: issue.html_url,
    });
  } catch (e) {
    console.warn(`[deconflict-feedback] fetch failed: ${e.message}`);
    return res.status(202).json({
      ok: false,
      stored: 'localStorage_only',
      reason: 'fetch_exception',
    });
  }
}
