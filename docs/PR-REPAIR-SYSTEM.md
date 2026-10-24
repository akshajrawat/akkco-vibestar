# PR review repair system

The [October 23 workspace update](PREMIUM-UX-GIT-FINALIZATION.md) replaces the
primary manual URL/Track form with a saved GitHub PR list. Refresh retrieves
metadata; opening a discovered PR creates an inactive compatible review record.
Analyze PR remains explicit. Legacy tracking RPCs/data and the repair workflow
described below retain their existing contracts.

The current publisher shares the independent host fast-forward/SHA boundary with
ordinary-task Git Finalization. Its private pre-push hook remains defense in depth;
the exact-ref lease plus immutable ancestry proof closes the race independently.
Repair commits share exact UTF-8 object creation, preserving multiline bodies,
spaces and absence of a final newline. Repair still publishes only to its freshly
verified actual PR head repository/branch; task presets cannot change that destination.

Milestones 3–5 extend the existing manual analysis and IDE harness into a complete existing-PR repair workflow. A PR created outside Vibestar can be repaired without an issue task. The user selects saved source-linked concerns, runs Codex implementation followed by independent Antigravity verification, reviews the result and chooses a local-only commit or a separately confirmed push to the original fork/branch.

## Architecture and boundaries

Repair is a separate domain because its immutable PR identity, head/base ancestry, selected observations and publication lifecycle differ from issue planning. It reuses the execution engine rather than introducing a second agent orchestrator.

| Responsibility                                                                     | Implementation                         |
| ---------------------------------------------------------------------------------- | -------------------------------------- |
| Strict identity, session, workspace and agent-result contracts                     | `backend/review/repair/contracts.ts`   |
| Exact GitHub PR/upstream/fork IDs, current refs/SHAs, viewer and permission        | `backend/review/repair/identity.ts`    |
| Owned worktree creation, upstream merge, conflict recovery and cleanup             | `backend/review/repair/workspace.ts`   |
| Validated persistence and transition/activity journals                             | `backend/review/repair/store.ts`       |
| Complete read-only context packets and per-item agent instructions                 | `backend/review/repair/prompt.ts`      |
| Explicit creation, execution, follow-up, review, restart and editor coordination   | `backend/review/repair/service.ts`     |
| Manual approval, local commits, publication plans, guarded push and reconciliation | `backend/review/repair/publication.ts` |

`WorkspaceAssignment` supplies the physical repository/worktree boundary without inventing an issue task. Existing `AgentRunner`, provider adapters, bubblewrap sandbox, execution slots, cancellation, normalized events, redacted logs, command evidence and `ai_usage` serve both workflows. Adapter stage numbers select existing implementation/review capabilities; they are not the repair workflow's persisted stages. Antigravity receives read-only source access and its own context/diff/test review instructions. Every selected action needs exactly one validated result.

Full saved analysis context includes the PR purpose/description, linked issue context when available, complete reviewer comments and source identities, original patches/commits/checks, selected concerns, additional instructions, runtime information and previous results. Managed artifact packets mount read-only. GitHub comments and repository documents are untrusted context, not authority to perform host operations.

The shared output renderer remains authoritative for Readable/Raw views, event paging, search, saved prompts, logs and truthful tool activity. Provider-reported test summaries remain separate from recorded command starts, streams and exit statuses. Unreported tokens or subscription limits remain unavailable.

## Persistence

Migration 19 adds `pr_repairs`, `repair_messages`, `repair_activity`, `repair_publications` and `repair_reviewed_files`. Sessions retain references to the original tracked PR, selected repository and analysis; they save identity, source-linked actions, configuration, full context, workspace ownership/checkpoints, agent results and approval hashes.

Migration 20 atomically preserves the existing `agent_runs`, `agent_events`, `test_runs` and `terminal_sessions`, allowing exactly one task or repair owner. `ai_usage` gains a nullable repair link; deleting explicitly selected repair history preserves usage. Existing issue tasks, analyses, messages, settings, registrations and histories remain in their existing tables. There is no second usage database.

