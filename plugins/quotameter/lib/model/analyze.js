// Turns the store into the summary the report renders.
//
// Units: "points" are percentage points of a limit window. Code usage is
// measured in list-price dollars (a weight, not a bill) and converted to
// points with a calibration factor k (points per dollar), learned per window
// kind from the user's own history. See docs/DESIGN.md.

import path from 'node:path';
import { readAll, readState } from '../store.js';
import { loadConfig } from '../config.js';
import { mergeMessage } from '../ingest/logs.js';
import { HOUR, DAY, sum, tokensOf, round, percentile } from './util.js';
import { insights } from './insights.js';

const WINDOW_MS = { session: 5 * HOUR, weekly_all: 7 * DAY };
const PLAN_PRICE = { pro: 20, max5: 100, max20: 200 };

// ---------- loading ----------

// Rows that retention already summarised are skipped, so a crash between
// writing summaries and rewriting the raw files cannot count them twice.
export const roundMinute = (t) => Math.round(t / 60000) * 60000;

export function loadData(state = readState()) {
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

  // Windows that reset before the cutoff live on as summaries in windows.jsonl.
  const readings = [...readAll('readings'), ...statusRows.filter((l) => l.percent != null)]
    .map((r) => ({ ...r, t: Date.parse(r.ts), r: r.resetsAt ? Date.parse(r.resetsAt) : null }))
    .filter((r) => Number.isFinite(r.t) && (r.r != null ? roundMinute(r.r) > cb : r.t >= cb - 8 * DAY))
    .sort((a, b) => a.t - b.t);

  const activity = readAll('activity').map((a) => Date.parse(a.ts)).filter((t) => Number.isFinite(t) && t >= cb);
  const overheadRows = readAll('overhead');
  const overhead = overheadRows.length ? overheadRows[overheadRows.length - 1] : null;
  return { messages, sessions, trueCost, costMeta, readings, activity, overhead, ...loadArchive(state) };
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
function reconcile(messages, trueCost, sessions, costMeta) {
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

// ---------- windows and calibration ----------

function buildWindows(readings, kind) {
  const dur = WINDOW_MS[kind];
  const map = new Map();
  for (const r of readings) {
    if (r.kind !== kind || r.r == null) continue;
    const key = roundMinute(r.r); // resets_at jitters by a second between reads
    if (!map.has(key)) map.set(key, { kind, resetsAt: key, start: key - dur, points: [] });
    map.get(key).points.push({ t: r.t, p: r.percent, severity: r.severity });
  }
  const wins = [...map.values()].sort((a, b) => a.start - b.start);
  // Readings without a reset time (Desktop history) join the window that covers them.
  for (const r of readings) {
    if (r.kind !== kind || r.r != null) continue;
    const w = wins.find((x) => r.t >= x.start && r.t <= x.resetsAt);
    if (w) w.points.push({ t: r.t, p: r.percent, severity: null });
  }
  for (const w of wins) {
    w.points.sort((a, b) => a.t - b.t);
    w.pct = Math.max(...w.points.map((x) => x.p));
    w.last = w.points[w.points.length - 1];
  }
  return wins;
}

function makeCostIndex(messages) {
  const s = [...messages].sort((a, b) => a.t - b.t);
  const pre = [0];
  for (const m of s) pre.push(pre[pre.length - 1] + m.adj);
  const idx = (t) => {
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (a, b) => pre[idx(b)] - pre[idx(a)]; // cost in (a, b]
}

// Walk a window's readings. Increases during intervals with no Code activity
// are chat for certain; the rest is shared between Code and chat using k.
function walkWindow(w, costIn) {
  const steps = [];
  let prev = { t: w.start, p: 0 };
  for (const pt of w.points) {
    const d = Math.max(0, pt.p - prev.p);
    steps.push({ a: prev.t, b: pt.t, d, c: costIn(prev.t, pt.t) });
    prev = pt;
  }
  const idle = sum(steps.filter((s) => s.c < 1e-4), (s) => s.d);
  const code = sum(steps, (s) => s.c);
  return { steps, idle, code };
}

function calibrate(wins, costIn, activity, codeOnly, minPct) {
  const samples = [];
  for (const w of wins) {
    const { idle, code } = walkWindow(w, costIn);
    const pts = w.pct - idle;
    if (w.pct < minPct || code <= 0 || pts <= 0) continue;
    const end = Math.min(w.resetsAt, w.last.t);
    const busyDesktop = activity.some((t) => t >= w.start && t <= end);
    const marked = codeOnly.includes(w.resetsAt);
    samples.push({ r: pts / code, clean: marked || (!busyDesktop && idle === 0), marked });
  }
  const clean = samples.filter((s) => s.clean).map((s) => s.r);
  const all = samples.map((s) => s.r);
  const k = clean.length ? percentile(clean, 0.5) : percentile(all.slice(-20), 0.2);
  return { k, windows: samples.length, cleanWindows: clean.length, provisional: samples.length < 5 };
}

function attribute(w, costIn, k, messages) {
  const { steps } = walkWindow(w, costIn);
  // Increases while Code was idle are chat. While Code was busy, chat is what
  // the whole busy part leaves after k x cost. Netting over the window, not
  // step by step, matters: readings are whole percents, so most steps show
  // +0 or +1, and a per-step max(0, ...) would push all rounding into chat.
  const idle = steps.filter((s) => s.c < 1e-4);
  const busy = steps.filter((s) => s.c >= 1e-4);
  const busyChat = k ? Math.max(0, sum(busy, (s) => s.d) - k * sum(busy, (s) => s.c)) : 0;
  // Spread the busy share over the steps that ran ahead of Code, for the daily chart.
  const ahead = busy.map((s) => Math.max(0, s.d - (k || 0) * s.c));
  const aheadTotal = sum(ahead);
  const chatSteps = [
    ...idle.filter((s) => s.d > 0).map((s) => ({ t: s.b, chat: s.d })),
    ...busy.map((s, i) => ({ t: s.b, chat: aheadTotal ? (busyChat * ahead[i]) / aheadTotal : 0 })).filter((x) => x.chat > 0),
  ];
  const chat = Math.min(sum(idle, (s) => s.d) + busyChat, w.pct);
  const code = Math.max(0, w.pct - chat);
  const inWin = messages.filter((m) => m.t > w.start && m.t <= w.last.t);
  const total = sum(inWin, (m) => m.adj) || 1;
  const bySurface = {};
  for (const m of inWin) {
    const key = m.entrypoint === 'claude-desktop' ? 'desktop' : m.entrypoint === 'cli' ? 'cli' : 'headless';
    bySurface[key] = (bySurface[key] || 0) + code * (m.cost / total);
  }
  bySurface.unitemised = code * (sum(inWin, (m) => m.adj - m.cost) / total);
  return { chat, code, codeCost: sum(inWin, (m) => m.adj), chatSteps, bySurface };
}

// Least-squares slope of percent over time (points per ms), for pace.
function slope(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const mt = sum(points, (p) => p.t) / n;
  const mp = sum(points, (p) => p.p) / n;
  const num = sum(points, (p) => (p.t - mt) * (p.p - mp));
  const den = sum(points, (p) => (p.t - mt) ** 2);
  return den > 0 ? num / den : null;
}

function forecast(w, now, kind) {
  if (!w) return null;
  const pct = w.last.p;
  const remaining = Math.max(0, w.resetsAt - now);
  const elapsed = Math.max(1, Math.min(now, w.resetsAt) - w.start);
  const lookback = kind === 'session' ? HOUR : DAY;
  const minSpan = kind === 'session' ? 15 * 60000 : 3 * HOUR;
  const recentPts = w.points.filter((p) => p.t >= now - lookback);
  const recent = recentPts.length >= 2 && recentPts[recentPts.length - 1].t - recentPts[0].t >= minSpan ? Math.max(0, slope(recentPts)) : null;
  const average = pct / elapsed;
  // A pause flattens the recent slope to 0; fall back to the window average
  // rather than reporting "won't hit the limit" because of a coffee break.
  const pace = recent > 0 ? recent : average;
  const lo = Math.min(recent ?? average, average);
  const hi = Math.max(recent ?? average, average);
  const at = (p) => Math.min(100, pct + p * remaining);
  const toLimit = pace > 0 ? (100 - pct) / pace : null;
  return {
    pct,
    resetsAt: new Date(w.resetsAt).toISOString(),
    start: new Date(w.start).toISOString(),
    pacePerHour: round(pace * HOUR, 2),
    paceBasis: recent > 0 ? (kind === 'session' ? 'last 60 min' : 'last 24 h') : 'window average',
    projectedAtReset: round(at(pace), 0),
    projectedRange: [round(at(lo), 0), round(at(hi), 0)],
    timeToLimitMs: toLimit != null ? Math.round(toLimit) : null,
    hitsBeforeReset: toLimit != null && toLimit < remaining,
    hitAt: toLimit != null && toLimit < remaining ? new Date(now + toLimit).toISOString() : null,
    readings: w.points.map((p) => [new Date(p.t).toISOString(), p.p]),
    severity: w.last.severity || null,
  };
}

// ---------- breakdowns ----------

function whereOf(m) {
  if (m.agent) return 'Subagents';
  if (m.entrypoint === 'claude-desktop') return 'Main · Desktop agent';
  if (m.entrypoint === 'cli') return 'Main · CLI';
  return 'Headless (claude -p)';
}

function sourceOf(e) {
  return e === 'claude-desktop' ? 'Desktop agent' : e === 'cli' ? 'CLI' : 'Headless';
}

function topN(obj, n, key = 'pts') {
  return Object.values(obj).sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n);
}

function mcpServer(tool) {
  if (!tool.startsWith('mcp__')) return null;
  return tool.slice(5).split('__')[0];
}

function breakdown(msgs, { codePts, chatPts, chatTokens, sessions, k, unit, total }) {
  const adjTotal = sum(msgs, (m) => m.adj);
  const ptsOf = (m) => (codePts != null && adjTotal > 0 ? (codePts * m.adj) / adjTotal : null);
  const add = (o, key, init, m, extra) => {
    const g = (o[key] ||= { ...init, req: 0, in: 0, out: 0, cw: 0, cr: 0, tokens: 0, cost: 0, adj: 0, pts: 0 });
    g.req += m.req || 1; // an archived row stands for many responses
    g.in += m.in; g.out += m.out; g.cw += m.cw5 + m.cw1h; g.cr += m.cr;
    g.tokens += tokensOf(m); g.cost += m.cost; g.adj += m.adj; g.pts += ptsOf(m) || 0;
    if (extra) extra(g);
    return g;
  };

  const models = {}, projects = {}, sess = {}, agents = {}, skills = {}, tools = {}, mcp = {};
  for (const m of msgs) {
    // A residual row (session total with no response records) belongs to its
    // project and session, but only to the "not itemised" model row.
    if (!m.residual) add(models, `${m.model}|${whereOf(m)}`, { model: m.model || 'unknown', where: whereOf(m) }, m);
    const proj = m.cwd ? path.basename(m.cwd.replace(/[\\/]+$/, '')) : 'unknown';
    add(projects, proj, { name: proj, branches: new Set(), sources: new Set() }, m, (g) => {
      if (m.branch && m.branch !== 'HEAD') g.branches.add(m.branch);
      g.sources.add(sourceOf(m.entrypoint));
    });
    if (!m.archived) add(sess, m.session, { session: m.session, models: new Set(), agents: new Set() }, m, (g) => {
      if (m.agent) g.agents.add(m.agent.id || m.agent.type);
      else g.models.add(m.model);
    });
    if (m.agent) {
      const key = m.agent.type || m.agent.name || 'agent';
      add(agents, key, { name: key, models: new Set(), depth: m.agent.depth, tools: {} }, m, (g) => {
        g.models.add(m.model);
        for (const t of m.tools) g.tools[t] = (g.tools[t] || 0) + 1;
      });
    }
    if (m.skill) add(skills, m.skill, { name: m.skill }, m);
    const share = m.tools.length ? 1 / m.tools.length : 0;
    for (const t of m.tools) {
      const g = (tools[t] ||= { name: t, calls: 0, pts: 0, cost: 0 });
      g.calls++;
      g.pts += (ptsOf(m) || 0) * share;
      g.cost += m.adj * share;
      const srv = mcpServer(t);
      if (srv) {
        const s = (mcp[srv] ||= { name: srv, calls: 0, pts: 0 });
        s.calls++;
        s.pts += (ptsOf(m) || 0) * share;
      }
    }
  }

  const unitemisedAdj = sum(msgs, (m) => m.adj - m.cost);
  const r = (x) => round(x, 2);
  const modelRows = Object.values(models)
    .sort((a, b) => b.adj - a.adj)
    .map((g) => ({ model: g.model, where: g.where, req: g.req, in: g.in, out: g.out, cw: g.cw, cr: g.cr, cost: r(g.cost), pts: codePts != null ? r(g.adj > 0 ? (g.pts * g.cost) / g.adj : 0) : null }));
  if (unitemisedAdj > 0.0001) modelRows.push({ model: 'Claude Code · not itemised', where: 'from session totals', unitemised: true, cost: r(unitemisedAdj), pts: codePts != null ? r((codePts * unitemisedAdj) / adjTotal) : null });
  if (chatPts != null) modelRows.push({ model: 'Chat and other devices', where: 'claude.ai, Desktop Chat, mobile, other computers', chat: true, tokens: chatTokens, pts: r(chatPts) });

  const projRows = topN(projects, 8).map((g) => ({ name: g.name, branch: [...g.branches].slice(0, 2).join(' · '), src: [...g.sources].join(' + '), tokens: g.tokens, cost: r(g.adj), pts: codePts != null ? r(g.pts) : null }));
  if (chatPts != null) projRows.push({ name: 'Chat and other devices', src: 'estimated', tokens: chatTokens, pts: r(chatPts), chat: true });

  const sessRows = topN(sess, 8, codePts != null ? 'pts' : 'adj').map((g) => {
    const s = sessions.get(g.session) || {};
    const main = [...g.models].filter(Boolean).map(prettyModel).join(', ');
    return {
      title: s.customTitle || s.aiTitle || (s.cwd ? path.basename(s.cwd) : g.session.slice(0, 8)),
      src: sourceOf(s.entrypoint),
      model: main + (g.agents.size ? ` + ${g.agents.size} agent${g.agents.size > 1 ? 's' : ''}` : ''),
      durationMs: s.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : null,
      tokens: g.tokens,
      cost: r(g.adj),
      pts: codePts != null ? r(g.pts) : null,
    };
  });

  const agentRows = topN(agents, 8, 'adj').map((g) => ({
    name: g.name,
    model: [...g.models].join(', '),
    depth: g.depth,
    req: g.req,
    tokens: g.tokens,
    cost: r(g.adj),
    pts: codePts != null ? r(g.pts) : null,
    tools: Object.entries(g.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t} ${n}`).join(' · '),
  }));

  const skillRows = topN(skills, 10, 'adj').map((g) => ({ name: g.name, responses: g.req, cost: r(g.adj), pts: codePts != null ? r(g.pts) : null, share: total ? r(((codePts != null ? g.pts : g.adj) / total) * 100) : null }));
  const toolRows = topN(tools, 15, 'cost').map((g) => ({ name: g.name, calls: g.calls, cost: r(g.cost), pts: codePts != null ? r(g.pts) : null }));
  const mcpRows = Object.values(mcp).map((g) => ({ name: g.name, calls: g.calls, pts: codePts != null ? r(g.pts) : null }));

  const real = msgs.filter((m) => !m.residual);
  const main = sum(real.filter((m) => !m.agent), (m) => m.req || 1);
  const exactTokens = sum(msgs, tokensOf);
  return {
    unit,
    total: total != null ? r(total) : null,
    tiles: {
      requests: sum(real, (m) => m.req || 1),
      mainRequests: main,
      agentRequests: sum(real, (m) => m.req || 1) - main,
      tokens: exactTokens + (chatTokens || 0),
      exactTokens,
      chatTokens: chatTokens || 0,
      cacheReadShare: exactTokens ? sum(msgs, (m) => m.cr) / exactTokens : 0,
      apiCost: r(sum(msgs, (m) => m.adj)),
    },
    models: modelRows,
    projects: projRows,
    sessions: sessRows,
    agents: agentRows,
    skills: skillRows,
    tools: toolRows,
    mcp: mcpRows,
  };
}

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Family by keyword, so both "claude-opus-5-5" and older "claude-3-5-sonnet" work.
export function familyOf(m) {
  const f = FAMILIES.find((x) => (m || '').includes(x));
  return f ? cap(f) : 'Other';
}

// "claude-opus-5-5" -> "Opus 5.5", "claude-3-5-sonnet" -> "Sonnet 3.5".
export function prettyModel(m) {
  if (!m) return 'unknown';
  const f = FAMILIES.find((x) => m.includes(x));
  if (!f) return m;
  const version = m.replace(/^claude-/, '').split('-').filter((p) => p !== f && /^\d+$/.test(p)).join('.');
  return `${cap(f)} ${version}`.trim();
}

// ---------- main ----------

// Reconcile, then build and attribute the limit windows. Shared by the report
// and by retention, so summaries carry the same inferences the report shows.
export function prepare(data, config) {
  const { messages, sessions, trueCost, costMeta = new Map(), readings, activity } = data;
  const unitemised = reconcile(messages, trueCost, sessions, costMeta);
  // Archived days join after reconciliation: their cost is already reconciled.
  for (const m of data.archivedMessages || []) messages.push(m);
  const costIn = makeCostIndex(messages);
  const kinds = {};
  for (const [kind, minPct] of [['session', 5], ['weekly_all', 3]]) {
    const wins = buildWindows(readings, kind);
    const cal = calibrate(wins, costIn, activity, config.codeOnlyWindows || [], minPct);
    kinds[kind] = { wins, cal, attributed: wins.map((w) => ({ w, ...attribute(w, costIn, cal.k, messages) })) };
  }
  return { unitemised, costIn, kinds };
}

export function analyze({ now = Date.now(), data = loadData(), config = loadConfig() } = {}) {
  const { messages, sessions, readings, overhead } = data;
  const archivedWindows = data.archivedWindows || [];
  const archivedWeeks = archivedWindows.filter((x) => x.kind === 'weekly_all');
  const { unitemised: unitemisedAll, kinds } = prepare(data, config);
  const recent = messages.filter((m) => m.t > now - 30 * DAY && m.t <= now);
  const tpd30 = sum(recent, (m) => m.adj) > 0 ? sum(recent, tokensOf) / sum(recent, (m) => m.adj) : 0;
  const result = { generatedAt: new Date(now).toISOString(), windows: {}, calibration: {}, attribution: {}, breakdown: {}, config: { plan: config.plan || 'pro' } };
  const chatByKind = {};

  for (const [kind, label] of [['session', 'h5'], ['weekly_all', 'wk']]) {
    const { wins, cal, attributed } = kinds[kind];
    result.calibration[label] = { k: cal.k, windows: cal.windows, cleanWindows: cal.cleanWindows, provisional: cal.provisional };
    const current = [...wins].reverse().find((w) => w.resetsAt > now) || null;
    const fc = forecast(current, now, kind);
    chatByKind[kind] = attributed;

    const attr = current ? chatByKind[kind].find((x) => x.w === current) : null;
    const inWin = current ? messages.filter((m) => m.t > current.start && m.t <= now) : [];
    // Tokens per list-price dollar converts chat points into tokens. Use this
    // window's mix, or the last 30 days when the window has no Code activity.
    const tokensPerDollar = sum(inWin, (m) => m.adj) > 0 ? sum(inWin, tokensOf) / sum(inWin, (m) => m.adj) : tpd30;
    const chatTokens = attr && cal.k ? Math.round((attr.chat / cal.k) * tokensPerDollar) : 0;
    if (fc) {
      const exact = sum(inWin, tokensOf);
      const totalTokens = exact + chatTokens;
      fc.tokensExact = exact;
      fc.tokensChat = chatTokens;
      fc.tokensLeft = fc.pct > 0 ? Math.round((totalTokens / fc.pct) * (100 - fc.pct)) : null;
      fc.tokensPerPoint = fc.pct > 0 ? Math.round(totalTokens / fc.pct) : null;
    }
    result.windows[label] = fc;
    if (attr) {
      result.attribution[label] = {
        total: attr.w.pct,
        cli: round(attr.bySurface.cli || 0, 2),
        desktop: round(attr.bySurface.desktop || 0, 2),
        headless: round(attr.bySurface.headless || 0, 2),
        unitemised: round(attr.bySurface.unitemised || 0, 2),
        chat: round(attr.chat, 2),
      };
    }
    result.breakdown[label] = current
      ? breakdown(inWin, {
          codePts: attr ? attr.code : null,
          chatPts: attr ? attr.chat : null,
          chatTokens,
          sessions,
          k: cal.k,
          unit: kind === 'session' ? '% of 5-hour limit' : '% of weekly limit',
          total: attr ? attr.w.pct : null,
        })
      : breakdown(inWin, { sessions, unit: 'list-price dollars' });
    result.breakdown[label].range = current ? { start: new Date(current.start).toISOString(), end: new Date(current.resetsAt).toISOString() } : null;
  }

  // Last 30 days, in weekly-limit points: a full week is 100.
  const from30 = now - 30 * DAY;
  const msgs30 = messages.filter((m) => m.t > from30 && m.t <= now);
  const weeks30 = (chatByKind.weekly_all || []).filter((x) => x.w.resetsAt > from30);
  const total30 = weeks30.length ? sum(weeks30, (x) => x.w.pct) : null;
  const chat30 = weeks30.length ? sum(weeks30, (x) => x.chat) : null;
  const kWeek = result.calibration.wk.k;
  result.breakdown.d30 = breakdown(msgs30, {
    codePts: total30 != null ? total30 - chat30 : null,
    chatPts: chat30,
    chatTokens: chat30 && kWeek ? Math.round((chat30 / kWeek) * tpd30) : 0,
    sessions,
    unit: '% of a weekly limit, summed across weeks',
    total: total30,
  });
  result.breakdown.d30.range = { start: new Date(from30).toISOString(), end: new Date(now).toISOString() };

  // 90 days is always offered; its note says how much of it the store covers.
  // All history appears once the store holds more than 90 days.
  const first = messages.reduce((a, m) => Math.min(a, m.t), Infinity);
  const longRange = (days) => {
    const from = days ? now - days * DAY : first - 1;
    const msgs = messages.filter((m) => m.t > from && m.t <= now);
    const liveKeys = new Set((chatByKind.weekly_all || []).map((x) => x.w.resetsAt)); // weekly windows only, like archivedWeeks
    const wks = [...(chatByKind.weekly_all || []).filter((x) => x.w.resetsAt > from), ...archivedWeeks.filter((x) => x.resetsAt > from && !liveKeys.has(x.resetsAt))];
    const total = wks.length ? sum(wks, (x) => x.w ? x.w.pct : x.peak) : null;
    const chat = wks.length ? sum(wks, (x) => x.chat) : null;
    const tpd = sum(msgs, (m) => m.adj) > 0 ? sum(msgs, tokensOf) / sum(msgs, (m) => m.adj) : tpd30;
    const b = breakdown(msgs, { codePts: total != null ? total - chat : null, chatPts: chat, chatTokens: chat && kWeek ? Math.round((chat / kWeek) * tpd) : 0, sessions, unit: '% of a weekly limit, summed across weeks', total });
    b.range = { start: new Date(Number.isFinite(first) ? Math.max(from, first) : from).toISOString(), end: new Date(now).toISOString() };
    b.dataFrom = Number.isFinite(first) ? new Date(first).toISOString() : null;
    return b;
  };
  result.breakdown.d90 = longRange(90);
  if (first < now - 90 * DAY) result.breakdown.all = longRange(0);

  result.history = history(chatByKind, msgs30, now);
  result.overhead = overheadView(overhead, result.breakdown.d30);
  result.value = value(msgs30, chat30, kWeek, config);
  result.unitemisedCost = round(unitemisedAll, 2);
  result.sources = sourcesView(data, readings);
  result.insights = insights({ messages, sessions, chatByKind, k: { h5: result.calibration.h5.k, wk: kWeek }, windows: result.windows, tpd30, now, plan: config.plan || 'pro', archive: { windows: archivedWindows } });
  result.recommendations = recommend(result, msgs30);
  return result;
}

function history(chatByKind, msgs30, now) {
  const weeks = (chatByKind.weekly_all || []).slice(-6).map(({ w }) => {
    const hits = (chatByKind.session || []).filter(({ w: s }) => s.resetsAt > w.start && s.start < w.resetsAt && (s.pct >= 100 || ['critical', 'exceeded'].includes(s.last.severity))).length;
    return { start: new Date(w.start).toISOString(), pct: w.pct, hits, current: w.resetsAt > now };
  });
  const sessionsAll = chatByKind.session || [];
  const limitHits = sessionsAll.filter(({ w }) => w.resetsAt > now - 30 * DAY && w.pct >= 100);
  const lastHit = limitHits.length ? limitHits[limitHits.length - 1].w.points.find((p) => p.p >= 100) : null;

  // Heatmap: share of Code usage by local weekday (Mon=0) and hour.
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const m of msgs30) {
    const d = new Date(m.t);
    grid[(d.getDay() + 6) % 7][d.getHours()] += m.adj;
  }
  const tot = sum(grid.flat()) || 1;
  const heat = grid.map((row) => row.map((v) => round(v / tot, 4)));
  const byDay = heat.map((row) => sum(row));
  const byHour = Array.from({ length: 24 }, (_, h) => sum(heat, (row) => row[h]));
  const day = byDay.indexOf(Math.max(...byDay));
  const hour = byHour.indexOf(Math.max(...byHour));

  // This week vs last week at the same point in the week.
  let vsLastWeek = null;
  const wk = chatByKind.weekly_all || [];
  if (wk.length >= 2 && wk[wk.length - 1].w.resetsAt > now) {
    const cur = wk[wk.length - 1].w;
    const prev = wk[wk.length - 2].w;
    const offset = now - cur.start;
    const at = prev.points.filter((p) => p.t - prev.start <= offset).pop();
    if (at) vsLastWeek = { now: cur.last.p, then: at.p };
  }
  return {
    weeks,
    heatmap: heat,
    limitHits30: limitHits.length,
    lastHit: lastHit ? new Date(lastHit.t).toISOString() : null,
    busiest: msgs30.length ? { day, hour, share: round(byHour[hour] * 100, 0) } : null,
    activeDays: new Set(msgs30.map((m) => new Date(m.t).toDateString())).size,
    vsLastWeek,
  };
}

function overheadView(o, d30) {
  if (!o) return { mcp: [], plugins: [], snapshot: null };
  const calls = Object.fromEntries((d30.mcp || []).map((m) => [m.name, m.calls]));
  // /context lists full definition sizes per tool, but most MCP tools are
  // deferred: only names load until Claude searches for them. The category
  // totals say how much actually loads, so scale each server to that.
  const cat = (n) => sum(o.categories.filter((c) => c.name === n), (c) => c.tokens);
  const loadedTools = cat('MCP tools');
  const instructions = cat('MCP server instructions');
  const defined = sum(o.mcpTools, (t) => t.tokens) || 1;
  const servers = {};
  for (const t of o.mcpTools) {
    const s = (servers[t.server] ||= { name: t.server, defined: 0, tools: 0 });
    s.defined += t.tokens || 0;
    s.tools++;
  }
  const nServers = Object.keys(servers).length || 1;
  for (const s of Object.values(servers)) s.tokens = Math.round((s.defined / defined) * loadedTools + instructions / nServers);
  const plugins = {};
  for (const s of o.skills) {
    if (!s.plugin) continue;
    const p = (plugins[s.plugin] ||= { name: s.plugin, skills: 0, tokens: 0, used: 0 });
    p.skills++;
    p.tokens += s.tokens || 0;
    p.used += (d30.skills || []).filter((x) => x.name === s.name || x.name === `${s.plugin}:${s.name}`).reduce((a, x) => a + x.responses, 0);
  }
  return {
    snapshot: o.ts,
    loadedMcpTokens: loadedTools + instructions,
    deferredMcpTokens: cat('MCP tools (deferred)'),
    categories: o.categories,
    mcp: Object.values(servers).map((s) => ({ ...s, calls: calls[s.name] || 0 })).sort((a, b) => b.tokens - a.tokens),
    plugins: Object.values(plugins).sort((a, b) => b.tokens - a.tokens),
  };
}

function value(msgs30, chat30, kWeek, config) {
  const fam = {};
  for (const m of msgs30) {
    const f = familyOf(m.model);
    const key = `${f}${m.agent ? ' · agents' : ''}`;
    fam[key] = (fam[key] || 0) + m.adj;
  }
  const rows = Object.entries(fam).map(([label, v]) => ({ label, cost: round(v, 2) })).sort((a, b) => b.cost - a.cost);
  const chatCost = chat30 && kWeek ? chat30 / kWeek : 0;
  if (chatCost > 0) rows.push({ label: 'Chat and other devices (est.)', cost: round(chatCost, 2), chat: true });
  const total = sum(rows, (r) => r.cost);
  const plan = config.plan || 'pro';
  return { total: round(total, 2), planPrice: PLAN_PRICE[plan] ?? null, plan, multiple: PLAN_PRICE[plan] ? round(total / PLAN_PRICE[plan], 1) : null, rows };
}

function sourcesView(data, readings) {
  const last = (src) => {
    const r = readings.filter((x) => x.source === src).pop();
    return r ? new Date(r.t).toISOString() : null;
  };
  const files = new Set(data.messages.map((m) => m.session)).size;
  return {
    usagePoll: last('usage-poll') || last('usage-log'),
    statusline: last('statusline'),
    desktop: last('desktop-history'),
    sessions: files,
    messages: data.messages.length,
    surfaces: [...new Set(data.messages.map((m) => m.entrypoint).filter(Boolean))],
  };
}

function fmtDur(ms) {
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / 60000);
  return h ? `${h} h ${m} m` : `${m} m`;
}

function recommend(r, msgs30) {
  const out = [];
  const h5 = r.windows.h5;
  if (h5?.hitsBeforeReset) {
    out.push({ title: 'Slow down or switch models.', body: `At the current pace the 5-hour limit runs out in ${fmtDur(h5.timeToLimitMs)}, before it resets. Moving routine work to Sonnet or Haiku stretches what is left.` });
  }
  const idle = (r.overhead.mcp || []).filter((s) => s.calls === 0);
  const idleTokens = sum(idle, (s) => s.tokens);
  if (idle.length && idleTokens >= 2000) {
    out.push({ title: 'Turn off MCP servers you do not use.', body: `${idle.slice(0, 3).map((s) => s.name).join(', ')}${idle.length > 3 ? ` and ${idle.length - 3} more` : ''} had no calls in 30 days but load about ${Math.round(idleTokens / 100) / 10}K tokens into every new session.` });
  }
  const agentMsgs = msgs30.filter((m) => m.agent);
  const opusAgents = agentMsgs.filter((m) => /opus|fable/.test(m.model || ''));
  if (opusAgents.length && sum(opusAgents, (m) => m.adj) > 0.25 * sum(agentMsgs, (m) => m.adj)) {
    out.push({ title: 'Run subagents on a cheaper model.', body: `Subagents on Opus or Fable cost $${round(sum(opusAgents, (m) => m.adj), 2)} at list price in 30 days. Exploration and search agents usually do as well on Haiku, at a fraction of the weight.` });
  }
  const long = msgs30.filter((m) => m.in + m.cr + m.cw5 + m.cw1h > 150000);
  const longShare = sum(long, (m) => m.adj) / (sum(msgs30, (m) => m.adj) || 1);
  if (longShare > 0.1) {
    out.push({ title: 'Watch long contexts.', body: `${Math.round(longShare * 100)}% of your Code usage ran with more than 150K tokens of context. Running /compact earlier or starting fresh sessions for new tasks keeps each turn lighter.` });
  }
  const cacheWrite = sum(msgs30, (m) => m.cost * (m.cw5 * 1.25 + m.cw1h * 2) / Math.max(1, m.in + m.out * 5 + m.cw5 * 1.25 + m.cw1h * 2 + m.cr * 0.1));
  if (cacheWrite > 0.4 * (sum(msgs30, (m) => m.cost) || 1)) {
    out.push({ title: 'Fewer fresh starts.', body: 'Cache writes are a large part of your usage. Each new session or a long pause re-sends the full context. Keeping related work in one session, or resuming instead of restarting, cuts this.' });
  }
  return out.slice(0, 4);
}
