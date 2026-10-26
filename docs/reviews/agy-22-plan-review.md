### Item 1: Quota-Aware Assistant (Prompt Hook)

* **Is the design sound?** Sound in concept, but flawed in cache handling.
* **What breaks it:** Injecting dynamic text (such as fluctuating percentages and countdown minutes) into `additionalContext` on every prompt invalidates Claude Code's prompt cache prefix. This forces full context re-tokenization on every turn, spending quota on cache writes and accelerating exhaustion.
* **Simplest correct version:** Keep `warningFor()` separate for `systemMessage`. In `adviceFor()`, emit `hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." }` without `systemMessage`. To preserve prompt cache, stabilize the text: update only across 5% boundary shifts, round reset countdowns to 30-minute intervals, and ignore readings where `resetsAt <= now`.
* **Tests must cover:** Triggering at or above `adviseAt` (5-hour) and `adviseAt + 10` (weekly); no injection below thresholds or when `adviseAt = 0`; no `systemMessage` emission; ignoring expired windows; stability of output text across consecutive turns.

---

### Item 2: Cost Per Turn and Context in the Status Line

* **Is the design sound?** Flawed.
* **What breaks it:**
  * **Payload contents:** Claude Code passes `cost.total_cost_usd`, `rate_limits.five_hour`, `rate_limits.seven_day`, and `context_window` (which provides `used_percentage`, or `current_usage` against `context_window_size`).
  * **Not a per-turn figure:** Claude Code triggers the status line on terminal resizes, tool updates, and internal UI redraws. A per-refresh cost delta is not a per-turn figure. Consecutive refreshes without new prompts show `+$0.00/turn`, while multi-step tool calls fragment a single turn into micro-deltas, showing wrong numbers.
  * **Performance:** Writing to `live-turn.json` and `live.jsonl` on every refresh creates synchronous disk contention and UI lag.
* **Simplest correct version:** Retain the previous non-zero turn delta across UI redraws instead of overwriting with `+0.0%`. Update turn cost only when cumulative session cost increases following a prompt. Throttle disk writes to `live.jsonl` to once every 15 to 30 seconds. Read `k` from a small cached `k.json`, falling back to dollars if `k` is missing.
* **Tests must cover:** Safe parsing of `context_window` whether `used_percentage` is present or null; terminal redraws preserving the previous turn delta; formatting with `k` (`+X.X%/turn`) and without `k` (`+$X.XX/turn`); resilience against corrupted `k.json` or `live-turn.json`.

---

### Item 3: Session Receipt and Weekly Digest (SessionStart Hook)

* **Is the design sound?** Unsound execution path.
* **What breaks it:**
  * **Visibility:** In Claude Code, a `SessionStart` hook's `systemMessage` is ingested as system prompt context or suppressed from the terminal interface; it is not reliably displayed to the user as a visible terminal message.
  * **Startup lag:** Running `analyze()` synchronously blocks session startup. On a 90-day store, `analyze()` reconciles thousands of records and computes window percentiles. A 1.5-second timeout means the user suffers a noticeable 1.5-second freeze on every session start. If another session holds the store lock, it stalls longer. Additionally, if the previous session's background ingest has not finished, it reads stale data and shows wrong numbers.
* **Simplest correct version:** Never run full `analyze()` in the synchronous startup path. Instead, have the background ingest or previous session exit write a precomputed, lightweight `receipt.json` (under 1 KB). `SessionStart` reads this file in under 2 milliseconds and outputs it.
* **Tests must cover:** Sub-50ms execution time; session receipt printed exactly once per session ID; weekly digest emitted once per weekly cycle; project names omitted when `redactPaths` is true; graceful handling of missing receipt files.

---

### Item 4: Script Guard (`quotameter precheck`)

