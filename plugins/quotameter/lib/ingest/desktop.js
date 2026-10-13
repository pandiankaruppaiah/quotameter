// Claude Desktop sources. Two things only:
//  1. plan-usage-history.json: percentage samples Desktop records itself.
//  2. The modified time of Desktop's web storage folders, as a sign that the
//     Chat tab was in use. Only timestamps are read, never the contents: these
//     folders also hold sign-in data.

import fs from 'node:fs';
import path from 'node:path';
import { desktopDataDirs } from '../paths.js';

export function readDesktopHistory(state) {
  const readings = [];
  for (const dir of desktopDataDirs()) {
    const f = path.join(dir, 'plan-usage-history.json');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const seen = (state.desktopHistory ||= {});
    const last = seen[f] || 0;
    for (const s of Array.isArray(data?.samples) ? data.samples : []) {
      if (typeof s?.t !== 'number' || s.t <= last || !s.u) continue;
      const ts = new Date(s.t).toISOString();
      if (typeof s.u.fh === 'number') readings.push({ ts, source: 'desktop-history', kind: 'session', group: 'session', percent: s.u.fh, resetsAt: null, severity: null });
      if (typeof s.u.sd === 'number') readings.push({ ts, source: 'desktop-history', kind: 'weekly_all', group: 'weekly', percent: s.u.sd, resetsAt: null, severity: null });
      seen[f] = Math.max(seen[f] || 0, s.t);
    }
  }
  return readings;
}

const WEB_STORAGE = ['IndexedDB', 'Local Storage', 'Session Storage'];

function newestMtime(dir) {
  let newest = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const t = e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs;
      if (t > newest) newest = t;
    }
  } catch {}
  return newest;
}

// One activity row each time Desktop's web storage changed since the last scan.
export function readDesktopActivity(state) {
  const rows = [];
  for (const dir of desktopDataDirs()) {
    const t = Math.max(...WEB_STORAGE.map((d) => newestMtime(path.join(dir, d))));
    if (!t) continue;
    const seen = (state.desktopActivity ||= {});
    if (t > (seen[dir] || 0)) {
      if (seen[dir]) rows.push({ ts: new Date(t).toISOString(), source: 'desktop-web-storage' });
      seen[dir] = t;
    }
  }
  return rows;
}
