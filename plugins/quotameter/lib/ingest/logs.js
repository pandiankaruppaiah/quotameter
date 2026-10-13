// Incremental scanner for Claude Code session logs (~/.claude/projects/**/*.jsonl).
//
// Reads only usage metadata. Message text, thinking and tool inputs are never
// stored: from message content we keep tool names and nothing else.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { claudeProjectsDir } from '../paths.js';
import { costOf, normalizeModel } from '../model/pricing.js';

const CHUNK = Number(process.env.QUOTAMETER_CHUNK_BYTES) || 8 * 1024 * 1024;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function readAgentMeta(logPath) {
  try {
    const m = JSON.parse(fs.readFileSync(logPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return { type: m.agentType || m.spawnedAgentType || null, name: m.name || null, depth: m.spawnDepth ?? null };
  } catch {
    return null;
  }
}

export const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

function messageRow(rec, agent, opts) {
  const msg = rec.message;
  const u = msg.usage;
  const tools = [];
  for (const c of msg.content || []) if (c && c.type === 'tool_use' && c.name) tools.push(c.name);
  const model = normalizeModel(msg.model);
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  return {
    id: msg.id || rec.requestId || rec.uuid,
    ts: rec.timestamp,
    session: rec.sessionId,
    entrypoint: rec.entrypoint || null,
    cwd: opts.redactPaths && rec.cwd ? `project-${hash(rec.cwd)}` : rec.cwd || null,
    branch: opts.redactPaths ? null : rec.gitBranch || null,
    model,
    agent,
    skill: rec.attributionSkill || null,
    tools,
    speed: u.speed || null,
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cw5: u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1h),
    cw1h: w1h,
    cr: u.cache_read_input_tokens || 0,
    final: msg.stop_reason != null,
    cost: costOf(model, u),
  };
}

// Keep the most complete copy: a final record beats a partial one, then the
// larger output count wins. Tool names are the union across copies, because
// each streamed record can carry a different content block.
export function mergeMessage(a, b) {
  if (!a) return b;
  const better = (b.final && !a.final) || (b.final === a.final && b.out >= a.out) ? b : a;
  return { ...better, tools: [...new Set([...(a.tools || []), ...(b.tools || [])])] };
}

function readingRows(rec) {
  const limits = rec.usageReport?.rate_limits?.limits;
  if (!Array.isArray(limits)) return [];
  return limits
    .filter((l) => typeof l.percent === 'number' && l.kind)
    .map((l) => ({
      ts: rec.timestamp,
      source: 'usage-log',
      kind: l.kind,
      group: l.group || null,
      percent: l.percent,
      resetsAt: l.resets_at ? new Date(l.resets_at).toISOString() : null,
      severity: l.severity || null,
    }));
}

function overheadRow(rec) {
  const c = rec.contextUsage;
  if (!c || !Array.isArray(c.categories)) return null;
  return {
    ts: rec.timestamp,
    model: normalizeModel(c.model),
    categories: c.categories.map((x) => ({ name: x.name, tokens: x.tokens })),
    mcpTools: (c.mcp_tools || []).map((t) => ({ name: t.name, server: t.server_name, tokens: t.tokens })),
    skills: (c.skills || []).map((s) => ({ name: s.name, source: s.source, plugin: s.plugin_name || null, tokens: s.tokens })),
  };
}

// Claude Code's own per-session totals, written when a session ends.
function costRow(rec, fileMtime) {
  const models = {};
  for (const [m, v] of Object.entries(rec.modelUsage || {})) {
    models[normalizeModel(m)] = {
      in: v.inputTokens || 0,
      out: v.outputTokens || 0,
      cr: v.cacheReadInputTokens || 0,
      cw: v.cacheCreationInputTokens || 0,
      cost: v.costUSD ?? null,
    };
  }
  return {
    session: rec.sessionId,
    run: rec.startTime || null,
    ts: fileMtime,
    totalCost: rec.totalCostUSD ?? null,
    models,
  };
}

// Iterate complete lines from `offset`, reading the file in chunks so a large
// first scan does not load the whole log into memory.
// Lines are split on the newline byte before decoding, so a multi-byte
// character that straddles a chunk boundary is never decoded in halves.
function* linesFrom(fd, offset, size) {
  let pos = offset;
  let carry = Buffer.alloc(0);
  while (pos < size) {
    const len = Math.min(CHUNK, size - pos);
    const chunk = Buffer.alloc(len);
    fs.readSync(fd, chunk, 0, len, pos);
    pos += len;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      carry = buf;
      continue;
    }
    carry = Buffer.from(buf.subarray(lastNl + 1));
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) yield line;
  }
  // Bytes after the last newline belong to a line the writer has not finished.
  return carry.length;
}

