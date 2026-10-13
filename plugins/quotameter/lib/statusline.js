// Status line command. Claude Code pipes session JSON on stdin each refresh.
// We print one short line and record the plan's percentages so quotameter has
// readings while a session is open. Never waits on the store lock.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { append, storePath } from './store.js';

function clock(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
}

// True at most once per `ms` for a given stamp file. The stamp's mtime is the clock.
function due(stamp, ms) {
  const p = storePath(stamp);
  try {
    if (Date.now() - fs.statSync(p).mtimeMs < ms) return false;
  } catch {}
  fs.writeFileSync(p, '');
  return true;
}

// Readings at most once a minute; the session's running cost every 15 seconds,
// so a short session still leaves a total behind.
function record(input) {
  const rl = input.rate_limits || {};
  const now = new Date().toISOString();
  const rows = [];
  for (const [key, kind, group] of [['five_hour', 'session', 'session'], ['seven_day', 'weekly_all', 'weekly']]) {
    const w = rl[key];
    if (w && typeof w.used_percentage === 'number') {
      rows.push({ ts: now, source: 'statusline', kind, group, percent: Math.round(w.used_percentage), resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null });
    }
  }
  if (rows.length && due('live-reading.stamp', 60000)) append('live', rows);
  const cost = input.cost?.total_cost_usd;
  if (input.session_id && typeof cost === 'number' && due('live-cost.stamp', 15000)) {
    append('live', [{ ts: now, source: 'statusline', session: input.session_id, cost }]);
  }
}

export function statusText(input) {
  const rl = input.rate_limits || {};
  const parts = [];
  const h = rl.five_hour;
  const w = rl.seven_day;
  if (typeof h?.used_percentage === 'number') parts.push(`5h ${Math.round(h.used_percentage)}%${h.resets_at ? ` (resets ${clock(h.resets_at)})` : ''}`);
  if (typeof w?.used_percentage === 'number') parts.push(`wk ${Math.round(w.used_percentage)}%`);
  return parts.length ? parts.join(' | ') : 'quotameter: waiting for first response';
}

function runWrapped(cmd, raw) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
    child.stdin.end(raw);
  });
}

export async function statusline({ wrap } = {}) {
  if (process.stdin.isTTY) {
    process.stdout.write('quotameter statusline reads Claude Code status JSON on stdin. Set it up with /quotameter:setup.\n');
    return;
  }
  const raw = fs.readFileSync(0, 'utf8');
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  try {
    record(input);
  } catch {}
  const ours = statusText(input);
  const theirs = wrap ? await runWrapped(wrap, raw) : '';
  process.stdout.write(theirs ? `${theirs} | ${ours}` : ours);
}
