// The report page's script. It runs in the browser with the summary in S,
// the formatters from format.js, and no other dependencies. render.js embeds
// it into template.html; a test compiles it so a syntax error fails npm test.

/* global S */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tt = $('#tt');
function tip(el, html) {
  el.addEventListener('mouseenter', () => { tt.innerHTML = html; tt.style.opacity = 1; });
  el.addEventListener('mousemove', (e) => { tt.style.left = Math.min(e.clientX + 12, innerWidth - tt.offsetWidth - 8) + 'px'; tt.style.top = (e.clientY + 14) + 'px'; });
  el.addEventListener('mouseleave', () => (tt.style.opacity = 0));
  // Touch screens have no hover: a tap opens the tooltip, a tap elsewhere closes it.
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    tt.innerHTML = html;
    tt.style.opacity = 1;
    tt.style.left = Math.min(e.clientX + 12, innerWidth - tt.offsetWidth - 8) + 'px';
    tt.style.top = (e.clientY + 14) + 'px';
  });
}
document.addEventListener('click', () => (tt.style.opacity = 0));
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
const status = (bad, text) => `<span class="status"><i style="background:var(${bad ? '--critical' : '--good'})"></i>${text}</span>`;

// ---------- header ----------
function header() {
  const plan = { pro: 'Pro', max5: 'Max 5x', max20: 'Max 20x' }[S.config.plan] || S.config.plan;
  $('#hdrSub').textContent = `${plan} plan · generated ${new Date(S.generatedAt).toLocaleString()}`;
  const src = S.sources;
  const chip = (on, label, detail) => `<span class="chip ${on ? 'on' : 'off'}"><b>${label}</b> ${esc(detail)}</span>`;
  $('#chips').innerHTML = [
    chip(src.usagePoll, '/usage', src.usagePoll ? 'read ' + dayTime(src.usagePoll) : 'no readings yet'),
    chip(src.messages, 'Code logs', `${src.sessions} sessions`),
    chip(src.desktop || src.surfaces.includes('claude-desktop'), 'Desktop', src.desktop || src.surfaces.includes('claude-desktop') ? 'detected' : 'not found'),
    src.machines?.length ? chip(true, 'Other computers', src.machines.map((m) => m.name).join(', ')) : '',
    src.statusline ? chip(true, 'Status line', 'on') : '<span class="hint" title="The status line records your limits every minute while Claude Code is open, which makes every number here more accurate.">Live readings off · run <code>/quotameter:setup</code></span>',
    S.redacted === 'share' ? '<span class="hint">Shareable copy: project names, branches and session titles hidden</span>' : '',
    '<button class="theme-btn" id="themeBtn" type="button">Toggle theme</button>',
  ].join('');
  if (!S.windows.h5 && !S.windows.wk) {
    document.body.classList.add('no-readings');
    const days = S.insights.historyStart ? Math.max(1, Math.ceil((Date.parse(S.generatedAt) - Date.parse(S.insights.historyStart)) / 864e5)) : 0;
    const have = src.messages ? `quotameter already has ${fmt(src.messages)} Claude Code responses from ${src.sessions} session${src.sessions === 1 ? '' : 's'}${days ? ` over ${days} day${days === 1 ? '' : 's'}` : ''}, so the breakdowns by model, project and session below are ready.` : 'No Claude Code logs were found yet, so there is nothing to break down until you use Claude Code with the plugin installed.';
    const why = src.pollError ? `The last <code>/usage</code> reading failed: ${esc(src.pollError)}. Run <code>quotameter doctor</code> to see why.` : 'A reading is taken when a Claude Code session starts and every ten minutes while you work; the first one has not arrived yet, or run <code>quotameter poll</code> now.';
    $('#calNote').innerHTML = `<div class="cal"><b>No limit readings yet.</b> ${have}<br>The meters, the chat estimate, sessions left and the plan verdict need readings of your 5-hour and weekly limits. ${why}<br><code>/quotameter:setup</code> adds a status line that records a reading every minute while Claude Code is open, which makes every number here better.</div>`;
  } else if (!S.windows.h5) {
    $('#calNote').innerHTML = '<div class="cal"><b>No 5-hour reading in the current window yet.</b> Run <code>quotameter poll</code> or start a Claude Code session with the plugin installed.</div>';
  }
}
// Small "estimate" tag for chat figures while calibration is provisional.
const estTag = () => S.calibration.h5?.provisional ? `<span class="est" title="Chat figures firm up after about 5 windows of data (${S.calibration.h5.windows} so far).">early estimate</span>` : '';

// ---------- at a glance ----------
function glance() {
  const rows = [['5-hour session', S.windows.h5], ['Weekly · all models', S.windows.wk]].filter(([, w]) => w);
  if (!rows.length) { $('#glance').innerHTML = '<tr><td class="empty">Waiting for the first limit reading.</td></tr>'; return; }
  const h5 = S.windows.h5;
  $('#glanceSub').textContent = h5?.tokensPerPoint ? `Fresh tokens are input, output and cache writes; cache reads count for a tenth or less and are listed, not extrapolated. Tokens left assume your current model mix (1% of the 5-hour window ≈ ${fmt(h5.tokensPerPoint)} fresh tokens right now); more Opus lowers the number.` : '';
  $('#glance').innerHTML = `<tr><th>Window</th><th class="n">Fresh tokens · measured</th><th class="n">Cache reads · measured</th><th class="n">Chat · estimated</th><th class="n">% used</th><th class="n">Fresh tokens left · estimate</th><th class="n">% left</th><th class="n">Your pace</th><th class="n">At reset</th><th class="n">Resets</th><th>Verdict</th></tr>` +
    rows.map(([name, w]) => {
      const pace = name.startsWith('5') ? `${pt(w.pacePerHour)}% / hour` : `${pt(w.pacePerHour * 24)}% / day`;
      return `<tr><td><b>${name}</b></td><td class="n">${fmt(w.tokensFresh)}</td><td class="n">${fmt(w.tokensCacheRead)}</td><td class="n">~${fmt(w.tokensChat)}</td><td class="n"><b>${w.pct}%</b></td><td class="n"><b>${w.tokensLeft != null ? '~' + fmt(w.tokensLeft) : 'n/a'}</b></td><td class="n">${100 - w.pct}%</td><td class="n">${pace}<br><span class="muted">${w.paceBasis}</span></td><td class="n"><b>${projRange(w)}</b></td><td class="n">${dayTime(w.resetsAt)}<br><span class="muted">${until(w.resetsAt)}</span></td><td>${w.hitsBeforeReset ? status(true, 'Hits limit at ' + time(w.hitAt)) : status(false, "Won't hit before reset")}</td></tr>`;
    }).join('');
}

