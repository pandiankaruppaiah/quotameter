### 1. First-Run Experience

A new user installing quotameter faces several friction points in the first 10 minutes that can lead them to abandon the plugin:

#### A. Node.js Dependency and Silent Hook Failures
* **Prerequisite barrier:** Claude Code provides native single-binary installers for Windows, macOS, and Linux that do not include Node.js. [README.md line 31](../../README.md#L31) lists Node 18+ as a requirement, but users installing through `/plugin marketplace add` ([README.md line 48](../../README.md#L48)) often do not read the full prerequisites.
* **Silent background failure:** All three lifecycle hooks in [hooks.json lines 4, 7, 10](../../plugins/quotameter/hooks/hooks.json#L4) invoke `node "${CLAUDE_PLUGIN_ROOT}/bin/quotameter.js" hook start|stop|end`. If Node is not on the user's `PATH` (for instance, when installed via nvm/asdf or in non-login GUI shells), or if the hook fails, [bin/quotameter.js lines 61-63](../../plugins/quotameter/bin/quotameter.js#L61-L63) spawns the background worker with `stdio: 'ignore'`. The hook fails completely silently without logging any actionable diagnostic to the user's Claude Code session.

#### B. The `/quotameter:setup` Skill Friction
* **Non-deterministic LLM configuration:** [setup/SKILL.md lines 10-24](../../plugins/quotameter/skills/setup/SKILL.md#L10-L24) instructs the assistant to read `~/.claude/settings.json`, explain changes, request user confirmation, and manually construct a JSON string edit. Having an LLM hand-edit core application settings introduces syntax errors, escaping failures, and friction.
* **Path escaping pitfalls:** On Windows, paths like `C:\Users\name\...` require either forward slashes or double-escaped backslashes. If the model misformats `statusLine.command` ([setup/SKILL.md line 15](../../plugins/quotameter/skills/setup/SKILL.md#L15)), Claude Code fails to parse `settings.json` on restart. This entire setup should be a deterministic CLI command (`quotameter setup --statusline`) rather than an agentic prompt script.
* **Latency on prompt refresh:** If the user already has a status line command, [setup/SKILL.md line 21](../../plugins/quotameter/skills/setup/SKILL.md#L21) wraps it with `--wrap "<command>"`. In [statusline.js line 54](../../plugins/quotameter/lib/statusline.js#L54), `runWrapped` spawns a subshell on every single refresh turn. This adds perceptible latency to every terminal response.

#### C. The "Empty Report" Cold-Start
* **Disappointing first report:** A user installing the plugin will immediately run `/quotameter:report`. While Claude Code log history exists in `~/.claude/projects`, limit percentages are only recorded while quotameter runs ([README.md line 87](../../README.md#L87)).
* **A sea of empty placeholders:** If the user runs the report right away, [template.html](../../plugins/quotameter/lib/report/template.html) renders an uninviting collection of missing-data notices:
  * [template.html line 316](../../plugins/quotameter/lib/report/template.html#L316): `No limit readings yet. Run quotameter poll...`
  * [template.html line 324](../../plugins/quotameter/lib/report/template.html#L324): `Waiting for the first limit reading.`
  * [template.html line 338](../../plugins/quotameter/lib/report/template.html#L338): `No readings yet.`
  * [template.html line 358](../../plugins/quotameter/lib/report/template.html#L358): `No readings in this window yet.`
  * [template.html line 387](../../plugins/quotameter/lib/report/template.html#L387): `Needs at least one limit reading.`
  * [template.html lines 407, 418, 424, 479, 508, 523, 531, 546, 553, 610](../../plugins/quotameter/lib/report/template.html#L407): Multiple cards show "n/a" or "no data".
* **Swallowed poll failures:** In [bin/quotameter.js lines 92-98](../../plugins/quotameter/bin/quotameter.js#L92-L98), `report` executes `await ingest({ poll: 'auto' })` without inspecting whether the poll succeeded. If `claude -p /usage` fails (due to PATH issues, API-key authentication, or slow network), the error is suppressed, and the browser opens to an empty, uncalibrated report.

#### D. Status Line First Turn
* In [statusline.js line 49](../../plugins/quotameter/lib/statusline.js#L49), if `rate_limits` are not yet populated on stdin (which happens on the very first turn of a session), `statusText()` outputs `quotameter: waiting for first response`. This 37-character placeholder clutters terminal real estate on every new session launch until Claude finishes streaming.

#### E. Operating System Discrepancies
* **WSL browser launch failure:** [bin/quotameter.js lines 51-58](../../plugins/quotameter/bin/quotameter.js#L51-L58) uses `xdg-open` on Linux. Under WSL (Windows Subsystem for Linux), where many Claude Code developers work, `xdg-open` fails without an active X11 server or `wslview`. The command fails silently without presenting the Windows file path.
* **Windows executable resolution:** In [usage-poll.js lines 16-20](../../plugins/quotameter/lib/ingest/usage-poll.js#L16-L20), `findClaude()` defaults to `'claude'`. On Windows, npm installs `claude.cmd`, while the native installer uses `claude.exe`. While lines 28-30 attempt a fallback using `cmd.exe /c`, spawning cmd wrappers creates process overhead and path quoting fragilities on Windows setups.
* **Store directory permissions:** [store.js line 37](../../plugins/quotameter/lib/store.js#L37) executes `fs.chmodSync(dir, 0o700)`. If run in Docker, containerized dev environments, or network file shares where POSIX mode changes fail, this can trigger runtime errors.

---

### 2. Usefulness

#### A. Features That Earn Their Place
1. **The Dual Limit Meters and Reset Countdown:**
   * [template.html lines 336-352](../../plugins/quotameter/lib/report/template.html#L336-L352): Showing percent used, reset time, and projected percentage at reset directly answers the primary question users have: "Will I hit the limit before it resets?"
2. **Remaining Session Capacity ("Sessions Left"):**
   * [insights.js lines 145-148](../../plugins/quotameter/lib/model/insights.js#L145-L148) and [template.html line 349](../../plugins/quotameter/lib/report/template.html#L349): Converting abstract percentage points into "Room for about X more sessions like your usual ones" provides intuitive, practical context.
3. **Unused MCP Server Overhead Detection:**
   * [analyze.js lines 685-689](../../plugins/quotameter/lib/model/analyze.js#L685-L689) and [template.html line 610](../../plugins/quotameter/lib/report/template.html#L610): Identifying MCP servers that were loaded into every session context but had zero tool calls in 30 days is actionable and directly saves quota.
4. **Model What-If Simulator:**
   * [insights.js lines 188-201](../../plugins/quotameter/lib/model/insights.js#L188-L201) and [template.html lines 519-523](../../plugins/quotameter/lib/report/template.html#L519-L523): Simulating what Opus and Fable workloads would consume if run on Sonnet or Haiku helps developers spot inefficient model assignments.
5. **Prompt Cache Rebuild Cost Tracking:**
   * [insights.js lines 204-246](../../plugins/quotameter/lib/model/insights.js#L204-L246): Spotting context rebuilds (large creation writes after pauses longer than the 5-minute TTL) highlights a major source of hidden quota drain.

#### B. Noise and Low-Value Features
1. **The Plan Value Multiple:**
   * [analyze.js lines 642-655](../../plugins/quotameter/lib/model/analyze.js#L642-L655) and [template.html lines 650-655](../../plugins/quotameter/lib/report/template.html#L650-L655): Displaying "$1,450 vs $20 a month for your plan: 72.5x the subscription price" reads like promotional copy. Pro and Max subscribers pay flat monthly fees; calculating theoretical API equivalent multiples provides little optimization value.
2. **The 7x24 Weekday/Hour Heatmap:**
   * [analyze.js lines 572-584](../../plugins/quotameter/lib/model/analyze.js#L572-L584) and [template.html lines 626-646](../../plugins/quotameter/lib/report/template.html#L626-L646): A 168-cell grid of when the user works takes up visual space without providing actionable quota guidance. Developers already know what hours they work.
3. **Naive Equal-Share Tool Cost Splitting:**
   * [analyze.js lines 336-348](../../plugins/quotameter/lib/model/analyze.js#L336-L348): When a message invokes multiple tools, tokens and costs are divided equally among them (`share = 1 / tools.length`). Assigning equal cost to a lightweight `Glob` call and a massive file `Read` produces inaccurate data.
4. **Over-Engineered Retention and Compaction:**
   * [retention.js lines 80-131](../../plugins/quotameter/lib/model/retention.js#L80-L131) manages 11 distinct JSONL files with complex batching, lock acquisition, drain steps, and row rewriting. For local metadata that rarely exceeds 10 to 20 megabytes over months, running background compaction creates risk of store corruption for negligible disk savings.

#### C. Critical Missing Capabilities
1. **Proactive Rate-Limit Warning Hook:**
   * Currently, quotameter only collects data passively. It lacks a `PreToolUse` or `UserPromptSubmit` hook to warn the user before a quota limit hits (e.g. "Quota alert: 5-hour limit is at 91%, reset in 35m. Continue?").
2. **Compact Terminal Dashboard:**
   * Running `/quotameter:report` always attempts to open an external browser window ([bin/quotameter.js line 124](../../plugins/quotameter/bin/quotameter.js#L124)). A quick, styled terminal status card (displaying meters, pace, and top model) without opening a browser tab is essential for terminal-focused workflows.
3. **Branch and Task-Level Quota Budgeting:**
   * Developers want to know how much quota a specific pull request, refactor, or feature branch consumed. While `gitBranch` is recorded in [logs.js line 52](../../plugins/quotameter/lib/ingest/logs.js#L52), there is no way to set a quota budget or view usage by branch over time.
4. **Team and Engineering Lead Exports:**
   * Team leads need an exportable summary (`quotameter export --format json|csv`) to monitor subagent usage, expensive models, and MCP overhead across team repositories.

---

### 3. Accuracy and Trust

#### A. Where Estimates Mislead
1. **The Linear API List-Price Assumption:**
   * In [analyze.js lines 190-205](../../plugins/quotameter/lib/model/analyze.js#L190-L205), calibration computes `k` (percentage points per dollar) by comparing list-price token costs to observed quota drops.
   * Anthropic does not document that subscription rate limits scale linearly with API dollar pricing. For example, Haiku costs $0.10/M tokens, while Opus costs $4.00/M tokens (a 40x price difference). Anthropic's internal rate limits do not necessarily allow 40 times more Haiku tokens per hour than Opus tokens.
   * Because `k` is derived from dollars, any mismatch between Anthropic's true internal quota algorithm and the API pricing table is dumped into the "Chat and other devices" residual ([analyze.js lines 215-223](../../plugins/quotameter/lib/model/analyze.js#L215-L223)). A user who never uses claude.ai can still see 15% to 30% attributed to "Chat".
2. **Flawed "Tokens Left" Calculation:**
   * In [analyze.js line 489](../../plugins/quotameter/lib/model/analyze.js#L489):
     `fc.tokensLeft = fc.pct > 0 ? Math.round((totalTokens / fc.pct) * (100 - fc.pct)) : null;`
   * In [analyze.js line 486](../../plugins/quotameter/lib/model/analyze.js#L486), `totalTokens` sums all exact tokens, including cache reads.
   * Cache read tokens cost only 10% (or less) of input tokens and count far less against rate limits. If a session had 2,000,000 cache read tokens and 20,000 output tokens, `tokensLeft` will report millions of remaining tokens. The moment the user starts a fresh session without cache hits, they will hit the rate limit in 50,000 tokens. This misleads users about their remaining capacity.
3. **Discretization and Whole-Number Percentage Noise:**
   * The `/usage` command returns integers (e.g. 12%, 13%). In [analyze.js lines 237-245](../../plugins/quotameter/lib/model/analyze.js#L237-L245), `slope()` fits a regression line through integer values. A jump from 3% to 4% over a 5-minute interval creates sudden spikes in calculated pace and erratic "time to 100%" estimates.
4. **Attribution of Multiple Machines:**
   * If a developer uses Claude Code on both a work desktop and a laptop, the laptop's quotameter installation labels the desktop's usage as "Chat and other devices" ([analyze.js line 357](../../plugins/quotameter/lib/model/analyze.js#L357)).

#### B. Communicating Uncertainty to Build User Trust
1. **Strictly Separate Measured Data from Inferred Estimates:**
   * In [template.html line 578](../../plugins/quotameter/lib/report/template.html#L578), exact tokens and estimated chat tokens are combined in total token counts. The UI should display exact logged tokens prominently and report estimated unlogged usage in a separate secondary section with clear labeling.
2. **Confidence Ranges Instead of Point Forecasts:**
   * Instead of projecting a single target ("At this pace you reach the limit at 4:15pm", [template.html line 346](../../plugins/quotameter/lib/report/template.html#L346)), provide an expected range (e.g. "Projected limit between 3:45pm and 4:40pm based on turn variance").
3. **User Feedback Loop for Calibration:**
   * While `codeOnlyWindows` exists in the configuration schema ([config.js line 10](../../plugins/quotameter/lib/config.js#L10)), there is no interactive button in the HTML report to mark a window as "Code-only". Giving users a button to confirm "I did not use claude.ai today" would improve calibration accuracy and user trust.

---

### 4. Maintainability

#### A. Overly Large and Monolithic Files
1. **`plugins/quotameter/lib/model/analyze.js` (705 lines):**
   * This file combines too many responsibilities: store loading ([lines 24-74](../../plugins/quotameter/lib/model/analyze.js#L24-L74)), cost reconciliation ([lines 104-131](../../plugins/quotameter/lib/model/analyze.js#L104-L131)), window segmentation ([lines 135-157](../../plugins/quotameter/lib/model/analyze.js#L135-L157)), regression calibration ([lines 190-205](../../plugins/quotameter/lib/model/analyze.js#L190-L205)), attribution calculation ([lines 207-234](../../plugins/quotameter/lib/model/analyze.js#L207-L234)), pace forecasting ([lines 247-278](../../plugins/quotameter/lib/model/analyze.js#L247-L278)), breakdown aggregation ([lines 302-350](../../plugins/quotameter/lib/model/analyze.js#L302-L350)), model naming ([lines 421-433](../../plugins/quotameter/lib/model/analyze.js#L421-L433)), heatmap grouping ([lines 572-584](../../plugins/quotameter/lib/model/analyze.js#L572-L584)), overhead analysis ([lines 606-640](../../plugins/quotameter/lib/model/analyze.js#L606-L640)), and recommendations ([lines 680-705](../../plugins/quotameter/lib/model/analyze.js#L680-L705)).
   * Any change to forecasting or data structures risks regressions in breakdown reporting or archive compaction.
2. **`plugins/quotameter/lib/report/template.html` (691 lines):**
   * Contains embedded CSS, raw HTML markup, client-side data binding, table formatting, and SVG chart drawing algorithms ([lines 355-381, 429-462, 626-646](../../plugins/quotameter/lib/report/template.html#L355)).
   * Because all client-side JavaScript is embedded inside an uncompiled HTML string, syntax errors cannot be caught by standard build linters or tests.
3. **`plugins/quotameter/lib/model/insights.js` (455 lines):**
   * Houses 14 different statistical calculations in a single script. Each metric uses separate filtering and sorting passes over the message collection.

#### B. Duplicated Logic and Magic Constants
1. **Fragmented Model Definitions:**
   * Model prices and regex normalization are defined in [pricing.js lines 11-50](../../plugins/quotameter/lib/model/pricing.js#L11-L50).
   * Model families and display names are defined separately in [analyze.js lines 417-433](../../plugins/quotameter/lib/model/analyze.js#L417-L433).
   * Model color mappings are hardcoded a third time in [template.html line 562](../../plugins/quotameter/lib/report/template.html#L562) (`MC(m)`). Adding a new model requires coordinated edits in three distinct files.
2. **Duplicated Formatting Functions:**
   * Number, duration, and date formatters (`fmt`, `dur`, `clock`) are written in Node in [render.js lines 19-29](../../plugins/quotameter/lib/report/render.js#L19-L29).
   * Near-identical functions (`fmt`, `dur`, `time`, `dayTime`, `until`) are re-implemented in client-side JavaScript in [template.html lines 275-282](../../plugins/quotameter/lib/report/template.html#L275-L282).

#### C. Testing Gaps
1. **Zero Client-Side Test Coverage:**
   * The test suite in [test/quotameter.test.js](../../test/quotameter.test.js) tests backend models and parsers, but has zero tests executing the browser DOM or SVG chart logic inside `template.html`. A client-side JavaScript runtime exception will break the HTML report without failing any test in `npm test`.
2. **Missing Real-World Path Fixtures:**
   * Tests use synthetic POSIX path strings like `/p/app` and `/p/x` ([test/quotameter.test.js lines 203, 225, 289](../../test/quotameter.test.js#L203)). Windows-style drive letters, UNC shares, and paths with spaces or special characters are not exercised in the automated test suite.

---

### 5. Discoverability and Adoption

#### A. Value Proposition and Positioning
* **Dense introduction:** The opening paragraph in [README.md line 9](../../README.md#L9) is a dense 6-line catalog of features. It describes technical attribution dimensions (subagent, skill, MCP server, cost-state residual) before addressing the user's primary concern: "How do I prevent my Claude Code session from getting blocked by rate limits?"
* **Clearer positioning:** The documentation should lead with three direct user questions:
  1. Am I going to hit my limit before my session finishes?
  2. What hidden tool, subagent, or MCP server is consuming my quota?
  3. How many more coding sessions can I run today?

#### B. Command Usability and Naming
* **Missing quick terminal command:** Currently, the plugin only registers `/quotameter:report` and `/quotameter:setup`. When a developer in the terminal wants a fast status check, they do not want to run a report that opens a browser window. Adding `/quotameter:status` to print a 3-line terminal summary directly in chat would improve daily usability.
* **Overly aggressive skill triggering:** In [report/SKILL.md line 3](../../plugins/quotameter/skills/report/SKILL.md#L3), the skill triggers whenever a user asks about tokens, limits, or quota. In [report/SKILL.md lines 10-16](../../plugins/quotameter/skills/report/SKILL.md#L10-L16), running this skill automatically launches the user's browser via `quotameter.js report`. If a user asks a simple question like "how many tokens do I have left?", opening a browser window is disruptive. The skill should print the text summary into chat and only launch the browser when explicitly requested.

#### C. Viral Adoption and Retention Loops
* **Automate status line adoption:** The status line is the primary driver of long-term retention. Leaving it as an optional multi-step manual prompt in [setup/SKILL.md](../../plugins/quotameter/skills/setup/SKILL.md) means the majority of users never activate it.
* **Sharable quota summary card:** While [bin/quotameter.js line 33](../../plugins/quotameter/bin/quotameter.js#L33) provides a `--share` flag for HTML reports, there is no command to generate a clean, privacy-safe text summary designed for sharing in GitHub issues, Discord, or team Slack channels.

---

### 6. Top 10 Improvements Ranked by Value / Effort

Ranked by (Value to Users / Implementation Effort):

| # | Improvement | Concrete File References | One-Line Reason | Effort Estimate |
|---|---|---|---|---|
| **1** | **Deterministic 1-click statusline setup CLI** | [setup/SKILL.md](../../plugins/quotameter/skills/setup/SKILL.md#L10-L24), [bin/quotameter.js](../../plugins/quotameter/bin/quotameter.js#L89) | Replace error-prone LLM JSON editing with a safe `quotameter setup --statusline` CLI command to drive permanent user retention. | 2.5 hours |
| **2** | **Terminal `/quotameter:status` without opening browser** | [report/SKILL.md](../../plugins/quotameter/skills/report/SKILL.md#L10-L16), [render.js](../../plugins/quotameter/lib/report/render.js#L31-L52) | Provide an in-chat status summary on demand instead of disrupting terminal workflows by popping open browser tabs. | 2.0 hours |
| **3** | **Proactive rate-limit warning hook** | [hooks/hooks.json](../../plugins/quotameter/hooks/hooks.json#L2-L12), [bin/quotameter.js](../../plugins/quotameter/bin/quotameter.js#L67-L71) | Add a `UserPromptSubmit` hook that checks current quota percentage and warns the developer before a critical rate limit locks them out. | 3.5 hours |
| **4** | **Fix "Tokens Left" calculation to discount cache reads** | [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L485-L491), [template.html](../../plugins/quotameter/lib/report/template.html#L327) | Prevent misleading projections by excluding cheap cache-read tokens from the extrapolation formula. | 1.5 hours |
| **5** | **Friendly first-run onboarding state and immediate poll** | [bin/quotameter.js](../../plugins/quotameter/bin/quotameter.js#L92), [template.html](../../plugins/quotameter/lib/report/template.html#L316-L324) | Handle initial polling synchronously on first run and display clear onboarding guidance instead of 10 empty "no data" cards. | 3.0 hours |
| **6** | **Unify model metadata, pricing, and color definitions** | [pricing.js](../../plugins/quotameter/lib/model/pricing.js#L11-L50), [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L417-L433), [template.html](../../plugins/quotameter/lib/report/template.html#L562) | Consolidate model pricing, family names, and theme colors into a single shared registry so adding models does not require three separate file edits. | 2.0 hours |
| **7** | **In-report "Mark as Code-Only" calibration action** | [template.html](../../plugins/quotameter/lib/report/template.html#L394-L396), [config.js](../../plugins/quotameter/lib/config.js#L9-L10) | Allow users to confirm a window had zero chat activity, improving the calibration factor `k` and eliminating false chat attribution. | 2.5 hours |
| **8** | **Modularize `analyze.js` into focused sub-libraries** | [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L1-L705) | Split the 705-line monolith into `reconcile.js`, `calibrate.js`, `forecast.js`, and `breakdown.js` to enable safer ongoing development. | 4.5 hours |
| **9** | **Deprecate or collapse low-value visual noise** | [template.html](../../plugins/quotameter/lib/report/template.html#L618-L655), [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L572-L584) | Move the 168-cell activity heatmap and the subscription value multiplier into a collapsed section to keep the main report focused on quota optimization. | 1.5 hours |
| **10** | **Exportable summary card for team leads and sharing** | [bin/quotameter.js](../../plugins/quotameter/bin/quotameter.js#L111-L125), [render.js](../../plugins/quotameter/lib/report/render.js#L31-L52) | Add `quotameter export --format markdown|json` to generate clean, shareable quota reports for team leads and issue discussions. | 2.5 hours |
