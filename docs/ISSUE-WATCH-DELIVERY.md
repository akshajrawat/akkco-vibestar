# Security hardening and Issue Watch delivery

The approved S1–S5 work is complete. The final suite passed 370 tests (13 opt-in skipped), integration 7, PTY 3, six built Electron/package checks and the authorized GitHub fixture. Both installers built successfully. Measured results and environment limits are maintained in [VERIFICATION.md](VERIFICATION.md).

## S1 fixes and evidence

All production host Git paths use the shared configuration/transport boundary. Hostile fsmonitor/filter/driver/hook/helper/include/transport fixtures, exact-destination publication tests and source/index canaries exercise the actual application paths. Canonical managed roots, positive ownership, interrupted creation/removal checkpoints and expected-SHA cleanup preserve dirty, ignored and unrelated work. Versioned issue authority hashes bind exact HEAD/index and full underlying file/mode/link bytes through shared repair primitives, including large binaries and credential-shaped paths.

Empty-root sandbox manifests reduce host mounts and sockets while retaining required runtime/toolchains and selected official provider state. Stateful bounded PTY redaction covers split, escaped and ANSI-adjacent fixture credentials. Output/backpressure failures cancel execution. Discovery and cancellation await process settlement. Persistence diagnostics isolate malformed records without deleting source bytes; migration backups/transaction rollback/FK checks and durable task-request identities protect history and retries. Independent read-only investigators/reviewers informed the S1 patch families.

## Security limits

Provider processes own their official auth/session state and service network access. Redaction is best effort. Same-user external processes and editors do not participate in application leases. GitHub search and multiple API reads are not an atomic repository snapshot. Claim/policy prose remains labelled interpretation; an unassigned candidate is not guaranteed available. Missing evidence, stale state and bounded omissions remain visible. SQLite physical damage and external filesystem failures require recovery rather than invented defaults.

## S2 storage and deterministic rules

Migration 21 adds persistence diagnostics and durable issue-task request tombstones. Migration 22 adds six normalized tables: watches, immutable revisions, scan attempts, retained sources, candidate snapshots and complete-result projections. Migration 23 attributes utility runs/usage to watch/scan owners and stores utility events without weakening existing task/repair ownership checks. Existing migration history and completed approvals remain readable.

Rules enforce open issues, exact labels, explicit issue exclusions, current tracker membership, assignments and confirmed competing work before and after screening. Structural Markdown parsing skips code/HTML/PR examples and preserves repository identity. Trackers refresh per attempt; required failures block. Later scans compare tracker node IDs with the complete baseline while allowing canonical renames with the same IDs. Only complete attempts atomically update the baseline; local dismissal never does.

## S3 models and allowance controls

Codex uses the existing UtilityAI/AgentRunner, official discovery, read-only sandbox, cancellation, capture, logs and usage. Each explicit attempt reserves at most one host invocation before launch. All-excluded attempts skip inference. Full packets, candidate selection, request/source bytes and deadlines are bounded. Unknown IDs, duplicated results, forged citations/actors/blockers and invalid output cannot promote candidates. Quota/capacity failures retain GitHub evidence without retry or fallback. Missing token/allowance values remain unavailable.

Antigravity is unsupported for Issue Watch under its official consumer-plan application-wrapping restriction; existing adapters are preserved. No credential extraction or authentication workaround is added.

## S4 desktop

The resizable saved-watch/results/details workspace includes deterministic preview/ambiguity confirmation, discovered model/effort selection, bounded limits, explicit scan/retry/continue/recheck, progress/Cancel, categories, original Markdown/discussion/policy evidence, safe GitHub links, local dismissal, paged saved history, Readable/Raw output, exact prompts and actual usage. Completion notices deduplicate across navigation/restart and reserve space instead of covering actions. Keyboard selection, focus containment/restoration, persistent pane preferences, narrow-screen cancellation and reduced-motion styling are integrated. Task handoff only prefills the existing form; explicit task submission retains its original pipeline.

## S5 verification