// ---------- meters ----------
// One plain sentence per window: where you are, when it resets, where the pace takes you.
// "40% to 55%" when the recent pace and the window average disagree by 2 points or more.
const projRange = (w) => w.projectedRange && Math.abs(w.projectedRange[1] - w.projectedRange[0]) >= 2 ? `${w.projectedRange[0]}% to ${w.projectedRange[1]}%` : `${w.projectedAtReset}%`;
function meters() {
  const card = (title, w, lead) => {
    if (!w) return `<div class="card"><h2>${title}</h2><div class="empty">No readings yet.</div></div>`;
    const proj = Math.max(w.pct, w.projectedAtReset);
    return `<div class="card"><div class="meter-head"><div><h2>${title}</h2><div class="sub">Resets ${dayTime(w.resetsAt)} · ${until(w.resetsAt)}</div></div>${w.hitsBeforeReset ? status(true, 'At risk') : status(false, 'On track')}</div>
      <div class="meter-val">${w.pct}%<span class="sub" style="font-size:14px;font-weight:500"> used</span></div>
      <div class="meter" aria-label="${w.pct}% used, projected ${w.projectedAtReset}% at reset"><span style="width:${w.pct}%"></span><div class="proj" style="left:${w.pct}%;width:${proj - w.pct}%"></div></div>
      <div class="lead">${lead}</div></div>`;
  };
  const h5 = S.windows.h5, wk = S.windows.wk, sc = S.insights.sessionCost;
  const pace = (w) => w.hitsBeforeReset
    ? `At this pace you reach the limit at <b>${dayTime(w.hitAt)}</b>, ${dur(Date.parse(w.resetsAt) - Date.parse(w.hitAt))} before it resets.`
    : `At this pace you end the window ${projRange(w).includes(' to ') ? 'between' : 'around'} <b>${projRange(w).replace(' to ', '</b> and <b>')}</b>, under the limit.`;
  const h5Lead = h5 ? pace(h5) + ' ' + fitsText(h5, sc, S.insights.sessionLength) : '';
  const wkLead = wk ? pace(wk) + (sc?.leftWeek ? ` About ${sc.leftWeek.typical} typical sessions left this week.` : '') : '';
  const fb = S.windows.fable;
  const fbLead = fb ? pace(fb) + ' Only Fable and Mythos usage counts here; it also counts against the weekly limit.' : '';
  $('#meters').innerHTML = card('5-hour limit', h5, h5Lead) + card('Weekly limit · all models', wk, wkLead) + (fb ? card('Fable limit · up to 50% of the week', fb, fbLead) : '');
}

