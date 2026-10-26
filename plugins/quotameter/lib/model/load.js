// Reads the store into memory and reconciles itemised rows with Claude Code's
// own session totals. See docs/DESIGN.md.

import { readAll, readState } from '../store.js';
import { mergeMessage } from '../ingest/logs.js';
import { HOUR, DAY } from './util.js';
import { loadConfig } from '../config.js';
import { importSync, dedupeReadings } from '../sync.js';

// Rows that retention already summarised are skipped, so a crash between
// writing summaries and rewriting the raw files cannot count them twice.
export const roundMinute = (t) => Math.round(t / 60000) * 60000;

// remote: false leaves other machines out (retention summarises only this machine).
export function loadData(state = readState(), { remote = true, config = null, now = Date.now() } = {}) {
  const cb = state.compactedBefore || 0;
  const archived = state.archived || {};
  const live = (s) => !archived[s];
  const byId = new Map();
  for (const m of readAll('messages')) if (live(m.session)) byId.set(m.id, mergeMessage(byId.get(m.id), m));
  // "<synthetic>" records are placeholders Claude Code writes itself (for
  // example after an interrupt). They carry no usage.
  const messages = [...byId.values()].filter((m) => m.ts && m.model !== '<synthetic>').map((m) => ({ ...m, t: Date.parse(m.ts), cost: m.cost || 0 }));

  const sessions = new Map();
  for (const s of readAll('sessions')) {
    if (!live(s.session)) continue;
    const cur = sessions.get(s.session) || { session: s.session };
    if (s.start && (!cur.start || s.start < cur.start)) cur.start = s.start;
    if (s.end && (!cur.end || s.end > cur.end)) cur.end = s.end;
    for (const k of ['entrypoint', 'cwd', 'customTitle', 'aiTitle']) if (s[k]) cur[k] = s[k];
    sessions.set(s.session, cur);
  }

  // Claude Code's own totals. One row per session run; later rows for the same run replace earlier ones.
  const runs = new Map();
  for (const c of readAll('costs')) if (live(c.session)) runs.set(`${c.session}|${c.run}`, c);
  const trueCost = new Map();
  const costMeta = new Map();
  for (const c of runs.values()) {
    if (c.totalCost == null) continue;
    trueCost.set(c.session, (trueCost.get(c.session) || 0) + c.totalCost);
    const top = Object.entries(c.models || {}).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))[0];
    costMeta.set(c.session, { ts: c.ts, model: top ? top[0] : null });
  }

  // The status line's running total covers sessions that have not ended yet.
  const statusRows = [...readAll('livelog'), ...readAll('live')];
  for (const l of statusRows) {
    if (l.session && l.cost != null && live(l.session) && !trueCost.has(l.session)) {
      trueCost.set(`live:${l.session}`, Math.max(trueCost.get(`live:${l.session}`) || 0, l.cost));
    }
  }

  // Other computers, through the sync folder: their responses carry a
  // reconciled total per hashed session, so they join the cost index like
  // local ones and calibration sees the whole account's Code usage.
  const sync = remote ? importSync(config || loadConfig(), now) : { messages: [], costs: new Map(), readings: [], machines: [] };
  for (const m of sync.messages) messages.push({ ...m, t: Date.parse(m.ts) });
  for (const [session, total] of sync.costs) trueCost.set(session, total);
  const machines = sync.machines;

  // Windows that reset before the cutoff live on as summaries in windows.jsonl.
  const readings = dedupeReadings([...readAll('readings'), ...statusRows.filter((l) => l.percent != null), ...sync.readings])
    .map((r) => ({ ...r, t: Date.parse(r.ts), r: r.resetsAt ? Date.parse(r.resetsAt) : null }))
    .filter((r) => Number.isFinite(r.t) && (r.r != null ? roundMinute(r.r) > cb : r.t >= cb - 8 * DAY))
    .sort((a, b) => a.t - b.t);

  const activity = readAll('activity').map((a) => Date.parse(a.ts)).filter((t) => Number.isFinite(t) && t >= cb);
  const overheadRows = readAll('overhead');
  const overhead = overheadRows.length ? overheadRows[overheadRows.length - 1] : null;
  return { messages, sessions, trueCost, costMeta, readings, activity, overhead, machines, ...loadArchive(state) };
}

// Summaries written by retention. Daily rows become one message per model,
// project, surface and skill, with cost already reconciled; windows keep
// their peak, chat estimate and weekly totals. Duplicates from a repeated
// compaction collapse on their id. Rows from a batch that never reached
// state.json (a crash before the commit) are ignored; the next compaction
// writes them again under its own batch.
function loadArchive(state) {
  const committed = new Set(state.batches || []);
  const days = new Map();
  for (const d of readAll('daily')) if (committed.has(d.batch)) days.set(d.id, d);
  const archivedMessages = [];
  for (const d of days.values()) {
    d.cells.forEach((c, i) => {
      archivedMessages.push({
        id: `archive:${d.id}:${i}`, ts: new Date(d.t + 12 * HOUR).toISOString(), t: d.t + 12 * HOUR, session: `archive:${d.day}`,
        entrypoint: c.surface, cwd: c.project, branch: null, model: c.model, agent: c.agent ? { type: c.agent } : null, skill: c.skill, tools: [],
        in: c.in, out: c.out, cw5: c.cw5, cw1h: c.cw1h, cr: c.cr, cost: c.cost, adj: c.adj, req: c.req, archived: true,
      });
    });
  }
  const wins = new Map();
  for (const w of readAll('windows')) if (committed.has(w.batch)) wins.set(`${w.kind}|${w.resetsAt}`, w);
  return { archivedMessages, archivedWindows: [...wins.values()] };
}

// Scale each session's itemised cost up to Claude Code's own total. The
// difference is usage the per-message logs never itemise (final output of
// tool-calling turns, background calls). Returns the unitemised total.
export function reconcile(messages, trueCost, sessions, costMeta) {
  const logged = new Map();
  for (const m of messages) logged.set(m.session, (logged.get(m.session) || 0) + m.cost);
  let unitemised = 0;
  for (const m of messages) {
    const total = trueCost.get(m.session) ?? trueCost.get(`live:${m.session}`);
    const l = logged.get(m.session);
    const f = total != null && l > 0 && total > l ? total / l : 1;
    m.adj = m.cost * f;
    unitemised += m.adj - m.cost;
  }
  // Sessions Claude Code billed but that left no response records at all
  // (for example only background calls). Place them at the session's end.
  for (const [session, total] of trueCost) {
    if (session.startsWith('live:') || logged.has(session) || !(total > 0)) continue;
    const s = sessions.get(session) || {};
    const meta = costMeta.get(session) || {};
    const ts = s.end || meta.ts;
    if (!ts) continue;
    messages.push({
      id: `residual:${session}`, ts, t: Date.parse(ts), session, entrypoint: s.entrypoint || null, cwd: s.cwd || null,
      branch: null, model: meta.model || null, agent: null, skill: null, tools: [], in: 0, out: 0, cw5: 0, cw1h: 0, cr: 0,
      cost: 0, adj: total, residual: true,
    });
    unitemised += total;
  }
  return unitemised;
}
