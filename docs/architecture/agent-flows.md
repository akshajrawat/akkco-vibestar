# Agent flows: implementation record

Vibestar provides solo agents (Vibers), editable directed acyclic flows and three
editable starting templates. The former Plan → Refine → Implement → Review workflow
is a template with explicit human approval nodes. This document records the delivered
behavior, migration boundaries, cleanup decisions and acceptance evidence.

Vibers have draft character bodies, eyes, visible ports and readable
name/provider/model/status labels. Appearance customization remains deferred.
The canvas represents real host execution while that visual identity evolves.

The clarified interaction model treats a Viber as a reusable profile/identity. A task
uses a distinct instance of that Viber in its graph, with task/node-scoped conversation
history. The same Viber can be used directly or added to several tasks without sharing
provider threads or silently carrying conversations between them. The Vibers library
creates and edits these identities, starts a direct task, and opens their existing
instances. Each agent in a connected crew has a chat view with its own draft, scroll
position and visible history selection. Completed messages from that instance are
included by default; long conversations require an explicit smaller selection. A conversation captures just that node,
forces conversational output and preserves its configured access and instructions.
It never completes graph work or starts connected successors.

## Original dependency trace

These paths describe the fixed-stage baseline before migration. Current ownership is
documented in `ARCHITECTURE.md`; the removed paths below explain the replacements.

| Concern               | Original owners and replacement requirements                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task creation         | `execution/engine/tasks.ts`, `rpc/tasks.ts`, `features/tasks/NewTask.tsx`: idle creation currently requires a repository and GitHub issue. General tasks need a real optional-context model.                          |
| Chat/startup          | `execution/engine/workflow.ts`: explicit startup, saved-message selection, workspace preparation and conversation threads. Preserve chat scope, reconciliation and scroll behavior during integration.                |
| Stage settings        | `domain.ts`, `execution/agents/prompt.ts`: legacy settings, prompts and artifacts are stage-indexed. Keep historical readers; new flows resolve profiles and output contracts explicitly.                             |
| Permissions           | `agents/agent-runner.ts`, `providers/{codex,antigravity,codex-conversation}.ts`: stage 3 previously granted both provider and outer-sandbox write authority. Explicit access now controls these boundaries.           |
| Approval/continuation | `engine/{approvals,verification}.ts`, `agents/continuation.ts`: bind approvals to viewed content, saved instructions and evidence. Replacement must bind each approval to a captured node configuration/input packet. |
| Shared execution      | `engine/{state,scheduling,agents}.ts`: global slots, maintenance/cancellation and manual terminal exclusion remain authoritative. The graph scheduler must use them.                                                  |
| Workspace identity    | `workspace/{git,paths,runtime}.ts`, `execution/runtime/sandbox.ts`: retain canonical ownership and isolation; repository-free tasks need an owned managed workspace.                                                  |
| Telemetry/history     | `storage/database.ts`, `execution/{output,verification}`, task messages and repair tables: keep existing run/event/command/usage IDs and owner separation. Link node attempts to these records.                       |
| Persistence           | `storage/{migrations,records,contracts}.ts`: preserve historical migrations, backup-before-upgrade, foreign keys, corrupt bytes and diagnostics.                                                                      |
| Existing tools        | `backend/scheduled`, `review`, `issue-watch`, terminals and editor/diff tools remain live dependencies. Their apparent absence from renderer imports does not make them dead.                                         |

## Implemented foundation

- Explicit runtime-validated execution settings separate provider, model, effort,
  timeout, workspace access and output contract. New calls can execute without a
  numeric stage. The existing executor still owns isolation, streaming, redaction,
  process lifetime, usage and observed command records.
- Provider adapters and the outer sandbox use explicit access. Task, repair and
  utility callers all use `AgentRunner.runConfigured`. The retired stage executor,
  prompt builder, startup/chat orchestration, approvals, continuation helper and
  verification recovery mutations have been removed. Historical stage fields and
  readers remain data contracts; repair stages remain recorded telemetry only.
