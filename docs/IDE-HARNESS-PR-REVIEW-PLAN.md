# IDE harness and manual PR review milestone plan

Status: Milestone 1 approved; Milestone 2 implemented and verified, awaiting user review. Milestones 3–5 remain deferred pending separate approval.

## Accepted boundaries

- Manual-only execution applies to PR metadata scanning, semantic analysis and repair. Preserve the existing issue queue, startup recovery, provider order, scope semantics and approval gates.
- Prefer a new isolated repair worktree from the verified remote PR head. Record upstream and head repository identities, the actual PR branch, head SHA and selected local repository. Issue and repair workflows do not share a physical worktree by default.
- Local commits and remote publication have different authority. A user-requested repair may create a checkpointed local upstream merge commit. Never keep MERGE_HEAD pending through agent stages. Source checkout files, index and current branch remain untouched. Remote writes require explicit confirmation, exact fork/ref validation and remote-head verification; never force-push.
- Reuse AgentRunner, provider adapters, agent events, redacted logs, SQLite and ai_usage. Prioritize truthful readable output and live streaming; defer universal run registries, output indexes and generalized search until evidence establishes a need.
- Implement and verify each milestone independently. Every milestone preserves the original Antigravity plan → Codex refine → Codex implementation → validation → Antigravity final review → human approval issue workflow.

## Milestone 1 — Manual PR scanning and complete analysis

- [x] Add an additive manual-policy migration disabling legacy enabled watches and one-shot/pending automatic inspection without deleting snapshots, decisions, attention, history or usage.
- [x] Remove startup, recurring and authentication-triggered PR sync/analysis. Refresh PR List retrieves GitHub metadata only. Track PR saves a disabled record without inspecting or starting inference. Legacy enable requests cannot restore automatic execution.
- [x] Reuse the existing PR collector and paginators. Preserve complete review bodies, authored chronological comments, review submissions, inline reply chains, thread membership/resolution/outdated coordinates, head/base repository/ref/SHA, changed-file patches, checks and available commit/linked-issue context. Record explicit retrieval coverage and missing information.
- [x] Analyze PR/Analyze Again creates one explicit operation, with progress, cancellation and no retry after cancellation or restart. Show configured Utility AI before execution; use the existing runner/sandbox/usage path at most once per operation when semantics need inference. No optional legacy second-model verification.
- [x] Persist analysis history and stable observations anchored to real GitHub source IDs and exact quotations. Separate classification, author response, code evidence and thread resolution. Replies, pushes and resolved threads do not prove code correctness. Multiple observations in one review remain independent; positive feedback is not a fix request.
- [x] Construct bounded context with complete read-only packets and explicit source/segment coverage. Never claim complete analysis when pagination, source coverage or context is insufficient. Repeated analysis preserves action IDs where correspondence is proven and retains older results on failure.
- [x] Extend the existing PR inbox/details with full review text, an engineering report, observations/questions, checks, analysis history and actual usage. Repair/publishing remains unavailable until its milestones are approved.
- [x] Verify migrations, no automatic invocation, retrieval/pagination, action identity/evidence, cancellation/recovery, report UI and unchanged issue pipeline with fixtures. Run format, lint, type checks, relevant tests and build; use no real model subscription during routine verification.

Integration points: backend/github/{client,service,contracts}, backend/scheduled/{scheduler,github,contracts,action}, backend/review/pr analysis contracts/service, backend/execution/{engine,utility-ai,agent-runner}, backend/storage/{migrations,database,service}, backend/{main,rpc}, electron/bridge, src/components/{ScheduledPage,PrDetails,SettingsPage,ProvidersPage}, and existing tests. Add only PR analysis/action persistence in this milestone; no task/workspace redesign.

Implemented persistence: migration 17 enforces the manual policy; migration 18 adds pr_analyses, pr_review_actions and pr_action_assessments, with nullable analysis_id links on existing runs/usage. Session states are running → completed/partial/failed/cancelled/interrupted. Each Analyze request has a caller-generated idempotency UUID. The host validates quotations, source IDs, reply chronology, thread ownership, commit citations and segment coverage before persisting assessments. Code verification remains explicitly unverified.

