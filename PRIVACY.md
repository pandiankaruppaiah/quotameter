# Privacy

quotameter runs entirely on your computer.

## What it reads

- Claude Code session logs in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). From each response it keeps: message id, time, session id, surface, working folder, git branch, model, subagent name and type, skill name, tool names, token counts and speed.
- The output of `claude -p /usage` and `claude -p /context`, which Claude Code runs locally.
- Claude Desktop's `plan-usage-history.json`, and the last-modified time (not the contents) of Desktop's web storage folders, used as a sign that the Chat tab was in use.
- The JSON Claude Code sends to the status line, if you enable it.

## What it never stores

- Message text, thinking, tool inputs or tool results. Each log line is parsed in memory to pick out the fields above, and the rest is discarded. A test checks that no message text reaches the store.

## What it never opens

- Credentials or OAuth token files, cookies, or the contents of browser storage.

## Where data goes

Into `~/.quotameter` (`%USERPROFILE%\.quotameter` on Windows) as plain JSONL files you can open and inspect. Nothing is uploaded. quotameter makes no network requests of its own. The only network activity is Claude Code itself fetching `/usage`, the same as when you type `/usage`.

## How long it is kept

Raw rows are kept for 90 days (`keepDays`). Older days are summarised and the raw rows deleted. Summaries hold daily token and cost totals by model, project folder name, product, subagent type and skill, and each limit window's peak and estimates. They hold no message text, session titles or session ids, and project names are hashed when `redactPaths` is on.

## Options

- `quotameter config redactPaths true` stores project folders as a short hash and drops branch names.
- Delete `~/.quotameter` to remove all data.

## Optional AI summary

`/quotameter:report` can ask a Haiku subagent to write findings. It reads only `~/.quotameter/summary.json` (aggregated numbers and project and session titles) and runs through your own Claude Code session. It runs only when you ask for an analysis.