Normal/adversarial tests, real isolated Git/PTY fixtures, built Electron watch/issue/PR/repair/output regressions, installer builds and packaged smoke checks are recorded with exact counts and evidence paths in [VERIFICATION.md](VERIFICATION.md). The GitHub test is separately opt-in and restricted to the user-authorized [test repository](https://github.com/akshajrawat/akkco-vibestar-test). It creates identifiable fixtures, checks real API behavior, closes/removes only its fixtures and uses fake provider processes. Routine tests use saved GitHub responses.

## File inventory

| Responsibility                  | Files                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git/ownership/integrity         | `backend/workspace/git-command.ts`, `ownership.ts`, `git.ts`, `paths.ts`; `backend/review/file-hash.ts`; repair workspace/publication callers                                                                    |
| Execution/persistence hardening | `backend/execution/{sandbox,process,stream-redactor,bounded-output,auth,agent-runner,engine}.ts`, provider adapters and related modules; `backend/storage/{records,database,migrations,migrate-root,service}.ts` |
| Watch domain                    | `backend/issue-watch/{contracts,rules,tracker-exclusions,eligibility,store,scan,semantic,service}.ts`                                                                                                            |
| GitHub collection               | `backend/github/{client,issue-search,issue-context}.ts`                                                                                                                                                          |
| API and ownership               | `backend/{main,rpc,domain}.ts`, execution usage/utility modules, `electron/bridge.ts`                                                                                                                            |
| Desktop                         | `src/components/issue-watch/*`, `src/lib/issue-watch/*`, `App.tsx`, shared `StageSettings`, `LogView`, output readers, NewTask and styles                                                                        |
| Verification                    | `tests/security/*`, `tests/issue-watch/*`, `tests/desktop-issue-watch.test.ts`, `tests/packaged.test.ts`, existing regression fixtures                                                                           |
| Documentation                   | `ARCHITECTURE.md`, `README.md`, this report, usage guide, approved plan and verification record                                                                                                                  |

These are responsibility groups, not claims that every similarly named path changed in the final continuation. Git history/diff contains the exact inventory.

## Confirmed dead-code removals

Removed the test-only scheduled analysis path and optional second-model branch, obsolete activity/prompt heuristics, unmounted Monaco DiffView/DiffReview, loader/declarations and unused dependencies. Kept selected-code APIs/history, CodeAskAI, active Changes/Overview/FileTree views, inert scheduler compatibility and all migrations. Tests use active UtilityAI/manual PR paths.

## Compatibility

Unsupported executable local Git configuration receives an actionable refusal without rewriting user configuration. New clones use full objects; existing partial clones need Git 2.45 or newer. Pending legacy issue approvals/drafts require fresh review because old authority hashes are incomparable; completed history remains. Older helpers show an update-required watch state and cannot start feature writes/scans. Antigravity is accurately unsupported for the new workflow. PR navigation is labelled Pull Requests. Saved watch history cursors identify a scan owned by the watch and remain stable across equal timestamps.

## Real Oppia test

Follow the [Issue Watch guide](ISSUE-WATCH.md): connect official gh/Codex, enter `oppia/oppia` and the exact tracker/claim prompt, confirm preview ambiguities and choose a discovered model. Save, verify nothing runs, then explicitly Scan Now. Inspect coverage and current claim evidence before requesting assignment outside Vibestar. Start Vibestar Task opens the existing form; connect/select a repository and explicitly submit it. A real Oppia scan consumes the selected subscription's allowance when semantic screening is needed.

## Unverified native/provider behavior

No live subscription inference was performed for S1–S5. Current provider-native tool/auth semantics, actual account allowance, native Windows installation/update/DPI and a real Oppia dependency/browser run remain unverified. Linux cross-built Windows/WSL helper smoke does not prove native Windows execution. Installers are local, unsigned and unpublished. Legacy live opt-in desktop/product tests that access personal checkouts or subscriptions were not enabled under this goal.

## Incomplete work

No feature phase or required supported-host check remains incomplete. Unavailable live subscription and native Windows validation is explicitly recorded above; it is not claimed as tested.
