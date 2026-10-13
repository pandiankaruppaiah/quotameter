import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { quotameterHome } from './paths.js';

export const FILES = {
  messages: 'messages.jsonl',
  readings: 'readings.jsonl',
  sessions: 'sessions.jsonl',
  costs: 'costs.jsonl',
  overhead: 'overhead.jsonl',
  activity: 'activity.jsonl',
  // Written only by the status line, without the lock: one short line per
  // append, so it never waits on a running ingest.
  live: 'live.jsonl',
  // Status line rows moved here under the lock, so retention can prune them.
  livelog: 'livelog.jsonl',
  // Summaries that outlive the raw rows (see model/retention.js).
  daily: 'daily.jsonl',
  windows: 'windows.jsonl',
  state: 'state.json',
};

export function storePath(name) {
  const dir = quotameterHome();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

export function append(kind, rows) {
  if (!rows.length) return;
  fs.appendFileSync(storePath(FILES[kind]), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function readAll(kind) {
  let text;
  try {
    text = fs.readFileSync(storePath(FILES[kind]), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash; skip it.
    }
  }
  return rows;
}

export function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(storePath(FILES.state), 'utf8'));
    s.files ||= {};
    return s;
  } catch {
    return { files: {} };
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// On Windows a rename fails with EPERM or EBUSY while another process has
// the target open, so retry briefly. Throws after about 5 seconds.
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || i >= 20) throw err;
      sleepSync(25 * (i + 1));
    }
  }
}

// Write to a temp file and rename it into place.
function replaceAtomic(target, text) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    renameRetry(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(target, value) {
  replaceAtomic(target, JSON.stringify(value));
}

// Replace a JSONL file with the given rows. Call only under withLock, and
// never for live.jsonl, which the status line appends to without the lock.
export function rewrite(kind, rows) {
  if (kind === 'live') throw new Error('live.jsonl is drained, never rewritten');
  replaceAtomic(storePath(FILES[kind]), rows.map((r) => JSON.stringify(r) + '\n').join(''));
}

// Move status line rows into livelog.jsonl. Renaming live.jsonl away is
// atomic; a status line that writes a moment later starts a fresh file.
// If the rename fails (the file is open right now), try again next ingest.
export function drainLive() {
  const live = storePath(FILES.live);
  try {
    renameRetry(live, `${live}.drain-${process.pid}-${Date.now()}`);
  } catch {
    // No live.jsonl yet, or still locked after retries: next ingest.
  }
  // Includes drains a crashed process left behind.
  const dir = path.dirname(live);
  let n = 0;
  for (const name of fs.readdirSync(dir).filter((f) => f.startsWith(`${FILES.live}.drain-`)).sort()) {
    const drain = path.join(dir, name);
    const text = fs.readFileSync(drain, 'utf8');
    fs.appendFileSync(storePath(FILES.livelog), text && !text.endsWith('\n') ? text + '\n' : text);
    fs.rmSync(drain, { force: true });
    n += text.split('\n').filter(Boolean).length;
  }
  return n;
}

export function writeState(state) {
  writeJsonAtomic(storePath(FILES.state), state);
}

// Several Claude Code sessions can fire hooks at once. Creating a directory is
// atomic on every platform, so it works as a cross-process lock. The owner file
// inside lets us release only our own lock and recover from a crashed holder.
export async function withLock(fn, { waitMs = 10000, staleMs = 60000 } = {}) {
  const lock = storePath('lock');
  const owner = path.join(lock, 'owner');
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(owner, token);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isStale(lock, staleMs)) {
        // Rename before deleting: only one process can win the rename, so two
        // processes cannot both clear the lock and then both take it.
        const grave = `${lock}.stale-${token}`;
        try {
          fs.renameSync(lock, grave);
          fs.rmSync(grave, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() - start > waitMs) return { skipped: true };
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(owner, 'utf8') === token) fs.rmSync(lock, { recursive: true, force: true });
    } catch {}
  }
}

// A non-blocking lease for slow work that must not run twice at once (the
// /usage poll). Returns a release function, or null if someone else holds it.
export function tryLease(name, ttlMs) {
  const p = storePath(`${name}.lease`);
  try {
    fs.mkdirSync(p);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < ttlMs) return null;
      const grave = `${p}.stale-${process.pid}-${Date.now()}`;
      fs.renameSync(p, grave);
      fs.rmSync(grave, { recursive: true, force: true });
      fs.mkdirSync(p);
    } catch {
      return null;
    }
  }
  return () => fs.rmSync(p, { recursive: true, force: true });
}

function isStale(lock, staleMs) {
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs > staleMs) return true;
    const pid = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8').split('-')[0]);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        return e.code === 'ESRCH'; // Holder process is gone.
      }
    }
  } catch {}
  return false;
}
