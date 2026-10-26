// Team digest with nothing uploaded. Each person runs `quotameter team
// export`, which writes a small JSON of aggregate numbers for the last 30
// days: no paths, branches, titles, hostnames or session ids. Whoever
// collects the files runs `quotameter team report a.json b.json` and gets a
// table. Where the files travel is up to the team.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fmt } from './report/format.js';

export const SCHEMA = 1;

const clean = (s) => String(s || '').replace(/[^\w .()-]/g, '').trim().slice(0, 32);
const share = (x) => (x == null ? null : Math.round(x * 100));

// summary: the output of analyze(). label: from --label or config.teamLabel.
export function teamDigest(summary, { label = '', seed = '' } = {}) {
  const d = summary.breakdown.d30 || {};
  const t = d.tiles || {};
  const models = (d.models || []).filter((m) => !m.chat && !m.unitemised);
  const total = models.reduce((a, m) => a + (m.cost || 0), 0) || 1;
  const mix = {};
  for (const m of models) {
    const fam = /opus|fable|mythos/.test(m.model) ? 'Opus' : /sonnet/.test(m.model) ? 'Sonnet' : /haiku/.test(m.model) ? 'Haiku' : 'Other';
    mix[fam] = (mix[fam] || 0) + m.cost / total;
  }
  for (const k of Object.keys(mix)) mix[k] = share(mix[k]);
  const I = summary.insights || {};
  const weeks = (I.weeklyTokens || []).filter((w) => !w.current && w.pct != null).slice(-4);
  const idle = (summary.overhead?.mcp || []).filter((s) => s.calls === 0);
  const whatIf = (I.whatIf?.rows || [])[0];
  return {
    schema: SCHEMA,
    label: clean(label) || `member-${crypto.createHash('sha256').update(seed || String(Math.random())).digest('hex').slice(0, 6)}`,
    exportedAt: summary.generatedAt,
    period: 'last 30 days',
    plan: summary.config?.plan || null,
    sessions: I.sessionCost?.n ?? null,
    activeDays: summary.history?.activeDays ?? null,
    requests: t.requests ?? null,
    freshTokens: t.freshTokens ?? null,
    cacheReadTokens: t.cacheReadTokens ?? null,
    listCost: t.apiCost ?? null,
    cacheHitRatio: I.cache?.d30?.hitRatio ?? null,
    rebuildCostWeek: I.cache?.week?.rebuildCost ?? null,
    subagentShare: I.subagents?.d30?.share ?? null,
    modelMix: mix,
    opusExcessCost: whatIf ? Math.max(0, (whatIf.actual || 0) - (whatIf.sonnet || 0)) : null,
    weeklyPeaks: weeks.map((w) => w.pct),
    h5Hits30: I.binding?.h5Hits ?? null,
    idleMcpServers: idle.length,
    idleMcpTokens: idle.reduce((a, s) => a + (s.tokens || 0), 0),
  };
}

export function readDigests(files) {
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (d?.schema === SCHEMA && typeof d.label === 'string') out.push({ ...d, label: clean(d.label) || 'member' });
      else out.push({ error: `${f}: not a quotameter team digest (schema ${d?.schema ?? 'missing'})` });
    } catch (e) {
      out.push({ error: `${f}: ${e.message}` });
    }
  }
  return out;
}

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x)}%`);
const money = (x) => (x == null ? 'n/a' : `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// A markdown table people can paste anywhere, plus one waste line per member.
export function teamReport(digests) {
  const ok = digests.filter((d) => !d.error);
  const lines = [];
  for (const d of digests.filter((d) => d.error)) lines.push(`Skipped ${d.error}`);
  if (!ok.length) return lines.concat('No digests to report.').join('\n');
  const head = ['Member', 'Plan', 'Sessions', 'Fresh tokens', 'Cache hit', 'Subagents', 'Opus share', 'List cost', 'Weekly peak', '5h hits', 'Idle MCP tokens'];
  const row = (d) => [d.label, d.plan || 'n/a', d.sessions ?? 'n/a', fmt(d.freshTokens), pct(d.cacheHitRatio == null ? null : d.cacheHitRatio * 100), pct(d.subagentShare == null ? null : d.subagentShare * 100), pct(d.modelMix?.Opus), money(d.listCost), d.weeklyPeaks?.length ? pct(avg(d.weeklyPeaks)) : 'n/a', d.h5Hits30 ?? 'n/a', fmt(d.idleMcpTokens)];
  const rows = ok.map(row);
  const totals = ['All', '', ok.reduce((a, d) => a + (d.sessions || 0), 0), fmt(ok.reduce((a, d) => a + (d.freshTokens || 0), 0)), pct(avg(ok.filter((d) => d.cacheHitRatio != null).map((d) => d.cacheHitRatio * 100))), pct(avg(ok.filter((d) => d.subagentShare != null).map((d) => d.subagentShare * 100))), pct(avg(ok.filter((d) => d.modelMix?.Opus != null).map((d) => d.modelMix.Opus))), money(ok.reduce((a, d) => a + (d.listCost || 0), 0)), pct(avg(ok.flatMap((d) => d.weeklyPeaks || []))), ok.reduce((a, d) => a + (d.h5Hits30 || 0), 0), fmt(ok.reduce((a, d) => a + (d.idleMcpTokens || 0), 0))];
  const all = [head, ...rows, totals].map((r) => r.map(String));
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(' | ')} |`;
  lines.push(`quotameter team report, ${ok[0].period}, ${ok.length} member${ok.length === 1 ? '' : 's'}`);
  lines.push('');
  lines.push(line(all[0]));
  lines.push(`|${widths.map((w, i) => (i === 0 ? '-'.repeat(w + 2) : '-'.repeat(w + 1) + ':')).join('|')}|`);
  for (const r of all.slice(1)) lines.push(line(r));
  lines.push('');
  lines.push('Waste, each in its own unit:');
  for (const d of ok) {
    const parts = [];
    if (d.rebuildCostWeek) parts.push(`cache rebuilds ${money(d.rebuildCostWeek)} this week`);
    if (d.opusExcessCost) parts.push(`Opus work that would fit Sonnet ${money(d.opusExcessCost)} at list price`);
    if (d.idleMcpTokens) parts.push(`${fmt(d.idleMcpTokens)} tokens of unused MCP servers loaded into every session (${d.idleMcpServers} server${d.idleMcpServers === 1 ? '' : 's'})`);
    lines.push(`- ${d.label}: ${parts.length ? parts.join('; ') : 'nothing stands out'}`);
  }
  lines.push('');
  lines.push('List cost is API list price as a measure of usage, not money spent. Cache hit and subagent share are 30-day averages; weekly peak is the average final percentage of the last finished weeks.');
  return lines.join('\n');
}
