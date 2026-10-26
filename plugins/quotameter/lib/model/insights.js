// Derived stats for the "How you use your limit" section: weekly token
// trend, typical session cost, unused allowance, which limit binds, model
// what-if, cache, subagents, limit timing, burn rate, context growth,
// branches, daily chat vs Code and session length.
//
// k.h5 and k.wk convert list-price dollars to points of each window. Either
// can be null before the first calibration; every stat then falls back to
// dollars or tokens and says so.

import { costOf, priceFor } from './pricing.js';
import { folderName } from './breakdown.js';
import { HOUR, DAY, sum, tokensOf, round, percentile } from './util.js';

const ACTIVE_GAP = 15 * 60000; // a pause longer than this ends an active stretch
const CACHE_TTL = 5 * 60000; // the default prompt cache lifetime
const HEAVY = /opus|fable|mythos/;
const CTX = (m) => m.in + m.cr + m.cw5 + m.cw1h;

function usageOf(m) {
  return {
    input_tokens: m.in,
    output_tokens: m.out,
    cache_read_input_tokens: m.cr,
    cache_creation_input_tokens: m.cw5 + m.cw1h,
    cache_creation: { ephemeral_5m_input_tokens: m.cw5, ephemeral_1h_input_tokens: m.cw1h },
    speed: m.speed,
  };
}

// The adjusted cost carries the session's share of usage the logs do not
// itemise. Keep that ratio when re-pricing a message.
const scale = (m) => (m.cost > 0 ? m.adj / m.cost : 1);

function localDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupSessions(msgs, sessions) {
  const by = new Map();
  for (const m of msgs) {
    const g = by.get(m.session) || { session: m.session, adj: 0, tokens: 0, first: Infinity, last: -Infinity, agentAdj: 0, entry: new Set() };
    g.adj += m.adj;
    g.tokens += tokensOf(m);
    if (!m.residual) {
      g.first = Math.min(g.first, m.t);
      g.last = Math.max(g.last, m.t);
    }
    if (m.agent) g.agentAdj += m.adj;
    if (m.entrypoint) g.entry.add(m.entrypoint);
    by.set(m.session, g);
  }
  return [...by.values()].map((g) => {
    const s = sessions.get(g.session) || {};
    const interactive = g.entry.has('cli') || g.entry.has('claude-desktop') || ['cli', 'claude-desktop'].includes(s.entrypoint);
    return { ...g, interactive, durationMs: Number.isFinite(g.first) ? g.last - g.first : 0, title: s.customTitle || s.aiTitle || null };
  });
}

// 1. Tokens and weekly-limit % per week, 12 weeks, aligned to the weekly
// reset when we know it. A week that retention already summarised uses the
// totals stored on its window, which are exact to the reset time; archived
// daily rows would blur the week boundary by up to a day.
const WEEKS = 12;
function weeklyTokens(msgs, wkWins, h5Wins, archive, anchor, now, kWk, tpd30) {
  const out = [];
  // Resets are a week apart; half a day of tolerance survives clock shifts.
  const near = (a, b) => Math.abs(a - b) < 12 * HOUR;
  for (let i = WEEKS - 1; i >= 0; i--) {
    const start = anchor - i * 7 * DAY;
    const end = Math.min(start + 7 * DAY, now);
    if (start > now) continue;
    const win = wkWins.find((x) => near(x.w.start, start));
    const old = win ? null : archive.windows.find((x) => x.kind === 'weekly_all' && near(x.start, start));
    const useOld = old && old.fresh != null;
    const inB = useOld ? [] : msgs.filter((m) => m.t > start && m.t <= end);
    const fresh = useOld ? old.fresh : sum(inB, (m) => m.in + m.out + m.cw5 + m.cw1h);
    const cacheRead = useOld ? old.cacheRead : sum(inB, (m) => m.cr);
    const adj = sum(inB, (m) => m.adj);
    const tpd = adj > 0 ? sum(inB, tokensOf) / adj : tpd30;
    const chat = useOld ? old.chatTokens || 0 : win && kWk ? Math.round((win.chat / kWk) * tpd) : 0;
    const pct = win ? win.w.pct : old ? old.peak : null;
    const hits = h5Wins.filter(({ w }) => w.start >= start && w.start < start + 7 * DAY && w.pct >= 100).length
      + archive.windows.filter((x) => x.kind === 'session' && x.start >= start && x.start < start + 7 * DAY && x.peak >= 100).length;
    const empty = !inB.length && !useOld && pct == null;
    out.push({ start: new Date(start).toISOString(), end: new Date(start + 7 * DAY).toISOString(), fresh, cacheRead, chat, pct, hits, current: end === now, empty });
  }
  // Keep empty weeks so the chart reads as a 12-week history, not one bar.
  return out;
}

