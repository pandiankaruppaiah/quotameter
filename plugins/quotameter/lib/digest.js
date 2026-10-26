// What the session start hook says: a receipt for the last finished session,
// a digest for a week that just ended, and a note when resuming will rebuild
// the prompt cache. Read straight from the store, no analysis, so a session
// start is never slowed down. Percentages use the k the last analysis wrote.

import fs from 'node:fs';
import { readAll, readK, storePath, writeJsonAtomic } from './store.js';
import { loadConfig } from './config.js';
import { costOf } from './model/pricing.js';
import { sum, freshOf, DAY } from './model/util.js';
import { folderName } from './model/breakdown.js';
import { fmt, dur } from './report/format.js';

const FILE = 'digest.json';
const HEAVY = /opus|fable|mythos/;
const INTERACTIVE = ['cli', 'claude-desktop'];
// Weekly resets jitter by seconds between sources; the hour is the key.
const roundHour = (t) => Math.round(t / 3600000) * 3600000;

function readDone() {
  try {
    return JSON.parse(fs.readFileSync(storePath(FILE), 'utf8'));
  } catch {
    return {};
  }
}

const pct = (cost, k) => (k ? `${(cost * k).toFixed(cost * k >= 10 ? 0 : 1)}%` : null);

// The newest finished interactive session with a Claude Code total.
// A session is still running if the status line wrote its total in the last
// two minutes, or if it is the session that is starting right now.
function runningSessions(current, now) {
  const live = new Set(current ? [current] : []);
  for (const r of readAll('live')) if (r.session && r.cost != null && now - Date.parse(r.ts) < 120000) live.add(r.session);
  return live;
}

export function receipt(k, done, { redact = false, current = null, now = Date.now(), messages = null } = {}) {
  const live = runningSessions(current, now);
  const costs = readAll('costs').filter((c) => c.totalCost > 0 && !live.has(c.session));
  if (!costs.length) return null;
  const last = costs.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
  if (done.lastSession === last.session) return null;
  const sessions = new Map(readAll('sessions').map((s) => [s.session, s]));
  const s = sessions.get(last.session) || {};
  if (s.entrypoint && !INTERACTIVE.includes(s.entrypoint)) return { skip: last.session };
  const msgs = (messages || readAll('messages')).filter((m) => m.session === last.session);
  const fresh = sum(msgs, freshOf);
  const heavy = sum(msgs.filter((m) => HEAVY.test(m.model || '')), (m) => m.cost || 0);
  const all = sum(msgs, (m) => m.cost || 0);
  const share = all > 0 ? Math.round((heavy / all) * 100) : null;
  const length = s.start && s.end ? dur(Date.parse(s.end) - Date.parse(s.start)) : null;
  const bits = [fresh ? `${fmt(fresh)} fresh tokens` : null, length, share != null ? `${share}% on Opus or Fable` : null].filter(Boolean);
  const head = pct(last.totalCost, k?.h5) ? `last session used ${pct(last.totalCost, k.h5)} of the 5-hour limit` : `last session used $${last.totalCost.toFixed(2)} at list price`;
  return { session: last.session, text: `${head}${bits.length ? ` (${bits.join(', ')})` : ''}.` };
}

// The weekly window that ended most recently, once, within a week of its end.
export function weeklyDigest(k, done, now = Date.now(), { redact = false, messages = null } = {}) {
  const rows = [...readAll('readings'), ...readAll('livelog'), ...readAll('live')].filter((r) => r.kind === 'weekly_all' && r.resetsAt && r.percent != null);
  const ended = rows.map((r) => ({ ...r, r: roundHour(Date.parse(r.resetsAt)) })).filter((r) => r.r <= now && r.r > now - 7 * DAY);
  if (!ended.length) return null;
  const key = Math.max(...ended.map((r) => r.r));
  if (done.lastWeek === key) return null;
  const peak = Math.max(...ended.filter((r) => r.r === key).map((r) => r.percent));
  const start = key - 7 * DAY;
  const msgs = (messages || readAll('messages')).filter((m) => {
    const t = Date.parse(m.ts);
    return t >= start && t < key;
  });
  const sessions = new Map(readAll('sessions').map((s) => [s.session, s]));
  const n = new Set(msgs.filter((m) => INTERACTIVE.includes(m.entrypoint)).map((m) => m.session)).size;
  const fresh = sum(msgs, freshOf);
  const byProject = {};
  for (const m of msgs) if (m.cwd) byProject[folderName(m.cwd)] = (byProject[folderName(m.cwd)] || 0) + (m.cost || 0);
  const top = !redact && Object.keys(byProject).length ? Object.entries(byProject).sort((a, b) => b[1] - a[1])[0][0] : null;
  const heavy = msgs.filter((m) => HEAVY.test(m.model || ''));
  const usageOf = (m) => ({ input_tokens: m.in, output_tokens: m.out, cache_read_input_tokens: m.cr, cache_creation_input_tokens: m.cw5 + m.cw1h, cache_creation: { ephemeral_5m_input_tokens: m.cw5, ephemeral_1h_input_tokens: m.cw1h }, speed: m.speed });
  const actual = sum(heavy, (m) => m.cost || 0);
  const sonnet = sum(heavy, (m) => costOf('claude-sonnet-5-5', usageOf(m)) || 0);
  const whatIf = heavy.length && k?.wk && actual * k.wk >= 1 ? ` The Opus work (${pct(actual, k.wk)} of the week) would have been about ${pct(sonnet, k.wk)} on Sonnet.` : '';
  void sessions;
  return { key, text: `last week you used ${peak}% of the weekly limit over ${n} session${n === 1 ? '' : 's'}${fresh ? ` (${fmt(fresh)} fresh tokens)` : ''}${top ? `, mostly in ${top}` : ''}.${whatIf}` };
}

// input: the SessionStart hook's stdin JSON (source, and on resume the cache
// fields). Returns the lines to show, and remembers what was shown.
export function startMessages(input = {}, now = Date.now()) {
  const cfg = loadConfig();
  const k = readK();
  const done = readDone();
  const next = { ...done };
  const out = [];
  if ((input.source === 'resume' || input.source === 'fork') && input.prompt_cache_likely_expired) {
    const usd = Number(input.estimated_cache_write_usd);
    const cost = Number.isFinite(usd) && usd > 0 ? ` about $${usd.toFixed(2)} at list price${pct(usd, k?.h5) ? ` (${pct(usd, k.h5)} of the 5-hour window)` : ''}` : '';
    out.push(`resuming after ${input.seconds_since_last_response ? dur(input.seconds_since_last_response * 1000) : 'a pause'} rebuilds the prompt cache:${cost || ' the full context is sent again'}.`);
  }
  if (!input.source || input.source === 'startup') {
    // One pass over the messages serves both; it costs about 10 ms per MB.
    const messages = readAll('messages');
    const r = receipt(k, done, { redact: cfg.redactPaths, current: input.session_id || null, now, messages });
    if (r?.text) out.push(r.text);
    if (r?.session || r?.skip) next.lastSession = r.session || r.skip;
    const w = weeklyDigest(k, done, now, { redact: cfg.redactPaths, messages });
    if (w) {
      out.push(w.text);
      next.lastWeek = w.key;
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(done)) writeJsonAtomic(storePath(FILE), next);
  return out.map((l) => `quotameter: ${l[0].toUpperCase()}${l.slice(1)}`);
}
