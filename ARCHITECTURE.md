# Architecture

Akkco Vibestar is a local Electron workspace for issue contributions, PR analysis,
isolated repairs and manual issue discovery. Its architecture separates presentation
from the host authority that owns processes, files, Git and saved state.

Read [development](docs/development.md), [testing](docs/testing.md),
[security](docs/security.md) and [workflow contracts](docs/architecture/workflows.md)
for operational details. The [restructuring record](docs/architecture/restructuring.md)
tracks this repository preparation milestone.

## Runtime boundaries

```mermaid
flowchart LR
  UI[React renderer] --> Preload[Isolated preload API]
  Preload --> Main[Electron main process]
  Main <-->|JSON lines over stdio| Core[Node core in Linux or WSL]
  Core --> DB[(Local SQLite)]
  Core --> Git[Owned Git worktrees]
  Core --> Runner[AgentRunner and sandbox]
  Runner --> CLI[Official provider CLI]
  Core --> GH[Official gh client]
```

The renderer has no Node integration. Context isolation, Chromium sandboxing,
main-frame sender validation and restrictive navigation/window policies apply in
Electron. The preload exposes typed RPC, events, desktop configuration and window
controls. Repository content is rendered as text or safe Markdown without raw HTML.

`electron/bridge.ts` owns core startup, request correlation, events and compatibility
negotiation. Linux starts Node directly. Native Windows uses argv-safe WSL execution
with a constant launcher and structured configuration. There is no application HTTP
server or external database.

`backend/main.ts` validates the newline-delimited transport envelope. `core.info`
advertises protocol/build capabilities; the bridge blocks unsupported mutations
against older helpers while preserving available reads and cancellation.

## Core composition and RPC

`backend/rpc.ts` constructs the existing domain services and owns their shutdown.
An explicit method registry delegates to `backend/rpc/` handlers for tasks,
repositories, storage, terminals, repair, review, PR analysis, output and system
operations. Issue Watch retains its own service dispatcher.

Handlers keep runtime Zod validation, confirmation literals and owner checks next
to the operation they authorize. A transport UUID is correlation, not permission.
Unknown methods fail explicitly. No renderer-supplied executor, transport, arbitrary
hook command or test provider can cross this boundary.

Canonical persisted/domain contracts remain in `backend/domain.ts` and each domain's
`contracts.ts`. Zod-derived types are preferred at validated boundaries. Renderer
projections reference those contracts through type-only imports and retain sparse
historical fields where required. Security canonicalizers stay in trusted backend modules.

## Execution engine

`backend/execution/engine.ts` is the stable façade and startup/shutdown coordinator.
Its internal collaborators are grouped under `backend/execution/engine/`:

| Module            | Responsibility                                                                  |
| ----------------- | ------------------------------------------------------------------------------- |
| `state.ts`        | One authoritative set of execution slots, leases and cancellation state         |
| `scheduling.ts`   | Queue draining, active runs, terminal leases and maintenance exclusion          |
| `flows.ts`        | Durable graph dispatch, Viber conversations, node attempts and approval control |
| `tasks.ts`        | Idempotent issue/general task creation, request digests and initial persistence |
| `repositories.ts` | Registration, clone preparation, verified local connections and remotes         |
| `commands.ts`     | Sandboxed manual argv execution and observed command records                    |
| `agents.ts`       | Existing runner coordination for utility and repair work                        |

Collaborators share state rather than keeping independent concurrency counters.
They receive only the Engine methods and internal capabilities they need. Their
imports of Engine contracts are type-only; the façade remains the composition root.
Repository operations and captured flow requests settle before shutdown closes SQLite.

`execution/contracts.ts` defines explicit invocation access, provider configuration
and output contracts. `AgentRunner.runConfigured` uses those settings through the
existing process, sandbox, events, command evidence and usage path. Provider adapters
and the outer sandbox use explicit access; numeric stages do not grant permissions.
Task flows, PR repair and utility work all call that explicit executor. Repair phases
retain stage 3/5 solely as saved telemetry; the phase explicitly selects access and
output contracts. There is no fixed-stage task runner or legacy queue consumer.
Historical stage metadata and artifact readers remain supported. Migration 28 adds nullable execution
snapshots to existing run tables; it does not invent settings for historical runs.

