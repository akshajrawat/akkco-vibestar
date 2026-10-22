# Manual Issue Watch

Issue Watch saves contribution criteria for a GitHub repository. Saving, opening results, restarting Vibestar and changing models do not scan. **Scan Now**, **Recheck**, **Retry explicitly** and **Continue Analysis** each authorize a separate attempt. There is no polling schedule or automatic model retry.

1. Open **Issue Watch → New watch**. Enter a name and `https://github.com/oppia/oppia`.
2. Enter: “Find open issues that are not triage needed, not listed in https://github.com/oppia/oppia/issues/27409, and not already actively claimed. Prefer issues for which I can reasonably request assignment.”
3. Click **Preview hard filters**. Check the exact excluded labels and tracker URL, and confirm each ambiguous interpretation. Add similar labels explicitly if needed. Tracker bodies are checked by default; all-comments coverage is opt-in.
4. Select a discovered Codex model and supported effort. Review the candidate, discussion, semantic, request and time limits. Save the watch.
5. Click **Scan Now**. Inspect progress, tracker verification and coverage. **Cancel** remains available while work is running. Selected GitHub content is sent to the configured provider during semantic screening, including private content when applicable.
6. Inspect result categories and original evidence. The selected attempt's provider, output, prompt, usage and source snapshots remain available in history. Changing the saved configuration creates a revision; it does not rewrite earlier attempts.
7. **Start Vibestar Task** opens the existing task form with the issue URL and discovery notes. Select a connected repository, inspect the issue preview and explicitly submit the form to start the normal pipeline.

GitHub access uses official `gh` authentication without cloning the repository. Issue Watch never posts comments, claims issues, requests assignment or creates PRs. Open/copy actions and local dismissal do not invoke a model.

## Reading outcomes

**Candidate for claim request** means no blocker was detected within the declared evidence scope. It does not grant assignment. Possible claims, repository approval requirements and missing discussion/policy evidence remain visible. Assignees, excluded labels/tracker references, confirmed competing PRs and accepted active claims take precedence over model preferences. Claim age alone does not imply abandonment.

Initial discoveries establish the first complete baseline. **New GitHub issue** means creation after the prior complete cutoff. **Newly matching existing issue**, **Reentered eligibility**, **Criteria changed**, **Existing match**, **No longer eligible** and **Not rechecked** describe different histories. An old issue is never called newly created merely because it first appeared in search.

Every attempt is bounded. “Complete” refers to its declared collection scope, not exhaustive repository screening. Missing required trackers block the attempt; other missing coverage or model failures produce partial evidence. Partial, cancelled, blocked and interrupted attempts preserve the prior complete baseline. Continue Analysis requires an explicit candidate selection and refreshes exclusions in a new attempt. No unavailable model silently falls back to another provider.

Previously verified tracker repository/issue IDs remain bound to the complete baseline. Renames with the same IDs work; a genuinely replaced tracker needs a new watch after you verify its identity. Editing preference text does not discard earlier identity evidence.

Codex uses the existing official subscription CLI and read-only AgentRunner sandbox. At most one host-started semantic invocation is reserved per attempt; the CLI can make internal requests. Actual reported tokens and available allowance snapshots are shown, with missing fields left unavailable. Antigravity is unsupported for this new workflow because its official consumer-plan FAQ excludes third-party application wrapping. Existing adapters remain available for established workflows; no unsupported authentication workaround is added.

Default maximums are 200 candidate identities, 40 detailed contexts, 20 semantic candidates, 400 GitHub requests, a 128 KiB semantic packet and a 120-second model timeout. Source and total collection byte limits also fail explicitly. Large repositories may need narrower criteria or explicit continued analysis.

## Verification

The normal suite uses isolated GitHub responses and inert provider processes. Built Electron acceptance uses the exact Oppia prompt, a changing tracker, saved evidence/output/usage/history, keyboard controls, narrow-screen cancellation and the existing task-form handoff:

```bash
npm run build
VIBESTAR_KEEP_EVIDENCE=1 xvfb-run -a npm run test:desktop:watch
```

The user-authorized live GitHub fixture is restricted to `akshajrawat/akkco-vibestar-test`; it creates identifiable test issues, a label and a temporary contribution policy, then closes/removes only those fixtures. It uses a fake provider, creates no clone/task and never spends subscription allowance. Closed fixture issues and policy commit history remain as the audit trail. It refuses to overwrite an existing contribution policy.

```bash
VIBESTAR_GITHUB_WATCH_TEST=1 VIBESTAR_KEEP_EVIDENCE=1 \
  npm test -- tests/issue-watch/github-live.test.ts --maxWorkers=1
```

See [verification](VERIFICATION.md) for actual results and unverified native/provider behavior, and the [approved plan](ISSUE-WATCH-SECURITY-PLAN.md) for hardening details.
