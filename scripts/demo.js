#!/usr/bin/env node
// Writes seven weeks of synthetic usage into a quotameter store, for the
// README screenshot and docs/sample-report.html. Every project, title and
// number is made up; no real logs are read.
//
//   QUOTAMETER_HOME=/tmp/qm-demo node scripts/demo.js
//
// It then builds the report with your Claude Code logs, Claude Desktop data
// and the claude command all switched off, so nothing real gets mixed in.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { append, readAll } from '../plugins/quotameter/lib/store.js';
import { costOf } from '../plugins/quotameter/lib/model/pricing.js';

if (!process.env.QUOTAMETER_HOME) {
  console.error('Set QUOTAMETER_HOME to an empty folder first, so the demo never mixes with your own data.');
  process.exit(1);
}
if (readAll('messages').length) {
  console.error(`${process.env.QUOTAMETER_HOME} already has data. Use an empty folder.`);
  process.exit(1);
}

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const K_H5 = 3.2; // points of the 5-hour window per list-price dollar
const K_WK = 0.42; // points of the weekly window per list-price dollar

// Small seeded generator, so the demo looks the same every run.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const between = (a, b) => a + rnd() * (b - a);

const PROJECTS = [
  { cwd: '/home/dev/work/checkout-service', branches: ['main', 'feat/refunds', 'fix/tax-rounding'] },
  { cwd: '/home/dev/work/docs-site', branches: ['main', 'content/api-guide'] },
  { cwd: '/home/dev/work/data-pipeline', branches: ['main', 'feat/backfill'] },
  { cwd: '/home/dev/oss/mobile-app', branches: ['develop', 'feat/offline-sync'] },
];
const TITLES = ['Add refund endpoint', 'Fix flaky payment tests', 'Write API guide', 'Backfill March events', 'Offline sync design', 'Upgrade to Node 22', 'Tax rounding bug', 'Review PR feedback', 'Speed up CI', 'Migrate auth middleware'];
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Write', 'mcp__github__get_pull_request', 'mcp__github__create_review', 'mcp__linear__get_issue'];

