import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmt, dur, time, fitsText } from './format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

// The page script: the summary as JSON, the shared formatters, then report.js.
// It runs as an inline module script, so format.js keeps its `export`
// keywords; the browser ignores unused exports. Neither file may import
// anything, since a file:// page cannot load modules.
export function pageScript(summary) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const BS = String.fromCharCode(92);
  // Escape "<" so a project name or title containing "</script>" cannot break out.
  const json = JSON.stringify(summary).replace(/</g, BS + 'u003c').split(LS).join(BS + 'u2028').split(PS).join(BS + 'u2029');
  return `const S = ${json};\n${read('format.js')}\n${read('report.js')}`;
}

export function renderHtml(summary) {
  // A function replacement, so "$&" or "$'" inside a title is not treated as a pattern.
  return read('template.html').replace('/*__SCRIPT__*/', () => pageScript(summary));
}

export function renderText(s) {
  const lines = [];
  const row = (name, w) => {
    if (!w) return `${name.padEnd(8)} no readings yet`;
    const verdict = w.hitsBeforeReset ? `hits limit at ${time(w.hitAt)}` : "won't hit before reset";
    const range = w.projectedRange && Math.abs(w.projectedRange[1] - w.projectedRange[0]) >= 2 ? `${w.projectedRange[0]}-${w.projectedRange[1]}%` : `${w.projectedAtReset}%`;
    return `${name.padEnd(8)} ${String(w.pct).padStart(3)}% used  -> ${range} at reset (${time(w.resetsAt)}, in ${dur(Date.parse(w.resetsAt) - Date.now())})  ${w.tokensLeft != null ? `~${fmt(w.tokensLeft)} fresh tokens left  ` : ''}${verdict}`;
  };
  lines.push('quotameter');
  if (!s.windows.h5 && !s.windows.wk) {
    lines.push('No limit readings yet, so only the token breakdowns are available.');
    lines.push(s.sources.pollError ? `The last /usage poll failed: ${s.sources.pollError}. Run quotameter doctor.` : 'Run quotameter poll, or /quotameter:setup for a status line that records readings while you work.');
    if (s.sources.messages) lines.push(`Claude Code logs found: ${s.sources.messages} responses in ${s.sources.sessions} sessions.`);
    return lines.join('\n');
  }
  lines.push(row('5-hour', s.windows.h5));
  lines.push(row('Weekly', s.windows.wk));
  const a = s.attribution.h5;
  if (a) lines.push(`5-hour split (% of the limit): CLI ${a.cli}% · Desktop agent ${a.desktop}% · headless+other ${(a.headless + a.unitemised).toFixed(1)}%${a.remote ? ` · other computers ${a.remote}%` : ''} · chat and other devices ~${a.chat}% (estimated)`);
  for (const m of (s.sources.machines || []).filter((x) => x.error)) lines.push(`Other computer ${m.name}: ${m.error}, so its usage counts as chat for now.`);
  const sc = s.insights?.sessionCost;
  const fits = fitsText(s.windows.h5, sc, s.insights?.sessionLength);
  if (fits) lines.push(`${fits} A typical session uses ${sc.medianH5}% of the 5-hour limit.`);
  const wt = s.insights?.weeklyTokens?.at(-1);
  if (wt) lines.push(`This week: ${fmt(wt.fresh)} fresh Code tokens (measured), ${fmt(wt.cacheRead)} cache reads, ~${fmt(wt.chat)} chat tokens (estimated).`);
  const top = (s.breakdown.h5?.models || []).filter((m) => !m.chat && !m.unitemised).slice(0, 3);
  if (top.length) lines.push('Top models, 5-hour window: ' + top.map((m) => `${m.model} (${m.where}) ${m.pts != null ? m.pts + '% of the limit' : '$' + m.cost}`).join(', '));
  for (const r of s.recommendations.slice(0, 2)) lines.push(`Tip: ${r.title} ${r.body}`);
  if (s.calibration.h5?.provisional && s.windows.h5) lines.push(`Calibrating: ${s.calibration.h5.windows} window(s) so far; chat estimates firm up after about 5.${s.sources.statusline ? '' : ' A status line (/quotameter:setup) records readings while you work and gets there sooner.'}`);
  return lines.join('\n');
}
