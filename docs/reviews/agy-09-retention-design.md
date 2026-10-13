### 1. MUST: Residual Cost Explosion and Double Counting on Compaction

* **Issue**: In [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L70-L96), `reconcile()` compares `costs.jsonl` with `messages.jsonl`. For any session in `costs.jsonl` that has no rows in `messages.jsonl`, it synthesizes a `residual:${session}` row carrying the full session cost. If compaction deletes messages older than 90 days from `messages.jsonl` but leaves `costs.jsonl` untouched, all pruned historical sessions appear as non-itemized residuals. When long-term views combine `daily.jsonl` with raw data, those sessions are counted twice: once in `daily.jsonl` and once as synthetic residuals.
* **Why it matters**: Historical token and cost totals will double or triple across long-term views.
* **Concrete Fix**: Prune `costs.jsonl` and `sessions.jsonl` at the exact same cutoff timestamp as `messages.jsonl`. In `loadData()`, ignore all raw records where `t < state.compactedBefore`. In `scanAll()`, drop scanned records older than `compactedBefore` so rescans cannot reinsert purged sessions. Deduplicate `daily.jsonl` by `day` and `windows.jsonl` by `kind + resetsAt` when reading.

---

### 2. MUST: Status Line Data Loss During Raw File Rewrite (`live.jsonl`)

* **Issue**: [statusline.js](../../plugins/quotameter/lib/statusline.js#L25-L39) writes readings and costs directly to `live.jsonl` without acquiring `withLock`. Readings from the status line exist only in `live.jsonl` and are never copied to `readings.jsonl`. If retention attempts to rewrite `live.jsonl` via temp file and rename, any status line append that occurs between reading and renaming will be destroyed. If retention ignores `live.jsonl`, it grows without limit.
* **Why it matters**: Status line readings are permanently lost, and Windows file handles held by `statusline.js` will trigger `EPERM` during rename.
* **Concrete Fix**: Never rewrite `live.jsonl` during retention. Instead, have `ingest()` (which runs under `withLock`) periodically drain `live.jsonl`: rename `live.jsonl` to `live.drain.jsonl`, append its readings to `readings.jsonl` and costs to `costs.jsonl`, and delete `live.drain.jsonl`. A concurrent status line invocation immediately creates a fresh `live.jsonl`. Retention then compacts only lock-protected files.

---

### 3. MUST: Windows File Locking (`EPERM`/`EBUSY`) During Atomic Rename

* **Issue**: On Windows NTFS, `fs.renameSync` fails with `EPERM` or `EBUSY` if the destination file is open by any process (such as a concurrent `quotameter report`, background scanner, or user editor). While [store.js](../../plugins/quotameter/lib/store.js#L63-L78) provides `writeJsonAtomic` for JSON files, there is no atomic replacement function for JSONL files.
* **Why it matters**: Compaction crashes midway through rewriting raw files on Windows, leaving orphaned `.tmp` files and an inconsistent store.
* **Concrete Fix**: Add a reusable `replaceFileAtomic(targetPath, tmpPath)` helper in [store.js](../../plugins/quotameter/lib/store.js) with exponential backoff retrying on `EPERM`, `EBUSY`, and `EACCES`. Write new raw files to temp files first, rename them into place, and update `state.json` last.

---

### 4. MUST: Weekly Trends and Limit History Cannot Be Derived from Daily Summaries

* **Issue**: Weekly limit windows in [insights.js](../../plugins/quotameter/lib/model/insights.js#L61-L81) (`weeklyTokens`) align to each user's specific weekly reset time (for example, Thursday at 14:32), not calendar midnight. `daily.jsonl` aggregates strictly by local calendar day (midnight to midnight). It is mathematically impossible to slice calendar days into reset-aligned weeks without boundary distortion. Furthermore, `windows.jsonl` as designed stores only percentages and `k`, omitting token counts and session limit hit counts needed for `history()` in [analyze.js](../../plugins/quotameter/lib/model/analyze.js#L480-L484).
* **Why it matters**: 12-week token charts and weekly limit history cannot be rendered once raw rows are deleted.
* **Concrete Fix**: Store token counts and hit stats directly on weekly rows in `windows.jsonl`: `freshTokens`, `cacheReadTokens`, `chatTokens`, `codeCost`, and `sessionLimitHits` (count of 5-hour windows reaching 100% or critical severity during that week). Long-term weekly charts can then read directly from the last 12 rows of `windows.jsonl` without re-aggregating daily buckets.

---

### 5. SHOULD: Missing Dimensions Break "All-History" Breakdown

* **Issue**: The proposed `daily.jsonl` records only reconciled cost by model, surface, project (top 20 plus other), subagents, and Opus/Fable. It completely discards tools, MCP servers, attribution skills, git branches, individual sessions, and token counts per model. In addition, daily top 20 project summaries suffer from rank churn: a project ranked #21 on certain days gets merged into "other", corrupting long-term totals.
* **Why it matters**: The "All history" breakdown view will show empty tables for Tools, MCP, Skills, and Sessions, and inaccurate project costs.
* **Concrete Fix**: Explicitly constrain the "All history" breakdown view in the report to supported aggregate dimensions (Models, Surfaces, Projects, Subagents) and hide unsupported tabs (Tools, Skills, Sessions) when viewing all-history mode. Retain token counts alongside costs in daily model summaries. Keep all active projects in daily summaries rather than cutting off at top 20 (data volume is negligible).

---

### 6. SHOULD: Timezone Shifts and Daylight Saving Corrupt Daily Cutoffs

* **Issue**: [DESIGN.md](../../docs/DESIGN.md#L141) specifies the cutoff as "local midnight keepDays ago". If the user travels across time zones or daylight saving begins/ends, "local midnight" shifts by one or more hours.
* **Why it matters**: A shifted local day boundary can overlap with a previously summarized day or leave a multi-hour unsummarized gap, causing duplicate records or missed usage.
* **Concrete Fix**: Use UTC midnight boundaries for `daily.jsonl` and record the exact ISO timestamp cutoff in `state.compactedBefore`. Partition raw rows strictly on `m.t < cutoff`.

---

### 7. SHOULD: Privacy Guardrails for Project Paths and Session Titles

* **Issue**: [logs.js](../../plugins/quotameter/lib/ingest/logs.js#L48-L66) does not store message text, but [sessions.jsonl](../../plugins/quotameter/lib/ingest/logs.js#L200-L204) stores `customTitle` and `aiTitle`, which often contain prompt excerpts or file names.
* **Why it matters**: Compacting session metadata into persistent summaries could inadvertently leak prompt text or proprietary paths into permanent summaries.
* **Concrete Fix**: Do not store session titles or raw session IDs in `daily.jsonl`. When `config.redactPaths` is true, ensure project names in `daily.jsonl` use the existing hashed project identifiers (`project-${hash}`).

---

### 8. SHOULD: Simpler Alternative: Monthly File Partitioning

* **Issue**: Line-by-line reading, filtering, temp file writing, and renaming of five active JSONL files under a process lock is complex, slow, and prone to Windows file locking contention.
* **Why it matters**: Unnecessary complexity and maintenance burden for small amounts of data (a few megabytes per month).
* **Concrete Fix**: Partition raw storage by month (for example, `messages-2026-10.jsonl`, `readings-2026-10.jsonl`). Compacting simply generates summary rows for completed months into `daily.jsonl` and `windows.jsonl`, then removes old monthly files with `fs.unlinkSync()`. This eliminates all line-by-line file rewriting, avoids Windows file rename collisions, and guarantees clean, atomic pruning.
