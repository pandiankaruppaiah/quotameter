# agy review 01: design

1. **MUST**: Streaming messages create duplicate rows across incremental scans.
   - **Issue**: In [logs.js](../../plugins/quotameter/lib/ingest/logs.js#L117-L154), `scanFile` deduplicates records in memory only within the current read buffer. If a message is streamed across two scan intervals, both the intermediate partial record and the final record are returned and appended to `messages.jsonl`. [store.js](../../plugins/quotameter/lib/store.js#L24-L41) does not deduplicate on read.
   - **Why it matters**: Multi-turn and tool-using responses will be stored multiple times, artificially doubling or tripling token counts, list-price costs, and quota consumption.
   - **Recommendation**: Deduplicate records by `row.id` at the store or query layer (retaining the record where `final: true` and output token count is highest), or run a compaction step before aggregating data.

2. **MUST**: Cost-state reconciliation is completely unhandled in the ingest pipeline.
   - **Issue**: [DESIGN.md](../../docs/DESIGN.md#L37-L45) identifies that per-message records systematically undercount tokens (missing background tasks and final tool-call outputs) and specifies that `cost-state` records are authoritative. However, [logs.js](../../plugins/quotameter/lib/ingest/logs.js#L122-L147) completely omits handling for `rec.type === 'cost-state'`.
   - **Why it matters**: Up to 20% to 30% of session tokens and all background Haiku calls (e.g., session title generators, classifiers) will be permanently omitted from the usage totals.
   - **Recommendation**: Add a handler for `rec.type === 'cost-state'` in `scanFile` to record authoritative session totals, compute `residual = costStateTotals - summedMessageRows`, and store a non-itemized reconciliation record.

3. **MUST**: Pricing table omits all Claude 3, 3.5, and 3.7 model families.
   - **Issue**: [pricing.js](../../plugins/quotameter/lib/model/pricing.js#L11-L30) only contains speculative future model IDs (`claude-opus-5-5`, `claude-fable-5-1`, etc.) and lacks current production models (`claude-3-5-sonnet`, `claude-3-7-sonnet`, `claude-3-5-haiku`, `claude-3-opus`).
   - **Why it matters**: Users running current versions of Claude Code will receive `null` from `priceFor()` and `costOf()`. This propagates `NaN` or `null` through cost weighting, breaking calibration and attribution.
   - **Recommendation**: Add full pricing definitions for the Claude 3.x families and provide a sensible fallback (such as standard Sonnet rates) when an unmapped model is encountered.

4. **MUST**: Unconditional 10-minute OS polling daemon risks quota loss and battery drain.
   - **Issue**: Running `claude -p "/usage"` headless via Task Scheduler, launchd, or cron executes 144 CLI sessions a day. As noted in the sample report, shell argument mangling (such as MSYS path rewriting in Git Bash) previously converted `/usage` into an expensive prompt turn that consumed quota.
   - **Why it matters**: It can drain laptop batteries, pollute session logs, risk account suspension for automated scraping, and accidentally spend user quota to measure quota if CLI execution fails.
   - **Recommendation**: Remove the 24/7 background OS scheduler. Rely on the Claude Code status line feed and `SessionStart`/`Stop` hooks for live data. If headless polling is triggered, enforce direct binary execution with `MSYS_NO_PATHCONV=1` on Windows and make polling strictly opt-in.

5. **MUST**: Concurrency locking and file state replacement are unsafe on Windows.
   - **Issue**: In [store.js](../../plugins/quotameter/lib/store.js#L61-L82), `withLock` has a 5000 ms timeout but a 30000 ms stale check, making stale lock recovery unreachable. It also lacks ownership tokens, allowing an exiting process to delete another process's active lock. Furthermore, `append()` never acquires `withLock()`. In `writeState()`, `fs.renameSync` will throw `EPERM` or `EBUSY` on Windows if the target file has an active read handle.
   - **Why it matters**: Concurrent invocations from status lines and hooks will trigger unhandled filesystem crashes or file corruption on Windows.
   - **Recommendation**: Wrap `append()` in a proper lock. Include process ID and timestamps in lock metadata to verify ownership before release, and replace `renameSync` with a retry-capable atomic file replacement routine for Windows.

6. **SHOULD**: Calibration percentile fails for users who chat regularly (Open Question 2).
   - **Issue**: [DESIGN.md](../../docs/DESIGN.md#L89-L98) assumes that taking the 20th percentile of `r = percent_used / code_cost` isolates pure Code usage. If a subscriber chats on claude.ai or mobile during most 5-hour windows, every window contains hidden chat.
   - **Why it matters**: The 20th percentile will be contaminated by chat, overestimating `k` (percent per dollar). An inflated `k` makes `chat_points = max(0, delta_percent - k * code_cost)` collapse to 0, falsely attributing chat usage to Claude Code.
   - **Recommendation**: Do not rely on a rolling 20th percentile across noisy windows. Track the historical all-time minimum of `r` across multi-week baselines, detect windows with zero browser/desktop activity during off-hours, and allow users to manually tag a clean window as "Code only".

7. **SHOULD**: Dollar list pricing is an inaccurate proxy for quota usage (Open Question 1).
   - **Issue**: API list price discounts cache reads to 10% of input and prices output at 5x input. In contrast, Anthropic rate limits are driven by GPU/TPU compute allocation, where output generation is expensive and cache reads consume negligible generation capacity.
   - **Why it matters**: When cache reads dominate (e.g., 91% of tokens in the sample report), list-price weighting overstates cache read impact and skews window consumption estimates.
   - **Recommendation**: Decouple quota attribution from dollar list prices. Use a multi-variable weighting model where cache reads carry lower relative quota weight and output tokens are weighted higher to reflect compute intensity.

8. **SHOULD**: Deleting poller session logs causes race conditions (Open Question 3).
   - **Issue**: The poller runs inside `~/.quotameter/poll` and deletes the generated session file immediately after parsing.
   - **Why it matters**: Claude Code flushes session logs asynchronously. Deleting open files triggers `EBUSY` on Windows. Additionally, deleting local files does not clean up server-side session records, leaving orphaned sessions in the CLI history.
   - **Recommendation**: Avoid deleting files immediately after execution. Run the poller in an isolated temporary `CLAUDE_CONFIG_DIR`, or retain poll session files in `~/.quotameter/poll` and clean them up through a decoupled garbage collection pass.

9. **SHOULD**: Replace 24/7 background polling with reactive polling (Open Question 4).
   - **Issue**: Polling every 10 minutes around the clock generates unnecessary system churn when the user is inactive.
   - **Why it matters**: It creates redundant log entries with zero delta and wastes system resources.
   - **Recommendation**: Adopt reactive polling: poll only when a Claude Code session is active (via `SessionStart` if the last reading is older than 15 minutes) or on demand when generating a report. Read Claude Desktop's `plan-usage-history.json` when background updates are needed.

10. **SHOULD**: Transition storage architecture to SQLite on Node 22 LTS (Open Question 5).
    - **Issue**: Append-only JSONL files read entirely into memory via `fs.readFileSync` and `.split('\n')` in [store.js](../../plugins/quotameter/lib/store.js#L24-L41) will degrade in speed and memory footprint as logs grow.
    - **Why it matters**: Aggregations across projects, sessions, tools, and models will cause noticeable latency in terminal status line refreshes.
    - **Recommendation**: Node 18 reached end-of-life in 2025; bump the target runtime to Node 22 LTS and use native `node:sqlite`. SQLite provides built-in transactions, atomic operations, indexing, and fast group-by reporting without external dependencies.

11. **SHOULD**: Guard against division by zero and linear forecast instability.
    - **Issue**: In [sample-report.html](../../docs/sample-report.html#L470), `left = total / g.pct * (100 - g.pct)` yields `Infinity` or `NaN` when `g.pct === 0`. Furthermore, a linear 60-minute pace causes time-to-limit forecasts to fluctuate wildly between active coding bursts and breaks.
    - **Why it matters**: At the start of a window, the report renders invalid figures. Linear pace estimates will flicker erratically between "hits limit in 20 minutes" and "won't hit before reset".
    - **Recommendation**: Add a check for `pct === 0` to display "N/A" or fallback to historical averages. Smooth pace forecasts using a time-decayed exponential moving average combined with weekday/hour usage patterns from the history heatmap.

12. **SHOULD**: Fix Windows MSIX package discovery and inode assumptions.
    - **Issue**: In [paths.js](../../plugins/quotameter/lib/paths.js#L35), `desktopDataDirs()` uses `/^Claude_/i`, which misses Windows Store packages that prefix the publisher name (e.g., `AnthropicPBC.Claude_`). Additionally, [DESIGN.md](../../docs/DESIGN.md#L77) relies on inode checks, which are not persistent on Windows NTFS.
    - **Why it matters**: Claude Desktop usage logs will be missed on standard Windows installations, and file rescan logic on Windows will become unreliable.
    - **Recommendation**: Broaden the MSIX directory regex to `/(^|\.)Claude_/i` or `/Anthropic/i`, and identify file changes using normalized paths, file size, and `mtimeMs` instead of POSIX inodes.

13. **SHOULD**: Complete session metadata extraction and stream log parsing.
    - **Issue**: In [logs.js](../../plugins/quotameter/lib/ingest/logs.js#L141-L146), `scanFile` only captures `sessionId` and titles; it never records `start`, `end`, or `entrypoint`. Additionally, `scanFile` uses `Buffer.alloc(size - fromOffset)` to pull whole file segments into memory.
    - **Why it matters**: Session duration and entrypoint details in session tables remain blank. Reading large logs all at once causes high memory allocation spikes.
    - **Recommendation**: Extract session start, end, and entrypoint fields from the session log headers, and parse files using Node line streams (`readline` over an `fs` stream) to maintain constant memory consumption.

14. **NICE**: Improve tool token attribution granularity.
    - **Issue**: When an assistant turn invokes multiple tools, token costs are split equally among them.
    - **Why it matters**: A lightweight `Glob` call gets charged the same token weight as a heavy `Read` call that returned 100k tokens of source code, obscuring which tool actually drove context expansion.
    - **Recommendation**: Where tool result blocks are present, weight tool token attribution by the character length of each tool call's input and output blocks rather than using an unweighted split.

15. **NICE**: Provide path sanitization and strict privacy boundaries.
    - **Issue**: [logs.js](../../plugins/quotameter/lib/ingest/logs.js#L48-L49) stores raw project directory paths (`cwd`) and git branch names in `messages.jsonl`.
    - **Why it matters**: Users working in corporate environments or on sensitive proprietary repositories may be reluctant to install an open-source tool that stores plain-text project paths and branches.
    - **Recommendation**: Add a privacy flag that hashes or strips project paths and branch names before persisting them, and document a verifiable privacy pledge backed by automated tests confirming message text is never written to disk.