// Plan fit over everything kept: finished weekly windows and 5-hour limit
// hits, live and archived. Needs two finished weeks before it says anything.
const NEXT_PLAN = { pro: 'Max 5x', max5: 'Max 20x' };
function planFit(h5Wins, wkWins, archive, now, plan, historyStart) {
  const liveKeys = new Set([...wkWins, ...h5Wins].map(({ w }) => `${w.kind}|${w.resetsAt}`));
  const old = archive.windows.filter((x) => !liveKeys.has(`${x.kind}|${x.resetsAt}`));
  const weeks = [
    ...wkWins.filter(({ w }) => w.resetsAt <= now).map(({ w }) => w.pct),
    ...old.filter((x) => x.kind === 'weekly_all').map((x) => x.peak),
  ];
  const hits = h5Wins.filter(({ w }) => w.pct >= 100).length + old.filter((x) => x.kind === 'session' && x.peak >= 100).length;
  const weekHits = weeks.filter((p) => p >= 100).length;
  if (weeks.length < 2) {
    const since = historyStart ? Math.max(1, Math.round((now - Date.parse(historyStart)) / DAY)) : 0;
    return { weeks: weeks.length, title: 'Too early to judge your plan.', body: `This needs two finished weeks of readings; quotameter has ${since} day${since === 1 ? '' : 's'} so far.` };
  }
  const avg = Math.round(sum(weeks) / weeks.length);
  const perWeek = hits / weeks.length;
  const next = NEXT_PLAN[plan];
  const base = { weeks: weeks.length, avgWeekly: avg, hits, weekHits };
  const hitText = hits ? `hit the 5-hour limit ${hits} time${hits === 1 ? '' : 's'}` : 'never hit the 5-hour limit';
  if (weekHits || perWeek >= 2 || avg >= 85) {
    return { ...base, verdict: 'tight', title: 'Your plan is tight.', body: `Over ${weeks.length} weeks you averaged ${avg}% of the weekly limit and ${hitText}${weekHits ? `, plus the weekly limit ${weekHits} time${weekHits === 1 ? '' : 's'}` : ''}.${next ? ` ${next} would give you more room.` : ''}` };
  }
  if (avg < 40 && !hits) {
    return { ...base, verdict: 'roomy', title: 'Plenty of room.', body: `Over ${weeks.length} weeks you averaged ${avg}% of the weekly limit and never hit the 5-hour limit.` };
  }
  return { ...base, verdict: 'fits', title: 'Your plan fits.', body: `Over ${weeks.length} weeks you averaged ${avg}% of the weekly limit and ${hitText}.` };
}

