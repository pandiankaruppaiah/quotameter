// The prompt hook: runs on every prompt, so it must be quick and quiet. It
// reads the newest limit reading per window from the tails of the reading
// files (no lock, no analysis) and warns once per window and level when a
// limit is close. It never reads the prompt itself.

import fs from 'node:fs';
import { FILES, storePath, writeJsonAtomic, readK, PRIVATE } from './store.js';
import { dur, time, dayTime, fmt } from './report/format.js';
import { priceFor } from './model/pricing.js';

const KINDS = ['session', 'weekly_all'];
const TAIL = 64 * 1024;
const ATTEMPT = 'poll-attempt.stamp';

// Parse the last `TAIL` bytes of a JSONL file. The first line may be cut, so
// it is dropped unless the read started at the beginning of the file.
function tailRows(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const rows = [];
    for (const l of lines) {
      if (!l) continue;
      try {
        rows.push(JSON.parse(l));
      } catch {}
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

// Newest reading per window kind, across the status line's live files and
// the readings file: { session: row, weekly_all: row, newestTs }.
export function latestReadings() {
  const out = { newestTs: 0 };
  for (const kind of ['readings', 'livelog', 'live']) {
    for (const r of tailRows(storePath(FILES[kind]))) {
      if (r.percent == null || !KINDS.includes(r.kind)) continue;
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t)) continue;
      if (t > out.newestTs) out.newestTs = t;
      if (!out[r.kind] || t > Date.parse(out[r.kind].ts)) out[r.kind] = r;
    }
  }
  return out;
}

// The newest status line row with a session total: { session, cost, ctx, model, ts }.
export function latestTurn() {
  let best = null;
  for (const kind of ['livelog', 'live']) {
    for (const r of tailRows(storePath(FILES[kind]))) {
      if (!r.session || r.cost == null) continue;
      if (!best || Date.parse(r.ts) > Date.parse(best.ts)) best = r;
    }
  }
  return best;
}

// Once per session, when its context has grown past ctxNudgeAt tokens.
// The prompt hook does not know which session asked (it reads nothing), so
// it only trusts a row written in the last two minutes and says so in words.
export function contextNudge(turn, { ctxNudgeAt = 150000 } = {}, k = null, warned = [], now = Date.now()) {
  if (!(ctxNudgeAt > 0) || !turn?.ctx || turn.ctx < ctxNudgeAt) return null;
  if (now - Date.parse(turn.ts) > 120000) return null;
  const key = `ctx|${turn.session}`;
  if (warned.includes(key)) return null;
  // Every turn re-reads the whole context, nearly all of it from cache.
  const price = priceFor(turn.model || k?.model || 'claude-opus-5-5');
  const perTurn = price && k?.h5 ? (turn.ctx * price.cacheRead * k.h5) / 1e6 : null;
  const cost = perTurn != null ? `, about ${perTurn >= 1 ? perTurn.toFixed(1) : perTurn.toFixed(2)}% of the 5-hour window per turn` : '';
  return { key, message: `quotameter: the context of your most recently active session is ${fmt(turn.ctx)} tokens${cost}. /compact, or a fresh session for the next task, makes later turns cheaper.` };
}

// A window at 95% or past it: wake the user when it resets, once per window.
export function alarmFor(latest, { resetAlarm = true } = {}, now = Date.now(), warned = []) {
  if (!resetAlarm) return null;
  for (const kind of KINDS) {
    const r = latest[kind];
    const resets = r?.resetsAt ? Date.parse(r.resetsAt) : NaN;
    if (!r || !Number.isFinite(resets) || resets <= now) continue;
    if (!(r.percent >= 95 || ['exceeded', 'critical'].includes(r.severity))) continue;
    const key = `alarm|${kind}|${roundMinute(resets)}`;
    if (warned.includes(key)) continue;
    return { key, at: roundMinute(resets), kind: kind === 'session' ? '5-hour' : 'weekly' };
  }
  return null;
}

// When /usage was last tried, whether or not it worked. A poll that keeps
// failing (no `claude` on PATH, an API-key account, offline) must back off
// for pollIntervalMin like a successful one, not run on every prompt.
export function lastPollAttempt() {
  try {
    return fs.statSync(storePath(ATTEMPT)).mtimeMs;
  } catch {
    return 0;
  }
}

export function notePollAttempt() {
  fs.writeFileSync(storePath(ATTEMPT), '', PRIVATE);
}

