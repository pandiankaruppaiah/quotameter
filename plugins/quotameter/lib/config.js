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
