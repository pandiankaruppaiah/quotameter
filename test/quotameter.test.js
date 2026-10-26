import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempHome, assistant, usage, usageRecord, writeLog, SECRET } from './helpers.js';

const home = tempHome();
const { costOf, normalizeModel, priceFor } = await import('../plugins/quotameter/lib/model/pricing.js');
const { scanAll, scanFile } = await import('../plugins/quotameter/lib/ingest/logs.js');
const { ingest } = await import('../plugins/quotameter/lib/ingest/index.js');
const { analyze, loadData } = await import('../plugins/quotameter/lib/model/analyze.js');
const { parseUsageText } = await import('../plugins/quotameter/lib/ingest/usage-poll.js');
const { renderHtml } = await import('../plugins/quotameter/lib/report/render.js');
const { statusText } = await import('../plugins/quotameter/lib/statusline.js');

const H = 3600000;
const iso = (t) => new Date(t).toISOString();

test('cost matches Claude Code for a 1-hour cache write on Opus 5.5', () => {
  const c = costOf('claude-opus-5-5', usage({ input: 2, output: 442, cw1h: 25590 }));
  assert.equal(Math.round(c * 1e6), 213568);
});

test('model names are normalised and unknown models fall back to their family', () => {
  assert.equal(normalizeModel('anthropic.claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
  assert.ok(priceFor('claude-sonnet-9-9'));
  assert.equal(priceFor('gpt-4'), null);
});

test('streamed copies merge into one message: final record, union of tools', () => {
  const p = writeLog(home, 'p-merge', 'm.jsonl', [
    assistant({ id: 'a', ts: '2026-10-13T01:00:00Z', u: usage({ output: 3 }), stop: null, blocks: [{ type: 'tool_use', name: 'Bash', input: { command: SECRET } }] }),
    assistant({ id: 'a', ts: '2026-10-13T01:00:01Z', u: usage({ output: 3 }), stop: null, blocks: [{ type: 'tool_use', name: 'Read', input: {} }] }),
    assistant({ id: 'b', ts: '2026-10-13T01:01:00Z', u: usage({ output: 9 }), stop: null }),
    assistant({ id: 'b', ts: '2026-10-13T01:01:05Z', u: usage({ output: 762 }), stop: 'end_turn' }),
  ]);
  const r = scanFile(p, 0);
  assert.equal(r.messages.length, 2);
  const a = r.messages.find((m) => m.id === 'a');
  assert.deepEqual(a.tools.sort(), ['Bash', 'Read']);
  assert.equal(r.messages.find((m) => m.id === 'b').out, 762);
});

test('incremental scan resumes from the offset and leaves a half-written line', () => {
  const p = writeLog(home, 'p-inc', 'i.jsonl', [assistant({ id: 'x1', ts: '2026-10-13T02:00:00Z' })]);
  const state = { files: {} };
  const first = scanAll(state, { only: p });
  assert.equal(first.messages.length, 1);
  const partial = JSON.stringify(assistant({ id: 'x2', ts: '2026-10-13T02:01:00Z' }));
  fs.appendFileSync(p, partial.slice(0, 40));
  assert.equal(scanAll(state, { only: p }).messages.length, 0);
  fs.appendFileSync(p, partial.slice(40) + '\n');
  const third = scanAll(state, { only: p });
  assert.deepEqual(third.messages.map((m) => m.id), ['x2']);
});

test('message text, thinking and tool inputs are never stored', async () => {
  await ingest({ poll: false });
  const stored = fs.readdirSync(process.env.QUOTAMETER_HOME).map((f) => {
    const p = path.join(process.env.QUOTAMETER_HOME, f);
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : '';
  });
  assert.ok(!stored.join('\n').includes(SECRET));
});

test('analysis: calibration, chat from idle increases, reconciliation and forecast', async () => {
  const now = Date.parse('2026-10-20T03:00:00Z');
  const reset = now + 2 * H;
  const start = reset - 5 * H;
  const weekReset = now + 3 * 24 * H;
  // Code work between start+0.5h and start+1.5h. Usage climbs 0 -> 10 while Code
  // works, then 10 -> 14 while Code is idle (that 4 must be chat).
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(assistant({ id: `w${i}`, session: 'sw', ts: iso(start + 0.5 * H + i * 6 * 60000), u: usage({ input: 10, output: 2000, cw5: 20000, read: 100000 }) }));
  }
  writeLog(home, 'p-win', 'sw.jsonl', [
    ...msgs,
    // Claude Code's own total is higher than the itemised messages.
    { type: 'cost-state', sessionId: 'sw', startTime: iso(start), totalCostUSD: 99, modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 99 } } },
  ]);
  writeLog(home, 'p-poll', 'poll.jsonl', [
    usageRecord({ ts: iso(start + 1.6 * H), fivePct: 10, weekPct: 2, fiveReset: iso(reset), weekReset: iso(weekReset) }),
    usageRecord({ ts: iso(start + 2.5 * H), fivePct: 14, weekPct: 3, fiveReset: iso(reset), weekReset: iso(weekReset) }),
  ]);
  await ingest({ poll: false });
  const s = analyze({ now, config: { plan: 'pro', codeOnlyWindows: [] } });
  const a = s.attribution.h5;
  assert.equal(a.total, 14);
  assert.ok(Math.abs(a.chat - 4) < 0.01, `chat was ${a.chat}`);
  assert.ok(a.unitemised > 0, 'cost-state residual shows up as not itemised');
  assert.equal(s.windows.h5.pct, 14);
  assert.ok(s.windows.h5.projectedAtReset >= 14 && s.windows.h5.projectedAtReset <= 100);
  assert.ok(s.breakdown.h5.models.some((m) => m.chat));
  assert.ok(s.calibration.h5.provisional);
});

test('forecast guards against a 0% window', async () => {
  const now = Date.parse('2026-11-01T03:00:00Z');
  writeLog(home, 'p-zero', 'z.jsonl', [usageRecord({ ts: iso(now - 60000), fivePct: 0, weekPct: 0, fiveReset: iso(now + 4 * H), weekReset: iso(now + 5 * 24 * H) })]);
  await ingest({ poll: false });
  const s = analyze({ now, config: { plan: 'pro', codeOnlyWindows: [] } });
  assert.equal(s.windows.h5.pct, 0);
  assert.equal(s.windows.h5.tokensLeft, null);
  assert.equal(s.windows.h5.hitsBeforeReset, false);
});

test('text fallback parser reads /usage output', () => {
  const rows = parseUsageText('Current session: 17% used · resets Oct 13, 5:39pm (UTC)\nCurrent week (all models): 3% used · resets Oct 15, 2:59am (UTC)', new Date('2026-10-13T03:00:00Z'));
  assert.deepEqual(rows.map((r) => [r.kind, r.percent]), [['session', 17], ['weekly_all', 3]]);
  assert.ok(rows[0].resetsAt);
});

test('report escapes data so a title cannot break out of the script tag', () => {
  const html = renderHtml({ title: '</script><img src=x onerror=alert(1)> $& $\'' });
  const i = html.indexOf('const S = ');
  const line = html.slice(i, html.indexOf('\n', i));
  assert.ok(!line.includes('</script>'));
  assert.ok(line.includes("$& $'"));
});

test('status line text', () => {
  const t = statusText({ rate_limits: { five_hour: { used_percentage: 17.4, resets_at: 1791873600 }, seven_day: { used_percentage: 3 } } });
  assert.match(t, /^5h 17% \(resets .+\) \| wk 3%$/);
  assert.equal(statusText({}), '5h -- | wk --');
});

test('no em dashes anywhere in shipped files', () => {
  const root = path.resolve('plugins/quotameter');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = [...walk(root), path.resolve('README.md'), path.resolve('docs/DESIGN.md')].filter((f) => fs.existsSync(f));
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('\u2014'), `em dash in ${f}`);
});

