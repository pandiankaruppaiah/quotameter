#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingest } from '../lib/ingest/index.js';
import { runLocalCommand, pollUsage } from '../lib/ingest/usage-poll.js';
import { analyze } from '../lib/model/analyze.js';
import { renderHtml, renderText } from '../lib/report/render.js';
import { statusline } from '../lib/statusline.js';
import { loadConfig, saveConfig, DEFAULTS } from '../lib/config.js';
import { quotameterHome, claudeProjectsDir, desktopDataDirs } from '../lib/paths.js';
import { readAll, withLock, drainLive, PRIVATE } from '../lib/store.js';
import { redact } from '../lib/model/redact.js';
import { compact, MIN_KEEP_DAYS } from '../lib/model/retention.js';

const self = fileURLToPath(import.meta.url);
const [cmd = 'report', ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const HELP = `quotameter: see where your Claude Pro/Max quota goes.

Usage: quotameter <command> [options]

  report            Build the HTML report and open it (default)
      --text          Print a short summary instead
      --json          Print the summary as JSON
      --out <file>    Write the HTML somewhere else (must end in .html)
      --share         Hide project names, branches and session titles,
                      for screenshots (writes report-share.html)
      --findings <f>  Add Claude's findings (JSON array of strings) to the report
      --no-open       Do not open a browser
  ingest            Read new log data (used by the plugin hooks)
      --no-poll       Do not run /usage even if the last reading is old
  poll              Read the 5-hour and weekly % now (free, no model call)
  context           Snapshot per-session overhead from /context (free)
  statusline        Status line command for Claude Code settings
      --wrap "<cmd>"  Run your existing status line and append ours
  compact           Summarise and remove raw rows older than keepDays now
  config [key val]  Show or change settings: plan (pro|max5|max20),
                    redactPaths (true|false), pollIntervalMin (number),
                    keepDays (days of raw data to keep, at least ${MIN_KEEP_DAYS})
  doctor            Check what quotameter can see on this machine

Data lives in ${quotameterHome()}. Nothing leaves your machine.`;

function openFile(rel) {
  const file = path.resolve(rel); // explorer.exe does not resolve relative paths

  // explorer.exe opens the file with its default app without a shell, so
  // characters such as & in the path cannot run commands.
  const [c, a] = process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(c, a, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Hooks must return quickly. Re-launch ourselves detached and exit.
function detached(...argv) {
  spawn(process.execPath, [self, ...argv], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  switch (cmd) {
    case 'hook': {
      // We only need to know the hook fired, so stdin is not read.
      detached('ingest', ...(args[0] === 'stop' ? ['--no-poll'] : []));
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
    case 'report': {
      await ingest({ poll: 'auto' });
      const overhead = readAll('overhead');
      const lastSnap = overhead.length ? Date.parse(overhead[overhead.length - 1].ts) : 0;
      if (Date.now() - lastSnap > 86400000) {
        await runLocalCommand('context');
        await ingest({ poll: false });
      }
      const summary = analyze();
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
