### Verification of Security Findings ([docs/reviews/agy-15-security.md](../../docs/reviews/agy-15-security.md))

1. **Store directory and file permissions**: **Fixed**.
   - [`storePath`](../../plugins/quotameter/lib/store.js#L31-L41) creates the directory with `mode: 0o700` and tightens existing folders via `fs.chmodSync(dir, 0o700)` on non-Windows platforms.
   - `PRIVATE` (`{ mode: 0o600 }`) is applied on writes in [`store.js:47, 98, 134`](../../plugins/quotameter/lib/store.js#L47), [`config.js:24`](../../plugins/quotameter/lib/config.js#L24), [`statusline.js:19`](../../plugins/quotameter/lib/statusline.js#L19), and [`quotameter.js:110, 120`](../../plugins/quotameter/bin/quotameter.js#L110).

2. **Session titles stored and unredacted by `redactPaths`**: **Fixed**.
   - [`scanFile`](../../plugins/quotameter/lib/ingest/logs.js#L200-L204) skips storing `customTitle` and `aiTitle` when `opts.redactPaths` is true.
   - [`analyze()`](../../plugins/quotameter/lib/model/analyze.js#L457-L462) strips pre-existing titles from loaded sessions when `config.redactPaths` is enabled.
   - [`PRIVACY.md:7-8, 37`](../../PRIVACY.md#L7-L8) documents title collection and redaction behavior.

3. **Haiku summary agent receives session titles and branch names**: **Fixed**.
   - [`summary.json`](../../plugins/quotameter/bin/quotameter.js#L110) is filtered with [`redact()`](../../plugins/quotameter/lib/model/redact.js#L15-L38), which scrubs branch names, replaces session titles with generic placeholders ("Session 1", etc.), and drops `longestTitle`.
   - [`PRIVACY.md:40-43`](../../PRIVACY.md#L40-L43) clarifies what `summary.json` provides to the model.

4. **Arbitrary file overwrite and execution via `--out`**: **Fixed**.
   - [`bin/quotameter.js:115-119`](../../plugins/quotameter/bin/quotameter.js#L115-L119) verifies `--out` strictly matches `/\.html?$/i` before writing.
   - [`openFile()`](../../plugins/quotameter/bin/quotameter.js#L56-L57) spawns platform openers with argument arrays directly, avoiding shell evaluation.

5. **Shell command execution in statusline `--wrap`**: **Partly**.
   - [`statusline.js:54`](../../plugins/quotameter/lib/statusline.js#L54) still invokes `spawn(cmd, { shell: true })`.
   - [`setup/SKILL.md:21-24`](../../plugins/quotameter/skills/setup/SKILL.md#L21-L24) mentions JSON quote escaping but does not document shell escaping requirements or risks.
   - [`SECURITY.md:14`](../../SECURITY.md#L14) briefly notes that `--wrap` runs the configured command, but no direct execution without shell was implemented.

6. **Race condition in `tryLease` release callback**: **Fixed**.
   - [`tryLease()`](../../plugins/quotameter/lib/store.js#L187-L208) writes a unique owner token (`${process.pid}-${crypto.randomUUID()}`) to `<lease>/owner`.
   - The release callback verifies token match before removing the lease directory.

7. **GitHub Actions workflow least-privilege permissions and SHA pinning**: **Fixed**.
   - [`.github/workflows/test.yml:5-6`](../../.github/workflows/test.yml#L5-L6) adds top-level `permissions: contents: read`.
   - [`.github/workflows/test.yml:18, 21`](../../.github/workflows/test.yml#L18) pins `actions/checkout` and `actions/setup-node` to full commit SHAs.

8. **Author location disclosed in comments and tests**: **Fixed**.
   - Replaced `Australia/Sydney` with generic `UTC` in [`usage-poll.js:51-52`](../../plugins/quotameter/lib/ingest/usage-poll.js#L51-L52) and [`test/quotameter.test.js:110`](../../test/quotameter.test.js#L110).

---

### New Problems Identified

1. **`--share` ignored when `--json` flag is provided**:
   - [`bin/quotameter.js:111`](../../plugins/quotameter/bin/quotameter.js#L111) returns `JSON.stringify(summary, null, 2)` directly before evaluating `const share = flag('share')` on line 113. Running `quotameter report --share --json` prints unredacted project names, branches, and session titles.

2. **Unrestricted folder permissions during standalone poll command**:
   - [`usage-poll.js:109`](../../plugins/quotameter/lib/ingest/usage-poll.js#L109) calls `fs.mkdirSync(cwd, { recursive: true })` for `pollDir()` without `{ mode: 0o700 }`. If `quotameter poll` or `quotameter context` runs on a fresh machine prior to any `storePath()` call, `~/.quotameter` is initially created with default umask permissions (0755).

3. **Lock and lease owner files written with default umask**:
   - [`store.js:156`](../../plugins/quotameter/lib/store.js#L156) and [`store.js:203`](../../plugins/quotameter/lib/store.js#L203) call `fs.writeFileSync()` on `owner` token files without passing `PRIVATE` (`mode: 0o600`), relying entirely on directory traversal limits.
