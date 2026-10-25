# Pipeline verification V2

## Root cause and policy

The previous stage-4 retry ran only `git diff --check <pinned-base> --` and
reevaluated saved implementation evidence. It launched neither Playwright nor a
provider. Every unresolved required check set `canReview=false`, so environmental
gaps repeatedly returned the same blocked result before Antigravity could review.

`verification.ts` now separates actual check failures, environmental prerequisites
and ambiguous/missing evidence. Observed exit/output evidence takes precedence over
model reports. Assertion/compiler failures cannot be waived through a setup label
or a DNS message. An unobserved reported pass cannot establish required coverage.
Setup interruption remains unverified. Existing reports are retained verbatim.

Required checks survive later implementation reports. Earlier passes do not certify
changed code. An earlier assertion failure still needs a passing affected-check
rerun; an environmental failure in the repair cannot silently waive that obligation.
Requirements discovered by an independent reviewer are additive and survive repairs.
Observed failures from interrupted or failed runs also survive; their incomplete
provider output cannot assert success. Chronological passing reruns settle an older
failure. Stable distinct check names preserve the obligation when a repair replaces
a moved or ephemeral command, but the replacement needs its own observed result.
Duplicate names use exact command matching. Provider prompts request stable names.

A live issue-9 report exposed another evidence mismatch: the report named the
literal script while Codex's execution record included `/bin/bash -lc` around it.
The internal `verification-command.ts` now decodes one static known Bash/sh wrapper
for identity and command-purpose checks. The complete inner script still has to
match, including logging, redirections and pipelines. Dynamic expansion, malformed
quoting, extra arguments, custom shell paths and differing scripts remain unmatched.
This parser executes nothing and does not enable shell commands in missing-check
recovery. Original command records are retained unchanged. Required unobserved
passes still remain unknown. Concrete curl `Could not resolve host:` output is
classified as DNS failure. A blocked dependent setup inherits its known prerequisite
instead of adding a duplicate generic tooling root; unknown references stay blocked.

Reevaluating that task's saved records now observes its source review, Node version,
syntax check, browser inventory and mock-DOM execution. It qualifies for explicit
review with gaps while browser rendering/arithmetic/responsive checks remain
unexecuted. Its guidance search exited 1 because no files matched; this remains
recorded as blocked setup, not a passing check or application assertion failure.
No provider invocation, approval, installation or live command rerun was needed to
repair the evidence association. The requested validation-only rerun subsequently
recorded a new passing host diff check, five observed check passes, no required
unknowns and no application failures. Six required setup/browser obligations
remain incomplete, so only acknowledged gap review is eligible; fully verified
publication remains unavailable. The three prior agent runs were unchanged and
no new model ran. Measured follow-up verification passed 540 normal tests and
all eight Electron fixtures; see the newest section in VERIFICATION.md.

Named prerequisite edges form a cycle-safe dependency graph. Multiple semicolon
references and transitive dependencies retain each individual check while exposing
root tooling/DNS/socket/platform blockers. Missing/ambiguous edges do not grant
review authority. Technical check groups are expandable; root causes appear first.
Root counts include unresolved dependent items only; passed checks and real failures
remain in their own evidence groups.

## Transitions and human authority

The approved provider order remains Antigravity plan → Codex refinement → Codex
implementation → deterministic validation → Antigravity final review. Each plan,
implementation review and final acceptance retains its explicit human gate.

| Validation                                             | Backend decision                        | Next action                                       |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------- |
| All required checks passed                             | Normal implementation approval          | Authorize final review                            |
| Actual required assertion/compiler/lint/build failure  | Failed, no waiver                       | Explicit Codex repair                             |
| Every remaining requirement has an environmental cause | Verification incomplete                 | Inspect implementation and acknowledge exact gaps |
| Ambiguous legacy evidence or missing command exits     | Incomplete, not eligible for gap waiver | Inspect/rerun checks or explicit Codex repair     |

Review-gap approval binds the implementation artifact, worktree fingerprint and
hash of recorded evidence. The backend rejects stale or manufactured approvals
and rechecks authority immediately before stage 5. Restart preserves waiting
states without replaying inference. Saved instructions require an explicit
keep-saved/include-next-stage choice. Concurrent approvals cannot start a second
provider. Explicit repair request IDs prevent duplicate continuation delivery.
Rechecking never consumes queued instructions into an agent continuation, even
when it succeeds. Implementation continuations invalidate the old review verdict,
fingerprint, gap acknowledgment and canonical artifacts while retaining run history.