// 2 and 3. What one session costs, and how many more fit in this window.
function sessionCost(list, k, windows) {
  const ses = list.filter((s) => s.interactive && s.adj > 0);
  if (!ses.length) return null;
  const costs = ses.map((s) => s.adj);
  const med = percentile(costs, 0.5);
  const heavy = percentile(costs, 0.9);
  const quick = percentile(costs, 0.25); // a quick task: the lighter quarter of sessions
  const toks = percentile(ses.map((s) => s.tokens), 0.5);
  const res = {
    n: ses.length,
    medianCost: round(med, 2),
    heavyCost: round(heavy, 2),
    quickCost: round(quick, 2),
    quickH5: k.h5 ? round(quick * k.h5, 1) : null,
    medianTokens: Math.round(toks),
    medianH5: k.h5 ? round(med * k.h5, 1) : null,
    heavyH5: k.h5 ? round(heavy * k.h5, 1) : null,
    medianWk: k.wk ? round(med * k.wk, 1) : null,
    heavyWk: k.wk ? round(heavy * k.wk, 1) : null,
    left: null,
  };
  const h5 = windows.h5;
  if (h5 && k.h5 && med > 0) {
    const room = Math.max(0, 100 - h5.pct);
    // A quarter of sessions can cost nothing (a poll, an aborted start): then "quick" is unknown.
    res.left = { quick: quick > 0 ? Math.floor(room / (quick * k.h5)) : null, typical: Math.floor(room / (med * k.h5)), heavy: heavy > 0 ? Math.floor(room / (heavy * k.h5)) : 0, room };
  }
  const wk = windows.wk;
  if (wk && k.wk && med > 0) res.leftWeek = { typical: Math.floor(Math.max(0, 100 - wk.pct) / (med * k.wk)), heavy: heavy > 0 ? Math.floor(Math.max(0, 100 - wk.pct) / (heavy * k.wk)) : 0 };
  return res;
}

// 4. Allowance that reset unused.
function unused(h5Wins, wkWins, now) {
  const recent = h5Wins.filter(({ w }) => w.start > now - 7 * DAY);
  const done = recent.filter(({ w }) => w.resetsAt <= now);
  const doneWeeks = wkWins.filter(({ w }) => w.resetsAt <= now).slice(-4);
  return {
    windows: recent.length,
    finished: done.length,
    avgPeak: done.length ? round(sum(done, ({ w }) => w.pct) / done.length, 0) : null,
    light: done.filter(({ w }) => w.pct < 25).length,
    hit: recent.filter(({ w }) => w.pct >= 100).length,
    lastWeek: doneWeeks.length ? doneWeeks[doneWeeks.length - 1].w.pct : null,
    avgWeek: doneWeeks.length ? round(sum(doneWeeks, ({ w }) => w.pct) / doneWeeks.length, 0) : null,
    weeks: doneWeeks.length,
  };
}

// 5. Which limit actually stops you.
function binding(h5Wins, wkWins, windows, now) {
  const from = now - 30 * DAY;
  const h5 = h5Wins.filter(({ w }) => w.resetsAt > from);
  const wk = wkWins.filter(({ w }) => w.resetsAt > from);
  const h5Hits = h5.filter(({ w }) => w.pct >= 100).length;
  const wkHits = wk.filter(({ w }) => w.pct >= 100).length;
  const h5Peak = h5.length ? Math.max(...h5.map(({ w }) => w.pct)) : null;
  const wkPeak = wk.length ? Math.max(...wk.map(({ w }) => w.pct)) : null;
  const wkProjected = windows.wk?.projectedAtReset ?? null;
  let verdict;
  if (!h5.length && !wk.length) verdict = 'unknown';
  else if (wkHits || wkProjected >= 100) verdict = 'weekly';
  else if (h5Hits) verdict = '5-hour';
  else verdict = 'neither';
  return { verdict, h5Hits, wkHits, h5Peak, wkPeak, wkProjected, h5Windows: h5.length, wkWindows: wk.length };
}

// 6. The same work re-priced on Sonnet 5.5 and Haiku 5.5.
function whatIf(msgs, kWk) {
  const rows = [];
  for (const [label, pick] of [['All Opus and Fable work', (m) => true], ['Subagents on Opus or Fable', (m) => !!m.agent]]) {
    const heavy = msgs.filter((m) => !m.residual && HEAVY.test(m.model || '') && pick(m));
    if (!heavy.length) continue;
    const actual = sum(heavy, (m) => m.adj);
    const as = (model) => sum(heavy, (m) => (costOf(model, usageOf(m)) || 0) * scale(m));
    const sonnet = as('claude-sonnet-5-5');
    const haiku = as('claude-haiku-5-5');
    const pts = (c) => (kWk ? round(c * kWk, 1) : null);
    rows.push({ label, requests: heavy.length, actual: round(actual, 2), sonnet: round(sonnet, 2), haiku: round(haiku, 2), actualPts: pts(actual), sonnetPts: pts(sonnet), haikuPts: pts(haiku) });
  }
  return rows;
}

