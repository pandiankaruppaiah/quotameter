I have reviewed the new code across [`insights.js`](../../plugins/quotameter/lib/model/insights.js), [`analyze.js`](../../plugins/quotameter/lib/model/analyze.js), [`util.js`](../../plugins/quotameter/lib/model/util.js), [`template.html`](../../plugins/quotameter/lib/report/template.html), [`render.js`](../../plugins/quotameter/lib/report/render.js), and [`quotameter.test.js`](../../test/quotameter.test.js).

---

### What is Fine

1. **Formula correctness and unit consistency**:
   - `k.h5` and `k.wk` are handled as points per dollar for the 5-hour window and weekly window respectively.
   - In [`sessionCost()`](../../plugins/quotameter/lib/model/insights.js#L83-L109), `med * k.h5` and `heavy * k.h5` correctly convert list-price dollars to 5-hour limit points, and `Math.floor(room / (med * k.h5))` calculates remaining sessions.
   - In [`whatIf()`](../../plugins/quotameter/lib/model/insights.js#L146-L160), [`cache()`](../../plugins/quotameter/lib/model/insights.js#L162-L205), [`subagents()`](../../plugins/quotameter/lib/model/insights.js#L207-L223), and [`branches()`](../../plugins/quotameter/lib/model/insights.js#L312-L329), points are scaled using `kWk`, correctly reflecting weekly limit points.
   - In [`burnRate()`](../../plugins/quotameter/lib/model/insights.js#L255-L273), `h5PerHour` (`cost * k.h5 / hours`) and `wkPerHour` (`cost * k.wk / hours`) are separated, and `hoursPerWindow` (`100 / ((cost * k.h5) / hours)`) calculates the hours of steady work required to fill a 5-hour window.
   - In [`weeklyTokens()`](../../plugins/quotameter/lib/model/insights.js#L62-L80), `(win.chat / kWk) * tpd` converts chat points into list-price dollars and then into token volume using the token-per-dollar ratio.
2. **Double counting and time ranges**:
   - In [`weeklyTokens()`](../../plugins/quotameter/lib/model/insights.js#L68-L70), `fresh` (`in + out + cw5 + cw1h`), `cacheRead` (`cr`), and estimated `chat` tokens are mutually exclusive categories and are not double-counted.
   - In [`stretches()`](../../plugins/quotameter/lib/model/insights.js#L244-L253), activity clustering uses non-overlapping blocks with a 15-minute gap threshold, and residual synthetic rows are excluded from turn-based timing.
   - In [`attribute()`](../../plugins/quotameter/lib/model/analyze.js#L173-L193), `chatSteps` records individual step increments per window, ensuring attribution intervals do not overlap.
3. **XSS sanitization**:
   - Dynamic values coming from message and session logs (projects, branches, session titles, agent names, models, tools) pass through [`esc()`](../../plugins/quotameter/lib/report/template.html#L283) before DOM insertion in [`useTables()`](../../plugins/quotameter/lib/report/template.html#L504-L549) and [`breakdown()`](../../plugins/quotameter/lib/report/template.html#L558-L585).
   - Embedded JSON data in [`renderHtml()`](../../plugins/quotameter/lib/report/render.js#L9-L17) escapes `<` characters and Unicode separators.
4. **Em dash characters**:
   - No em dash characters (`\u2014`) exist in [`insights.js`](../../plugins/quotameter/lib/model/insights.js), [`analyze.js`](../../plugins/quotameter/lib/model/analyze.js), [`util.js`](../../plugins/quotameter/lib/model/util.js), [`template.html`](../../plugins/quotameter/lib/report/template.html), or [`render.js`](../../plugins/quotameter/lib/report/render.js). Middle dots (`·`) and hyphens are used consistently.

---

### Numbered Findings

#### 1. Chat points dropped and misleading subtitle when Code is idle in the 14-day window
- **File**: [`plugins/quotameter/lib/model/insights.js`](../../plugins/quotameter/lib/model/insights.js#L347-L366) and [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L494-L498)
- **Line**: `insights.js` line 347-366; `template.html` line 494-498
- **Severity**: High
- **Issue**: In [`daily()`](../../plugins/quotameter/lib/model/insights.js#L334-L368), `pointsKnown` is set to `true` only inside the message loop when `m.adj * r` executes (`if (r != null) { pointsKnown = true; }`). If the user has valid weekly readings and chat activity, but did not run Claude Code on this machine during the last 14 days (or only had background operations where `codeCost === 0`), `pointsKnown` remains `false`.
  This causes two bugs:
  1. [`daily()`](../../plugins/quotameter/lib/model/insights.js#L365) returns `unit: 'dollars'`. In [`template.html`](../../plugins/quotameter/lib/report/template.html#L495), `pts` is false, causing the subtitle to state: `"Last 14 days · no weekly readings yet, so Claude Code is shown at list price and chat is not estimated."` This is misleading because weekly readings do exist.
  2. In [`template.html`](../../plugins/quotameter/lib/report/template.html#L498), `parts` falls back to `[x.cost, 0]`, completely zeroing out the estimated chat points (`x.chat`) from the chart bars.
- **Fix**: In [`daily()`](../../plugins/quotameter/lib/model/insights.js#L347), evaluate `pointsKnown` based on whether weekly windows cover the 14-day window with limit readings:
  ```javascript
  const pointsKnown = wkWins.some(({ w }) => w.resetsAt > today - 14 * DAY && w.pct != null);
  ```
  Pass `k.wk` into `daily()` so that if `rate(t)` is null for a message, `m.adj * k.wk` provides the point rate. In [`template.html`](../../plugins/quotameter/lib/report/template.html#L495), adjust the subtitle condition to check whether weekly readings exist.

---

#### 2. Null peaks format as `'n/a%'` in limit binding tile
- **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L440)
- **Line**: `template.html` line 440
- **Severity**: Medium
- **Issue**: In [`useTiles()`](../../plugins/quotameter/lib/report/template.html#L428-L453) under the "Which limit stops you" tile, when `b.verdict === 'neither'`, the subtitle evaluates:
  ```javascript
  `Highest in 30 days: 5-hour ${b.h5Peak ?? 'n/a'}%, weekly ${b.wkPeak ?? 'n/a'}%`
  ```
  If either `b.h5Peak` or `b.wkPeak` is `null` (for instance, when readings exist for one limit window type but not the other), the string renders as `5-hour n/a%` or `weekly n/a%`.
- **Fix**: Format the percentage symbol conditionally:
  ```javascript
  `Highest in 30 days: 5-hour ${b.h5Peak != null ? b.h5Peak + '%' : 'n/a'}, weekly ${b.wkPeak != null ? b.wkPeak + '%' : 'n/a'}${b.wkProjected != null ? ` (this week heading for ${b.wkProjected}%)` : ''}`
  ```

---

#### 3. What-if subtitle claims "in weekly-limit points" when calibration is null
- **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L508)
- **Line**: `template.html` line 508
- **Severity**: Low
- **Issue**: In [`useTables()`](../../plugins/quotameter/lib/report/template.html#L504-L549), the card subtitle is hardcoded:
  ```javascript
  $('#whatIfSub').textContent = `Opus and Fable usage ${wi.period}, in weekly-limit points.`;
  ```
  Prior to the first weekly calibration (`k.wk` is null), [`whatIf()`](../../plugins/quotameter/lib/model/insights.js#L156-L157) produces `null` for `actualPts`, `sonnetPts`, and `haikuPts`. The table then displays values solely in list-price dollars via `money(c)`. The subtitle claiming "in weekly-limit points" is misleading when only dollars are shown.
- **Fix**: Check whether points are present before rendering the subtitle:
  ```javascript
  const hasPts = wi.rows.some((r) => r.actualPts != null);
  $('#whatIfSub').textContent = `Opus and Fable usage ${wi.period}${hasPts ? ', in weekly-limit points.' : ' at list price (calibration pending).'}`;
  ```

---

#### 4. Ambiguous phrasing "of 5 hours" in session cost tile
- **File**: [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L436)
- **Line**: `template.html` line 436
- **Severity**: Low
- **Issue**: In [`useTiles()`](../../plugins/quotameter/lib/report/template.html#L436), the tile renders:
  ```javascript
  sc.medianH5 != null ? `${pt(sc.medianH5)}% ${small('of 5 hours')}` : money(sc.medianCost)
  ```
  Describing quota percentage points as "X% of 5 hours" can easily be misinterpreted by users as session elapsed duration (e.g., 20% of 5 hours = 1 hour of time), rather than quota utilization of the 5-hour allowance.
- **Fix**: Clarify the unit label to reference the limit window:
  ```javascript
  sc.medianH5 != null ? `${pt(sc.medianH5)}% ${small('of 5h limit')}` : money(sc.medianCost)
  ```

---

#### 5. Strict 1-hour threshold in weeklyTokens breaks across Daylight Saving Time boundaries
- **File**: [`plugins/quotameter/lib/model/insights.js`](../../plugins/quotameter/lib/model/insights.js#L71)
- **Line**: `insights.js` line 71
- **Severity**: Low
- **Issue**: In [`weeklyTokens()`](../../plugins/quotameter/lib/model/insights.js#L62-L80):
  ```javascript
  const win = wkWins.find((x) => Math.abs(x.w.start - start) < HOUR);
  ```
  `start` is generated using fixed 7-day increments: `anchor - i * 7 * DAY` (`7 * 86400000` ms). When a Daylight Saving Time shift occurs between weeks, the actual weekly reset interval can be 167 or 169 hours. The timestamp delta `Math.abs(x.w.start - start)` can equal or exceed `HOUR` (3,600,000 ms), causing `win` to be undefined. The week's chat estimation drops to 0 and `pct` becomes null.
- **Fix**: Widen the threshold or match on window overlap:
  ```javascript
  const win = wkWins.find((x) => Math.abs(x.w.start - start) < 2 * HOUR);
  ```

---

#### 6. Inconsistent schema return in subagents helper when agent cost is zero
- **File**: [`plugins/quotameter/lib/model/insights.js`](../../plugins/quotameter/lib/model/insights.js#L211)
- **Line**: `insights.js` line 211
- **Severity**: Low
- **Issue**: In [`subagents()`](../../plugins/quotameter/lib/model/insights.js#L208-L223), if `!agent`, the function returns:
  ```javascript
  return { agentCost: 0, mainCost: round(main, 2), ratio: 0, share: 0, sessionsWithAgents: 0 };
  ```
  This omits `agentPts` and `medianSessionRatio` (leaving them `undefined`), whereas the non-empty path explicitly provides `agentPts` and `medianSessionRatio` as `null` or numeric values. While [`template.html`](../../plugins/quotameter/lib/report/template.html#L522-L526) handles loose null checks, returning a consistent object structure prevents undefined property issues in external consumers.
- **Fix**: Return consistent keys in the early return:
  ```javascript
  if (!agent) return { agentCost: 0, mainCost: round(main, 2), agentPts: null, ratio: 0, share: 0, sessionsWithAgents: 0, medianSessionRatio: null };
  ```

---

#### 7. Insights integration test lacks weekly window coverage
- **File**: [`test/quotameter.test.js`](../../test/quotameter.test.js#L236-L240)
- **Line**: `test/quotameter.test.js` line 236-240
- **Severity**: Low
- **Issue**: In the insights test at the end of [`test/quotameter.test.js`](../../test/quotameter.test.js#L219-L260), all mock readings use `kind: 'session'`. There are no readings for `kind: 'weekly_all'`. As a result, weekly calibration, weekly point calculations in `whatIf`, `branches`, `daily`, and `sessionCost.leftWeek` are not covered by the test assertions.
- **Fix**: Include at least one weekly reading in `data.readings`:
  ```javascript
  { ts: iso(start + H), t: start + H, r: curReset + 6 * 24 * H, kind: 'weekly_all', percent: 12, source: 'test' },
  ```
  and add assertions for `I.whatIf.rows[0].actualPts` and `I.daily.unit`.
