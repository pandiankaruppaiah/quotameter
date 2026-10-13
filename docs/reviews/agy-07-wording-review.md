### 1. User-Visible "Points" or "Pts"

1. **`weekly-limit points` unit string in 30-day breakdown metadata**
   - **File**: [`plugins/quotameter/lib/model/analyze.js`](../../plugins/quotameter/lib/model/analyze.js#L465)
   - **Line**: 465
   - **Severity**: Medium
   - **Fix**: Replace `unit: 'weekly-limit points'` with `unit: '% of a weekly limit'` so `summary.json` and JSON consumers match the new percentage unit naming used in [`template.html:564`](../../plugins/quotameter/lib/report/template.html#L564).

2. **Ambiguous "same point" phrasing in history tile**
   - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L619)
   - **Line**: 619
   - **Severity**: Low
   - **Fix**: Change tile title `'This week vs last week, same point'` to `'This week vs last week, same time of week'` to prevent users confusing a point in time with quota points.

---

### 2. Percentage Limits and Dollar Values

3. **Breakdown projects table renders `n/a` instead of cost when calibration is absent**
   - **File**: [`plugins/quotameter/lib/model/analyze.js`](../../plugins/quotameter/lib/model/analyze.js#L318)
   - **Line**: 318
   - **Severity**: High
   - **Fix**: [`projRows`](../../plugins/quotameter/lib/model/analyze.js#L318) omits the `cost` field on mapped project objects. When `!hasPts` is true, [`template.html:582`](../../plugins/quotameter/lib/report/template.html#L582) reads `key(r) = r.cost` (`undefined`), causing [`ptsBar`](../../plugins/quotameter/lib/report/template.html#L567) to display `<span class="muted">n/a</span>` under the `Cost` column. Add `cost: r(g.cost)` to [`analyze.js:318`](../../plugins/quotameter/lib/model/analyze.js#L318).

4. **Terminal summary displays 5-hour model percentages directly under weekly context**
   - **File**: [`plugins/quotameter/lib/report/render.js`](../../plugins/quotameter/lib/report/render.js#L47-L48)
   - **Line**: 47-48
   - **Severity**: Medium
   - **Fix**: Line 46 outputs `"This week: ..."`, followed immediately by line 48 printing `"Top models: ... X%"`. Because these model rows come from `s.breakdown.h5` without a window label, users misread `X%` as their weekly share. Update line 48 to `'Top models (5-hour): '` or append `% of 5h limit`.

5. **Daily chart tooltip omits limit qualifier on chat share**
   - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L513)
   - **Line**: 513
   - **Severity**: Low
   - **Fix**: Tooltip renders `Claude Code: ${pt(i.code)}% of the week<br>Chat, estimated: ${pt(i.chat)}%`. Chat is also a percentage of the weekly limit. Change chat label to `Chat, estimated: ${pt(i.chat)}% of the week`.

6. **Ambiguous limit attribution for heavy session in session cost tile**
   - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L437)
   - **Line**: 437
   - **Severity**: Low
   - **Fix**: Subtitle renders `heavy ones ${pt(sc.heavyH5)}% · ${pt(sc.medianWk)}% of the week`. Because `heavyH5` lacks a limit qualifier right before `% of the week`, users misread it as a weekly percentage. Change to `heavy ones ${pt(sc.heavyH5)}% of 5h · ${pt(sc.medianWk)}% of the week`.

---

### 3. Explanation of 30-Day Summed Percentages

7. **Introductory note contradicts multi-week summed percentages**
   - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L148)
   - **Line**: 148
   - **Severity**: Medium
   - **Fix**: The note states `"All percentages in this report are shares of your plan's limits, the same numbers claude.ai shows under Settings, Usage."` Claude.ai only shows single-window values (0-100%). Seeing totals like 280% in the 30-day breakdown makes users suspect a calculation error. Clarify that 30-day totals sum weekly allowances across the period.

8. **Missing mental model for >100% totals across 30 days**
   - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L213) and [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L572)
   - **Line**: 213, 572
   - **Severity**: Low
   - **Fix**: In [`notes.d30`](../../plugins/quotameter/lib/report/template.html#L572) and the [`branchTable`](../../plugins/quotameter/lib/report/template.html#L213) subtitle, state that 30 days provides ~4.3 weeks of quota: `'so 100% is one full week of allowance (out of ~4.3 weeks in 30 days)'`.

---

### 4. Week Range Labels and Empty-Week Handling

9. **Early return in `weekTokChart` bypasses empty-week rendering and leaves stale note**
   - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L488)
   - **Line**: 488
   - **Severity**: High
   - **Fix**: Line 488 checks `if (!wk.length || !wk.some((w) => w.fresh || w.cacheRead || w.chat))`. When all 6 weeks are empty (`empty: true`), `!wk.some(...)` is true, so the function sets `<div class="empty">No token usage recorded yet.</div>` and returns immediately. This blocks the new empty-week bar rendering (drawing 'no data' per column), skips date range labels, and leaves [`#weekTokNote`](../../plugins/quotameter/lib/report/template.html#L499) unmanaged. Change condition to `if (!wk?.length)` so the chart draws the 6 empty weeks with 'no data', or clear [`#weekTokNote`](../../plugins/quotameter/lib/report/template.html#L499) before returning.

10. **Week date range strings collide and overlap horizontally in SVG**
    - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L492-L493)
    - **Line**: 492-493
    - **Severity**: Medium
    - **Fix**: In [`span()`](../../plugins/quotameter/lib/report/template.html#L491), strings like `'28 Sep to 4 Oct'` (15 characters) and `'8 to 14 Oct'` (11 characters) are 75px to 100px wide. With 6 bars across a 320-480px width, each column band is only 44-71px wide, causing middle-anchored labels to collide with neighboring columns. Use a compact separator like `'8-14 Oct'` and `'28 Sep-4 Oct'`, or split month-crossing labels into two `<tspan>` lines.

11. **Daylight Saving Time shifts truncate 7-day span calculation to 6 days**
    - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L492)
    - **Line**: 492
    - **Severity**: Medium
    - **Fix**: `const b = new Date(Date.parse(w.end) - 86400000)` subtracts fixed 24-hour millisecond intervals. If a week crosses a 25-hour fall-back DST transition, subtracting 86,400,000 ms from midnight lands at 23:00 on day 6, causing `b.getDate()` to return 13 instead of 14 (`'8 to 13 Oct'`). Use calendar day arithmetic: `const b = new Date(a); b.setDate(b.getDate() + 6);`.

12. **Misleading "No data for this week" tooltip on current active week**
    - **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L497)
    - **Line**: 497
    - **Severity**: Low
    - **Fix**: When `w.current` is empty, tooltip says `'No data for this week'`. For the current window in progress, this sounds like an ingestion error rather than an idle period. Update to `i.current ? \`<b>${i.range}</b> (in progress)<br>No activity yet this week\` : \`<b>${i.range}</b><br>No data for this week\``.
