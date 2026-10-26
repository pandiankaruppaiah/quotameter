Here are 14 feature ideas for quotameter that expand it beyond passive usage tracking into proactive quota management.

---

### 1. Reset Flight Planner (Pre-Session Task Sizing)

* **What the user sees:** A terminal command `/quotameter:plan` or status message: `14% left (resets in 42m). Fits: 1 quick fix (~4%). A full feature (~25%) will stall mid-work. Recommendation: wait 42m or switch to Haiku.`
* **Why it is valuable:** Prevents the most frustrating Pro and Max failure mode: running out of quota midway through an uncommitted architectural change.
* **What data or hook it needs:** Statistical distribution of past session costs from `messages.jsonl` combined with current limit percentages and reset timestamps.
* **Whether the data exists locally today:** Yes. Historical session totals and live reset times are already captured in `messages.jsonl` and `readings.jsonl`.
* **Effort in hours:** 10 hours.
* **Risks:** Task sizing has natural variance. Predictions must be framed as probabilistic ranges rather than guarantees.

---

### 2. Branch and Project Quota Budgets

* **What the user sees:** A command `quotameter budget set 25%` on branch `feature/auth`. When prompt submissions push that branch past 20% and 25%, Claude Code displays a warning: `Branch 'feature/auth' reached its 25% quota budget (used 25.4%). Switch to Haiku or raise budget with /quotameter:budget.`
* **Why it is valuable:** Helps developers and team leads allocate their rolling 5-hour allowance across multiple repositories or client tasks without burning their entire budget on one minor issue.
* **What data or hook it needs:** `UserPromptSubmit` hook inspecting current git branch and calculating cumulative branch cost.
* **Whether the data exists locally today:** Yes. `gitBranch` and `cwd` are already logged per message in `messages.jsonl`.
* **Effort in hours:** 12 hours.
* **Risks:** Switching git branches inside an active session without restarting Claude Code requires dynamic branch detection on each prompt.

---

### 3. Prompt Cache Warmth Countdown

* **What the user sees:** The status line displays cache status: `Cache: 145k warm (expires in 2m 15s) | 5h 22%`. If inactive for 4 minutes, the prompt hook alerts the user: `Prompt cache expiring in 45s. Submit your next turn now to avoid a full context rebuild.`
* **Why it is valuable:** Prompt cache writes cost significantly more than cache reads. Pausing for more than the 5-minute TTL causes massive cache rebuilds that rapidly deplete quota.
* **What data or hook it needs:** Timestamp of the previous turn from `live.jsonl` compared against current clock time.
* **Whether the data exists locally today:** Yes. Message timestamps and cache write and read token counts exist locally in real time.
* **Effort in hours:** 8 hours.
* **Risks:** The status line refreshes only when Claude Code outputs a turn. Providing sub-minute warnings requires either background timer checks or prompt submission checks.

---

### 4. Context Bloat Compaction Trigger

* **What the user sees:** An in-session alert when active context passes a high threshold: `Session context reached 98k tokens (costing ~1.5% quota per turn). Run /compact to shed ~65k tokens and save ~1.0% per prompt.`
* **Why it is valuable:** In long conversations, repeating 100k+ tokens of past history on every turn drains quota exponentially. Prompting the user to run `/compact` at the right moment cuts per-turn burn in half.
* **What data or hook it needs:** `UserPromptSubmit` hook checking recent turn input and cache tokens from `live.jsonl`.
* **Whether the data exists locally today:** Yes. Turn token counts are recorded in session logs and live files.
* **Effort in hours:** 6 hours.
* **Risks:** Running `/compact` too early can drop necessary conversational nuance. The threshold must trigger only after high token counts and multiple turns.

---

### 5. Subagent Tree Quota Profiler

* **What the user sees:** An interactive tree view in the HTML report and a terminal tree showing parent session, spawned subagents, depth, models used, and exact percentage points consumed by each subagent branch.
* **Why it is valuable:** Autonomous subagents are currently black boxes. Users often discover only after the fact that a recursive subagent swallowed 40% of their 5-hour allowance.
* **What data or hook it needs:** Ingestion of `subagents/agent-*.jsonl` and `agent-*.meta.json` files, mapping `parentSessionId` and `spawnDepth`.
* **Whether the data exists locally today:** Yes. Claude Code stores subagent logs and metadata files alongside project logs.
* **Effort in hours:** 14 hours.
* **Risks:** Subagent logs can be written asynchronously or cleaned up independently, requiring robust handling of incomplete agent trees.