## Distinct recovery operations

| UI                             | RPC                                                          | Execution                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Recheck saved evidence         | `task.verification.recheck`                                  | Reruns pinned-base diff hygiene; evaluates saved outcomes; starts no AI/install/browser                                                    |
| Run missing checks             | `task.verification.run`                                      | Executes selected recognizable recorded npm, Node, pytest, compiler/linter or local-only Playwright argv through the existing task sandbox |
| Fix with Codex                 | `task.verification.fix`                                      | One explicitly authorized Codex iteration in the original worktree, with actual failure output and missing requirements                    |
| Continue to independent review | `reviewPreview` / `continueReview` under `task.verification` | Preview then explicit implementation approval plus environmental-gap acknowledgment                                                        |

Missing-check execution validates command structure and resolved prerequisites.
It never executes an installer, shell paragraph or inferred arbitrary script.
Package executables use `npx --offline --no-install`. Only these leading execution
restrictions are normalized when linking evidence; test arguments stay exact.
Explicitly selected matching browser capabilities may make a browser check runnable,
while retaining every original blocked setup result and application requirement.
Unsupported custom commands remain available through the existing explicit manual
argv form. Further Codex iterations require another user request. Failed setup is
included in repair context, with an instruction to inspect changed prerequisites
before another installation attempt. No automatic install/retry loop was added.

When there are no runnable recorded commands, the action is **Prepare missing
checks**. Its dialog lists every unresolved requirement with its actual readiness
reason: missing command, setup prerequisite, unresolved dependencies, unsupported
command or mutating flags. Browser-related gaps expose the existing capability
inspection and explicit environment selector inline. Opening these controls starts
no probe, installation or inference. **Prepare runnable checks with Codex** opens
the existing separate authorization for one iteration; its prompt now explicitly
requires repeatable scripts, supported check commands, stable requirement names
and honest remaining prerequisites. A successful capability probe never passes an
application requirement. A compound script still needs explicit manual execution
or a saved supported test command. Simple literal shell-wrapped checks can execute
as validated direct argv through the existing sandbox without invoking a shell.

This fixes the empty rerun action when a model saved `command: null`. It does not
invent browser tests from their names or hide environmental gaps. **Recheck saved
evidence** continues to perform its separate no-AI operation. Until the missing
tests actually execute, the task remains incomplete and may use the explicit
independent-review-with-gaps path when eligible.

## Independent review

The existing stage-5 AgentRunner stays read-only. Its managed artifact packet
contains the issue/scope, refined plan, implementation report, complete retained
command records and prior provider results. `output_truncated` remains visible;
omitted historical output is not proof of a pass. Source and the pinned-base diff,
including untracked files, remain available to the reviewer inside its sandbox.

Structured reviews retain `approval`, `findings`, `testsRun`, `testsNotRun` and
`summary`, with optional structured verification, environment limitations,
implementation concerns, severity/file/evidence issues and recommended actions.
Matching observed reviewer executions may settle requirements. A reviewer opinion
cannot replace a blocked test with a pass or discard an original requirement.

Persisted verdicts distinguish verified, code approved with incomplete verification,
changes requested, and blocked review. Accepting code with gaps enters
`reviewed_with_gaps`; it keeps changes local. Actual failures/implementation concerns
prevent acceptance. A changed worktree requires another review.

`canReview` retains its strict complete-verification meaning for Git Finalization.
No exceptional publication waiver was added. Selected files, exact messages,
reviewed fingerprints, approved destinations, branch/ref checks, ancestry,
separate push confirmation, journal history and uncertain-outcome recovery remain
in the existing finalization/publication services. Completing a task also rechecks
verification. Review approval never grants publication authority.

## Browser capability and interface

The existing fixed browser probe is reused unchanged. It detects project packages,
existing executable browsers, DNS, loopback sockets and independent direct-file/HTTP
capability. Environment selection remains explicit and applies only to supported
manual commands. Probes install nothing and cannot pass application requirements.
No provider sandbox, credential mount or unrestricted host/network path was added.

