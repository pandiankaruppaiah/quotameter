// Usage by model, project, session, subagent, skill, tool and MCP server for
// one range of messages.

import { sum, tokensOf, freshOf, round } from './util.js';
import { prettyModel } from './models.js';

function whereOf(m) {
  if (m.remote) return `Other computer: ${m.remote}`;
  if (m.agent) return 'Subagents';
  if (m.entrypoint === 'claude-desktop') return 'Main · Desktop agent';
  if (m.entrypoint === 'cli') return 'Main · CLI';
  return 'Headless (claude -p)';
}

function sourceOf(e) {
  return e === 'claude-desktop' ? 'Desktop agent' : e === 'cli' ? 'CLI' : 'Headless';
}

function topN(obj, n, key = 'pts') {
  return Object.values(obj).sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n);
}

function mcpServer(tool) {
  if (!tool.startsWith('mcp__')) return null;
  return tool.slice(5).split('__')[0];
}

// Last folder of a path written on any platform: "C:\\Users\\dev\\My Projects\\app" and "/home/dev/app" both give "app".
export const folderName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

export function breakdown(msgs, { codePts, chatPts, chatTokens, sessions, k, unit, total }) {
  const adjTotal = sum(msgs, (m) => m.adj);
  const ptsOf = (m) => (codePts != null && adjTotal > 0 ? (codePts * m.adj) / adjTotal : null);
  const add = (o, key, init, m, extra) => {
    const g = (o[key] ||= { ...init, req: 0, in: 0, out: 0, cw: 0, cr: 0, tokens: 0, fresh: 0, cost: 0, adj: 0, pts: 0 });
    g.req += m.req || 1; // an archived row stands for many responses
    g.in += m.in; g.out += m.out; g.cw += m.cw5 + m.cw1h; g.cr += m.cr;
    g.tokens += tokensOf(m); g.fresh += freshOf(m); g.cost += m.cost; g.adj += m.adj; g.pts += ptsOf(m) || 0;
    if (extra) extra(g);
    return g;
  };

  const models = {}, projects = {}, sess = {}, agents = {}, skills = {}, tools = {}, mcp = {};
  for (const m of msgs) {
    // A residual row (session total with no response records) belongs to its
    // project and session, but only to the "not itemised" model row.
    if (!m.residual) add(models, `${m.model}|${whereOf(m)}`, { model: m.model || 'unknown', where: whereOf(m) }, m);
    const proj = m.cwd ? folderName(m.cwd) : 'unknown';
    add(projects, proj, { name: proj, branches: new Set(), sources: new Set() }, m, (g) => {
      if (m.branch && m.branch !== 'HEAD') g.branches.add(m.branch);
      g.sources.add(m.remote ? 'Other computer' : sourceOf(m.entrypoint));
    });
    if (!m.archived) add(sess, m.session, { session: m.session, models: new Set(), agents: new Set() }, m, (g) => {
      if (m.agent) g.agents.add(m.agent.id || m.agent.type);
      else g.models.add(m.model);
    });
    if (m.agent) {
      const key = m.agent.type || m.agent.name || 'agent';
      add(agents, key, { name: key, models: new Set(), depth: m.agent.depth, tools: {} }, m, (g) => {
        g.models.add(m.model);
        for (const t of m.tools) g.tools[t] = (g.tools[t] || 0) + 1;
      });
    }
    if (m.skill) add(skills, m.skill, { name: m.skill }, m);
    const share = m.tools.length ? 1 / m.tools.length : 0;
    for (const t of m.tools) {
      const g = (tools[t] ||= { name: t, calls: 0, pts: 0, cost: 0 });
      g.calls++;
      g.pts += (ptsOf(m) || 0) * share;
      g.cost += m.adj * share;
      const srv = mcpServer(t);
      if (srv) {
        const s = (mcp[srv] ||= { name: srv, calls: 0, pts: 0 });
        s.calls++;
        s.pts += (ptsOf(m) || 0) * share;
      }
    }
  }

  const unitemisedAdj = sum(msgs, (m) => m.adj - m.cost);
  const r = (x) => round(x, 2);
  const modelRows = Object.values(models)
    .sort((a, b) => b.adj - a.adj)
    .map((g) => ({ model: g.model, where: g.where, req: g.req, in: g.in, out: g.out, cw: g.cw, cr: g.cr, cost: r(g.cost), pts: codePts != null ? r(g.adj > 0 ? (g.pts * g.cost) / g.adj : 0) : null }));
  if (unitemisedAdj > 0.0001) modelRows.push({ model: 'Claude Code · not itemised', where: 'from session totals', unitemised: true, cost: r(unitemisedAdj), pts: codePts != null ? r((codePts * unitemisedAdj) / adjTotal) : null });
  if (chatPts != null) modelRows.push({ model: 'Chat and other devices', where: 'claude.ai, Desktop Chat, mobile, other computers', chat: true, tokens: chatTokens, pts: r(chatPts) });

  const projRows = topN(projects, 8).map((g) => ({ name: g.name, branch: [...g.branches].slice(0, 2).join(' · '), src: [...g.sources].join(' + '), tokens: g.fresh, allTokens: g.tokens, cost: r(g.adj), pts: codePts != null ? r(g.pts) : null }));
  if (chatPts != null) projRows.push({ name: 'Chat and other devices', src: 'estimated', tokens: chatTokens, pts: r(chatPts), chat: true });

  const sessRows = topN(sess, 8, codePts != null ? 'pts' : 'adj').map((g) => {
    const s = sessions.get(g.session) || {};
    const main = [...g.models].filter(Boolean).map(prettyModel).join(', ');
    return {
      title: s.customTitle || s.aiTitle || (s.cwd ? folderName(s.cwd) : g.session.slice(0, 8)),
      src: sourceOf(s.entrypoint),
      model: main + (g.agents.size ? ` + ${g.agents.size} agent${g.agents.size > 1 ? 's' : ''}` : ''),
      durationMs: s.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : null,
      tokens: g.fresh,
      allTokens: g.tokens,
      cost: r(g.adj),
      pts: codePts != null ? r(g.pts) : null,
    };
  });

  const agentRows = topN(agents, 8, 'adj').map((g) => ({
    name: g.name,
    model: [...g.models].join(', '),
    depth: g.depth,
    req: g.req,
    tokens: g.fresh,
    allTokens: g.tokens,
    cost: r(g.adj),
    pts: codePts != null ? r(g.pts) : null,
    tools: Object.entries(g.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t} ${n}`).join(' · '),
  }));

  const skillRows = topN(skills, 10, 'adj').map((g) => ({ name: g.name, responses: g.req, cost: r(g.adj), pts: codePts != null ? r(g.pts) : null, share: total ? r(((codePts != null ? g.pts : g.adj) / total) * 100) : null }));
  const toolRows = topN(tools, 15, 'cost').map((g) => ({ name: g.name, calls: g.calls, cost: r(g.cost), pts: codePts != null ? r(g.pts) : null }));
  const mcpRows = Object.values(mcp).map((g) => ({ name: g.name, calls: g.calls, pts: codePts != null ? r(g.pts) : null }));

  const real = msgs.filter((m) => !m.residual);
  const main = sum(real.filter((m) => !m.agent), (m) => m.req || 1);
  const exactTokens = sum(msgs, tokensOf);
  const freshTokens = sum(msgs, freshOf);
  return {
    unit,
    total: total != null ? r(total) : null,
    tiles: {
      requests: sum(real, (m) => m.req || 1),
      mainRequests: main,
      agentRequests: sum(real, (m) => m.req || 1) - main,
      tokens: freshTokens + (chatTokens || 0),
      allTokens: exactTokens,
      freshTokens,
      cacheReadTokens: sum(msgs, (m) => m.cr),
      chatTokens: chatTokens || 0,
      cacheReadShare: exactTokens ? sum(msgs, (m) => m.cr) / exactTokens : 0,
      apiCost: r(sum(msgs, (m) => m.adj)),
    },
    models: modelRows,
    projects: projRows,
    sessions: sessRows,
    agents: agentRows,
    skills: skillRows,
    tools: toolRows,
    mcp: mcpRows,
  };
}
