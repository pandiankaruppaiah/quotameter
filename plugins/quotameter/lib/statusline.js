// Status line command. Claude Code pipes session JSON on stdin each refresh.
// We print one short line and record the plan's percentages so quotameter has
// readings while a session is open. Never waits on the store lock.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { append, storePath, readK, PRIVATE } from './store.js';
import { loadConfig } from './config.js';
import { claudeConfigDir } from './paths.js';

function clock(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
}

// True at most once per `ms` for a given stamp file. The stamp's mtime is the clock.
function due(stamp, ms) {
  const p = storePath(stamp);
  try {
    if (Date.now() - fs.statSync(p).mtimeMs < ms) return false;
  } catch {}
  fs.writeFileSync(p, '', PRIVATE);
  return true;
}

// Context tokens as Claude Code counts them: input only, cache included.
function contextTokens(input) {
  const c = input.context_window;
  if (!c) return null;
  if (typeof c.total_input_tokens === 'number' && c.total_input_tokens > 0) return c.total_input_tokens;
  const u = c.current_usage;
  if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return null;
}

// Readings at most once a minute; the session's running cost and context
// every 15 seconds, so a short session still leaves a total behind.
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
    append('live', [{ ts: now, source: 'statusline', session: input.session_id, cost, ctx: contextTokens(input), model: input.model?.id || null }]);
  }
}

// `5h 41% (this session 14%, resets 2:50am) | ctx 62% | wk 18%`. The session
// share uses the 5-hour k the last analysis wrote; before that, dollars.
export function statusText(input, k = null) {
  input = input && typeof input === 'object' ? input : {};
  const rl = input.rate_limits || {};
  const parts = [];
  const h = rl.five_hour;
  const w = rl.seven_day;
  const cost = input.cost?.total_cost_usd;
  const session = typeof cost === 'number' && cost > 0 ? (k?.h5 ? `this session ${(cost * k.h5).toFixed(cost * k.h5 >= 10 ? 0 : 1)}%` : `this session $${cost.toFixed(2)}`) : '';
  if (typeof h?.used_percentage === 'number') {
    const inside = [session, h.resets_at ? `resets ${clock(h.resets_at)}` : ''].filter(Boolean).join(', ');
    parts.push(`5h ${Math.round(h.used_percentage)}%${inside ? ` (${inside})` : ''}`);
  }
  const ctx = input.context_window?.used_percentage;
  if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);
  if (typeof w?.used_percentage === 'number') parts.push(`wk ${Math.round(w.used_percentage)}%`);
  // Before the first response Claude Code sends no limits yet.
  return parts.length ? parts.join(' | ') : '5h -- | wk --';
}

// The user's own status line command, run the way Claude Code would run it:
// through a shell, with the same JSON on stdin. A command that hangs is cut
// off after 3 seconds; one that never reads stdin must not take us down.
function runWrapped(cmd, raw, timeoutMs = 3000) {
  return new Promise((resolve) => {
    // Its own process group on POSIX, so a timeout can kill the shell and
    // whatever it started; on Windows taskkill /t does the same.
    const child = spawn(cmd, { shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    let out = '';
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(text);
    };
    const killTree = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      killTree();
      finish(out.trim());
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => finish(''));
    child.on('close', () => finish(out.trim()));
    child.stdin.on('error', () => {}); // EPIPE when the command exits without reading
    child.stdin.end(raw);
  });
}

// The command `quotameter setup` kept for this Claude Code profile.
export function wrappedCommand(cfg = loadConfig()) {
  // Keyed the way setup.js stores it: the resolved config folder.
  return cfg.wrapCommands?.[path.resolve(claudeConfigDir())] || cfg.wrapCommand || null;
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
    if (!input || typeof input !== 'object') input = {};
  } catch {}
  try {
    record(input);
  } catch {}
  let k = null;
  try {
    k = readK();
  } catch {}
  const ours = statusText(input, k);
  // `quotameter setup` keeps a wrapped command in config.json rather than on
  // the command line, so nothing needs quoting inside settings.json.
  let wrapped = wrap;
  if (!wrapped) {
    try {
      wrapped = wrappedCommand();
    } catch {}
  }
  const theirs = wrapped ? await runWrapped(wrapped, raw) : '';
  process.stdout.write(theirs ? `${theirs} | ${ours}` : ours);
}