test('model families and names', async () => {
  const { familyOf, prettyModel } = await import('../plugins/quotameter/lib/model/analyze.js');
  assert.equal(familyOf('claude-3-5-sonnet'), 'Sonnet');
  assert.equal(familyOf('claude-opus-5-5'), 'Opus');
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-3-5-sonnet'), 'Sonnet 3.5');
  assert.equal(prettyModel('claude-haiku-4-5'), 'Haiku 4.5');
});

test('a session with a total but no response records still counts', async () => {
  const now = Date.parse('2026-12-01T03:00:00Z');
  const data = {
    messages: [],
    sessions: new Map([['bg', { session: 'bg', end: new Date(now - H).toISOString(), entrypoint: 'cli' }]]),
    trueCost: new Map([['bg', 0.5]]),
    costMeta: new Map([['bg', { ts: new Date(now - H).toISOString(), model: 'claude-haiku-5-5' }]]),
    readings: [], activity: [], overhead: null,
  };
  const s = analyze({ now, data, config: { plan: 'pro', codeOnlyWindows: [] } });
  assert.equal(s.unitemisedCost, 0.5);
});

test('a pause does not flip the forecast to "won\'t hit"', async () => {
  const now = Date.parse('2026-12-05T03:00:00Z');
  const reset = now + 2 * H;
  const r = (t, p) => ({ ts: iso(t), t, r: reset, kind: 'session', percent: p, source: 'test' });
  // 80% in 2 hours, then flat for the last 30 minutes.
  const readings = [r(now - 2.5 * H, 20), r(now - 1.5 * H, 60), r(now - 0.5 * H, 80), r(now - 0.25 * H, 80), r(now, 80)];
  const data = { messages: [], sessions: new Map(), trueCost: new Map(), costMeta: new Map(), readings, activity: [], overhead: null };
  const s = analyze({ now, data, config: { plan: 'pro', codeOnlyWindows: [] } });
  assert.ok(s.windows.h5.pacePerHour > 0);
  assert.equal(s.windows.h5.hitsBeforeReset, true);
});

test('only one poll lease at a time', async () => {
  const { tryLease } = await import('../plugins/quotameter/lib/store.js');
  const release = tryLease('test-poll', 60000);
  assert.ok(release);
  assert.equal(tryLease('test-poll', 60000), null);
  release();
  const again = tryLease('test-poll', 60000);
  assert.ok(again);
  again();
});

test('a multi-byte character across a chunk boundary keeps offsets exact', async () => {
  const { execFileSync } = await import('node:child_process');
  const p = path.join(home, 'utf8.jsonl');
  const rec = (id) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T01:00:00Z', sessionId: 'u', cwd: '/p/ünïcødé-✓-日本', message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  fs.writeFileSync(p, [rec('u1'), rec('u2'), ''].join(String.fromCharCode(10)));
  // Run in a child process so the tiny chunk size applies when logs.js loads.
  const script = [
    "const { scanFile } = await import(process.env.QM_LOGS);",
    "const r = scanFile(process.env.QM_FILE, 0);",
    "console.log(JSON.stringify({ n: r.messages.length, offset: r.offset, cwd: r.messages[0].cwd }));",
  ].join(String.fromCharCode(10));
  const env = { ...process.env, QUOTAMETER_CHUNK_BYTES: '64', QM_FILE: p, QM_LOGS: new URL('../plugins/quotameter/lib/ingest/logs.js', import.meta.url).href };
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env }));
  assert.equal(out.n, 2);
  assert.equal(out.offset, fs.statSync(p).size);
  assert.equal(out.cwd, JSON.parse(rec('x')).cwd);
});

test('model rows add up to the window total when a session has only a total', async () => {
  const now = Date.parse('2026-12-10T03:00:00Z');
  const reset = now + 2 * H;
  const start = reset - 5 * H;
  const mk = (id, t) => ({ id, ts: iso(t), t, session: 'a', entrypoint: 'cli', cwd: '/p/x', branch: null, model: 'claude-opus-5-5', agent: null, skill: null, tools: [], in: 1, out: 100, cw5: 0, cw1h: 0, cr: 0, cost: 1 });
  const data = {
    messages: [mk('m1', start + H), mk('m2', start + 1.5 * H)],
    sessions: new Map([['bg', { session: 'bg', end: iso(start + 1.2 * H), entrypoint: 'cli' }]]),
    trueCost: new Map([['bg', 1]]),
    costMeta: new Map([['bg', { ts: iso(start + 1.2 * H), model: 'claude-haiku-5-5' }]]),
    readings: [{ ts: iso(start + 2 * H), t: start + 2 * H, r: reset, kind: 'session', percent: 12, source: 'test' }],
    activity: [], overhead: null,
  };
  const s = analyze({ now, data, config: { plan: 'pro', codeOnlyWindows: [] } });
  const rows = s.breakdown.h5.models;
  const total = rows.reduce((a, r) => a + (r.pts || 0), 0);
  assert.ok(Math.abs(total - 12) < 0.05, `model points sum to ${total}`);
  assert.equal(s.breakdown.h5.tiles.requests, 2);
});

test('insights: limit timing, binding limit, sessions left, what-if and cache rebuilds', async () => {
  const now = Date.parse('2026-12-20T12:00:00Z');
  const oldReset = now - 4 * H;
  const start = oldReset - 5 * H;
  const curReset = now + 3 * H;
  const mk = (id, session, t, u) => {
    const m = { id, ts: iso(t), t, session, entrypoint: 'cli', cwd: '/p/app', branch: 'main', model: 'claude-opus-5-5', agent: null, skill: null, tools: [], speed: null, in: u.in, out: u.out, cw5: u.cw5 || 0, cw1h: 0, cr: 0 };
    m.cost = costOf(m.model, usage({ input: m.in, output: m.out, cw5: m.cw5 }));
    return m;
  };
  const data = {
    messages: [
      mk('a1', 'a', start + 0.5 * H, { in: 1000, out: 100 }),
      mk('a2', 'a', start + 1.5 * H, { in: 1000, out: 100, cw5: 30000 }),
      mk('b1', 'b', start + 1.6 * H, { in: 5000, out: 500 }),
    ],
    sessions: new Map(), trueCost: new Map(), costMeta: new Map(),
    readings: [
      { ts: iso(start + H), t: start + H, r: oldReset, kind: 'session', percent: 40, source: 'test' },
      { ts: iso(start + 2 * H), t: start + 2 * H, r: oldReset, kind: 'session', percent: 100, source: 'test' },
      { ts: iso(now - H), t: now - H, r: curReset, kind: 'session', percent: 20, source: 'test' },
      { ts: iso(start + 2 * H), t: start + 2 * H, r: curReset + 6 * 24 * H, kind: 'weekly_all', percent: 12, source: 'test' },
    ],
    activity: [], overhead: null,
  };
  const s = analyze({ now, data, config: { plan: 'pro', codeOnlyWindows: [] } });
  const I = s.insights;
  assert.equal(I.limitTiming.count, 1);
  assert.equal(I.limitTiming.medianAfterMs, 2 * H);
  assert.equal(I.limitTiming.medianLockedMs, 3 * H);
  assert.equal(I.binding.verdict, '5-hour');
  assert.equal(I.unused.finished, 1);
  assert.equal(I.unused.avgPeak, 100);
  assert.ok(I.sessionCost.left && I.sessionCost.left.typical >= I.sessionCost.left.heavy);
  assert.equal(I.sessionCost.left.room, 80);
  const w = I.whatIf.rows[0];
  assert.ok(Math.abs(w.sonnet - w.actual / 2) < 0.01, 'Sonnet 5.5 is half of Opus 5.5 for these tokens');
  assert.equal(I.cache.week.rebuilds, 1);
  assert.equal(I.cache.week.rebuildTokens, 30000);
  assert.equal(I.weeklyTokens.at(-1).fresh, 1100 + 31100 + 5500);
  assert.equal(I.branches[0].branch, 'main');
  assert.ok(w.actualPts > 0, 'what-if has weekly points once the week is calibrated');
  assert.equal(I.daily.unit, 'points');
  assert.ok(Math.abs(I.daily.days.reduce((a, d) => a + d.code, 0) - 12) < 0.05, 'daily Code points add up to the weekly window');
  assert.ok(renderHtml(s).includes('Your patterns'));
  assert.equal(I.weeklyTokens.length, 12);
  assert.equal(I.weeklyTokens.at(-1).hits, 1, 'the 5-hour window that hit 100% falls in this week');
});

