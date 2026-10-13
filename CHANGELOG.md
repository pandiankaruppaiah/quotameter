# Changelog

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
