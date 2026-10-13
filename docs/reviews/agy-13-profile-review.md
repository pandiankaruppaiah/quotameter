### Review Findings

A detailed implementation plan has been generated in profile_review_plan.md (agy working file, not included). 

Both files render valid GitHub Flavored Markdown and contain zero em dashes (`—`). The setup URLs and fields match GitHub's current UI. However, several claims and setup instructions require fixes to eliminate unbacked claims, invented details, and AI-slop phrasing:

1. **[github-profile/README.md](../../../github-profile/README.md#L9)**:
   - **Issue:** Unbacked claims / buzzwords. Claims "Claude Agent SDK" and "approval steps before risky actions". [`quotameter`](../../README.md) has zero dependencies, uses no agent SDK or API calls, and has no risk-gated agent pipeline.
   - **Fix:** Replace with: `- **Agentic systems.** Subagents and plugin workflows in Claude Code: tool calling, MCP server telemetry, and bounded execution.`

2. **[github-profile/README.md](../../../github-profile/README.md#L12)**:
   - **Issue:** Unbacked claim. "Eval sets and graders for agent behaviour". [`quotameter`](../../docs/DESIGN.md#L167-L172) uses deterministic unit test fixtures (`node:test`), not agent evals or graders. (Dual-model review is backed by the 12 review logs in `DESIGN.md`).
   - **Fix:** Replace with: `- **Evaluation and review.** Deterministic fixture suites for local agent logs, and a second model reviewing every design and code change.`

3. **[github-profile/README.md](../../../github-profile/README.md#L26)**:
   - **Issue:** Slop/hype phrasing. "**Agent harnesses:** clear tool contracts, retries with limits...". [`quotameter`](../../README.md) is quota telemetry and developer tooling, not an agent execution harness.
   - **Fix:** Replace with: `- **Plugin harnesses:** clear tool contracts, process isolation, and a hard stop instead of a guess when a step fails.`

4. **[github-profile/README.md](../../../github-profile/README.md#L32)**:
   - **Issue:** Unbacked toolbox items. Lists `Claude API`, `Claude Agent SDK`, and `evals`. [`quotameter`](../../README.md#L160) specifically avoids API network calls.
   - **Fix:** Replace line with: `Claude Code (plugins, skills, hooks, subagents) · Model Context Protocol · prompt caching · Node.js · GitHub Actions · multi-model review`

5. **[github-profile/README.md](../../../github-profile/README.md#L36)**:
   - **Issue:** Slop overclaim & repo count mismatch. "running AI in production" (tool is local desktop telemetry) and "on any of my repositories" (he only has one repo).
   - **Fix:** Replace with: `Open to conversations about agentic systems, AI developer tooling and quota telemetry. Start a discussion on quotameter.`

6. **[github-profile/PROFILE-SETUP.md](../../../github-profile/PROFILE-SETUP.md#L10)**:
   - **Issue:** Suggested bio contains unbacked "evals".
   - **Fix:** Change suggested bio to: `` `AI Tech Lead. I build agentic systems on Claude: Claude Code plugins, MCP, telemetry and quota engineering.` `` (108 chars).

7. **[github-profile/PROFILE-SETUP.md](../../../github-profile/PROFILE-SETUP.md#L21)**:
   - **Issue:** Phantom instruction. "Replace every `[BRACKETED]` placeholder...". [README.md](../../../github-profile/README.md) contains zero bracketed placeholders; they only exist in the setup guide's table (lines 11–12).
   - **Fix:** Clarify: `Ensure no bracketed placeholders from the profile settings table above ([YOUR COMPANY], [CITY, COUNTRY]) are left visible. (README.md contains no placeholders.)`

8. **[github-profile/PROFILE-SETUP.md](../../../github-profile/PROFILE-SETUP.md#L27)**:
   - **Issue:** Generic copy-paste boilerplate. "Pin up to 6 repositories that show your best work" when the owner has only one repository.
   - **Fix:** Replace with: `- **Pin** quotameter (Profile overview -> "Customize your pins").`

9. **[github-profile/PROFILE-SETUP.md](../../../github-profile/PROFILE-SETUP.md#L28)**:
   - **Issue:** Invented year. "An empty public repository from 2020 weakens a profile...". The date 2020 is not substantiated anywhere.
   - **Fix:** Remove "from 2020": `- **Automation is empty.** Either push the work it was meant for, make it private, or delete it. An empty public repository weakens a profile more than having none.`