test('insights: chat-only days still show in points', async () => {
  const now = Date.parse('2026-12-24T12:00:00Z');
  const reset = now + 3 * 24 * H;
  const r = (t, p) => ({ ts: iso(t), t, r: reset, kind: 'weekly_all', percent: p, source: 'test' });
  const data = { messages: [], sessions: new Map(), trueCost: new Map(), costMeta: new Map(), readings: [r(now - 30 * H, 4), r(now - 2 * H, 9)], activity: [], overhead: null };
  const s = analyze({ now, data, config: { plan: 'pro', codeOnlyWindows: [] } });
  const d = s.insights.daily;
  assert.equal(d.unit, 'points');
  assert.equal(Math.round(d.days.reduce((a, x) => a + x.chat, 0)), 9);
  assert.ok(!renderHtml(s).includes('NaN'));
});

test('retention: old sessions become summaries, totals survive, nothing counts twice', async () => {
  const { append, readAll } = await import('../plugins/quotameter/lib/store.js');
  const { compact } = await import('../plugins/quotameter/lib/model/retention.js');
  const { prepare } = await import('../plugins/quotameter/lib/model/analyze.js');
  const saved = process.env.QUOTAMETER_HOME;
  process.env.QUOTAMETER_HOME = fs.mkdtempSync(path.join(home, 'retention-'));
  try {
    const D = 24 * H;
    const now = Date.parse('2027-03-01T12:00:00Z');
    const msg = (id, session, t, model = 'claude-opus-5-5') => ({ id, ts: iso(t), session, entrypoint: 'cli', cwd: '/p/app', branch: 'main', model, agent: null, skill: null, tools: [], in: 1000, out: 200, cw5: 0, cw1h: 0, cr: 5000, final: true, cost: 0.01 });
    append('messages', [msg('o1', 'old', now - 100 * D + H / 2), msg('o2', 'old', now - 100 * D + H, 'claude-sonnet-5-5'), msg('n1', 'new', now - 2 * D)]);
    append('sessions', [{ session: 'old', start: iso(now - 100 * D), end: iso(now - 100 * D + H), entrypoint: 'cli' }, { session: 'new', start: iso(now - 2 * D), end: iso(now - 2 * D), entrypoint: 'cli' }]);
    // Claude Code's own total for the old session is twice what the logs itemise.
    append('costs', [{ ts: iso(now - 100 * D + H), session: 'old', run: 1, totalCost: 0.04 }]);
    const oldReset = now - 93 * D;
    append('readings', [
      { ts: iso(now - 100 * D + 2 * H), source: 'test', kind: 'weekly_all', group: 'weekly', percent: 40, resetsAt: iso(oldReset) },
      { ts: iso(now - H), source: 'test', kind: 'weekly_all', group: 'weekly', percent: 5, resetsAt: iso(now + 3 * D) },
    ]);
    const total = () => {
      const data = loadData();
      prepare(data, { codeOnlyWindows: [] });
      return Math.round(data.messages.reduce((a, m) => a + m.adj, 0) * 1e6) / 1e6;
    };
    const before = total();
    assert.equal(before, 0.05, 'old session reconciled to 0.04, new session 0.01');

    const r = compact({ now, force: true });
    assert.equal(r.sessions, 1);
    assert.equal(r.windows, 1);
    assert.ok(!readAll('messages').some((m) => m.session === 'old'), 'raw rows for the old session are gone');
    assert.ok(!readAll('costs').length, 'its cost row is gone too');
    assert.equal(total(), before, 'summaries keep the reconciled total');
    const w = readAll('windows')[0];
    assert.equal(w.peak, 40);
    assert.equal(w.fresh, 2400);

    // A rescan of old logs, or a crash before the rewrite, must not double count.
    append('messages', [msg('o1', 'old', now - 100 * D + H / 2)]);
    compact({ now, force: true });
    assert.equal(total(), before);
    assert.equal(readAll('windows').length, 1);

    // Summaries from a batch that never reached state.json (a crash) are ignored.
    append('daily', [{ id: 'x|1', batch: 1, day: '2026-11-01', t: now - 120 * D, cells: [{ model: 'claude-opus-5-5', project: 'app', surface: 'cli', agent: null, skill: null, in: 1, out: 1, cw5: 0, cw1h: 0, cr: 0, cost: 9, adj: 9, req: 1 }] }]);
    assert.equal(total(), before, 'uncommitted summaries do not count');

    // Status line rows left in a drain file by a crashed process are recovered.
    const { storePath, drainLive } = await import('../plugins/quotameter/lib/store.js');
    fs.writeFileSync(storePath('live.jsonl.drain-1-1'), JSON.stringify({ ts: iso(now), source: 'statusline', session: 'new', cost: 0.5 }) + String.fromCharCode(10));
    assert.equal(drainLive(), 1);
    assert.equal(readAll('livelog').length, 1);

    const s = analyze({ now, data: loadData(), config: { plan: 'pro', codeOnlyWindows: [] } });
    assert.ok(s.breakdown.d90 && s.breakdown.all, '90-day and all-history ranges appear once data is old enough');
    assert.equal(s.breakdown.all.models.filter((m) => !m.chat && !m.unitemised).length, 2);
    assert.ok(!s.breakdown.all.sessions.some((x) => /archive/.test(x.title)), 'archived days are not listed as sessions');
  } finally {
    process.env.QUOTAMETER_HOME = saved;
  }
});

test('whole-percent readings do not leak rounding into chat', async () => {
  const now = Date.parse('2027-01-10T12:00:00Z');
  const mk = (id, t) => ({ id, ts: iso(t), t, session: 's', entrypoint: 'cli', cwd: '/p/x', branch: null, model: 'claude-opus-5-5', agent: null, skill: null, tools: [], in: 1, out: 1, cw5: 0, cw1h: 0, cr: 0, cost: 1 });
  const r = (t, reset, p) => ({ ts: iso(t), t, r: reset, kind: 'session', percent: p, source: 'test' });
  // Window A: Code only, 25 dollars -> 10%, so k = 0.4 points per dollar.
  const aReset = now - 20 * H;
  const messages = [];
  for (let i = 0; i < 25; i++) messages.push(mk(`a${i}`, aReset - 4 * H + i * 60000));
  const readings = [r(aReset - 3 * H, aReset, 10)];
  // Window B: the same work, read after every response as whole percents.
  const bReset = now + H;
  const bStart = bReset - 5 * H;
  for (let i = 1; i <= 25; i++) {
    messages.push(mk(`b${i}`, bStart + i * 10 * 60000));
    readings.push(r(bStart + i * 10 * 60000 + 1000, bReset, Math.round(0.4 * i)));
  }
  const data = { messages, sessions: new Map(), trueCost: new Map(), costMeta: new Map(), readings, activity: [], overhead: null };
  const s = analyze({ now, data, config: { plan: 'pro', codeOnlyWindows: [] } });
  assert.ok(s.attribution.h5.chat < 0.5, `chat was ${s.attribution.h5.chat}, expected about 0`);
});

test('the plugin folder runs on its own, the way Claude Code installs it', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(home, 'installed-'));
  fs.cpSync(path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'plugins', 'quotameter'), dir, { recursive: true });
  const out = execFileSync(process.execPath, [path.join(dir, 'bin', 'quotameter.js'), 'help'], { encoding: 'utf8' });
  assert.match(out, /Usage: quotameter/);
});

