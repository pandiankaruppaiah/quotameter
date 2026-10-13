### Verification of Fixes (docs/reviews/agy-10-retention-ux-code.md)

1. **Crash between summary append and state write causes permanent double counting**
   * **Status**: Fixed.
   * **Details**: [`dailyRows`](../../plugins/quotameter/lib/model/retention.js#L52) and [`windowRows`](../../plugins/quotameter/lib/model/retention.js#L64) tag rows with `batch: cutoff`. [`writeState`](../../plugins/quotameter/lib/model/retention.js#L107-L108) commits batches to `state.batches`. [`loadArchive`](../../plugins/quotameter/lib/model/analyze.js#L82-L99) and the `done` filter in [`retention.js:96-97`](../../plugins/quotameter/lib/model/retention.js#L96-L97) only accept committed batches.
   * **New problem**: None.

2. **Window rounding mismatch between loadData() and windowRows() duplicates limit windows**
   * **Status**: Fixed.
   * **Details**: [`roundMinute`](../../plugins/quotameter/lib/model/analyze.js#L22) is shared across [`buildWindows`](../../plugins/quotameter/lib/model/analyze.js#L140), [`loadData`](../../plugins/quotameter/lib/model/analyze.js#L67), and [`keepReading`](../../plugins/quotameter/lib/model/retention.js#L111). Deduplication was added in [`longRange`](../../plugins/quotameter/lib/model/analyze.js#L525-L526) and [`planFit`](../../plugins/quotameter/lib/model/insights.js#L97-L98).
   * **New problem**: [insights.js:97-98](../../plugins/quotameter/lib/model/insights.js#L97-L98): `liveKeys` collects bare `w.resetsAt` without qualifying by window kind. If a live 5-hour window shares a reset timestamp with an archived weekly window (or vice versa), the archived window will be dropped from `old`.

3. **weeklyTokens() double-counts unarchived sessions spanning the cutoff**
   * **Status**: Fixed.
   * **Details**: In [`weeklyTokens`](../../plugins/quotameter/lib/model/insights.js#L76-L82), when `useOld` is true, `inB` is set to `[]`. `fresh` and `cacheRead` use `old.fresh` and `old.cacheRead` directly without adding `sum(inB, ...)`.
   * **New problem**: None.

4. **drainLive() fails permanently on Windows if drain destination exists, and lacks retry**
   * **Status**: Fixed.
   * **Details**: [`drainLive`](../../plugins/quotameter/lib/store.js#L106-L124) uses a unique target path with PID and timestamp, wraps the rename in `renameRetry()`, and scans and recovers any remaining `.drain-*` files.
   * **New problem**: None.

5. **quotameter compact CLI command misses drainLive()**
   * **Status**: Fixed.
   * **Details**: [`bin/quotameter.js:116-119`](../../plugins/quotameter/bin/quotameter.js#L116-L119) executes [`drainLive`](../../plugins/quotameter/lib/store.js#L106) inside `withLock` prior to calling [`compact({ force: true })`](../../plugins/quotameter/lib/model/retention.js#L80).
   * **New problem**: None.

6. **90-day breakdown tab appears after only 31 days**
   * **Status**: Partly fixed (partly declined).
   * **Details**: Retention retains the 30-day threshold for generating `d90` ([analyze.js:534](../../plugins/quotameter/lib/model/analyze.js#L534)). The button label adapts to `Since <date>` when range is under 89 days ([template.html:661](../../plugins/quotameter/lib/report/template.html#L661)).
   * **New problems**:
     * [template.html:567](../../plugins/quotameter/lib/report/template.html#L567): `notes.d90` still hardcodes "Last 90 days... and 90 days hold about 13 weeks" even when the tab is labelled `Since <date>` and holds fewer than 90 days of data.
     * [template.html:661](../../plugins/quotameter/lib/report/template.html#L661): Uses `Date.now()` instead of report snapshot time (`S.generatedAt` or `S.breakdown.d90.range.end`). Viewing an exported report weeks later will label the button "90 days" even if the data only covered 35 days.

7. **dailyRows() does not respect config.redactPaths**
   * **Status**: Fixed.
   * **Details**: [`dailyRows`](../../plugins/quotameter/lib/model/retention.js#L38) hashes unredacted paths to `project-${hash(m.cwd)}` when `redact` is true, and [`compact`](../../plugins/quotameter/lib/model/retention.js#L98) passes `cfg.redactPaths`.
   * **New problem**: None.

8. **planFit wording awkwardness when limit was never hit**
   * **Status**: Fixed.
   * **Details**: [`planFit`](../../plugins/quotameter/lib/model/insights.js#L113-L120) defines `hitText` to say `never hit the 5-hour limit` when `hits === 0` across tight, roomy, and fitting verdicts.
   * **New problem**: None.

9. **Negative time display in tooltip when window reset is in the past**
   * **Status**: Partly fixed.
   * **Details**: [`until`](../../plugins/quotameter/lib/report/template.html#L281) returns `'now'` if `Date.parse(iso) <= Date.now()`, preventing negative numbers.
   * **New problem**: [template.html:328](../../plugins/quotameter/lib/report/template.html#L328) and [template.html:338](../../plugins/quotameter/lib/report/template.html#L338): Both call sites prepend `in ` (`in ${until(w.resetsAt)}`), producing ungrammatical strings like "in now" and "· in now".
