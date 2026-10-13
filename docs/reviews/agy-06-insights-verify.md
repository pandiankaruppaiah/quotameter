### Verification of Findings

1. **Finding 1 (Chat points dropped and misleading subtitle when Code is idle in 14-day window)**: **Fixed**
   [`plugins/quotameter/lib/model/insights.js`](../../plugins/quotameter/lib/model/insights.js#L345-L351) calculates `pointsKnown` from `wkWins` coverage over the 14-day window and falls back to `kWk`. [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L495) updates the subtitle condition text when weekly readings do not cover the period.

2. **Finding 2 (Null peaks format as 'n/a%' in limit binding tile)**: **Fixed**
   [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L440) conditionally appends `%` only when peaks are non-null (`b.h5Peak != null ? b.h5Peak + '%' : 'n/a'`).

3. **Finding 3 (What-if subtitle claims 'in weekly-limit points' when calibration is null)**: **Fixed**
   [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L508) checks `wi.rows.some((r) => r.actualPts != null)` before claiming weekly-limit points, falling back to "at list price until the weekly calibration is ready."

4. **Finding 4 (Ambiguous phrasing 'of 5 hours' in session cost tile)**: **Fixed**
   [`plugins/quotameter/lib/report/template.html`](../../plugins/quotameter/lib/report/template.html#L436) replaces `'of 5 hours'` with `'of the 5-hour limit'`.

5. **Finding 5 (Strict 1-hour threshold in weeklyTokens breaks across DST boundaries)**: **Fixed**
   [`plugins/quotameter/lib/model/insights.js`](../../plugins/quotameter/lib/model/insights.js#L72) widens tolerance to `12 * HOUR`. Because weekly resets occur ~168 hours apart, 12 hours reliably handles clock shifts without risk of matching adjacent weeks.

6. **Finding 6 (Inconsistent schema return in subagents helper when agent cost is zero)**: **Fixed**
   [`plugins/quotameter/lib/model/insights.js`](../../plugins/quotameter/lib/model/insights.js#L212) explicitly includes `agentPts: null` and `medianSessionRatio: null` in the `!agent` early return, matching the full schema.

7. **Finding 7 (Insights integration test lacks weekly window coverage)**: **Fixed**
   [`test/quotameter.test.js`](../../test/quotameter.test.js#L240-L276) adds a `weekly_all` reading at line 240, verifies `w.actualPts`, `I.daily.unit`, and daily point sums at lines 260-262, and adds a dedicated chat-only test at lines 266-276.

---

### New Problems Introduced

**None**. No syntax errors, schema mismatches, em dashes, or regressions were introduced across the modified files.
