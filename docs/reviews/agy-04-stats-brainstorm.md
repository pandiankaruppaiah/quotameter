I have reviewed [DESIGN.md](../../docs/DESIGN.md), [analyze.js](../../plugins/quotameter/lib/model/analyze.js), and [template.html](../../plugins/quotameter/lib/report/template.html).

The complete plan and proposals have been saved to the artifact quotameter_stats_plan.md (agy working file, not included). Below is the proposed catalog of 22 candidate stats and views, followed by the top 6 picks.

---

### Candidate Stats and Views (22 proposals)

#### 1. Weekly token volume
- Question: How many total tokens did I burn across all surfaces during the current week?
- Computation: Sum exact tokens from all Claude Code messages in the weekly window (`in + out + cw5 + cw1h + cr`) plus estimated chat tokens (`chat_pts / k * tokens_per_dollar`).
- Confidence: Estimated (exact for Claude Code, estimated for chat).
- Priority: Must.

#### 2. Quota cost per Code session
- Question: How many percentage points of the 5-hour limit does a typical Claude Code session consume?
- Computation: For all completed sessions in the last 30 days, compute session cost multiplied by calibration factor `k`. Report median and 90th percentile percentage points.
- Confidence: Estimated.
- Priority: Must.

#### 3. Sessions remaining until 5-hour limit
- Question: How many typical coding sessions can I run before hitting the 5-hour limit?
- Computation: `(100 - current_pct) / median_session_pct`, where median session percentage is derived from 30-day session history.
- Confidence: Estimated.
- Priority: Must.

#### 4. Chat sessions until limit
- Question: How many web or mobile chat conversations can I have before exhausting my 5-hour quota?
- Computation: Remaining points divided by average points per chat conversation.
- Confidence: Rough.
- Priority: Skip.
- Flag: Needs data we do not have. Anthropic logs no local chat session boundaries or chat message counts. We can only observe aggregate percentage increases during idle intervals.

#### 5. Effective cache hit ratio
- Question: What percentage of my input context was served from cache rather than processed fresh?
- Computation: `cr / (in + cw5 + cw1h + cr)` across all Claude Code messages in the selected period.
- Confidence: Exact.
- Priority: Must.

#### 6. Cache write overhead share
- Question: What fraction of my quota was spent writing new cache entries due to session restarts or 5-minute expirations?
- Computation: Sum list price cost of `cw5` and `cw1h` tokens divided by total message list cost.
- Confidence: Exact.
- Priority: Nice.

#### 7. Active burn rate
- Question: When I am actively prompting, how many percentage points per hour do I burn?
- Computation: Cluster turns into active periods (turns separated by less than 15 minutes). Sum points burned divided by total active session hours.
- Confidence: Estimated.
- Priority: Must.

#### 8. Weekly quota headroom at current pace
- Question: Will my weekly allowance run out before the reset day, and how many points will remain?
- Computation: `100 - (current_weekly_pct + daily_pace * days_until_reset)`.
- Confidence: Estimated.
- Priority: Must.

#### 9. Subagent overhead ratio
- Question: How much extra quota do subagents add on top of my main session prompts?
- Computation: For sessions that spawned subagents, compute `subagent_points / main_session_points`.
- Confidence: Estimated.
- Priority: Must.

#### 10. Context bloat penalty (>100K tokens)
- Question: How much quota was consumed on turns where context size exceeded 100,000 tokens?
- Computation: Filter messages where `in + cr + cw >= 100000`, sum reconciled points, and calculate share of total session quota.
- Confidence: Estimated.
- Priority: Nice.

#### 11. Cost per user turn
- Question: How many percentage points of the 5-hour limit does a single prompt turn consume on average?
- Computation: Total window points divided by count of main assistant responses (non-subagent turns).
- Confidence: Estimated.
- Priority: Nice.

#### 12. Quota expenditure by git branch
- Question: How much quota has been spent on my current feature branch compared to main?
- Computation: Group messages by `cwd` and `branch`. Sum reconciled cost and convert to weekly points using `k`.
- Confidence: Estimated.
- Priority: Nice.

#### 13. Idle MCP token tax
- Question: How many tokens were loaded into session starts by MCP servers that were never called?
- Computation: For MCP servers in overhead with zero calls in 30 days, multiply their loaded tokens per session by total sessions started in that 30-day period.
- Confidence: Exact.
- Priority: Nice.

#### 14. Daily Chat vs Code quota split
- Question: On each day of the week, how much quota was spent on chat versus Claude Code?
- Computation: Group walk-window interval results by calendar day into chat points and Code points.
- Confidence: Estimated.
- Priority: Nice.

#### 15. Continuous sprint limit time
- Question: How long can I code continuously during a heavy session before triggering a limit warning?
- Computation: For past sessions reaching warning or critical severity, calculate elapsed duration from session start to the first warning reading.
- Confidence: Estimated.
- Priority: Nice.