Named states are `created`, `preparing`, `ready_to_repair`, `codex_implementing`, `antigravity_verifying`, `awaiting_manual_review`, `ready_to_publish` and `published`, with `failed`, `cancelled`, `interrupted`, `merge_conflict`, `stale_remote_head` and `verification_blocked` stop states. User messages, state transitions, execution history and publication attempts are durable.

Workspace checkpoints record original head/merge-base, fetched base, integrated head/local merge commit, exact repair branch/path/common directory, ownership, source worktree registrations, conflict paths/index, remote freshness and sensitive process PID/start identity. Startup terminates only matching recorded processes and inspects actual Git state. It never automatically invokes a provider, repeats a merge or replays a push. Managed-root migration translates and verifies repair worktrees alongside issue worktrees; imported worktrees retain the existing explicit old-location boundary.

## RPC contracts

All new inputs use runtime validation. Caller-generated request UUIDs make creation idempotent. Confirmation is an explicit boolean contract, and a publication ID identifies one exact proposed operation.

| RPCs                                                      | Contract                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `repair.create`, `repair.list`, `repair.detail`           | Selected saved action IDs, explicit repository/configuration/instructions; persisted repair history and current execution evidence |
| `repair.start`, `repair.cancel`, `repair.recoverConflict` | Explicit initial/resumed/follow-up execution, cancellation and staged conflict recovery                                            |
| `repair.diff`, `repair.file`                              | Ownership-checked original PR, upstream integration and repair baselines                                                           |
| `repair.reviewFiles`, `repair.reviewed`                   | Content-bound review marks; stale content cannot be marked reviewed                                                                |
| `repair.events`, `repair.logs`                            | Existing owner-checked event cursors, log byte pages and full-file search                                                          |
| `repair.approve`, `repair.approveLocal`, `repair.commit`  | Explicit approval/commit of the exact reviewed fingerprint; local-only approval requires no remote push permission                 |
| `repair.preparePublication`, `repair.publish`             | Exact proposed destination/head/counts/validation; separately confirmed normal push                                                |
| `repair.reconcilePublication`, `repair.keepLocal`         | Read-only uncertain-outcome reconciliation or retained local work                                                                  |
| `repair.command`, `repair.terminal.*`                     | Existing sandboxed validation and leased PTY infrastructure with repair ownership                                                  |
| `repair.cleanup`                                          | Explicit clean owned-worktree cleanup; optional separately selected history deletion                                               |

`core.info.pr_repair` guards compatibility. The Electron bridge blocks repair writes/execution with an older helper while retaining reads/cancellation. Editor/folder actions accept repair ownership and resolve the exact verified worktree. Snapshot events include repair identity; local inbox counts require no remote polling or inference.

## Git and publication safeguards

- Identity comes from immutable PR/upstream/fork IDs and exact refs/SHAs. A matching branch name or legacy issue-task hint is insufficient. The explicitly selected checkout must match the upstream and its canonical Git common directory.
- A unique owned branch starts at the verified remote PR head. Fetch uses session-owned refs; preparation merges the actual latest base into the repair branch. Source files, index, current branch and original issue worktree are preserved. Preparation never pushes.
- Merge intent precedes mutation. Conflicts preserve `MERGE_HEAD`, unmerged index stages and paths. Recovery requires explicit staging/resolution and validates the saved merge target/ancestry. Incoming tracked paths cannot overwrite existing ignored files.
- Shared Git metadata locks use the canonical common directory. Independent destination/branch leases protect repair agents, terminals, commits and pushes across registrations/data roots. Terminal access must close before another writer starts.
- Approval binds HEAD, index, changed-file contents and modes. Editing or staging after review invalidates approval. Local staging/commit proves reviewed content is unchanged and preserves both original PR and integrated-base ancestry. Git hooks/signing cannot introduce unrelated automation during host commit preparation.
- Publication plans record the actual fork/ref, expected remote/local SHAs, PR URL, upstream base, Git counts/history, command outcomes, reported blockers and confirmation details. Fresh PR identity/open state, viewer permission, remote head, ancestry and reviewed fingerprint are checked before publication.
- Push uses an ordinary non-force ref update to the original fork/branch. A private per-invocation pre-push guard also validates Git's advertised old SHA and exact URL/ref/local SHA, catching a race after the earlier freshness check. URL rewriting is rejected. No force option, upstream update, automatic comment, PR merge or thread resolution is provided.
- Uncertain transmission/cancellation/restart outcomes require read-only remote reconciliation before another publication plan. A confirmed successful attempt is idempotent; restart does not replay it. Journal history retains outcome/errors and confirmed/published timestamps.
- Cleanup checks physical worktree/common-directory/branch ownership, refuses dirty or conflicted work and deletes only owned refs with expected-SHA comparisons. Repository/storage removal accounts for retained repairs before mutation.