Implemented RPC: scheduled.analyze, scheduled.cancel, scheduled.detail and scheduled.logs extend the existing PR records. scheduled.run remains an explicit GitHub-only inspection; scheduled.enabled cannot enable automatic execution; scheduled.fix cannot create an issue follow-up. Refresh and tracking retain their existing github.sync/scheduled.add entry points with manual-only behavior. Analysis activity leases protect storage and record deletion from races.

Verification uses fixture-only GitHub responses and the existing runner inside its real sandbox. Collector, migration, semantic evidence, cancellation/restart, report rendering and bridge guards have automated coverage. Built Electron tests exercise both the PR report and original issue approval workflow. Actual provider semantics, live GitHub permissions and native Windows/WSL installation still require optional live verification; no subscription allowance or GitHub writes are used by these fixtures.

Coverage limits are explicit: essential pagination failure preserves the prior snapshot and fails the operation; optional retrieval failures make the report partial. The collector caps REST/thread pagination at 100 pages, closing-issue references at 100 and linked-issue bodies at 20. Missing binary/omitted patches warn that code evidence is incomplete. Semantic segment coverage is provider-reported and host-validated for identity/completeness, not a claim of access to hidden reasoning. Partial reports require another explicit Analyze action. Historical task links remain hints; Milestone 3 must independently verify exact fork/ref/worktree identity.

Milestone 1 verification completed on 2026-10-14:

| Check                                                           | Result                             |
| --------------------------------------------------------------- | ---------------------------------- |
| npm test                                                        | 190 passed; 8 opt-in tests skipped |
| Built Electron PR analysis and existing issue approval fixtures | 2 passed under Xvfb                |
| npm run lint                                                    | Passed                             |
| npm run build (includes TypeScript checks)                      | Passed                             |
| npm run format:check and separate plan-document formatting      | Passed                             |
| git diff --check                                                | Passed                             |
| Real provider inference / live GitHub / remote writes           | Not performed                      |

## Milestone 2 — Professional IDE harness and complete agent output UX

- [x] Keep current provider/model/effort/stage/activity visible across task tabs with optional panes closed.
- [x] Improve existing normalized tool grouping, exact arguments, stdout/stderr, truthful terminal states and unknown structured field visibility.
- [x] Reuse saved prompts/raw logs and live events for readable/raw provider views; keep the interactive PTY separate.
- [x] Add practical follow/pause/copy/filter controls, stage navigation, accessible dialogs and persistent layouts without a framework rewrite.
- [x] Make per-run provider/model, duration and actual reported usage directly accessible from the current run.
- [x] Verify streamed updates, real tool completion/failure, keyboard/IME behavior and task-local state; run PTY E2E when interactive behavior changes.

Implemented on 2026-10-14. CurrentRun now lives outside the optional sidebar and utility dock, including when the dock is maximized. It uses the executing run rather than composer selections. Officially emitted startup model/effort updates both the run and ai_usage; omitted default-model identity stays explicit. Run usage opens the existing telemetry filtered to that run.

LogView offers Readable, Raw stdout/stderr/structured events and exact saved prompts. Tool cards show arguments, paths, commands, live output, exit status, reported or explicitly observed duration, and independent running/completed/failed/interrupted states. Explicit interruption outranks exit zero. Provider command aggregates remain labelled as aggregates/tool output; separate CLI streams are not conflated. Nested results, provider status/errors and unknown raw fields remain inspectable without inventing progress or hidden reasoning.

Persistence stays on agent_runs, agent_events, test_runs, redacted log files and ai_usage. task.events adds ownership-checked cursor reads with first/latest tool context; task.logs adds optional byte pages and full-file streaming search while preserving legacy tail callers. Chat retains its bounded snapshot, while the output browser can inspect older persisted events/files. Search pages bound matching lines and payload bytes, retaining a complete oversized line. No migration, universal run registry or output index is introduced. The process executor preserves UTF-8 split across stdout/stderr chunks, and structured stderr cannot overwrite stdout results/session/usage.

Task-local output selection, mode, stream, search, filtering, scrolling and layouts persist locally. Follow/pause never stops capture. Earlier-page loading preserves scroll position; copying uses displayed output. Ctrl/Cmd+F focuses output search, Ctrl/Cmd+End follows output, Escape clears search, and Arrow/Home/End navigate task/utility tabs. Saved-prompt dialogs contain and restore focus. Existing resizers and PTY sessions are retained. No new dependency is required.

