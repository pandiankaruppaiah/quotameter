---
name: setup
description: Set up quotameter's status line so Claude Code shows 5-hour and weekly quota use and quotameter records readings during sessions. Use when the user runs /quotameter:setup or asks to show quota in the status line. Also handles removal (/quotameter:setup remove).
---

# quotameter setup

The CLI lives two folders up from this skill's base directory: `<base>/../../bin/quotameter.js`.

1. Show what would change, without changing anything:

   ```
   node "<base>/../../bin/quotameter.js" setup --dry-run
   ```

   Show the user that output: the settings file, the backup (a copy of their settings as they are before quotameter touches the status line), and the `statusLine` entry before and after. If the user already has a status line command, it is kept and run first; quotameter's line is appended after it.

2. Ask the user to confirm. Then run:

   ```
   node "<base>/../../bin/quotameter.js" setup
   ```

   If the user asked to remove it, run `setup --remove` instead; it restores their previous status line command.

3. Run `node "<base>/../../bin/quotameter.js" doctor` and show the result.

4. Tell the user the status line appears after the next response, that it records a reading every minute while Claude Code is open, and that `/quotameter:status` answers quick questions while `/quotameter:report` shows the full report.

Do not edit `settings.json` yourself. The command does it, keeps a backup, and installs a launcher that survives plugin updates. If `node` is not found, tell the user to install Node 18 or newer (see the README's Requirements) and restart Claude Code.
