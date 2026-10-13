# agy review 02: code

1. **MUST: Command injection via `openFile` on Windows**
   - **File and line:** [`plugins/quotameter/bin/quotameter.js:45-48`](../../plugins/quotameter/bin/quotameter.js#L45-L48)
   - **Problem:** `openFile` spawns `cmd.exe /c start ""` with unescaped file paths. On Windows, `cmd.exe /c` interprets shell metacharacters such as `&`, `|`, and `^`.
   - **Concrete failure scenario:** A user runs `quotameter report --out "report.html&calc.exe"`, or runs the tool from a directory path containing an ampersand (e.g. `~ & Bob\.quotameter\report.html`). The command executed by `cmd.exe` splits on `&` and executes `calc.exe`.
   - **Fix:** On Windows, avoid `cmd.exe /c start`. Spawn `explorer.exe` directly or validate that the path contains no shell metacharacters before handing it to the shell.

2. **MUST: Malformed hook configuration in `hooks.json` disables all automatic hooks**
   - **File and line:** [`plugins/quotameter/hooks/hooks.json:3-11`](../../plugins/quotameter/hooks/hooks.json#L3-L11)
   - **Problem:** Each hook event array nests the hook definition inside an extra `"hooks"` property:
     `"SessionStart": [ { "hooks": [ { "type": "command", ... } ] } ]`.
     Claude Code expects an array of action objects directly (`"SessionStart": [ { "type": "command", ... } ]`).
   - **Concrete failure scenario:** Claude Code loads the plugin's `hooks.json`. The hook loader expects objects with a `type` property in the array. Because `type` is buried inside an unexpected nested `hooks` array, the hook registration fails or is ignored. As a result, `SessionStart`, `Stop`, and `SessionEnd` hooks never run, breaking automatic ingest and reactive polling.
   - **Fix:** Remove the extraneous inner `hooks` wrapper object for each event:
     ```json
     {
       "hooks": {
         "SessionStart": [
           { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/quotameter.js\" hook start", "timeout": 10 }
         ],
         "Stop": [
           { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/quotameter.js\" hook stop", "timeout": 10 }
         ],
         "SessionEnd": [
           { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/quotameter.js\" hook end", "timeout": 10 }
         ]
       }
     }
     ```

3. **MUST: Synchronous stdin read blocks until timeout in hook execution and hangs statusline**
   - **File and line:** [`plugins/quotameter/bin/quotameter.js:60`](../../plugins/quotameter/bin/quotameter.js#L60) and [`plugins/quotameter/lib/statusline.js:56`](../../plugins/quotameter/lib/statusline.js#L56)
   - **Problem:** `fs.readFileSync(0, 'utf8')` synchronously blocks until EOF (pipe closure). In `bin/quotameter.js:58-61`, the code explicitly states `"we only need to know it fired"`, yet still performs a blocking read on file descriptor 0. If Claude Code keeps the stdin pipe open while waiting for the command process to complete, this blocks indefinitely until Claude Code terminates the hook. In `statusline.js:56`, running the command interactively without piped input blocks the terminal forever.
   - **Concrete failure scenario:** Claude Code triggers the `SessionStart` hook with stdin connected to a live pipe. `fs.readFileSync(0)` blocks for the full 10-second timeout. Claude Code kills the process on timeout, preventing `detached('ingest')` from executing and delaying Claude Code's startup by 10 seconds.
   - **Fix:** In `bin/quotameter.js`, remove `fs.readFileSync(0, 'utf8')` completely. In `statusline.js`, check `process.stdin.isTTY` and read asynchronously with a short timeout.

4. **MUST: Windows Store (MSIX) Claude Desktop detection broken by outdated regex**
   - **File and line:** [`plugins/quotameter/lib/paths.js:35`](../../plugins/quotameter/lib/paths.js#L35)
   - **Problem:** `desktopDataDirs()` uses `/^Claude_/i.test(name)` to scan Windows Store package folders in `%LOCALAPPDATA%\Packages`. Standard Windows Store installations of Claude Desktop use package names prefixed with the publisher identifier (e.g. `AnthropicPBC.Claude_...`).
   - **Concrete failure scenario:** On Windows 11 with Claude Desktop installed via Microsoft Store, the folder name is `AnthropicPBC.Claude_8h5...`. `/^Claude_/i.test(...)` evaluates to `false`. Quotameter completely fails to find Claude Desktop data, skipping `plan-usage-history.json` and web storage activity.
   - **Fix:** Broaden the regex to match publisher prefixes:
     ```javascript
     if (/(^|\.)Claude/i.test(name)) dirs.push(path.join(pkgs, name, 'LocalCache', 'Roaming', 'Claude'));
     ```

5. **MUST: Concurrent polling outside store lock leads to duplicate CLI executions and readings**
   - **File and line:** [`plugins/quotameter/lib/ingest/index.js:25-39`](../../plugins/quotameter/lib/ingest/index.js#L25-L39)
   - **Problem:** `ingest()` checks staleness and executes `await pollUsage()` outside `withLock`. Running `claude -p /usage` takes multiple seconds. When two hooks fire concurrently, both see `stale === true`, both launch `claude -p /usage` simultaneously in `~/.quotameter/poll`, and both append the resulting readings into `readings.jsonl`.
   - **Concrete failure scenario:** Two Claude Code sessions start concurrently after the 10-minute poll interval has lapsed. Both processes run `pollUsage()` in parallel in `~/.quotameter/poll`. The first process finishes, acquires `withLock`, and appends readings. The second process finishes, acquires `withLock`, and appends identical duplicate readings for the same timestamp.
   - **Fix:** Use a file-based lock or state flag before spawning `pollUsage()`, or check staleness under the lock and write an immediate lease timestamp to prevent overlapping polls.

6. **MUST: Stale lock recovery in `store.js` allows concurrent lock destruction and race conditions**
   - **File and line:** [`plugins/quotameter/lib/store.js:99-102`](../../plugins/quotameter/lib/store.js#L99-L102)
   - **Problem:** When `isStale(lock)` returns `true`, `withLock()` executes `fs.rmSync(lock, { recursive: true, force: true })` without checking lock ownership or verifying if another process has just acquired the lock.
   - **Concrete failure scenario:** Process A's lock expires or process A exits. Process B detects the lock is stale, calls `rmSync`, creates a new lock directory, and writes its token. Process C, which checked `isStale` at the same time, also calls `rmSync`, deleting Process B's new lock, and creates its own lock. Both Process B and Process C proceed into their critical sections concurrently, causing write collisions on JSONL files.
   - **Fix:** Check the owner token before deleting a stale lock, or use atomic file creation/renaming with `fs.openSync` using `O_CREAT | O_EXCL`.

7. **MUST: Chat tokens and token forecasts collapse to zero when current window has no Claude Code messages**
   - **File and line:** [`plugins/quotameter/lib/model/analyze.js:381-390`](../../plugins/quotameter/lib/model/analyze.js#L381-L390)
   - **Problem:** `tokensPerDollar` is computed exclusively from `inWin` (messages in the current window):
     `tokensPerDollar = sum(inWin, (m) => m.adj) > 0 ? sum(inWin, tokensOf) / sum(inWin, (m) => m.adj) : 0;`
     `chatTokens = attr && cal.k ? Math.round((attr.chat / cal.k) * tokensPerDollar) : 0;`
     If the user used claude.ai or mobile chat during the current window without sending messages in Claude Code, `inWin` is empty. `tokensPerDollar` becomes `0`, which forces `chatTokens` to `0`. Consequently, `totalTokens` becomes `0`, and both `fc.tokensLeft` and `fc.tokensPerPoint` evaluate to `0`.
   - **Concrete failure scenario:** A user consumes 40% of their 5-hour quota in claude.ai on their phone, then opens Claude Code and runs `quotameter report`. `inWin` is empty. The report shows chat tokens as 0, tokens per point as 0, and estimated tokens left as 0, falsely claiming no tokens remain despite 60% of the limit being unused.
   - **Fix:** Fall back to 30-day historical `tokensPerDollar` (`tpd30` from line 423) when `inWin` contains no messages:
     ```javascript
     const tokensPerDollar = sum(inWin, (m) => m.adj) > 0
       ? sum(inWin, tokensOf) / sum(inWin, (m) => m.adj)
       : (sum(msgs30, (m) => m.adj) > 0 ? sum(msgs30, tokensOf) / sum(msgs30, (m) => m.adj) : 0);
     ```

8. **MUST: Model name parsing groups all Claude 3.x models under "3" in Value and Session views**
   - **File and line:** [`plugins/quotameter/lib/model/analyze.js:524-525`](../../plugins/quotameter/lib/model/analyze.js#L524-L525) and [`plugins/quotameter/lib/model/analyze.js:356-358`](../../plugins/quotameter/lib/model/analyze.js#L356-L358)
   - **Problem:** In `value()`, family names are parsed using `(m.model || 'unknown').replace(/^claude-/, '').split('-')[0]`. For production models such as `claude-3-5-sonnet`, `claude-3-7-sonnet`, or `claude-3-opus`, `split('-')[0]` is `'3'`. This produces a family key of `'3'` instead of `'Sonnet'` or `'Opus'`. In `prettyModel()`, `x.slice(1).join('.')` turns `claude-3-5-sonnet` into `'3 5.sonnet'`.
   - **Concrete failure scenario:** A user with logs from `claude-3-5-sonnet` or `claude-3-7-sonnet` views the "Value of your plan" section. All Claude 3.x models are merged into a single row labeled `3` (`3: $45.20`). In session breakdown tables, the model column displays `3 5.sonnet`.
   - **Fix:** Extract the model family by matching keywords rather than splitting on the first hyphen:
     ```javascript
     const match = (m.model || '').match(/opus|sonnet|haiku|fable|mythos/i);
     const f = match ? match[0].toLowerCase() : (m.model || 'unknown').replace(/^claude-/, '').split('-')[0];
     ```

9. **SHOULD: Linear regression slope pace collapses to zero during coding pauses**
   - **File and line:** [`plugins/quotameter/lib/model/analyze.js:197-203`](../../plugins/quotameter/lib/model/analyze.js#L197-L203)
   - **Problem:** `recent = Math.max(0, slope(recentPts))` returns `0` if readings over the last 15 to 60 minutes did not change. Because JavaScript's nullish coalescing operator `??` evaluates `0 ?? average` to `0`, `pace` becomes `0`. This overrides the window `average` pace entirely.
   - **Concrete failure scenario:** A user reaches 80% usage in 2 hours, then pauses for 15 minutes to review code. `slope(recentPts)` returns `0`. `pace` collapses to `0`, `toLimit` becomes `null`, and `hitsBeforeReset` switches to `false`. The report displays a green "Won't hit before reset" and "On track" indicator despite the user being on track to breach the limit.
   - **Fix:** Fall back to `average` when `recent === 0` and `average > 0`, or compute an exponential moving average as specified in DESIGN.md:
     ```javascript
     const pace = (recent != null && recent > 0) ? recent : average;
     ```

10. **SHOULD: `QUOTAMETER_CLAUDE_BIN` on Windows fails when pointing to `.cmd` or `.bat` files**
    - **File and line:** [`plugins/quotameter/lib/ingest/usage-poll.js:17-21`](../../plugins/quotameter/lib/ingest/usage-poll.js#L17-L21) and [`plugins/quotameter/lib/ingest/usage-poll.js:28, 112`](../../plugins/quotameter/lib/ingest/usage-poll.js#L28)
    - **Problem:** When `QUOTAMETER_CLAUDE_BIN` is set, `findClaude()` returns `{ cmd: ..., shell: false }` without setting `windowsCmdFallback: true`. In Node on Windows, spawning a `.cmd` or `.bat` file (such as `claude.cmd` from global npm) directly without a shell throws `ENOENT` or `EINVAL`. Because `windowsCmdFallback` is undefined, `runLocalCommand` does not retry with `cmd.exe`. In addition, line 28 does not quote `${cmd}`, so paths containing spaces break in `cmd.exe`.
    - **Concrete failure scenario:** A Windows user sets `QUOTAMETER_CLAUDE_BIN` to `~\AppData\Roaming\npm\claude.cmd` or `C:\Program Files\nodejs\claude.cmd`. Running `quotameter poll` fails immediately with `could not run claude: spawn ... ENOENT` or `'C:\Program' is not recognized`.
    - **Fix:** Keep `windowsCmdFallback: process.platform === 'win32'` enabled when `QUOTAMETER_CLAUDE_BIN` is set, and wrap `${cmd}` in quotes when building the `cmd.exe` command string.

11. **SHOULD: Incomplete UTF-8 chunk boundary corrupts stream offset in incremental log scanner**
    - **File and line:** [`plugins/quotameter/lib/ingest/logs.js:133-146, 204`](../../plugins/quotameter/lib/ingest/logs.js#L133-L146)
    - **Problem:** `linesFrom` reads log files in 8MB chunks and immediately decodes them with `buf.toString('utf8')`. If a multi-byte UTF-8 character is sliced across the 8MB boundary, `buf.toString('utf8')` replaces the truncated byte sequence with `\uFFFD`. When `Buffer.byteLength(carry, 'utf8')` is evaluated on line 146, its byte count differs from the true byte offset on disk, corrupting `out.offset`.
    - **Concrete failure scenario:** A session log contains a large tool output or non-ASCII characters that cross an 8MB chunk boundary. `out.offset` is recorded at an offset shifted by replacement bytes. On the next incremental scan, reading resumes mid-character, causing all subsequent lines to throw `SyntaxError` on `JSON.parse`.
    - **Fix:** Use Node's built-in `string_decoder.StringDecoder('utf8')`, which preserves incomplete trailing bytes across chunk boundaries.

12. **SHOULD: Reconciliation drops sessions that have zero assistant messages**
    - **File and line:** [`plugins/quotameter/lib/model/analyze.js:77-83`](../../plugins/quotameter/lib/model/analyze.js#L77-L83)
    - **Problem:** `reconcile()` only iterates over the `messages` array (`for (const m of messages)`). If a session incurred cost recorded in `cost-state` (e.g. background session title generation or turns that failed before assistant messages were saved), but has zero assistant messages in `messages`, it is never processed in the loop.
    - **Concrete failure scenario:** A session ran background classifier tasks or title generation costing $0.20 in `cost-state`, but contains no assistant message records. `reconcile` ignores the session, permanently omitting the $0.20 from `unitemisedCost` and plan value.
    - **Fix:** After looping through `messages`, check `trueCost` for sessions not present in `logged` and add their costs to `unitemised`.

13. **SHOULD: `cleanupPollLogs` slug mismatch fails to delete poll logs**
    - **File and line:** [`plugins/quotameter/lib/ingest/usage-poll.js:138-140`](../../plugins/quotameter/lib/ingest/usage-poll.js#L138-L140)
    - **Problem:** `cleanupPollLogs` constructs the project directory name as `pollDir().replace(/[:\\/._]/g, '-')`. Claude Code uses its own path encoding convention for folders under `~/.claude/projects/`, which does not match this regex (especially for Windows drive paths containing backslashes and colons).
    - **Concrete failure scenario:** On Windows, `pollDir().replace(...)` produces `C--Users-Name--quotameter-poll`. Claude Code stores the logs in a directory with different separator encoding. `fs.readdirSync(dir)` throws `ENOENT` (caught silently), and temporary poll session files accumulate indefinitely.
    - **Fix:** Locate poll session logs by reading project directory entries whose metadata or logs match `pollDir()`, or clean up poll files directly in `pollDir()` if stored locally.

14. **SHOULD: Missing Content Security Policy in generated HTML report**
    - **File and line:** [`plugins/quotameter/lib/report/template.html:1-7`](../../plugins/quotameter/lib/report/template.html#L1-L7)
    - **Problem:** `report.html` is opened as a local `file://` document in the user's browser, but does not define a Content Security Policy header or meta tag.
    - **Concrete failure scenario:** If any untrusted project title, git branch, or findings string were to bypass sanitization or inject markup into the report, the absence of a CSP allows unrestricted JavaScript execution and outbound network requests from the local file origin.
    - **Fix:** Add a strict CSP meta tag in `<head>`:
     ```html
     <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
     ```

15. **SHOULD: First reading in a window incorrectly attributes all prior usage to chat**
    - **File and line:** [`plugins/quotameter/lib/model/analyze.js:133-140`](../../plugins/quotameter/lib/model/analyze.js#L133-L140)
    - **Problem:** `walkWindow()` starts with `prev = { t: w.start, p: 0 }`. If quotameter records its first reading partway through a 5-hour window, the initial step spans from `w.start` to `firstReading.t`. If no Claude Code messages were scanned in that prior interval, `costIn` is 0, so the entire percentage is flagged as idle and assigned to chat.
    - **Concrete failure scenario:** A user starts Claude Code 2 hours into a 5-hour window where 30% of quota was already consumed. The first reading is 30%. Because `prev.p` starts at 0 at `w.start` and there were no Claude Code messages between 0h and 2h in the store, `walkWindow` counts all 30 points as idle increase and attributes 100% of it to claude.ai chat.
    - **Fix:** If the earliest reading in a window is significantly later than `w.start`, start `prev` at the first reading rather than assuming 0% at `w.start`, or mark pre-existing usage as unattributed.

16. **NICE: Statusline rate limiting drops live session costs**
    - **File and line:** [`plugins/quotameter/lib/statusline.js:28-31`](../../plugins/quotameter/lib/statusline.js#L28-L31)
    - **Problem:** `record()` checks `Date.now() - fs.statSync(storePath(FILES.live)).mtimeMs < 60000` and exits early before appending. This rate-limits both rate limit readings and session costs.
    - **Concrete failure scenario:** A session updates its cost 20 seconds after a statusline refresh. The updated cost row is dropped. If the session ends before another statusline refresh, the live cost estimate is never recorded in `live.jsonl`.
    - **Fix:** Separate the rate limiting: throttle limit percentage rows to once per minute, but append session cost updates when the cost value changes.

17. **NICE: PRIVACY.md statement that it "never reads" message text is factually incorrect**
    - **File and line:** [`PRIVACY.md:14`](../../PRIVACY.md#L14)
    - **Problem:** PRIVACY.md states: `"What it never reads or stores: Message text, thinking, tool inputs or tool results"`. In [`logs.js:174`](../../plugins/quotameter/lib/ingest/logs.js#L174), the scanner reads the raw lines from disk and executes `JSON.parse()`, loading the entire message content and tool inputs into memory before discarding them.
    - **Concrete failure scenario:** In a corporate compliance review, stating the tool "never reads" message text is flagged as an inaccurate claim because message contents are read into process memory during log parsing.
    - **Fix:** Rephrase accurately: "What it never stores or transmits: Message text, thinking, tool inputs or tool results. Log files are read locally into memory solely to extract token counts and tool names; all message text is discarded immediately."

18. **NICE: README and Value section overclaim subscription multiple as true monetary value**
    - **File and line:** [`README.md:35`](../../README.md#L35) and [`plugins/quotameter/lib/model/analyze.js:533`](../../plugins/quotameter/lib/model/analyze.js#L533)
    - **Problem:** README advertises `"Plan value: Your last 30 days at API list prices, next to what you pay"`, and the report displays `"15.3x the subscription price"`. As DESIGN.md acknowledges, API list prices are only a usage weight proxy, not a financial valuation, because Pro and Max quotas are bounded by compute availability and rate limits rather than token billing.
    - **Concrete failure scenario:** Users assume their Pro plan provided $3,000 worth of API tokens, when the vast majority were discounted cache reads that do not represent equivalent API purchasing power.
    - **Fix:** Add a note in README and the report clarifying that the figure represents equivalent list-price weight rather than cash value.