- Migration 28 adds captured execution/output-schema snapshots to agent, utility
  and scheduled run records. Snapshots capture resolved settings before invocation;
  provider-reported model/effort remain separate telemetry. Old runs have null
  snapshots rather than reconstructed permission claims.
- Shared graph contracts validate agent, argv command and approval nodes, unique
  identities/connections, missing endpoints, cycles and explicit predecessor input
  bindings. Branches and joins are valid. Profile names grant no access or provider
  identity; node overrides cannot exceed a profile's supported access.
- Migration 29 and `FlowStore` persist profile revisions, executable flow revisions
  and independent canvas layout. Revision conflicts fail instead of overwriting
  history. Flow task ownership cannot be changed by an edit. Corrupt records use
  existing diagnostics and retain their original bytes. Existing task cleanup,
  disposal and reset refuse to remove workspace/evidence referenced by a saved flow.
- `@xyflow/react` powers the canvas over the persisted graph. Execution state comes
  from durable attempts and existing telemetry rather than a visual simulation.
- Migration 30 and `FlowRunStore` add run snapshots, append-only attempt identities,
  transition history, captured context, exact approval decisions and existing
  agent/command telemetry links. Snapshots are protected against updates. Run/node
  startup requests validate their captured authority; retries require the latest
  explicit attempt ID. Linked continuations preserve prior snapshots and close old
  pending approvals without inventing an accepted decision.
- The existing runner and controlled command path enforce node settings, selected
  context and workspace fingerprints before invocation. Selected command inputs
  arrive as JSON stdin. Successful process records, observed passing checks and
  approved review are separate completion requirements. Core restart interrupts
  unfinished work, preserves corrupt snapshot bytes and starts no provider.
- `context.ts` resolves task goal, selected repository/issue context, predecessor
  output, owned artifacts and observed verification records. Context omissions are
  not silent: unavailable/foreign sources and packets over 128 KiB fail explicitly.
  Observed commands and provider-reported checks retain separate attribution.
- Migration 31 makes task repository context nullable without changing historical
  task JSON, IDs or foreign-key references. `createGeneralTask` creates an idle task
  and solo graph using an existing selected profile, with null issue fields and no
  fabricated repository record. Creation starts no filesystem preparation or inference.
- Owned repository-free workspaces use a separate `workspaces` category, with owner
  markers outside the writable mount, bounded fingerprints and alias refusal. The
  shared sandbox, command capacity and terminal leases apply. Explicit shell opening
  can prepare the directory. Cache clearing and data-root migration preserve these
  files and their source ownership. Git-backed general tasks retain real worktrees
  and do not advance numeric workflow stages on restart.
- Migration 32 persists the exact scope and identity of flow, single-node and retry
  dispatches. `engine/flows.ts` schedules branches and joins through existing shared
  execution slots and terminal/maintenance leases. Pause completes the current node;
  stop aborts the process. Retry executes only the selected stopped node. Queue and
  active dispatches become interrupted on shutdown/restart without replay.
- Fresh approval decisions validate actual workspace fingerprints under a task lease.
  Duplicate decisions return their original result even if downstream work later
  changes the workspace, without authorizing another dispatch. Full-flow approvals
  can continue their existing scope; single-node approvals pause again. Observed
  checks remain separate from arbitrary successful commands and provider reports.
- Solo turns use the common graph controller and existing task message table, with
  explicit current-message and selected completed-history bindings. A write-capable
  solo profile can edit at stage zero. No profile-wide provider thread is shared.
- Validated RPC handlers and `agent_flows: 1` capability negotiation expose profile
  revisions, task creation, graph/layout editing, execution, node controls and task
  lifecycle. Managed-file inspection returns bounded owned text files with no false
  Git baseline. Existing Git changes, terminals, output and usage views are reused.