// 7. How much of the input came from cache, and what rebuilding it cost.
function cache(msgs, kWk) {
  const real = msgs.filter((m) => !m.residual);
  const input = sum(real, (m) => m.in + m.cw5 + m.cw1h + m.cr);
  if (!input) return null;
  const writeCost = (m) => {
    const p = priceFor(m.model);
    return p ? ((m.cw5 * 1.25 + m.cw1h * 2) * p.input * scale(m)) / 1e6 : 0;
  };
  // A large write right after a pause longer than the cache lifetime means
  // the context was sent again from scratch.
  const threads = new Map();
  for (const m of real) {
    const key = `${m.session}|${m.agent?.id || ''}`;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(m);
  }
  let rebuilds = 0;
  let rebuildCost = 0;
  let rebuildTokens = 0;
  for (const list of threads.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const m = list[i];
      const cw = m.cw5 + m.cw1h;
      if (m.t - list[i - 1].t > CACHE_TTL && cw >= 20000) {
        rebuilds++;
        rebuildTokens += cw;
        rebuildCost += writeCost(m);
      }
    }
  }
  const total = sum(real, (m) => m.adj) || 1;
  const writes = sum(real, writeCost);
  return {
    hitRatio: round(sum(real, (m) => m.cr) / input, 3),
    writeShare: round(writes / total, 3),
    writeCost: round(writes, 2),
    rebuilds,
    rebuildTokens,
    rebuildCost: round(rebuildCost, 2),
    rebuildPts: kWk ? round(rebuildCost * kWk, 1) : null,
  };
}

// 8. What subagents add on top of the main conversation.
function subagents(msgs, list, kWk) {
  const agent = sum(msgs.filter((m) => m.agent), (m) => m.adj);
  const main = sum(msgs.filter((m) => !m.agent), (m) => m.adj);
  if (!agent) return { agentCost: 0, mainCost: round(main, 2), agentPts: null, ratio: 0, share: 0, sessionsWithAgents: 0, medianSessionRatio: null };
  const withAgents = list.filter((s) => s.agentAdj > 0 && s.adj - s.agentAdj > 0);
  return {
    agentCost: round(agent, 2),
    mainCost: round(main, 2),
    agentPts: kWk ? round(agent * kWk, 1) : null,
    ratio: main > 0 ? round(agent / main, 2) : null,
    share: round(agent / (agent + main), 3),
    sessionsWithAgents: withAgents.length,
    medianSessionRatio: withAgents.length ? round(percentile(withAgents.map((s) => s.agentAdj / (s.adj - s.agentAdj)), 0.5), 2) : null,
  };
}

// 9. On days you hit the 5-hour limit, how fast it happened.
function limitTiming(h5Wins, now) {
  const hits = [];
  for (const { w } of h5Wins) {
    if (w.resetsAt <= now - 30 * DAY || w.pct < 100) continue;
    const p = w.points.find((x) => x.p >= 100);
    if (!p) continue;
    hits.push({ at: new Date(p.t).toISOString(), afterMs: p.t - w.start, lockedMs: Math.max(0, w.resetsAt - p.t) });
  }
  if (!hits.length) return { count: 0, hits: [] };
  return {
    count: hits.length,
    medianAfterMs: Math.round(percentile(hits.map((h) => h.afterMs), 0.5)),
    medianLockedMs: Math.round(percentile(hits.map((h) => h.lockedMs), 0.5)),
    hits: hits.slice(-8).reverse(),
  };
}

