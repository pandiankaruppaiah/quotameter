---
name: status
description: Quick answer in the terminal about the user's Claude Pro/Max limits. Use when the user asks how much quota or how many tokens they have left, when the 5-hour or weekly limit resets, whether they will hit the limit, how many sessions fit, or runs /quotameter:status. No browser opens. For the full report use /quotameter:report.
---

# quotameter status

The CLI lives two folders up from this skill's base directory: `<base>/../../bin/quotameter.js`.

Run:

```
node "<base>/../../bin/quotameter.js" status
```

It reads new log data, takes a free `/usage` reading only if the last one is older than ten minutes, and prints a short summary. Show the output to the user as it is; do not reword the numbers. If they want to know more, mention `/quotameter:report` for the full page.

If it prints "No limit readings yet", show the reason it gives and the command it suggests. If `node` is not found, tell the user to install Node 18 or newer (see the README's Requirements) and restart Claude Code. Do not read the user's session logs yourself.
