### Findings

#### High Severity

1. **Unhandled EPIPE on wrapped status line process crashes statusline launcher**
   - **File and line**: [`plugins/quotameter/lib/statusline.js#L56-L65`](../../plugins/quotameter/lib/statusline.js#L56-L65) in [`runWrapped`](../../plugins/quotameter/lib/statusline.js#L56)
   - **Problem**: When a user has an existing status line command, [`runWrapped`](../../plugins/quotameter/lib/statusline.js#L56) pipes the raw status JSON to child stdin via `child.stdin.end(raw)`. Many commands (such as shell scripts or `git branch` lookups) do not read stdin and exit immediately. Writing to closed child stdin emits an unhandled `EPIPE` event on `child.stdin`. Because only `child.on('error', ...)` is handled, the unhandled stream error crashes the Node process with an uncaught exception, breaking the status line completely.
   - **Fix**: Add an error listener directly to the stdin stream before writing: `child.stdin.on('error', () => {}); child.stdin.end(raw);`.

2. **Persistent poll failure causes detached background poll loop on every prompt**
   - **File and line**: [`plugins/quotameter/lib/warn.js#L44-L56`](../../plugins/quotameter/lib/warn.js#L44-L56) in [`latestReadings`](../../plugins/quotameter/lib/warn.js#L44) and line 102 in [`promptHook`](../../plugins/quotameter/lib/warn.js#L100)
   - **Problem**: If `claude -p /usage` fails or produces no limits (for example, on API key accounts, when `claude` is missing from `PATH`, or when offline), no reading records are appended to the store files. As a result, `latest.newestTs` stays `0`. On every single subsequent prompt, `now - latest.newestTs > pollIntervalMin * 60000` evaluates to true, causing the prompt hook in [`bin/quotameter.js#L122`](../../plugins/quotameter/bin/quotameter.js#L122) to spawn a detached ingest process on every prompt submission.
   - **Fix**: Record the timestamp of the last poll attempt in a stamp file (or in `state.json`), and check that timestamp in [`promptHook`](../../plugins/quotameter/lib/warn.js#L100) so failed polls back off for `pollIntervalMin`.

---

#### Medium Severity

3. **`warnAt` threshold override still warns at 95%**
   - **File and line**: [`plugins/quotameter/lib/warn.js#L63`](../../plugins/quotameter/lib/warn.js#L63) in [`warningFor`](../../plugins/quotameter/lib/warn.js#L61)
   - **Problem**: The hook hardcodes `levels` as `[...new Set([warnAt, 95])].filter((l) => l > 0 && l <= 100).sort((a, b) => a - b)`. If a user configures `warnAt: 98` because they only want an alert right before hitting 100%, `levels` contains `[95, 98]`. The hook triggers at 95%, contradicting the user's explicit preference.
   - **Fix**: Filter escalation levels so thresholds lower than the configured threshold are excluded: `const levels = [...new Set([warnAt, 95])].filter((l) => l >= warnAt && l <= 100).sort((a, b) => a - b);`.

4. **Launcher falls back to arbitrary popped root when profile config directory does not match**
   - **File and line**: [`plugins/quotameter/lib/setup.js#L33-L35`](../../plugins/quotameter/lib/setup.js#L33-L35) in `LAUNCHER_SRC`
   - **Problem**: In `statusline.mjs`, the launcher looks up roots using `root = roots[cfgDir] || Object.values(roots).pop() || null`. On Windows, `cfgDir` can have minor formatting discrepancies (such as backslashes versus forward slashes or lowercase drive letters) compared to the key written during setup. When a key lookup misses, falling back to `Object.values(roots).pop()` executes whatever plugin root happened to be registered last, potentially mixing separate profiles or unverified directories.
   - **Fix**: Normalize directory paths using `path.resolve(cfgDir)` both when writing and reading `launcher.json`, and do not fall back to `Object.values(roots).pop()`.

5. **`wrapCommand` is global and conflicts across multiple `CLAUDE_CONFIG_DIR` profiles**
   - **File and line**: [`plugins/quotameter/lib/setup.js#L98`](../../plugins/quotameter/lib/setup.js#L98) and line 138 in [`setup`](../../plugins/quotameter/lib/setup.js#L95)
   - **Problem**: While `launcher.json` keys plugin roots by Claude Code config directory to prevent profiles from fighting, `wrapCommand` is saved as a single global value in `~/.quotameter/config.json`. If a user runs two profiles with distinct status line commands, setting up the second profile overwrites the wrapped command for the first.
   - **Fix**: Store wrapped commands in `config.json` keyed by profile path, for example `cfg.wrapCommands[claudeConfigDir()] = wrapCommand`.

6. **Missing timeout on wrapped status line execution**
   - **File and line**: [`plugins/quotameter/lib/statusline.js#L56-L65`](../../plugins/quotameter/lib/statusline.js#L56-L65) in [`runWrapped`](../../plugins/quotameter/lib/statusline.js#L56)
   - **Problem**: [`runWrapped`](../../plugins/quotameter/lib/statusline.js#L56) spawns the user's previous status line command via shell without a timeout. If that external script hangs, waits for network, or prompts for input, the status line blocks indefinitely until killed.
   - **Fix**: Add a timeout (such as 3000 ms) using `setTimeout` to kill the child process and resolve with an empty string.

7. **Inconsistent token definitions in breakdown tiles and tables**
   - **File and line**: [`plugins/quotameter/lib/model/breakdown.js#L87-L88`](../../plugins/quotameter/lib/model/breakdown.js#L87-L88) and line 130 in [`breakdown`](../../plugins/quotameter/lib/model/breakdown.js#L30)
   - **Problem**: In [`breakdown.js`](../../plugins/quotameter/lib/model/breakdown.js#L130), `tiles.tokens = exactTokens + (chatTokens || 0)`. Here `exactTokens` includes cache reads ([`tokensOf`](../../plugins/quotameter/lib/model/util.js#L8)), while `chatTokens` is calculated purely from fresh tokens per dollar. Similarly, in the projects table, Code projects show `g.tokens` (inclusive of cache reads), while the Chat row displays fresh tokens. Furthermore, in [`analyze.js#L76`](../../plugins/quotameter/lib/model/analyze.js#L76), `fc.tokensExact` refers strictly to fresh tokens, creating conflicting definitions of `tokensExact`.
   - **Fix**: Standardize token accounting across [`breakdown.js`](../../plugins/quotameter/lib/model/breakdown.js): use fresh tokens for `g.tokens` when comparing against chat, or display fresh tokens and cache reads in separate columns.

8. **Launcher trust check checks package name without path validation**
   - **File and line**: [`plugins/quotameter/lib/setup.js#L36-L38`](../../plugins/quotameter/lib/setup.js#L36-L38) in `LAUNCHER_SRC`
   - **Problem**: `trusted(r)` only checks whether `package.json` in folder `r` parses to `{ "name": "quotameter-plugin" }`. If an unauthorized process modifies `launcher.json`, it can point to an attacker-controlled directory containing a trivial `package.json` with that name to execute arbitrary code via dynamic import.
   - **Fix**: Ensure `root` is an absolute path, verify that the directory is owned by the current user, or restrict trusted paths to known Claude plugin cache and development directories.

---

#### Low Severity

9. **Setup crashes with SyntaxError on empty `settings.json`**
   - **File and line**: [`plugins/quotameter/lib/setup.js#L84-L88`](../../plugins/quotameter/lib/setup.js#L84-L88) in [`readSettings`](../../plugins/quotameter/lib/setup.js#L77)
   - **Problem**: If `~/.claude/settings.json` exists but is zero bytes (e.g., after an interrupted write), `JSON.parse("")` throws a `SyntaxError`, causing [`setup`](../../plugins/quotameter/lib/setup.js#L95) to abort with a fatal error rather than initializing default settings.
   - **Fix**: Treat an empty string as `{}`: `text.trim() ? JSON.parse(text) : {}`.

10. **`setup` writes `settings.json` non-atomically**
    - **File and line**: [`plugins/quotameter/lib/setup.js#L136`](../../plugins/quotameter/lib/setup.js#L136) in [`setup`](../../plugins/quotameter/lib/setup.js#L95)
    - **Problem**: `fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')` writes directly to `settings.json` without using a temporary file and rename. An interruption during write can truncate the user's primary configuration file.
    - **Fix**: Use atomic replacement: write to a temporary file and rename it into place.

11. **Subsequent `setup` runs overwrite backup with modified settings**
    - **File and line**: [`plugins/quotameter/lib/setup.js#L132`](../../plugins/quotameter/lib/setup.js#L132) in [`setup`](../../plugins/quotameter/lib/setup.js#L95)
    - **Problem**: When [`setup`](../../plugins/quotameter/lib/setup.js#L95) is re-run (for instance, to update an existing launcher command), `fs.copyFileSync(file, plan.backup)` copies `settings.json` after it already contains quotameter's command. If a user manually restores `settings.json.quotameter.bak`, it will no longer contain their original pre-quotameter configuration.
    - **Fix**: Only copy to `plan.backup` if the backup file does not already exist, or save pre-quotameter settings under a distinct name.

12. **Documentation in setup skill contradicts code on backup frequency**
    - **File and line**: [`plugins/quotameter/skills/setup/SKILL.md#L16`](../../plugins/quotameter/skills/setup/SKILL.md#L16)
    - **Problem**: The skill document states "the backup that will be written once". The implementation in [`setup.js#L132`](../../plugins/quotameter/lib/setup.js#L132) and the design doc both confirm that the backup is copied on every modification.
    - **Fix**: Update [`plugins/quotameter/skills/setup/SKILL.md#L16`](../../plugins/quotameter/skills/setup/SKILL.md#L16) to state: "the backup that is updated before each change".

13. **`mark code-only` test does not test calibration**
    - **File and line**: [`test/quotameter.test.js#L520-L536`](../../test/quotameter.test.js#L520-L536)
    - **Problem**: The test is named `'mark code-only: the current window is trusted by calibration'`, but it only invokes CLI options and verifies that array items are added or removed in `config.json`. It never runs [`calibrate`](../../plugins/quotameter/lib/model/windows.js#L64) or [`analyze`](../../plugins/quotameter/lib/model/analyze.js#L40) to verify that calibration respects the mark.
    - **Fix**: Add an analysis step asserting that the marked window is included in `cal.cleanWindows` and `cal.marked`.

14. **Launcher trust test tests non-existent folder instead of untrusted package**
    - **File and line**: [`test/quotameter.test.js#L470-L473`](../../test/quotameter.test.js#L470-L473)
    - **Problem**: The test sets `root` to a non-existent path (`path.join(home, 'nowhere')`), which fails on `!fs.existsSync(mod)`. It does not test that an existing directory with an invalid package name is rejected by `trusted()`.
    - **Fix**: Write a real directory with a `package.json` containing `{ "name": "other-plugin" }` and assert that the launcher outputs `quotameter: plugin not found`.

---

### What is Fine

- **Privacy and security**: Hook invocations never inspect standard input; prompt text and thinking blocks are never stored or inspected.
- **Process execution safety**: `claude -p /usage` is spawned with argument arrays without a shell, avoiding shell injection and Git Bash slash conversion.
- **Report escaping**: User-facing titles, branch names, and project directories are escaped before interpolation, and `<` is sanitized to prevent script breakout.
- **Inline module script safety**: The inline `<script type="module">` in [`template.html`](../../plugins/quotameter/lib/report/template.html#L272) runs without issue from `file://` URLs because it contains no external `import` declarations.
- **Store locking and concurrency**: Ingest operations use atomic directory locks and leases with pid tracking, preventing concurrent corruption across multiple sessions.
- **Windows path handling**: [`folderName`](../../plugins/quotameter/lib/model/breakdown.js#L28) correctly normalizes Windows backslashes, POSIX forward slashes, and UNC shares across platforms.
- **Status line defaults**: First-turn placeholder `5h -- | wk --` avoids cluttering the terminal before the first response.