// 10. Burn rate while actually working. Each stretch of activity ends after
// a 15 minute pause; a lone response counts as 5 minutes.
function stretches(msgs) {
  const real = msgs.filter((m) => !m.residual).sort((a, b) => a.t - b.t);
  const out = [];
  let cur = null;
  for (const m of real) {
    if (!cur || m.t - cur.end > ACTIVE_GAP) out.push((cur = { start: m.t, end: m.t }));
    else cur.end = m.t;
  }
  return out.map((s) => ({ ...s, ms: Math.max(5 * 60000, s.end - s.start) }));
}

function burnRate(msgs, k) {
  const runs = stretches(msgs);
  const ms = sum(runs, (r) => r.ms);
  if (!ms) return null;
  const hours = ms / HOUR;
  const cost = sum(msgs, (m) => m.adj);
  const days = new Set(runs.map((r) => localDay(r.start))).size;
  return {
    activeHours: round(hours, 1),
    activeDays: days,
    hoursPerDay: round(hours / days, 1),
    costPerHour: round(cost / hours, 2),
    tokensPerHour: Math.round(sum(msgs, tokensOf) / hours),
    h5PerHour: k.h5 ? round((cost * k.h5) / hours, 1) : null,
    wkPerHour: k.wk ? round((cost * k.wk) / hours, 1) : null,
    // Hours of active work one full 5-hour window lasts at this rate.
    hoursPerWindow: k.h5 && cost > 0 ? round(100 / ((cost * k.h5) / hours), 1) : null,
  };
}

// 11. How fast the context grows in a main conversation.
function contextGrowth(msgs) {
  const by = new Map();
  for (const m of msgs) {
    if (m.residual || m.agent) continue;
    if (!by.has(m.session)) by.set(m.session, []);
    by.get(m.session).push(m);
  }
  const growth = [];
  const turnsTo100k = [];
  let reached = 0;
  let n = 0;
  const ends = [];
  for (const list of by.values()) {
    if (list.length < 3) continue;
    n++;
    list.sort((a, b) => a.t - b.t);
    const ctx = list.map(CTX);
    const peak = ctx.indexOf(Math.max(...ctx));
    if (peak > 0) growth.push((ctx[peak] - ctx[0]) / peak);
    const i = ctx.findIndex((c) => c >= 100000);
    if (i >= 0) {
      reached++;
      turnsTo100k.push(i + 1);
    }
    ends.push(Math.max(...ctx));
  }
  if (!n) return null;
  return {
    sessions: n,
    perTurn: growth.length ? Math.round(percentile(growth, 0.5)) : null,
    medianPeak: Math.round(percentile(ends, 0.5)),
    reached100k: reached,
    turnsTo100k: turnsTo100k.length ? Math.round(percentile(turnsTo100k, 0.5)) : null,
  };
}

// 12. Usage by project and git branch.
function branches(msgs, kWk) {
  const by = new Map();
  for (const m of msgs) {
    const project = m.cwd ? folderName(m.cwd) : 'unknown';
    const branch = m.branch && m.branch !== 'HEAD' ? m.branch : null;
    const key = `${project}|${branch || ''}`;
    const g = by.get(key) || { project, branch, cost: 0, tokens: 0, sessions: new Set() };
    g.cost += m.adj;
    g.tokens += tokensOf(m);
    g.sessions.add(m.session);
    by.set(key, g);
  }
  return [...by.values()]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map((g) => ({ project: g.project, branch: g.branch, sessions: g.sessions.size, tokens: g.tokens, cost: round(g.cost, 2), pts: kWk ? round(g.cost * kWk, 1) : null }));
}