These guards govern Vibestar operations. External editors and independently executed Git commands remain under the user's control; they do not participate in Vibestar's leases.

## UI and changed-file inventory

`src/components/repair/` contains `SolveReview`, `RepairWorkspace`, `PublicationDialog`, `LocalCommitDialog` and shared repair view types. Selection preserves original wording and distinguishes requests/questions/suggestions. The workspace presents the complete context, Codex/Antigravity history, action results, conflicts, manual review and explicit follow-ups. Utility tabs provide Changes, Tests, Agent Output, Logs, Usage and Terminal. Diff layers separate original PR changes, upstream integration and new repair work; review checkmarks are content-bound.

Repository navigation separates Issue Tasks and Pull Requests, with persisted repair selection. PR detail tabs are Overview, Full Conversation, Review Actions, CI / Checks, Analysis History and Repair Sessions. Accessible dialogs contain/restore focus, Escape dismisses, tab lists support keyboard navigation and optional context/dock dimensions persist. Publication and local-only commits have distinct dialogs. Published sessions show the PR link, pushed SHA and explicit Analyze Again.

Other modified implementation groups:

- Core: `backend/domain.ts`, `backend/main.ts`, `backend/rpc.ts`; execution engine, agent runner, command records, process capture, sandbox, terminals and usage under `backend/execution/`.
- Git/storage/editor infrastructure: `backend/workspace/{git,paths,editors}.ts`, `backend/storage/{migrations,migrate-root,service}.ts`. Shared `backend/review/file-hash.ts` retains the existing review hashing behavior.
- Desktop/shared UI: `electron/bridge.ts`, `src/App.tsx`, PR details/inbox, ChangesView, CommandRuns, CurrentRun, LogView, OpenInEditor, Status, TaskTerminal and TaskWorkspace. Shared output ownership, keyboard/focus helpers and snapshot types live under `src/lib/`; styling extends existing tokens in `src/styles.css`.
- Verification: `tests/pr-repair/` fixtures/provider plus identity, workspace, pipeline, publication, persistence and UI tests; `tests/desktop-pr-repair.test.ts`; existing migration, PR UI and Electron regression assertions. `package.json` adds the fixture-only desktop repair script without adding dependencies.
- Documentation: README, ARCHITECTURE, the milestone plan, this implementation guide and VERIFICATION.

## Acceptance evidence

The normal suite passes 227 tests, with 10 opt-in tests skipped. Twenty-four repair tests cover the new backend and renderer mechanics. Integration and PTY scripts pass separately. [VERIFICATION.md](VERIFICATION.md) records the final built Electron, production build and installer results, exact commands and retained artifacts.

