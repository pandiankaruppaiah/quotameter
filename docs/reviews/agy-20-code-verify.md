### Verification of Review Findings

1. **Unhandled EPIPE on wrapped status line process crashes launcher**: **Fixed**
   - File and line: [`statusline.js`](../../plugins/quotameter/lib/statusline.js#L76) line 76
   - `child.stdin.on('error', () => {})` catches stream errors before `child.stdin.end(raw)` writes to child processes that exit without reading input.

2. **Persistent poll failure causes detached background poll loop on every prompt**: **Fixed**
   - File and line: [`warn.js`](../../plugins/quotameter/lib/warn.js#L62-L76) lines 62-76, line 123; [`index.js`](../../plugins/quotameter/lib/ingest/index.js#L29-L34) lines 29-34
   - `notePollAttempt()` touches `poll-attempt.stamp` before polling. `pollIsDue()` checks `Math.max(newestTs, lastPollAttempt())`, forcing failed polls to back off for `pollIntervalMin`.

3. **`warnAt` threshold override still warns at 95%**: **Fixed**
   - File and line: [`warn.js`](../../plugins/quotameter/lib/warn.js#L84) line 84
   - Threshold levels are filtered with `l >= warnAt && l <= 100`, dropping 95 whenever `warnAt` is set higher.

4. **Launcher falls back to arbitrary popped root when profile config directory does not match**: **Fixed**
   - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L30) line 30, line 36, and lines 72-75
   - Paths are normalized using `path.resolve()`. Arbitrary `Object.values(roots).pop()` was removed across multiple profiles, falling back only when exactly one root exists.

5. **`wrapCommand` is global and conflicts across multiple `CLAUDE_CONFIG_DIR` profiles**: **Fixed**
   - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L110-L116) lines 110-116, lines 155-159; [`statusline.js`](../../plugins/quotameter/lib/statusline.js#L82-L84) lines 82-84
   - `wrapCommands` stores commands keyed by resolved profile path in `config.json`.

6. **Missing timeout on wrapped status line execution**: **Fixed**
   - File and line: [`statusline.js`](../../plugins/quotameter/lib/statusline.js#L58) line 58 and lines 69-72
   - `runWrapped()` adds a 3000 ms timer calling `child.kill()` and resolves early with trimmed output.

7. **Inconsistent token definitions in breakdown tiles and tables**: **Fixed**
   - File and line: [`breakdown.js`](../../plugins/quotameter/lib/model/breakdown.js#L87-L88) lines 87-88, lines 123-138; [`analyze.js`](../../plugins/quotameter/lib/model/analyze.js#L76-L80) lines 76-80; [`report.js`](../../plugins/quotameter/lib/report/report.js#L313) line 313, line 328
   - Standardized on fresh tokens (`freshOf`). Tiles and project tables display fresh tokens, while cache reads are isolated in separate properties (`cacheReadTokens`, `allTokens`). `tokensExact` was renamed to `tokensFresh`.

8. **Launcher trust check checks package name without path validation**: **Fixed**
   - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L40-L46) lines 40-46
   - `trusted(r)` verifies that `r` is absolute and checks file ownership via `fs.statSync(r).uid === process.getuid()` on non-Windows platforms.

9. **Setup crashes with SyntaxError on empty `settings.json`**: **Fixed**
   - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L95) line 95
   - `readSettings()` parses `text.trim() ? JSON.parse(text) : {}`, treating an empty file as `{}`.

10. **`setup` writes `settings.json` non-atomically**: **Fixed**
    - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L151-L153) lines 151-153
    - Writes to a process temporary file `${file}.${process.pid}.tmp` and renames into place with `fs.renameSync()`.

11. **Subsequent `setup` runs overwrite backup with modified settings**: **Fixed**
    - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L141) line 141 and line 146
    - `plan.backup` is set only when `text != null && !ours`. Subsequent runs identify quotameter commands and skip copying over the backup.

12. **Documentation in setup skill contradicts code on backup frequency**: **Fixed**
    - File and line: [`SKILL.md`](../../plugins/quotameter/skills/setup/SKILL.md#L16) line 16; [`DESIGN.md`](../../docs/DESIGN.md#L165) line 165
    - `SKILL.md` was corrected to describe the backup as a copy of settings before quotameter touches the status line, aligning with the fix for finding 11.

13. **`mark code-only` test does not test calibration**: **Fixed**
    - File and line: [`quotameter.test.js`](../../test/quotameter.test.js#L533-L536) lines 533-536
    - Added an `analyze()` assertion verifying `marked.calibration.h5.marked === 1` and `cleanWindows >= 1`.

14. **Launcher trust test tests non-existent folder instead of untrusted package**: **Fixed**
    - File and line: [`quotameter.test.js`](../../test/quotameter.test.js#L478-L485) lines 478-485
    - Writes a real directory containing `package.json` with name `other-plugin` and asserts the launcher outputs `quotameter: plugin not found`.

---

### New Problems Introduced by the Fixes

1. **Unresolved profile path lookup in `wrappedCommand()`**:
   - File and line: [`statusline.js`](../../plugins/quotameter/lib/statusline.js#L83) line 83
   - [`setup.js`](../../plugins/quotameter/lib/setup.js#L58) line 58 and line 110 stores wrapped commands under `path.resolve(claudeConfigDir())`. In `statusline.js`, `wrappedCommand()` indexes `cfg.wrapCommands?.[claudeConfigDir()]` without calling `path.resolve()`. If `CLAUDE_CONFIG_DIR` is relative or uses different slash separators, the lookup misses and wrapped commands fail to run.

2. **Temp file leak and missing retry on Windows rename errors in `setup`**:
   - File and line: [`setup.js`](../../plugins/quotameter/lib/setup.js#L151-L153) lines 151-153
   - Unlike `replaceAtomic()` in [`store.js`](../../plugins/quotameter/lib/store.js#L83-L105) lines 83-105, `setup()` calls `fs.renameSync()` directly without catching errors to remove the `.tmp` file or retrying on Windows `EBUSY`/`EPERM` lock conflicts.

3. **Orphaned child processes when wrapped status line command times out**:
   - File and line: [`statusline.js`](../../plugins/quotameter/lib/statusline.js#L69-L72) lines 69-72
   - `child.kill()` kills the spawned shell process, but does not terminate the underlying subprocesses spawned by the shell on Windows or Unix. Stalled commands remain running in the background.