// 13. Weekly-limit points per day, Code against estimated chat. Code uses
// each weekly window's own points per dollar, so the days add up to the
// window; chat lands on the day its increase was seen.
function daily(msgs, wkWins, now, kWk) {
  const days = [];
  const today = localDay(now);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push({ day: d.getTime(), code: 0, chat: 0, cost: 0 });
  }
  const at = new Map(days.map((d) => [d.day, d]));
  // Outside a window with Code activity, fall back to the calibrated k.
  const rate = (t) => {
    const x = wkWins.find(({ w }) => t > w.start && t <= w.resetsAt);
    return x && x.codeCost > 0 ? x.code / x.codeCost : kWk || null;
  };
  // Points are meaningful when weekly readings cover part of the 14 days,
  // even if Claude Code was idle and only chat moved the limit.
  const pointsKnown = wkWins.some(({ w }) => w.resetsAt > days[0].day && w.start <= now);
  for (const m of msgs) {
    const d = at.get(localDay(m.t));
    if (!d) continue;
    d.cost += m.adj;
    const r = rate(m.t);
    if (r != null) d.code += m.adj * r;
  }
  for (const { chatSteps } of wkWins) {
    for (const s of chatSteps || []) {
      const d = at.get(localDay(s.t));
      if (d) d.chat += s.chat;
    }
  }
  return {
    unit: pointsKnown ? 'points' : 'dollars',
    days: days.map((d) => ({ day: new Date(d.day).toISOString(), code: round(d.code, 2), chat: round(d.chat, 2), cost: round(d.cost, 2) })),
  };
}

// 14. How long sessions run and how hard.
function sessionLength(list) {
  const ses = list.filter((s) => s.interactive && s.durationMs > 0);
  if (!ses.length) return null;
  const longest = ses.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
  return {
    n: ses.length,
    medianMs: Math.round(percentile(ses.map((s) => s.durationMs), 0.5)),
    p90Ms: Math.round(percentile(ses.map((s) => s.durationMs), 0.9)),
    longestMs: longest.durationMs,
    longestTitle: longest.title,
    tokensPerMin: Math.round(percentile(ses.map((s) => s.tokens / Math.max(1, s.durationMs / 60000)), 0.5)),
  };
}

export function insights({ messages, sessions, chatByKind, k, windows, tpd30, now, plan = 'pro', archive = { windows: [] } }) {
  const msgs30 = messages.filter((m) => m.t > now - 30 * DAY && m.t <= now);
  const h5Wins = chatByKind.session || [];
  const wkWins = chatByKind.weekly_all || [];
  const curWeek = [...wkWins].reverse().find(({ w }) => w.resetsAt > now);
  const anchor = curWeek ? curWeek.w.start : now - 7 * DAY;
  const weekMsgs = messages.filter((m) => m.t > anchor && m.t <= now);
  const list30 = groupSessions(msgs30, sessions);
  // The oldest record kept, raw or archived; history charts start here.
  const first = messages.reduce((a, m) => Math.min(a, m.t), Infinity);
  const historyStart = Number.isFinite(first) ? new Date(first).toISOString() : null;
  return {
    // The oldest Claude Code record we have; history charts start here.
    historyStart,
    weeklyTokens: weeklyTokens(messages.filter((m) => m.t <= now), wkWins, h5Wins, archive, anchor, now, k.wk, tpd30),
    planFit: planFit(h5Wins, wkWins, archive, now, plan, historyStart),
    sessionCost: sessionCost(list30, k, windows),
    unused: unused(h5Wins, wkWins, now),
    binding: binding(h5Wins, wkWins, windows, now),
    whatIf: { period: curWeek ? 'this week' : 'last 7 days', rows: whatIf(weekMsgs, k.wk) },
    cache: { week: cache(weekMsgs, k.wk), d30: cache(msgs30, null) },
    subagents: { week: subagents(weekMsgs, groupSessions(weekMsgs, sessions), k.wk), d30: subagents(msgs30, list30, null) },
    limitTiming: limitTiming(h5Wins, now),
    burn: burnRate(msgs30, k),
    context: contextGrowth(msgs30),
    branches: branches(msgs30, k.wk),
    daily: daily(messages.filter((m) => m.t <= now), wkWins, now, k.wk),
    sessionLength: sessionLength(list30),
  };
}
