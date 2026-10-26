#!/usr/bin/env node
// The plugin's hooks. A separate entry point from quotameter.js so that a
// hook (the file guard runs on every Read) loads only the few modules it
// needs, and returns in well under a second.
//
// start, stop, end: record where the plugin lives, then ingest in the
//   background. start also prints the last session's receipt.
// prompt: poll when readings are stale, warn near a limit, advise the
//   assistant once per 5% band, start the reset alarm. Never reads stdin.
// pretool: the file guard. Reads the Read call's file path, stores nothing.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { readK } from '../lib/store.js';
import { refreshLauncher } from '../lib/setup.js';
import { promptHook } from '../lib/warn.js';
import { guardDecision } from '../lib/guard.js';
import { startMessages } from '../lib/digest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'quotameter.js');
const pluginRoot = path.resolve(here, '..');
const [event = ''] = process.argv.slice(2);

// Hooks must return quickly: anything slow runs detached.
function detached(...argv) {
  spawn(process.execPath, [cli, ...argv], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Only the session start hook (event type, resume cache fields) and the
// file guard (the Read call's file path) look at stdin. Nothing is stored.
function input() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

// Session events record where the plugin lives; a Read must not pay for that.
if (!['prompt', 'pretool'].includes(event)) {
  try {
    refreshLauncher(pluginRoot);
  } catch {}
}

switch (event) {
  case 'prompt': {
    const r = promptHook(loadConfig());
    if (r.poll) detached('ingest', '--quiet');
    if (r.alarm) detached('alarm', new Date(r.alarm.at).toISOString(), '--window', r.alarm.kind);
    // systemMessage is shown to the user; additionalContext goes to the
    // assistant only, so it can go easy on quota by itself. Warnings stay
    // out of the context: they are for the person, and context is not free.
    const out = {};
    if (r.message) out.systemMessage = r.message;
    if (r.advice) out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: r.advice };
    if (Object.keys(out).length) console.log(JSON.stringify(out));
    break;
  }
  case 'pretool': {
    const d = guardDecision(input(), loadConfig(), readK());
    if (d) console.log(JSON.stringify(d));
    break;
  }
  case 'start': {
    const i = input();
    detached('ingest', '--quiet');
    let lines = [];
    try {
      lines = startMessages(i);
    } catch {}
    if (lines.length) console.log(JSON.stringify({ systemMessage: lines.join(' ') }));
    break;
  }
  case 'stop':
    detached('ingest', '--quiet', '--no-poll');
    break;
  default:
    detached('ingest', '--quiet');
}