Milestone 2 verification:

| Check                                                                          | Result                                   |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| Baseline before editing                                                        | 190 tests passed; 8 opt-in tests skipped |
| npm test                                                                       | 203 passed; 9 opt-in tests skipped       |
| npm run test:tui                                                               | 2 passed                                 |
| Built Electron output, original issue approval and manual PR analysis fixtures | 3 passed under Xvfb, sequential workers  |
| npm run lint / npm run typecheck / npm run build                               | Passed                                   |
| npm run format:check / explicit docs formatting / git diff --check             | Passed                                   |
| Real provider inference / live GitHub / remote writes                          | Not performed                            |

The final built output screenshots and fixture audit are at `/home/aksha/tmp/vibestar-output-desktop-v7DT5Y/screenshots/`. Readable streaming, independent raw streams, redaction/copying, completed/interrupted tools, historical search beyond the UI tail, reported usage and restored preferences were visually inspected. Full commands and limits are recorded in [verification documentation](VERIFICATION.md).

Limits: provider-omitted fields remain unavailable; raw search is a linear scan of saved files, and large output is browsed in pages. Unknown CLI variants remain available in raw/technical views. Native Windows installation/DPI and live account/provider behavior were not retested. Existing issue pipeline, approval gates, manual PR policy, worktree ownership, concurrency, authentication and remote-write restrictions remain unchanged. Repair implementation remains deferred. Stop here until the user approves Milestone 3.

## Milestone 3 — Isolated PR worktree and upstream integration

- [ ] Verify PR/fork/ref/SHA and explicitly selected local repository; import manual PRs without inventing an issue branch.
- [ ] Create an owned repair branch/worktree from the verified remote PR head; preserve foreign checkouts and local changes.
- [ ] Fetch the configured latest upstream base and merge it into the repair branch with a normal local merge commit. Checkpoint intent/result and stop on conflicts; recovery never blindly replays the merge.
- [ ] Record original PR, upstream integration and repair diff baselines. Reserve the repair worktree/remote branch against concurrent writers.
- [ ] Verify identity, merge direction, dirty/checked-out branches, conflicts, stale remote heads and restart behavior using real local Git fixtures.

## Milestone 4 — Repair → verification → manual review

- [ ] Introduce a separate typed persistent PR-repair workflow, using the existing runner/event/log infrastructure.
- [ ] Codex implements selected observations and runs applicable checks; Antigravity independently reviews afterward with source-write restrictions.
- [ ] Persist per-action files, commands, validation, uncertainty and acceptance. Never equate model success with a verified fix.
- [ ] Stop at manual review with original comments, checklist, actual test outcomes, diff and local commits. Support explicit retry/additional fixes and durable history.
- [ ] Verify provider order, isolation, evidence, failed verification, cancellation and restart; regress the original issue pipeline.

## Milestone 5 — Confirmed finalization/push and integrated polish

- [ ] Prepare reviewable local finalization and remote publication separately, including exact destination/ref, expected remote SHA, reviewed fingerprint and commit information.
- [ ] Require explicit confirmation for every push/GitHub modification; use an ordinary fast-forward push only. A guarded per-invocation pre-push check must reject changed advertised remote heads. Never force-push or modify the source checkout.
- [ ] Journal publication and reconcile uncertain outcomes read-only after interruption; no blind replay.
- [ ] Integrate repository navigation, repair history and professional pane/report styling; preserve branding and established React/Electron boundaries.
- [ ] Run fixture desktop, integration, issue regression, PTY, build and packaging verification. Any real provider/live publication test needs separate explicit authorization.

## Persistence and security methodology

Milestone 1 extends existing tracked PR records rather than adding another PR registry. Full GitHub snapshots, immutable analysis sessions and host-assigned stable observations preserve source provenance. ai_usage remains the authoritative local provider usage record; token/allowance values stay nullable unless officially reported. Later milestones add only their required workspace/repair/publication checkpoints.

GitHub and repository text are untrusted model context, never execution authority. Official gh/codex/agy own authentication; no credential extraction or permission bypass. Existing path checks, argv-safe execution, bubblewrap, PID identity recovery and storage leases stay in force. No analysis posts replies, resolves threads, merges or pushes.

Each meaningful change updates ARCHITECTURE.md. Do not start the next milestone without approval.