The pipeline uses compact timeline rows with actual provider/model/effort, execution
duration, activity and semantic status icons. Secondary actions live in keyboard
accessible disclosures. Amber incomplete verification has concrete recovery actions;
cancelled/interrupted states remain muted. Task navigation uses neutral selection,
truncation, fixed status icons and hover/focus actions, preserving right-click,
keyboard menus, editor opening, archiving and cleanup. Reduced motion is inherited
from the existing global motion policy. Final review shows code verdict, observed
test counts, required gaps and next action with complete details behind disclosure.
Implementation and final-review technical reports stay collapsed in chat. The
host-evidence recheck remains visible when missing checks pass so the user can
reopen the implementation approval gate without starting AI automatically.
Host preparation records optional real start/finish timestamps in task JSON;
historical missing durations stay unavailable. Genuine negative review verdicts use
red timeline/navigation states and expose Codex fixes even when tests passed.

## Reset Local Test Workspace

The existing `StorageService` / `storage.reset` are reused. `storage.resetPreview`
inventories task ownership, worktrees, branches, logs/artifacts, archived records,
repair sessions, finalizations, active processes and retained cache/runtime data.
Confirmation requires the exact preview token and typed `RESET LOCAL TEST WORKSPACE`.

Reset refuses active operations and unresolved sensitive Git operations. It creates
a private SQLite online backup, verifies `quick_check=ok`, saves the preview manifest,
copies retained log/artifact metadata and records the result. Existing cleanup
rechecks ownership/common directory, dirty/ignored/index state and unpushed commits
under the canonical Git lock before deleting eligible task data. Dirty, unpushed or
unknown resources remain with exact reasons. Settings, original repositories,
managed clones, user branches, official CLI authentication, repairs, finalizations
and independently owned Issue Watch/PR-analysis history are preserved. There is no
recursive data-root wipe, remote GitHub write or automatic AI start.

Recover by closing Vibestar, preserving the current root, then restoring the backed
up SQLite file and saved log/artifact metadata into a separate recovery root first.
Worktree/branch removal cannot be reversed by the database alone; eligible removed
worktrees have no unique local commits or dirty files. The manifest records their
pinned identities for manual reconstruction. Preserve a current root before any
manual recovery or migration.

### Actual local-data audit

Read-only inspection found `/home/aksha/.akkco-vibestar` configured by the normal
data-root selection: one task, three agent runs, 34 command records, five artifacts,
zero terminal sessions, zero repairs and zero Git Finalizations. The task is issue
9 in `akshajrawat/akkco-vibestar-test`, blocked at stage 4. Its positively owned
`akkco/9-whole-issue` worktree contains untracked `README.md`, `index.html`,
`script.js` and `style.css`; no unique unpushed commits were found. Those files and
the task were preserved. A standalone clone log has separate ownership and remains.
No real application reset or provider invocation was performed by the audit.
The retained task ID is `df777c82-a458-4503-b3de-b5eba8d553db`, at
`/home/aksha/.akkco-vibestar/worktrees/f011b5a1-b678-4ae4-aab2-eabee8f6e167/9-whole-issue`.
There are **zero eligible real tasks** to remove. Its three runs, 34 command records,
five database artifacts, task logs and branch remain attached to the protected work.
No archived tasks, terminal sessions, repairs or pending finalizations were found;
cache/runtime/artifact directories were empty. The original managed clone and
separately owned clone log remain. The application is therefore not claimed to have
a fresh real data root. A fixture reset demonstrated a clean reopen with settings,
repositories and provider connections intact, and no inference.

The initial read-only inventory is retained at
`/home/aksha/tmp/vibestar-v2-checks-20261025/local-data-inventory.json`.

### Confirmed fresh start after explicit follow-up

The user subsequently explicitly requested removal of the old data. Vibestar was
closed gracefully and no task agents or terminals were running. A private full
data-root copy and valid SQLite backup were saved outside the active root at
`/home/aksha/vibestar-backups/fresh-start-2026-10-25T14-13-07-960Z`.
All four untracked files were verified against their archived SHA-256 hashes before
removal from the old task workspace. The existing ownership-verified StorageService
then removed the now-clean task worktree, owned branch and task data. No cleanup
guard was weakened. Stale issue/GitHub/local discovery catalogs, logs and cache were
cleared; old migration/reset backups were moved to the external archive.