* **Is the design sound?** Sound and practical.
* **What breaks it:**
  * Polling `claude -p /usage` in headless CI environments without saved credentials can hang or fail.
  * Inverted threshold logic: `percent` in readings represents used allowance. "At least 25% left" requires `100 - percent >= min` (i.e. `percent <= 75`). Inverting this check aborts valid runs.
  * Evaluating an expired window (`resetsAt <= now`) without polling treats an old exhausted window as still exhausted, showing a wrong number.
* **Simplest correct version:** Read `latestReadings()`. If the reading is expired and `--no-poll` is not set, attempt a polled refresh. Calculate `remaining = 100 - percent`. Exit 0 if `remaining >= min`, exit 1 with an abort message if `remaining < min`, and exit 2 if no reading exists or polling fails.
* **Tests must cover:** Exit 0 when remaining quota exceeds minimum; exit 1 when quota is insufficient; exit 2 when readings are absent; expired reading detection; `--window 5h` versus `--window week`.

---

### Item 5: What Fits Before the Reset

* **Is the design sound?** Sound (the math already exists in `lib/model/insights.js`).
* **What breaks it:** Division by zero or NaN when `k.h5` is missing or `quickCost` is 0; grammar errors like "1 quick tasks"; claiming multiple tasks fit when the window resets in 3 minutes (less time than a single task takes).
* **Simplest correct version:** Consume `left.quick`, `left.typical`, and `left.heavy` from `insights.sessionCost`. Guard against missing `k` or zero cost. Compare remaining time (`resetsAt - now`) against `sessionLength.medianMs`. If remaining time is shorter, append: "and only X minutes, less than your usual session."
* **Tests must cover:** Proper singular and plural formatting; zero tasks fitting when room is zero; duration warning when remaining time is below median session length; safe fallbacks when calibration `k` is missing.

---

### Item 6: Reset Alarm

* **Is the design sound?** Sound concept, but vulnerable to OS sleep.
* **What breaks it:**
  * **System sleep:** In Node, a single long `setTimeout` drifts or pauses when the OS enters low-power sleep. If a computer sleeps past the reset time, the timer may fail to trigger on wake.
  * **Platform compatibility:** Linux environments without `notify-send` or X11/Wayland display variables will fail or crash; Windows PowerShell executions can fail if execution policies or window styles are unconstrained.
* **Simplest correct version:**
  * Spawn `quotameter alarm <resetsAt>` detached.
  * The alarm process sleeps in short intervals (such as 30 seconds) checking `Date.now() >= resetsAt`. This ensures waking from sleep triggers within 30 seconds.
  * If the wake time is over 30 minutes past reset, exit silently to avoid firing stale notifications.
  * Fire notifications via dependency-free OS tools:
    * **macOS:** `osascript -e 'display notification "5-hour limit reset" with title "quotameter"'`
    * **Linux:** `notify-send "quotameter" "5-hour limit reset"` (wrapped in try/catch to ignore headless errors)
    * **Windows:** `powershell -NoProfile -NonInteractive -WindowStyle Hidden` using a Windows Forms `NotifyIcon` balloon tip.
* **Tests must cover:** Delay calculation; immediate firing if the system wakes past the reset time; suppression of obsolete alarms; deduplication via `warned.json`.

---

### Item 7: Multi-Machine Merge (`syncDir`)

* **Is the design sound?** Sound, but attribution mechanics are critical.
* **What breaks it:**
  * **Clock skew:** Dropping all future rows fails when another computer's clock is 2 minutes fast.
  * **Partial sync files:** Cloud tools (OneDrive, Syncthing) write files in chunks. Reading a partial file crashes JSON parsing.
  * **Machine identity:** Basing identity on hostname causes duplicates if the computer is renamed. Use a persistent UUID `machineId` stored in `config.json`.
  * **Attribution and calibration poisoning:** In `windows.js`, limit increases during intervals where Code was idle are classified as web chat. If remote Claude Code rows are omitted from `costIn(a, b)` during calibration, the limit increases caused by the other computer look like idle intervals. Quotameter then misclassifies the other computer's Code usage as chat, ruining the calibration factor `k` and attribution.