`backend/flows/contracts.ts` owns shared validated profiles, DAG definitions, explicit
input bindings and separate canvas layout. `backend/flows/store.ts` saves immutable
profile/flow revisions with optimistic revision checks and owner-bound layouts
(migration 29). `run-store.ts` owns captured run/node inputs, execution links, transitions,
approval decisions and linked continuations (migration 30). Engine startup interrupts
unfinished runs without replay. `context.ts` resolves only selected owned sources and
rejects missing or oversized context. Agent and command invocations must match the
captured node settings, inputs and workspace evidence.

Task repository/issue context is nullable (migration 31). General tasks use the same
task/message/run tables as issue tasks. Repository-free files live in owned
`workspaces/<task-id>/files` directories; their owner markers remain outside the
agent's writable mount. `workspace/managed.ts` validates ownership and computes bounded
file integrity, rejecting aliases and special files. Explicit terminals can prepare
these directories without inference and share the existing task lease. Cache clearing
preserves them; data-root migration copies and revalidates them without deleting the
source. Saving profiles/tasks/configurations starts no process. Migration 32 stores
the scope and identity of each explicit graph execution request. The flow controller
uses shared slots and serializes branches in one workspace. Joins wait for every
predecessor, pause stops at a node boundary, cancellation aborts the current process,
and retries authorize only their selected node. Fresh approvals acquire a maintenance
lease and validate captured configuration, inputs and actual workspace evidence.

`backend/rpc/flows.ts` exposes validated profiles, drafts, layout, Viber turns and
execution controls, negotiated through `agent_flows: 1`. `src/features/flows` owns
the React Flow editor, Viber characters, inspector, profile library and task
workspace for general and issue tasks. Solo turns use existing task messages and explicit history bindings. Node
attempts reference the existing event/command/usage records. Task lifecycle is separate
from flow execution and verification. Migrations 33–34 retain completion
fingerprints, source-result links, continuation request plans and invalidation
evidence. `flows/continuation.ts` previews reuse against exact configurations,
dependencies, selected inputs and observed workspace state. Apply recomputes and
checks that plan under a task lease, creates a linked immutable run, and starts only
through a new explicit request. Reused telemetry keeps its original IDs. Missing
historical completion evidence is never reconstructed. Queued workspace changes
invalidate links before inference, and changed nodes invalidate downstream results
in the canvas. `flow_continuations: 1` is negotiated independently of initial flow
support. Migration 35 preserves exact historical task bytes and migration provenance.
`flows/legacy-migration.ts` retains the complete historical graph and translates the
saved boundary into an idle suffix checkpoint. Old approvals, exact input packets and
invocation settings remain unknown; no attempts, dispatches or decisions are invented.
Cancelled/failed/interrupted checkpoints retain their state. Missing or corrupt
context produces an inspectable recovery diagnostic with original source bytes. Missing
historical execution settings cannot be replaced with current defaults.
Explicit continuation captures current inputs; final-review inspection also requires
the original integrity fingerprint to match.

Migration 36 separates graph runs and conversation turns while sharing the same
runner, ownership, slots and telemetry. `viber_conversations: 1` negotiates the unified
`viber.chat` route and reusable identity/instance library independently. A conversation
captures one task/node/profile, keeps its access and instructions, and supplies only
selected inputs/history. It cannot complete graph nodes. Paused/waiting graphs can
coexist with a conversation; active execution remains serialized. Writes that change
the shared workspace invalidate parent graph authority, including partial writes on
failure or cancellation. Pending gates become interrupted without accepted decisions.
Graph resume rechecks the last node's workspace evidence. Message attribution is
backfilled only from proven same-task attempts; unassigned records remain readable
in History. Renderer drafts and scroll positions follow the task/node/profile scope. Ordinary
chat includes that instance’s completed conversation by default, with visible message
selection. More than 50 messages requires an explicit smaller selection; the 128 KiB
context limit still fails before inference. No conversation is silently truncated.

