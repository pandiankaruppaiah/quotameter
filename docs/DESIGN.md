# quotameter design

Status: draft for review, Phase 1 (core + Claude Code plugin).

## Problem

Claude Pro and Max have one shared allowance: a rolling 5-hour window and a weekly window. Claude Code, Claude Desktop, claude.ai and the mobile apps all draw from it. Anthropic shows the percentage used, but not what used it. Claude Code logs exact tokens per message; the chat surfaces log nothing locally.

quotameter answers four questions:

1. How much of each window have I used, and will I run out before it resets?
2. Which surface, model, project, session, subagent, skill, tool, MCP server and plugin used it?
3. How much did chat (claude.ai, Desktop Chat, mobile) use, given that it leaves no local logs?
4. What should I change to make the allowance last longer?

## Constraints

- Local only. No telemetry, no cloud sync, no accounts.
- Never read credentials, cookies, OAuth tokens or message text. Only usage metadata.
- Use only data Anthropic exposes to the user: the `claude` CLI and the files it and Claude Desktop write.
- Node 18+, zero runtime dependencies. Works on Windows, macOS and Linux.
- Must not spend quota to measure quota.

## Data sources (all verified on Windows 11, Claude Code 2.1.296, Desktop MSIX)

| Source | What it gives | Cost | Notes |
|---|---|---|---|
| `claude -p "/usage"` | Both windows: `percent`, `resets_at`, `severity`, extra-usage credits | Free (runs locally, `num_turns: 0`) | Writes a `system/local_command` record with `usageReport.rate_limits.limits[]` to the poll's session log. Text output is the fallback. |
| Status line stdin | `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`) | Free | Only while a session is open, only after the first response. |
| `~/.claude/projects/**/*.jsonl` | Exact tokens per message, model, `entrypoint` (`cli`, `claude-desktop`, `sdk`), `cwd`, `gitBranch`, `attributionSkill`, tool calls, session titles | Free | Streamed duplicates: dedupe by `message.id`. Pruned after `cleanupPeriodDays` (default 30), so we copy what we need. |
| `subagents/agent-*.meta.json` | Agent type, name, model, spawn depth | Free | Next to each subagent log. |
| `claude -p "/context"` | Fixed per-session overhead: system tools, each MCP tool, each skill with its `plugin_name` | Free | Run at most once a day. |
| Desktop `plan-usage-history.json` | 5-hour (`fh`) and weekly (`sd`) % samples | Free | Undocumented; read if present, ignore if the format changes. |

| `cost-state` record in each session log | Claude Code's own per-session totals by model: input, output, thinking, cache read and write, cost | Free | Written when a session ends. Authoritative totals. |

### Known gap: the per-message logs undercount

Measured on a finished session (Opus 5.5): the logs summed to 2,977 output, 26 input and 1.75M cache-read tokens. The session's `cost-state` said 3,012 output, 1,544 input and 2.22M cache read, plus 1,195 Haiku input tokens that never appear as messages. Two causes:

1. On turns that call tools, Claude Code writes `usage` as it stood when streaming began (`stop_reason: null`, `output_tokens` often below 10) and never writes the final numbers. Input and cache counts are right; output is not.
2. Background calls (session titles, classifiers) never appear as message records.

So per-message rows give the breakdown, and `cost-state` gives the truth. For each finished session and model, `residual = cost-state totals - summed message rows` is stored as a "Claude Code, not itemised" row so totals match Claude Code's own numbers. Live sessions use the status line's running `cost.total_cost_usd` until `cost-state` arrives. Breakdowns by tool and skill are labelled as based on itemised usage only.

Not used in Phase 1: Desktop Local Storage (LevelDB, near auth data), the OAuth usage endpoint (needs credentials), `/insights` (spends quota).

## Architecture

```
plugins/quotameter/
  .claude-plugin/plugin.json
  bin/quotameter.js    CLI entry (also the npm `bin`)
  lib/ingest/          log scanner, /usage poller, Desktop reader, /context snapshot
  lib/store.js         append-only JSONL files under ~/.quotameter
  lib/model/           pricing and model registry, load, windows (calibration, attribution, forecast), breakdown, insights, retention, redact
  lib/report/          report.js and format.js (the page), render.js (HTML and text), template.html
  lib/statusline.js, lib/setup.js, lib/warn.js   status line, its installer, the prompt hook
  lib/digest.js, lib/guard.js, lib/notify.js      session receipt, file guard, reset alarm
  lib/sync.js, lib/team.js                       other computers, team digest
  bin/hook.js                                    the hooks' lean entry point
  hooks/ skills/ agents/
.claude-plugin/marketplace.json   points at ./plugins/quotameter
package.json                      npm package; "bin" and "files" point into plugins/quotameter
```

