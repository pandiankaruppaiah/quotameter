// Limit windows: building them from readings, calibrating points per dollar,
// attributing each window to Code and chat, and forecasting the current one.

import { HOUR, DAY, sum, round, percentile } from './util.js';
import { roundMinute } from './load.js';

const WINDOW_MS = { session: 5 * HOUR, weekly_all: 7 * DAY };

export function buildWindows(readings, kind) {
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

export function makeCostIndex(messages) {
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

export function calibrate(wins, costIn, activity, codeOnly, minPct) {
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
  return { k, windows: samples.length, cleanWindows: clean.length, marked: samples.filter((s) => s.marked).length, provisional: samples.length < 5 };
}

export function attribute(w, costIn, k, messages) {
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

export function forecast(w, now, kind) {
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