test('privacy: summaries for the model and for sharing drop titles, branches and names', async () => {
  const { redact } = await import('../plugins/quotameter/lib/model/redact.js');
  const summary = {
    breakdown: { h5: {
      projects: [{ name: 'acme-billing', branch: 'feat/client-x', pts: 3 }, { name: 'Chat and other devices', chat: true, pts: 1 }],
      sessions: [{ title: 'Fix the SECRET-CLIENT invoice bug', pts: 2 }],
    } },
    insights: { branches: [{ project: 'acme-billing', branch: 'feat/client-x' }], sessionLength: { longestTitle: 'SECRET-CLIENT' } },
    findings: ['acme-billing used most of the week'],
  };
  const model = JSON.stringify(redact(summary));
  assert.ok(!model.includes('SECRET-CLIENT') && !model.includes('feat/client-x'), 'no titles or branches for the model');
  assert.ok(model.includes('acme-billing'), 'project names stay for the model');
  const shared = redact(summary, { share: true });
  const text = JSON.stringify(shared);
  assert.ok(!text.includes('acme-billing') && !text.includes('SECRET-CLIENT') && !text.includes('feat/client-x'));
  assert.equal(shared.breakdown.h5.projects[0].name, 'Project 1');
  assert.equal(shared.breakdown.h5.projects[1].name, 'Chat and other devices');
  assert.equal(summary.breakdown.h5.sessions[0].title, 'Fix the SECRET-CLIENT invoice bug', 'the original is not changed');
});

test('privacy: redactPaths stops session titles being stored', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'titles-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'ai-title', sessionId: 's9', aiTitle: 'SECRET-TITLE' }),
    JSON.stringify(assistant({ id: 'm9', ts: '2027-01-01T00:00:00Z', session: 's9' })),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10));
  const redacted = scanFile(file, 0, { redactPaths: true });
  assert.ok(!JSON.stringify(redacted.sessions).includes('SECRET-TITLE'));
  const plain = scanFile(file, 0, {});
  assert.ok(JSON.stringify(plain.sessions).includes('SECRET-TITLE'));
});

test('privacy: the store is private to its owner on macOS and Linux', { skip: process.platform === 'win32' }, async () => {
  const { storePath, append } = await import('../plugins/quotameter/lib/store.js');
  const saved = process.env.QUOTAMETER_HOME;
  process.env.QUOTAMETER_HOME = path.join(fs.mkdtempSync(path.join(home, 'perm-')), 'store');
  try {
    append('activity', [{ ts: '2027-01-01T00:00:00Z' }]);
    assert.equal(fs.statSync(process.env.QUOTAMETER_HOME).mode & 0o777, 0o700);
    assert.equal(fs.statSync(storePath('activity.jsonl')).mode & 0o777, 0o600);
  } finally {
    process.env.QUOTAMETER_HOME = saved;
  }
});

test('a lease is only released by the process that holds it', async () => {
  const { tryLease, storePath } = await import('../plugins/quotameter/lib/store.js');
  const first = tryLease('race', 1);
  await new Promise((r) => setTimeout(r, 20));
  const second = tryLease('race', 1); // the first one is stale now, so this takes over
  assert.ok(first && second);
  first(); // the slow first holder finishes late
  assert.ok(fs.existsSync(storePath('race.lease')), 'the newer lease survives');
  second();
  assert.ok(!fs.existsSync(storePath('race.lease')));
});

// ---------- 0.2.0 ----------

const pluginRoot = path.resolve('plugins/quotameter');

test('setup: installs the launcher, keeps an existing status line, removes cleanly', async () => {
  const { setup, settingsFile, launcherPath, isOurs } = await import('../plugins/quotameter/lib/setup.js');
  const { loadConfig } = await import('../plugins/quotameter/lib/config.js');
  fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'echo mine', padding: 1 } }));
  const dry = setup(pluginRoot, { dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).statusLine.command, 'echo mine', 'a dry run changes nothing');
  setup(pluginRoot);
  const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  assert.equal(s.model, 'opus', 'other settings survive');
  assert.ok(isOurs(s.statusLine.command) && s.statusLine.command.includes('statusline.mjs'));
  assert.equal(s.statusLine.padding, 1, 'other statusLine keys survive');
  const profile = path.resolve(process.env.CLAUDE_CONFIG_DIR);
  assert.equal(loadConfig().wrapCommands[profile], 'echo mine', 'the old command moves to config, not the command line');
  assert.ok(fs.existsSync(launcherPath()));
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(launcherPath()), 'launcher.json'), 'utf8')).roots[profile], pluginRoot);
  assert.match(fs.readFileSync(path.join(path.dirname(settingsFile()), 'settings.json.quotameter.bak'), 'utf8'), /echo mine/);
  assert.equal(setup(pluginRoot).changed, false, 'running it again is a no-op');
  const removed = setup(pluginRoot, { remove: true });
  assert.equal(removed.changed, true);
  const s2 = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  assert.deepEqual(s2.statusLine, { type: 'command', command: 'echo mine', padding: 1 });
  assert.equal(loadConfig().wrapCommands, undefined);
  // An empty settings.json counts as no settings, and the backup is the user's own state.
  fs.writeFileSync(settingsFile(), '');
  setup(pluginRoot);
  assert.ok(isOurs(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).statusLine.command));
  assert.equal(fs.readFileSync(path.join(path.dirname(settingsFile()), 'settings.json.quotameter.bak'), 'utf8'), '');
  setup(pluginRoot, { remove: true });
  // With no previous status line, remove deletes the entry.
  fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus' }));
  setup(pluginRoot);
  setup(pluginRoot, { remove: true });
  assert.equal('statusLine' in JSON.parse(fs.readFileSync(settingsFile(), 'utf8')), false);
});

test('setup: the launcher runs the installed plugin and prints both limits', async () => {
  const { execFileSync } = await import('node:child_process');
  const { setup, launcherPath } = await import('../plugins/quotameter/lib/setup.js');
  setup(pluginRoot);
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1791873600 }, seven_day: { used_percentage: 7 } } });
  const out = execFileSync(process.execPath, [launcherPath()], { input, encoding: 'utf8', env: process.env });
  assert.match(out, /5h 42% \(resets .+\) \| wk 7%/);
  // A folder whose package.json is not this plugin is refused, even with a statusline.js in it.
  const other = path.join(fs.mkdtempSync(path.join(home, 'other-')), 'plugin');
  fs.mkdirSync(path.join(other, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-plugin', type: 'module' }));
  fs.writeFileSync(path.join(other, 'lib', 'statusline.js'), 'export const statusline = () => process.stdout.write("hijacked");');
  fs.writeFileSync(path.join(path.dirname(launcherPath()), 'launcher.json'), JSON.stringify({ roots: { [path.resolve(process.env.CLAUDE_CONFIG_DIR)]: other } }));
  const refused = execFileSync(process.execPath, [launcherPath()], { input, encoding: 'utf8', env: process.env });
  assert.match(refused, /plugin not found/);
  assert.ok(!refused.includes('hijacked'));
  setup(pluginRoot, { remove: true });
});

