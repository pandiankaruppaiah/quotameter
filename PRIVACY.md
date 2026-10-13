# Privacy

quotameter runs entirely on your computer.

## What it reads and keeps

- Claude Code session logs in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). From each response it keeps: message id, time, session id, product (CLI, Desktop, headless), working folder, git branch, model, subagent name and type, skill name, tool names, token counts and speed.
- **Session titles.** Claude Code writes a short title for each session, usually from your first prompt, so a title can contain words you typed. quotameter keeps it to name sessions in your report. `redactPaths` turns this off.
- The output of `claude -p /usage` and `claude -p /context`, which Claude Code runs locally.
- Claude Desktop's `plan-usage-history.json`, and the last-modified time (not the contents) of Desktop's web storage folders, used as a sign that the Chat tab was in use.
- The JSON Claude Code sends to the status line, if you enable it.

## What it never stores

- Message text, thinking, tool inputs or tool results. Each log line is parsed in memory to pick out the fields above, and the rest is discarded. A test checks that no message text reaches the store.

## What it never opens

- Credentials or OAuth token files, cookies, or the contents of browser storage.

## Where data goes

Into `~/.quotameter` (`%USERPROFILE%\.quotameter` on Windows) as plain JSONL files you can open and inspect. On macOS and Linux the folder is readable only by you (0700, files 0600); on Windows it sits in your user profile, which is already private.

Nothing is uploaded. quotameter makes no network requests of its own. The only network activity is Claude Code itself fetching `/usage`, the same as when you type `/usage`.

## How long it is kept

Raw rows are kept for 90 days (`keepDays`). Older days are summarised and the raw rows deleted. Summaries hold daily token and cost totals by model, project folder name, product, subagent type and skill, and each limit window's peak and estimates. They hold no message text, session titles or session ids, and project names are hashed when `redactPaths` is on.

## Sharing a report

`report.html` shows your project names, branches and session titles, so check it before you share it. `quotameter report --share` writes `report-share.html` with projects renamed to "Project 1", "Project 2", and branches, session titles and Claude's written findings removed. Use that one for screenshots and posts.

## Options

- `quotameter config redactPaths true` stores project folders as a short hash and stops storing branch names and session titles. Titles stored before you turned it on are hidden in the report as well.
- Delete `~/.quotameter` to remove all data.

## Optional AI summary

`/quotameter:report` can ask a Haiku subagent to write findings. It runs through your own Claude Code session, only when you ask for an analysis, and reads only `~/.quotameter/summary.json`. That file holds aggregated numbers, project names, model, tool, skill and MCP server names. Session titles and branch names are removed from it.
