import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The summary is embedded as JSON inside a <script>. Escape "<" so a project
// name or title containing "</script>" cannot break out of it.
export function renderHtml(summary) {
  const template = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const BS = String.fromCharCode(92);
  const json = JSON.stringify(summary).replace(/</g, BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");
  // A function replacement, so "$&" or "$'" inside a title is not treated as a pattern.
  return template.replace('/*__DATA__*/null', () => json);
}

const fmt = (n) => (n == null ? 'n/a' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

function dur(ms) {
  if (ms == null) return 'n/a';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function renderText(s) {
  const lines = [];
  const row = (name, w) => {
    if (!w) return `${name.padEnd(8)} no readings yet`;
    const verdict = w.hitsBeforeReset ? `hits limit at ${clock(w.hitAt)}` : "won't hit before reset";
    return `${name.padEnd(8)} ${String(w.pct).padStart(3)}% used  ->${String(w.projectedAtReset).padStart(4)}% at reset (${clock(w.resetsAt)}, in ${dur(Date.parse(w.resetsAt) - Date.now())})  ~${fmt(w.tokensLeft)} tokens left  ${verdict}`;
  };
  lines.push('quotameter');
  lines.push(row('5-hour', s.windows.h5));
  lines.push(row('Weekly', s.windows.wk));
  const a = s.attribution.h5;
  if (a) lines.push(`5-hour split (% of the limit): CLI ${a.cli}% · Desktop agent ${a.desktop}% · headless+other ${(a.headless + a.unitemised).toFixed(1)}% · chat and other devices ~${a.chat}%`);
  const sc = s.insights?.sessionCost;
  if (sc?.left) lines.push(`Room for about ${sc.left.typical} typical session(s) or ${sc.left.heavy} heavy one(s) before the 5-hour limit. A typical session uses ${sc.medianH5}% of it.`);
  const wt = s.insights?.weeklyTokens?.at(-1);
  if (wt) lines.push(`This week: ${fmt(wt.fresh)} fresh Code tokens, ${fmt(wt.cacheRead)} cache reads, ~${fmt(wt.chat)} chat tokens (estimated).`);
  const top = (s.breakdown.h5?.models || []).filter((m) => !m.chat && !m.unitemised).slice(0, 3);
  if (top.length) lines.push('Top models, 5-hour window: ' + top.map((m) => `${m.model} (${m.where}) ${m.pts != null ? m.pts + '% of the limit' : '$' + m.cost}`).join(', '));
  for (const r of s.recommendations.slice(0, 2)) lines.push(`Tip: ${r.title} ${r.body}`);
  if (s.calibration.h5?.provisional && s.windows.h5) lines.push(`Calibrating: ${s.calibration.h5.windows} window(s) so far; chat estimates firm up after about 5.`);
  return lines.join('\n');
}
