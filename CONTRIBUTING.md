# Contributing

Thanks for helping. A few rules keep quotameter trustworthy.

## Ground rules

- **No real data in the repository.** Tests and the demo generate their data. Never paste real session logs, store files or reports into an issue or a pull request; they contain your project names and session titles.
- **No message text, ever.** quotameter reads token counts and metadata. A change that would store prompt or response text will not be merged. `test/quotameter.test.js` checks this.
- **No network calls.** quotameter talks only to the local `claude` command.
- **No dependencies.** Node's standard library only, so it installs anywhere Claude Code runs.
- **Plain wording.** No em dashes, no hype. A test checks for em dashes in shipped files.

## Working on it

```
npm test                                          # the full suite
node plugins/quotameter/bin/quotameter.js doctor  # what it finds on your machine
```

A full report from synthetic data, in an empty folder:

```
# macOS and Linux
QUOTAMETER_HOME=/tmp/qm-demo node scripts/demo.js

# Windows PowerShell
$env:QUOTAMETER_HOME = "$env:TEMP\qm-demo"; node scripts/demo.js
```

To try your working copy as a plugin, add the folder as a local marketplace: `claude plugin marketplace add ./` from the repository root, then `claude plugin install quotameter@quotameter`.

`QUOTAMETER_HOME`, `CLAUDE_CONFIG_DIR`, `QUOTAMETER_DESKTOP_DIR` and `QUOTAMETER_CLAUDE_BIN` point quotameter at test folders, so you can work without touching your real data.

The design, every formula and the review history are in [docs/DESIGN.md](docs/DESIGN.md). If you change how something is counted, update that file in the same pull request.

## Reporting a problem

Include the output of `quotameter doctor`, your operating system and Node version, and what you expected. Leave out store files and reports.