---

### 6. PreToolUse Large-File Interceptor

* **What the user sees:** A terminal confirmation prompt before a tool runs: `PreToolUse Guard: File 'dist/bundle.js' is 3.8 MB (~950k tokens). Reading it will consume ~30% of your 5-hour quota. Proceed? (y/N)`.
* **Why it is valuable:** Stops catastrophic single-turn quota destruction caused by Claude accidentally reading minified bundles, large CSVs, or log files.
* **What data or hook it needs:** Claude Code `PreToolUse` hook inspecting tool arguments (such as `file_path` for file viewing tools) and running local `fs.statSync`.
* **Whether the data exists locally today:** Partial. Local file sizes exist, but quotameter currently registers only `SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd` hooks.
* **Effort in hours:** 16 hours.
* **Risks:** The hook must execute in under 15 milliseconds to avoid adding perceived latency to normal file reads.

---

### 7. Zero-Upload Anonymized Team Quota Digest

* **What the user sees:** `quotameter team export` produces a privacy-safe JSON digest. A team lead collects these files and runs `quotameter team report *.json` to view team metrics: cache hit efficiency, subagent share, model distribution, and quota waste without any code, filenames, or prompts.
* **Why it is valuable:** Engineering leads need to benchmark usage patterns and justify subscription plans across teams without transmitting proprietary code or violating privacy boundaries.
* **What data or hook it needs:** Aggregated totals from `daily.jsonl` and `windows.jsonl`, stripped of project paths, branches, and titles.
* **Whether the data exists locally today:** Yes. The retention engine already computes these aggregate statistics locally.
* **Effort in hours:** 12 hours.
* **Risks:** Very small teams could potentially infer who worked when if daily timestamps are too granular. Summaries should aggregate across full days.

---

### 8. Multi-Machine Peer Sync (Resolving Unlogged Usage)

* **What the user sees:** The mysterious "Chat and other devices" attribution drops from 35% to 4%, replaced by concrete entries: `Laptop (Work): 31% (Sonnet 3.7, repo-frontend)`.
* **Why it is valuable:** Users working across both a desktop and a laptop currently see their secondary machine misclassified as web chat. This eliminates the largest blind spot in quotameter's calibration.
* **What data or hook it needs:** Exporting and importing lightweight, encrypted reading manifests via a user-specified shared directory (such as a local git dotfiles repo or Syncthing folder).
* **Whether the data exists locally today:** No across machines. The data exists locally on each separate computer, but no synchronization transport exists yet.
* **Effort in hours:** 18 hours.
* **Risks:** Clock skew between computers and out-of-order log merges can complicate time-window reconciliation.

---

### 9. Dynamic MCP Server Quota Tax Calculator

* **What the user sees:** A report section listing MCP overhead: `MCP Schema Overhead: 16,500 tokens loaded every turn. Servers 'jira' and 'sentry' had 0 tool calls this week, costing ~6.8% of your 5-hour quota. Run quotameter mcp prune to disable them.`
* **Why it is valuable:** Unused MCP servers bloat the system prompt on every single turn. Disabling idle servers recovers 10% to 20% of active turn capacity.
* **What data or hook it needs:** Snapshot data from `claude -p /context` correlated with actual tool call counts in `messages.jsonl`.
* **Whether the data exists locally today:** Yes. Quotameter already takes `/context` snapshots and logs all tool invocations.
* **Effort in hours:** 14 hours.
* **Risks:** Modifying MCP configuration files directly can be sensitive. The tool should recommend settings adjustments or generate toggles rather than editing configs without prompt confirmation.

---

### 10. Quota-Aware Model Router (Task Sizing Suggestions)

* **What the user sees:** When submitting a simple task while quota is running low: `Quotameter suggestion: 5-hour quota is at 82%. This prompt appears to be unit test formatting. Switching to Haiku with /model haiku will save ~7% quota.`
* **Why it is valuable:** Helps users preserve their limited Opus and Sonnet quota for complex design and debugging by directing boilerplate tasks to lightweight models.
* **What data or hook it needs:** `UserPromptSubmit` hook inspecting prompt length, basic task keywords, and current quota percentage.
* **Whether the data exists locally today:** Yes. Hook stdin receives prompt details and local store has latest limit readings.
* **Effort in hours:** 12 hours.
* **Risks:** Simple keyword heuristics can misjudge prompt complexity. Recommendations must remain non-blocking suggestions.

---

### 11. Reset Alarm Desktop Notification