// ---------- 5-hour line chart ----------
function lineChart() {
  const host = $('#lineChart'); host.innerHTML = '';
  const w = S.windows.h5;
  if (!w || !w.readings.length) { host.innerHTML = '<div class="empty">No readings in this window yet.</div>'; return; }
  const W = host.clientWidth || 480, H = 220, m = { l: 34, r: 56, t: 16, b: 26 };
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
  const x0 = Date.parse(w.start), x1 = Date.parse(w.resetsAt);
  const yMax = Math.min(100, Math.max(20, Math.ceil(Math.max(w.projectedAtReset, w.pct) / 10) * 10 + 10));
  const X = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
  const step = yMax > 50 ? 25 : 10;
  for (let v = 0; v <= yMax; v += step) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v + '%';
  }
  for (let t = Math.ceil(x0 / 3600000) * 3600000; t <= x1; t += 3600000) svgEl('text', { x: X(t), y: H - 8, 'text-anchor': 'middle' }, svg).textContent = new Date(t).toLocaleTimeString([], { hour: 'numeric' });
  const r = [[x0, 0], ...w.readings.map(([ts, p]) => [Date.parse(ts), p])];
  const pts = r.map(([t, v]) => `${X(t)},${Y(v)}`).join(' ');
  const last = r[r.length - 1];
  svgEl('polygon', { points: `${X(r[0][0])},${Y(0)} ${pts} ${X(last[0])},${Y(0)}`, fill: 'var(--series-1)', opacity: 0.1 }, svg);
  svgEl('polyline', { points: pts, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  svgEl('line', { x1: X(last[0]), y1: Y(last[1]), x2: X(x1), y2: Y(w.projectedAtReset), stroke: 'var(--series-1)', 'stroke-width': 2, opacity: 0.35, 'stroke-linecap': 'round' }, svg);
  for (const [t, v] of r.slice(1)) { const c = svgEl('circle', { cx: X(t), cy: Y(v), r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg); tip(c, `<b>${time(new Date(t).toISOString())}</b><br>${v}% used`); }
  svgEl('text', { x: X(last[0]) - 8, y: Y(last[1]) - 10, 'text-anchor': 'end', style: 'fill:var(--text-primary);font-weight:600' }, svg).textContent = `${last[1]}% now`;
  svgEl('circle', { cx: X(x1), cy: Y(w.projectedAtReset), r: 4, fill: 'var(--surface-1)', stroke: 'var(--series-1)', 'stroke-width': 2 }, svg);
  svgEl('text', { x: X(x1) + 6, y: Y(w.projectedAtReset) + 4, style: 'fill:var(--text-secondary)' }, svg).textContent = `${w.projectedAtReset}%`;
}

// ---------- attribution ----------
function stacks() {
  const parts = [['cli', 'Claude Code (CLI)', '--series-1'], ['desktop', 'Desktop agent', '--series-2'], ['other', 'Headless and not itemised', '--series-4'], ['remote', 'Claude Code on other computers', '--series-5'], ['chat', 'Chat and other devices (estimated)', '--series-3']];
  const rows = [['5-hour', S.attribution.h5], ['Weekly', S.attribution.wk], ['Fable', S.attribution.fable]].filter(([, a]) => a);
  if (!rows.length) { $('#stacks').innerHTML = '<div class="empty">Needs at least one limit reading.</div>'; return; }
  $('#stacks').innerHTML = rows.map(([label, a]) => {
    const vals = { cli: a.cli, desktop: a.desktop, other: a.headless + a.unitemised, remote: a.remote || 0, chat: a.chat };
    const segs = parts.filter(([k]) => vals[k] > 0.005).map(([k, name, c]) => `<div data-k="${k}" data-name="${name}" data-v="${vals[k]}" data-t="${a.total}" style="width:${(vals[k] / Math.max(a.total, 0.01)) * 100}%;background:var(${c})"></div>`).join('');
    return `<div class="stack-row"><div><b>${label}</b></div><div class="stack">${segs}</div><div class="n" style="text-align:right;font-weight:600">${a.total}%</div></div>`;
  }).join('');
  document.querySelectorAll('.stack').forEach((s) => { const kids = [...s.children]; if (kids.length) kids[kids.length - 1].classList.add('last'); kids.forEach((seg) => tip(seg, `<b>${seg.dataset.name}</b><br>${pt(+seg.dataset.v)}% of the limit · ${Math.round((seg.dataset.v / seg.dataset.t) * 100)}% of what was used`)); });
  const c = S.calibration.h5;
  $('#calLine').textContent = c.k ? `Calibration: 1% of the 5-hour window ≈ ${money(1 / c.k)} of list-price usage, from ${c.windows} window${c.windows === 1 ? '' : 's'} (${c.cleanWindows} with Claude Code as the only activity${c.marked ? `, ${c.marked} marked by you` : ''}).${c.provisional ? ' Provisional until about 5 windows.' : ''} If a window had no chat at all, "quotameter mark code-only" tells calibration so.` : 'Calibration needs a window with at least 5% used and some Claude Code activity.';
}

// ---------- how you use your limit ----------
const tileHtml = (l, v, s) => `<div class="card tile"><div class="label">${l}</div><div class="value">${v}</div><div class="delta">${s}</div></div>`;
const pct1 = (x) => x == null ? 'n/a' : (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
function useTiles() {
  const I = S.insights, sc = I.sessionCost, b = I.binding, u = I.unused, br = I.burn, lt = I.limitTiming, h = S.history;
  const small = (s) => `<span style="font-size:15px;color:var(--text-muted);font-weight:500">${s}</span>`;
  const tiles = [];
  tiles.push(sc
    ? tileHtml('A typical session uses', sc.medianH5 != null ? `${pt(sc.medianH5)}% ${small('of the 5-hour limit')}` : money(sc.medianCost), `${sc.heavyH5 != null ? `heavy ones ${pt(sc.heavyH5)}% of 5 hours · ` : ''}${sc.medianWk != null ? `${pt(sc.medianWk)}% of the week · ` : ''}${fmt(sc.medianTokens)} tokens · from ${sc.n} session${sc.n === 1 ? '' : 's'}`)
    : tileHtml('A typical session uses', 'n/a', 'No interactive sessions in 30 days'));
  const verdict = { weekly: 'Weekly limit', '5-hour': '5-hour limit', neither: 'Neither yet', unknown: 'n/a' }[b.verdict];
  const why = b.verdict === 'unknown' ? 'Needs limit readings' : b.verdict === 'neither'
    ? `Highest in 30 days: 5-hour ${b.h5Peak != null ? b.h5Peak + '%' : 'n/a'}, weekly ${b.wkPeak != null ? b.wkPeak + '%' : 'n/a'}${b.wkProjected != null ? ` (this week heading for ${b.wkProjected}%)` : ''}`
    : `5-hour limit hit ${b.h5Hits}× · weekly ${b.wkHits}× in 30 days${b.wkProjected >= 100 && !b.wkHits ? ' · this week is heading past 100%' : ''}`;
  tiles.push(tileHtml('Which limit stops you', verdict, why));
  tiles.push(u.avgPeak != null
    ? tileHtml('Unused allowance, last 7 days', `${100 - u.avgPeak}% ${small('left at reset, on average')}`, `${u.finished} finished 5-hour window${u.finished === 1 ? '' : 's'}, average peak ${u.avgPeak}%, ${u.light} under 25%${u.lastWeek != null ? ` · last week ended at ${u.lastWeek}%` : ''}`)
    : tileHtml('Unused allowance, last 7 days', 'n/a', u.windows ? `${u.windows} window${u.windows === 1 ? '' : 's'} still open` : 'Needs a finished 5-hour window'));
  tiles.push(br
    ? tileHtml('Burn rate while working', br.h5PerHour != null ? `${pt(br.h5PerHour)}% ${small('an hour')}` : `${money(br.costPerHour)} ${small('per active hour')}`, `${br.h5PerHour != null ? 'of the 5-hour window per active hour · ' : ''}${br.hoursPerWindow != null ? `${pt(br.hoursPerWindow)} h of steady work fills a window · ` : ''}${pt(br.hoursPerDay)} h active per day over ${br.activeDays} day${br.activeDays === 1 ? '' : 's'}`)
    : tileHtml('Burn rate while working', 'n/a', 'No Claude Code activity in 30 days'));
  tiles.push(lt.count
    ? tileHtml('When you hit the 5-hour limit', `${lt.count}× ${small('in 30 days')}`, `usually ${dur(lt.medianAfterMs)} into the window, then locked out for ${dur(lt.medianLockedMs)}`)
    : tileHtml('When you hit the 5-hour limit', 'Not hit', 'No 5-hour limit hits in the last 30 days'));
  tiles.push(h.vsLastWeek
    ? tileHtml('This week vs last week', `${h.vsLastWeek.now}% ${small(`vs ${h.vsLastWeek.then}%`)}`, `of the weekly limit at the same time of week · ${h.vsLastWeek.now <= h.vsLastWeek.then ? `▼ ${h.vsLastWeek.then - h.vsLastWeek.now}% less` : `▲ ${h.vsLastWeek.now - h.vsLastWeek.then}% more`}`)
    : tileHtml('This week vs last week', 'n/a', 'Needs two weeks of readings'));
  $('#useTiles').innerHTML = tiles.join('');
}

// Stacked columns. Each item: { label, label2?, parts[], top?, empty?, faded? }.
function stackBars(host, items, colors, { yMax, axis, tipFn, highlight = -1, title = '' }) {
  host.innerHTML = '';
  const two = items.some((i) => i.label2);
  const W = host.clientWidth || 480, H = two ? 234 : 220, m = { l: 44, r: 8, t: 20, b: two ? 40 : 26 };
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title }, host);
  const Y = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
  for (const v of [0, yMax / 2, yMax]) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = axis(v);
  }
  const band = (W - m.l - m.r) / items.length, bw = Math.min(28, band * 0.6);
  const widest = Math.max(...items.map((it) => String(it.label).length)) * 6.5 + 8;
  const every = Math.max(1, Math.ceil(widest / band));
  items.forEach((it, i) => {
    const cx = m.l + band * i + band / 2, x = cx - bw / 2;
    const strong = i === highlight ? 'fill:var(--text-primary);font-weight:600' : '';
    if ((items.length - 1 - i) % every === 0) svgEl('text', { x: cx, y: H - (two ? 22 : 8), 'text-anchor': 'middle', style: strong }, svg).textContent = it.label;
    if (it.label2) svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', style: strong }, svg).textContent = it.label2;
    let base = Y(0);
    const segs = it.parts.map((v, j) => ({ v, j })).filter((s) => s.v > 0);
    segs.forEach((s, k) => {
      const h = Math.max(2, Y(0) - Y(s.v)) - (k ? 2 : 0);
      if (h <= 0) return;
      const top = base - (k ? 2 : 0) - h, bottom = base - (k ? 2 : 0);
      const last = k === segs.length - 1, rr = last ? Math.min(4, h) : 0;
      svgEl('path', { d: `M${x},${bottom} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${bottom} Z`, fill: colors[s.j], opacity: it.faded ? 0.55 : 1 }, svg);
      base = top;
    });
    if (it.top) svgEl('text', { x: cx, y: base - 6, 'text-anchor': 'middle', style: 'fill:var(--text-secondary)' }, svg).textContent = it.top;
    if (it.empty && band >= 56) svgEl('text', { x: cx, y: Y(0) - 8, 'text-anchor': 'middle', style: 'fill:var(--text-muted)' }, svg).textContent = 'no data';
    const hit = svgEl('rect', { x: cx - band / 2, y: m.t, width: band, height: H - m.t - m.b, fill: 'transparent' }, svg);
    if (tipFn) tip(hit, tipFn(it));
  });
}

