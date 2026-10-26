### Verification of Findings in [agy-23-code-review.md](../../docs/reviews/agy-23-code-review.md)

1. **Finding 1 (Division by zero in session cost): Fixed**  
   [`sessionCost`](../../plugins/quotameter/lib/model/insights.js#L124-L154) in [insights.js#L149](../../plugins/quotameter/lib/model/insights.js#L149) guards `quick > 0` (returning `null` if 0) and `heavy > 0` (returning 0 if 0). Safe formatting is handled in [`fitsText`](../../plugins/quotameter/lib/report/format.js#L12-L26) at [format.js#L19-L23](../../plugins/quotameter/lib/report/format.js#L19-L23).

2. **Finding 2 (Status line crash on null input): Fixed**  
   [statusline.js#L58](../../plugins/quotameter/lib/statusline.js#L58) adds `input = input && typeof input === 'object' ? input : {}` inside [`statusText`](../../plugins/quotameter/lib/statusline.js#L57-L74), and [statusline.js#L126-L128](../../plugins/quotameter/lib/statusline.js#L126-L128) inside [`statusline`](../../plugins/quotameter/lib/statusline.js#L118-L147) falls back to an empty object if `JSON.parse` returns null or a non-object.

3. **Finding 3 (File guard triggering on directories): Fixed**  
   [`guardDecision`](../../plugins/quotameter/lib/guard.js#L14-L42) in [guard.js#L26](../../plugins/quotameter/lib/guard.js#L26) checks `!st.isFile()` and exits with `null` before evaluating size.

4. **Finding 4 (Startup delay parsing message logs): Partly**  
   [`startMessages`](../../plugins/quotameter/lib/digest.js#L88-L113) in [digest.js#L101](../../plugins/quotameter/lib/digest.js#L101) reduced two log scans down to one shared `readAll('messages')` call. However, it still parses the entire message log synchronously on startup rather than reading a 64 KB tail or reading a precomputed receipt.

5. **Finding 5 (Receipt triggering on active sessions): Partly**  
   [`receipt`](../../plugins/quotameter/lib/digest.js#L39-L56) in [digest.js#L40](../../plugins/quotameter/lib/digest.js#L40) passes `input.session_id` as `current` and skips sessions active within two minutes via [`running`](../../plugins/quotameter/lib/digest.js#L33-L37) ([digest.js#L33-L37](../../plugins/quotameter/lib/digest.js#L33-L37)). However, it never verifies that `s.end` exists, meaning an active session idle for over two minutes can still trigger a premature receipt.

6. **Finding 6 (Context nudge misattribution across concurrent sessions): Partly**  
   [`contextNudge`](../../plugins/quotameter/lib/warn.js#L75-L85) in [warn.js#L77](../../plugins/quotameter/lib/warn.js#L77) ignores rows older than two minutes and rewords the output to "your most recently active session" ([warn.js#L84](../../plugins/quotameter/lib/warn.js#L84)). However, [`latestTurn`](../../plugins/quotameter/lib/warn.js#L61-L70) in [warn.js#L61-L70](../../plugins/quotameter/lib/warn.js#L61-L70) still inspects shared logs without tracking per-session turn files.

7. **Finding 7 (Dropping files from newer schemas): Fixed**  
   [`importSync`](../../plugins/quotameter/lib/sync.js#L71-L116) in [sync.js#L92](../../plugins/quotameter/lib/sync.js#L92) records unsupported schemas into `out.machines` with an update notice. Diagnostics are displayed in [`renderText`](../../plugins/quotameter/lib/report/render.js#L27-L57) at [render.js#L46](../../plugins/quotameter/lib/report/render.js#L46) and `doctor` in [quotameter.js#L348](../../plugins/quotameter/bin/quotameter.js#L348).

8. **Finding 8 (Self-import before first export): Fixed**  
   [`importSync`](../../plugins/quotameter/lib/sync.js#L71-L116) in [sync.js#L74](../../plugins/quotameter/lib/sync.js#L74) calls [`machineId(cfg)`](../../plugins/quotameter/lib/sync.js#L29-L35) directly to guarantee the machine ID is generated before comparing remote files.

9. **Finding 9 (Weekly digest firing twice): Partly**  
   `roundHour` in [digest.js#L18](../../plugins/quotameter/lib/digest.js#L18) and [digest.js#L61](../../plugins/quotameter/lib/digest.js#L61) eliminates second-level timestamp jitter. However, [`startMessages`](../../plugins/quotameter/lib/digest.js#L88-L113) at [digest.js#L91-L111](../../plugins/quotameter/lib/digest.js#L91-L111) was not wrapped in `withLock`, so concurrent starts can still race on `digest.json` (documented as an accepted trade-off in [docs/DESIGN.md#L177](../../docs/DESIGN.md#L177)).

10. **Finding 10 (Launcher refresh on Read tools): Fixed**  
    [hook.js#L44-L48](../../plugins/quotameter/bin/hook.js#L44-L48) skips [`refreshLauncher`](../../plugins/quotameter/lib/setup.js#L65-L83) when `event` is `'prompt'` or `'pretool'`.

11. **Finding 11 (Limit warnings leaking into assistant context): Fixed**  
    [hook.js#L58-L61](../../plugins/quotameter/bin/hook.js#L58-L61) routes `r.message` strictly to `systemMessage` and sends only `r.advice` to `additionalContext`.

12. **Finding 12 (Test not asserting contract): Fixed**  
    [quotameter.test.js#L619-L631](../../test/quotameter.test.js#L619-L631) invokes [`promptHook`](../../plugins/quotameter/lib/warn.js#L184-L197) and asserts that `r.message` is null when advice triggers below the warning threshold.

13. **Finding 13 (Documentation on resume notice): Fixed**  
    [README.md#L246](../../README.md#L246) clarifies that on resume, a notice is shown only if the prompt cache has likely expired.

14. **Finding 14 (Inaccurate security claims): Fixed**  
    [SECURITY.md#L14](../../SECURITY.md#L14) lists desktop notification utilities and file openers, and [SECURITY.md#L17](../../SECURITY.md#L17) discloses exported usage files written to `syncDir`.

---

### New Problems Introduced by the Fixes

1. **Repeated synchronous disk reads in receipt filter:** In [digest.js#L35](../../plugins/quotameter/lib/digest.js#L35), [`running`](../../plugins/quotameter/lib/digest.js#L33-L37) calls `readAll('live')` on every cost row during `costs.filter(...)` at [digest.js#L40](../../plugins/quotameter/lib/digest.js#L40). On stores with many sessions, this repeatedly opens, reads, and parses `live.jsonl` from disk inside a loop at session startup.
2. **Unpatched hook logic in CLI entry point:** The fixes for findings 10 and 11 were added to [hook.js](../../plugins/quotameter/bin/hook.js), but the duplicate hook logic in [quotameter.js](../../plugins/quotameter/bin/quotameter.js) was missed. [quotameter.js#L146](../../plugins/quotameter/bin/quotameter.js#L146) still runs `refreshLauncher` on every hook event, and [quotameter.js#L154-L157](../../plugins/quotameter/bin/quotameter.js#L154-L157) still joins `r.message` into `additionalContext`.
3. **Missing heavy divisor guard in weekly calculations:** In [insights.js#L152](../../plugins/quotameter/lib/model/insights.js#L152), `res.leftWeek` computes `heavy` without the `heavy > 0` guard added to `res.left` in line 149, leaving it vulnerable to division by zero if `heavy` or `k.wk` evaluates to 0.