New issue creation uses `task.createIssue`, selected profiles/templates and explicit
goal/brief/repository/issue bindings. It starts no inference. `flow.workspace` exposes
original history separately from current attempts. The retired fixed-workflow RPCs
are unregistered, and the desktop bridge refuses to forward them even to an older
helper. New issue tasks always require an explicit profile/template and retain the
existing issue-request digest and tombstone contract. Snapshot navigation reports saved flow
status and recorded checks independently from task lifecycle. Storage exposes graph
record counts and managed-file sizes; executed flow evidence is retained, while
explicit deletion of an idle draft preserves request tombstones. See the
[agent-flow implementation record](docs/architecture/agent-flows.md) for the remaining work.

`execution/agents` owns AgentRunner, explicit output contracts and UtilityAI.
`execution/providers` adapts official Codex and Antigravity CLI capabilities and output.
Ordinary Codex conversation uses app-server initialization, thread and turn messages
inside the mandatory outer sandbox. Completed conversations can resume their saved
thread for the same task, model and effort; interrupted turns are never replayed.
Each explicit turn owns its process and closes stdin on completion. The sandbox masks
user and project Codex configuration for this path while authentication and thread storage remain
CLI-owned. Successful official discovery is reused for up to 30 seconds; explicit
provider refresh and failed runs invalidate that cache. Workflow stages keep bounded
CLI/schema invocations and independent approval authority. App-server streaming items
normalize to the existing persisted event contracts. Antigravity continues an explicitly
identified completed conversation through its documented `--conversation` CLI option.
Antigravity sends one JSON user message through the documented streamed stdin protocol
and reads its schema from the mounted artifact file, keeping large issue context out of
process argv. The runner closes stdin after that message, completing one authorized turn.
Conversation turns use ordinary provider prose without an output schema. New sessions
receive project context and bounded completed history once; resumed turns receive only
the new user message. Workflow schemas and instructions remain exclusive to workflow runs.
`execution/runtime` owns process execution and the outer sandbox. `execution/output`
owns bounded output, streaming redaction and reported usage. `execution/terminals`
separates ephemeral login PTYs from owned task/repair shells. `execution/verification`
owns observed command evidence, historical policy summaries and browser capability diagnostics.

## Issue tasks and approval flow

```mermaid
flowchart TD
  Create[Create idle task] --> Chat[Optional read-only chat]
  Create --> Start[Explicit start workflow]
  Chat --> Start
  Start --> Prepare[Prepare owned worktree]
  Prepare --> Plan[Plan]
  Plan --> Gate1[Human approval]
  Gate1 --> Refine[Plan refinement]
  Refine --> Gate2[Human approval]
  Gate2 --> Implement[Implementation and agent-run checks]
  Implement --> Gate3[Human approval]
  Gate3 --> Review[Independent read-only review]
  Review --> Verdict[Final verdict and next steps; workflow stops]
  Verdict --> Followup[Explicit chat fixes with selected model]
  Verdict --> Ready[Manual review and Git commands]
```

Creation persists `not_started`; it starts no provider or worktree preparation.
Explicit startup binds request identity, provider settings and selected completed
conversation messages or a reviewed summary. Historical authorized queue entries
keep their saved semantics. Idle chat uses a read-only stage-1 sandbox and never
creates a plan artifact or advances pipeline authority.
Complete greetings, thanks and app-identity questions use an empty managed conversation workspace, so they
skip cloning, worktree setup and source fingerprinting while retaining real provider
inference, task-owned history, usage and execution slots. New sessions identify Akkco
Vibestar as the host app. Repository questions use the owned worktree. Provider threads
are reused only within the same workspace scope and read/write authority, determined
from host-owned task state and saved user-message records.

The first planner receives the complete issue/comments and the scoped user brief; refinement
receives that brief and the original plan. Implementation receives the refined plan directly,
plus explicitly delivered user instructions when present. These are provider user messages,
also rendered as user turns in chat. Schemas still validate each stage's saved artifact. Long
user turns have a bounded preview with Show more/less. Thinking activity uses a
disclosure during execution; completed turns show Worked for with the final reply
outside the disclosure. Scrolled history exposes an explicit jump-to-latest control.