// "Your weeks": % of the weekly limit, fresh tokens, or tokens with cache reads.
let WEEK_MODE = (S.insights.weeklyTokens || []).some((w) => w.pct != null) ? 'pct' : 'fresh';
const WEEK_LEGEND = {
  pct: [['--series-1', 'Weekly limit used']],
  fresh: [['--series-1', 'Claude Code, fresh tokens'], ['--series-3', 'Chat and other devices (estimated)']],
  all: [['--series-1', 'Claude Code, fresh tokens'], ['--series-4', 'Claude Code, cache reads'], ['--series-3', 'Chat and other devices (estimated)']],
};
function weekTokChart() {
  const host = $('#weekTokChart'), wk = S.insights.weeklyTokens, mode = WEEK_MODE;
  $('#weekTokLegend').innerHTML = WEEK_LEGEND[mode].map(([c, l]) => `<span style="--c:var(${c})">${l}</span>`).join('');
  $('#weekTokSub').textContent = {
    pct: 'Final % of your weekly limit in each week. ▲ marks weeks where you also hit the 5-hour limit.',
    fresh: 'Tokens that count fully against your limit: input, output and cache writes. Chat is estimated.',
    all: 'Every token, including cache reads. Cache reads count for far less, so they dwarf the rest.',
  }[mode];
  if (!wk.length || !wk.some((w) => !w.empty)) { host.innerHTML = '<div class="empty">No usage recorded yet.</div>'; $('#weekTokNote').textContent = ''; return; }
  // "8-14 Oct", so a bar reads as a week rather than a day.
  const span = (w) => {
    const a = new Date(w.start), b = new Date(a);
    b.setDate(b.getDate() + 6);
    const dm = (d) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return a.getMonth() === b.getMonth() ? `${a.getDate()}-${dm(b)}` : `${dm(a)}-${dm(b)}`;
  };
  const partsOf = (w) => mode === 'pct' ? [w.pct || 0] : mode === 'fresh' ? [w.fresh, w.chat] : [w.fresh, w.cacheRead, w.chat];
  const sumOf = (w) => partsOf(w).reduce((a, b) => a + b, 0);
  const items = wk.map((w) => {
    const none = mode === 'pct' ? w.pct == null : w.empty;
    const top = none ? '' : mode === 'pct' ? `${w.pct}%${w.hits ? ' ▲' + w.hits : ''}` : fmt(sumOf(w));
    return { ...w, empty: none, label: w.current ? 'This week' : span(w), range: span(w), parts: partsOf(w), top };
  });
  const yMax = mode === 'pct' ? 100 : Math.max(...items.map(sumOf)) * 1.15 || 1;
  const colors = mode === 'pct' ? ['var(--series-1)'] : mode === 'fresh' ? ['var(--series-1)', 'var(--series-3)'] : ['var(--series-1)', 'var(--series-4)', 'var(--series-3)'];
  stackBars(host, items, colors, { yMax, axis: (v) => mode === 'pct' ? Math.round(v) + '%' : fmt(v), highlight: items.length - 1, title: 'Usage per week',
    tipFn: (i) => i.empty ? (i.current ? `<b>${i.range}</b> (in progress)<br>No activity yet this week` : `<b>${i.range}</b><br>No data for this week`)
      : `<b>${i.range}</b>${i.current ? ' (in progress)' : ''}${i.pct != null ? `<br>Weekly limit used: ${i.pct}%` : ''}${i.hits ? `<br>5-hour limit reached ${i.hits}×` : ''}<br>Code, fresh: ${fmt(i.fresh)}<br>Code, cache reads: ${fmt(i.cacheRead)}<br>Chat, estimated: ~${fmt(i.chat)}` });
  const start = S.insights.historyStart;
  $('#weekTokNote').textContent = wk.some((w) => w.empty) && start
    ? `History starts ${new Date(start).toLocaleDateString([], { day: 'numeric', month: 'short' })}, the date of the oldest Claude Code log on this computer. Claude Code deletes old logs (after 30 days by default), but quotameter keeps its own copy, so this chart fills in week by week.`
    : '';
}

