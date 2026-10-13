// Builds synthetic Claude Code session logs in a temp folder. The record shapes
// mirror real logs (checked against Claude Code 2.1.296); every text field is fake.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotameter-test-'));
  process.env.QUOTAMETER_HOME = path.join(dir, 'store');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.QUOTAMETER_DESKTOP_DIR = ''; // never read the real Desktop app
  fs.mkdirSync(path.join(dir, 'claude', 'projects'), { recursive: true });
  return dir;
}

export const SECRET = 'SECRET-PROMPT-TEXT-SHOULD-NEVER-BE-STORED';

export function usage({ input = 2, output = 100, cw5 = 0, cw1h = 0, read = 0, speed = 'standard' } = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cw5 + cw1h,
    cache_read_input_tokens: read,
    output_tokens: output,
    cache_creation: { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: cw1h },
    service_tier: 'standard',
    speed,
  };
}

export function assistant({ id, ts, session = 's1', model = 'claude-opus-5-5', u = usage(), stop = 'end_turn', blocks = [{ type: 'text', text: SECRET }], extra = {} }) {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: session,
    entrypoint: 'cli',
    cwd: '/home/dev/projects/invoice-app',
    gitBranch: 'feat/webhooks',
    isSidechain: false,
    requestId: `req_${id}`,
    message: { id, model, role: 'assistant', stop_reason: stop, content: blocks, usage: u },
    ...extra,
  };
}

export function usageRecord({ ts, session = 'poll', fivePct, weekPct, fiveReset, weekReset }) {
  return {
    type: 'system',
    subtype: 'local_command',
    timestamp: ts,
    sessionId: session,
    usageReport: {
      rate_limits: {
        limits: [
          { kind: 'session', group: 'session', percent: fivePct, resets_at: fiveReset, severity: 'normal' },
          { kind: 'weekly_all', group: 'weekly', percent: weekPct, resets_at: weekReset, severity: 'normal' },
        ],
      },
    },
  };
}

export function writeLog(home, project, file, records) {
  const dir = path.join(home, 'claude', 'projects', project);
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
