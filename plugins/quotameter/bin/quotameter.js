#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingest } from '../lib/ingest/index.js';
import { runLocalCommand, pollUsage } from '../lib/ingest/usage-poll.js';
import { analyze } from '../lib/model/analyze.js';
import { roundMinute } from '../lib/model/load.js';
import { renderHtml, renderText } from '../lib/report/render.js';
import { statusline } from '../lib/statusline.js';
import { loadConfig, saveConfig, DEFAULTS } from '../lib/config.js';
import { quotameterHome, claudeProjectsDir, desktopDataDirs } from '../lib/paths.js';
import { readAll, withLock, drainLive, PRIVATE } from '../lib/store.js';
import { redact } from '../lib/model/redact.js';
import { compact, MIN_KEEP_DAYS } from '../lib/model/retention.js';
import { setup, describe, refreshLauncher } from '../lib/setup.js';
import { promptHook, latestReadings } from '../lib/warn.js';

const self = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(self), '..');
const [cmd = 'report', ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const HELP = `quotameter: see where your Claude Pro/Max quota goes.

Usage: quotameter <command> [options]

  status            Both limits, the split, sessions left: a few lines, no browser
      --no-poll       Do not run /usage even if the last reading is old
  report            Build the HTML report and open it (default)
      --text          Print the short summary instead
      --json          Print the summary as JSON
      --out <file>    Write the HTML somewhere else (must end in .html)
      --share         Hide project names, branches and session titles,
                      for screenshots (writes report-share.html)
      --findings <f>  Add Claude's findings (JSON array of strings) to the report
      --no-open       Do not open a browser
  setup             Put the status line into Claude Code's settings.json
      --dry-run       Show what would change and stop
      --remove        Take it out again and restore what was there
  poll              Read the 5-hour and weekly % now (free, no model call)
  mark code-only    Say this 5-hour window had no chat, to sharpen the chat estimate
      --week          The weekly window instead
      --undo          Remove the mark
  context           Snapshot per-session overhead from /context (free)
  compact           Summarise and remove raw rows older than keepDays now
  config [key val]  Show or change settings: plan (pro|max5|max20),
                    warnAt (percent, 0 to turn warnings off), pollIntervalMin,
                    redactPaths (true|false), keepDays (at least ${MIN_KEEP_DAYS})
  doctor            Check what quotameter can see on this machine
  ingest            Read new log data (used by the plugin hooks)
  statusline        Status line command (installed for you by setup)

Data lives in ${quotameterHome()}. Nothing leaves your machine.`;

const isWsl = () => {
  try {
    return process.platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
};

function openFile(rel) {
  const file = path.resolve(rel); // explorer.exe does not resolve relative paths
  let c, a;
  if (process.platform === 'win32') {
    // explorer.exe opens the file with its default app without a shell, so
    // characters such as & in the path cannot run commands.
    [c, a] = ['explorer.exe', [file]];
  } else if (process.platform === 'darwin') {
    [c, a] = ['open', [file]];
  } else if (isWsl()) {
    // xdg-open has nothing to open on WSL; wslview (from wslu) hands the file to Windows.
    if (spawnSync('which', ['wslview'], { stdio: 'ignore' }).status !== 0) {
      console.log('Open the report from Windows (WSL has no browser of its own).');
      return;
    }
    [c, a] = ['wslview', [file]];
  } else {
    [c, a] = ['xdg-open', [file]];
  }
  spawn(c, a, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Hooks must return quickly. Re-launch ourselves detached and exit.
function detached(...argv) {
  spawn(process.execPath, [self, ...argv], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Both `status` and `report` build the summary the same way; `report` also
// refreshes the /context snapshot once a day.
async function buildSummary({ poll, context = false } = {}) {
  const r = await ingest({ poll });
  if (context) {
    const overhead = readAll('overhead');
    const lastSnap = overhead.length ? Date.parse(overhead[overhead.length - 1].ts) : 0;
    if (Date.now() - lastSnap > 86400000) {
      await runLocalCommand('context');
      await ingest({ poll: false });
    }
  }
  const pollError = r?.poll && !['ok', 'skipped'].includes(r.poll) ? r.poll : null;
  return analyze({ pollError });
}

async function main() {
  switch (cmd) {
    case 'hook': {
      // We only need to know the hook fired, so stdin is not read, not even
      // for the prompt hook: the prompt text never reaches quotameter.
      try {
        refreshLauncher(pluginRoot);
      } catch {}
      if (args[0] === 'prompt') {
        const r = promptHook(loadConfig());
        if (r.poll) detached('ingest', '--quiet');
        // Claude Code shows systemMessage to the user; additionalContext lets
        // the assistant know too, so it can suggest a lighter model itself.
        if (r.message) console.log(JSON.stringify({ systemMessage: r.message, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.message } }));
        return;
      }
      detached('ingest', '--quiet', ...(args[0] === 'stop' ? ['--no-poll'] : []));
      return;
    }
    case 'ingest': {
      const r = await ingest({ poll: flag('no-poll') ? false : 'auto' });
      if (!flag('quiet')) console.log(JSON.stringify(r));
      return;
    }
    case 'poll': {
      const r = await ingest({ poll: true });
      console.log(r?.poll === 'ok' ? 'Recorded the current 5-hour and weekly percentages.' : `Poll failed: ${r?.poll}`);
      return;
    }
    case 'context': {
      const r = await runLocalCommand('context');
      if (!r.ok) return console.log(`Snapshot failed: ${r.error}`);
      await ingest({ poll: false });
      console.log('Recorded a /context overhead snapshot.');
      return;
    }
    case 'statusline':
      return statusline({ wrap: opt('wrap') });
    case 'setup': {
      const plan = setup(pluginRoot, { dryRun: flag('dry-run'), remove: flag('remove') });
      for (const l of describe(plan)) console.log(l);
      if (flag('dry-run') && plan.changed) console.log('\nNothing changed. Run "quotameter setup" to apply.');
      else if (plan.changed) console.log(flag('remove') ? '\nDone. Restart Claude Code to see the change.' : '\nDone. The status line appears after the next response in Claude Code.');
      return;
    }
    case 'status': {
      const summary = await buildSummary({ poll: flag('no-poll') ? false : 'auto' });
      console.log(renderText(summary));
      return;
    }
    case 'report': {
      const summary = await buildSummary({ poll: 'auto', context: true });
      const findingsFile = opt('findings');
      if (findingsFile) {
        try {
          summary.findings = JSON.parse(fs.readFileSync(findingsFile, 'utf8')).filter((x) => typeof x === 'string').slice(0, 10);
        } catch (e) {
          console.error(`Could not read findings: ${e.message}`);
        }
      }
      // summary.json is what the optional Haiku summary reads: no session
      // titles or branch names in it.
      fs.writeFileSync(path.join(quotameterHome(), 'summary.json'), JSON.stringify(redact(summary), null, 2), PRIVATE);
      const share = flag('share');
      const shown = share ? redact(summary, { share: true }) : summary;
      if (flag('json')) return console.log(JSON.stringify(shown, null, 2));
      if (flag('text')) return console.log(renderText(shown));
      const out = opt('out') || path.join(quotameterHome(), share ? 'report-share.html' : 'report.html');
      if (!/\.html?$/i.test(out)) {
        console.error('--out must be an .html file.');
        process.exitCode = 1;
        return;
      }
      fs.writeFileSync(out, renderHtml(shown), PRIVATE);
      console.log(renderText(shown));
      console.log(`\nReport: ${out}`);
      if (!flag('no-open')) openFile(out);
      return;
    }
    case 'mark': {
      if (args[0] !== 'code-only') return console.log('Usage: quotameter mark code-only [--week] [--undo]');
      const kind = flag('week') ? 'weekly_all' : 'session';
      const name = kind === 'session' ? '5-hour' : 'weekly';
      const r = latestReadings()[kind];
      const resets = r?.resetsAt ? Date.parse(r.resetsAt) : NaN;
      if (!Number.isFinite(resets) || resets <= Date.now()) return console.log(`No reading for the current ${name} window yet. Run quotameter poll first.`);
      const key = roundMinute(resets);
      const cfg = loadConfig();
      const marks = (cfg.codeOnlyWindows || []).filter((x) => x !== key);
      if (!flag('undo')) marks.push(key);
      cfg.codeOnlyWindows = marks.slice(-50);
      saveConfig(cfg);
      console.log(flag('undo')
        ? `Unmarked the ${name} window that resets ${new Date(resets).toLocaleString()}.`
        : `Marked the ${name} window that resets ${new Date(resets).toLocaleString()} as Claude Code only. Calibration trusts it fully from the next report.`);
      return;
    }
    case 'compact': {
      const r = await withLock(() => {
        drainLive();
        return compact({ force: true });
      });
      if (r?.skipped === true) return console.log('Another quotameter process holds the store. Try again in a moment.');
      const day = r.cutoff.slice(0, 10);
      console.log(r.sessions != null ? `Summarised ${r.sessions} session(s) over ${r.days} day(s) and ${r.windows} limit window(s) older than ${day}.` : `Nothing older than ${day} to summarise.`);
      return;
    }
    case 'config': {
      const cfg = loadConfig();
      if (!args.length) return console.log(JSON.stringify(cfg, null, 2));
      const [key, raw] = args;
      if (!(key in DEFAULTS) && key !== 'plan') return console.log(`Unknown setting: ${key}`);
      // One argument shows that setting; it never clears it.
      if (raw === undefined) return console.log(`${key} = ${JSON.stringify(cfg[key] ?? 'pro')}`);
      cfg[key] = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
      if (key === 'keepDays' && !(cfg.keepDays >= MIN_KEEP_DAYS)) return console.log(`keepDays must be a number of days, at least ${MIN_KEEP_DAYS}.`);
      if (key === 'warnAt' && !(typeof cfg.warnAt === 'number' && cfg.warnAt >= 0 && cfg.warnAt <= 100)) return console.log('warnAt must be a percentage from 0 (off) to 100.');
      saveConfig(cfg);
      return console.log(`${key} = ${JSON.stringify(cfg[key])}`);
    }
    case 'doctor': {
      const ok = (b, msg) => console.log(`${b ? 'ok  ' : 'no  '} ${msg}`);
      ok(fs.existsSync(claudeProjectsDir()), `Claude Code logs: ${claudeProjectsDir()}`);
      const d = desktopDataDirs();
      ok(d.length, `Claude Desktop data: ${d[0] || 'not found'}`);
      const p = await pollUsage();
      ok(p.ok, p.ok ? `/usage works: ${p.readings.map((r) => `${r.kind} ${r.percent}%`).join(', ')}` : `/usage: ${p.error}`);
      const latest = latestReadings();
      ok(latest.newestTs > 0, latest.newestTs ? `Newest limit reading: ${new Date(latest.newestTs).toLocaleString()}` : 'No limit readings stored yet');
      const { settingsFile, isOurs } = await import('../lib/setup.js');
      let sl = null;
      try {
        sl = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).statusLine?.command;
      } catch {}
      ok(isOurs(sl), isOurs(sl) ? 'Status line: set up (records a reading every minute while you work)' : 'Status line: not set up. Run /quotameter:setup or "quotameter setup".');
      ok(true, `Store: ${quotameterHome()}`);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      return console.log(HELP);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`quotameter: ${e.message}`);
  process.exitCode = 1;
});