function dailyChart() {
  const host = $('#dailyChart'), d = S.insights.daily, pts = d.unit === 'points';
  $('#dailySub').textContent = pts ? 'Last 14 days · % of the weekly limit added each day. Chat lands on the day its increase was seen.' : 'Last 14 days · no weekly readings cover this period, so Claude Code is shown at list price and chat is not estimated.';
  if (!d.days.some((x) => x.cost || x.chat)) { host.innerHTML = '<div class="empty">No activity in the last 14 days.</div>'; return; }
  const today = new Date().toDateString();
  const items = d.days.map((x) => { const dt = new Date(x.day); return { ...x, dt, label: dt.toLocaleDateString([], { weekday: 'short' }).slice(0, 2), label2: String(dt.getDate()), parts: pts ? [x.code, x.chat] : [x.cost, 0] }; });
  const yMax = Math.max(...items.map((i) => i.parts[0] + i.parts[1])) * 1.15 || 1;
  stackBars(host, items, ['var(--series-1)', 'var(--series-3)'], { yMax, axis: (v) => pts ? pt(v) + '%' : money(v), highlight: items.findIndex((i) => i.dt.toDateString() === today), title: 'Claude Code and chat by day',
    tipFn: (i) => `<b>${i.dt.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>` + (pts ? `Claude Code: ${pt(i.code)}% of the week<br>Chat, estimated: ${pt(i.chat)}% of the week` : `Claude Code: ${money(i.cost)} at list price`) });
}

function useTables() {
  const I = S.insights;
  const both = (p, c) => p != null ? `<b>${pt(p)}%</b> <span class="muted">${money(c)}</span>` : money(c);
  const wi = I.whatIf;
  $('#whatIfSub').textContent = wi.rows.some((r) => r.actualPts != null) ? `Opus and Fable usage ${wi.period}, as % of your weekly limit. List-price cost in grey.` : `Opus and Fable usage ${wi.period}, at list price until the weekly calibration is ready.`;
  $('#whatIfTable').innerHTML = wi.rows.length ? `<tr><th></th><th class="n">Requests</th><th class="n">As run</th><th class="n">On Sonnet 5.5</th><th class="n">On Haiku 5.5</th></tr>` +
    wi.rows.map((r) => `<tr><td><b>${esc(r.label)}</b></td><td class="n">${fmt(r.requests)}</td><td class="n">${both(r.actualPts, r.actual)}</td><td class="n">${both(r.sonnetPts, r.sonnet)}</td><td class="n">${both(r.haikuPts, r.haiku)}</td></tr>`).join('')
    : '<tr><td class="empty">No Opus or Fable usage in this period.</td></tr>';
  const c = I.cache.week, c30 = I.cache.d30;
  $('#cacheTable').innerHTML = c ? [
    ['Input served from cache, this week', `<b>${pct1(c.hitRatio)}</b>`],
    ['Input served from cache, 30 days', c30 ? pct1(c30.hitRatio) : 'n/a'],
    ['Cache writes as a share of usage', `${pct1(c.writeShare)} <span class="muted">${money(c.writeCost)}</span>`],
    ['Context sent again after a pause over 5 min', `${c.rebuilds}× <span class="muted">${fmt(c.rebuildTokens)} tokens</span>`],
    ['Cost of those rebuilds, % of weekly limit', both(c.rebuildPts, c.rebuildCost)],
  ].map(([a, b]) => `<tr><td>${a}</td><td class="n">${b}</td></tr>`).join('') : '<tr><td class="empty">No Claude Code usage this week.</td></tr>';
  const a = I.subagents.week, a30 = I.subagents.d30;
  $('#agentOhTable').innerHTML = [
    ['Subagent usage this week, % of weekly limit', both(a.agentPts, a.agentCost)],
    ['Share of Claude Code usage, this week', pct1(a.share)],
    ['Share of Claude Code usage, 30 days', pct1(a30.share)],
    ['Added per $1 of main conversation', a.ratio != null ? money(a.ratio) : 'n/a'],
    ['Sessions that used subagents, this week', `${a.sessionsWithAgents}${a.medianSessionRatio != null ? ` <span class="muted">median adds ${Math.round(a.medianSessionRatio * 100)}%</span>` : ''}`],
  ].map(([x, y]) => `<tr><td>${x}</td><td class="n">${y}</td></tr>`).join('');
  const cx = I.context;
  $('#ctxTable').innerHTML = cx ? [
    ['Growth per turn, median', `<b>${fmt(cx.perTurn)}</b> tokens`],
    ['Peak context per session, median', `${fmt(cx.medianPeak)} tokens`],
    ['Sessions that passed 100K', `${cx.reached100k} of ${cx.sessions}`],
    ['Turns until 100K, median', cx.turnsTo100k != null ? String(cx.turnsTo100k) : 'n/a'],
  ].map(([x, y]) => `<tr><td>${x}</td><td class="n">${y}</td></tr>`).join('') + '<tr><td colspan="2" class="muted">Every turn re-reads the whole context, so a session past 100K costs more per turn than a fresh one.</td></tr>' : '<tr><td class="empty">Needs a session with at least 3 turns.</td></tr>';
  const l = I.sessionLength;
  $('#lenTable').innerHTML = l ? [
    ['Median length', `<b>${dur(l.medianMs)}</b>`],
    ['Long sessions (90th percentile)', dur(l.p90Ms)],
    ['Longest', `${dur(l.longestMs)}${l.longestTitle ? `<br><span class="muted">${esc(l.longestTitle)}</span>` : ''}`],
    ['Tokens per minute, median', fmt(l.tokensPerMin)],
  ].map(([x, y]) => `<tr><td>${x}</td><td class="n">${y}</td></tr>`).join('') : '<tr><td class="empty">No interactive sessions in 30 days.</td></tr>';
  const lt = I.limitTiming;
  $('#hitsWrap').innerHTML = lt.count ? `<h2 style="margin-top:16px">Times you hit the 5-hour limit</h2><table><tr><th>When</th><th class="n">Window start to 100%</th><th class="n">Locked out for</th></tr>` +
    lt.hits.map((h) => `<tr><td>${dayTime(h.at)}</td><td class="n">${dur(h.afterMs)}</td><td class="n">${dur(h.lockedMs)}</td></tr>`).join('') + '</table>' : '';
}