Each stage saves its own provider, model, effort and timeout. Codex and Antigravity
can fill any role; sandbox permissions follow the stage, independently of the chosen
provider. PR repair uses the saved implementation and review providers. Changing a
future stage starts no process and cannot rewrite a completed run. Legacy settings
and stage/gate identifiers retain their historical defaults and persisted spelling.
The bridge requires the per-stage-provider capability before workflow mutations.

Plans and implementation results pause durably. Feedback, retries and recovered
drafts retain their original stage boundaries. A saved pending instruction requires
an explicit inclusion decision. Cancellation and restart preserve evidence and do
not imply permission to rerun a provider. Final review ends at stage 6 with its fingerprint
and verdict; queued feedback becomes saved instructions and never restarts implementation.
Verified changes become ready for manual completion; findings or evidence gaps remain
`reviewed_with_gaps`. Historical final-acceptance gates remain readable and actionable.
After review, an explicit chat turn uses stage-3 workspace permissions and the selected
composer model, with the previous plan/results available as context. It creates no workflow
artifact and schedules no subsequent stage. Actual edits, including edits from a failed
turn, invalidate review authority. Manual task completion still requires current verified content.
The request carries explicit workspace access in its chat configuration; older callers retain
read-only semantics. The bridge requires the core's `workspace_chat: 1` capability before
forwarding an edit-capable chat request.

## Workspaces and filesystem ownership

`backend/workspace` owns Git operations, registered/imported sources, physical paths,
worktree identity, runtime mounts and editor launch. Each task pins its base branch
and commit and receives a dedicated owned branch. An explicitly started workflow can
use the registered source checkout when it is clean, on the configured base branch,
at the fetched base commit, and unreserved. Other tasks use separate worktrees;
dirty or busy source files are never committed, stashed or switched for another task.
Read-only pre-workflow chat and historical queued tasks retain isolated worktrees.
Repair assignments
reuse the physical contract without pretending to be issue tasks.

Managed paths are checked against the canonical startup root with no-follow parent
inspection. Category/repository/worktree aliases, unknown ownership and replaced
roots fail closed. Imported source checkouts are a separate explicit boundary.
Common-directory locks and branch/workspace/destination leases serialize writers.
Creation/removal checkpoints include process-start identity for crash recovery.

Agents see only their assigned source/runtime boundary. Ignored source
dependencies, including nested package directories, and recognized toolchains can be
mounted read-only; they are not copied or installed automatically. Nested mounts require
canonical directories and ignored/untracked dependency contents. Isolated worktrees also
require an empty owned destination; source assignments bind their installed dependencies
read-only in place. Aliases and tracked dependencies are never overlaid.
Refined plans carry dependency/browser/toolchain prerequisites into implementation.
Sandbox package runners default to offline npm and no-index pip operation.
Read-only planning/review cannot modify source or Git.
Source assignments persist an explicit mode, canonical registered path, common-directory
checkpoint and task/branch owner markers. Every use verifies that identity. Their provider
sandbox mounts Git metadata and recognized installed dependencies read-only even during
implementation. The source reservation survives pauses and restart; reuse requires a
known completed, cancelled or preserved owner with no active operation, and a clean
checkout manually returned to the base branch. Task cleanup never removes or resets a
source checkout; the existing history-only action preserves its files and branch. Managed
source assignments migrate with their repository; imported assignments retain the existing
requirement to keep their original storage location.
External editors and explicit manual terminals operate under the user's own environment.

Repository discovery searches configured project folders and known imported sources.
Home scanning is an explicit advanced option. Traversal skips temporary, generated,
dependency and managed trees; an explicit location can still name a legitimate
checkout under a temporary folder. Physical paths and Git common directories keep
managed task worktrees out of external-import candidates.
A read-only canonical-path lookup selects known registrations, including aliases,
before the external-import flow; it grants no import or execution capability.

