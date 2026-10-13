---
name: report
description: Show where the user's Claude Pro/Max quota went (5-hour and weekly limits, models, subagents, projects, skills, tools, MCP servers, chat share) and forecast when they will hit the limit. Use when the user asks about their Claude usage, limits, quota, tokens left, or runs /quotameter:report.
---

# quotameter report

The CLI lives two folders up from this skill's base directory: `<base>/../../bin/quotameter.js`.

1. Build the report and print the short summary:

   ```
   node "<base>/../../bin/quotameter.js" report
   ```

   This reads new log data, takes a free `/usage` reading if the last one is old, writes `~/.quotameter/report.html`, opens it in the browser, and prints a text summary. Show the user the text summary as it is, plus the path to the report.

2. Only if the user asks for an analysis or a written summary, also do this (it uses a little quota, so do not do it unasked):
   - Use the `quotameter:usage-analyst` agent. Pass it the path `~/.quotameter/summary.json` (expand `~` to the home folder).
   - It returns a JSON array of short findings. Save that array to `~/.quotameter/findings.json`.
   - Re-run: `node "<base>/../../bin/quotameter.js" report --findings "<home>/.quotameter/findings.json"`.

Do not read the user's session logs yourself. Everything you need is in the CLI output or `summary.json`.

If the CLI prints "Poll failed", tell the user plainly and suggest `node "<base>/../../bin/quotameter.js" doctor`.
