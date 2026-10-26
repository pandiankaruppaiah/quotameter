// `quotameter setup`: puts the status line into Claude Code's settings.json
// without anyone hand-editing JSON.
//
// The command installed is a small launcher in ~/.quotameter, not the plugin
// path. Claude Code installs each plugin version in a new cache folder, so a
// command that pointed at the plugin folder would break at the next update.
// The launcher reads launcher.json for the current plugin root; every hook
// run refreshes that file, so an update heals itself at the next session.

import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDir } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { storePath, writeJsonAtomic, renameRetry, PRIVATE } from './store.js';

export const LAUNCHER = 'statusline.mjs';
const BACKUP = 'settings.json.quotameter.bak';

// Roots are keyed by Claude Code config folder, so profiles that use
// CLAUDE_CONFIG_DIR with different plugin installs do not fight over one entry.
// The launcher only imports a folder whose package.json names the plugin.
const LAUNCHER_SRC = `// quotameter status line launcher, written by "quotameter setup".
// Finds the installed plugin through launcher.json next to this file, which
// the plugin's hooks keep current across updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const cfgDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
let root = null;
try {
  const roots = JSON.parse(fs.readFileSync(path.join(here, 'launcher.json'), 'utf8')).roots || {};
  const all = Object.values(roots);
  // The profile's own root; with a single root recorded, that one.
  root = roots[cfgDir] || (all.length === 1 ? all[0] : null);
} catch {}
// Only an absolute folder, owned by this user where the platform says who
// owns files, whose package.json names this plugin.
const trusted = (r) => {
  try {
    if (!path.isAbsolute(r)) return false;
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && fs.statSync(r).uid !== process.getuid()) return false;
    return JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf8')).name === 'quotameter-plugin';
  } catch { return false; }
};
const mod = root && trusted(root) ? path.join(root, 'lib', 'statusline.js') : null;
if (!mod || !fs.existsSync(mod)) {
  process.stdout.write('quotameter: plugin not found, run /quotameter:setup');
} else {
  const { statusline } = await import(pathToFileURL(mod).href);
  await statusline();
}
`;

export const settingsFile = () => path.join(claudeConfigDir(), 'settings.json');
// The key for this profile in launcher.json and config.json, in one spelling.
export const profileKey = () => path.resolve(claudeConfigDir());
export const launcherPath = () => storePath(LAUNCHER);
// Forward slashes so the same JSON works on every platform.
export const launcherCommand = () => `node "${launcherPath().replace(/\\/g, '/')}"`;

// Record where the plugin lives and make sure the launcher is current.
// Called by every hook run, so it only writes when something changed.
export function refreshLauncher(root) {
  const meta = storePath('launcher.json');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(meta, 'utf8'));
  } catch {}
  const roots = { ...(cur.roots || {}) };
  const key = profileKey();
  if (roots[key] !== root) {
    roots[key] = root;
    writeJsonAtomic(meta, { roots });
  }
  const launcher = launcherPath();
  let src = null;
  try {
    src = fs.readFileSync(launcher, 'utf8');
  } catch {}
  if (src !== LAUNCHER_SRC) fs.writeFileSync(launcher, LAUNCHER_SRC, PRIVATE);
}

export const isOurs = (cmd) => typeof cmd === 'string' && (cmd.includes(LAUNCHER) || /quotameter\.js"? statusline/.test(cmd));

function readSettings(file) {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { text: null, settings: {} };
  }
  try {
    return { text, settings: text.trim() ? JSON.parse(text) : {} }; // an empty file counts as no settings
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it before running setup.`);
  }
}

// root: the plugin folder (two up from bin/). Returns what changed, or would.
// The backup is taken only when the status line being replaced is not ours,
// so it always holds a settings.json the user made, never one with
// quotameter's command in it. `--remove` does not restore it wholesale, it
// only puts the statusLine entry back, so settings added in between are kept.
export function setup(root, { dryRun = false, remove = false } = {}) {
  const file = settingsFile();
  const { text, settings } = readSettings(file);
  const cfg = loadConfig();
  const key = profileKey();
  const wraps = { ...(cfg.wrapCommands || {}) };
  if (cfg.wrapCommand && !wraps[key]) wraps[key] = cfg.wrapCommand; // from a 0.2.0 pre-release config
  const current = settings.statusLine;
  const ours = current && isOurs(current.command);
  let next;
  let wrapCommand = wraps[key] || null;
  let note;

  if (remove) {
    if (!ours) return { changed: false, file, message: 'quotameter is not in the status line.' };
    next = wrapCommand ? { ...current, command: wrapCommand } : undefined;
    wrapCommand = null;
    note = next ? 'Your previous status line command is restored.' : 'The status line is removed.';
  } else if (ours) {
    // An older setup put the wrapped command on the command line; move it to config.
    const m = /statusline --wrap "((?:[^"\\]|\\.)*)"\s*$/.exec(current.command);
    if (m) wrapCommand = m[1].replace(/\\(.)/g, '$1');
    next = current.command === launcherCommand() ? current : { ...current, command: launcherCommand() };
    note = next === current ? 'Already set up.' : 'Updated to the current launcher.';
  } else {
    if (current?.type === 'command' && current.command) {
      wrapCommand = current.command;
      note = 'Your existing status line is kept and quotameter is added after it.';
    } else {
      note = 'Adds a status line showing both limits, and records a reading every minute while you work.';
    }
    next = { ...(current || {}), type: 'command', command: launcherCommand() };
  }

  const changed = JSON.stringify(current) !== JSON.stringify(next) || (wraps[key] || null) !== wrapCommand;
  const plan = { file, backup: text != null && !ours ? path.join(path.dirname(file), BACKUP) : null, before: current, after: next, wrapCommand, message: note, changed };
  if (dryRun || !changed) {
    if (!dryRun && !remove) refreshLauncher(root);
    return plan;
  }
  if (plan.backup) fs.copyFileSync(file, plan.backup);
  if (next) settings.statusLine = next;
  else delete settings.statusLine;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write beside the file and rename, so an interruption cannot leave it half written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  try {
    renameRetry(tmp, file); // retries while Claude Code holds the file open on Windows
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (!remove) refreshLauncher(root);
  if (wrapCommand) wraps[key] = wrapCommand;
  else delete wraps[key];
  delete cfg.wrapCommand;
  if (Object.keys(wraps).length) cfg.wrapCommands = wraps;
  else delete cfg.wrapCommands;
  saveConfig(cfg);
  return plan;
}

export function describe(plan) {
  const lines = [];
  if (!plan.changed) return [plan.message].concat(plan.file ? [`File: ${plan.file}`] : []);
  lines.push(plan.message);
  lines.push(`File: ${plan.file}`);
  if (plan.backup) lines.push(`Backup: ${plan.backup} (your settings as they are now, before quotameter touches the status line)`);
  lines.push(`statusLine before: ${plan.before ? JSON.stringify(plan.before) : 'none'}`);
  lines.push(`statusLine after:  ${plan.after ? JSON.stringify(plan.after) : 'none'}`);
  if (plan.wrapCommand) lines.push(`Wrapped command (kept in quotameter's config.json): ${plan.wrapCommand}`);
  return lines;
}
