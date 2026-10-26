// Several of your own computers, one shared folder. Each install writes its
// usage into `syncDir` (a folder you already sync: Syncthing, OneDrive, a
// dotfiles repo), and reads the others' files when it loads data. Claude
// Code on the laptop then shows up as "Claude Code on other computers"
// instead of being counted as chat, and calibration stays right because the
// other machine's cost is in the cost index when limit windows are walked.
//
// Nothing crosses that is not needed: per response only time, model,
// surface, agent flag, token counts and list cost, with the session id
// replaced by a short hash; no folder, branch, title or hostname beyond the
// name you chose. Remote rows are never written to the local store.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readAll, readState } from './store.js';
import { saveConfig } from './config.js';
import { mergeMessage } from './ingest/logs.js';
import { DAY } from './model/util.js';

export const SCHEMA = 1;
const SKEW = 5 * 60000; // rows this far in the future are clock skew, not lies
const FIELDS = ['id', 'ts', 'model', 'entrypoint', 'in', 'out', 'cw5', 'cw1h', 'cr', 'cost', 'speed'];

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10);

// A persistent id, so a renamed computer is still the same computer.
export function machineId(cfg) {
  if (!cfg.machineId) {
    cfg.machineId = crypto.randomBytes(4).toString('hex');
    saveConfig(cfg);
  }
  return cfg.machineId;
}

export const machineName = (cfg) => (cfg.machineName || os.hostname() || 'another computer').slice(0, 40);
const fileFor = (dir, id) => path.join(dir, `quotameter-${id}.json`);

// Write this machine's file. Called at the end of every ingest.
export function exportSync(cfg, state = readState(), now = Date.now()) {
  if (!cfg.syncDir) return null;
  const id = machineId(cfg);
  const keep = now - (cfg.keepDays || 90) * DAY;
  const archived = state.archived || {};
  const byId = new Map();
  for (const m of readAll('messages')) if (!archived[m.session]) byId.set(m.id, mergeMessage(byId.get(m.id), m));
  const rows = [];
  for (const m of byId.values()) {
    if (!m.ts || Date.parse(m.ts) < keep || m.model === '<synthetic>') continue;
    const row = {};
    for (const f of FIELDS) if (m[f] != null) row[f] = m[f];
    row.session = hash(m.session);
    if (m.agent) row.agent = m.agent.type || 'agent';
    rows.push(row);
  }
  const costs = readAll('costs').filter((c) => !archived[c.session] && c.totalCost != null && Date.parse(c.ts) >= keep)
    .map((c) => ({ session: hash(c.session), run: c.run, ts: c.ts, totalCost: c.totalCost }));
  const readings = readAll('readings').filter((r) => r.percent != null && Date.parse(r.ts) >= now - 35 * DAY)
    .map((r) => ({ ts: r.ts, kind: r.kind, group: r.group || null, percent: r.percent, resetsAt: r.resetsAt || null }));
  const payload = { schema: SCHEMA, machineId: id, name: machineName(cfg), exportedAt: new Date(now).toISOString(), rows, costs, readings };
  fs.mkdirSync(cfg.syncDir, { recursive: true });
  const file = fileFor(cfg.syncDir, id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file); // a syncing tool never sees a half-written file
  return { file, rows: rows.length, readings: readings.length };
}

// Read every other machine's file. A half-synced or foreign file is skipped.
export function importSync(cfg, now = Date.now()) {
  const out = { messages: [], costs: new Map(), readings: [], machines: [] };
  if (!cfg.syncDir) return out;
  const own = machineId(cfg); // generated now if missing, so our own file is never "another computer"
  let names;
  try {
    names = fs.readdirSync(cfg.syncDir).filter((f) => /^quotameter-[0-9a-f]+\.json$/.test(f));
  } catch {
    return out;
  }
  for (const name of names) {
    let p;
    try {
      p = JSON.parse(fs.readFileSync(path.join(cfg.syncDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!p?.machineId || p.machineId === own) continue;
    if (p.schema !== SCHEMA || !Array.isArray(p.rows)) {
      // Left out of the numbers, but said out loud: that computer's Code usage
      // would otherwise look like chat here.
      out.machines.push({ id: p.machineId, name: String(p.name || p.machineId).slice(0, 40), error: p.schema > SCHEMA ? 'written by a newer quotameter; update this one' : 'unreadable file' });
      continue;
    }
    const label = String(p.name || p.machineId).replace(/[\u0000-\u001f]/g, '').slice(0, 40);
    out.machines.push({ id: p.machineId, name: label, exportedAt: p.exportedAt || null });
    for (const r of p.rows) {
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t) || t > now + SKEW) continue;
      out.messages.push({
        id: `remote:${p.machineId}:${r.id}`, ts: r.ts, session: `remote:${p.machineId}:${r.session}`, entrypoint: r.entrypoint || 'cli',
        cwd: `Other computer: ${label}`, branch: null, model: r.model || null, agent: r.agent ? { type: r.agent } : null, skill: null, tools: [],
        speed: r.speed || null, in: r.in || 0, out: r.out || 0, cw5: r.cw5 || 0, cw1h: r.cw1h || 0, cr: r.cr || 0, cost: r.cost || 0, remote: label,
      });
    }
    for (const c of p.costs || []) {
      const key = `remote:${p.machineId}:${c.session}`;
      out.costs.set(key, (out.costs.get(key) || 0) + (c.totalCost || 0));
    }
    for (const r of p.readings || []) {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && t <= now + SKEW) out.readings.push({ ...r, source: `sync:${p.machineId}` });
    }
  }
  return out;
}

// Readings from two machines read the same limits; keep one per kind and minute.
export function dedupeReadings(readings) {
  const seen = new Set();
  const out = [];
  for (const r of readings) {
    const key = `${r.kind}|${Math.round(Date.parse(r.ts) / 60000)}|${r.resetsAt ? Math.round(Date.parse(r.resetsAt) / 60000) : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
