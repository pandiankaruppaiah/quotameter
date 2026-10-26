### Findings

#### High Severity

1. **File and line:** [plugins/quotameter/lib/model/insights.js](../../plugins/quotameter/lib/model/insights.js#L148)
   - **Problem:** Division by zero and `NaN` in session cost calculation. In [`sessionCost`](../../plugins/quotameter/lib/model/insights.js#L124-L153), `res.left` computes `quick: Math.floor(room / (quick * k.h5))` and `heavy: Math.floor(room / (heavy * k.h5))`. While `med > 0` is checked, `quick > 0` and `heavy > 0` are not checked. If 25% of sessions have zero cost, `quick * k.h5` is 0. Dividing by zero yields `Infinity` (or `NaN` if `room` is 0). In [`fitsText`](../../plugins/quotameter/lib/report/format.js#L19), `Infinity > 12` evaluates to true, reporting "room for many quick tasks" when there may be no quota remaining.
   - **Fix:** Guard against zero before dividing:
     ```javascript
     res.left = {
       quick: quick > 0 ? Math.floor(room / (quick * k.h5)) : null,
       typical: Math.floor(room / (med * k.h5)),
       heavy: heavy > 0 ? Math.floor(room / (heavy * k.h5)) : 0,
       room,
     };
     ```

2. **File and line:** [plugins/quotameter/lib/statusline.js](../../plugins/quotameter/lib/statusline.js#L58) and [plugins/quotameter/lib/statusline.js](../../plugins/quotameter/lib/statusline.js#L134)
   - **Problem:** Process crash on null status line input. When Claude Code passes `"null"` or invalid JSON on standard input, `JSON.parse` returns `null`. Line 134 invokes [`statusText(input, k)`](../../plugins/quotameter/lib/statusline.js#L57-L73) outside a `try/catch` block. Line 58 evaluates `input.rate_limits || {}`, which throws an unhandled `TypeError: Cannot read properties of null (reading 'rate_limits')` and terminates the process.
   - **Fix:** Ensure `input` falls back to an empty object if parsing returns null or a non-object:
     ```javascript
     try {
       input = JSON.parse(raw);
       if (!input || typeof input !== 'object') input = {};
     } catch {
       input = {};
     }
     ```
     And add a defensive check inside [`statusText`](../../plugins/quotameter/lib/statusline.js#L57): `input = input || {};`.

3. **File and line:** [plugins/quotameter/lib/guard.js](../../plugins/quotameter/lib/guard.js#L22-L26)
   - **Problem:** File guard triggers on directories and symlinks. [`guardDecision`](../../plugins/quotameter/lib/guard.js#L14-L41) calls `fs.statSync(file).size` without checking `st.isFile()`. If Claude Code calls the `Read` tool on a directory, `fs.statSync` succeeds. On filesystems where large directories report sizes above 512 KB, the guard asks the user to read the directory with offset and limit, which is invalid.
   - **Fix:** Inspect `st.isFile()` before evaluating file size:
     ```javascript
     let st;
     try {
       st = fs.statSync(file);
     } catch {
       return null;
     }
     if (!st.isFile() || st.size <= fileGuardKB * 1024) return null;
     ```

---

#### Medium Severity

4. **File and line:** [plugins/quotameter/lib/digest.js](../../plugins/quotameter/lib/digest.js#L38) and [plugins/quotameter/lib/digest.js](../../plugins/quotameter/lib/digest.js#L58)
   - **Problem:** Synchronous startup delay parsing full message logs. [`startMessages`](../../plugins/quotameter/lib/digest.js#L79-L102) runs synchronously on session start and invokes `readAll('messages')` twice (once in [`receipt`](../../plugins/quotameter/lib/digest.js#L30-L47) and once in [`weeklyDigest`](../../plugins/quotameter/lib/digest.js#L50-L75)). On a 90-day store with tens of megabytes of JSONL records, parsing all rows twice synchronously blocks session startup and exceeds the sub-120 ms target.
   - **Fix:** Avoid scanning the entire store on startup. Read only the last 64 KB tail of `messages.jsonl` to extract the last session's records, or precompute a compact receipt file during background ingest or session exit.

5. **File and line:** [plugins/quotameter/lib/digest.js](../../plugins/quotameter/lib/digest.js#L31-L36)
   - **Problem:** Receipt can trigger for an active or running session. [`receipt`](../../plugins/quotameter/lib/digest.js#L30-L47) picks the newest row from `costs.jsonl` using `costs.reduce(...)`. Claude Code writes `cost-state` records during session execution (such as after subagent runs or at compaction checkpoints). If another session is actively running, or if the current session wrote an intermediate cost, [`receipt`](../../plugins/quotameter/lib/digest.js#L30) can display a receipt for an incomplete session.
   - **Fix:** Accept `input.session_id` into [`startMessages`](../../plugins/quotameter/lib/digest.js#L79) and [`receipt`](../../plugins/quotameter/lib/digest.js#L30), ignore records matching the starting session ID, and verify the session has ended (`s.end` exists and is not present in `live.jsonl`).

6. **File and line:** [plugins/quotameter/lib/warn.js](../../plugins/quotameter/lib/warn.js#L61-L70) and [plugins/quotameter/lib/warn.js](../../plugins/quotameter/lib/warn.js#L73-L82)
   - **Problem:** Context nudge misattribution across concurrent sessions. [`latestTurn`](../../plugins/quotameter/lib/warn.js#L61-L70) inspects `live.jsonl` tails and returns whichever session wrote the most recent timestamp. If Session A has a small context (20K tokens) and Session B has a large context (160K tokens), a prompt submitted in Session A can pick up Session B's row and output a false context nudge in Session A.
   - **Fix:** Read the session identifier from the prompt hook environment or status files, or track per-session turn files so each prompt checks only its own session context.

7. **File and line:** [plugins/quotameter/lib/sync.js](../../plugins/quotameter/lib/sync.js#L88)
   - **Problem:** Silently dropping files from newer schemas poisons calibration. If another computer updates to a newer quotameter version with `schema > SCHEMA`, [`importSync`](../../plugins/quotameter/lib/sync.js#L71-L110) hits `continue` without warning. The local computer then counts the remote Code usage as web chat, poisoning the local calibration factor `k`.
   - **Fix:** Record dropped files with unsupported schemas in `out.machines` (e.g. `{ error: 'unsupported schema' }`) and display a diagnostic in `quotameter doctor` and `status` advising the user to update.

8. **File and line:** [plugins/quotameter/lib/sync.js](../../plugins/quotameter/lib/sync.js#L74)
   - **Problem:** Self-import on fresh machines before first export. [`importSync`](../../plugins/quotameter/lib/sync.js#L71-L110) sets `const own = cfg.machineId || null;`. If a machine has not yet run [`exportSync`](../../plugins/quotameter/lib/sync.js#L41-L68), `cfg.machineId` is undefined. If a sync folder already contains a file previously generated by this machine, `p.machineId === own` evaluates to false, causing the machine to import its own file as a remote machine.
   - **Fix:** Call [`machineId(cfg)`](../../plugins/quotameter/lib/sync.js#L29-L35) inside [`importSync`](../../plugins/quotameter/lib/sync.js#L71) to ensure the current machine ID is loaded or generated:
     ```javascript
     const own = machineId(cfg);
     ```

9. **File and line:** [plugins/quotameter/lib/digest.js](../../plugins/quotameter/lib/digest.js#L52-L56)
   - **Problem:** Weekly digest can fire twice. First, `roundMinute(Date.parse(r.resetsAt))` can yield different keys for the same window if timestamps from different sources (such as status line epoch seconds versus `/usage` ISO strings) jitter across the 30-second mark. Second, [`startMessages`](../../plugins/quotameter/lib/digest.js#L79-L102) runs without `withLock`. If two sessions start simultaneously, both read `digest.json` before either commits `next.lastWeek = w.key`, outputting duplicate weekly digests.
   - **Fix:** Round reset timestamps to the hour for weekly digest deduplication (`Math.round(t / 3600000) * 3600000`), and wrap the `digest.json` update in an atomic lock.

---

#### Low Severity

10. **File and line:** [plugins/quotameter/bin/hook.js](../../plugins/quotameter/bin/hook.js#L44)
    - **Problem:** Unnecessary filesystem operations on every Read tool use. [`refreshLauncher(pluginRoot)`](../../plugins/quotameter/lib/setup.js#L65-L83) runs at top-level on every hook call. For `pretool` (which runs on every file read), this reads `launcher.json` and `statusline.mjs` synchronously, adding latency to regular tool calls.
    - **Fix:** Move `refreshLauncher` inside the `switch` statement for `start` and `stop` events only, bypassing it during `pretool`.

11. **File and line:** [plugins/quotameter/bin/hook.js](../../plugins/quotameter/bin/hook.js#L54-L57)
    - **Problem:** User limit warnings leak into assistant context. When [`warningFor`](../../plugins/quotameter/lib/warn.js#L122-L142) fires at 80% or 95%, `r.message` is joined into `context` alongside `r.advice`. As noted in design review 22, `warningFor` was intended exclusively for `systemMessage` (user notification), while `adviceFor` was intended for `additionalContext` (assistant guidance). Injecting the warning message into `additionalContext` consumes prompt context tokens unnecessarily.
    - **Fix:** Send only `r.advice` to `additionalContext`:
      ```javascript
      if (r.message) out.systemMessage = r.message;
      if (r.advice) out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: r.advice };
      ```

12. **File and line:** [test/quotameter.test.js](../../test/quotameter.test.js#L604-L623)
    - **Problem:** Test does not verify its claimed contract. The test titled `'advice for the assistant: only when tight, once per 5% band, never a user message'` only calls the pure helper function [`adviceFor`](../../plugins/quotameter/lib/warn.js#L148-L162). It does not test [`promptHook`](../../plugins/quotameter/lib/warn.js#L181-L194) or [`hook.js`](../../plugins/quotameter/bin/hook.js) to prove that `systemMessage` remains unset when advice triggers.
    - **Fix:** Update the test to invoke [`promptHook`](../../plugins/quotameter/lib/warn.js#L181) and assert `assert.equal(r.message, null)` when advice triggers below the warning threshold.

13. **File and line:** [README.md](../../README.md#L246)
    - **Problem:** Documentation contradicts implemented behavior. Line 246 states: "nothing is shown after /clear, /compact or a resume." However, `CHANGELOG.md` line 10, `README.md` line 124, and [`digest.js`](../../plugins/quotameter/lib/digest.js#L85-L89) explicitly show a cache rebuild cost notice when resuming after a pause.
    - **Fix:** Update line 246 of `README.md` to state: "nothing is shown after /clear or /compact; on resume, a notice is shown only if the prompt cache likely expired."

14. **File and line:** [SECURITY.md](../../SECURITY.md#L14-L15)
    - **Problem:** Inaccurate security claims. Line 15 claims: "`quotameter setup` is the only thing that writes outside `~/.quotameter`". However, when `syncDir` is enabled, [`exportSync`](../../plugins/quotameter/lib/sync.js#L41-L68) writes sync files outside `~/.quotameter` on every ingest. Additionally, line 14 states quotameter "Starts only the claude command", omitting notification utilities (`powershell.exe`, `osascript`, `notify-send`) and browser launch utilities.
    - **Fix:** Clarify in `SECURITY.md` that configured `syncDir` paths receive exported usage files, and list the desktop notification tools under executed processes.

---

### What Is Fine

- **Calibration and attribution math:** [`windows.js`](../../plugins/quotameter/lib/model/windows.js) cleanly isolates idle increases as chat, nets busy intervals over the full window to prevent rounding bias, and integrates remote machine usage into the cost index so other computers are not misclassified as chat.
- **Percentage calculations and units:** All percentage displays across [`statusline.js`](../../plugins/quotameter/lib/statusline.js), [`guard.js`](../../plugins/quotameter/lib/guard.js), [`warn.js`](../../plugins/quotameter/lib/warn.js), [`digest.js`](../../plugins/quotameter/lib/digest.js), and [`render.js`](../../plugins/quotameter/lib/report/render.js) use the proper calibration factor (`k.h5` for 5-hour windows and `k.wk` for weekly windows) without mixing units.
- **Privacy and security boundaries:** Hooks never read prompt text, no authentication tokens or browser cookies are accessed, and the file guard processes paths in memory without persisting file metadata.
- **Reset alarm implementation:** [`alarm`](../../plugins/quotameter/lib/notify.js#L50-L71) sleeps in short 30-second steps to handle system sleep wakeups, passes parameters as arguments rather than shell strings, and stays silent if waking more than 30 minutes past reset.
- **Launcher resilience:** The status line launcher cleanly validates path ownership and plugin package names before importing, surviving plugin directory updates without breaking settings.
- **Precheck execution:** [`precheck`](../../plugins/quotameter/bin/quotameter.js#L264-L287) uses correct remaining quota math (`100 - r.percent >= min`) and returns documented exit codes (0, 1, and 2).
- **Em dashes:** No em dash characters were found in any of the reviewed files.