* **What the user sees:** A native operating system desktop notification at the exact moment of reset: `Claude 5-Hour Quota Reset: Limit is back to 0% used. Your allowance is fully replenished.`
* **Why it is valuable:** When locked out at 95%+, developers switch to other tasks and forget to check back, losing an hour or more of prime coding time after the reset occurs.
* **What data or hook it needs:** A scheduled background timer using native OS commands (PowerShell on Windows, `osascript` on macOS, `notify-send` on Linux).
* **Whether the data exists locally today:** Yes. The exact reset timestamp is already parsed and stored in `readings.jsonl`.
* **Effort in hours:** 6 hours.
* **Risks:** Laptops that go into sleep mode will delay timer execution until the machine wakes.

---

### 12. Automated Script and CI Quota Guard (`quotameter precheck`)

* **What the user sees:** A fast CLI command for build scripts: `quotameter precheck --min-points 25`. It exits with code 0 if quota is available, or code 1 with: `Aborted: 5-hour quota has only 11% remaining (25% required). Resets at 3:15pm.`
* **Why it is valuable:** Prevents automated scripts or headless Claude Code runs from draining the developer's daily allowance and blocking interactive coding.
* **What data or hook it needs:** Reading the latest percentage and reset time from `live.jsonl` or `readings.jsonl`.
* **Whether the data exists locally today:** Yes. Current limit state is readily accessible in local storage.
* **Effort in hours:** 4 hours.
* **Risks:** Very low. This is a lightweight read-only CLI check.

---

### 13. Antigravity and Multi-Surface Log Ingestion

* **What the user sees:** A consolidated surface breakdown: `Claude Code: 58% | Antigravity: 26% | Claude Desktop: 10% | Chat: 6%`.
* **Why it is valuable:** Developers who use Google Antigravity alongside Claude Code draw from shared model allowances or want unified visibility into their daily agent token spend.
* **What data or hook it needs:** Parsing local Antigravity transcript logs from `.gemini/antigravity-cli/brain/*/transcript.jsonl`.
* **Whether the data exists locally today:** Yes. Antigravity stores structured JSONL transcripts locally on the machine.
* **Effort in hours:** 16 hours.
* **Risks:** Antigravity transcript schemas differ from Claude Code logs. Parsing logic must be maintained across updates.

---

### 14. Single-File SQLite Engine (`node:sqlite`)

* **What the user sees:** Sub-50ms report generation, zero lock-file race conditions on Windows, and seamless queries across any historical date range.
* **Why it is valuable:** Replaces hundreds of lines of fragile multi-file JSONL compaction, offset tracking, and custom file-locking code with built-in transactional storage.
* **What data or hook it needs:** Node.js built-in `node:sqlite` (available in Node 22.5+), with fallback handling for older Node versions.
* **Whether the data exists locally today:** Yes. This replaces internal storage mechanics without altering external data sources.
* **Effort in hours:** 20 hours.
* **Risks:** Maintaining backwards compatibility with Node 18 environments requires keeping a legacy JSONL reader or bundling a fallback.

---

### Top 5 Ranked by Value Divided by Effort

| Rank | Feature | Value | Effort | Value / Effort Rationale |
|---|---|---|---|---|
| 1 | **Automated Script Guard (`precheck`)** | High | 4h | Minimal code to build; immediately prevents automated scripts from wiping out daily interactive quota. |
| 2 | **Reset Alarm Desktop Notification** | High | 6h | High practical benefit; eliminates forgotten downtime after a quota limit hits. |
| 3 | **Context Bloat Compaction Trigger** | High | 6h | Low effort via prompt hook; directly saves up to 50% of per-turn token burn in long sessions. |
| 4 | **Prompt Cache Warmth Countdown** | High | 8h | Protects users from expensive 100k+ token cache writes caused by slight conversational pauses. |
| 5 | **Reset Flight Planner** | Very High | 10h | Solves the primary daily planning dilemma for Pro and Max coders by predicting task completion feasibility. |

---

### What to Build First and Why

Build the **Reset Flight Planner (Feature 1)** first.

The single biggest source of frustration for Claude Pro and Max developers is getting locked out midway through an edit when code is broken and tests fail. Every daily coder repeatedly faces the question: "I have 18% left and 45 minutes until reset, should I start this feature now or wait?" 

Quotameter already has all the required data locally: past session costs, model mixes, and live reset countdowns. Building this feature transforms quotameter from a passive historical meter into an indispensable decision tool that developers rely on before every major coding session.
