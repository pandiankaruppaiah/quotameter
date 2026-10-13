# agy review 03: verification of fixes

### 1. Status of Accepted and Partly Accepted Findings

1. **Finding 1 ([`openFile`](../../plugins/quotameter/bin/quotameter.js#L45-L50) in [`plugins/quotameter/bin/quotameter.js:45-50`](../../plugins/quotameter/bin/quotameter.js#L45-L50)) - Accepted**
   * **Status:** Incomplete.
   * **Detail:** Switching to `spawn('explorer.exe', [file])` eliminates `cmd.exe` shell injection from paths with `&`. However, `path.resolve(file)` is not applied. On Windows, `explorer.exe` fails to open relative paths provided via `--out` (e.g. `report.html`).

2. **Finding 3 ([`main`](../../plugins/quotameter/bin/quotameter.js#L59-L63) in [`plugins/quotameter/bin/quotameter.js:59-63`](../../plugins/quotameter/bin/quotameter.js#L59-L63) and [`statusline`](../../plugins/quotameter/lib/statusline.js#L63-L79) in [`plugins/quotameter/lib/statusline.js:64-68`](../../plugins/quotameter/lib/statusline.js#L64-L68)) - Accepted**
   * **Status:** Correct for hooks; partly complete for statusline.
   * **Detail:** Hooks no longer read `stdin` and launch detached immediately. [`statusline`](../../plugins/quotameter/lib/statusline.js#L63-L79) exits on `process.stdin.isTTY`, but still relies on blocking `fs.readFileSync(0, 'utf8')` without an async timeout if `stdin` is a non-TTY open pipe.

3. **Finding 4 ([`desktopDataDirs`](../../plugins/quotameter/lib/paths.js#L27-L45) in [`plugins/quotameter/lib/paths.js:35`](../../plugins/quotameter/lib/paths.js#L35)) - Partly**
   * **Status:** Correct and complete.
   * **Detail:** The regex `/(^|[.])Claude_/i` matches both publisher-prefixed package names (e.g. `AnthropicPBC.Claude_...`) and unprefixed package names (`Claude_...`).

4. **Finding 5 ([`tryLease`](../../plugins/quotameter/lib/store.js#L124-L141) in [`plugins/quotameter/lib/store.js:124-141`](../../plugins/quotameter/lib/store.js#L124-L141) and [`ingest`](../../plugins/quotameter/lib/ingest/index.js#L22-L62) in [`plugins/quotameter/lib/ingest/index.js:28-36`](../../plugins/quotameter/lib/ingest/index.js#L28-L36)) - Accepted**
   * **Status:** Correct and complete.
   * **Detail:** [`tryLease`](../../plugins/quotameter/lib/store.js#L124-L141) with atomic directory creation ensures only one process spawns `pollUsage()` concurrently.

5. **Finding 6 ([`withLock`](../../plugins/quotameter/lib/store.js#L87-L120) in [`plugins/quotameter/lib/store.js:99-108`](../../plugins/quotameter/lib/store.js#L99-L108)) - Accepted**
   * **Status:** Correct and complete.
   * **Detail:** Stale lock directories are atomically renamed to a token-qualified grave path before deletion, preventing two processes from clearing the lock simultaneously.

6. **Finding 7 ([`analyze`](../../plugins/quotameter/lib/model/analyze.js#L397-L478) in [`plugins/quotameter/lib/model/analyze.js:401, 419-420`](../../plugins/quotameter/lib/model/analyze.js#L401)) - Accepted**
   * **Status:** Correct and complete.
   * **Detail:** `tokensPerDollar` falls back to `tpd30` when `inWin` has no billable messages, preventing `chatTokens`, `tokensLeft`, and `tokensPerPoint` from collapsing to zero.

7. **Finding 8 ([`familyOf`](../../plugins/quotameter/lib/model/analyze.js#L381-L384) and [`prettyModel`](../../plugins/quotameter/lib/model/analyze.js#L387-L393) in [`plugins/quotameter/lib/model/analyze.js:377-393`](../../plugins/quotameter/lib/model/analyze.js#L377-L393)) - Accepted**
   * **Status:** Correct and complete.
   * **Detail:** Model families are extracted via keyword matching across `['fable', 'mythos', 'opus', 'sonnet', 'haiku']`, avoiding truncation to `"3"` for Claude 3.x models.

8. **Finding 9 ([`forecast`](../../plugins/quotameter/lib/model/analyze.js#L210-L241) in [`plugins/quotameter/lib/model/analyze.js:220-232`](../../plugins/quotameter/lib/model/analyze.js#L220-L232)) - Accepted**
   * **Status:** Incomplete.
   * **Detail:** Pace calculation falls back to `average` when `recent === 0` (`recent > 0 ? recent : average`), but `paceBasis` still checks `recent != null`. Because `0 != null` is true, the report displays `'last 60 min'` rather than `'window average'`.

9. **Finding 10 ([`findClaude`](../../plugins/quotameter/lib/ingest/usage-poll.js#L16-L20) and [`run`](../../plugins/quotameter/lib/ingest/usage-poll.js#L22-L45) in [`plugins/quotameter/lib/ingest/usage-poll.js:19, 27`](../../plugins/quotameter/lib/ingest/usage-poll.js#L19)) - Accepted**
   * **Status:** Correct and complete.
   * **Detail:** `windowsCmdFallback` remains enabled for `QUOTAMETER_CLAUDE_BIN` on Windows, and all command arguments are quoted inside the `cmd.exe /c` wrapper.

10. **Finding 11 ([`linesFrom`](../../plugins/quotameter/lib/ingest/logs.js#L130-L149) in [`plugins/quotameter/lib/ingest/logs.js:130-149, 206`](../../plugins/quotameter/lib/ingest/logs.js#L130-L149)) - Accepted**
    * **Status:** Correct and complete.
    * **Detail:** Lines are segmented on `0x0a` byte boundaries prior to UTF-8 decoding, preserving incomplete trailing bytes in a `Buffer` and keeping `out.offset` byte-accurate across chunk boundaries.

11. **Finding 12 ([`reconcile`](../../plugins/quotameter/lib/model/analyze.js#L79-L106) in [`plugins/quotameter/lib/model/analyze.js:90-104`](../../plugins/quotameter/lib/model/analyze.js#L90-L104)) - Accepted**
    * **Status:** Correct in recovery, but introduced a regression.
    * **Detail:** Sessions with only `cost-state` totals now generate residual records and count toward unitemised cost. However, the synthesized message creates a point double-counting bug in model breakdowns (see Section 3).

12. **Finding 13 ([`cleanupPollLogs`](../../plugins/quotameter/lib/ingest/usage-poll.js#L138-L155) in [`plugins/quotameter/lib/ingest/usage-poll.js:140`](../../plugins/quotameter/lib/ingest/usage-poll.js#L140)) - Partly**
    * **Status:** Correct and complete.
    * **Detail:** Replaced directory slug mapping with `pollDir().replace(/[^a-zA-Z0-9]/g, '-')`, matching Claude Code's project slug encoding.

13. **Finding 14 (CSP header in [`plugins/quotameter/lib/report/template.html:6`](../../plugins/quotameter/lib/report/template.html#L6)) - Accepted**
    * **Status:** Correct and complete.
    * **Detail:** A `<meta http-equiv="Content-Security-Policy">` tag was added with `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`, preventing outbound network requests.

14. **Finding 15 (Attribution labels in [`plugins/quotameter/lib/model/analyze.js:318`](../../plugins/quotameter/lib/model/analyze.js#L318), [`plugins/quotameter/lib/report/template.html:168`](../../plugins/quotameter/lib/report/template.html#L168), and [`plugins/quotameter/lib/report/render.js:42`](../../plugins/quotameter/lib/report/render.js#L42)) - Partly**
    * **Status:** Incomplete.
    * **Detail:** The label was updated to "Chat and other devices" in [`analyze.js`](../../plugins/quotameter/lib/model/analyze.js#L318) and [`template.html`](../../plugins/quotameter/lib/report/template.html#L168), but [`renderText`](../../plugins/quotameter/lib/report/render.js#L31-L48) in [`render.js:42`](../../plugins/quotameter/lib/report/render.js#L42) still outputs `chat ~${a.chat} points`.

15. **Finding 16 ([`record`](../../plugins/quotameter/lib/statusline.js#L25-L40) in [`plugins/quotameter/lib/statusline.js:35-39`](../../plugins/quotameter/lib/statusline.js#L35-L39)) - Accepted**
    * **Status:** Correct and complete.
    * **Detail:** Throttling uses separate stamp files: `live-reading.stamp` (60s) for limit percentages and `live-cost.stamp` (15s) for live session costs.

16. **Finding 17 ([PRIVACY.md:12-14](../../PRIVACY.md#L12-L14)) - Accepted**
    * **Status:** Correct and complete.
    * **Detail:** Changed section header to "What it never stores" and explicitly describes local in-memory log parsing.

17. **Finding 18 ([README.md:35](../../README.md#L35) and [`plugins/quotameter/lib/report/template.html:481`](../../plugins/quotameter/lib/report/template.html#L481)) - Accepted**
    * **Status:** Correct and complete.
    * **Detail:** Both files now state that list-price totals are an index of usage volume rather than financial savings.

---

### 2. Re-check of Finding 2 ([`plugins/quotameter/hooks/hooks.json`](../../plugins/quotameter/hooks/hooks.json))

The format used in [`plugins/quotameter/hooks/hooks.json`](../../plugins/quotameter/hooks/hooks.json#L1-L13) is correct:
1. Each event (`SessionStart`, `Stop`, `SessionEnd`) correctly maps to an array of matcher group objects: `[ { "hooks": [ ... ] } ]`.
2. Each element inside the inner `"hooks"` array is a valid command action definition (`{ "type": "command", "command": ..., "timeout": 10 }`).
3. The root wrapper `{ "hooks": { ... } }` conforms to Claude Code's plugin hooks schema and passes validation. Finding 2 was a false positive in the previous review; rejecting it was valid.

---

### 3. New Bugs Introduced by the Fixes

1. **MUST: Double-counting of points for residual sessions in breakdown model rows**
   * **File and line:** [`plugins/quotameter/lib/model/analyze.js:316-317`](../../plugins/quotameter/lib/model/analyze.js#L316-L317)
   * **Concrete failure scenario:** When [`reconcile()`](../../plugins/quotameter/lib/model/analyze.js#L79-L106) recovers a session that had zero assistant messages, it synthesizes a message with `cost: 0` and `adj: total`. In [`breakdown()`](../../plugins/quotameter/lib/model/analyze.js#L265-L375), line 316 calculates model points as `g.pts * (g.cost / g.adj || 1)`. When `g.cost === 0`, `0 / g.adj` evaluates to `0`. Because `0` is falsy in JavaScript, `0 || 1` evaluates to `1`, assigning 100% of `g.pts` to that model row. On line 317, `unitemisedAdj` (`m.adj - m.cost`) ALSO adds those identical points to the `Claude Code · not itemised` row. The points are counted twice, causing the sum of model points to exceed total code usage.

2. **SHOULD: `explorer.exe` fails to open report when relative path is passed via `--out`**
   * **File and line:** [`plugins/quotameter/bin/quotameter.js:48`](../../plugins/quotameter/bin/quotameter.js#L48) ([`openFile`](../../plugins/quotameter/bin/quotameter.js#L45-L50))
   * **Concrete failure scenario:** A user on Windows runs `quotameter report --out report.html`. The file is written to `report.html` in the current working directory, but `spawn('explorer.exe', ['report.html'])` does not resolve relative paths against the calling process's working directory. File Explorer fails to open the document and instead opens the user's `Documents` folder or displays an error dialog.

3. **SHOULD: `paceBasis` displays `last 60 min` during coding pauses instead of `window average`**
   * **File and line:** [`plugins/quotameter/lib/model/analyze.js:232`](../../plugins/quotameter/lib/model/analyze.js#L232) ([`forecast`](../../plugins/quotameter/lib/model/analyze.js#L210-L241))
   * **Concrete failure scenario:** A user pauses coding for 30 minutes. `slope(recentPts)` returns `0`. Line 222 falls back to `average`, but line 232 checks `recent != null`. Because `0 != null` is `true`, `paceBasis` evaluates to `last 60 min`. The report displays a pace calculated from the window average while claiming it was derived from the last 60 minutes.

4. **NICE: `statusText` outputs `5h NaN%` when `used_percentage` is undefined**
   * **File and line:** [`plugins/quotameter/lib/statusline.js:47`](../../plugins/quotameter/lib/statusline.js#L47) ([`statusText`](../../plugins/quotameter/lib/statusline.js#L42-L50))
   * **Concrete failure scenario:** Claude Code pipes an initial rate limits payload without `used_percentage` (e.g. `{ rate_limits: { five_hour: {} } }`). [`statusText`](../../plugins/quotameter/lib/statusline.js#L42-L50) runs `Math.round(undefined)`, outputting `5h NaN%` to the status line.

5. **NICE: Synthetic residual messages increment request counts in summary tiles**
   * **File and line:** [`plugins/quotameter/lib/model/analyze.js:358-360`](../../plugins/quotameter/lib/model/analyze.js#L358-L360) ([`breakdown`](../../plugins/quotameter/lib/model/analyze.js#L265-L375))
   * **Concrete failure scenario:** A session containing only background metadata without assistant messages adds a synthetic message to `messages`. In `breakdown()`, `tiles.requests` (`msgs.length`) and `tiles.mainRequests` increment by 1, overreporting request counts.

6. **NICE: `renderText` terminal report outputs outdated `chat` label**
   * **File and line:** [`plugins/quotameter/lib/report/render.js:42`](../../plugins/quotameter/lib/report/render.js#L42) ([`renderText`](../../plugins/quotameter/lib/report/render.js#L31-L48))
   * **Concrete failure scenario:** Running `quotameter report --text` prints `chat ~X points` instead of the broadened label "Chat and other devices".

