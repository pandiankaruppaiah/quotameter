import fs from 'node:fs';
import { storePath, PRIVATE } from './store.js';

export const DEFAULTS = {
  // Minutes between /usage polls triggered by hooks, the status line or a report.
  pollIntervalMin: 10,
  // Store project folders as a short hash and drop branch names.
  redactPaths: false,
  // Windows the user marked as Code-only (`quotameter mark code-only`), used for calibration.
  codeOnlyWindows: [],
  // Days of raw rows to keep (at least 35). Older days live on as summaries.
  keepDays: 90,
  // The prompt hook warns once when a limit reaches this percentage, and again at 95. 0 turns it off.
  warnAt: 80,
  // From this percentage of the 5-hour window (weekly: 10 more), every prompt
  // tells the assistant to go easy on quota. Not shown to the user. 0 turns it off.
  adviseAt: 70,
  // Context size in tokens at which the prompt hook suggests /compact, once per session. 0 turns it off.
  ctxNudgeAt: 150000,
  // Show an OS notification when a limit that reached 95% resets.
  resetAlarm: true,
  // Ask before Claude reads a file larger than this many KB. 0 turns the guard off.
  fileGuardKB: 512,
  // A folder you sync between your own computers; each one writes its usage there so the
  // others stop counting it as chat. Empty: off.
  syncDir: '',
  // How this computer is named in merged reports. Empty: the hostname.
  machineName: '',
  // Label used by `quotameter team export`. Empty: member-<hash>.
  teamLabel: '',
};

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(storePath('config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(storePath('config.json'), JSON.stringify(cfg, null, 2) + '\n', PRIVATE);
}