// ---------- breakdown ----------
let WIN = 'h5';
const UNIT = { h5: 'of 5-hour limit', wk: 'of weekly limit', fable: 'of the Fable limit', d30: 'of a weekly limit', d90: 'of a weekly limit', all: 'of a weekly limit' };
const MC = (m) => { const f = Object.keys(S.series || {}).find((k) => String(m || '').toLowerCase().includes(k)); return f ? `var(--series-${S.series[f]})` : 'var(--series-3)'; };
function ptsBar(p, max, col, total, cost) {
  if (p == null) return '<span class="muted">n/a</span>';
  return `<div class="ibar"><i style="width:${Math.max(2, (p / (max || 1)) * 120)}px;background:${col}"></i><span class="pts">${cost ? money(p) : pt(p) + '%'}</span>${total ? `<span class="muted">· ${Math.round((p / total) * 100)}% of the total</span>` : ''}</div>`;
}
function breakdown() {
  const d = S.breakdown[WIN];
  const notes = { h5: 'Current 5-hour window. Percentages are of your 5-hour limit.', wk: 'Current weekly window. Percentages are of your weekly limit.', fable: 'Current weekly window, Fable and Mythos usage only. Percentages are of the Fable limit (up to 50% of your weekly limit).', d30: 'Last 30 days. Percentages are of a weekly limit, added up across weeks, so 100% is one full week of allowance and 30 days hold about 4.3 weeks.', d90: 'Last 90 days. Percentages are of a weekly limit, added up across weeks, so 100% is one full week of allowance and 90 days hold about 13 weeks.', all: 'Everything quotameter has kept. Percentages are of a weekly limit, added up across weeks. Older days are kept as summaries, so tools and individual sessions only cover the days kept in full.' };
  // Say plainly when a long range holds less than its name promises.
  const span = WIN === 'd90' && d.dataFrom ? Math.max(1, Math.ceil((Date.parse(d.range.end) - Date.parse(d.dataFrom)) / 864e5)) : null;
  const partial = span != null && span < 89 ? `quotameter has ${span} day${span === 1 ? '' : 's'} of data so far, from ${dayTime(d.dataFrom)}. This view fills up to 90 days as it keeps collecting. ` : '';
  const note = partial ? notes[WIN].replace(/^Last 90 days. /, '').replace(/ and 90 days hold about 13 weeks/, '') : notes[WIN];
  $('#winNote').textContent = partial + (d.range && !partial ? `${dayTime(d.range.start)} to ${dayTime(d.range.end)}. ` : '') + note;
  const t = d.tiles;
  $('#tiles').innerHTML = [
    ['Requests', fmt(t.requests), `${t.mainRequests} main · ${t.agentRequests} subagent`],
    ['Fresh tokens', fmt(t.tokens), `${fmt(t.freshTokens)} measured · ~${fmt(t.chatTokens)} chat, estimated · plus ${fmt(t.cacheReadTokens)} cache reads`],
    ['API-equivalent', money(t.apiCost), 'Claude Code at list price'],
  ].map(([l, v, s]) => `<div class="card tile"><div class="label">${l}</div><div class="value">${v}</div><div class="delta">${s}</div></div>`).join('');
  const hasPts = d.total != null;
  $('#modelSub').textContent = hasPts ? `Percentages are ${UNIT[WIN]}. Cost at API list price is a usage weight only; Pro and Max are not billed per token.` : 'No limit readings for this period, so rows show list-price cost instead of a share of the limit.';
  const key = (r) => hasPts ? r.pts : r.cost;
  const mMax = Math.max(...d.models.map((r) => key(r) || 0));
  $('#modelTable').innerHTML = `<tr><th>Model</th><th>Where</th><th>${hasPts ? '% ' + UNIT[WIN] : 'Cost'}</th><th class="n">Requests</th><th class="n">Input</th><th class="n">Output</th><th class="n">Cache write</th><th class="n">Cache read</th><th class="n">API-equiv.</th></tr>` +
    d.models.map((r) => {
      const bar = hasPts ? ptsBar(r.pts, mMax, MC(r.model), d.total) : ptsBar(r.cost, mMax, MC(r.model), 0, true);
      if (r.chat) return `<tr><td><span class="dot" style="background:var(--series-3)"></span>${r.model}${estTag()}</td><td>${r.where}</td><td>${bar}</td><td class="n muted" colspan="5">~${fmt(r.tokens)} tokens, estimated from the leftover %</td><td class="n muted">n/a</td></tr>`;
      if (r.unitemised) return `<tr><td><span class="dot" style="background:var(--series-4)"></span>${r.model}</td><td>${r.where}</td><td>${bar}</td><td class="n muted" colspan="5">usage the per-message logs do not break down</td><td class="n">${money(r.cost)}</td></tr>`;
      return `<tr><td><span class="dot" style="background:${MC(r.model)}"></span>${esc(r.model)}</td><td>${r.where}</td><td>${bar}</td><td class="n">${fmt(r.req)}</td><td class="n">${fmt(r.in)}</td><td class="n">${fmt(r.out)}</td><td class="n">${fmt(r.cw)}</td><td class="n">${fmt(r.cr)}</td><td class="n">${money(r.cost)}</td></tr>`;
    }).join('') + (hasPts ? `<tr><td colspan="2"><b>Total</b></td><td><span class="pts">${pt(d.total)}%</span> <span class="muted">${UNIT[WIN]}</span></td><td colspan="6"></td></tr>` : '');
  const pMax = Math.max(...d.projects.map((r) => key(r) || 0));
  $('#projTable').innerHTML = d.projects.length ? `<tr><th>Project</th><th>Source</th><th class="n">Fresh tokens</th><th>${hasPts ? '% ' + UNIT[WIN] : 'Cost'}</th></tr>` + d.projects.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.branch ? `<br><span class="muted">${esc(r.branch)}</span>` : ''}</td><td>${esc(r.src)}</td><td class="n">${fmt(r.tokens)}</td><td>${ptsBar(key(r), pMax, r.chat ? 'var(--series-3)' : 'var(--series-1)', 0, !hasPts)}</td></tr>`).join('') : '<tr><td class="empty">No Claude Code activity in this period.</td></tr>';
  const sMax = Math.max(...d.sessions.map((r) => key(r) || 0));
  $('#sessTable').innerHTML = d.sessions.length ? `<tr><th>Session</th><th>Model</th><th class="n">Length</th><th>${hasPts ? '% ' + UNIT[WIN] : 'Cost'}</th></tr>` + d.sessions.map((r) => `<tr><td><b>${esc(r.title)}</b><br><span class="muted">${esc(r.src)}</span></td><td>${esc(r.model)}</td><td class="n">${dur(r.durationMs)}</td><td>${ptsBar(key(r), sMax, 'var(--series-1)', 0, !hasPts)}</td></tr>`).join('') : '<tr><td class="empty">No sessions in this period.</td></tr>';
  $('#agentCard').hidden = !d.agents.length;
  $('#agentTable').innerHTML = d.agents.length ? `<tr><th>Agent</th><th>Model</th><th class="n">Depth</th><th class="n">Requests</th><th class="n">Fresh tokens</th><th class="n">${hasPts ? '% ' + UNIT[WIN] : 'Cost'}</th><th>Top tools</th></tr>` + d.agents.map((a) => `<tr><td><b>${esc(a.name)}</b></td><td><span class="dot" style="background:${MC(a.model)}"></span>${esc(a.model)}</td><td class="n">${a.depth ?? 'n/a'}</td><td class="n">${fmt(a.req)}</td><td class="n">${fmt(a.tokens)}</td><td class="n">${hasPts ? pt(a.pts) + '%' : money(a.cost)}</td><td class="muted">${esc(a.tools)}</td></tr>`).join('') : '<tr><td class="empty">No subagents ran in this period.</td></tr>';
  panels(d, hasPts);
}

function panels(d, hasPts) {
  const val = (r) => hasPts ? r.pts : r.cost;
  const bar = (v, max) => `<div class="ibar"><i style="width:${Math.max(2, (v / (max || 1)) * 160)}px"></i><span>${hasPts ? pt(v) + '%' : money(v)}</span></div>`;
  const sm = Math.max(...d.skills.map((s) => val(s) || 0));
  $('#p-skills').innerHTML = `<div class="sub" style="margin-bottom:8px">Exact: responses Claude Code tagged with the skill that caused them.</div>` + (d.skills.length ? `<div class="scroll"><table><tr><th>Skill</th><th class="n">Responses</th><th>${hasPts ? '% ' + UNIT[WIN] : 'Cost'}</th></tr>` + d.skills.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="n">${s.responses}</td><td>${bar(val(s), sm)}</td></tr>`).join('') + '</table></div>' : '<div class="empty">No skill usage in this period.</div>');
  const tm = Math.max(...d.tools.map((s) => val(s) || 0));
  $('#p-tools').innerHTML = `<div class="sub" style="margin-bottom:8px">Estimated: each response's usage is split evenly across the tools it called.</div>` + (d.tools.length ? `<div class="scroll"><table><tr><th>Tool</th><th class="n">Responses using it</th><th>Est. ${hasPts ? '% ' + UNIT[WIN] : 'cost'}</th></tr>` + d.tools.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="n">${s.calls}</td><td>${bar(val(s), tm)}</td></tr>`).join('') + '</table></div>' : '<div class="empty">No tool calls in this period.</div>');
  const o = S.overhead;
  $('#p-mcp').innerHTML = `<div class="sub" style="margin-bottom:8px">Loaded per session is what each server adds to every new session${o.snapshot ? ` (from <code>/context</code>, ${dayTime(o.snapshot)})` : ''}. ${o.deferredMcpTokens ? `Another ${fmt(o.deferredMcpTokens)} tokens of tool definitions are deferred and load only when Claude looks them up.` : ''}</div>` +
    (o.mcp.length ? `<div class="scroll"><table><tr><th>Server</th><th class="n">Tools</th><th class="n">Calls (30 days)</th><th class="n">Loaded / session</th><th></th></tr>` + o.mcp.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="n">${s.tools}</td><td class="n">${s.calls}</td><td class="n">${fmt(s.tokens)} tok</td><td>${s.calls === 0 ? '<span class="tag warn">Unused</span> ' : ''}${s.connector ? '<span class="tag">claude.ai connector</span>' : ''}</td></tr>`).join('') + '</table></div>' : '<div class="empty">No <code>/context</code> snapshot yet. Run <code>quotameter context</code>.</div>');
  $('#p-plugins').innerHTML = `<div class="sub" style="margin-bottom:8px">Skills each plugin adds to every session, and how often they ran in 30 days.</div>` + (o.plugins.length ? `<div class="scroll"><table><tr><th>Plugin</th><th class="n">Skills</th><th class="n">Loaded / session</th><th class="n">Uses</th><th></th></tr>` + o.plugins.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="n">${p.skills}</td><td class="n">${fmt(p.tokens)} tok</td><td class="n">${p.used}</td><td>${p.used === 0 ? '<span class="tag warn">Never used</span>' : ''}</td></tr>`).join('') + '</table></div>' : '<div class="empty">No plugin skills found in the latest snapshot.</div>');
}

// ---------- history ----------
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourName = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
function historyView() {
  const h = S.history, card = $('#heatCard');
  // A heatmap needs about a week of activity before it says anything.
  if ((h.activeDays || 0) < 5) { card.hidden = true; return; }
  card.hidden = false;
  $('#heatSub').textContent = `Share of Code usage by weekday and hour, last 30 days.${h.busiest ? ` Busiest: ${DAYS[h.busiest.day]}s around ${hourName(h.busiest.hour)}.` : ''}`;
  heatmap();
}
const RAMP = ['var(--surface-2)', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf'];
function heatmap() {
  const host = $('#heatmap'); host.innerHTML = '';
  const HEAT = S.history.heatmap, max = Math.max(...HEAT.flat());
  if (!max) { host.innerHTML = '<div class="empty">Not enough data yet.</div>'; return; }
  const W = host.clientWidth || 480, m = { l: 34, r: 4, t: 4, b: 40 };
  const cw = (W - m.l - m.r) / 24, ch = Math.min(22, Math.max(14, cw)), H = m.t + ch * 7 + m.b;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Claude Code usage by weekday and hour' }, host);
  HEAT.forEach((row, di) => {
    svgEl('text', { x: m.l - 6, y: m.t + di * ch + ch / 2 + 4, 'text-anchor': 'end' }, svg).textContent = DAYS[di];
    row.forEach((v, h) => {
      const step = v === 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999));
      const r = svgEl('rect', { x: m.l + h * cw + 1, y: m.t + di * ch + 1, width: cw - 2, height: ch - 2, rx: 2, fill: RAMP[step] }, svg);
      tip(r, `<b>${DAYS[di]}, ${hourName(h)}</b><br>${v ? (v * 100).toFixed(1) + '% of Code usage' : 'No usage'}`);
    });
  });
  for (const h of [0, 6, 12, 18]) svgEl('text', { x: m.l + h * cw + cw / 2, y: m.t + ch * 7 + 14, 'text-anchor': 'middle' }, svg).textContent = hourName(h);
  const ly = m.t + ch * 7 + 26;
  svgEl('text', { x: m.l, y: ly + 9 }, svg).textContent = 'Less';
  RAMP.slice(1).forEach((c, i) => svgEl('rect', { x: m.l + 32 + i * 16, y: ly, width: 14, height: 10, rx: 2, fill: c }, svg));
  svgEl('text', { x: m.l + 32 + 5 * 16 + 4, y: ly + 9 }, svg).textContent = 'More';
}

// ---------- value, recommendations ----------
function valueView() {
  const v = S.value, max = Math.max(...v.rows.map((r) => r.cost), 0.01), fit = S.insights.planFit;
  const col = (l) => l.startsWith('Chat') ? 'var(--series-3)' : MC(l.toLowerCase());
  const verdict = fit ? `<div class="lead" style="margin-top:12px"><b>${esc(fit.title)}</b> ${esc(fit.body)}</div>` : '';
  $('#valueCard').innerHTML = `<div><div class="label sub">API-equivalent usage, last 30 days</div><div class="hero">${money(v.total)}</div><div class="sub">${v.planPrice ? `at API list prices. Your plan costs $${v.planPrice} a month${v.multiple >= 2 ? `, so this is about ${Math.round(v.multiple)} times that` : ''}.` : 'at API list prices.'}</div>${verdict}</div>
    <div class="value-split">${v.rows.map((r) => `<div class="row"><span>${esc(r.label)}</span><i style="width:${(r.cost / max) * 100}%;background:${col(r.label)}"></i><span class="n" style="text-align:right">${money(r.cost)}</span></div>`).join('')}<div class="note">Priced at API list rates: a measure of usage, not money saved. Chat is estimated from its share of the limit. Set your plan with <code>quotameter config plan max5</code>.</div></div>`;
}
function recsView() {
  $('#recs').innerHTML = S.recommendations.length ? S.recommendations.map((r, i) => `<div class="rec"><div class="ico">${i + 1}</div><div><b>${esc(r.title)}</b> ${esc(r.body)}</div></div>`).join('') : '<div class="empty">Nothing stands out. Your usage looks efficient.</div>';
  if (S.findings?.length) { $('#findingsWrap').hidden = false; $('#findings').innerHTML = S.findings.map((f) => `<li>${esc(f)}</li>`).join(''); }
  $('#foot').innerHTML = `Generated by quotameter from local files only. Sources: <code>claude -p /usage</code>, Claude Code session logs (${S.sources.messages} responses), ${S.sources.desktop ? 'Claude Desktop usage history, ' : ''}<code>/context</code> snapshot. Chat figures and tool shares are estimates. Not affiliated with Anthropic.`;
}

// ---------- wiring ----------
// Ranges with data only: 90 days and all history appear once there is more than the shorter range holds.
function rangeButtons() {
  const label = { h5: '5-hour window', wk: 'This week', fable: 'Fable this week', d30: '30 days', d90: '90 days', all: 'All history' };
  $('#winSel').innerHTML = ['h5', 'wk', 'fable', 'd30', 'd90', 'all'].filter((k) => S.breakdown[k]).map((k) => `<button role="tab" data-win="${k}" aria-selected="${k === WIN}">${label[k]}</button>`).join('');
  document.querySelectorAll('#winSel button').forEach((b) => b.addEventListener('click', () => {
    WIN = b.dataset.win;
    document.querySelectorAll('#winSel button').forEach((x) => x.setAttribute('aria-selected', x === b));
    breakdown();
  }));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'p-' + b.dataset.tab));
}));
document.querySelectorAll('#weekMode button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === WEEK_MODE));
document.querySelectorAll('#weekMode button').forEach((b) => b.addEventListener('click', () => {
  WEEK_MODE = b.dataset.mode;
  document.querySelectorAll('#weekMode button').forEach((x) => x.setAttribute('aria-selected', x === b));
  weekTokChart();
}));
header();
document.addEventListener('click', (e) => { if (e.target.id === 'themeBtn') { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; } });
glance(); meters(); stacks(); useTiles(); useTables(); rangeButtons(); breakdown(); valueView(); recsView();
// The heatmap card shows or hides first, so the charts beside it measure the right width.
function render() { historyView(); lineChart(); weekTokChart(); dailyChart(); }
render();
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });
