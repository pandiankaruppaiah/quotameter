import { append, readAll, readState, writeState, withLock, tryLease, drainLive } from '../store.js';
import { compact } from '../model/retention.js';
import { loadConfig } from '../config.js';
import { scanAll } from './logs.js';
import { readDesktopHistory, readDesktopActivity } from './desktop.js';
import { pollUsage, cleanupPollLogs } from './usage-poll.js';
import { pollIsDue, notePollAttempt } from '../warn.js';
import { exportSync } from '../sync.js';
import { readK } from '../store.js';

export function newestReadingTs() {
  let last = 0;
  for (const kind of ['readings', 'livelog', 'live']) {
    for (const r of readAll(kind)) {
      const t = Date.parse(r.ts);
      if (r.percent != null && t > last) last = t;
    }
  }
  return last;
}

// Pull everything new into the store.
// poll: 'auto' runs `claude -p /usage` only when the newest reading is older
// than the configured interval; true forces it; false never polls.
// The poll runs outside the lock because it can take several seconds.
// Hooks never analyse, so the background ingest keeps k.json fresh for them.
async function refreshK() {
  const k = readK();
  if (k && Date.now() - Date.parse(k.ts) < 30 * 60000) return;
  const { analyze, saveK } = await import('../model/analyze.js');
  saveK(analyze());
}

export async function ingest({ poll = 'auto', only, refresh = true } = {}) {
  const cfg = loadConfig();
  let pollResult = null;
  // Stale means no reading and no attempt for pollIntervalMin, so a poll
  // that keeps failing backs off instead of running on every prompt.
  if (poll === true || (poll === 'auto' && pollIsDue(cfg, Date.now(), newestReadingTs()))) {
    // Several hooks can fire together; only one of them runs the poll.
    const release = tryLease('poll', 120000);
    if (release) {
      try {
        notePollAttempt();
        pollResult = await pollUsage();
      } finally {
        release();
      }
    }
  }

  const result = await withLock(async () => {
    const state = readState();
    const scan = scanAll(state, { only, redactPaths: cfg.redactPaths });
    const readings = [...scan.readings, ...readDesktopHistory(state)];
    if (pollResult?.ok) readings.push(...pollResult.readings);
    if (pollResult && (!state.lastCleanup || Date.now() - state.lastCleanup > 3600000)) {
      cleanupPollLogs();
      state.lastCleanup = Date.now();
    }

    // A rescan of old logs must not bring back sessions retention summarised.
    const fresh = (r) => !state.archived?.[r.session];
    append('messages', scan.messages.filter(fresh));
    append('readings', readings);
    append('sessions', scan.sessions.filter(fresh));
    append('costs', scan.costs.filter(fresh));
    append('overhead', scan.overhead);
    append('activity', readDesktopActivity(state));
    drainLive();
    writeState(state);
    if (cfg.syncDir) {
      try {
        exportSync(cfg, state);
      } catch {}
    }
    // Summarise and prune old rows at most once a day.
    const compacted = !state.lastCompact || Date.now() - state.lastCompact > 86400000 ? compact() : null;
    return {
      scanned: scan.scanned,
      messages: scan.messages.length,
      readings: readings.length,
      poll: pollResult ? (pollResult.ok ? 'ok' : pollResult.error) : 'skipped',
      ...(compacted && !compacted.skipped ? { compacted } : {}),
    };
  });
  // Reads outside the lock are fine: readAll skips a line cut mid-write.
  // A busy lock still gets k.json written when it is missing altogether.
  if (refresh && (!result?.skipped || !readK())) {
    try {
      await refreshK();
    } catch {}
  }
  return result;
}