test('warnings: once per window and level, nothing when off or after reset', async () => {
  const { warningFor, promptHook } = await import('../plugins/quotameter/lib/warn.js');
  const { append } = await import('../plugins/quotameter/lib/store.js');
  const now = Date.parse('2026-10-20T10:00:00Z');
  const latest = { session: { ts: iso(now - 60000), percent: 85, resetsAt: iso(now + 2 * H) }, weekly_all: { ts: iso(now - 60000), percent: 50, resetsAt: iso(now + 48 * H) } };
  const w = warningFor(latest, { warnAt: 80 }, now, []);
  assert.match(w.message, /5-hour limit at 85%, resets in 2 h 0 m/);
  assert.ok(!/weekly/.test(w.message));
  assert.equal(warningFor(latest, { warnAt: 80 }, now, w.keys), null, 'not twice for the same window and level');
  latest.session.percent = 96;
  assert.match(warningFor(latest, { warnAt: 80 }, now, w.keys).message, /96%/, 'a new level fires again');
  assert.equal(warningFor(latest, { warnAt: 0 }, now, []), null, 'warnAt 0 turns it off');
  latest.session.resetsAt = iso(now - 1);
  assert.equal(warningFor(latest, { warnAt: 80 }, now, []), null, 'a window that reset is not warned about');
  // Through a store of its own: a fresh reading means no poll, and the warning is remembered.
  const saved = process.env.QUOTAMETER_HOME;
  process.env.QUOTAMETER_HOME = path.join(fs.mkdtempSync(path.join(home, 'warn-')), 'store');
  try {
    append('live', [{ ts: new Date().toISOString(), source: 'statusline', kind: 'session', group: 'session', percent: 91, resetsAt: iso(Date.now() + H) }]);
    const first = promptHook({ warnAt: 80, pollIntervalMin: 10 });
    assert.equal(first.poll, false);
    assert.match(first.message, /91%/);
    assert.equal(promptHook({ warnAt: 80, pollIntervalMin: 10 }).message, null);
  } finally {
    process.env.QUOTAMETER_HOME = saved;
  }
});

test('tokens left are fresh tokens: cache reads are listed, never extrapolated', async () => {
  const now = Date.parse('2026-12-01T03:00:00Z');
  const reset = now + 2 * H, start = reset - 5 * H;
  writeLog(home, 'p-fresh', 'f.jsonl', [
    assistant({ id: 'f1', session: 'sf', ts: iso(start + H), u: usage({ input: 1000, output: 1000, read: 2000000 }) }),
    usageRecord({ ts: iso(start + 1.5 * H), fivePct: 50, weekPct: 5, fiveReset: iso(reset), weekReset: iso(now + 3 * 24 * H) }),
  ]);
  await ingest({ poll: false });
  const s = analyze({ now, config: { plan: 'pro', codeOnlyWindows: [] } });
  const w = s.windows.h5;
  assert.equal(w.tokensCacheRead, 2000000);
  assert.equal(w.tokensFresh, 2000);
  assert.ok(w.tokensLeft < 20000, `tokens left was ${w.tokensLeft}, cache reads must not inflate it`);
  assert.equal(s.breakdown.h5.tiles.freshTokens, 2000);
  assert.equal(s.breakdown.h5.projects[0].tokens, 2000, 'rows beside the chat row use fresh tokens too');
  // A window marked code-only counts as clean for calibration.
  const marked = analyze({ now, config: { plan: 'pro', codeOnlyWindows: [reset] } });
  assert.equal(marked.calibration.h5.marked, 1);
  assert.ok(marked.calibration.h5.cleanWindows >= 1, 'a marked window is clean whatever else happened in it');
});

test('mark code-only: records the current window in config', async () => {
  const { execFileSync } = await import('node:child_process');
  const { append } = await import('../plugins/quotameter/lib/store.js');
  const { loadConfig } = await import('../plugins/quotameter/lib/config.js');
  const saved = process.env.QUOTAMETER_HOME;
  process.env.QUOTAMETER_HOME = path.join(fs.mkdtempSync(path.join(home, 'mark-')), 'store');
  try {
    const resets = iso(Math.round((Date.now() + 3 * H) / 60000) * 60000);
    append('live', [{ ts: new Date().toISOString(), source: 'statusline', kind: 'session', group: 'session', percent: 20, resetsAt: resets }]);
    const cli = path.join(pluginRoot, 'bin', 'quotameter.js');
    assert.match(execFileSync(process.execPath, [cli, 'mark', 'code-only'], { encoding: 'utf8', env: process.env }), /Marked the 5-hour window/);
    assert.deepEqual(loadConfig().codeOnlyWindows, [Date.parse(resets)]);
    execFileSync(process.execPath, [cli, 'mark', 'code-only', '--undo'], { encoding: 'utf8', env: process.env });
    assert.deepEqual(loadConfig().codeOnlyWindows, []);
  } finally {
    process.env.QUOTAMETER_HOME = saved;
  }
});

test('claude.ai connectors are told apart from local MCP servers', async () => {
  const { isConnector } = await import('../plugins/quotameter/lib/model/analyze.js');
  assert.ok(isConnector('claude_ai_Vercel') && isConnector('claude.ai TomTom Maps'));
  assert.ok(!isConnector('github') && !isConnector('my-claude-ai-notes'));
});

test('a Windows project path gives the same project name on every platform', async () => {
  const { folderName } = await import('../plugins/quotameter/lib/model/breakdown.js');
  assert.equal(folderName('C:\\Users\\dev\\My Projects\\app\\'), 'app');
  assert.equal(folderName('/home/dev/app'), 'app');
  assert.equal(folderName('\\\\server\\share\\repo'), 'repo');
});

test('the report page script compiles, and a report without readings explains itself', async () => {
  const { execFileSync } = await import('node:child_process');
  const { pageScript, renderText } = await import('../plugins/quotameter/lib/report/render.js');
  const empty = fs.mkdtempSync(path.join(home, 'empty-'));
  const saved = { home: process.env.QUOTAMETER_HOME, cfg: process.env.CLAUDE_CONFIG_DIR };
  process.env.QUOTAMETER_HOME = path.join(empty, 'store');
  process.env.CLAUDE_CONFIG_DIR = path.join(empty, 'claude');
  try {
    const s = analyze({ pollError: 'could not run claude: ENOENT' });
    assert.equal(s.windows.h5, null);
    assert.match(renderText(s), /No limit readings yet/);
    assert.match(renderText(s), /ENOENT/);
    const file = path.join(empty, 'page.mjs');
    fs.writeFileSync(file, pageScript(s));
    execFileSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  } finally {
    process.env.QUOTAMETER_HOME = saved.home;
    process.env.CLAUDE_CONFIG_DIR = saved.cfg;
  }
});

// ---------- 0.3.0 ----------

const cliPath = path.join(pluginRoot, 'bin', 'quotameter.js');
const hookPath = path.join(pluginRoot, 'bin', 'hook.js');
// A store of its own for tests that write readings or sessions, so they
// cannot hijack the current window of other tests.
function ownStore(name) {
  const saved = process.env.QUOTAMETER_HOME;
  process.env.QUOTAMETER_HOME = path.join(fs.mkdtempSync(path.join(home, `${name}-`)), 'store');
  return () => (process.env.QUOTAMETER_HOME = saved);
}
const msgRow = (o) => ({ id: o.id, ts: o.ts, session: o.session || 'r1', entrypoint: 'cli', cwd: o.cwd || '/home/dev/app', branch: 'main', model: o.model || 'claude-opus-5-5', agent: null, skill: null, tools: [], speed: 'standard', in: o.in || 10, out: o.out || 2000, cw5: o.cw5 || 20000, cw1h: 0, cr: o.cr || 100000, final: true, cost: o.cost || 0.5 });