export function pollIsDue(cfg, now = Date.now(), newestTs = latestReadings().newestTs) {
  return now - Math.max(newestTs, lastPollAttempt()) > (cfg.pollIntervalMin || 10) * 60000;
}

const roundMinute = (t) => Math.round(t / 60000) * 60000;

// Levels: the configured threshold and 95, unless the threshold is higher.
// Each fires once per window.
export function warningFor(latest, { warnAt = 80 } = {}, now = Date.now(), warned = []) {
  if (!(warnAt > 0)) return null;
  const levels = [...new Set([warnAt, 95])].filter((l) => l >= warnAt && l <= 100).sort((a, b) => a - b);
  const lines = [];
  const keys = [];
  for (const kind of KINDS) {
    const r = latest[kind];
    const resets = r?.resetsAt ? Date.parse(r.resetsAt) : NaN;
    if (!r || !Number.isFinite(resets) || resets <= now) continue;
    const level = levels.filter((l) => r.percent >= l).pop();
    if (level == null) continue;
    const key = `${kind}|${roundMinute(resets)}|${level}`;
    if (warned.includes(key)) continue;
    keys.push(key);
    const name = kind === 'session' ? '5-hour limit' : 'weekly limit';
    const when = kind === 'session' ? `${time(r.resetsAt)}` : dayTime(r.resetsAt);
    lines.push(`${name} at ${r.percent}%, resets in ${dur(resets - now)} (${when})`);
  }
  if (!lines.length) return null;
  return { message: `quotameter: ${lines.join('; ')}.`, keys };
}

// Quiet guidance for the assistant itself, on every prompt once a window is
// tight. Not shown to the user; the 80/95 warnings are.
// Said once per 5% band of each window, not on every prompt: each injection
// stays in the context for the rest of the session, so it must be rare.
export function adviceFor(latest, { adviseAt = 70 } = {}, now = Date.now(), warned = []) {
  if (!(adviseAt > 0)) return null;
  const h = latest.session, w = latest.weekly_all;
  const live = (r) => r?.resetsAt && Date.parse(r.resetsAt) > now;
  const tight5 = live(h) && h.percent >= adviseAt;
  const tightWk = live(w) && w.percent >= Math.min(100, adviseAt + 10);
  if (!tight5 && !tightWk) return null;
  const band = (r) => Math.floor(r.percent / 5) * 5;
  const key = `advice|${tight5 ? `session|${roundMinute(Date.parse(h.resetsAt))}|${band(h)}` : ''}|${tightWk ? `weekly|${roundMinute(Date.parse(w.resetsAt))}|${band(w)}` : ''}`;
  if (warned.includes(key)) return null;
  const parts = [];
  if (live(h)) parts.push(`5-hour limit at ${h.percent}% (resets in ${dur(Date.parse(h.resetsAt) - now)})`);
  if (live(w)) parts.push(`weekly at ${w.percent}%`);
  return { key, message: `quotameter: ${parts.join(', ')}. Quota is tight: prefer Sonnet or Haiku for routine steps and subagents, avoid re-reading large files, and keep output short.` };
}

const WARNED = 'warned.json';

export function readWarned() {
  try {
    const w = JSON.parse(fs.readFileSync(storePath(WARNED), 'utf8'));
    return Array.isArray(w.keys) ? w.keys : [];
  } catch {
    return [];
  }
}

export function rememberWarned(keys) {
  writeJsonAtomic(storePath(WARNED), { keys: [...readWarned(), ...keys].slice(-40) });
}

// What the prompt hook should do: poll if the newest reading is stale, and
// warn if a limit is close. Pure apart from the warned.json bookkeeping.
export function promptHook(cfg, now = Date.now()) {
  const latest = latestReadings();
  const poll = pollIsDue(cfg, now, latest.newestTs);
  const warned = readWarned();
  const k = readK();
  const w = warningFor(latest, cfg, now, warned);
  const nudge = contextNudge(latestTurn(), cfg, k, warned, now);
  const alarm = alarmFor(latest, cfg, now, warned);
  const advice = adviceFor(latest, cfg, now, warned);
  const keys = [...(w?.keys || []), ...(nudge ? [nudge.key] : []), ...(alarm ? [alarm.key] : []), ...(advice ? [advice.key] : [])];
  if (keys.length) rememberWarned(keys);
  const messages = [w?.message, nudge?.message].filter(Boolean);
  return { poll, message: messages.length ? messages.join(' ') : null, advice: advice?.message || null, alarm, latest };
}
