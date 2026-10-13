// Reads the plan's 5-hour and weekly percentages by running `claude -p /usage`.
//
// /usage is a local command: it makes no model call and spends no quota. Two
// things keep it that way:
//   1. The CLI is spawned with an argument array and no shell. Git Bash on
//      Windows rewrites a leading "/" into a path ("C:/Program Files/Git/usage"),
//      which turns the command into an ordinary prompt that costs quota.
//   2. The JSON result is checked for `local_command: "usage"` and zero turns.
//      Anything else is reported as an error and nothing is recorded.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pollDir, claudeProjectsDir } from '../paths.js';

function findClaude() {
  // On Windows the CLI is usually claude.exe (native installer) or claude.cmd (npm).
  // A .cmd file can only run through cmd.exe, so that is the fallback.
  return { cmd: process.env.QUOTAMETER_CLAUDE_BIN || 'claude', windowsCmdFallback: process.platform === 'win32' };
}

function run(cmd, args, { cwd, timeoutMs, useCmd }) {
  return new Promise((resolve) => {
    const env = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
    // With /s, cmd.exe strips the outer pair of quotes, so the whole line is
    // wrapped once more: ""C:\path\claude.cmd" "-p" "/usage"".
    const line = `"${[cmd, ...args].map((a) => `"${a}"`).join(' ')}"`;
    const child = useCmd
      ? spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd, env, windowsVerbatimArguments: true, windowsHide: true })
      : spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Fallback parser for the human-readable text, used only if the structured
// record cannot be found. Example lines:
//   Current session: 17% used · resets Oct 13, 5:39pm (UTC)
//   Current week (all models): 3% used · resets Oct 15, 2:59am (UTC)
export function parseUsageText(text, now = new Date()) {
  const rows = [];
  const re = /Current (session|week)([^:]*):\s*(\d+)%\s*used(?:[^\n]*?resets\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase() === 'session' ? 'session' : /all models/i.test(m[2]) || !m[2].trim() ? 'weekly_all' : `weekly_${m[2].replace(/[^a-z]+/gi, '_').replace(/^_|_$/g, '').toLowerCase()}`;
    let resetsAt = null;
    if (m[4]) {
      // The text gives local wall-clock time without a year; good enough as a fallback.
      let h = Number(m[6]) % 12;
      if (m[8].toLowerCase() === 'pm') h += 12;
      const d = new Date(now.getFullYear(), MONTHS[m[4].toLowerCase()], Number(m[5]), h, Number(m[7] || 0));
      if (d < now - 86400000) d.setFullYear(d.getFullYear() + 1);
      resetsAt = d.toISOString();
    }
    rows.push({ kind, group: kind === 'session' ? 'session' : 'weekly', percent: Number(m[3]), resetsAt, severity: null });
  }
  return rows;
}

// Look for the structured record the run wrote into its own session log.
function structuredFromLog(sessionId) {
  const root = claudeProjectsDir();
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('usageReport')) continue;
      try {
        const rec = JSON.parse(line);
        const limits = rec.usageReport?.rate_limits?.limits;
        if (Array.isArray(limits)) {
          return limits.filter((l) => typeof l.percent === 'number').map((l) => ({
            kind: l.kind,
            group: l.group || null,
            percent: l.percent,
            resetsAt: l.resets_at ? new Date(l.resets_at).toISOString() : null,
            severity: l.severity || null,
          }));
        }
      } catch {}
    }
  }
  return null;
}

// Run a built-in slash command headless. Returns the parsed JSON result, or an
// error if it did not run as a local command (which would have spent quota).
export async function runLocalCommand(name, { timeoutMs = 60000 } = {}) {
  const cwd = pollDir();
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); // inside the private store
  const { cmd, windowsCmdFallback } = findClaude();
  const args = ['-p', `/${name}`, '--output-format', 'json'];
  let res = await run(cmd, args, { cwd, timeoutMs, useCmd: false });
  if (res.error && windowsCmdFallback) res = await run(cmd, args, { cwd, timeoutMs, useCmd: true });
  if (res.error) return { ok: false, error: `could not run claude: ${res.error.message}` };
  let json;
  try {
    json = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    return { ok: false, error: `unexpected output from claude -p /${name}`, detail: (res.stdout + res.stderr).slice(0, 400) };
  }
  if (json.local_command !== name || json.num_turns > 0) {
    return { ok: false, error: `/${name} did not run as a local command`, spent: json.total_cost_usd || 0 };
  }
  return { ok: true, json };
}

export async function pollUsage(opts) {
  const res = await runLocalCommand('usage', opts);
  if (!res.ok) return res;
  const json = res.json;
  const ts = new Date().toISOString();
  const limits = structuredFromLog(json.session_id) || parseUsageText(String(json.result || ''));
  if (!limits.length) return { ok: false, error: 'no limits in /usage output (API-key accounts have none)' };
  return { ok: true, readings: limits.map((l) => ({ ts, source: 'usage-poll', ...l })), sessionId: json.session_id };
}

// Poll runs leave one small session log each. Remove the ones older than a day.
export function cleanupPollLogs(maxAgeMs = 86400000) {
  // Claude Code names a project folder by replacing each non-alphanumeric character with '-'.
  const slug = pollDir().replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(claudeProjectsDir(), slug);
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
  } catch {}
  return removed;
}
