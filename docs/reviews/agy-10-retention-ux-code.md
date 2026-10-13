### Numbered Findings

1. **Crash between summary append and state write causes permanent double counting**
   * **File & Line**: [retention.js](../../plugins/quotameter/lib/model/retention.js#L98-L105), [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L78-L94)
   * **Severity**: MUST
   * **Issue**: `compact()` appends to `daily.jsonl` and `windows.jsonl` before calling `writeState(state)`. If a crash occurs between the appends and `writeState`, the new summaries are on disk but `state.archived` and `state.compactedBefore` are not updated. `loadData()` will load raw messages and `loadArchive()` will load the summaries, double-counting both. If compaction runs on a subsequent day with a new cutoff, duplicate entries with a new ID (`${day}|${newCutoff}`) are appended to `daily.jsonl`, causing permanent double counting across all history.
   * **Fix**: In `loadArchive()` ([analyze.js](../../plugins/quotameter/lib/model/analyze.js#L78-L94)), pass `state` and only load rows where the cutoff timestamp in `d.id` is `<= state.compactedBefore`. Additionally, deduplicate `daily.jsonl` rows by day when reading by merging cell totals.

2. **Window rounding mismatch between `loadData()` and `windowRows()` duplicates limit windows**
   * **File & Line**: [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L65), [retention.js](../../plugins/quotameter/lib/model/retention.js#L61)
   * **Severity**: MUST
   * **Issue**: `buildWindows()` rounds reset timestamps to the nearest minute (`Math.round(r.r / 60000) * 60000`). `windowRows()` checks rounded `w.resetsAt <= cutoff` and writes the window to `windows.jsonl`. However, `loadData()` filters readings using raw unrounded timestamps (`r.r > cb`). If `r.r` is up to 30 seconds past cutoff, it rounds down to `<= cutoff` (summarised in `windows.jsonl`), but passes `r.r > cb` (retained in raw readings). In [analyze.js:520](../../plugins/quotameter/lib/model/analyze.js#L520) and [insights.js:98-101](../../plugins/quotameter/lib/model/insights.js#L98-L101), `wks` and `weeks` concatenate live windows and archived windows without deduplication, double-counting peak percentages and limit hits.
   * **Fix**: In `loadData()` and `keepReading()`, round `r.r` to the minute before comparing against `cb`: `Math.round(r.r / 60000) * 60000 > cb`. In `analyze.js:520` and `insights.js:98-101`, deduplicate combined window arrays on `${kind}|${resetsAt}`.

3. **`weeklyTokens()` double-counts unarchived sessions spanning the cutoff**
   * **File & Line**: [insights.js](../../plugins/quotameter/lib/model/insights.js#L77-L79)
   * **Severity**: MUST
   * **Issue**: When an archived week exists (`useOld = true`), `old.fresh` and `old.cacheRead` already include the full token counts for that week. Line 77 filters `inB = msgs.filter(m => m.t > start && m.t <= end && !(useOld && m.archived))`, keeping raw messages for unarchived sessions that spanned the cutoff. Line 78 then adds `sum(inB, ...) + old.fresh`. Any session that spanned the cutoff has its tokens counted twice for that week.
   * **Fix**: In [insights.js:78-79](../../plugins/quotameter/lib/model/insights.js#L78-L79), when `useOld` is true, use `old.fresh` and `old.cacheRead` directly without adding `sum(inB, ...)`.

4. **`drainLive()` fails permanently on Windows if drain destination exists, and lacks retry**
   * **File & Line**: [store.js](../../plugins/quotameter/lib/store.js#L108-L113)
   * **Severity**: MUST
   * **Issue**: `drainLive()` targets a static filename `${live}.drain-${process.pid}` using bare `fs.renameSync`. On Windows, `renameSync` throws `EPERM` if the destination already exists (such as from a prior crashed process with the same PID) and will not overwrite it. Because `drainLive()` catches all errors and returns 0, `live.jsonl` will never be drained again for that PID. Furthermore, `drainLive()` does not use `renameRetry()`, so a transient file lock held by `statusline.js` aborts the drain immediately.
   * **Fix**: Use a unique drain path such as `${live}.drain-${process.pid}-${Date.now()}` and use `renameRetry(live, drain)` (ignoring `ENOENT` if `live.jsonl` is absent). Clean up any stale `.drain-*` files on startup.

5. **`quotameter compact` CLI command misses `drainLive()`**
   * **File & Line**: [quotameter.js](../../plugins/quotameter/bin/quotameter.js#L116)
   * **Severity**: SHOULD
   * **Issue**: Running `quotameter compact` invokes `compact({ force: true })` inside `withLock`, but never calls `drainLive()`. Any status line readings and costs currently buffered in `live.jsonl` are skipped and remain undrained.
   * **Fix**: Call `drainLive()` inside `withLock` before calling `compact({ force: true })`.

6. **90-day breakdown tab appears after only 31 days**
   * **File & Line**: [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L528)
   * **Severity**: SHOULD
   * **Issue**: Line 528 enables `d90` whenever `first < now - 30 * DAY`. A user with 31 days of logs gets a "90 days" tab that only contains 31 days of data. This contradicts the UX decision in `docs/reviews/agy-08-ux-review.md` ("Do not add a 90-day view next to the 30-day view... show the 90-day option only after 90 days of local records exist").
   * **Fix**: Change line 528 to `if (first < now - 90 * DAY) result.breakdown.d90 = longRange(90);`. To expose longer history beyond 30 days without mislabeling, enable `all` when `first < now - 30 * DAY`.

7. **`dailyRows()` does not respect `config.redactPaths`**
   * **File & Line**: [retention.js](../../plugins/quotameter/lib/model/retention.js#L37)
   * **Severity**: SHOULD
   * **Issue**: Design finding 7 required that project paths in `daily.jsonl` use hashed identifiers (`project-${hash}`) when `config.redactPaths` is true. `dailyRows()` uses `path.basename(m.cwd)` without checking `cfg.redactPaths`. If messages were scanned prior to setting `redactPaths: true`, unredacted project directory names are written permanently into `daily.jsonl`.
   * **Fix**: Pass `cfg` into `dailyRows()`. If `cfg.redactPaths` is true and `project` does not already start with `project-`, hash the project name.

8. **`planFit` wording awkwardness when limit was never hit**
   * **File & Line**: [insights.js](../../plugins/quotameter/lib/model/insights.js#L112), [insights.js](../../plugins/quotameter/lib/model/insights.js#L117)
   * **Severity**: NIT
   * **Issue**: In `planFit()`, if `hits === 0` but `avg >= 40` (the "fits" verdict on line 117) or `avg >= 85` (the "tight" verdict on line 112), the text reads: "and hit the 5-hour limit 0 times."
   * **Fix**: Replace with `${hits ? `hit the 5-hour limit ${hits} time${hits === 1 ? '' : 's'}` : 'never hit the 5-hour limit'}`.

9. **Negative time display in tooltip when window reset is in the past**
   * **File & Line**: [template.html](../../plugins/quotameter/lib/report/template.html#L281)
   * **Severity**: NIT
   * **Issue**: `until(iso) => dur(Date.parse(iso) - Date.now())`. If a report is viewed after a window reset has elapsed, `until()` displays negative durations like "in -4 m".
   * **Fix**: In [template.html:281](../../plugins/quotameter/lib/report/template.html#L281), return `'resetting now'` if `Date.parse(iso) <= Date.now()`.

---

### What Is Fine

* **Whole-Session Retention**: Archiving whole sessions only (`last.get(session) < cutoff`) cleanly prevents splitting sessions across cutoff boundaries, preserving cost reconciliation scaling.
* **Finding 1 (Residual Cost Explosion)**: Pruning `costs.jsonl` and `sessions.jsonl` alongside `messages.jsonl`, combined with skipping archived sessions in `loadData()` and `scanAll()`, eliminates duplicate synthetic residuals.
* **Finding 3 (Windows Locking)**: `replaceAtomic()` and `renameRetry()` in `store.js` reliably handle Windows `EPERM`/`EBUSY` contention during JSONL rewrites.
* **Finding 6 (UTC Boundaries)**: Partitioning daily summaries on UTC midnight (`Math.floor(t / DAY) * DAY`) prevents timezone and daylight saving boundary shifts.
* **Template Structure & Element IDs**: All 46 element IDs queried by JavaScript exist in `template.html`. The updated section hierarchy (Right now, What used your limit, Make it last longer, Your patterns, Technical details) matches the UX plan.
* **Touch Tooltip Handling**: Touch devices are properly supported via `click` and `e.stopPropagation()` listeners.
* **Em Dash Compliance**: Verified zero em dashes (U+2014) across all code, tests, and markdown files.
