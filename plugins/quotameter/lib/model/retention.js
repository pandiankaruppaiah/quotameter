// Keeps raw rows for `keepDays` (default 90) and summaries forever.
//
// Whole sessions are summarised once their last response is older than the
// cutoff, so a session that spans the cutoff is never split (its cost total
// would then scale the remaining half wrongly). Limit windows that reset
// before the cutoff are summarised with their chat estimate and, for weeks,
// their token totals. Summaries hold no message text, titles or session ids.
//
// Order: append summaries, record what was summarised in state.json, then
// rewrite the raw files. loadData() skips anything state says is summarised,
// so a crash between the steps cannot count a row twice. Call under withLock.

import { append, readAll, readState, writeState, rewrite } from '../store.js';
import { folderName } from './breakdown.js';
import { loadConfig } from '../config.js';
import { loadData, roundMinute } from './load.js';
import { prepare } from './analyze.js';
import { hash } from '../ingest/logs.js';
import { DAY, sum, tokensOf, round } from './util.js';

export const MIN_KEEP_DAYS = 35;

const utcDay = (t) => Math.floor(t / DAY) * DAY;
const keyOf = (w) => `${w.kind}|${w.resetsAt}`;

export function cutoffFor(now, keepDays) {
  return utcDay(now - Math.max(MIN_KEEP_DAYS, Number(keepDays) || 90) * DAY);
}

function surfaceOf(e) {
  return e === 'claude-desktop' ? 'claude-desktop' : e === 'cli' ? 'cli' : 'headless';
}

// One row per UTC day, one cell per model, project, surface, subagent and skill.
function dailyRows(msgs, cutoff, redact) {
  const days = new Map();
  for (const m of msgs) {
    const t = utcDay(m.t);
    const project = !m.cwd ? 'unknown' : redact && !m.cwd.startsWith('project-') ? `project-${hash(m.cwd)}` : folderName(m.cwd);
    const agent = m.agent ? m.agent.type || m.agent.name || 'agent' : null;
    const key = [m.model || 'unknown', project, surfaceOf(m.entrypoint), agent || '', m.skill || ''].join('|');
    if (!days.has(t)) days.set(t, new Map());
    const cells = days.get(t);
    const c = cells.get(key) || { model: m.model || 'unknown', project, surface: surfaceOf(m.entrypoint), agent, skill: m.skill || null, in: 0, out: 0, cw5: 0, cw1h: 0, cr: 0, cost: 0, adj: 0, req: 0 };
    c.in += m.in; c.out += m.out; c.cw5 += m.cw5; c.cw1h += m.cw1h; c.cr += m.cr;
    c.cost += m.cost; c.adj += m.adj; c.req += m.residual ? 0 : 1;
    cells.set(key, c);
  }
  return [...days].map(([t, cells]) => {
    const day = new Date(t).toISOString().slice(0, 10);
    // The id includes the cutoff: a repeat of the same compaction collapses,
    // a later compaction that adds a long session to the same day does not.
    return { id: `${day}|${cutoff}`, batch: cutoff, day, t, cells: [...cells.values()].map((c) => ({ ...c, cost: round(c.cost, 6), adj: round(c.adj, 6) })) };
  });
}

function windowRows(kinds, messages, cutoff, done) {
  const out = [];
  const h5 = kinds.session?.attributed || [];
  for (const [kind, { cal, attributed }] of Object.entries(kinds)) {
    for (const a of attributed) {
      const w = a.w;
      if (w.resetsAt > cutoff || done.has(keyOf({ kind, resetsAt: w.resetsAt }))) continue;
      const hit = w.points.find((p) => p.p >= 100);
      const row = { batch: cutoff, kind, start: w.start, resetsAt: w.resetsAt, peak: w.pct, hitAt: hit ? hit.t : null, chat: round(a.chat, 3), code: round(a.code, 3), codeCost: round(a.codeCost, 4), k: cal.k };
      if (kind === 'weekly_all') {
        const inW = messages.filter((m) => m.t > w.start && m.t <= w.resetsAt);
        const adj = sum(inW, (m) => m.adj);
        const tpd = adj > 0 ? sum(inW, tokensOf) / adj : 0;
        row.fresh = sum(inW, (m) => m.in + m.out + m.cw5 + m.cw1h);
        row.cacheRead = sum(inW, (m) => m.cr);
        row.chatTokens = cal.k ? Math.round((a.chat / cal.k) * tpd) : 0;
        row.hits = h5.filter((x) => x.w.start >= w.start && x.w.start < w.resetsAt && x.w.pct >= 100).length;
      }
      out.push(row);
    }
  }
  return out;
}

export function compact({ now = Date.now(), force = false } = {}) {
  const cfg = loadConfig();
  const cutoff = cutoffFor(now, cfg.keepDays);
  const state = readState();
  if (!force && (state.compactedBefore || 0) >= cutoff) return { skipped: 'up to date', cutoff: new Date(cutoff).toISOString() };

  const data = loadData(state);
  const { kinds } = prepare(data, cfg);
  const raw = data.messages.filter((m) => !m.archived);

  // Sessions whose last row is before the cutoff, residual rows included.
  const last = new Map();
  for (const m of raw) last.set(m.session, Math.max(last.get(m.session) || 0, m.t));
  const old = new Set([...last].filter(([, t]) => t < cutoff).map(([s]) => s));
  const oldMsgs = raw.filter((m) => old.has(m.session));

  const committed = new Set(state.batches || []);
  const done = new Set(readAll('windows').filter((w) => committed.has(w.batch)).map(keyOf));
  const days = dailyRows(oldMsgs, cutoff, cfg.redactPaths);
  const wins = windowRows(kinds, data.messages, cutoff, done);
  append('daily', days);
  append('windows', wins);

  state.archived ||= {};
  for (const s of old) state.archived[s] = new Date(last.get(s)).toISOString().slice(0, 10);
  state.compactedBefore = cutoff;
  state.lastCompact = now;
  state.batches = [...new Set([...(state.batches || []), cutoff])];
  writeState(state);

  const keepRow = (r) => !old.has(r.session) && !state.archived[r.session];
  const keepReading = (r) => (r.resetsAt ? roundMinute(Date.parse(r.resetsAt)) > cutoff : Date.parse(r.ts) >= cutoff - 8 * DAY);
  const before = {};
  const prune = (kind, keep) => {
    const rows = readAll(kind);
    const kept = rows.filter(keep);
    before[kind] = rows.length - kept.length;
    if (kept.length !== rows.length) rewrite(kind, kept);
  };
  prune('messages', keepRow);
  prune('sessions', keepRow);
  prune('costs', keepRow);
  prune('readings', keepReading);
  prune('livelog', (r) => (r.percent != null ? keepReading(r) : r.session ? keepRow(r) : true));
  prune('activity', (r) => Date.parse(r.ts) >= cutoff);
  const snaps = readAll('overhead');
  if (snaps.length > 10) {
    before.overhead = snaps.length - 10;
    rewrite('overhead', snaps.slice(-10));
  }
  return { cutoff: new Date(cutoff).toISOString(), sessions: old.size, days: days.length, windows: wins.length, removed: before };
}
