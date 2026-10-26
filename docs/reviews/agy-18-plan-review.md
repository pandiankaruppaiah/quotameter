Here is the review of [the 0.2.0 plan (now in docs/DESIGN.md)](../DESIGN.md) against the codebase in `plugins/quotameter` and the product review in [docs/reviews/agy-17-product-review.md](../../docs/reviews/agy-17-product-review.md).

---

### 1. The Stable Status Line Launcher (Section 1a)

**Design soundness and install paths:**
The problem identified in [PLAN-0.2.0.md line 10](../DESIGN.md#L10) is real. Claude Code installs plugins into versioned cache directories (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`). Claude Code expands `${CLAUDE_PLUGIN_ROOT}` only inside [hooks/hooks.json](../../plugins/quotameter/hooks/hooks.json), never in `settings.json`. A direct path placed in `settings.json` breaks as soon as an update cleans up the old cache directory.

The launcher bridge (`statusline.mjs` reading `launcher.json`) solves the hardcoded path issue, but has three specific risks:

1. **Startup race condition on update:** If an update deletes the old plugin folder, the first prompt render before or during session start will invoke `statusline.mjs`. If `launcher.json` has not been refreshed yet, the status line will print `quotameter: plugin not found`. Hook updates must write `launcher.json` synchronously before spawning any detached background tasks in [bin/quotameter.js line 61](../../plugins/quotameter/bin/quotameter.js#L61).
2. **Windows ESM dynamic import failure:** In Node ESM, dynamic `import(root + '/lib/statusline.js')` fails on Windows with `ERR_UNSUPPORTED_ESM_URL_SCHEME` because Windows drive paths (`C:\...`) are not valid URL schemes. The launcher script must wrap the path with `pathToFileURL(path.resolve(root, 'lib/statusline.js')).href`.
3. **Arbitrary execution security risk:** Loading an executable script from a path found in an unvalidated JSON file allows local privilege escalation if `launcher.json` is modified. The launcher must verify that `root` contains a valid `package.json` with `"name": "quotameter-plugin"` before importing.

**Handling `CLAUDE_CONFIG_DIR`:**
[`claudeConfigDir`](../../plugins/quotameter/lib/paths.js#L12) in [lib/paths.js line 12](../../plugins/quotameter/lib/paths.js#L12) respects `process.env.CLAUDE_CONFIG_DIR`. However, [`quotameterHome`](../../plugins/quotameter/lib/paths.js#L7) in [lib/paths.js line 7](../../plugins/quotameter/lib/paths.js#L7) defaults to `~/.quotameter`. If a user runs multiple profiles with different `CLAUDE_CONFIG_DIR` values, all sessions share one `launcher.json` and overwrite each other's roots. The launcher file and statusline script should live inside `<claudeConfigDir>` instead of `<quotameterHome>`, or `launcher.json` must key roots by config directory path.

---

### 2. The UserPromptSubmit Hook (Sections 1b and 1c)

**Claude Code hook behavior:**
* **`systemMessage` on stdout:** Confirmed. When a hook exits 0, Claude Code parses stdout. A JSON payload containing `{"systemMessage": "..."}` displays the message directly to the user in the active turn without interrupting prompt execution.
* **Not reading stdin:** Claude Code feeds prompt and turn JSON to hook stdin. While Node can ignore stdin and exit immediately, closing the pipe early can cause `EPIPE` or broken pipe errors in the parent process if Claude Code streams large prompts. In [hooks/hooks.json](../../plugins/quotameter/hooks/hooks.json), the hook command should explicitly configure standard input or drain stdin on startup.

**Safety of a 10-minute background poll during activity:**
* **Prompt latency:** Safe. In [PLAN-0.2.0.md line 17](../DESIGN.md#L17), the hook delegates to a detached worker using `stdio: 'ignore'`. The hook process itself exits in under 50 ms.
* **Spending quota:** Running [`runLocalCommand`](../../plugins/quotameter/lib/ingest/usage-poll.js#L107) for `usage` ([lib/ingest/usage-poll.js line 107](../../plugins/quotameter/lib/ingest/usage-poll.js#L107)) executes `claude -p /usage`. It checks `json.local_command === 'usage'` and `json.num_turns === 0`. It does not call an LLM and consumes zero quota.
* **Recursive hooks and leases:** Running `claude -p /usage` starts a headless session in [`pollDir`](../../plugins/quotameter/lib/paths.js#L21), which triggers `SessionStart`. Infinite polling loops are prevented by [`tryLease`](../../plugins/quotameter/lib/store.js#L171) in [lib/ingest/index.js line 29](../../plugins/quotameter/lib/ingest/index.js#L29), which holds a 2-minute lease.

---

### 3. Fresh Tokens and Chat Conversion (Section 3)

**Is defining tokens left from fresh tokens the right call?**
Yes. In [lib/model/analyze.js line 75](../../plugins/quotameter/lib/model/analyze.js#L75), `tokensLeft` currently derives from [`tokensOf`](../../plugins/quotameter/lib/model/util.js#L8) ([lib/model/util.js line 8](../../plugins/quotameter/lib/model/util.js#L8)), which includes cache reads (`cr`).

As noted in [agy-17 review section 3A.2](../../docs/reviews/agy-17-product-review.md#L78-L82), cache reads are discounted by 90% or more. If a user has a long session with 3 million cache reads and 20,000 output tokens, `tokensLeft` projects millions of remaining tokens. The moment the user starts a fresh session without warm cache, they hit the limit in tens of thousands of tokens.

Defining capacity using [`freshOf`](../../plugins/quotameter/lib/model/util.js#L11) (`in + out + cw5 + cw1h` in [lib/model/util.js line 11](../../plugins/quotameter/lib/model/util.js#L11)) matches the true compute budget of new turns.

**Converting chat tokens consistently:**
In [lib/model/analyze.js lines 68-69](../../plugins/quotameter/lib/model/analyze.js#L68-L69), `tokensPerDollar` currently divides total tokens (including cache reads) by dollars:
`tokensPerDollar = sum(inWin, tokensOf) / sum(inWin, (m) => m.adj)`

Because Claude Code has massive cache-read ratios, this inflates `tokensPerDollar` and produces millions of phantom chat tokens. To be consistent:
1. Compute `freshTokensPerDollar = sum(inWin, freshOf) / sum(inWin, (m) => m.adj)`.
2. Estimate chat tokens using fresh tokens: `tokensChat = Math.round((attr.chat / cal.k) * freshTokensPerDollar)`.
3. Compute `tokensLeft` strictly from fresh tokens: `Math.round(((tokensFresh + tokensChat) / fc.pct) * (100 - fc.pct))`.

Both Code and Chat will share the same fresh token basis.

---

### 4. Split of analyze.js and Page Script Extraction (Section 5)

**Test suite compatibility:**
The tests in [test/quotameter.test.js](../../test/quotameter.test.js) will continue working.

In the current codebase, the file split has already been largely implemented:
* [lib/model/load.js](../../plugins/quotameter/lib/model/load.js) handles loading and reconciliation.
* [lib/model/windows.js](../../plugins/quotameter/lib/model/windows.js) handles windowing, calibration, attribution, and forecasts.
* [lib/model/breakdown.js](../../plugins/quotameter/lib/model/breakdown.js) handles breakdowns.
* [lib/model/models.js](../../plugins/quotameter/lib/model/models.js) handles model normalization and colors.

Because [lib/model/analyze.js lines 16-17](../../plugins/quotameter/lib/model/analyze.js#L16-L17) re-exports `loadData`, `roundMinute`, `familyOf`, and `prettyModel`, all external imports in [test/quotameter.test.js lines 11, 137, and 283](../../test/quotameter.test.js#L11) remain intact.

**Stripping `export ` from format.js:**
Stripping `export ` with `replace(/^export /gm, '')` in [`pageScript`](../../plugins/quotameter/lib/report/render.js#L12) ([lib/report/render.js line 18](../../plugins/quotameter/lib/report/render.js#L18)) works only under strict conditions and is a trap:
* If anyone introduces `export default`, `export { a, b }`, or indented exports, regex stripping produces invalid JavaScript or syntax errors.
* If anyone adds an `import` statement to [lib/report/format.js](../../plugins/quotameter/lib/report/format.js), embedding it inside a non-module `<script>` tag causes the browser to reject it with `Cannot use import statement outside a module`.
* A cleaner solution is to render the inline tag as `<script type="module">`. Modern browsers support module scripts natively, which allows standard `export` statements without regex text manipulation.

---

### 5. Plan Risks, Flaws, and Product Review Gaps

**Risks and flawed items in the plan:**
1. **The backup file strategy in Section 1a (`settings.json.quotameter.bak`):** Writing this file once and never updating it means if a user runs `setup --remove` and re-runs `setup` months later, restoring `.bak` will erase all other settings added in the intervening months. A diff or surgical key removal is safer.
2. **`warned.json` write collisions (Section 1c):** The plan specifies writing `warned.json` without file locking. If multiple Claude Code sessions run simultaneously in separate windows, concurrent prompt hooks will race and corrupt the file. Writes must use an atomic tempfile rename.
3. **Keeping the heatmap in "Technical details" (Section 5):** [agy-17 review section 2B.2](../../docs/reviews/agy-17-product-review.md#L52) identified the 168-cell heatmap as low-value clutter. Relocating it instead of removing it retains 50 lines of unused SVG logic in [lib/report/report.js lines 351-371](../../plugins/quotameter/lib/report/report.js#L351-L371).

**Critical items missed from the product review:**
1. **Missing Node.js detection:** [agy-17 review section 1A](../../docs/reviews/agy-17-product-review.md#L5-L8) pointed out that Claude Code's native standalone binaries do not include Node.js. When users lack Node on their `PATH`, hooks fail silently with `stdio: 'ignore'`. The plan does not add a check or visible diagnostic for this failure mode.
2. **Windows command resolution overhead:** [agy-17 review section 1E](../../docs/reviews/agy-17-product-review.md#L30) noted that spawning `cmd.exe /c` fallback wrappers in [lib/ingest/usage-poll.js lines 28-30](../../plugins/quotameter/lib/ingest/usage-poll.js#L28-L30) causes quoting fragility and slow process startup. The plan leaves this unaddressed.
3. **In-report "Mark as Code-Only" button:** [agy-17 review section 3B.3 and item 7](../../docs/reviews/agy-17-product-review.md#L93-L95) called for an interactive button directly inside the HTML report. The plan implements it only as a CLI command (`quotameter mark code-only`), leaving it hidden from users who view the browser report.
4. **Real-world path fixtures in automated tests:** [agy-17 review section 4C.2](../../docs/reviews/agy-17-product-review.md#L122-L124) highlighted that tests only use synthetic POSIX paths like `/p/app`. Windows paths with drive letters, backslashes, and spaces remain untested.