const now = Date.now();
// Weekly limit resets Thursdays at 03:00 local time.
const reset = new Date(now);
reset.setHours(3, 0, 0, 0);
while (reset.getDay() !== 4 || reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
const weekReset = (t) => {
  let r = reset.getTime();
  while (r - 7 * DAY >= t) r -= 7 * DAY;
  return r;
};

// ---- sessions and messages ----
const events = []; // { t, kind: 'msg' | 'chat', ... }
const sessions = [];
let n = 0;
for (let d = 49; d >= 0; d--) {
  const day = new Date(now - d * DAY);
  day.setHours(0, 0, 0, 0);
  const weekend = [0, 6].includes(day.getDay());
  const count = d === 0 ? 1 : weekend ? (rnd() < 0.4 ? 1 : 0) : 1 + Math.floor(rnd() * 3);
  // Heavier use in recent weeks, so the trend chart has a story.
  const intensity = 0.7 + (49 - d) / 49 * 0.6;
  for (let s = 0; s < count; s++) {
    // Today has one session still running, so the 5-hour window is live.
    const start = d === 0 ? now - 100 * MIN : day.getTime() + between(9, 21) * HOUR;
    if (start > now - 20 * MIN) continue;
    const id = `demo-${++n}`;
    const proj = pick(PROJECTS);
    const r = rnd();
    const model = r < 0.62 ? 'claude-opus-5-5' : r < 0.92 ? 'claude-sonnet-5-5' : 'claude-haiku-5-5';
    const entrypoint = rnd() < 0.15 ? 'claude-desktop' : rnd() < 0.05 ? 'sdk-cli' : 'cli';
    const turns = Math.floor(between(15, 70) * intensity);
    const branch = pick(proj.branches);
    const skill = rnd() < 0.25 ? pick(['code-review', 'superpowers:brainstorming', 'frontend-design']) : null;
    let t = start;
    let ctx = between(14000, 22000);
    let itemised = 0;
    for (let i = 0; i < turns; i++) {
      t += between(0.5, 4) * MIN;
      if (t > now) break;
      const pause = rnd() < 0.06;
      if (pause) t += between(8, 40) * MIN; // coffee break: the cache expires
      const cw5 = i === 0 || pause ? Math.round(ctx) : Math.round(between(400, 3000));
      const out = Math.round(between(150, 2400));
      const u = { input_tokens: Math.round(between(2, 40)), output_tokens: out, cache_read_input_tokens: i === 0 || pause ? 0 : Math.round(ctx), cache_creation_input_tokens: cw5, cache_creation: { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: 0 } };
      const cost = costOf(model, u);
      itemised += cost;
      const tools = rnd() < 0.7 ? [pick(TOOLS)] : [];
      events.push({ t, kind: 'msg', row: { id: `msg_${id}_${i}`, ts: new Date(t).toISOString(), session: id, entrypoint, cwd: proj.cwd, branch, model, agent: null, skill: i < 6 ? skill : null, tools, speed: null, in: u.input_tokens, out, cw5, cw1h: 0, cr: u.cache_read_input_tokens, final: true, cost } });
      ctx = Math.min(190000, ctx + between(800, 5200));
      if (ctx > 160000 && rnd() < 0.3) ctx = between(30000, 45000); // /compact
      // Some turns spawn an Explore subagent on Haiku.
      if (rnd() < 0.05) {
        for (let j = 0; j < 8; j++) {
          const at = t + j * 20000;
          const au = { input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 9000 + j * 2500, cache_creation_input_tokens: 2500, cache_creation: { ephemeral_5m_input_tokens: 2500, ephemeral_1h_input_tokens: 0 } };
          const ac = costOf('claude-haiku-5-5', au);
          itemised += ac;
          events.push({ t: at, kind: 'msg', row: { id: `msg_${id}_${i}_a${j}`, ts: new Date(at).toISOString(), session: id, entrypoint, cwd: proj.cwd, branch, model: 'claude-haiku-5-5', agent: { id: `a${i}`, type: 'Explore', name: 'Explore', depth: 1 }, skill: null, tools: [pick(['Read', 'Grep', 'Glob'])], speed: null, in: 10, out: 400, cw5: 2500, cw1h: 0, cr: au.cache_read_input_tokens, final: true, cost: ac } });
        }
      }
    }
    sessions.push({ id, start, end: t, entrypoint, cwd: proj.cwd, title: pick(TITLES), itemised });
  }
  // Evening chat on claude.ai most days.
  if (rnd() < 0.7) {
    const t = day.getTime() + between(19, 23) * HOUR;
    if (t < now) events.push({ t, kind: 'chat', h5: between(2, 7), wk: between(0.3, 1.1) });
  }
}
events.sort((a, b) => a.t - b.t);

// ---- limit readings: 5-hour windows start at the first use after a reset ----
const readings = [];
const kept = [];
let h5 = null;
let wk = { reset: 0, pts: 0 };
let lastRead = 0;
const read = (t, force) => {
  if (!force && t - lastRead < 10 * MIN) return;
  lastRead = t;
  const iso = new Date(t).toISOString();
  readings.push({ ts: iso, source: 'usage-poll', kind: 'session', group: 'session', percent: Math.min(100, Math.round(h5.pts)), resetsAt: new Date(h5.end).toISOString(), severity: h5.pts >= 100 ? 'exceeded' : h5.pts >= 80 ? 'warning' : 'normal' });
  readings.push({ ts: iso, source: 'usage-poll', kind: 'weekly_all', group: 'weekly', percent: Math.min(100, Math.round(wk.pts)), resetsAt: new Date(wk.reset).toISOString(), severity: 'normal' });
};
for (const e of events) {
  if (!h5 || e.t > h5.end) h5 = { end: e.t + 5 * HOUR, pts: 0 };
  const r = weekReset(e.t);
  if (r !== wk.reset) wk = { reset: r, pts: 0 };
  if (h5.pts >= 100) continue; // locked out until the window resets
  if (e.kind === 'chat') {
    h5.pts += e.h5;
    wk.pts += e.wk;
    read(e.t + MIN, true);
    continue;
  }
  h5.pts += e.row.cost * 1.12 * K_H5;
  wk.pts += e.row.cost * 1.12 * K_WK;
  kept.push(e.row);
  read(e.t);
}
if (h5) read(now - MIN, true);

append('messages', kept);
append('readings', readings);
const used = new Set(kept.map((m) => m.session));
append('sessions', sessions.filter((s) => used.has(s.id)).map((s) => ({ session: s.id, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), entrypoint: s.entrypoint, cwd: s.cwd, customTitle: s.title })));
// Claude Code's own totals run a little above what the logs itemise.
append('costs', sessions.filter((s) => used.has(s.id) && s.end < now - HOUR).map((s) => ({ session: s.id, run: new Date(s.start).toISOString(), ts: new Date(s.end).toISOString(), totalCost: Math.round(s.itemised * 1.12 * 1e6) / 1e6, models: {} })));
append('overhead', [{
  ts: new Date(now - 2 * HOUR).toISOString(),
  model: 'claude-opus-5-5',
  categories: [{ name: 'System prompt', tokens: 3100 }, { name: 'System tools', tokens: 11800 }, { name: 'MCP tools', tokens: 1900 }, { name: 'MCP server instructions', tokens: 700 }, { name: 'MCP tools (deferred)', tokens: 31000 }, { name: 'Skills', tokens: 1400 }],
  mcpTools: [
    ...['get_pull_request', 'create_review', 'list_issues', 'search_code', 'get_file'].map((x) => ({ name: `mcp__github__${x}`, server: 'github', tokens: 4200 })),
    ...['get_issue', 'update_issue', 'list_projects'].map((x) => ({ name: `mcp__linear__${x}`, server: 'linear', tokens: 3100 })),
    ...['get_design', 'export_frame', 'list_files', 'get_comments'].map((x) => ({ name: `mcp__figma__${x}`, server: 'figma', tokens: 2600 })),
  ],
  skills: [
    { name: 'brainstorming', source: 'plugin', plugin: 'superpowers', tokens: 180 },
    { name: 'writing-plans', source: 'plugin', plugin: 'superpowers', tokens: 160 },
    { name: 'pdf', source: 'plugin', plugin: 'document-skills', tokens: 140 },
    { name: 'xlsx', source: 'plugin', plugin: 'document-skills', tokens: 150 },
  ],
}]);
console.log(`Wrote ${kept.length} responses in ${used.size} sessions and ${readings.length} limit readings to ${process.env.QUOTAMETER_HOME}.`);

const empty = path.join(process.env.QUOTAMETER_HOME, '.empty-claude');
fs.mkdirSync(path.join(empty, 'projects'), { recursive: true });
const cli = fileURLToPath(new URL('../plugins/quotameter/bin/quotameter.js', import.meta.url));
spawnSync(process.execPath, [cli, 'report', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CLAUDE_CONFIG_DIR: empty, QUOTAMETER_DESKTOP_DIR: '', QUOTAMETER_CLAUDE_BIN: path.join(empty, 'no-claude') },
});