Reopening verified **zero tasks, agent runs/events, command records, artifacts,
usage records, terminals, repairs and finalizations**. SQLite `quick_check` was
`ok`, with no foreign-key errors or active blockers. The registered managed
repository and its index/HEAD were unchanged. Explicit policy/settings and official
provider/GitHub credentials were preserved. No model or remote write was invoked.
The complete before/after manifests and recoverable old source files are in the
external backup; the operational result is also retained at
`/home/aksha/tmp/vibestar-v2-checks-20261025/fresh-start-result.json`.
Normal catalog refresh may repopulate current discoveries when Vibestar reopens;
it does not restore deleted task or execution history.

## Repository verification policy fix

New tasks persist `verification_policy: repository`. Extra unexecuted manual
browser checks without a recorded command, and setup observations not needed by
outstanding application checks, are optional. Their original blocked/not-run
outcomes remain visible as skipped optional evidence. Executable automated tests,
explicit repository/issue requirements, demonstrated failures and historical
repair obligations remain required. The optional `scope` check field identifies
repository, issue, manual or discovery requirements; protected scope is additive
across reports and history. A later model cannot relabel it to weaken the gate.

Legacy tasks retain extended browser requirements until the user explicitly applies
`task.verification.policy` with confirmation. The shared recovery UI previews
those entries, exposes the policy change, and rechecks saved evidence without AI.
The operation is recorded in task activity. Prompts now use repository suites,
including their headless-browser tests, instead of imposing duplicate manual
browser launches/screenshots. User-requested manual acceptance remains mandatory.

Antigravity's finished tool output can encode its exit in an anchored
`Command exited with code N.` header. The adapter now retains that numeric exit;
explicit numeric metadata takes precedence. Recheck can recover missing exits from
original saved raw tool events. It never uses final model prose, application-printed
success text or file-read output to establish a pass, and does not replace known
exits. Rechecking a completed unchanged review preserves its fingerprint, accepted
state and canonical artifacts; stale source requires a new review. Restoring a
stricter policy or observing a genuine failure restores the appropriate safety gate.

The live task was backed up to
`/home/aksha/vibestar-backups/verification-policy-2026-10-25T16-11-17-469Z` and the
explicitly requested policy was applied. Deterministic recheck produced
**ready_for_review**, **verified**, and **zero required unverified checks**. All three
manual browser checks remain skipped; no test was invented. The same Antigravity
review hash and all four provider runs were retained, source was unchanged and no
new model ran. `live-policy-fix-result.json` records the result, and
`live-policy-ui.txt` confirms the native Windows UI exposed Validation completed,
Code approved / verification complete, and the normal Git Finalization action.
No commit or remote publication was performed. These optional JSON/schema fields
need no SQLite migration; schema version 24 remains unchanged.

## Persistence and verification

No SQLite migration is needed: optional task JSON fields persist gap acknowledgments,
final-review verdicts and preparation timing; the schema remains version 24.
Review schema additions remain backward compatible.
`core.info.pipeline_verification=2` protects recovery operations against old helpers.

Tests cover deterministic evidence classification, transitive prerequisites,
actual missing-check execution, rechecks without inference, stale acknowledgment,
restart, duplicate requests, explicit same-worktree Codex repair, independent
read-only review and publication refusal with gaps. Reset fixtures exercise online
backup validity, clean restart, imported source/index preservation, dirty/unpushed/
unknown ownership, active processes and stale previews. Built Electron acceptance
uses only fixture providers and isolated roots at 1920×1080, 1440×900 and 1280×720.
Measured command results and visually inspected screenshot paths are recorded in
[VERIFICATION.md](VERIFICATION.md).

## Acceptance evidence

