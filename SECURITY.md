# Security

## Reporting a problem

Please report security or privacy issues privately, through GitHub's **Report a vulnerability** button on the repository's Security tab, rather than in a public issue. Include what you found, how to reproduce it, and which version you used. You will get a reply within a week.

Do not attach your `~/.quotameter` files, reports or Claude Code logs; they contain your project names and session titles.

## What quotameter is designed to do and not do

- Runs locally. No network requests of its own, no telemetry, no dependencies.
- Reads Claude Code's logs and keeps token counts and metadata; never stores message text, thinking, tool inputs or tool results.
- Never opens credentials, OAuth tokens, cookies or browser storage contents.
- Starts the `claude` command with fixed arguments and without a shell, the system's own file opener for the report, and for the reset alarm the system's notifier (PowerShell, osascript or notify-send) with fixed text passed as arguments. If you already had a status line command, `quotameter setup` keeps it in quotameter's config and runs it the way Claude Code did, through a shell; quotameter never adds a command of its own.
- Outside `~/.quotameter`, quotameter writes only where you told it to: `quotameter setup` writes the `statusLine` entry in Claude Code's `settings.json`, after showing you the change and taking a backup. The status line launcher it installs imports code only from a folder whose `package.json` names this plugin.
- Hooks never read your prompt. The session start hook reads the event type, and the file guard reads the file path of a Read call to check its size; nothing from either is stored. The prompt hook never reads its input at all.
- With `syncDir` set, every ingest also writes this computer's usage file into that folder of yours, and `team export` writes a digest where you say. Both are described in PRIVACY.md.
- Keeps its data readable only by you on macOS and Linux.

See [PRIVACY.md](PRIVACY.md) for exactly what is read and kept.