test('advice for the assistant: only when tight, once per 5% band, never a user message', async () => {
  const { adviceFor } = await import('../plugins/quotameter/lib/warn.js');
  const now = Date.parse('2026-10-20T10:00:00Z');
  const latest = { session: { ts: iso(now), percent: 72, resetsAt: iso(now + H) }, weekly_all: { ts: iso(now), percent: 30, resetsAt: iso(now + 48 * H) } };
  const a = adviceFor(latest, { adviseAt: 70 }, now, []);
  assert.match(a.message, /5-hour limit at 72%/);
  assert.match(a.message, /Sonnet or Haiku/);
  assert.equal(adviceFor(latest, { adviseAt: 70 }, now, [a.key]), null, 'same band: said already');
  latest.session.percent = 76;
  assert.ok(adviceFor(latest, { adviseAt: 70 }, now, [a.key]), 'next band: said again');
  latest.session.percent = 50;
  assert.equal(adviceFor(latest, { adviseAt: 70 }, now, []), null, 'not tight');
  latest.weekly_all.percent = 85;
  assert.match(adviceFor(latest, { adviseAt: 70 }, now, []).message, /weekly at 85%/, 'the weekly limit counts from adviseAt + 10');
  assert.equal(adviceFor(latest, { adviseAt: 0 }, now, []), null, 'adviseAt 0 turns it off');
  // Through promptHook: advice without any message for the user, and remembered.
  const { promptHook } = await import('../plugins/quotameter/lib/warn.js');
  const { append } = await import('../plugins/quotameter/lib/store.js');
  const restore = ownStore('advice');
  try {
    append('live', [{ ts: new Date().toISOString(), source: 'statusline', kind: 'session', group: 'session', percent: 72, resetsAt: iso(Date.now() + H) }]);
    const r = promptHook({ adviseAt: 70, warnAt: 80, pollIntervalMin: 10 });
    assert.match(r.advice, /72%/);
    assert.equal(r.message, null, 'advice is not a user message');
    assert.equal(promptHook({ adviseAt: 70, warnAt: 80, pollIntervalMin: 10 }).advice, null, 'same band, not again');
  } finally {
    restore();
  }
  latest.session.percent = 90;
  latest.session.resetsAt = iso(now - 1);
  latest.weekly_all.percent = 30;
  assert.equal(adviceFor(latest, { adviseAt: 70 }, now, []), null, 'a window that reset is ignored');
});

test('status line shows the session share and context, with k and without', async () => {
  const input = { rate_limits: { five_hour: { used_percentage: 42, resets_at: 1791873600 }, seven_day: { used_percentage: 7 } }, cost: { total_cost_usd: 1.25 }, context_window: { used_percentage: 61.7 } };
  const base = { session: 's1', resetsAt: 1791873600, cost: 0 };
  assert.match(statusText({ ...input, session_id: 's1' }, null, base), /^5h 42% \(this window \$1\.25, resets .+\) \| ctx 62% \| wk 7%$/);
  assert.match(statusText({ ...input, session_id: 's1' }, { h5: 4 }, base), /this window 5\.0%/);
  assert.match(statusText(input, { h5: 4 }), /^5h 42% \(resets .+\) \| ctx 62% \| wk 7%$/, 'no window base, no share');
  assert.match(statusText({ ...input, session_id: 's1', context_window: { used_percentage: null } }, null, base), /^5h 42% \(this window \$1\.25, resets .+\) \| wk 7%$/, 'no context before the first call');
  assert.equal(statusText({ context_window: { used_percentage: 3 } }), 'ctx 3%');
});

test('context nudge: once per session, past the threshold, priced per turn', async () => {
  const { contextNudge } = await import('../plugins/quotameter/lib/warn.js');
  const turn = { session: 'sx', cost: 2, ctx: 162000, model: 'claude-opus-5-5', ts: iso(Date.now()) };
  const n = contextNudge(turn, { ctxNudgeAt: 150000 }, { h5: 3 }, []);
  assert.match(n.message, /162K tokens/);
  assert.equal(contextNudge({ ...turn, ts: iso(Date.now() - 5 * 60000) }, { ctxNudgeAt: 150000 }, { h5: 3 }, []), null, 'a stale row could be another session');
  assert.match(n.message, /% of the 5-hour window per turn/);
  assert.equal(contextNudge(turn, { ctxNudgeAt: 150000 }, { h5: 3 }, [n.key]), null);
  assert.equal(contextNudge({ ...turn, ctx: 90000 }, { ctxNudgeAt: 150000 }, null, []), null);
  assert.equal(contextNudge(turn, { ctxNudgeAt: 0 }, null, []), null);
});

test('session receipt and weekly digest: once each, only at a real start, nothing after', async () => {
  const restore = ownStore('digest');
  try {
    const { append, writeK } = await import('../plugins/quotameter/lib/store.js');
    const { startMessages } = await import('../plugins/quotameter/lib/digest.js');
    const now = Date.now();
    const weekEnd = Math.round((now - 2 * H) / 60000) * 60000;
    append('messages', [
      msgRow({ id: 'd1', ts: iso(weekEnd - 3 * 24 * H), session: 'sd', cwd: '/home/dev/billing-app', cost: 3 }),
      msgRow({ id: 'd2', ts: iso(weekEnd - 3 * 24 * H + H), session: 'sd', cwd: '/home/dev/billing-app', model: 'claude-haiku-5-5', cost: 0.1 }),
    ]);
    append('sessions', [{ session: 'sd', entrypoint: 'cli', start: iso(weekEnd - 3 * 24 * H), end: iso(weekEnd - 3 * 24 * H + 2 * H), cwd: '/home/dev/billing-app' }]);
    append('costs', [{ session: 'sd', run: 'r', ts: iso(weekEnd - 3 * 24 * H + 2 * H), totalCost: 3.5, models: {} }]);
    append('readings', [
      { ts: iso(weekEnd - 4 * 24 * H), source: 'usage-poll', kind: 'weekly_all', group: 'weekly', percent: 20, resetsAt: iso(weekEnd) },
      { ts: iso(weekEnd - 60000), source: 'usage-poll', kind: 'weekly_all', group: 'weekly', percent: 62, resetsAt: iso(weekEnd) },
    ]);
    writeK({ h5: 4, wk: 0.5, model: 'claude-opus-5-5' });
    // The session that is starting is never its own receipt.
    const first = startMessages({ source: 'startup', session_id: 'sd' }, now);
    assert.equal(first.length, 1, first.join(' | '));
    assert.match(first[0], /Last week you used 62% of the weekly limit over 1 session/);
    assert.match(first[0], /mostly in billing-app/);
    const lines = startMessages({ source: 'startup', session_id: 'other' }, now);
    assert.equal(lines.length, 1, lines.join(' | '));
    assert.match(lines[0], /Last session used 14% of the 5-hour limit/);
    assert.match(lines[0], /2 h 0 m/);
    assert.deepEqual(startMessages({ source: 'startup' }, now), [], 'said once');
    assert.deepEqual(startMessages({ source: 'compact' }, now), [], 'a compaction is not a session start');
    const resume = startMessages({ source: 'resume', prompt_cache_likely_expired: true, seconds_since_last_response: 900, estimated_cache_write_usd: 0.8 }, now);
    assert.match(resume[0], /Resuming after 15 m rebuilds the prompt cache: about \$0\.80 at list price \(3\.2% of the 5-hour window\)/);
  } finally {
    restore();
  }
});

test('precheck: exit 0 with room, 1 without, 2 with no reading', async () => {
  const restore = ownStore('precheck');
  try {
    const { spawnSync } = await import('node:child_process');
    const { append } = await import('../plugins/quotameter/lib/store.js');
    const run = (...a) => spawnSync(process.execPath, [cliPath, 'precheck', '--no-poll', ...a], { encoding: 'utf8', env: process.env });
    assert.equal(run().status, 2);
    append('live', [{ ts: new Date().toISOString(), source: 'statusline', kind: 'session', group: 'session', percent: 60, resetsAt: iso(Date.now() + 2 * H) }]);
    const ok = run('--min', '25');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /40% left/);
    const no = run('--min', '50');
    assert.equal(no.status, 1);
    assert.match(no.stdout, /Aborted: 5-hour limit has 40% left, 50% required/);
    assert.equal(run('--window', 'week').status, 2, 'no weekly reading yet');
  } finally {
    restore();
  }
});