## Persistence and recovery

`backend/storage/database.ts` owns SQLite with WAL, foreign keys and validated
migration transactions. Opening an older database creates a private asynchronous
backup before applying pending migrations. Existing migrations are retained unchanged.

`storage/records.ts` quarantines invalid collection records with payload-free
diagnostics and preserves original bytes. Exact owner reads refuse corrupt authority
records. Display fallbacks cannot become executable settings or invented ownership.
Task request tombstones prevent retries from recreating deleted history.

Root migration uses checked paths, a SQLite backup and a staged promotion journal.
Imported live worktrees are not silently relocated. Task disposal verifies ownership,
content and expected branch SHA. Ordinary cleanup protects dirty, ignored, hidden-index
and unpublished work. Deliberate discard requires a fresh preview and explicit loss
acknowledgment. History-only removal preserves an archived ownership record.

## Verification and review

Observed host/provider command records, provider-reported tests and environmental
prerequisites retain separate provenance. A model claim does not prove a check passed.
Unknown exits, skipped commands and missing evidence remain unverified.

Node completion records process outcome separately from observed checks and required
independent review. A failed assertion stays failed even if the model reports success
or its process later fails. Explicit retries append attempts; command nodes and the
manual command form run selected argv through the existing sandbox. Browser capability
diagnostics require an explicit request and remain separate from actual check results.

The full template pauses at configured approval nodes. Its implementation requires
observed passing checks; the reviewer stays read-only. Other saved profiles may use
record-only verification. Lifecycle completion/archive does not manufacture passing
checks or an approved review. Historical stage-4 records and their verification
summaries remain readable; the old stage-specific recovery mutations are retired.

Codex implementation commands have network access for test servers within the mandatory
filesystem sandbox; it does not authorize dependency installation. Planning and review retain their
read-only provider mode and source/Git mounts; unavailable independent checks remain visible.

## GitHub, PR analysis and repair

`backend/github` uses official `gh` authentication and bounded API reads. Repository
metadata and authored PR discovery are independent of local clones. Refresh is explicit;
search absence never proves closure. Partial retrieval preserves prior complete state.
The PR inbox refresh calls `github.pullRequests.refresh`: GraphQL search includes lifecycle,
head and title metadata for up to 100 PRs per page, with batched identity lookups for
known PRs absent from search. It skips the repository catalog and has a 30-second
overall deadline. Repository catalog sync remains a separate action. Metadata observation
timestamps keep older analysis snapshots from overriding freshly observed lifecycle.

`backend/review/pr/watch.ts` owns the lightweight, once-per-app-launch PR attention
check and explicit **Recheck open PRs**. The app calls the capability-negotiated watch
endpoint once after startup; renderer remounts/focus are deduplicated by the core.
It refreshes metadata, reads up to four PR conversations concurrently through GraphQL,
and retrieves PR bodies, review requests, comments/threads and linked issue bodies.
Reviewer assignments and unresolved thread markers alone do not mean the viewer owes
work. Complete conversations are checked for unanswered requests and later follow-ups;
substantive author replies can mean waiting for the reviewer even if an older formal
changes-requested decision remains. The authenticated viewer's own requests are excluded.
Conversations share a compact classification
prompt, using the saved review model or utility fallback. No diffs, commits, CI history
or filesystem tool turns are requested. Large/incomplete data stays uncertain; it cannot
become a clear result. Source IDs are validated, unchanged successful results are reused,
and Stop aborts concurrent reads and inference without automatic retries. The latest
bounded watch state is stored through the existing settings/record-recovery boundary;
run prompts, reported usage and redacted logs use the existing UtilityAI runner and slots.
Interrupted/cancelled/failed watches require explicit recheck instead of startup replay.

`backend/scheduled` remains the legacy-named coordinator for explicit engineering
analysis. `backend/review/pr/analysis.ts` owns complete-context reports, source-linked
observations and report reuse for repair preparation. Opening a report, filtering or
refreshing metadata does not start detailed analysis. Legacy batch history remains readable.
Detailed analysis includes source packets and coverage validation; moderate contexts are
supplied directly and large contexts remain in complete packets. Both quick watch and
explicit analysis honor the saved model timeout and temporary picker overrides.