- New-task creation and the general-task workspace integrate a React Flow canvas
  with small Viber characters, eyes, input/output ports, provider/model labels, actual
  status and reduced motion. Profiles, commands, approvals and the three requested
  templates are available in the palette. The inspector edits explicit authority,
  instructions, handoffs and completion requirements. Saved layout is independent
  of executable revisions. Issue tasks now use the same flow workspace; untranslatable records use a read-only recovery/history view.
- Migrations 33–34 retain a node's observed completion fingerprint, immutable links
  to original results, bound continuation request plans and durable invalidation
  reasons. Historical attempts acquire null completion fingerprints, never invented
  evidence. A continuation preview checks exact profiles/nodes, dependencies,
  selected sources and workspace evidence. Applying it under a task lease captures
  a new linked run, reuses only proved results and explicitly recomputes stale work.
  Duplicate concurrent or settled requests share their original result without
  rerunning providers. Workspace changes during queueing invalidate links before
  execution. Reused usage/commands/events retain their original identities.
- The canvas marks changed results and their dependants stale and labels reused
  results separately. Saved-revision previews list reuse/recomputation decisions
  before execution, while started runs keep their captured revision. A selected
  running node shows actual recent activity. A waiting approval can be refreshed
  explicitly into a new attempt; its original attempt becomes interrupted without
  a fabricated decision. Accepting that node-only refresh pauses again until an
  explicit continuation. New continuation RPCs negotiate `flow_continuations: 1`.

- Migration 35 stores immutable original task bytes and conversion provenance. The
  full eight-node graph remains available; remaining work starts at the saved boundary
  in a historical checkpoint with no fabricated attempts, invocations or approvals.
  Missing/corrupt context rolls back translation and remains inspectable. Reopen never
  queues checkpoints. Explicit inspection captures new inputs and workspace integrity;
  imported final-review approval requires the old content fingerprint still to match.
- New issue creation selects profiles/templates directly, with scoped brief, notes,
  repository and issue bindings. It does not create historical migration records.
  Profile settings, navigation, overview and storage now expose the new model.
  Optimistic solo messages use the existing reconciliation helper; failed sends restore
  drafts without replacing later typing. Owned artifacts, saved messages and observed
  commands are selectable in the inspector; pending instructions remain explicit.

Migration 36 distinguishes graph runs from conversation turns and persists immutable
task/node/profile attribution on messages. Only messages linked to proven same-task
agent attempts are backfilled; unknown history remains unassigned and readable in
History. Separate chat turns share the task's lease and global slots. A paused or
waiting graph can coexist with a chat, while graph continuation and approval wait
for the chat to settle. Read-only chat preserves graph evidence. A write that changes
files, including a cancelled partial write, invalidates the parent graph and interrupts
undecided gates without inventing a decision. Fresh continuation previews or explicit
new graph runs capture subsequent work. File freshness is checked again when a graph
resumes after a node boundary.

The independently negotiated `viber_conversations: 1` capability covers `viber.chat`
and `viber.instances`. Solo and connected chat use this one route; the earlier
solo-only `flow.chat` route and wrapper were removed after migrating their callers
and regression tests. `flow.workspace` projects graph and conversation records
separately, keeping canvas completion honest. Selected retained attempt outputs and
observed verification can be shared intentionally within the same task; they do not
grant graph completion or approval. Essential context is bounded before inference.

## Acceptance

The full deterministic matrix, production build and six applicable built Electron
fixtures passed. The final audit covers profiles, task/context ownership, DAG
execution, explicit permission/output contracts, scoped conversations, immutable
attempts and continuations, conservative migration, canvas/navigation and preserved
PR/watch/repair/terminal behavior. All 27 pre-existing migrations remain unchanged;
new migrations are 28–36. Historical readers and data remain retained after cleanup.