#### 16. Subagent model downgrade savings
- Question: How many quota points could be saved if Opus subagent tasks were switched to Sonnet or Haiku?
- Computation: Re-price Opus subagent token counts at Sonnet and Haiku rates. Multiply the cost difference by `k`.
- Confidence: Estimated.
- Priority: Nice.

#### 17. Output generation velocity
- Question: What is Claude's generation speed in tokens per second by model?
- Computation: Average `usage.speed` across messages grouped by model family.
- Confidence: Exact.
- Priority: Skip. (Users care about quota preservation rather than raw throughput).
- Flag: The `speed` field is null on some message records.

#### 18. Turn-to-turn context growth rate
- Question: How fast does prompt context grow from turn to turn in a typical session?
- Computation: Average difference in `(in + cr)` between consecutive assistant turns within the same session.
- Confidence: Exact.
- Priority: Nice.

#### 19. Unitemised usage share
- Question: What percentage of my quota consumption comes from unitemised background operations or unlogged devices?
- Computation: `(unitemised_code_cost * k + chat_points) / total_window_points`.
- Confidence: Estimated.
- Priority: Nice.

#### 20. Quota relief countdown card
- Question: When will the next quota reset arrive, and how many points will be replenished?
- Computation: Time delta until `resetsAt` on the 5-hour window (frees up current used points) and weekly window.
- Confidence: Exact.
- Priority: Must.

#### 21. Desktop chat vs web chat split
- Question: How much of my estimated chat quota was spent on Desktop chat versus claude.ai in the browser?
- Computation: Would require separating Desktop chat messages from web chat.
- Confidence: Rough.
- Priority: Skip.
- Flag: Needs data we do not have. Desktop chat creates no local message logs.

#### 22. Session duration and token intensity
- Question: How long do my coding sessions last, and how many tokens per minute do they burn?
- Computation: Session duration from `sessions.jsonl` (`end - start`), tokens from `messages.jsonl`, computing `tokens / duration_minutes`.
- Confidence: Exact.
- Priority: Nice.

---

### Top 6 Selections

1. **Weekly token volume** (Must, Estimated)
   Answers how many tokens were consumed in the current 7-day period across both Code and chat.
2. **Sessions remaining until 5-hour limit** (Must, Estimated)
   Translates abstract percentage points into a concrete answer to: "Can I start another coding session right now?"
3. **Quota cost per Code session** (Must, Estimated)
   Provides median and 90th percentile percentage point costs for planning session workloads.
4. **Weekly quota headroom at current pace** (Must, Estimated)
   Warns whether current daily consumption will trigger a weekly lockout before reset day.
5. **Effective cache hit ratio** (Must, Exact)
   Reveals if prompt caching is actively protecting quota or if cache misses are inflating turn costs.
6. **Subagent overhead ratio** (Must, Estimated)
   Exposes the quota penalty added by autonomous subagents relative to the primary conversation.

---

### Open Questions for Implementation

1. For **Weekly token volume**, should the headline number combine all token types into one total with a cache read footnote, or show raw prompt tokens and cached tokens side by side?
2. For **Sessions remaining**, should the calculation base itself on the 30-day median session or the user's last 5 recent sessions?
The brainstorming analysis and walkthrough artifacts have been documented:
- Plan: quotameter_stats_plan.md (agy working file, not included)
- Walkthrough: walkthrough.md (agy working file, not included)

### Summary of Decisions and Next Steps

1. **Top 6 Recommended Metrics**:
   - **Weekly Token Volume** (Must, Estimated): Combined token burn across Claude Code and estimated chat for the current week.
   - **Sessions Remaining Until 5-Hour Limit** (Must, Estimated): Number of typical coding sessions possible before hitting 100%.
   - **Quota Cost per Code Session** (Must, Estimated): Median and 90th percentile percentage point costs per session.
   - **Weekly Quota Headroom at Current Pace** (Must, Estimated): Estimated leftover percentage points or deficit at the weekly reset.
   - **Effective Cache Hit Ratio** (Must, Exact): Percentage of input context served from prompt cache.
   - **Subagent Overhead Ratio** (Must, Estimated): Multiplier of quota consumed by autonomous subagents relative to the main session.

2. **Data Feasibility Flags**:
   - **Chat conversation counts** and **Desktop vs Web chat split** were flagged and deprioritized (Skip) because Anthropic stores no local logs for claude.ai or mobile chat. Chat can only be estimated as aggregate unexplained percentage increases.

When you are ready to implement any of these views in [analyze.js](../../plugins/quotameter/lib/model/analyze.js) and [template.html](../../plugins/quotameter/lib/report/template.html), let me know which ones you would like to start with.