`backend/review/repair` owns immutable PR identity, selected observations, isolated
head/base preparation, upstream integration and conflict recovery.
Implementation followed by independent read-only review stops at manual
review. Users commit and push manually in the built-in terminal.
Repair history, usage, commands and three diff baselines remain distinguishable.

## Issue Watch

`backend/issue-watch` owns strict criteria revisions, deterministic exclusions,
tracker/claim evidence, bounded collection, semantic screening and saved results.
Saving/opening a watch never scans. Each explicit scan/retry/continuation creates
its own durable attempt and reserves at most one semantic invocation.
Discovery reads one page of up to ten issues, ordered by creation time (newest or
oldest). Each saved attempt records its page/order/next page, and Next 10 explicitly
authorizes a new attempt. Earlier candidates are not fetched again. Successfully
checked batches accumulate saved results without advancing repository-wide coverage.
Search pages can shift as GitHub issues change; page history is not an atomic snapshot.
Issue Watch serializes its GitHub reads across watches and stops for a minimum
60-second cooldown after a rate-limit error, with no automatic retries. The host
caps each attempt at 80 requests, including tracker and PR evidence. A bounded
SQLite HTTP cache (migration 27, at most 20 MiB / 1,000 entries) stores response
bodies and ETags. Authenticated conditional gh requests must return 304 before any
cached body is reused; failed requests never authorize stale-cache fallback.
Clearing the application cache also clears these HTTP entries.

Partial/cancelled/interrupted attempts retain evidence without advancing the last
complete baseline. Missing coverage stays uncertain. A final metadata recheck
prevents stale provider conclusions from overriding host facts. Issue Watch uses
the existing GitHub client, AgentRunner, usage and output services without cloning.

## Manual terminals and Git

Task and PR repair workspaces expose an explicit built-in terminal backed by a PTY
in the Linux/WSL core. The core verifies worktree ownership before starting the user's
configured interactive shell in that worktree. Like an editor's integrated terminal,
this user-operated shell inherits the normal environment, Git configuration and CLI
authentication; it runs outside the agent sandbox. It can run Git hooks and arbitrary
commands with the user's own authority. Provider and manual verification commands
continue through the mandatory sandbox and restricted Git executor.

Showing Terminal starts and focuses the shell, taking the existing task or repair
lease; close the shell before running an agent in the same workspace. Repeated opens
share one session, and hiding the dock retains it. Sessions survive renderer
reattachment, use bounded redacted output and stop on core shutdown. Before startup,
the core adds a missing `origin` alias in managed clones using the registered fork URL
or upstream URL. Existing remotes and imported checkout configuration stay untouched.
The bridge negotiates manual terminal support separately from legacy sandboxed PTYs.

The application has no commit/push dialogs, selected-file finalization, publication
RPCs, presets or destination configuration workflow. Users stage, commit, configure
remotes and push through terminal commands. Historical SQLite migrations and Git
journals remain for restart safety and conservative storage protection; they never
replay operations or grant permission for a new write. Contributor Husky hooks remain
optional quality checks installed without overwriting existing private hook policies.

## Renderer and styles

`src/app` owns composition and navigation. `src/features` groups tasks, flows, chat,
verification, repositories, pull requests/repair, Issue Watch,
providers, settings and usage. Task completion and repair review provide direct
access to the shared terminal dock for manual commands.

Issue Watch presents a saved-topic overview and dedicated results, with local sorting
across classifications. Its compact availability display downgrades provisional or
historical positive claims; opening and sorting remain read-only. Matching issues
appear by default, with exclusions accessible through All results.

Shared primitives live in `components/ui`; shared workspace and diff controls live
in `components/shared` and `components/diff`. Reusable hooks live in `src/hooks`;
feature hooks stay with their owners.

Task approval controls live in the selected node inspector. Flow, chat, files, checks,
logs, usage and imported history share the task workspace. Explicit saved input
bindings replace implicit stage handoffs. Profile edits apply to future runs; node
attempts retain their captured settings. PR repair retains its shared secondary
workspace and dock. Repository rows separate identity, metadata and actions.