See [the verification record](verification-history.md#2026-11-07--viber-migration-acceptance)
for actual counts, logs and fixture evidence. Appearance customization remains
future work. Native Windows/window-manager behavior and live subscriptions/GitHub
writes were not tested by the headless fixture acceptance.

## Cleanup decisions

The unused stage-to-JSON-schema helper `schemaFor` was replaced by explicit output
contract selection. Its transport regression now uses the canonical implementation
schema directly. Provider tests that inferred permission from stage 3 now test
explicit access, including a stage-3 read-only request and stage-1 write request.
Obsolete migration-version inventory assertions were replaced with the current
schema version and a foreign-key integrity check; migration/reopening regressions
remain covered.

The old `tests/workspace/workflow.test.ts` and `instructions.test.ts` suites used the
retired fixed-stage startup, conversation and future-stage RPCs, including an
expectation that old queues resume on restart. Their replacements are flow RPC,
engine, continuation, historical migration, explicit-access and workspace chat tests.
Three obsolete fixed-stage approval/gap scenarios were removed from mixed suites;
streamed-artifact readers, provider isolation and observed-failure regressions remain.
New issue profile/template tests replace stage model selectors. Source-checkout,
registry, crash recovery and dirty-settings regressions are retained and adapted.
Task-only renderer cleanup is complete: `TaskWorkspace`, `TaskEngineering`, `PlanView`, `TestsView`,
`VerificationRecovery`, `FinalReviewSummary` and `ComposerSettings` were replaced by
the flow canvas, inspector, scoped conversations and read-only history. The stage
settings wrapper was removed; general `AgentConfiguration` remains for Settings and
Issue Watch. Repair owns its action tray, secondary panel and context picker; the
dock lives in shared controls. Ninety selectors exclusive to removed controls were
removed while retaining surviving rule order. Mixed UI suites retain shared
timeline, output, terminal/drawer, command evidence and historical-reader coverage.
The old recovery UI and three fixed-pipeline desktop fixtures were removed; flow
fixtures cover the replacement controls. The output desktop fixture now uses an
explicitly started Viber flow. The unused `review.send` endpoint and service method
were removed; local note persistence, hashes and path protection remain tested.
Legacy local drafts remain inspectable in History without automatic assignment.
Historical migrations and `backend/scheduled` remain intact.

The fixed-stage engine classes (`workflow`, `approvals`, `verification`), stage
prompt/continuation/draft helpers, old runner entry point and 18 task mutations are
removed. The bridge explicitly rejects them even when an older helper claims their
old capabilities. General and issue creation require current profiles/graphs; new
issue creation preserves its existing request digest, transactional reservation and
tombstone behavior. Task-wide cancellation also waits for linked manual/utility
execution to settle, without changing the separate graph/conversation stop scopes.

Legacy conversation and recovery suites were removed with their interfaces.
Worktree isolation, base pinning, source checkout protection, storage migration,
editor paths, actual command failures, read-only provider review and PTY exclusion
were migrated to current explicit flows or isolated historical ownership fixtures.
Both providers execute all four roles in the editable full template with four
captured approval decisions. The failed-check regression also covers a later
provider failure without losing the observed failed result. Old account-dependent
pipeline desktop scripts were removed; native window assertions moved to their own
isolated fixture and the existing Windows harness remains available. Missing historical
execution settings produce recovery diagnostics instead of substituting current
defaults. Migration 36 preserves malformed configuration bytes and leaves those
messages unassigned; only a valid captured configuration can establish attribution.

Reuse is deliberately conservative: a full observed workspace fingerprint must
match a source result's completion evidence. A later writer can make an earlier
result ineligible even when some individual files appear unchanged. The preview
reports that recomputation before authorizing it; no read-set or historical
fingerprint is invented to increase the amount of reuse.

## Verification evidence

Focused tests cover stage-free read-only denial and authorized writes through the
real outer sandbox, immutable execution snapshots, graph validation, predecessor
bindings, profile capture and authority, migration/reopening/backup and revision
storage/ownership/corrupt-record behavior. Broader regression and final acceptance
results are recorded as they are actually run. No live provider or GitHub-write
tests are authorized by this change.