| Required behavior                                                                                                            | Evidence                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Exact manual PR identity, imported/managed sources, checked-out/dirty original, actual slash-containing base                 | Identity/workspace fixtures using real local Git repositories        |
| Correct merge direction/commit, conflict/index preservation, stale head, shared-directory locks, ignored-file protection     | Workspace fixtures; upstream refs/source index compared before/after |
| Ownership, creation/removal checkpoints, real restart, process identity recovery, root migration, PTY exclusion              | Workspace/persistence fixtures                                       |
| Configured Codex → Antigravity, complete linked-issue/reviewer packet, every selected result, actual tests, read-only review | Pipeline fixtures executing safe Node providers in the real sandbox  |
| Blocked verification, invalid/missing results, explicit same-worktree fixes, cancellation, no startup inference              | Pipeline/persistence fixtures                                        |
| Exact fast-forward fork/ref, manual approval, changed fingerprints/dirty state/permission/closed PR rejection                | Publication fixtures against separate bare upstream/fork             |
| Advertised-head race, network failure after transmission, read-only reconcile, no duplicate push after core reopen           | Publication fixtures with actual Git transport and injected failures |
| Local-only commit without remote permission/publication attempt, accessible selection/dialogs, shared output/diff tabs       | Publication/UI fixtures                                              |
| Full manual Oppia-shaped analysis → repair → review → confirmed local-bare push; original checkout unchanged                 | Built Electron repair fixture with real IPC and retained screenshots |
| Original issue approval, manual-only PR analysis and Milestone 2 output/preferences                                          | Existing regression suite and built Electron fixtures                |

The acceptance repository models inline selectors, a changed test exploration and a vacuous `every()` draft assertion. Implementation moves selectors/assertions to utilities, restores the original exploration and tests rejection of an empty draft list. Both implementation and independent review execute actual `node:test` checks. This verifies the integrated mechanism, not the real Oppia test suite or actual model reasoning.

## Manual complete-experience check

1. Run `npm run build` and `npm start` with your normal isolated execution root. Connect the official GitHub/Codex/Antigravity CLIs and choose implementation/review models in Settings. Connect the upstream checkout or explicitly create a managed clone.
2. Track an open PR owned by a fork you can push to. Click Analyze PR and inspect full comments, distinct concerns, source links and coverage. A partial analysis must be completed with another explicit request before solving it.
3. Click Solve Review, deselect an item if desired, add instructions and confirm repository/models. Inspect the new separate repair navigation entry, exact branch/path/head/base and upstream integration diff. Compare the source checkout branch/status/index with its pre-run state.
4. Watch Codex and then Antigravity in the persistent run strip and shared output views. Inspect actual command outcomes separately from reported tests. Confirm the session stops at manual review and no remote update occurs.
5. Open the repair worktree in the editor, inspect all three change layers and mark reviewed files. For a failed/unverified concern, send Request Further Fix and confirm earlier runs remain while the same worktree gets a new explicit Codex/Antigravity pair.
6. Test Keep Local or Commit Locally first. The source checkout and remote head must stay unchanged. Local-only commits should work without fork push permission.
7. For publication you intend to perform, approve/prepare the push. Verify fork, branch, expected head, local head, base, changed-file counts and validation in the dialog. Commit locally if needed, inspect the resulting SHA, then explicitly Confirm Push. Verify the existing PR branch advances normally and publication history records that SHA.
8. Reopen Vibestar and inspect the history. No inference, push, analysis, comment or thread resolution should start. Analyze Again only when desired. Resolve a conflict explicitly, or reconcile an uncertain publication read-only, before resuming those stopped operations.

To reproduce the safe automated acceptance instead of using your accounts, run `npm run build` followed by `VIBESTAR_KEEP_EVIDENCE=1 xvfb-run -a npm run test:desktop:repair` on Linux. It uses isolated roots, blocked real CLI executables and local bare Git remotes.

## Limits and known risks

No remaining milestone feature is intentionally deferred. Live Codex/Antigravity repair semantics, subscription allowances, real GitHub permissions/push behavior and the real Oppia dependency/browser/test matrix were not exercised in this delivery. No live quota or real GitHub writes were used. Fixture-reported tokens are not account usage.

Official provider auth/session mounts retain the existing trusted-provider boundary; Vibestar never extracts credentials. Read-only review may block tools that require cache/dependency writes; those checks remain blocked and can be run explicitly in the repair command/terminal controls. Dependencies are not silently installed. Incomplete API/model context blocks solving until explicit reanalysis supplies complete coverage.

Native Windows installation/update, signing, DPI and real editor launch require their corresponding environment. Packaging is not installation evidence. Binary/large files remain subject to existing display limits, and metadata too large for a trustworthy repair fingerprint fails closed. Git races outside Vibestar's leases can stop preparation/publication and require a fresh explicit review. Imported worktrees cannot be silently relocated during root migration.
