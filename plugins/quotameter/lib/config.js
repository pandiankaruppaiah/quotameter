import fs from 'node:fs';
import { storePath } from './store.js';

export const DEFAULTS = {
  // Minutes between /usage polls triggered by hooks, the status line or a report.
  pollIntervalMin: 10,
  // Store project folders as a short hash and drop branch names.
  redactPaths: false,
  // Sessions the user marked as Code-only windows, used for calibration.
  codeOnlyWindows: [],
  // Days of raw rows to keep (at least 35). Older days live on as summaries.
  keepDays: 90,
};

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(storePath('config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(storePath('config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
