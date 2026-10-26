### Findings

#### 1. Wrong Fable calibration factor (k)
* **Severity**: High
* **File and Line**: [windows.js:71-77](../../plugins/quotameter/lib/model/windows.js#L71-L77)
* **Problem**: [`calibrate`](../../plugins/quotameter/lib/model/windows.js#L64) marks samples unclean if `activity.some()` detects Claude Desktop activity. Claude Desktop does not run Fable models. Because Desktop is active during the week, clean samples for `weekly_scoped` become zero. The function falls back to the 20th percentile of all samples (`percentile(all.slice(-20), 0.2)`). That formula was designed to discount hidden chat for 5-hour and weekly windows. Because Fable usage has no chat, taking the 20th percentile deflates Fable k below its true rate.
* **Fix**: For `kind === 'weekly_scoped'`, ignore Desktop activity and compute k using the median (50th percentile) across all scoped samples.

#### 2. Single session overwrite and stale baseline in windowBase
* **Severity**: High
* **File and Line**: [statusline.js:60-74](../../plugins/quotameter/lib/statusline.js#L60-L74)
* **Problem**: [`windowBase`](../../plugins/quotameter/lib/statusline.js#L60) stores a single JSON object in `window-base.json` rather than a map of sessions. Switching between sessions or resuming an older session from a previous day overwrites the file. When returning to the first session, `base.session === session` evaluates to false. It resets `base.cost` to 0, which pulls the full lifetime cost into the current window. In addition, when a window rolls over, `windowBase` sets `base.cost = cost` after the first turn in the new window has already billed. That erases the first turn of each new window.
* **Fix**: Store a dictionary of sessions keyed by `session_id` inside `window-base.json`. Only reset base cost to current cost when entering a new window instance, capturing the baseline before new turn cost is added.

#### 3. Unchecked missing 5-hour reset time
* **Severity**: High
* **File and Line**: [statusline.js:64, 87](../../plugins/quotameter/lib/statusline.js#L64)
* **Problem**: If `input.rate_limits.five_hour.resets_at` is missing or null, [`windowBase`](../../plugins/quotameter/lib/statusline.js#L60) returns `null`. In [`statusText`](../../plugins/quotameter/lib/statusline.js#L80), `base` is null, so it subtracts 0 and multiplies the entire session total by `k.h5`. The status line displays the full session total labeled as `this window`. Once `resets_at` appears later, `base.session === session` is false and `cost` resets to 0, locking in the error.
* **Fix**: If `resets_at` is missing, do not display `this window`. Fall back to showing dollars or suppress the share until a valid reset timestamp arrives.

#### 4. Background refreshK runs outside lock and skips on contention
* **Severity**: Medium
* **File and Line**: [ingest/index.js:27-32, 87-91](../../plugins/quotameter/lib/ingest/index.js#L27-L32)
* **Problem**: In [`ingest`](../../plugins/quotameter/lib/ingest/index.js#L34), [`refreshK`](../../plugins/quotameter/lib/ingest/index.js#L27) executes after `withLock` releases the lock. It reads store files without lock protection, risking corrupt reads during concurrent ingests. Furthermore, if another process holds the lock, `withLock` times out and returns `{ skipped: true }`. Line 87 then skips `refreshK()`. When `k.json` is missing, it remains missing until an unblocked ingest occurs.
* **Fix**: Keep calibration refresh under lock protection or make it atomic, and allow `refreshK` to attempt updating `k.json` when the file is absent.

#### 5. Scoped window retention summaries are incomplete and unread
* **Severity**: Medium
* **File and Line**: [retention.js:60-76](../../plugins/quotameter/lib/model/retention.js#L60-L76)
* **Problem**: [`windowRows`](../../plugins/quotameter/lib/model/retention.js#L57) processes `weekly_scoped`, but token metrics (`fresh`, `cacheRead`, `chatTokens`, `hits`) are only populated for `weekly_all`. More importantly, neither [`analyze`](../../plugins/quotameter/lib/model/analyze.js#L57) nor [`insights`](../../plugins/quotameter/lib/model/insights.js) reads archived `weekly_scoped` windows from `windows.jsonl`. Once raw readings pass the retention cutoff and are pruned, historical Fable window data is ignored.
* **Fix**: If Fable history is intended for long-term reports, aggregate token fields for `weekly_scoped` in `windowRows` and read them in [`analyze`](../../plugins/quotameter/lib/model/analyze.js#L57). Otherwise, filter `weekly_scoped` out of `windowRows`.

#### 6. Pro plan processes lingering Fable readings
* **Severity**: Medium
* **File and Line**: [analyze.js:41-44](../../plugins/quotameter/lib/model/analyze.js#L41-L44)
* **Problem**: [`prepare`](../../plugins/quotameter/lib/model/analyze.js#L30) only checks `!wins.length` before building `weekly_scoped`. If a user on a Pro plan has residual `weekly_scoped` readings in the store, `kinds.weekly_scoped` is populated and displayed in meters and stacks despite the plan configuration.
* **Fix**: Check `config.plan !== 'pro'` in [`prepare`](../../plugins/quotameter/lib/model/analyze.js#L30) before processing `weekly_scoped`.

#### 7. Double full analysis and slow ingest path
* **Severity**: Medium
* **File and Line**: [quotameter.js:108-118](../../plugins/quotameter/bin/quotameter.js#L108-L118) and [ingest/index.js:30-31](../../plugins/quotameter/lib/ingest/index.js#L30-L31)
* **Problem**: In [`buildSummary`](../../plugins/quotameter/bin/quotameter.js#L107), `await ingest({ poll })` calls [`refreshK`](../../plugins/quotameter/lib/ingest/index.js#L27), which runs a full [`analyze()`](../../plugins/quotameter/lib/model/analyze.js#L57) including 30-day, 90-day, all-history breakdowns and insights. Immediately afterward, line 118 runs [`analyze()`](../../plugins/quotameter/lib/model/analyze.js#L57) a second time.
* **Fix**: In [`refreshK`](../../plugins/quotameter/lib/ingest/index.js#L27), call a lightweight function that runs only [`prepare`](../../plugins/quotameter/lib/model/analyze.js#L30) to update `k.json`. Avoid running `analyze()` twice in `buildSummary`.

#### 8. Status line disk I/O bottleneck
* **Severity**: Low
* **File and Line**: [statusline.js:164](../../plugins/quotameter/lib/statusline.js#L164)
* **Problem**: On every single status line refresh, `statusline` calls [`latestReadings`](../../plugins/quotameter/lib/warn.js#L47), which reads 64 KB tails from three files and parses JSON lines just to look up `fable`.
* **Fix**: Cache the latest Fable reading in memory or in a small dedicated stamp file.

#### 9. adviceFor reports non-tight windows
* **Severity**: Low
* **File and Line**: [warn.js:154-168](../../plugins/quotameter/lib/warn.js#L154-L168)
* **Problem**: In [`adviceFor`](../../plugins/quotameter/lib/warn.js#L152), if only Fable is tight (`tightF` is true), line 165 and 166 still append the 5-hour and weekly window percentages because they check `live(h)` and `live(w)` instead of `tight5` and `tightWk`.
* **Fix**: Only push windows into `parts` when their corresponding threshold flag (`tight5`, `tightWk`, `tightF`) is true.

#### 10. Documentation and implementation mismatches
* **Severity**: Low
* **File and Line**: [README.md:68, 224](../../README.md#L68), [analyze.js:54](../../plugins/quotameter/lib/model/analyze.js#L54), and [docs/DESIGN.md:174](../../docs/DESIGN.md#L174)
* **Problem**:
  1. [README.md](../../README.md#L68) line 68 still lists the outdated status line format without session share or Fable.
  2. [README.md](../../README.md#L224) line 224 documents `adviseAt` for 5-hour and weekly windows, omitting Fable.
  3. [docs/DESIGN.md](../../docs/DESIGN.md#L174) states `saveK()` prefers the current window's points-per-dollar (`now`) over the median for all labels. However, [`saveK`](../../plugins/quotameter/lib/model/analyze.js#L51) only uses `now` for `h5` and `fable`, while writing `wk: c.wk?.k || null` and ignoring `c.wk?.now`.
* **Fix**: Update the README examples and `adviseAt` descriptions, and align [`saveK`](../../plugins/quotameter/lib/model/analyze.js#L51) with the design document.