test('what fits before the reset reads naturally and never claims too much', async () => {
  const { fitsText } = await import('../plugins/quotameter/lib/report/format.js');
  const w = { resetsAt: iso(Date.now() + 42 * 60000) };
  assert.equal(fitsText(w, { left: { quick: 3, typical: 1, heavy: 0 } }, { medianMs: 20 * 60000 }), 'Before the reset (in 42 m) there is room for 3 quick tasks or 1 typical session; a heavy one would not fit.');
  assert.match(fitsText(w, { left: { quick: 1, typical: 0, heavy: 0 } }, null), /room for 1 quick task, not a typical session/);
  assert.match(fitsText(w, { left: { quick: 0, typical: 0, heavy: 0 } }, null), /no room for even a quick task/);
  assert.match(fitsText(w, { left: { quick: 40, typical: 5, heavy: 2 } }, null), /many quick tasks or 5 typical sessions, even 2 heavy ones/);
  assert.match(fitsText(w, { left: { quick: 3, typical: 1, heavy: 0 } }, { medianMs: 90 * 60000 }), /and only 42 m, less than your usual session/);
  assert.equal(fitsText(w, null, null), '', 'no calibration, no claim');
  assert.match(fitsText(w, { left: { quick: null, typical: 1, heavy: 0 } }, null), /room for 1 typical session; a heavy one would not fit/, 'quick unknown when a quarter of sessions cost nothing');
  assert.equal(fitsText({ resetsAt: iso(Date.now() - 1) }, { left: { quick: 3, typical: 1, heavy: 0 } }, null), '');
});

test('reset alarm: fires at the reset, stays quiet when stale or far away', async () => {
  const { alarm, alarmFor } = await import('../plugins/quotameter/lib/notify.js').then(async (n) => ({ ...n, ...(await import('../plugins/quotameter/lib/warn.js')) }));
  const fired = [];
  const notifyFn = (t, b) => fired.push(b);
  let t = 1000;
  const clock = () => t;
  const p = alarm(1600, { now: 1000, notifyFn, step: 100, clock });
  await new Promise((r) => setTimeout(r, 120));
  t = 1700; // the reset passed while we slept
  assert.equal(await p, true);
  assert.match(fired[0], /5-hour limit has reset/);
  assert.equal(await alarm(1000, { now: 1000, notifyFn, clock: () => 1000 + 31 * 60000 }), false, 'woke up too late: silent');
  assert.equal(await alarm(Date.now() + 9 * 24 * H, { notifyFn }), false, 'too far away');
  const now = Date.now();
  const latest = { session: { ts: iso(now), percent: 96, resetsAt: iso(now + H) } };
  const a = alarmFor(latest, { resetAlarm: true }, now, []);
  assert.equal(a.kind, '5-hour');
  assert.equal(alarmFor(latest, { resetAlarm: true }, now, [a.key]), null, 'one alarm per window');
  assert.equal(alarmFor(latest, { resetAlarm: false }, now, []), null);
  assert.equal(alarmFor({ session: { ...latest.session, percent: 80 } }, { resetAlarm: true }, now, []), null);
});

test('other computers: their Code usage is Code, not chat, and calibration stays right', async () => {
  const { append, readState } = await import('../plugins/quotameter/lib/store.js');
  const { saveConfig, loadConfig } = await import('../plugins/quotameter/lib/config.js');
  const { exportSync, importSync, dedupeReadings } = await import('../plugins/quotameter/lib/sync.js');
  const syncDir = fs.mkdtempSync(path.join(home, 'sync-'));
  const now = Date.parse('2027-03-01T03:00:00Z');
  const reset = now + 2 * H, start = reset - 5 * H;
  // Machine A (the laptop): Code work between start+1h and start+2h.
  const restoreA = ownStore('laptop');
  saveConfig({ ...loadConfig(), syncDir, machineName: 'Laptop' });
  for (let i = 0; i < 10; i++) append('messages', [msgRow({ id: `l${i}`, ts: iso(start + H + i * 6 * 60000), session: 'ls', cwd: '/home/dev/secret-client', cost: 0.5 })]);
  append('costs', [{ session: 'ls', run: 'r', ts: iso(start + 2 * H), totalCost: 5, models: {} }]);
  append('readings', [{ ts: iso(start + 1.5 * H), source: 'usage-poll', kind: 'session', group: 'session', percent: 6, resetsAt: iso(reset) }]);
  const ex = exportSync(loadConfig(), readState(), now);
  assert.equal(ex.rows, 10);
  const text = fs.readFileSync(ex.file, 'utf8');
  assert.ok(!text.includes('secret-client') && !text.includes('"ls"'), 'no folder names or session ids cross');
  restoreA();
  // Machine B (this one): no Code work, but the limit rose 0 -> 10 while A worked.
  const restoreB = ownStore('desktop');
  try {
    saveConfig({ ...loadConfig(), syncDir, machineName: 'Desktop' });
    append('readings', [
      { ts: iso(start + 0.5 * H), source: 'usage-poll', kind: 'session', group: 'session', percent: 0, resetsAt: iso(reset) },
      { ts: iso(start + 2.5 * H), source: 'usage-poll', kind: 'session', group: 'session', percent: 10, resetsAt: iso(reset) },
      { ts: iso(start + 2.5 * H), source: 'usage-poll', kind: 'weekly_all', group: 'weekly', percent: 3, resetsAt: iso(now + 3 * 24 * H) },
    ]);
    const imp = importSync(loadConfig(), now);
    assert.equal(imp.messages.length, 10);
    assert.equal(imp.machines[0].name, 'Laptop');
    assert.equal(dedupeReadings([...imp.readings, ...imp.readings]).length, 1);
    const s = analyze({ now, config: loadConfig() });
    assert.ok(s.attribution.h5.remote > 9, `remote share was ${s.attribution.h5.remote}`);
    assert.ok(s.attribution.h5.chat < 0.5, `chat was ${s.attribution.h5.chat}`);
    assert.ok(s.breakdown.h5.projects.some((p) => p.name === 'Other computer: Laptop'));
    assert.equal(s.sources.machines[0].name, 'Laptop');
    // A half-synced file and rows from the future are skipped.
    fs.writeFileSync(path.join(syncDir, 'quotameter-deadbeef.json'), '{"schema":1,"machineId":"deadbeef","rows":[{"id":"x","ts":"2027-03-');
    fs.writeFileSync(path.join(syncDir, 'quotameter-cafe0001.json'), JSON.stringify({ schema: 1, machineId: 'cafe0001', name: 'Clock', rows: [{ id: 'f', ts: iso(now + H), cost: 1 }], costs: [], readings: [] }));
    assert.equal(importSync(loadConfig(), now).messages.length, 10);
  } finally {
    restoreB();
  }
});

test('team digest carries numbers only, and the report reads several of them', async () => {
  const { teamDigest, teamReport, readDigests } = await import('../plugins/quotameter/lib/team.js');
  const s = analyze({ now: Date.parse('2026-10-20T03:00:00Z'), config: { plan: 'max5', codeOnlyWindows: [] } });
  const d = teamDigest(s, { label: 'Pat <x>' });
  assert.equal(d.label, 'Pat x');
  const text = JSON.stringify(d);
  for (const bad of ['/p/', 'invoice-app', 'feat/', 'SECRET', '"session"', 'title', 'cwd']) assert.ok(!text.includes(bad), `digest contains ${bad}`);
  assert.equal(d.schema, 1);
  const dir = fs.mkdtempSync(path.join(home, 'team-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(d));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...d, label: 'Sam', listCost: 40, idleMcpTokens: 3000, idleMcpServers: 2 }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"schema":9}');
  const out = teamReport(readDigests([path.join(dir, 'a.json'), path.join(dir, 'b.json'), path.join(dir, 'bad.json')]));
  assert.match(out, /Skipped .*bad\.json: not a quotameter team digest/);
  assert.match(out, /\| Pat x/);
  assert.match(out, /\| Sam/);
  assert.match(out, /\| All/);
  assert.match(out, /- Sam: .*3\.0K tokens of unused MCP servers/);
});

test('file guard: asks before a big Read, lets everything else through, stores nothing', async () => {
  const { guardDecision } = await import('../plugins/quotameter/lib/guard.js');
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(home, 'guard-'));
  const big = path.join(dir, 'bundle.js');
  fs.writeFileSync(big, 'x'.repeat(700 * 1024));
  const small = path.join(dir, 'small.js');
  fs.writeFileSync(small, 'ok');
  const k = { h5: 4, model: 'claude-opus-5-5' };
  const d = guardDecision({ tool_name: 'Read', tool_input: { file_path: big } }, { fileGuardKB: 512 }, k);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /bundle\.js is 0\.7 MB, about 179K tokens, roughly 2\.9% of your 5-hour window/);
  assert.equal(guardDecision({ tool_name: 'Read', tool_input: { file_path: small } }, { fileGuardKB: 512 }, k), null);
  assert.equal(guardDecision({ tool_name: 'Read', tool_input: { file_path: path.join(dir, 'missing') } }, { fileGuardKB: 512 }, k), null);
  assert.equal(guardDecision({ tool_name: 'Grep', tool_input: { file_path: big } }, { fileGuardKB: 512 }, k), null);
  assert.equal(guardDecision({ tool_name: 'Read', tool_input: { file_path: big } }, { fileGuardKB: 0 }, k), null, 'off');
  assert.ok(guardDecision({ tool_name: 'Read', tool_input: { file_path: 'bundle.js' }, cwd: dir }, { fileGuardKB: 512 }, null), 'relative to the session folder');
  // Through the hook entry point, and nothing about the file lands in the store.
  const restore = ownStore('guardhook');
  try {
    const out = execFileSync(process.execPath, [hookPath, 'pretool'], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: big } }), encoding: 'utf8', env: process.env });
    assert.match(out, /"permissionDecision":"ask"/);
    const stored = fs.readdirSync(process.env.QUOTAMETER_HOME).map((f) => fs.readFileSync(path.join(process.env.QUOTAMETER_HOME, f), 'utf8')).join('');
    assert.ok(!stored.includes('bundle.js'));
  } finally {
    restore();
  }
});