Flow navigation stores the selected view and node in `lib/taskView.ts`. Command-palette
commands and global usage links open the corresponding flow view and actual run.
`FlowWorkspace` reuses `components/shared/BottomDock` and `useWorkspaceKeys`, retaining an
attached terminal while its dock is hidden or another utility tab is selected. These
view operations authorize no agent execution.

The unmounted fixed-pipeline `TaskWorkspace`, stage engineering/plan/recovery views
and stage settings/composer model picker have been removed. `AgentConfiguration`
remains a general provider control for Settings and Issue Watch. Repair owns its
secondary panel, action tray and context picker; the dock remains shared with flows.
Historical verification and exact command transcripts are read-only flow/history
views. Legacy local drafts and saved instruction selections remain inspectable in
History without assigning them to a Viber or authorizing execution.

Command filters use recorded run/attempt identity, including direct command nodes,
instead of fixed stage numbers. The node inspector also shows actual activity from
an active conversation without completing its graph node. The unused `review.send`
mutation was removed; local review notes, source hashes and read-only inspection
remain available. The renderer contains no fixed-pipeline task execution controls.

Task and PR repair share the chat surface, composer, optimistic-message reconciliation
and event timeline. Server echoes replace optimistic rows by identity; submission failures
restore the sent draft without replacing later typing. Scroll position and follow intent
are scoped to a workspace visit, with resize-driven following and an explicit Latest action.
Messages stay in natural document flow without viewport-sized spacers or top anchoring.
Workflow prompts appear as ordinary user messages; idle tasks show a short welcome.
Completed activity folds under an elapsed “Worked for…” disclosure with assistant replies
visible below it. Provider input echoes and diagnostic tool metadata stay out of chat;
raw logs retain the technical evidence. Preparation commands stay in workflow/run tools. Owner-scoped
message caches retain real deltas across the bounded detail window and recover missing
prefixes through existing paginated event reads, without starting providers. Changed-file summaries
belong to implementation turns; final review messages distinguish code approval from
observed verification and explain the remaining manual step. Historical stage 4 records and their saved evidence retain their original identifiers.

`src/lib/api.ts` owns transport and error presentation. Display formatting lives in
`lib/format.ts`; chat event decoding and verification argv parsing live in their
features. Existing view-state, keyboard, focus, diff and usage helpers are reused.
The unmounted selected-code UI and its exclusive legacy styles were removed; backend
selected-code review contracts and history remain intact.

`src/styles/index.css` imports Tailwind and ordered CSS chapters. Base tokens,
fonts, controls, feature rules and later refinements preserve the original cascade,
focus, responsive, motion and reduced-motion behavior. Font URLs resolve to bundled
Geist assets; its OFL notice is copied from `public` into the production renderer.
Shared controlled pickers provide search, keyboard selection, viewport containment
and focus return. Neutral selection and focus tokens are independent of semantic
status colors. Provider/model marks use local licensed assets with functional fallbacks;
model vendor identity never replaces the identity of the actual connected CLI.

## Extension and verification discipline

Add provider integrations behind the existing provider contract. Add RPC methods
within their domain handler with strict runtime validation. Extend domain schemas
and persistence deliberately; do not widen preload capabilities for convenience.
Avoid generic frameworks, catch-all utilities and new barrels without a real boundary.

Prettier is authoritative. Named Vitest projects separate regular feature/unit,
integration, security, PTY, desktop and live suites. Routine CI starts no paid model
or real GitHub write. Production builds retain the renderer, Electron entries,
Node-native addons and locked WSL helper resources.
Packaging maps `dist-core/node_modules` explicitly because electron-builder excludes a
resource root's `node_modules` by default. Linux-built helper addons remain Node ABI binaries;
Windows hosts execute that helper inside WSL. The project license and third-party notice
are included alongside the bundled font notice. The helper build and WSL install payload
also retain the project MIT license. See testing for acceptance gates.
