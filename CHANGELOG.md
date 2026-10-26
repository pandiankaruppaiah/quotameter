# Changelog

## 0.3.1 (2026-10-27)

Three fixes from the first day on a Max plan.

- **The Fable window.** Max plans cap Fable and Mythos usage at 50% of the week; `/usage` reports it as a third window. It now appears in `status`, the report (third meter, product stack, a "Fable this week" breakdown), the status line (`fable 42%`), the warnings, the advice, the reset alarm and `precheck --window fable`. It gets its own calibration from Fable-only usage, so no chat guessing is needed there.
- **The status line share is of this window.** It showed "this session 135%" because a session that spans two 5-hour windows carried its whole total. It now shows what the session spent since the current window began (`this window 14%`), remembered in `window-base.json` at each roll-over.
- **Calibration for the status line follows the window in progress.** `k.json` was written only by `status` and `report`, from the median of older windows, and was twice too high for a cache-heavy session. The background ingest now refreshes it every 30 minutes, preferring the current window's own ratio once that window is past 20% and shows no chat.


## 0.3.0 (2026-10-27)

Quota-aware sessions: what quotameter knows now reaches you, and the assistant, while you work. From the innovation brainstorm (docs/reviews/agy-21) and plan review (agy-22).

- **Status line** shows this session's share of the 5-hour window and the context size: `5h 41% (this session 14%, resets 2:50am) | ctx 62% | wk 18%`.
- **Quota-aware assistant:** from `adviseAt` (70%) Claude is told, once per 5% band, to prefer lighter models for routine steps, avoid re-reading large files and keep output short. Not shown to you; nothing is read from your prompt.
- **Context nudge:** once per session past `ctxNudgeAt` (150K tokens), with what each turn now costs and a pointer to `/compact`.
- **Session receipt and weekly digest** at session start, and the cost of rebuilding the cache when resuming after a pause.
- **`quotameter precheck --min 25`** for scripts and CI: exit 0, 1 or 2.
- **What fits before the reset:** quick tasks, typical sessions, heavy ones, and a note when less time is left than a usual session.
- **Reset alarm:** a desktop notification when a limit that reached 95% resets (`resetAlarm`). No daemon; a small process waits and exits.
- **Other computers:** `syncDir` names a folder you already sync; each install writes its usage there and reads the others', so Claude Code on your laptop is "Claude Code on other computers", not chat, and calibration sees the whole account. Nothing identifying crosses and nothing from another computer is written locally.
- **Team digest, zero upload:** `quotameter team export` and `quotameter team report`.
- **File guard:** a `PreToolUse` hook on Read asks before a file over `fileGuardKB` (512 KB) is read, with the size, token estimate and share of the window. It reads the file path only and stores nothing; PRIVACY.md and SECURITY.md say so.
- Hooks run through a lean `bin/hook.js` (about 120 ms) so the file guard does not load the whole CLI on every read. The hooks' `k.json` carries the last calibration so no hook runs an analysis.


## 0.2.0 (2026-10-26)

Readings without effort, answers in the terminal, and numbers you can trust. Driven by a product review (docs/reviews/agy-17) and by the author's own store: 13 days installed, 46 readings, because the status line was never set up.

- `quotameter setup` puts the status line into Claude Code's settings itself: shows the change first (`--dry-run`), keeps a backup, keeps an existing status line (now stored in quotameter's config rather than quoted on the command line), and `--remove` restores it. The installed command is a small launcher in `~/.quotameter` that follows the plugin across updates, so a plugin update no longer breaks the status line.
- New `UserPromptSubmit` hook: a free `/usage` reading every ten minutes while you work, and a one-line warning in Claude Code when a limit passes 80% and again at 95% (`warnAt`, 0 turns it off). It reads nothing from your prompt.
- `quotameter status` and `/quotameter:status`: both limits, the split and sessions left in a few lines, no browser. `/quotameter:report` no longer triggers on every question about tokens.
- Tokens left are fresh tokens (input, output, cache writes). Cache reads are listed but never extrapolated, so a long cached session no longer promises millions of tokens that a fresh session does not have. Chat tokens use the same basis.
- The forecast shows a range when the recent pace and the window average disagree.
- `quotameter mark code-only` tells calibration a window had no chat; the report counts marked windows.
- The MCP tip tells local servers from claude.ai connectors and says where each is turned off.
- A report with no readings yet explains what works and what is missing, instead of showing ten "n/a" cards, and names the poll error if there was one.
- Status line placeholder before the first response is `5h -- | wk --`. On WSL the report opens through `wslview` when present.
- Code: `analyze.js` split into load, windows, breakdown and models modules; one model registry drives names, families and chart colours; the report's script lives in `report.js` with shared formatters in `format.js`, and a test compiles it so a syntax error fails `npm test`. Project names from a store written on Windows read correctly on macOS and Linux.
- `doctor` reports the newest reading and whether the status line is set up. A missing `claude` command is reported as such instead of "unexpected output".


## 0.1.2 (2026-10-14)

Security and privacy review.

- The data folder is now readable only by you on macOS and Linux (0700, files 0600); existing folders are tightened on the next run.
- `redactPaths` also stops storing session titles, which Claude Code writes from your first prompt, and hides titles stored earlier.
- `summary.json`, the only file the optional Haiku summary reads, no longer contains session titles or branch names.
- New `quotameter report --share` writes a copy for screenshots with projects renamed and titles, branches and findings removed.
- `--out` must be an .html file.
- The poll lease is released only by the process that holds it.
- CI runs with read-only permissions and actions pinned to commit SHAs.
- Added SECURITY.md.

## 0.1.1 (2026-10-13)

- Fix: the installed plugin failed to start ("Cannot use import statement outside a module"), so its hooks and commands did nothing. Claude Code installs only the plugin folder, and the setting that marks the code as ES modules lived outside it. The plugin folder now carries its own. A test runs a copy of the folder on its own to keep it that way.

## 0.1.0 (2026-10-13)

First release.

- Claude Code plugin with session hooks, `/quotameter:report`, `/quotameter:setup` and an optional Haiku summary agent. The same code runs as a command-line tool with `npx github:pandiankaruppaiah/quotameter`.
- Reads the 5-hour and weekly limits with Claude Code's free `/usage` command, Claude Code session logs, Claude Code's own session totals, the status line, `/context`, and Claude Desktop's usage history.
- Estimates chat and other-device use from the part of the limit that Claude Code on this computer does not explain.
- Report: meters with forecasts and sessions left; usage by product, model, subagent, project, session, skill, tool, MCP server and plugin; recommendations, a model what-if and a plan verdict; weekly and daily trends; technical details on cache, context and subagents.
- Keeps 90 days of raw data and summarises older days, so history outlives Claude Code's 30-day log cleanup.
- Runs on Windows, macOS and Linux with Node 18 or newer. No dependencies.