| Requirement                                                                                         | Implementation and regression evidence                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three validation outcomes, trustworthy provenance and legacy behavior                               | `backend/execution/verification.ts`; `tests/verification.test.ts`                                                                                                                 |
| Root dependency graph, DNS/socket/browser/platform causes, transitive and cyclic edges              | `tests/verification.test.ts`; expandable root/check groups in `VerificationSummary`                                                                                               |
| Separate no-AI recheck, actual command execution, explicit bounded repair and acknowledged review   | `engine.ts`, `verification-recovery.ts`, strict RPCs; `tests/verification/recovery*.test.*`                                                                                       |
| Provider order, complete evidence packet, read-only review, restart and duplicate invocation guards | `agent-runner.ts`, `prompt.ts`; `tests/verification/recovery.test.ts`, existing approval/provider tests                                                                           |
| Honest final verdict and local-only acceptance with gaps                                            | `FinalReviewSummary.tsx`, `reviewed_with_gaps`; recovery UI/integration and desktop V2 fixtures                                                                                   |
| Git publication safety and fingerprint protections                                                  | Existing finalization/publication code retained; finalization normal tests, recovery refusal and built Git fixture                                                                |
| Installed tooling and direct-file/HTTP independence                                                 | Existing browser probe retained; `recovery-commands.test.ts`, `browser-environment.test.ts`                                                                                       |
| Compact timeline, real duration/model/activity, keyboard/narrow/reduced-motion behavior             | `TaskEngineering.tsx`, shared motion policy; workspace/verification UI tests and four-size V2 screenshots                                                                         |
| Neutral task selection, status, truncation, context menu/archive/editor/cleanup                     | `TaskNavigation.tsx`; `tests/workspace/navigation.test.tsx`, workspace desktop fixture                                                                                            |
| Preview, typed confirmation, valid backup, ownership and active/uncertain operation refusal         | Existing `StorageService`; `tests/storage-reset.test.ts`, storage/cleanup regressions, desktop reset screenshots                                                                  |
| Multiplication-table final acceptance                                                               | `tests/desktop-verification-v2.test.ts`: real source checks, simulated DNS/socket limits, explicit review, retained unverified checks, refused publication and safe fixture reset |

Automated inference uses fixture providers only. Git publication fixtures use
disposable local bare remotes. No live Codex/Antigravity allowance or GitHub write
was used. Native Windows/DPI acceptance was not repeated for this delivery; earlier
Windows results in the verification history belong to the October 24 delivery.
Unsupported arbitrary missing-check commands still need the existing explicit
manual argv flow. Environment capability and review opinions never certify an
unexecuted application check. Persistent output truncation, if present, is shown
to the reviewer and remains an evidence limitation.

## Files changed

- `ARCHITECTURE.md`
- `README.md`
- `backend/domain.ts`
- `backend/execution/agent-runner.ts`
- `backend/execution/command-executions.ts`
- `backend/execution/engine.ts`
- `backend/execution/prompt.ts`
- `backend/execution/providers/antigravity.ts`
- `backend/execution/providers/contracts.ts`
- `backend/execution/task-verification.ts`
- `backend/execution/verification-command.ts`
- `backend/execution/verification-recovery.ts`
- `backend/execution/verification.ts`
- `backend/main.ts`
- `backend/rpc.ts`
- `backend/storage/contracts.ts`
- `backend/storage/service.ts`
- `docs/PIPELINE-VERIFICATION-V2.md`
- `docs/VERIFICATION.md`
- `electron/bridge.ts`
- `src/components/AgentTimeline.tsx`
- `src/components/Status.tsx`
- `src/components/StoragePage.tsx`
- `src/components/StorageReset.tsx`
- `src/components/TaskNavigation.tsx`
- `src/components/TaskWorkspace.tsx`
- `src/components/TestsView.tsx`
- `src/components/VerificationSummary.tsx`
- `src/components/verification/FinalReviewSummary.tsx`
- `src/components/verification/VerificationRecovery.tsx`
- `src/components/workspace/TaskEngineering.tsx`
- `src/lib/agent-output/activity.ts`
- `src/lib/types.ts`
- `src/lib/verification.ts`
- `src/styles.css`
- `tests/command-executions.test.ts`
- `tests/core-bridge.test.ts`
- `tests/desktop-chat-workspace.test.ts`
- `tests/desktop-pipeline-approval.test.ts`
- `tests/desktop-verification-v2.test.ts`
- `tests/finalization/fixtures.ts`
- `tests/issue-watch/semantic.test.ts`
- `tests/pr-repair/persistence.test.ts`
- `tests/scope.test.ts`
- `tests/storage-reset.test.ts`
- `tests/verification.test.ts`
- `tests/verification/command-identity.test.ts`
- `tests/verification/policy-engine.test.ts`
- `tests/verification/policy.test.ts`
- `tests/verification/provider.ts`
- `tests/verification/recovery-commands.test.ts`
- `tests/verification/recovery-ui.test.tsx`
- `tests/verification/recovery.test.ts`
- `tests/verification/ui.test.tsx`
- `tests/workspace/layout.test.tsx`
- `tests/workspace/navigation.test.tsx`