* **Simplest correct version:**
  * Write `<syncDir>/quotameter-<machineId>.json` via temporary file and atomic rename.
  * Validate JSON on read, skipping incomplete files.
  * Tolerate up to 5 minutes of future clock skew.
  * Deduplicate readings across machines by `(kind, roundMinute(t), roundMinute(resetsAt))`.
  * Include remote rows with their reconciled costs in `costIn` during window walks so `k` remains exact. Attribute them to `bySurface.remote` ("Other computer: <name>") instead of chat. Never write remote rows to local storage.
* **Tests must cover:** Calibration `k` remaining accurate when remote Code activity moves limits; remote rows attributed to `bySurface.remote` rather than chat; handling partial sync files; clock skew tolerance; reading deduplication.

---

### Item 8: Team Digest, Zero Upload

* **Is the design sound?** Sound and preserves privacy.
* **What breaks it:** Combining different metric types (such as adding dollar costs to limit points) in the waste summary line; unsanitized `--label` inputs injecting control characters into ASCII tables; schema version drift across team members.
* **Simplest correct version:** `team export` extracts scalar aggregates from `analyze()` for the past 4 weeks without file paths, git branches, or timestamps. `team report` reads multiple digests, validates schema versions, outputs a clean terminal table, and separates waste categories clearly by unit (rebuilds in dollars, Opus excess in dollars, idle MCP in tokens).
* **Tests must cover:** Exported files containing zero paths, titles, or branches; report formatting across single and multiple files; handling corrupt or older schema versions; strict unit separation in waste summaries.

---

### Item 9: Large-File Guard (`PreToolUse`)

* **Is the design sound?** Sound, but hook contract and latency need care.
* **What breaks it:**
  * **Hook contract:** Claude Code matches tool names. If the matcher is only `Read`, calls to `View` bypass it. Stdin passes JSON containing `tool_name` and `tool_input`. If `tool_input.file_path` is relative, it must be resolved against working directory.
  * **Errors:** An uncaught `ENOENT` from `fs.statSync` on non-existent files or broken symlinks blocks the turn.
  * **Latency:** Importing `analyze.js` or `windows.js` in a PreToolUse hook adds 50 to 100 milliseconds to every file read, noticeably slowing prompts.
  * **Privacy contract:** Updating `PRIVACY.md` must be explicit to avoid violating privacy guarantees.
* **Simplest correct version:**
  * Matcher: `"Read|View"`. Hook command runs a lean handler that imports only `node:fs` and `node:path`.
  * Extract `file_path` from `tool_input`, resolve against cwd, and wrap `fs.statSync` in `try/catch`.
  * If size exceeds `fileGuardKB * 1024`, output:
    `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionReason: "<path> is X MB (~Y tokens)..." } }`
  * Update `PRIVACY.md` to state: "hooks never read your prompt; the file guard inspects only the target file path in memory to check file size, and stores nothing."
* **Tests must cover:** Files below threshold passing without prompt; files above threshold returning `permissionDecision: "ask"`; missing files passing without error; `fileGuard: false` bypassing the check; relative path resolution.

---

### Key Flags Summary

* **Spends Quota:** Item 1 injecting dynamic text into `additionalContext` on every prompt invalidates the prompt cache, consuming cache write tokens.
* **Slows Prompts or Sessions:** Item 2 performing file writes on every status line refresh; Item 3 running synchronous `analyze()` during `SessionStart`; Item 9 importing heavy analysis modules during `PreToolUse`.
* **Shows Wrong Numbers:** Item 2 treating per-refresh deltas as per-turn figures; Item 4 inverting remaining versus used percentages; Item 5 dividing by zero or recommending tasks when minutes remain; Item 7 omitting remote rows from `costIn`, which misattributes remote Code work as chat and poisons `k`.
