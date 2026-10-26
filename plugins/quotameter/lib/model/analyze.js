// Turns the store into the summary the report renders.
//
// Units: "points" are percentage points of a limit window. Code usage is
// measured in list-price dollars (a weight, not a bill) and converted to
// points with a calibration factor k (points per dollar), learned per window
// kind from the user's own history. See docs/DESIGN.md.

import { loadData, reconcile } from './load.js';
import { loadConfig } from '../config.js';
import { HOUR, DAY, sum, freshOf, round } from './util.js';
import { insights } from './insights.js';
import { makeCostIndex, buildWindows, calibrate, attribute, forecast } from './windows.js';
import { breakdown } from './breakdown.js';
import { familyOf, SERIES } from './models.js';
import { readK, writeK } from '../store.js';

// Max plans cap one model family ("Fable, up to 50% of your weekly limit");
// /usage reports that window as kind weekly_scoped. Only these models move it.
export const SCOPED = /fable|mythos/;

export { loadData, roundMinute } from './load.js';
export { familyOf, prettyModel } from './models.js';

const PLAN_PRICE = { pro: 20, max5: 100, max20: 200 };

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
  // The scoped window sees only the scoped models' cost, so its calibration
  // and attribution need no guessing about which usage counted.
  const scopedMsgs = messages.filter((m) => SCOPED.test(m.model || ''));
  const costInScoped = makeCostIndex(scopedMsgs);
  for (const [kind, minPct, ci, pool] of [['session', 5, costIn, messages], ['weekly_all', 3, costIn, messages], ['weekly_scoped', 3, costInScoped, scopedMsgs]]) {
    const wins = buildWindows(readings, kind);
    if (kind === 'weekly_scoped' && !wins.length) continue; // not every plan has one
    const cal = calibrate(wins, ci, activity, config.codeOnlyWindows || [], minPct);
    kinds[kind] = { wins, cal, pool, attributed: wins.map((w) => ({ w, ...attribute(w, ci, cal.k, pool) })) };
  }
  return { unitemised, costIn, kinds };
}

// k.json: what the status line and hooks use instead of running this.
export function saveK(summary) {
  const c = summary.calibration;
  const top = (summary.breakdown.h5?.models || []).find((m) => !m.chat && !m.unitemised);
  writeK({ h5: c.h5?.now || c.h5?.k || null, wk: c.wk?.now || c.wk?.k || null, fable: c.fable?.now || c.fable?.k || null, model: top?.model || readK()?.model || null });
}

export function analyze({ now = Date.now(), data = null, config = loadConfig(), pollError = null } = {}) {
  // Loaded with the same clock, so rows from other computers are judged
  // against `now` rather than the wall clock (tests run at other dates).
  data ??= loadData(undefined, { now, config });
  const { messages, sessions, readings, overhead } = data;
  // With redactPaths on, titles stored before it was turned on stay hidden too.
  if (config.redactPaths) {
    for (const s of sessions.values()) {
      delete s.customTitle;
      delete s.aiTitle;
    }
  }
  const archivedWindows = data.archivedWindows || [];
  const archivedWeeks = archivedWindows.filter((x) => x.kind === 'weekly_all');
  const { unitemised: unitemisedAll, kinds } = prepare(data, config);
  const recent = messages.filter((m) => m.t > now - 30 * DAY && m.t <= now);
  const tpd30 = sum(recent, (m) => m.adj) > 0 ? sum(recent, freshOf) / sum(recent, (m) => m.adj) : 0;
  const result = { generatedAt: new Date(now).toISOString(), windows: {}, calibration: {}, attribution: {}, breakdown: {}, config: { plan: config.plan || 'pro', warnAt: config.warnAt ?? 80 }, series: SERIES };
  const chatByKind = {};

  for (const [kind, label] of [['session', 'h5'], ['weekly_all', 'wk'], ['weekly_scoped', 'fable']]) {
    if (!kinds[kind]) {
      result.windows[label] = null;
      continue;
    }
    const { wins, cal, attributed, pool } = kinds[kind];
    result.calibration[label] = { k: cal.k, windows: cal.windows, cleanWindows: cal.cleanWindows, marked: cal.marked, provisional: cal.provisional };
    const current = [...wins].reverse().find((w) => w.resetsAt > now) || null;
    const fc = forecast(current, now, kind);
    chatByKind[kind] = attributed;

    const attr = current ? chatByKind[kind].find((x) => x.w === current) : null;
    const inWin = current ? pool.filter((m) => m.t > current.start && m.t <= now) : [];
    // Fresh tokens per list-price dollar converts chat points into tokens.
    // Use this window's mix, or the last 30 days when the window has no Code
    // activity. Everything here is in fresh tokens (input, output, cache
    // writes): cache reads are listed but never extrapolated, so a new
    // session without cache hits is not promised millions of tokens.
    const tokensPerDollar = sum(inWin, (m) => m.adj) > 0 ? sum(inWin, freshOf) / sum(inWin, (m) => m.adj) : tpd30;
    const chatTokens = attr && cal.k ? Math.round((attr.chat / cal.k) * tokensPerDollar) : 0;
    if (fc) {
      const fresh = sum(inWin, freshOf);
      const totalTokens = fresh + chatTokens;
      fc.tokensFresh = fresh;
      fc.tokensCacheRead = sum(inWin, (m) => m.cr);
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
        remote: round(attr.bySurface.remote || 0, 2),
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
          unit: kind === 'session' ? '% of 5-hour limit' : kind === 'weekly_scoped' ? '% of the Fable limit' : '% of weekly limit',
          total: attr ? attr.w.pct : null,
        })
      : breakdown(inWin, { sessions, unit: 'list-price dollars' });
    result.breakdown[label].range = current ? { start: new Date(current.start).toISOString(), end: new Date(current.resetsAt).toISOString() } : null;
    // The window in progress, once it has enough in it and shows no chat,
    // is the best guide to what a dollar costs right now; a cache-heavy
    // session can sit far from the median of older windows.
    if (attr && attr.w.pct >= 20 && attr.codeCost > 0 && attr.chat < 1) result.calibration[label].now = round(attr.code / attr.codeCost, 3);
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
    const tpd = sum(msgs, (m) => m.adj) > 0 ? sum(msgs, freshOf) / sum(msgs, (m) => m.adj) : tpd30;
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
  result.sources = { ...sourcesView(data, readings), pollError, machines: data.machines || [] };
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

// claude.ai connectors reach Claude Code through MCP under names like
// "claude_ai_Vercel". They are turned off in claude.ai settings, not here.
export const isConnector = (name) => /^claude[._ ]?ai[_.: ]/i.test(name || '');

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
    const s = (servers[t.server] ||= { name: t.server, defined: 0, tools: 0, connector: isConnector(t.server) });
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
    const names = (xs) => `${xs.slice(0, 3).map((s) => s.name).join(', ')}${xs.length > 3 ? ` and ${xs.length - 3} more` : ''}`;
    const local = idle.filter((s) => !s.connector);
    const remote = idle.filter((s) => s.connector);
    const how = [
      local.length ? `${names(local)}: remove with "claude mcp remove <name>" or from .mcp.json.` : '',
      remote.length ? `${names(remote)}: these are claude.ai connectors, turned off under Settings, Connectors on claude.ai (they load into Claude Code too).` : '',
    ].filter(Boolean).join(' ');
    out.push({ title: 'Turn off MCP servers you do not use.', body: `${idle.length} server${idle.length === 1 ? '' : 's'} had no calls in 30 days but load about ${Math.round(idleTokens / 100) / 10}K tokens into every new session. ${how}` });
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
