---
name: setup
description: Set up quotameter's status line so Claude Code shows 5-hour and weekly quota use and quotameter records readings during sessions. Use when the user runs /quotameter:setup or asks to show quota in the status line.
---

# quotameter setup

The CLI lives two folders up from this skill's base directory: `<base>/../../bin/quotameter.js`.

1. Read the user's `~/.claude/settings.json`. Look at the `statusLine` setting.
2. Explain what will change and ask for confirmation before editing.
3. If there is no `statusLine`, set:

   ```json
   "statusLine": { "type": "command", "command": "node \"<absolute path to bin/quotameter.js>\" statusline" }
   ```

   If there already is one with a `command`, keep it by wrapping it:

   ```json
   "statusLine": { "type": "command", "command": "node \"<absolute path to bin/quotameter.js>\" statusline --wrap \"<their existing command>\"" }
   ```

   Escape quotes correctly for JSON. Use forward slashes in the path on Windows.
4. Run `node "<base>/../../bin/quotameter.js" doctor` and show the result.
5. Tell the user the status line appears after the next response, and that `/quotameter:report` shows the full report.
