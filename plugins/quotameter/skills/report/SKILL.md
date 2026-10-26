---
name: report
description: Build and open quotameter's full HTML report of where the user's Claude Pro/Max quota went (5-hour and weekly limits by product, model, subagent, project, session, skill, tool, MCP server, chat share, trends and recommendations). Use when the user runs /quotameter:report or asks for the full report, a breakdown, or an analysis of their usage. For a quick number in the terminal use /quotameter:status instead.
---

# quotameter report

The CLI lives two folders up from this skill's base directory: `<base>/../../bin/quotameter.js`.

1. Build the report and print the short summary:

   ```
   node "<base>/../../bin/quotameter.js" report
   ```

   This reads new log data, takes a free `/usage` reading if the last one is old, writes `~/.quotameter/report.html`, opens it in the browser, and prints a text summary. Show the user the text summary as it is, plus the path to the report. Add `--no-open` if the user said not to open a browser.

2. Only if the user asks for an analysis or a written summary, also do this (it uses a little quota, so do not do it unasked):
   - Use the `quotameter:usage-analyst` agent. Pass it the path `~/.quotameter/summary.json` (expand `~` to the home folder).
   - It returns a JSON array of short findings. Save that array to `~/.quotameter/findings.json`.
   - Re-run: `node "<base>/../../bin/quotameter.js" report --findings "<home>/.quotameter/findings.json"`.

Do not read the user's session logs yourself. Everything you need is in the CLI output or `summary.json`.

If the CLI prints "Poll failed" or "No limit readings yet", tell the user plainly, show the reason, and suggest `node "<base>/../../bin/quotameter.js" doctor`.