Claude Code copies only the plugin folder when it installs from a marketplace, so the library lives inside it. The npm package ships the same folder. One copy of the code, no build step.

### Store (`~/.quotameter`, override with `QUOTAMETER_HOME`)

- `messages.jsonl`: one row per unique assistant message: id, ts, session, entrypoint, model, agent (type, depth) or main, cwd, branch, skill, tools[], token counts by type, list-price cost.
- `readings.jsonl`: one row per limit reading: ts, source, window kind, percent, resets_at.
- `sessions.jsonl`: session id, title, start, end, entrypoint.
- `overhead.jsonl`: daily `/context` snapshot.
- `state.json`: per-log byte offsets for incremental scans.

JSONL keeps it dependency-free and easy to inspect. Expected size: a few MB per month for a heavy user. Rows older than a configurable retention (default 180 days) are compacted into daily aggregates.

### Ingest

- **Logs:** incremental scan from stored offsets. If a file shrinks, rescan it from the start. Change detection uses size and mtime. Keep the last record per `message.id`.
- **Poller:** `claude -p /usage` spawned with an argument array and no shell, so Git Bash path rewriting cannot turn `/usage` into a model call. It runs in `~/.quotameter/poll` so its session logs are easy to exclude, and the poller deletes the session file it just created after parsing.
- **Triggers:**
  - `SessionStart` hook: ingest, and poll if the newest reading is older than 10 minutes. Detached, so session start is not delayed.
  - `Stop` hook: incremental ingest of `transcript_path`.
  - Status line: record `rate_limits` each refresh, rate-limited to one row per minute.
  - Optional OS schedule (`quotameter schedule install`): Task Scheduler on Windows, launchd on macOS, a user crontab on Linux. Every 10 minutes. Opt-in, because it runs when Claude Code is closed.

### Weighting tokens

Limits are percentages, not tokens. To compare a message with a percentage we need a weight. We use the API list price of the message (model price per token type: input, output, cache write 5m and 1h, cache read). Anthropic does not document that limits follow list price, so calibration below absorbs the overall scale and the report labels all derived numbers as estimates.

### Calibration and chat attribution

For each window kind separately (5-hour, weekly):

1. Group readings by window instance (same `resets_at`).
2. For each window instance with at least 5 points of usage, compute `r = percent_used / code_cost` where `code_cost` is the list-price cost of all Claude Code and Desktop agent messages inside the window.
3. Chat can only add to the percentage, never subtract. So the windows with the lowest `r` are the ones with the least hidden chat. Estimate `k` (percent per dollar) as the 20th percentile of `r` over the last 20 windows. Until 5 windows exist, use the minimum and mark the estimate as provisional.
4. Within a window, between consecutive readings: `chat_points = max(0, delta_percent - k * code_cost_in_interval)`. Intervals with no Code activity give all their delta to chat.
5. Readings are whole percentages, so short intervals are noisy. Attribution is reported per window and per day, never per message, and the report shows the calibration error band.

### Forecasts

- Pace: percent per hour over the last 60 minutes (5-hour window) and percent per day over the last 24 hours (weekly), smoothed with an exponential moving average.
- Time to 100%: `(100 - percent) / pace`, compared with `resets_at`. Verdict: "Won't hit before reset" or "Hits limit at HH:MM".
- Tokens left: tokens used in the window / percent x (100 - percent), at the current model mix. Labelled as an estimate.
- Turns left for a model: points left / average points per turn for that model in the last 7 days.

### Breakdowns

Every dimension is a group-by over `messages.jsonl` with points = `k x cost`:

- surface: `entrypoint`
- model, split by main session vs subagent
- subagent: from the subagent path and `meta.json`
- project: `cwd` (folder name) and `gitBranch`
- session: title from `custom-title` / `ai-title` records
- skill: `attributionSkill` (exact)
- tool and MCP server: tool names on each message, cost split evenly across the tools the message called (estimate)
- plugin: skill-to-plugin and MCP-server-to-plugin mapping from the latest `/context` snapshot
- overhead: per-session fixed tokens for each MCP server and plugin from `/context`, flagged when there were zero calls in the period

### How you use your limit (`lib/model/insights.js`)

Derived from the same messages and windows. Each stat falls back to dollars or tokens when its k is not known yet.

