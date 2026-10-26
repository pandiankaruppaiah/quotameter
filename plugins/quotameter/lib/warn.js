// The prompt hook: runs on every prompt, so it must be quick and quiet. It
// reads the newest limit reading per window from the tails of the reading
// files (no lock, no analysis) and warns once per window and level when a
// limit is close. It never reads the prompt itself.

import fs from 'node:fs';
import { FILES, storePath, writeJsonAtomic, PRIVATE } from './store.js';
import { dur, time, dayTime } from './report/format.js';

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
  writeJsonAtomic(storePath(WARNED), { keys: [...readWarned(), ...keys].slice(-20) });
}

// What the prompt hook should do: poll if the newest reading is stale, and
// warn if a limit is close. Pure apart from the warned.json bookkeeping.
export function promptHook(cfg, now = Date.now()) {
  const latest = latestReadings();
  const poll = pollIsDue(cfg, now, latest.newestTs);
  const w = warningFor(latest, cfg, now, readWarned());
  if (w) rememberWarned(w.keys);
  return { poll, message: w ? w.message : null };
}