export function scanFile(logPath, fromOffset = 0, opts = {}) {
  const out = { offset: fromOffset, messages: [], readings: [], sessions: [], costs: [], overhead: [] };
  const fd = fs.openSync(logPath, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (st.size <= fromOffset) {
      out.offset = st.size;
      return out;
    }
    const isSub = /[\\/]subagents[\\/]/.test(logPath);
    const meta = isSub ? readAgentMeta(logPath) : null;
    const byId = new Map();
    const sessions = new Map();
    const session = (id) => {
      if (!sessions.has(id)) sessions.set(id, { session: id });
      return sessions.get(id);
    };

    const it = linesFrom(fd, fromOffset, st.size);
    let step;
    while (!(step = it.next()).done) {
      const line = step.value;
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.sessionId && rec.timestamp && !isSub) {
        const s = session(rec.sessionId);
        if (!s.start || rec.timestamp < s.start) s.start = rec.timestamp;
        if (!s.end || rec.timestamp > s.end) s.end = rec.timestamp;
        if (rec.entrypoint) s.entrypoint = rec.entrypoint;
        if (rec.cwd && !s.cwd) s.cwd = opts.redactPaths ? `project-${hash(rec.cwd)}` : rec.cwd;
      }
      if (rec.type === 'assistant' && rec.message?.usage) {
        const agent = isSub || rec.isSidechain
          ? { id: rec.agentId || null, type: meta?.type || null, name: meta?.name || null, depth: meta?.depth ?? null }
          : null;
        const row = messageRow(rec, agent, opts);
        byId.set(row.id, mergeMessage(byId.get(row.id), row));
      } else if (rec.type === 'system' && rec.usageReport) {
        out.readings.push(...readingRows(rec));
      } else if (rec.type === 'system' && rec.contextUsage) {
        const o = overheadRow(rec);
        if (o) out.overhead.push(o);
      } else if (rec.type === 'cost-state' && rec.sessionId) {
        out.costs.push(costRow(rec, st.mtime.toISOString()));
      } else if (rec.type === 'custom-title' && rec.sessionId) {
        session(rec.sessionId).customTitle = rec.customTitle;
      } else if (rec.type === 'ai-title' && rec.sessionId) {
        session(rec.sessionId).aiTitle = rec.aiTitle;
      }
    }
    out.offset = st.size - step.value; // `return` value of linesFrom: unread tail bytes
    out.messages = [...byId.values()];
    out.sessions = [...sessions.values()];
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// Scan every log that changed since the last run. `state.files` maps a path to
// { size, mtimeMs, offset }. A file that shrank was rewritten: start over.
export function scanAll(state, { root = claudeProjectsDir(), only, redactPaths = false } = {}) {
  const out = { messages: [], readings: [], sessions: [], costs: [], overhead: [], scanned: 0 };
  for (const p of only ? [only] : walk(root)) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    const prev = state.files[p];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    const from = prev && st.size >= prev.offset ? prev.offset : 0;
    let r;
    try {
      r = scanFile(p, from, { redactPaths });
    } catch {
      continue; // Unreadable right now (locked or deleted); try again next run.
    }
    state.files[p] = { size: st.size, mtimeMs: st.mtimeMs, offset: r.offset };
    for (const k of ['messages', 'readings', 'sessions', 'costs', 'overhead']) out[k].push(...r[k]);
    out.scanned++;
  }
  return out;
}