- Tokens per week: 6 buckets aligned to the weekly reset. Fresh tokens (input, output, cache writes) apart from cache reads; chat tokens = chat points / k.wk x tokens per dollar.
- Typical session: median and 90th percentile of interactive session cost over 30 days, in points of each window. Sessions left = room left in the 5-hour window / typical session points.
- Unused allowance: finished 5-hour windows in the last 7 days, their average peak, and how many stayed under 25%.
- Which limit stops you: weekly if a weekly window hit 100% or this week projects past it, else 5-hour if one hit, else neither.
- Model what-if: this week's Opus and Fable messages re-priced at Sonnet 5.5 and Haiku 5.5, keeping each session's not-itemised share.
- Prompt cache: cache reads / all input; cache writes as a share of cost; a "rebuild" is a write of 20K+ tokens after a gap longer than the 5 minute cache lifetime in the same thread.
- Subagent overhead: subagent cost against main-conversation cost.
- Limit timing: for 5-hour windows that reached 100%, time from window start to the first 100% reading, and the time left until reset.
- Burn rate: activity split into stretches at 15 minute gaps; points per active hour.
- Context growth: per main conversation, (peak context minus first) / turns to peak, and turns until 100K.
- Projects and branches, daily Code vs chat (Code points use each weekly window's own points per dollar, chat lands on the day its increase was seen), and session length.

### Retention (`lib/model/retention.js`)

The store keeps raw rows for `keepDays` (default 90, at least 35) and summaries forever, so long-term trends survive without the store growing without limit.

- Runs at most once a day at the end of an ingest (inside the lock), or on demand with `quotameter compact`.
- Cutoff is local midnight `keepDays` ago. Only whole days before the cutoff are summarised.
- Summaries are computed with the same code the report uses (merge, reconcile to Claude Code's totals, windows, calibration, attribution), so they carry the inferences, not only raw counts.
- `daily.jsonl`, one row per local day: fresh tokens by type, cache reads, requests, sessions, list cost and reconciled cost, and reconciled cost by model, surface, project (top 20 plus "other"), subagents and Opus/Fable.
- `windows.jsonl`, one row per finished limit window: kind, start, reset, peak %, time it reached 100% (if it did), estimated chat and Code %, and the k used.
- Order: append summaries, record `compactedBefore` in state, then rewrite the raw files without the old rows (temp file and rename). Summaries are de-duplicated on load by day or window key, so a crash between steps cannot double count. Raw rows older than `compactedBefore` are ignored on load and dropped on ingest, so a log rescan cannot bring them back.
- Old `/context` snapshots: only the latest 10 are kept.
- Chat estimates for summarised windows are frozen with the k known at the time.

Long-term views read summaries and raw rows together: tokens per week (12 weeks), weekly limit history (12 weeks), a plan-fit verdict over all history, and an "All history" breakdown range that appears once data spans more than 90 days. The 90-day breakdown range appears once data spans more than 30 days and is labelled with the date the data starts.

### Report

- `quotameter report` writes `~/.quotameter/report.html` (single file, data embedded, no network) and opens it. `--json` prints `summary.json`. `--text` prints a short terminal table.
- Layout follows `docs/sample-report.html`, approved by the project owner. The page script is `lib/report/report.js` plus the formatters in `lib/report/format.js` (shared with the text output); `render.js` embeds both as one inline module script, so `format.js` keeps its exports and a test compiles the result with `node --check`.
- Tokens are quoted as fresh tokens (input, output, cache writes). Cache reads are listed in their own column and never extrapolated into "tokens left"; chat tokens are estimated with fresh tokens per list-price dollar, the same basis. The forecast is shown as a range when the recent pace and the window average differ by 2 points or more.
- With no readings at all the page adds `no-readings` to `body`, which hides the meters, the line chart, the token table, the product stacks and the pattern tiles, and shows one card saying what already works, what needs readings and the poll error if there was one.
- `quotameter status` builds the same summary and prints only the text, with no HTML and no browser.
- `/quotameter:report` runs the CLI, then a Haiku subagent reads `summary.json` (never raw logs) and writes 5 to 8 plain findings into the report. The summary is opt-in per run because it spends quota.

### Status line (`lib/statusline.js`, `lib/setup.js`)

`quotameter statusline` prints e.g. `5h 17% (resets 5:39pm) | wk 3%` and records the reading once a minute (and the session's running cost every 15 seconds) into `live.jsonl`, without the lock. Before the first response it prints `5h -- | wk --`.

`quotameter setup` installs it. The command written to `settings.json` is `node "~/.quotameter/statusline.mjs"`, a launcher, because Claude Code installs each plugin version in a new cache folder and a command pointing at the plugin would break at the next update. The launcher reads `launcher.json` (plugin roots keyed by Claude Code config folder, so `CLAUDE_CONFIG_DIR` profiles do not fight) and imports `lib/statusline.js` from a root whose `package.json` names the plugin. Every hook run refreshes `launcher.json` before doing anything else, so an update heals at the next session start. An existing status line command is kept in `config.json` as `wrapCommands[<config folder>]` and run by `statusline.js` the way Claude Code ran it (through a shell, cut off after 3 seconds, EPIPE ignored when it does not read stdin), which avoids quoting another command inside JSON. `setup` shows the change (`--dry-run`), copies `settings.json` to `settings.json.quotameter.bak` whenever it replaces a status line that is not its own (so the backup is always a state the user made), writes the file through a temp file and rename, treats an empty file as no settings, keeps other keys of the `statusLine` object, and `--remove` puts the previous command back rather than restoring the whole backup. The launcher trusts a root only if it is absolute, owned by the current user where the platform knows, and its `package.json` names the plugin; with several profiles recorded it uses only the matching one.

### During a session (0.3.0)

Everything here reads the store's tails or `k.json` (the calibration the last analysis wrote: h5, wk, model); no hook runs an analysis, and hooks go through `bin/hook.js`, which imports only what they need (about 120 ms end to end).

- **Status line** (`lib/statusline.js`): `5h 41% (this session 14%, resets 2:50am) | ctx 62% | wk 18%`. The session share is `cost.total_cost_usd` times k.h5 (dollars before k exists); context is `context_window.used_percentage`. A per-turn delta was considered and rejected: the status line refreshes per step and on redraws, so deltas are not turns. The 15-second cost row in `live.jsonl` now carries `ctx` and `model`.
- **Advice** (`adviceFor`): from `adviseAt` on the 5-hour window (weekly: 10 more), `additionalContext` tells the assistant quota is tight. Once per 5% band per window (key in `warned.json`), because each injection stays in the context for the rest of the session.
- **Context nudge** (`contextNudge`): once per session past `ctxNudgeAt`, priced as context times the model's cache-read price times k.h5, which is what a turn re-reads. The prompt hook reads nothing, so it cannot know which session asked; it trusts only a status line row less than two minutes old and says "your most recently active session". With two sessions open at once the nudge can name the other one; that is the price of not reading the hook's input.
- **Receipt and digest** (`lib/digest.js`): the session start hook reads `source` and `session_id` from stdin (the id only to leave the starting session out, and a session whose status line wrote a total in the last two minutes is treated as still running); on `startup` it prints the newest finished interactive session's total (from `costs.jsonl`) as a share of the 5-hour window, and once per finished weekly window the peak, sessions, fresh tokens, top project (unless `redactPaths`) and the Sonnet re-price of the Opus work. On `resume` with `prompt_cache_likely_expired`, the cache rebuild cost. Shown through `systemMessage`; remembered in `digest.json`, weeks keyed by the hour of their reset. Two sessions starting in the same second could both show the weekly digest; not worth a lock.
- **What fits** (`fitsText` in `format.js`): `sessionCost.left` gains `quick` (25th percentile); the sentence is shared by the page and the text, caps "quick tasks" at "many", and notes when less time is left than the median session.
- **precheck**: reads the newest reading (polling first unless `--no-poll`), exit 0 when `100 - percent >= min`, 1 otherwise, 2 with no current reading.
- **Reset alarm** (`lib/notify.js`): at 95% the prompt hook spawns `quotameter alarm <resetsAt>` once per window. It sleeps in 30-second steps (so OS sleep is noticed on wake), stays silent if it wakes more than 30 minutes past the reset, and notifies through PowerShell (a NotifyIcon balloon, text passed as arguments), osascript or notify-send, ignoring a missing notifier.
- **Other computers** (`lib/sync.js`): `exportSync` after every ingest writes `<syncDir>/quotameter-<machineId>.json` (a persistent random id in config, so a renamed computer is the same computer) through a temp file and rename. `importSync` on load skips foreign or half-written files, rows more than 5 minutes in the future, and its own file; remote responses join `messages` with `remote: <name>`, hashed session ids, a reconciled total per session in `trueCost`, and readings deduped per kind and minute. Because they are in the cost index, calibration treats them as Code; `attribute` puts them under `bySurface.remote` ("Claude Code on other computers"). Retention loads with `remote: false`, so nothing remote is ever summarised or stored.
- **Team digest** (`lib/team.js`): `teamDigest(summary)` keeps scalars from the 30-day breakdown, insights and overhead; labels are sanitised; `teamReport` prints a markdown table and a waste line per member with each item in its own unit.
- **File guard** (`lib/guard.js`): `PreToolUse` with matcher `Read`; resolves a relative path against the hook's `cwd`, stats the file, and above `fileGuardKB` answers `permissionDecision: ask` with size, tokens (bytes / 4) and the share of the window from the model's input price and k.h5. Missing files and other tools pass.

### Prompt hook (`lib/warn.js`)

`UserPromptSubmit` runs `hook prompt` on every prompt, so it reads the tails (64 KB) of `live.jsonl`, `livelog.jsonl` and `readings.jsonl` for the newest reading per window, with no lock and no analysis. If the newest reading and the newest poll attempt (`poll-attempt.stamp`, touched before every try) are both older than `pollIntervalMin` it detaches an ingest, which polls `/usage` (free, behind the poll lease); so a poll that keeps failing backs off like one that works. The 95 level is dropped when `warnAt` is set above it. If a window whose reset is still ahead is at or past `warnAt` (default 80) or 95, it prints `{"systemMessage": ...}`, which Claude Code shows to the user, plus the same text as `additionalContext` so the assistant can suggest a lighter model. One warning per window and level, remembered in `warned.json` (atomic write; a lost race means at worst a repeated warning). The hook never reads stdin: the prompt is not quotameter's business. A reading's age does not matter for the warning, only that its window has not reset, since the percentage cannot have gone down since.

## Privacy

- Reads only metadata fields; message `content` is touched only to collect tool names. Text is never stored.
- Never opens `.credentials.json`, cookies, Local Storage or IndexedDB.
- No network calls of its own. The only network activity is the `claude` CLI fetching `/usage`, which is what the user's own Claude Code does.

## Testing

- `node:test` with fixtures built from real logs on Windows and macOS, with all text fields replaced.
- Fixtures cover: streamed duplicate records, subagent logs, Desktop `claude-desktop` sessions, a window reset between readings, missing `rate_limits`, unknown models, and a malformed line.
- CI matrix: Windows, macOS, Ubuntu on Node 18, 20, 22.

## Open questions for review

1. Is list-price cost a sound weight, or should cache reads be weighted differently?
2. Is the 20th-percentile `k` robust enough when the user chats a lot every window?
3. Any risk in deleting the poller's own session files?
4. Is a 10-minute poll interval reasonable, or wasteful?
5. JSONL vs SQLite (`node:sqlite` needs Node 22.5+).

## Review log

### agy review 01 (2026-10-13), full text in `docs/reviews/agy-01-design.md`

| # | Finding | Decision |
|---|---|---|
| 1 | Streamed duplicates can be stored across scans | Accepted. The loader merges rows by message id (final record, highest output). |
| 2 | `cost-state` reconciliation not implemented | Accepted. Implemented in the scanner and analysis. |
| 3 | Unknown models price as null | Partly. Unknown models fall back to their family's price and are flagged. Claude 3.x models are retired and age out of 30-day logs, so they are not added. |
| 4, 9 | 24/7 OS polling | Accepted. Default is reactive: poll on `SessionStart`, on report, and from the status line when the last reading is stale. The OS schedule stays opt-in. The poller never uses a shell, so path rewriting cannot happen. |
| 5 | Lock without ownership, rename on Windows | Accepted. Lock carries pid and token; rename retries on `EPERM`/`EBUSY`; appends happen under the lock. |
| 6 | Percentile `k` contaminated by regular chat | Partly. Prefer windows with no Desktop or browser activity; users can mark a window as "Code only"; otherwise fall back to a low percentile over a long history. |
| 7 | List price may not match how limits are counted | Partly. List price is the starting weight. Once 20+ windows exist, fit per-token-type weights to the user's own data (v0.2). |
| 8 | Deleting the poller's session file right away | Accepted. Poll logs are cleaned up after 24 hours instead. |
| 10 | Move to SQLite on Node 22 | Rejected for v0.1. Many Claude Code users have no Node 22; data volume is small; the status line never aggregates. Revisit if the store grows past 50 MB. |
| 11 | Division by zero, jumpy forecasts | Accepted. Guard 0%, smooth pace, show ranges. |
| 12 | MSIX folder pattern, inode wording | Accepted. Broader pattern; change detection uses size and mtime only. |
| 13 | Session start/end, whole-file reads | Accepted. Sessions get start, end, entrypoint. Logs are read in 8 MB chunks. |
| 14 | Equal split across tools | Deferred to v0.2: weight tools by the size of their results. |
| 15 | Project paths and branches stored in plain text | Accepted. `--redact-paths` setting; tests assert message text is never stored. |

### agy review 02 (2026-10-13), full text in `docs/reviews/agy-02-code.md`

| # | Finding | Decision |
|---|---|---|
| 1 | `cmd /c start` can run commands from a path containing `&` | Accepted. Windows opens the report with `explorer.exe`, no shell. |
| 2 | hooks.json nesting "malformed" | Rejected. `{ "hooks": [ ... ] }` groups are Claude Code's documented format; `claude plugin validate` passes. |
| 3 | Hooks block reading stdin | Accepted. Hooks no longer read stdin; the status line refuses to run on a TTY. |
| 4 | MSIX folder pattern | Partly. The real folder is `Claude_<id>`; the pattern now also accepts a publisher prefix. |
| 5 | Two hooks can poll at once | Accepted. A poll lease lets only one run. |
| 6 | Stale-lock clearing can race | Accepted. A stale lock is renamed before deletion, so only one process wins. |
| 7 | Tokens left is 0 when the window has no Code activity | Accepted. Falls back to the 30-day tokens-per-dollar rate. |
| 8 | Old model names group under "3" | Accepted. Families are matched by keyword. |
| 9 | A pause sets pace to 0 and hides a coming limit | Accepted. A zero recent slope falls back to the window average. |
| 10 | `QUOTAMETER_CLAUDE_BIN` pointing at a `.cmd` file | Accepted. Quoted, with the `cmd.exe` fallback. |
| 11 | A multi-byte character across an 8 MB chunk shifts the offset | Accepted. Lines are split on bytes before decoding; test added. |
| 12 | Sessions with a total but no response records are dropped | Accepted. They count as not itemised. |
| 13 | Poll log folder name | Partly. The old rule matched observed folders; now uses Claude Code's rule (every non-alphanumeric character becomes `-`). |
| 14 | No Content-Security-Policy | Accepted. The report cannot load anything from the network. |
| 15 | Usage before the first reading counts as chat | Partly. The logic is right (this computer's Code logs are complete), but the bucket also includes Claude Code on other computers, so it is now labelled "chat and other devices". |
| 16 | Status line throttle drops cost rows | Accepted. Readings and costs are throttled separately. |
| 17 | PRIVACY.md said "never reads" | Accepted. Now "never stores", with how parsing works. |
| 18 | Plan value reads like money saved | Accepted. Labelled as a measure of usage. |

### agy review 03 (2026-10-13), full text in `docs/reviews/agy-03-verify.md`

Verified 14 fixes as correct and agreed that rejecting finding 2 (hooks format) was right. New issues found and fixed: residual sessions double counted in model rows (test added), relative `--out` path with `explorer.exe`, pace label during pauses, `NaN%` in the status line, residual rows counted as requests, and the old "chat" label in the terminal summary. Still open by choice: the status line reads stdin synchronously, which is fine because Claude Code closes stdin after writing.

### agy brainstorm 04 (2026-10-13), full text in `docs/reviews/agy-04-stats-brainstorm.md`

agy proposed 22 stats. Built: tokens per week, sessions left, typical session cost, cache hit ratio and rebuilds, subagent overhead, model what-if, burn rate, time to limit, context growth, projects and branches, daily chat vs Code, session length. Added by us: unused allowance and which limit stops you. Not built: chat conversation counts and Desktop vs web chat (no local data), generation speed (not about quota), weekly headroom and reset countdown (already in the meters and forecast).

### agy review 05 and verification 06 (2026-10-13), full text in `docs/reviews/agy-05-insights-review.md` and `agy-06-insights-verify.md`

7 findings, all accepted: daily chart decided points from Code activity instead of weekly coverage (chat-only days lost), "n/a%" text, what-if subtitle claimed points before calibration, "of 5 hours" read as time, weekly bucket match too strict (now 12 hours), inconsistent keys in the subagent early return, and no weekly readings in the insights test. agy verified all 7 fixed and found no new problems.

### agy review 07 (2026-10-13), full text in `docs/reviews/agy-07-wording-review.md`

The owner found "points" confusing, so the report now says "% of 5-hour limit", "% of weekly limit", or for 30 days "% of a weekly limit, summed across weeks". The weekly token chart keeps empty weeks, labels bars as date ranges, and notes when history starts. agy found 12 issues, all accepted: a leftover unit string in summary.json, "same point" wording, the project table missing `cost` before calibration (showed n/a), unlabelled limits in the text summary and two tooltips, the 30-day sum needing a 100% = one week explanation, a stale note when every week is empty, crowded range labels (now "8-14 Oct"), a daylight-saving off-by-one in the range end (now calendar arithmetic), and the current empty week reading as missing data.

### agy UX review 08 (2026-10-13), full text in `docs/reviews/agy-08-ux-review.md`

Built: meters with a plain sentence at the top and the token table behind a "Details" toggle; sections ordered Right now, What used your limit, Make it last longer, Your patterns, Technical details (collapsed); duplicates removed (per-day weekly chart, projects-and-branches table, forecast table, history tiles); "Your weeks" chart with % of limit, fresh tokens and with-cache-reads modes; calibration banner replaced by an "early estimate" tag; empty subagent card and early heatmap hidden; range switch labelled "Breakdown for"; two-line day labels; tap tooltips, chart labels for screen readers, darker muted text; plan verdict beside plan value; the status line chip says how to turn it on. Declined: drawing only weeks with data (the owner was confused by a lone bar), charting weeks only in % (the owner asked for tokens). Not yet built: card layout for wide tables on phones; the wide tables already scroll inside their card.

### agy retention design review 09 and code review 10 (2026-10-13), full text in `docs/reviews/agy-09-retention-design.md` and `agy-10-retention-ux-code.md`

Design: accepted 1 to 7 (prune costs and sessions with messages, drain live.jsonl under the lock instead of rewriting it, retrying rename, weekly totals on window summaries, limited dimensions for all history, UTC days, no titles or ids in summaries). Declined 8 (monthly files): it changes every reader for little gain. Added: whole sessions only, so a session spanning the cutoff is never split.

Code: accepted 8 of 9. Summaries now carry a batch id that only counts once state.json records it, reset times are rounded the same way everywhere and live and archived windows are de-duplicated, archived weeks use their own totals, drains have unique names and leftovers are recovered, `compact` drains first, summaries respect redactPaths, and wording fixes. Partly declined 6: the long range appears after 30 days of data but is labelled "Since <date>" until it covers 90 days.

### agy verification 11 (2026-10-13), full text in `docs/reviews/agy-11-retention-verify.md`

7 of 9 confirmed fixed. Follow-ups fixed: plan-fit de-duplication now keys on window kind and reset time; "in now" on reopened old reports now reads "already reset". The owner asked to see the 90-day view from day one, so it is always offered; when the store holds less than 90 days the note above it says how many days it covers instead of "Last 90 days", which also settles agy's labelling concerns.

### Demo data, a chat-estimate fix, and agy docs review 12 (2026-10-13)

`scripts/demo.js` writes seven weeks of synthetic usage and builds the report with real logs, Desktop data and the `claude` command switched off (`QUOTAMETER_DESKTOP_DIR` was added for this; the tests set it too). The README screenshot and `docs/sample-report.html` come from it.

The demo exposed a bias: readings are whole percents, and chat was computed per step as max(0, increase - k x cost), so rounding noise only ever went into chat. Busy steps are now netted over the whole window; idle increases still count as chat directly. A test covers it.

agy reviewed the README, PRIVACY, CHANGELOG, CONTRIBUTING, manifests and the draft GitHub profile. Accepted: a missing Windows backslash, PowerShell syntax for the demo, slash-command forms for update and uninstall, the Windows report path, neutral wording, and a real bug (`quotameter config plan` with no value cleared the setting; it now shows it). Profile: tone and placeholders accepted; "AI Tech Lead" kept because the owner gave that role.

### agy profile review 13 (2026-10-13), full text in `docs/reviews/agy-13-profile-review.md`

The GitHub profile README now claims only what quotameter shows (Claude Code plugins, skills, hooks, subagents, MCP, cost engineering, tests and multi-model review) plus the role the owner gave (AI Tech Lead). Removed: Claude Agent SDK, Claude API, eval graders, "running AI in production", and the "any of my repositories" line. Points 6 to 9 referred to an earlier draft of the setup guide that had already been replaced.

### agy innovation brainstorm 21 and 0.3.0 plan review 22 (2026-10-26), full text in `docs/reviews/agy-21-innovation-brainstorm.md` and `agy-22-plan-review.md`

Brainstorm 21 gave 14 ideas; nine were built as 0.3.0 (see "During a session" above), chosen for value over effort: the assistant made quota-aware without reading the prompt, session share and context in the status line, receipt and digest, precheck, what fits, the reset alarm, other computers through a synced folder, the team digest, and the file guard. Declined: a SQLite store (Node 22 only; the floor is 18), a model router that inspects prompt text (privacy), auto-editing MCP configs, branch budgets (later, if asked), a subagent tree view and a cache countdown in the status line (the line only refreshes on events).

Plan review 22 changed five things before any code was written: advice once per 5% band instead of every prompt (each injection stays in the context); the alarm sleeps in 30-second steps and stays silent when it wakes long after the reset; hooks run through a lean entry point so the file guard never loads the whole CLI; a persistent machine id instead of the hostname; readings from two machines deduped per minute. Its claim that a SessionStart `systemMessage` is not shown was checked against the hooks reference, which lists the events that discard it and does not include SessionStart; the receipt is shown that way. Its point about a per-turn cost delta is why the status line shows the session share instead.

Code review 23 (`docs/reviews/agy-23-code-review.md`) found 14 issues, all taken: sessions-left division by zero when a quarter of sessions cost nothing, a null status line input, the file guard on directories, one pass over messages at session start, no receipt for a session still running, a freshness guard and plain wording for the context nudge, a newer sync schema reported instead of silently dropped (status and doctor say so), our own sync file never imported, weekly digests keyed by the hour, launcher refresh kept off the Read path, warnings kept out of the assistant's context, a test that now covers promptHook, and two wording fixes in README and SECURITY. Verification 24 (`docs/reviews/agy-24-code-verify.md`) confirmed them and added three follow-ups, fixed: live.jsonl read once at session start, the CLI's `hook` command now hands over to hook.js instead of carrying a second copy, and the weekly sessions-left divisor guarded. Accepted as trade-offs: the receipt reads the whole message file once (about 10 ms per MB), and the context nudge cannot know which of two open sessions asked.

### agy product review 17 and 0.2.0 plan review 18 (2026-10-26), full text in `docs/reviews/agy-17-product-review.md` and `agy-18-plan-review.md`

Review 17 asked what would make quotameter a plugin people keep. Its top findings, with the author's own store as evidence (13 days installed, 46 readings, status line never set up): readings arrive only if the optional status line is set up and that step is an LLM editing JSON; every question about tokens opened a browser; nothing warns before a limit; "tokens left" extrapolated cache reads; the first report was a page of "n/a". Shipped in 0.2.0: `setup` as a command with a launcher that survives plugin updates, `status`, the prompt hook (poll every 10 minutes while active, warn at 80 and 95), fresh-token accounting, the forecast range, `mark code-only`, the MCP tip split into local servers and claude.ai connectors, the onboarding card, the module split, one model registry and the page script under test. Declined: dropping retention (tested and the reason the 90-day view exists), dropping the plan value card (reworded instead), an in-report "mark code-only" button (a static file cannot run commands; the calibration line names the command), a new weighting formula (nothing better exists until Anthropic documents the limits), an export command (`report --share --text` and `--json` cover it). The heatmap moved into Technical details rather than being removed.

Review 18 checked the plan. Accepted: the launcher imports only from a root whose `package.json` names the plugin; roots are keyed by Claude Code config folder; the backup is taken before every change (not once) and `--remove` restores the entry surgically; the page runs as an inline module script instead of stripping `export` with a regex; a Windows-path test and a platform-neutral `folderName`. Confirmed: `systemMessage` with exit 0 is shown to the user; the background poll spends no quota and cannot loop (poll lease). Code review 19 (`docs/reviews/agy-19-code-review.md`) found 14 issues, all taken: EPIPE and a timeout on the wrapped command, back-off after failed polls, `warnAt` above 95, normalised launcher keys with no fallback across profiles, per-profile wrapped commands, fresh tokens in every row that sits beside the chat row, a stronger launcher trust check, an empty `settings.json`, atomic settings writes, the backup rule above, skill wording, and two tests that did not test what they claimed. Verification 20 (`docs/reviews/agy-20-code-verify.md`) confirmed all 14 and found three follow-ups, fixed: the wrapped-command lookup now resolves the profile path the way setup stores it, the settings.json rename retries on Windows and removes its temp file on failure, and a wrapped command that times out is killed with its whole process tree. Declined: draining stdin in the prompt hook (the existing hooks have never read it and Claude Code copes; the privacy claim is worth more), a visible diagnostic for a missing `node` (the hook itself cannot run without it; the README and the skills cover it), caching the Windows `claude.cmd` resolution (one extra spawn per poll, in the background).

### agy security and privacy review 15 (2026-10-14), full text in `docs/reviews/agy-15-security.md`

All 8 findings accepted. The store is now 0700 with 0600 files on macOS and Linux. `redactPaths` also drops session titles (Claude Code writes them from the first prompt) and hides ones stored earlier. `summary.json`, read by the optional Haiku summary, has no titles or branch names. `--out` must be .html. The poll lease is released only by its holder. CI has read-only permissions and SHA-pinned actions. The sample timezone in a comment and a test is now UTC. Added: `report --share` for screenshots (projects renamed; titles, branches and findings removed) and SECURITY.md. Confirmed fine: no dependencies, no message text stored, no credentials opened, report escaping and CSP, `claude` spawned without a shell, hooks detach at once.

agy verification 16: 7 of 8 fixed; the `--wrap` shell is inherent (Claude Code runs status line commands through a shell) and is now documented in the setup skill. Follow-ups fixed: `--share` now also applies to `--json` and `--text`, the poll folder is created 0700, and lock owner files are 0600.