const DAY_MS = 24 * H;

// ---------- 0.3.1 ----------

test('the Fable window: only Fable usage moves it, and it gets its own calibration', async () => {
  const restore = ownStore('fable');
  try {
    const { append } = await import('../plugins/quotameter/lib/store.js');
    const now = Date.parse('2027-05-10T03:00:00Z');
    const weekReset = now + 2 * 24 * H, start = weekReset - 7 * DAY_MS;
    append('messages', [
      msgRow({ id: 'fb1', ts: iso(start + 10 * H), session: 'sf', model: 'claude-fable-5-1', cost: 4 }),
      msgRow({ id: 'op1', ts: iso(start + 11 * H), session: 'so', model: 'claude-opus-5-5', cost: 4 }),
    ]);
    append('costs', [{ session: 'sf', run: 'r', ts: iso(start + 12 * H), totalCost: 4, models: {} }, { session: 'so', run: 'r', ts: iso(start + 12 * H), totalCost: 4, models: {} }]);
    append('readings', [
      { ts: iso(start + 9 * H), source: 'usage-poll', kind: 'session', group: 'session', percent: 0, resetsAt: iso(start + 14 * H) },
      { ts: iso(start + 9 * H), source: 'usage-poll', kind: 'weekly_all', group: 'weekly', percent: 0, resetsAt: iso(weekReset) },
      { ts: iso(start + 9 * H), source: 'usage-poll', kind: 'weekly_scoped', group: 'weekly', percent: 0, resetsAt: iso(weekReset) },
      { ts: iso(start + 13 * H), source: 'usage-poll', kind: 'session', group: 'session', percent: 16, resetsAt: iso(start + 14 * H) },
      { ts: iso(start + 13 * H), source: 'usage-poll', kind: 'weekly_all', group: 'weekly', percent: 4, resetsAt: iso(weekReset) },
      { ts: iso(start + 13 * H), source: 'usage-poll', kind: 'weekly_scoped', group: 'weekly', percent: 10, resetsAt: iso(weekReset) },
    ]);
    const s = analyze({ now, config: { plan: 'max5', codeOnlyWindows: [] } });
    assert.equal(s.windows.fable.pct, 10);
    assert.ok(Math.abs(s.calibration.fable.k - 2.5) < 0.01, `fable k was ${s.calibration.fable.k}: 10 points for $4 of Fable only`);
    assert.ok(s.attribution.fable.cli > 9.9 && s.attribution.fable.chat < 0.1, JSON.stringify(s.attribution.fable));
    assert.ok(s.breakdown.fable.models.every((m) => m.chat || m.unitemised || /fable/.test(m.model)), 'only Fable rows in the Fable breakdown');
    assert.ok(s.breakdown.wk.models.some((m) => /opus/.test(m.model)), 'the weekly breakdown still has everything');
    const { renderText } = await import('../plugins/quotameter/lib/report/render.js');
    assert.match(renderText(s), /Fable\s+10% used/);
    // A plan without the cap: no window, no row.
    const none = analyze({ now, data: { ...(await import('../plugins/quotameter/lib/model/load.js')).loadData(undefined, { now }), readings: [] }, config: { plan: 'pro', codeOnlyWindows: [] } });
    assert.equal(none.windows.fable, null);
  } finally {
    restore();
  }
});

test('status line: the share is of this window, and the Fable cap rides along', async () => {
  const { statusText, windowBase } = await import('../plugins/quotameter/lib/statusline.js');
  const input = { session_id: 's1', rate_limits: { five_hour: { used_percentage: 42, resets_at: 1791873600 }, seven_day: { used_percentage: 7 } }, cost: { total_cost_usd: 10 } };
  assert.match(statusText(input, { h5: 2 }, { session: 's1', resetsAt: 1791873600, cost: 8 }), /this window 4\.0%/, '(10 - 8) x 2');
  assert.ok(!/this window/.test(statusText(input, { h5: 2 }, { session: 'other', resetsAt: 1791873600, cost: 8 })), 'a base from another session gives no share');
  assert.match(statusText(input, null, null, { percent: 42, resetsAt: iso(Date.now() + H) }), /\| fable 42%$/);
  assert.ok(!/fable/.test(statusText(input, null, null, { percent: 42, resetsAt: iso(Date.now() - 1) })), 'a reset cap is not shown');
  const restore = ownStore('base');
  try {
    const first = windowBase(input);
    assert.equal(first.cost, 0, 'a session seen for the first time starts at zero');
    assert.equal(windowBase(input).cost, 0, 'same window: same base');
    const rolled = windowBase({ ...input, rate_limits: { five_hour: { used_percentage: 1, resets_at: 1791891600 } }, cost: { total_cost_usd: 15 } });
    assert.equal(rolled.cost, 10, 'the window rolled over: the total before this turn stays before, the turn itself counts in the new window');
    const other = windowBase({ ...input, session_id: 's2', cost: { total_cost_usd: 3 } });
    assert.equal(other.cost, 0);
    assert.equal(windowBase({ ...input, rate_limits: { five_hour: { used_percentage: 1, resets_at: 1791891600 } }, cost: { total_cost_usd: 16 } }).cost, 10, 'another session does not disturb the first one');
  } finally {
    restore();
  }
});

test('warnings, precheck and k.json know the Fable window', async () => {
  const { warningFor } = await import('../plugins/quotameter/lib/warn.js');
  const now = Date.parse('2026-10-20T10:00:00Z');
  const w = warningFor({ weekly_scoped: { ts: iso(now), percent: 96, resetsAt: iso(now + 48 * H) } }, { warnAt: 80 }, now, []);
  assert.match(w.message, /Fable limit at 96%/);
  const restore = ownStore('fablecheck');
  try {
    const { spawnSync } = await import('node:child_process');
    const { append, readK } = await import('../plugins/quotameter/lib/store.js');
    append('live', [{ ts: new Date().toISOString(), source: 'statusline', kind: 'weekly_scoped', group: 'weekly', percent: 70, resetsAt: iso(Date.now() + 2 * DAY_MS) }]);
    const r = spawnSync(process.execPath, [cliPath, 'precheck', '--no-poll', '--window', 'fable', '--min', '25'], { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /Fable limit has 30% left/);
    assert.equal(readK(), null);
    await ingest({ poll: false });
    assert.ok(readK()?.ts, 'the background ingest writes k.json for the hooks');
  } finally {
    restore();
  }
});
