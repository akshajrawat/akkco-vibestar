# akkco vibestar architecture

## Premium workspace and Git Finalization

The October 24 delivery retains the Electron renderer / Linux or WSL core boundary
and existing chat-first task/repair architecture.
[Delivery contracts and acceptance](docs/PREMIUM-UX-GIT-FINALIZATION.md) and
[measured verification](docs/VERIFICATION.md) describe the implementation and limits.
Earlier milestone sections below remain historical records. Current acceptance
passed normal/integration/PTY/build, seven built Electron fixtures, actual installed
browser checks and native Windows window checks on two displays at 125%/150% DPI.

### Renderer foundations and pages

Desktop navigation checks verify immediate inert state and then completed exit,
matching the short presence transition while preserving keyboard shortcut checks.
Desktop analytics captures also use explicitly labelled fixture token samples with
partial coverage, retaining a missing-total row and no invented production totals.
Acceptance screenshots finish finite animations before capture so at-rest contrast
and layout are evaluated independently of transition timing.

Semantic charcoal surface/text/status/focus/spacing/radius tokens in src/styles.css
serve shared Button, PageHeader, EmptyState and ListSkeleton components and native
labelled controls. Bundled local Geist Sans/Mono WOFF2 assets serve UI, code, diffs
and xterm; Vite copies public/Geist-OFL.txt into dist. Lucide remains the icon family.
Motion handles navigation presence and selected navigation/workspace indicators;
CSS handles short surface/result/control transitions. Exiting navigation becomes
inert immediately. MotionConfig and CSS honor reduced motion. Stable saved keys,
bounded code highlighting and paged logs/history avoid per-event layout animation.
Existing per-task pane state and PTY mount/lease lifetime remain authoritative.

ScheduledPage merges saved GitHub PR discoveries and legacy records, with search,
repository/status/review filters, metrics and distinct connection/loading/error/
empty states. Opening a discovered PR creates only an inactive analysis record;
Analyze is explicit. GitHubService retains paginated/partitioned authored discovery,
commits catalog changes only after complete retrieval, persists last-sync/error
and preserves earlier data on partial failure. REST detail state wins over search
state; task links require a current unique upstream/fork/head association. Existing
analysis/repair identity and manual-only inference contracts are unchanged.

Issue Watch hides empty panes during onboarding and retains its real scan phases,
grounded counts, candidate groups/filters/evidence and explicit Scan Now authority.
Repositories retains local import/scanning, managed-clone progress and identities.
Providers displays actual connection/account/CLI/model/capability/error information.
Settings groups controls with validation and dirty/save feedback; background
snapshots do not replace dirty edits. Optional antigravity_review settings fall back
to antigravity for old JSON, while new tasks and repair sessions snapshot separate
final-review configuration. Existing task stage overrides still take precedence.

Usage aggregates only reported telemetry. Independent token channels show coverage
and overlapping cached/reasoning semantics without deriving missing totals. UTC
daily charts, runtime/task distributions and official allowance snapshots retain
unavailable states. Global history searches/filters/pages every matching saved run
in groups of fifty; scoped task/repair collections retain their disclosure history.
Background retrieval keeps prior rows and prevents overlapping polls.

MarkdownContent renders safe GFM without raw repository HTML, bounds lexical code
highlighting and copies exact fenced text. Pipeline derives stages from persisted
runs/approval gates, shares runActivity with CurrentRun, and treats missing exits as
unknown. Tests separates observed commands from provider reports, highlights root
prerequisites and groups required failures, blocked/not-run/passed checks and
optional evidence without altering transcripts or approval classifications.

### Browser verification environment

backend/execution/browser owns strict environment/report contracts and a fixed
20-second host-authored diagnostic. Task JSON optionally persists isolated or
installed_browsers mode and a validated capability report. Only explicitly selected
manual commands apply that profile; provider and terminal mounts stay unchanged.
Existing physical Playwright cache and Chrome directories can be mounted read-only;
aliases/private directories are refused. Probe observations distinguish installed
packages/binaries, DNS, loopback socket, direct-file and HTTP loading. No install,
inference or application-check waiver occurs.

Tests opens the disclosure without a probe. Use environment explicitly configures
the choice; Inspect separately records diagnostic commands through the existing
lifecycle. Unapplied choices survive snapshots; changing the choice clears stale
reports. Prompts inspect installed tools before downloads and distinguish manual
capability from provider-internal restrictions. Browser capability success cannot
satisfy required application verification.

### Selected-file Git finalization

backend/finalization groups strict contracts, store, files, workspaces and service.
Inspection verifies positively owned task worktrees/branches against the registered
Git common directory and records source/content/index fingerprints. Physical
bounded no-follow file inspection rejects credential/provider/cloud/private-key
paths and detected secret patterns, unexpected binaries, generated/debug additions,
aliases, links and submodules. Ignored files remain unselectable.

Preview creates an owned vibestar-finalization/<UUID> worktree/branch and stages
only exact literal selected paths in a separate index. Task/source files and index
remain intact. Selected existing staged content requires an explicit decision;
excluded index entries survive local commit, including rename/deletion cases.
The cumulative projected patch includes prior task commits. Full identical content
can reuse its final review; subsets/fingerprint changes require an explicit
read-only Antigravity review with git-finalization-review purpose. AgentRunner and
the engine's shared execution-slot reservation provide telemetry, cancellation and
provider limits without replacing canonical pipeline artifacts.

taskVerification is checked before selection, approval, commit and publication.
A fresh review must settle original required application commands; missing evidence
persists as verification_gap separately from the original provider verdict.
Host projected diff hygiene executes independently. Manual approval binds the exact
reviewed tree. Exact commit creation in workspace/commit-message.ts writes immutable
UTF-8 Git objects without trimming, templates, trailers or a final newline. Both
repair and ordinary tasks use it. The journal precedes compare-and-swap branch and
selected-index restoration; original/projected index snapshots support recovery.

Normal optional hooks use only authorized repository/worktree core.hooksPath or
shared hooks. The effective configuration is captured with the preview and
rechecked; changes require a new preview or explicit skip. /dev/null is visibly
repository-disabled policy. Hooks run in the read-only sandbox without provider
state, with the exact message mounted read-only and a 1 MiB / 2,048-line budget.
Unsupported paths/missing configured hooks/mutating behavior stop clearly.
Typed per-task presets contain only name, hook/push policy, remote and branch;
arbitrary command strings cannot execute. Optional skip never waives host gates.

Preparation verifies actual fetch/push URLs, canonical configured contribution
fork/upstream, current viewer, stable GitHub repository ID, permission and exact
remote SHA/absence. Upstream destinations are refused. The same local commit may
be rebound to another safe feature branch after fresh preparation. Publication has
a separate explicit destination/commit/SHA confirmation, rechecks all authority
and content, shares workspace/repository/branch/destination leases with other writers
and verifies the resulting remote object before claiming success.

workspace/publication.ts is the independent shared final boundary for tasks and
repair. It proves proposed immutable commit ancestry against the exact expected
remote object, then applies one explicit ref/object compare-and-swap lease. Git
names this force-with-lease; host ancestry proof permits only fast-forward updates.
New branches require a pinned ancestor and an exact absent-ref lease. Broad force,
plus refspecs and wildcard leases are prohibited. The repair private pre-push hook
is defense in depth; --no-verify cannot bypass this host boundary.

### Persistence, recovery and API

Migration 24 adds git_finalizations, git_operation_events and task_git_presets
with task/operation foreign keys and history indexes. Database.open retains its
private backup-before-migration behavior. A dedicated version-23 upgrade/reopen
fixture checks unchanged task/review/PR/usage/settings and valid foreign keys.
Strict records check JSON ID/task owner against persisted ownership; globally
colliding request IDs cannot overwrite another task's journal. Renderer views omit
internal index snapshots, process identities and request digests.

Redacted events retain real phases, exits and timestamps. Each event has a UTF-8
safe 64 KiB tail limit with omission marker; journal pages return 200 events plus
an older cursor. git.output reads only saved history. git.detail adds bounded staged
diff or a separate diff_error, so missing preview files cannot hide diagnostics or
be presented as a clean tree. These limits do not truncate integrity inputs.

Cancellation terminates the tracked process group. Startup checks saved process
start identity, interrupts incomplete local mutations and marks pushes uncertain.
Reconciliation is read-only. Explicit resumeCommit applies only the original
journaled branch/index transition without duplicating commits. Ambiguous publication
must reconcile before new preparation/confirmation. Cleanup refuses unresolved
journals, changed previews and unknown ownership. Explicit remove deletes only its
unchanged positively owned preview/branch/history, preserving task/local commits;
task cleanup cannot orphan previews. Early pre-marker crashes remain preserved for
manual inspection.

core.info advertises git_finalization:1, exact_commit_messages,
browser_verification_environment and independent_final_review. The bridge blocks
unsupported mutations on older helpers. RPCs cover inspect, preview, explicit review
and approval, exact commit, prepare/publish, typed presets, paged detail/output,
cancel/reconcile/resumeCommit and confirmed removal. Browser configure is confirmed;
browser inspect is a separate diagnostic action. GitFinalization is a focus-contained
ready/completed-task dialog with path search, selected diff, exact persisted message
draft, review/approval, presets, verified destination, separate push confirmation,
real progress/cancel/recovery/history and explicit removal. Ordered inspection
responses cannot overwrite newer state; progress uses lightweight output reads.

### Continuous integration and evidence

.github/workflows/ci.yml runs on push, pull_request and manual dispatch. Ubuntu
22.04/Node 22 installs bubblewrap/native build prerequisites and uses npm ci, format,
lint, typecheck, normal regression, integration, PTY and build scripts. Official
actions are pinned to verified commits, contents permission is read-only, checkout
retains no credentials and superseded same-ref runs cancel. Hosted CI starts no live
model or real GitHub write. Desktop/browser/platform opt-ins remain separate.

Disposable local bare-remotes tests cover normal/skip policies, exact messages,
selection and staged preservation, remote/permission/ancestry races, network
ambiguity, ownership, idempotency and recovery. Built Electron fixtures use isolated
roots, real renderer/IPC and blocked live service executables, capture main pages/
Git at three sizes and assert unchanged source data. Native Windows/WSL compatibility
is reviewed through the existing shared renderer/bridge/core boundary; native DPI,
installer and live-account behavior require separate environment evidence.

## Chat-first coding workspace — complete

The persistent conversation is the primary surface for issue tasks and PR repairs. Shared components in src/components/workspace own the chat surface, independently scrolling secondary workspace, expanding composer, compact action tray and Terminal / Problems dock. Pipeline, Plans, Changes, Tests, Final review, Usage, Run details and Raw logs are distinct tools in the right panel. The panel preserves selection, width and per-tool scrolling, expands for focused review and becomes a dismissible focus-contained drawer on narrow workspaces. An attached PTY remains mounted while hidden; its existing worktree lease and explicit close semantics remain authoritative.

Task-local layout version 2 migrates legacy center tabs and engineering dock selections. Draft text keeps its separate conversation-ID storage key; context snapshots, model choices, dimensions, selected diff/layer and per-layer paths persist locally. Storage failures retain the in-memory draft and surface an explicit persistence error. Expanded tools keep chat mounted and restore chat scroll/focus on return. The command palette, task menus, cleanup dialogs and panel controls use shared focus handling. Ctrl+Shift+P, Ctrl+B, Ctrl+backtick and Ctrl+J preserve the relevant workspace context and ignore composition where applicable. The header keeps editor, Stop and panel controls; task navigation owns status and confirmed secondary lifecycle actions.

Issue instruction persistence remains in task_messages. Save for later retains the local composer and backend gate without inference. Feedback sends only its explicitly requested message; retries no longer consume saved drafts. The UI supplies the viewed artifact ID and the backend rejects stale artifacts. Pending instructions require an explicit keep-saved/include-next-stage decision bound to their current IDs. Including them retains the next pipeline stage's configured provider/model, and final acceptance starts no agent. Message request IDs make transport retries idempotent; message delivery and continuation scheduling persist atomically. Repair follow-up requests reuse repair message identity atomically, while repair draft saves are explicitly local. Repair manual review, local commit and publication remain separate decisions with unchanged ownership, stale-head and content checks.

The concise chat model selector uses existing official provider discovery and exposes model/effort/account availability without provider fallback. Pipeline shows persisted effective run settings. A separate task.configureStage contract saves a task JSON override only for an idle, never-started provider stage; completed runs and global defaults are unchanged. Stage providers retain their approved order. The desktop negotiates saved_instruction_choices through core.info before permitting the changed task mutation contracts. These task JSON and message-ID extensions require no SQLite migration or widened package index exports.

Composer context consists of previewable, removable bounded snapshots. Existing validated task/repair file IPC supplies worktree files and selected file diffs; already-loaded plans/scopes, changed paths, incomplete checks and explicit notes supply other options. Historical repair diff attachments retain their selected baseline, while worktree references always read the current repair working tree. Snapshots remain local until explicit save/send. Shared input handles growth, long pastes, Enter/Shift+Enter/IME, message limits, busy state and persistence errors. UI notices are scoped to workflow/run/artifact identity so an earlier approval cannot label a later blocker.

Validation uses backend/execution/verification.ts for its evidence taxonomy and task-verification.ts for issue-task attempt selection. Optional bounded structured verification supplements unchanged historical arrays. Provider reports, observed commands and deterministic host diff evidence stay distinct. Recognized setup failure/interruption cannot become an application assertion failure or proof of verification success; ambiguous legacy evidence remains unresolved. Stage 4 requires the exact pinned-base diff check and all recorded required checks, with genuine failures retaining failed and gaps retaining verification_blocked. Approval rechecks evidence. Validation-only retry starts no provider and delivers no instruction. Chat, command cards and Tests share classification; transcripts retain original statuses, exits and output. No waiver moves unresolved required checks into review.

Diff presentation reuses validated Git file/diff payloads. src/lib/diff validates Git hunks and old/new counters and provides bounded lexical coloring. src/components/diff groups searchable tree/flat file navigation with numbered unified/split rendering, incremental unchanged-context reveal and explicit binary, oversized and unmapped states. React renders source as text; no raw repository HTML or editor dependency is introduced. ChangesView reuses review.files/review.reviewed for content-bound issue marks and existing repair review authority for repair marks. Failed mark refreshes hide stale indicators. Repair layers retain distinct statistics and correctly labelled base/head references. All filesystem, sandbox, source ownership, Issue Watch and explicit publication boundaries remain in their existing backend services.

The final checkpoint passed 446 normal tests, integration 7, PTY 3 and six built Electron fixtures, plus formatting, lint, type checking and production build. Screenshots were inspected at 1920×1080, 1440×900 and 1280×720, plus a narrow drawer, both diff modes, repair integration/publication and Issue Watch handoff. [Delivery, file inventory, manual checks and limits](docs/CHAT-FIRST-WORKSPACE.md) and [measured verification](docs/VERIFICATION.md) record the evidence. Earlier milestones below remain historical records.

## Security hardening and manual Issue Watch

[Security audit and Issue Watch plan](docs/ISSUE-WATCH-SECURITY-PLAN.md) is complete through S1–S5. The final checkpoint passed 370 normal tests, integration 7, PTY 3, built Electron watch/issue/PR/repair/output and packaged smoke, authorized real GitHub fixtures, and Linux/Windows installer builds. [Delivery](docs/ISSUE-WATCH-DELIVERY.md) and [verification](docs/VERIFICATION.md) record evidence and native/provider limits. Host Git operations are consolidated in `backend/workspace/git-command.ts`: built-in commands, inspected local/worktree configuration, disabled global/system configuration and implicit lazy fetch, executable-configuration refusals, canonical GitHub HTTPS and official gh credential delegation. Local transports are fixture-only constructor capabilities; publication retains its private pre-push hook. Integrity capture fails explicitly on overflow rather than returning incomplete authority evidence. Existing issue/repair behavior is the regression boundary. Issue Watch reuses GitHubClient, UtilityAI/AgentRunner, SQLite, usage, logs and Electron IPC for explicit scans, with deterministic exclusions before at most one semantic invocation. Saving/opening watches and startup never authorize a scan.

Managed storage validation retains the canonical startup root and checks every existing parent with lstat. Category, repository and worktree symlinks are refused, including dangling and internal aliases; a renamed/replaced root cannot redefine the authorized boundary. Clone/worktree creation, incomplete-clone cleanup, task cleanup and saved-log reads use this guard. Imported source checkouts remain a separate explicit ownership boundary.

Issue authority uses a versioned `issue-v2` content fingerprint, sharing repair's asynchronous file/mode/link hashing. It binds the pinned base, HEAD, exact index entries and all tracked/untracked working bytes, including unchanged paths whose contents or modes Git might otherwise hide. Internal Git identifiers bypass display redaction, reject invalid UTF-8 and fail on capture overflow. Legacy pending review/draft hashes no longer compare; saved completed history remains intact. Repair retains its 64-hex contract and content-only commit semantics. Root migration validates copied metadata parents before rewriting pointers.

Metadata enumeration treats valid file/directory transformations and uninitialized gitlinks explicitly; initialized submodules are fingerprinted within their verified parent Git-metadata boundary, with bounded nesting. File reads use no-follow handles, verify the opened descriptor's path and detect concurrent file changes. Raw NUL-framed identity output has its own capture budget rather than the display line limit. Repair history/context/publication-hook operations and registered managed sources use the same managed-path guard. Existing test cores now share a constructor-injected local transport that rejects network URLs by default.

Issue workspace creation now records common-directory, creation intent and Git process identity in optional task JSON checkpoints. Interrupted preparation must reconcile branch SHA, owner/creation evidence, the exact worktree registration and common directory before adoption or explicit reconstruction. Ownership is also written into task-specific worktree metadata. Issue cleanup refuses tracked, untracked, ignored and hidden-index work, checks the task metadata owner, persists removal intent and deletes branches with expected-SHA comparisons. Missing registrations use non-force scoped removal so recreated personal files are preserved. Preparation cannot overwrite removal intent. Checked Git metadata bypasses display redaction, retaining exact identifiers and NUL framing. Restart stops saved task Git operations by process-start identity; reconstruction of missing worktrees remains an explicit action.

Execution sandboxing now starts from an empty bubblewrap root and mounts an explicit system/toolchain/configuration manifest, the assigned worktree/runtime, managed artifacts and only the selected official provider's authentication/session directory. Host home, /run, /var, /srv and /opt are absent unless an exact selected executable/runtime mount requires a path. Unix socket environment is removed; official provider networking remains available. Provider-owned state is a deliberate trusted boundary, not an isolated credential service. Fixture provider detections do not mount real provider state.

PTY login/task sessions use separate bounded stateful redactors before emitted output, snapshots and log writes. Token/field recognition spans chunks, ANSI and JSON escapes; recognized values are suppressed until a terminator without retaining the value. Raw ambiguous tails never flush on session close. Output and pending disk writes have explicit byte/item caps; sink failures stop execution. Agent cancellation is rechecked after process settlement, fingerprinting and log drain. Official model/allowance discovery uses bounded protocol input, process-group cancellation and child-close settlement; cancelled runs do not start an independent post-run discovery.

Persistence recovery uses `storage/records.ts`, which isolates invalid JSON/schema rows during collection reads and records durable, payload-free diagnostics while retaining original source values. Exact owner reads fail with `corrupt_record`; sparse historical task/repository objects remain readable without invented ownership defaults. Pipeline settings are strict for execution, with a separately labelled display fallback. Cleanup and root migration verify relational ownership before deletion. Application database opening now takes an async SQLite backup before pending migrations; migration transactions validate foreign keys and close failed connections. Migration 21 adds persistence diagnostics, issue-request tombstones and a JSON-safe repository index. Ordinary task creation now binds optional request UUIDs to a canonical payload digest, shares in-flight retrieval, and atomically records the request with the task. Request tombstones survive history removal. The composer retains its request identity across transport retries and generates a new identity when its submitted payload changes. Context retrieval participates in shutdown/maintenance cancellation. Settings shows payload-free record diagnostics; engine shutdown shares one settlement promise and always releases database/lock resources.

S1 reachability cleanup removes the test-only `Engine.analyzeScheduled` path and its optional second-model branch, along with obsolete `assessActivity`/`reviewPrompt` heuristics. Current PR analysis still uses `ActionSchema`, exact `discussionEntries` and `isAcknowledgment`; integration/cancellation fixtures now exercise the active UtilityAI/PRAnalysis path. The unmounted Monaco `DiffView`/`DiffReview`, loader/declaration and unused Monaco dependencies are removed. `CodeAskAI`, review/question APIs and history, `ChangesView`, `DiffFileTree` and the active `Overview` remain. Deprecated scheduled.fix keeps a safe refusal directing users to explicit Solve Review.

PR context reuse hashes both retrieved and persisted snapshots through the same validated schema order, excluding retrieval time. Collection decoding therefore cannot trigger a second semantic invocation solely by changing JSON property order.

## Issue Watch backend

backend/issue-watch groups strict domain contracts, deterministic rule preview/confirmation, structural Markdown tracker references, claim/hard-rule assessment, normalized persistence, scan collection and the RPC lifecycle. Migration 22 adds six tables for clone-independent watches, immutable revisions, durable attempts, retained sources, candidate snapshots and the last complete projection. Requests bind UUIDs to payload digests; one active attempt per watch is enforced in SQLite. Partial/blocked/cancelled/interrupted attempts retain evidence without advancing the baseline. Stable-identity comparisons distinguish initial discoveries, actual creation after a saved cutoff, newly matching/reentered issues, criteria changes and verified eligibility loss. Direct known-result rechecks preserve not-rechecked uncertainty. Display collections quarantine invalid records; baseline execution requires strict prior-result decoding. Explicit reset clears watch history in foreign-key order; repository cleanup does not own watches.

backend/github/issue-search and issue-context share GitHubClient with a four-request pool, per-attempt request/byte/source/identity limits, structured search and current metadata checks. All API calls pin github.com. Trackers refresh on every explicit attempt, body only by default; optional all-comment coverage must be complete. Claim text is source-linked interpretation with actor-specific withdrawals and association-based grants; age alone never clears a claim. Verified assignments and visible Markdown closing references from open PRs take precedence. Complete source snapshots include bounded discussion/timeline/policy evidence; missing coverage stays uncertain. Contribution policy is read through GitHub community/content endpoints without cloning or following external websites.

IssueWatchService is owned by Rpc. Create/edit/local reads never scan. Only explicit scan/retry/continue routes reserve attempts; cancellation and shutdown use Engine activity blockers and await settlement. Startup marks unfinished attempts interrupted locally. The helper advertises manual_issue_watch contract 1, and CoreBridge blocks unsupported helpers before feature operations. Antigravity is accurately unsupported for this new integration. S3 connects IssueWatchSemantic to the existing UtilityAI/AgentRunner. Complete JSON packets fit a 128 KiB input budget with at most 20 semantic candidates and a 120-second timeout. A transactional invocation slot is consumed before the one call; omissions, quota/capacity/provider failures and invalid identities/citations retain GitHub-only partial evidence without an automatic retry or fallback. Host facts and hard exclusions remain authoritative after screening. A bounded final metadata recheck catches labels, assignments and discussion revisions changed during the model run; stale evidence makes the attempt partial. Continue requires an explicit candidate selection and creates a new attempt that refreshes tracker sources; scoped rechecks preserve the full baseline. Detached utility cache paths use the same canonical managed-path guard as artifacts/logs. Exact redacted packets/prompts live under relative artifacts/issue-watch/scan IDs.

Migration 23 adds nullable watch/scan attribution to utility_runs and ai_usage plus normalized utility_events. Detached watch execution does not manufacture task/repair owners or change their CHECK constraints. Scan-owned logs and events use the existing bounded capture/redaction/runtime and owner-checked saved output APIs; provider/model/effort, nullable reported usage and real allowance snapshots remain available.

## Issue Watch desktop

src/components/issue-watch groups the saved-watch/editor/result/details workspace, safe source Markdown and explicit continuation dialog. src/lib/issue-watch owns narrow typed local reads, stale-response guards and completion notices. The page uses event-driven local refresh/focus reads without a scan timer; lists return compact candidate/source metadata and only selected details load full original bodies. Panels reuse ResizeHandle/usePaneSize and persist watch-specific preferences. Editor previews/ambiguity decisions are deterministic; provider discovery is metadata only. Every scan/recheck/retry/continue is a direct button action with a durable request identity and visible provider/bounds/Cancel.

Local dismissal overlays historical candidate views without rewriting their immutable scan snapshots. Provisional dispositions can retain an identity tombstone in issue_watch_results; only rows evaluated by a completed scan enter the complete projection. Scoped local disposition tombstones remain separate from complete eligibility history. Dismissal alone never advances a baseline. Shared LogView/useAgentOutput accepts narrow Issue Watch ownership and retains the same Readable/Raw/prompt/search/history behavior without fake task/repair database owners. Start Vibestar Task prefills the existing NewTask URL/notes; its original explicit submission and pipeline remain unchanged. The workspace uses the existing dark semantic colors, dense rows, independent scrolling panels, responsive detail drawer, labelled keyboard controls and reduced-motion-aware progress indicator. Safe issue Markdown skips raw HTML, external images and unverified link protocols/hosts. The shell adds Issue Watch/global Usage and labels manual PR navigation Pull Requests. Root-level completion notices deduplicate saved completion IDs across navigation/restart; opening them reads local results only.

The narrow-screen detail drawer leaves an independent Cancel control in the page header so opening issue evidence cannot hide cancellation. Renderer fixtures exercise preview/save without inference, explicit scan, safe Markdown, helper refusal, completion deduplication and the existing task form handoff.

The built Electron Issue Watch fixture injects the same service through Rpc and uses an isolated saved-data root, GitHub responses and a shared fixture provider. Rpc snapshots and the helper handshake both advertise the manual watch contract. The fixture exercises actual IPC, read-only AgentRunner execution, saved output, real fixture usage, history and cancellation without subscription inference. Exclusion progress includes current assignment, tracker, label and confirmed competing-work outcomes. The application labels task navigation Tasks. An explicitly enabled GitHub test is restricted to the user-authorized akshajrawat/akkco-vibestar-test repository, creates identifiable issue/label/policy fixtures, closes/removes only its fixtures, and still uses a fake provider.

[Issue Watch usage](docs/ISSUE-WATCH.md) documents the manual Oppia workflow, bounded coverage, baseline categories, provider limits and task handoff. Compact-read/provisional-dismissal regressions protect immutable evidence and keep local dispositions out of complete baseline authority. Shared model selectors expose an explicit accessible name in Chromium; watch filter checkboxes retain their intrinsic width alongside readable labels.

Saved watch/history lists expose explicit loading of additional local pages. History cursors bind a saved scan ID to its watch and order by timestamp plus SQLite row identity so attempts sharing a timestamp remain reachable. Page refreshes re-read only the number of pages the user has requested; paging starts no GitHub collection or inference.

The watch editor uses the shared dialog-focus lifecycle alone, avoiding competing input autofocus that could replace the opener before focus restoration was captured.

Completion notices occupy a bounded scrollable strip inside the main workspace. They remain actionable across navigation without covering issue actions, model controls or cancellation.

Watch toolbar/history labels explicitly use horizontal control alignment, and watch checkboxes retain intrinsic sizing instead of the application's full-width text-input default.

Tracker sources retain their requested URL separately from a GitHub-resolved canonical URL. Subsequent scans compare repository and issue node IDs against the last complete baseline before accepting current tracker membership; canonical renames with the same IDs remain valid. Required prior source records decode strictly for execution, while display collections continue to isolate corrupt rows. Replaced tracker identities block the attempt without advancing the baseline. The optional JSON field is compatible with existing source snapshots and needs no table migration.

The opt-in packaged smoke checks both shipped Node helper bundles for matching hashes, schema/capability negotiation and empty-root behavior, then launches the actual Linux executable and opens the watch editor. It blocks live CLI/account access. Running the Windows-distributed Linux helper under Node checks the WSL helper payload; it does not establish native Windows installation or GUI behavior.

Real GitHub fixture cleanup binds the temporary contribution policy to the exact created blob SHA. A later external edit causes an explicit cleanup failure instead of deleting that edit.

## Approved milestone plan

[IDE harness and manual PR review plan](docs/IDE-HARNESS-PR-REVIEW-PLAN.md) records the five-milestone architecture and acceptance checklist. The current user brief authorizes implementation of Milestones 3–5 together while preserving completed Milestones 1–2. Manual PR policy does not change issue scheduling/recovery. Repair sessions use independent worktrees from the verified remote PR head, checkpoint normal local upstream merge commits, and require explicit confirmation for remote publication. Shared output indexing and physical worktree sharing remain deferred.

All five milestones are implemented. [PR repair system](docs/PR-REPAIR-SYSTEM.md) provides the current contract/file inventory and manual acceptance steps; [verification](docs/VERIFICATION.md) records source, real Git/PTY, built Electron and local installer evidence. Live provider/GitHub publication and native Windows installation remain separately unverified.

GitWorkspace resolves registered checkouts to their canonical Git common directory before locking shared metadata. Registrations and data roots that share that directory use the same filesystem lock; absent managed clones retain the registration lock during creation. The issue pipeline retains its existing worktree preparation behavior.

backend/review/repair introduces separate repair identity, workspace and workflow contracts. PRIdentityReader retrieves immutable PR/upstream/fork IDs, exact head/base refs and SHAs, authenticated viewer and destination push permission through official gh. RepairWorkspaces validates the explicitly selected checkout, fetches only session-owned refs, creates a dedicated owned branch from the verified PR head and merges the actual upstream base into that branch. Branch/worktree ownership and merge intent are checkpointed before operations. Conflicts retain their index stages and paths; explicit recovery inspects actual MERGE_HEAD, ancestry and ownership before committing a resolved merge. The source checkout's branch, index and files are never switched or staged. A minimal WorkspaceAssignment lets existing Git diff/fingerprint/path contracts serve repairs without manufacturing issue tasks.

Migration 19 adds separate PR repair sessions, user messages, activity checkpoints, publication journals and content-bound reviewed files, retaining existing issue tasks and analyses. Repair sessions reference the original tracked PR and analysis; deletion cannot silently remove active repair history. Local bare upstream/fork fixtures cover manually created PRs, imported/managed sources, checked-out feature branches, dirty source indexes, normal merge ancestry, conflicts, ownership, stale heads, shared-directory locks and checkpoint reconciliation. No production model or GitHub write is used.

Migration 20 preserves the existing agent_runs, agent_events, test_runs and terminal_sessions while making their owner either an issue task or a repair session, enforced by SQLite. Existing usage gains a nullable repair_id; there is no second usage database or output renderer. AgentRunner accepts a physical repair assignment and uses the existing adapters, sandbox, event normalization, command evidence, redacted logs and telemetry. Provider adapter stage numbers select read-only versus implementation capabilities only; PR workflow transitions remain separately named and persisted.

RepairStore validates new saved session contracts and journals named state transitions, user turns and workspace checkpoints. Repair execution reserves the existing engine concurrency slots and propagates cancellation into AgentRunner. Session context packets mount read-only from managed artifacts, retaining complete reviewer wording without placing support files in the repair diff. Git write leases are keyed by canonical common directory plus workspace/destination identity; a live conflicting lease fails before any agent or publication operation.

RepairService implements explicit selected-observation repair requests and the separate preparation → Codex implementation → Antigravity verification → manual review workflow. Configurations snapshot the existing implementation/review settings. Full saved review/issue/diff context, source identities, user instructions, runtime dependencies and prior execution results are mounted for both agents. Every selected item must have one schema-valid result with safe file paths. Reported tests remain distinct from observed command records. A blocked verification stops; further fixes require a new user instruction in the same worktree. Startup reconciles owned Git merge state read-only and marks interrupted execution; neither model runs nor pushes replay automatically.

Strict repair.create/list/detail/start/cancel/recoverConflict RPCs expose the separate workflow. repair.diff/file retain original-PR, upstream-integration and repair baselines through the existing Git diff implementation. repair.events/logs share the existing ownership-checked event paging and saved log search code. core.info advertises pr_repair and the Electron bridge blocks writes/execution with an older helper while retaining reads/cancellation.

Repair pipeline fixtures execute actual targeted file edits and node:test commands inside the existing bubblewrap sandbox, with independent reviewer write probes and recorded command exits. They exercise provider order/configuration, full review packets, per-item completeness, blocked checks, same-worktree explicit follow-ups, failed outputs, cancellation and no startup inference replay. Fixture provider code remains under tests/pr-repair only.

RepairPublisher separates manual review approval, local commit preparation and explicit push confirmation. Repair fingerprints bind HEAD, index, changed-file contents and modes; async content hashing avoids truncated diff evidence and now supplies the shared primitives for versioned issue fingerprints. Local commits preserve reviewed content and ancestry, use the repair checkout only and journal intent/result. Prepared publication journals contain exact fork/ref, remote/local SHAs, reviewer fingerprint, actual Git counts/history, observed command outcomes, reported blockers and confirmation identity. A private per-invocation pre-push hook checks Git's advertised remote SHA and exact destination during a normal non-force push. Uncertain/cancelled outcomes reconcile through read-only remote inspection; startup never repeats a push.

repair.approve/commit/publish require explicit confirmed=true contracts; publication IDs bind the exact proposed operation. preparePublication, reconcilePublication and keepLocal remain separate actions. Destination and branch leases use distinct target files in the common Git directory so the lock library can safely maintain simultaneous independent leases while repository metadata operations use their existing common-directory lock.

Publication fixtures use separate local bare upstream and fork repositories, explicit user-equivalent RPC confirmations and real Git pushes. They check local-only preparation, exact non-force fork/ref updates, unchanged dirty source indexes, changed review fingerprints, closed PRs/permissions, a pre-push advertised-head race and read-only reconciliation after a simulated post-transmission network failure. Publication transport/executor injection is constructor-only test infrastructure and is never accepted from renderer RPC input.

Repair terminals reuse TaskTerminals and xterm with repair ownership in the existing terminal_sessions table. Their destination/branch leases exclude agents, commits and pushes until the shell closes. Explicit repair validation commands reuse Engine.manual and the same sandbox/test evidence. Supported editor/folder actions resolve the exact owned repair worktree through RepairService's identity checks. Existing task terminals and editor actions retain their contracts.

Shared CurrentRun, LogView/useAgentOutput, ChangesView, CommandRuns, TaskTerminal and OpenInEditor accept narrow repair ownership/view contracts while preserving task defaults. PR publication uses an accessible focus-contained dialog presenting the journal's exact Git destination, SHAs, changed-file counts, actual command evidence and reported blockers. Local commit and Confirm Push are separate controls; dismissing the dialog grants no publication authority.

src/components/repair groups review selection, the dedicated persisted conversation/workspace and publication dialog. It reuses the shared output, tests, usage, terminal, changes and editor components. The workspace shows complete reviewer context, item-linked implementation/verification results, merge conflicts, durable history and explicit follow-up/manual approval actions. Optional resizable context and utility panes reuse task-local preferences; diff layers distinguish original PR, upstream integration and review repair changes.

The PR inbox/details now expose repair-session counts/history and Solve Review. Selection preserves original wording and source IDs, allows deselection/instructions and requires an explicitly visible connected upstream checkout. Missing local checkouts use the existing local connection/managed-clone actions. Repair sessions appear separately under repository-scoped Pull Requests navigation; opening a repair never changes the original issue task. Analyze Again after publication remains an explicit user click.

Confirmed repair.cleanup verifies common-directory/worktree/branch ownership, rejects dirty or conflicted workspaces, removes only the clean owned worktree and deletes its branch/session refs with expected-SHA comparisons. History is retained by default; separately confirmed history deletion preserves ai_usage with nullable links. Repository deletion, unused-clone cleanup and storage reset account for repair ownership before touching source data. Removed repair workspaces cannot restart agents.

Creation requests are idempotent while identity reads are in flight and after later follow-ups; the original selection/instructions are journaled. Shutdown aborts pending creation before closing persistence. Managed-root migration translates repair paths and owned worktree metadata alongside issue tasks, preserves session markers/history, then verifies both kinds at the promoted root. Imported repair worktrees retain the existing explicit Use old location boundary, preserving external metadata and source checkouts.

repair.reviewFiles/reviewed bind review checkmarks to the exact baseline/working file contents using the same fileHash helper as issue review. Changed contents invalidate visible review state and stale marking requests fail. Internal hashing is shared within backend/review without widening any package public export.

PR detail views expose Overview, Full Conversation, Review Actions, CI / Checks, Analysis History and Repair Sessions through the existing keyboard tab navigation. New selection/publication dialogs share focus containment/restoration helpers; Escape dismisses without authorizing work or publication. Utility dock tabs keep the existing keyboard and persisted layout behavior.

Additional repair persistence fixtures perform actual core reopen during merge intent, managed-root migration, content-bound review invalidation, safe cleanup/source protection and real repair PTY lease exclusion. Local inbox summaries count source-linked outstanding observations and unanswered questions from saved analysis history without GitHub reads or inference.

The Oppia-shaped repair fixture models an inline selector, a changed exploration and a vacuous every() draft assertion. Fixture implementation moves selectors/assertions to utilities, retains the legacy exploration and independently executes three node:test checks, including rejection of an empty draft list. No real provider subscription or GitHub publication is needed to verify the integrated mechanics.

Repair renderer tests exercise exact reviewer text, deselection/instructions/repository choice, absence of implicit inference/publication, named diff layers, shared Readable/Raw output controls, keyboard utility tabs and separate local commit/push confirmation. Subscription and permission metadata remain fixture-owned or officially reported; model claims are labelled separately from observed command evidence.

npm run test:desktop:repair exercises the complete Oppia-shaped acceptance path in the built Electron renderer and real IPC: manual analysis → selection → exact isolated head/base preparation → Codex edits/tests → read-only Antigravity checks → manual approval → local commit → explicit fast-forward push to a local bare fork. The ordinary desktop core uses an empty isolated root and blocked real CLI executables. Screenshots and results can be retained with VIBESTAR_KEEP_EVIDENCE=1. The existing PR analysis and issue approval desktop fixtures remain separate regression gates.

Sensitive repair Git fetch/worktree/merge/recovery operations checkpoint their PID and process-start identity in the workspace record; publication journals record the push process identity. A new core reconciles these alongside existing agent/test/terminal PID records, preventing a detached Git process from continuing to write while the restarted workflow inspects its checkpoints. Normal completion/cancellation clears preparation process checkpoints after the executor has stopped; uncertain pushes remain journaled for read-only reconciliation.

Owned workspace removal checkpoints its verified branch head and removing state before mutation. Explicit cleanup recovery handles an already removed worktree or branch with ownership and expected-SHA checks; it never recreates a removed workspace or deletes an unrelated ref. Interrupted local Git commits invalidate publication approval and require explicit resumed review, while publication journals retain their distinct uncertain-outcome reconciliation path.

Exclusive-operation failures are persisted with their operation labels; pre-publication stale-head errors durably enter stale_remote_head and offer an explicit Analyze Again action. The selection dialog retains its idempotency request ID through transport errors so retrying the same user request cannot silently start another inference sequence.

Recovery fixtures now include a confirmed live detached Git process terminated by its saved process identity, interruption between worktree creation and ownership checkpoint, cleanup after worktree removal but before branch deletion, and an actual slash-containing PR base ref differing from the source registration default. These checks use real Git and preserve source files/index without provider inference.

Repair persistence validates the entire saved analysis/snapshot structure, including full discussion, review threads, file patches, source-linked observations and coverage. Unknown external linked-issue data remains inert context; identity, workflow and publication authority use their separate strict host contracts. Publication restart coverage closes/reopens the actual engine/database before checking idempotent history and absence of a second push.

Failed preparations with no owned branch, physical worktree or matching registration can remove their local history without Git mutation. Editor fallbacks identify the PR repair worktree explicitly. The acceptance packet includes linked whole-issue context while repair scope stays limited to the selected source-linked concerns.

Upstream integration checks incoming added paths against existing files and disables overwriting ignored files, preserving local ignored content even during interrupted-preparation recovery. A real Git fixture verifies that an upstream tracked file cannot silently replace such content and that the repair HEAD stays at its verified checkpoint on failure.

An incoming-file preflight independently checks added upstream paths for existing local content before merging, covering ignored files even when the installed Git strategy does not enforce its no-overwrite-ignore flag.

repair.approveLocal and the local commit dialog permit reviewed local-only commits independently of remote publishing permission. The same content/ancestry/fingerprint guards apply; the action creates no publication attempt and returns the session to manual review after keeping its commit local. Prepare Push and Confirm Push retain their independent GitHub permission/destination checks.

Integrity-only Git plumbing retains exact stdout identifiers internally so secret-like filenames cannot be masked out of workspace hashes or incoming-file protection. Streamed output, stderr, prompts and ordinary process results remain redacted. A fixture changes a credential-shaped filename and verifies that its content changes the repair fingerprint without exposing its bytes through logs.

Milestone 1 adds migrations 17–18: legacy PR schedules are disabled without deleting their data, and explicit PR analyses/observation assessments have separate history linked to existing scheduled runs and ai_usage. Recovery interrupts unfinished PR analysis; issue queue recovery remains unchanged. Utility execution accepts a caller cancellation signal so stopping a PR analysis terminates the same official provider run. Startup and authentication completion no longer refresh PRs.

backend/review/pr groups strict report contracts, bounded complete context packets and source-validated observation persistence. The existing scheduler now owns manual operations only: Track saves an inactive record, Refresh reads metadata, Analyze retrieves complete context and invokes Utility AI at most once when semantics require it. No legacy optional verification runs. Each report keeps its own snapshot, source/segment coverage, configuration and immutable assessments; stable host-assigned action IDs survive repeat analysis. Replies/acknowledgments and GitHub thread resolution remain separate from unverified code. The PR inbox/details expose full conversation, engineering observations, CI/file context, report history, saved prompts/raw logs and existing ai_usage. UI polling reads local saved progress only; it never refreshes GitHub or invokes models. Explicit Solve Review transfers selected observations into the separate repair service; analysis itself grants no Git write authority.

## Runtime boundaries

Electron is a thin desktop host. React runs with context isolation, no Node integration and Chromium sandboxing. Its preload exposes a small sender-validated RPC/event bridge and window-control API. Navigation, webviews and arbitrary new windows are denied. A frameless 34px React titlebar provides native minimize, maximize/restore and close operations; Electron's application menu is removed and the loading background matches the app.

All orchestration lives in a Node 22 TypeScript execution core. Linux/WSLg launches it directly. Native Windows launches the configured WSL distribution with argv-safe wsl.exe --exec calls. A constant helper receives structured configuration and starts the core; newline-delimited JSON carries RPC requests and events over stdin/stdout. There is no application HTTP server or external database. Changing desktop execution settings updates only the host configuration. Linux desktop profile data lives under the root runtime/desktop directory; native Windows retains its small host configuration and Chromium profile in Windows application data because the execution root lives inside WSL.

## Frontend

Milestone 2 keeps CurrentRun outside optional context and utility panels, showing the executing provider/model/effort/stage/runtime/activity across task views and linking directly to that run's existing ai_usage. Officially reported startup model/effort overrides requested configuration in both the run and telemetry. Composer selections remain next-run settings. Terminal leases, issue concurrency, approvals, manual PR policy and remote-write restrictions are unchanged.

AgentTimeline reuses src/lib/agent-output/activity to group run-scoped call snapshots/deltas and render exact arguments, file paths, commands, reported durations/exit codes, provider status/errors and separate emitted streams. Unfinished tools become interrupted when their run ends; an explicit interruption outranks exit zero. Command completion without a reported zero exit has a neutral indicator. Provider aggregates/tool output are labelled honestly rather than claiming a stream split the CLI did not report. Technical details reuse the existing raw event column. Safe Markdown and nested structured fields retain unknown result shapes without raw HTML, hidden reasoning or invented progress.

Readable search also matches retained raw fields, with initial/latest emitted tool envelopes available together in technical details. Older normalized records keep their original raw evidence; missing provider metadata is never reconstructed speculatively.

Command cards use provider-reported duration when available, otherwise label the observed interval between persisted command-start/finish events. Missing duration and exit metadata have separate readable rows. Nested technical disclosures retain independent visual expansion indicators.

Raw search pages cap both matching-line count and payload bytes, allowing one complete oversized emitted line rather than clipping it. Continuation cursors preserve all remaining matches.

LogView offers Readable, Raw stdout/stderr/structured events and exact saved-prompt views. src/lib/agent-output/useOutput pages existing agent_events and managed redacted log files, rejects stale requests on task/run/view changes and drains live bursts even after completion. task.events validates task/run ownership, returns 500 cursor rows plus first/latest tool context so search/page boundaries preserve final states. task.logs retains its legacy 1 MiB tail API and adds 256 KiB byte pages plus full-file streaming search in pages of up to 200 matching lines. Existing SQLite indexes/files suffice; no migration, output index or run registry is added. Independent UTF-8 decoders preserve characters split across CLI chunks before existing line redaction/persistence. CLI stderr cannot overwrite stdout results, session identity or usage.

Follow/pause controls scrolling while capture continues; loading earlier output retains its scroll anchor. Copy uses displayed output, Ctrl/Cmd+F focuses scoped search, Ctrl/Cmd+End resumes following and Escape clears search. Task-local layout/output preferences persist in validated localStorage records; drafts keep their existing separate storage and pane dimensions retain usePaneSize. Task/utility tab lists share Arrow/Home/End navigation through src/lib/keyboard. The saved-prompt dialog contains Tab focus, closes with Escape and restores focus to its opener. Resizing/maximizing the dock preserves its existing PTY session. Fixture-only backend, renderer and built Electron tests cover output/history/state/keyboard behavior with real AI/GitHub executables blocked.

Sent prompts, repository metadata and pipeline history also live in a collapsible, resizable right sidebar. The persistent run strip keeps actual execution metadata, activity, output/usage access and Stop visible with that sidebar closed. Changes, Tests and Agent Output have direct workspace shortcuts. The utility dock maximizes into the task workspace and restores its saved height without remounting its terminal; Escape restores it. The Changes dock reuses the existing file tree and task.file boundary to show colored unified patches against the pinned base, including untracked files, without loading Monaco.

Migration 16 links observed provider command calls to test_runs and reconstructs historical calls from persisted events. CommandExecutions saves cumulative stdout/stderr snapshots separately per run/call, with explicit 1 MiB tails; full redacted provider logs remain accessible in Logs. Exit zero alone marks a command passed; completion without an exit code remains completed, and unfinished calls become interrupted when their provider exits. Provider-reported test summaries remain distinct from observed command evidence.

Command history uses insertion order to break timestamp ties, so fast repeated checks retain their execution order. Later output snapshots preserve a call's recorded completion metadata. Chat expands saved agent results by default and keeps both command streams visible when present.

Agent Output opens normalized activity and readable saved results; raw stdout and stderr remain explicit views. Tests places command browsing ahead of collapsed reports, with runtime details collapsed unless warnings need attention. Manual argv records render as readable commands while preserving their exact stored arguments.

Manual execution keeps a 1 MiB live tail per stream, then replaces it with the existing bounded process capture on completion and clears the live-tail marker.

Desktop fixture acceptance covers sidebar collapse, maximized patches, live PTY session preservation across maximize/restore, and separately browsable command stdout/stderr through the real Electron renderer and IPC. It never invokes a real model.

Both planning prompts inspect repository instructions and CI to derive a complete verification checklist without running tests. Codex implementation and Antigravity final review independently execute applicable checks and required platform variants, investigate failures and report exact commands, evidence paths and blockers. Existing explicit stage approvals and source-write sandbox restrictions remain in force. Manual validation stdout/stderr is persisted during execution so Tests updates while a command runs.

Task headers use compact status chips and Resume/Stop controls. Cancellations and failures appear only beside the relevant timeline activity, with dismissible notices and collapsed technical details; historical run outcomes remain visible. Errors use the task's actual stage, including planning cancellations before provider detection creates a run. Cleanup dialogs stay accessible for idle tasks with open terminals and show named live blockers with explicit Stop blockers/Try again controls. The RPC envelope preserves structured failures across Electron without exposing transport exception prefixes as user-facing messages.

Chat has explicit saved, queued and delivered message states. Sending persists the instruction first and publishes it before provider detection/spawn. Active pipeline instructions are consumed at the next stage boundary; terminal-occupied tasks save instructions without racing the shell. Continuations resume preparation, Antigravity planning, Codex refinement or implementation according to valid saved artifacts, while planning retries invalidate only later canonical artifacts. Historical runs retain their outputs. Implementation follow-ups use the selected provider without changing the approved pipeline order.

React, Vite, Tailwind and shadcn-style primitives provide the dense IDE shell. Components separate navigation, task workspace, timeline, plans, changes, tests, terminals, logs, provider authentication and schedules. Task state comes from SQLite-backed snapshots and real core events. A lightweight task-ID keyed view store preserves drafts, selected tabs, diff files, review visibility and terminal docking while switching tasks. Pane dimensions persist locally. Ctrl+Shift+P opens a keyboard-operable command palette calling existing navigation and task actions.

Chat is the main task workspace. Structured agent results show their real summary or goal with expandable readable details; prose uses safe Markdown without raw HTML. Raw JSON stays in Logs. Normalized provider events form expandable file/search/command/edit/test calls, preserving command results and failures. New task configuration snapshots the three independent pipeline settings; global settings are defaults for future tasks. The composer selects a next-run follow-up provider/model/effort without mutating historical run metadata or approved stage order. Scheduled analysis does not replace task plans. The unmounted Monaco review components and their dependencies have been removed; selected-code review contracts and stored history remain supported. xterm.js renders actual PTY streams.

## SQLite and persistence

Cleanup uses runtime activity leases rather than persisted task/watch status to identify blockers. Task maintenance reserves only its task and reports relevant agent, terminal and linked-watch activity; global maintenance waits for all live operations, including GitHub sync and repository discovery. Existing repository locks continue to serialize shared Git metadata. Named blockers and explicit stop/retry actions travel through the existing RPC bridge. Cancellation releases leases after provider completion and terminal log flushing. Repository scan cancellation preserves the previous index; stopped PR inspections pause their watch and cannot start a later verification stage.

Migration 11 upgrades legacy PR decision JSON with conversation and request defaults, preserves saved snapshots and decisions, and requeues only the known pre-inference missing-field `slice` failure. Paused watches remain paused; provider failures and interrupted inference still require explicit retry. The scheduler also validates saved decisions through ActionSchema on read so imported legacy records receive the same defaults.

Vibestar owns one configured data root, defaulting to ~/.akkco-vibestar, with state, logs, artifacts, cache, repos, worktrees, runtime and telemetry directories. StorageService measures logical file sizes without following symlinks and restricts destructive cleanup to owned paths and recorded task worktrees/branches. Imported source repositories and provider credentials are never cleanup targets. Task history and raw logs can be cleared independently; usage survives task deletion with nullable links. Root migration copies a locked SQLite backup and owned data, rewrites copied Git worktree pointers and verifies them before activation. The original location remains intact; unsupported external worktree metadata fails safely and offers continued use of the old location.

Deleting task history implies deleting its task worktree and owned local branch, including when the worktree was already removed. Creation writes a task-ID ownership marker into the branch's local Git configuration and checkpoints branch_owned only after successful creation. Legacy ownership requires the persisted successful worktree-add record and a matching creation reflog when the branch still exists; the akkco/ prefix alone grants no deletion authority. Cleanup validates shared Git metadata and all branch checkouts before mutation, preserves foreign branches/worktrees and keeps history on failure. Detached app worktrees whose branch was already deleted can still be cleaned. Failed preparation checkpoints with no remaining branch, files or worktree registration can be cleared without Git mutation. The deletion dialog makes the history/worktree/branch coupling explicit.

backend/storage owns better-sqlite3, WAL, transactions, numbered migrations and redacted local logs. Tables cover repositories, issues, tasks, agent_runs, agent_events, task_messages, task_artifacts, test_runs, settings, scheduled_jobs, scheduled_attention, task_review_notes, terminal_sessions, task_activity, github_repositories, github_pull_requests and scheduled_agent_runs. JSON domain records retain issue context and task execution settings. A GitHub issue may have multiple independently runnable tasks.

Run records are written before spawning processes. Provider run IDs, model, effort, prompt, timestamps, PID/start identity, conversation ID, exit status and normalized structured outputs remain local. Redacted raw JSONL and separate stderr streams are retained under the task's logs directory. Chat snapshots show the most recent 2,000 events; the output browser pages complete persisted run events and raw files beyond that tail. Legacy raw-log callers still read a bounded 1 MiB tail. Authentication PTY output is ephemeral and credentials are never read or copied.

## Git and worktrees

The existing Repository registry now represents explicit active connections. RepositoryIndex remains a discovery index; discovered candidates never become active simply because they were found. A dedicated local connection dialog verifies a canonical WSL path (or converts a Windows drive path with the configured distro's wslpath), reads Git status, all remote identities, local/remote branches and remote HEADs, and displays explicit upstream/fork/base selections in width-constrained controls. Missing remote HEADs or ambiguous upstream identities require a visible manual choice. Verification tokens expire after ten minutes and connection rechecks location/remotes. Connection writes only an imported registry record; it does not scan, clone, fetch or modify the checkout. Registered JSON persists connection, ownership, environment and remote selections. Existing records default to connected.

Migration 12 removes the old upstream-only uniqueness constraint and replaces it with upstream-plus-checkout uniqueness, allowing different explicit checkout IDs for the same GitHub repository. The migration preserves IDs and task foreign keys, temporarily disables foreign keys only during the transactional parent-table rebuild, checks referential integrity before commit and restores enforcement even after failure. Disconnect removes a checkout from the active UI/selector while retaining its historical record, branches and worktrees; relevant live task activity prevents disconnection. Reconnecting the same checkout restores its existing ID.

New Task visibly selects an active repository and sends repository_id through strict preview/create RPC schemas. An issue can suggest one matching active selection, but a user's later selection is authoritative. Both RPC and Engine reject issue/upstream mismatches before fetching context or queueing work; task creation never calls GitHub registration or substitutes a clone. Selected legacy managed records are also marked explicit before queueing, so a missing clone cannot silently become a different discovered checkout. GitHub catalog has one All view with explicit Find local checkout and confirmed Create Vibestar-managed clone actions. Explicit managed registrations skip automatic checkout substitution. The simplified repository page presents active connections first, discovery second and GitHub last; there are no Recent/Forks/Owned filters or advanced URL form.

Task source, worktree, owned branch and pinned base are visible in expandable workspace metadata and before task creation. Finalization preserves the worktree, offers review/open/mark-complete actions and never commits or switches the source checkout automatically.

RepositoryIndex scans configured WSL roots with bounded depth, time and entry limits, skipping build/dependency/hidden/system trees and symlinks. GitHub HTTPS and SSH identities match indexed checkouts; WSL-native sources rank before explicitly configured Windows roots. Legacy Git URL registration can scan before cloning; explicit connections revalidate the selected path, while explicit managed clones never substitute a discovered checkout. Deferred registrations honor an explicitly selected checkout; established repositories keep their worktree relationship, and a missing managed clone cannot be replaced while task worktrees exist. Imported sources retain their location, remotes, branch, index and files; fetch writes only a Vibestar-namespaced base ref and task preparation adds owned branches/worktree metadata. All task working directories remain under the data root. Agent isolation exposes only read-only shared Git metadata and the assigned worktree metadata, never the imported checkout's files or sibling worktrees. Cleanup must distinguish imported references from managed clones.

backend/workspace owns URL parsing, branch sanitization, safe paths, issue retrieval and Git commands. Each repository ID references one imported checkout or one harness-managed partial clone with complete history; distinct IDs can reference different checkouts of the same upstream. Upstream and optional fork/origin remain separate. A repository-level filesystem lock serializes fetch and shared worktree/branch operations.

Every new task fetches its configured upstream (a managed remote or a namespaced imported ref), resolves the configured upstream base branch, saves its exact SHA and creates an independent branch/worktree from that commit. Preparation checkpoints allow recovery without abandoning or silently replacing a worktree. Imported checkouts provide Git object storage and a Vibestar-owned fetched base ref; their current branches, index and source files remain untouched. Existing task bases remain pinned. Collision suffixes are deterministic.

Final changes compare the saved base SHA with current worktree content, including committed, staged, unstaged, renamed, deleted and untracked files. A separate untracked flag distinguishes untracked additions in the file tree. ChangesView renders colored unified patches; full editor review opens the assigned worktree externally. Binary and oversized files remain listed but text rendering is limited to 4 MiB. Canonical paths reject traversal, escaping symlinks and Git metadata access. Discard operations require explicit RPC confirmation and cannot run while the worktree is active.

Local review notes anchor selected base/working lines with a content hash. Sending notes to Codex is a deliberate task-local continuation, never a GitHub comment. Agents must verify anchors if source versions drift.

## Providers and execution

Provider detection reports structured connected/account and model capability fields. Antigravity authenticates through successful `agy models`; Codex checks official subscription login and discovers account-visible models and their reasoning efforts through the official app-server `model/list` handshake without starting inference. Fixed Antigravity variants expose their encoded effort; adjustable models use a maintained capability list, and unknown unsuffixed models require an explicit capability entry. Unknown models and unsupported effort fail explicitly. Settings retain independent utility AI and bounded local repository discovery configuration. Migration 8 adds a local checkout index, local AI usage, detached utility runs, and durable message delivery metadata. Migration 9 backfills historical run metadata without inventing tokens. Migration 10 persists optional official subscription-window snapshots with each run. Official Codex account/rateLimits/read supplies optional reported subscription windows; unavailable interfaces remain labeled as not exposed. Repository registration, preparation and fetch operations hold activity leases; cleanup holds a maintenance lease and migration preserves missing runtime metadata without overwriting current desktop preferences. Migration uses an interruption journal so partially promoted data is never activated.

backend/execution/providers contains real Antigravity and Codex adapters. Detection inspects installed version/help, safe authentication status where available and Antigravity model discovery. Commands use only verified official flags. Codex utility runs use the documented --skip-git-repo-check option for their empty read-only workspace, and the adapter maps optional application fields to the official strict nullable output schema and restores them before validation. No mock adapter is selectable in production. Tests inject fixtures at the execution boundary.

Antigravity runs verified headless plan mode with structured JSONL and a schema. Codex uses official exec with JSON events, output schemas, independent reasoning configuration and read-only planning or workspace-write implementation. Unsupported configurations surface provider/stage/exit/error detail and are not silently downgraded. Subscription runs filter API-key overrides and keep authentication owned by each official CLI.

Adapters preserve raw events and normalize run.started, message, analysis.status, file.read, file.changed, command.started, command.output, command.finished, test.result and terminal run outcomes. Generic call IDs, paths, commands, output, durations and exit codes allow renderer grouping without CLI-specific parsing. Lifecycle/input envelopes remain raw debug events rather than fabricated thinking activity; empty metadata is not promoted into chat content. Observed Antigravity tool ERROR events normalize to finished/failed calls with their captured error, rather than remaining visually active. Follow-ups reconstruct persisted issue/scope/plans/messages in a fresh official run when stable headless session resumption is unavailable.

backend/execution/process executes argv arrays without implicit shells, streams stdout/stderr separately, filters environment variables, redacts secrets, bounds capture, enforces deadlines and tracks process groups. Cancellation sends a graceful interrupt, then escalates termination if necessary. No dangerous global permission bypass is enabled.

## Job queue and recovery

AgentRunner is the shared execution path for pipeline, chat and utility inference. UtilityAI accepts a purpose, prompt, optional schema and read-only workspace/context and snapshots the independent utility configuration. Every attempted AI run gets a local ai_usage record before provider validation; reported usage fields remain nullable, and remaining subscription allowance is never estimated. Detached generic utility execution has its own recoverable run records; no telemetry leaves the device.

Engine owns a SQLite-backed queue with default concurrency 2, configurable 1–4. Different tasks run concurrently; stages inside one task are sequential: prepare, Antigravity plan, approval, Codex refinement, approval, Codex implementation, validation, approval, Antigravity final review/tests, final approval, Ready for Review. Stage-specific retries reuse successful earlier artifacts. Follow-up instructions affect only their task.

On startup, recorded PID and process-start identities prevent accidentally killing recycled PIDs. Disappeared/terminated active agent, test and terminal records become Interrupted. Expensive inference is never automatically repeated after a crash. Resume, Retry Stage and Restart Pipeline are explicit actions. Shutdown aborts the engine, stops the scheduler and PTYs, then closes persistence.

TaskTerminals owns real node-pty shells in the same required outer sandbox. Starting an interactive terminal acquires an exclusive task-worktree lease: other tasks can continue, but agents/manual command runs/scheduled analysis cannot race that shell in the same worktree. Closing the shell releases the lease. Switching renderer tabs only detaches xterm; the process stays alive and replays a bounded sequenced transcript. Terminal log errors surface in the UI without preventing PTY cleanup. Terminal PID identities and redacted transcripts are persisted; a crashed shell is not silently restarted. Authentication PTYs are separate official CLI login sessions.

## Manual PR inspection and analysis

backend/scheduled retains the tracked PR registry and legacy decisions/attention, but has no timer or background execution. GitHubService.start is inert, main does not start GitHub synchronization, and authentication completion only refreshes connection metadata. Explicit Refresh PR List retrieves authored PR metadata through gh and never creates a tracked inspection. Track PR creates an inactive idempotent record. Analyze PR creates an idempotent PRAnalysis session; it retrieves fresh context and invokes the configured UtilityAI only when human prose needs classification. Analysis leases are registered before execution so storage cleanup and PR removal cannot race the operation. Legacy Check now performs GitHub inspection only. Automatic enable requests and the old issue-follow-up fix action are rejected.

Migration 17 disables all legacy enabled/one-shot schedules and interrupts pending automatic work without deleting snapshots, decisions, attention, runs or usage. Runtime readers/writers enforce disabled scheduling even for imported records. Migration 18 adds pr_analyses, pr_review_actions and immutable pr_action_assessments; existing scheduled_agent_runs and ai_usage link to the analysis ID. Interrupted analyses recover explicitly while original issue-task queue/recovery behavior remains unchanged.

GitHubMonitor.inspect reuses GitHubClient pagination for comments, reviews, inline replies, changed files, available commits, check runs/statuses and linked-issue context. Nested GraphQL thread comments are paginated and retained; REST/GraphQL identities are joined and canonical discussion entries deduplicated. Snapshots retain full review bodies, source URLs, reply relationships, original/current diff coordinates, PR/fork/base identity, patches and coverage warnings. Missing patches, API caps, failed optional collections and concurrent PR changes are visible; essential pagination failures cannot advance a snapshot. Different check providers with the same label stay separate.

backend/review/pr owns strict semantic result schemas, complete bounded read-only context packets and source validation. One explicit analysis can invoke one official provider run, using existing sandbox/auth/log/usage behavior. Exact acknowledgments and author/bot-only activity avoid inference; unchanged complete reports reuse saved assessments. Long sources are segmented without losing text, and every source/segment has reported coverage. Partial coverage is never labeled complete or automatically retried. Stable host-assigned action IDs anchor exact original quotations, including separately tracked observations from one review; edited correspondence can explicitly reuse a prior ID from that source. Author replies and reviewer acknowledgments require real later citations; commits/thread resolution never establish verified code. Only explicit question answers are marked answered. Analysis leaves code unverified; repair records independent findings and observed command evidence separately.

The PR inbox/details display provider/model/effort before Analyze, full Markdown conversation, source-linked action items, questions, positive feedback, CI/patch context, immutable analysis history and repair sessions. Progress polling reads local history only. Saved prompts/redacted raw logs and ai_usage remain accessible for analyses and repairs. GitHub replies and thread-resolution operations remain unavailable. [PR repair system](docs/PR-REPAIR-SYSTEM.md) documents the integrated workflow, migration/RPC inventory, evidence and manual acceptance procedure.

Native Windows startup validates the WSL helper bytes against the bundled core hash before loading it, preventing an older helper from starting legacy PR timers after desktop upgrade. The core advertises manual_pr_analysis; the bridge rejects PR mutation/analysis against helpers that cannot enforce the policy. Existing issue approval capability checks remain independent.

Milestone 1 has separate collector, migration, report-rendering and manual-operation tests, including nonadvancing nested pagination, saved reports after failed retrieval, and shutdown/reopen without inference replay. Bridge tests verify independent issue/PR capabilities and execute the WSL launch script against matching and outdated fixture helpers before any legacy code loads. `npm run test:desktop:pr` exercises the built Electron renderer and IPC with injected GitHub context and fixture providers, an empty production core root, and blocked real CLI executables. It verifies tracking without inference, one explicit runner invocation, full review text, usage/raw logs, and quota-free reuse. Existing issue integration/approval suites remain the regression boundary.

## Security model

Mandatory bubblewrap mount isolation hides other worktrees, home data, Windows drives and ADE state/configuration. Shared Git metadata is read-only, sibling worktree metadata is hidden, and only the assigned worktree is mounted read-only for planning or writable for implementation/terminal commands. System files are read-only; temporary files use sandbox tmpfs. SSH-agent and desktop-bus environment access are removed inside the sandbox. WSL DNS resolver targets are mounted explicitly. Missing isolation fails closed.

Provider-owned authentication/session directories must remain available to official CLIs. Vibestar does not inspect their contents. This is a documented trust boundary: mount isolation cannot distinguish a provider's authentication code from a tool in the same provider process. Provider tooling and its restrictions remain trusted. Network inference and upstream/issue reads are permitted; no application feature automatically pushes, creates PRs, comments, merges or changes issue administration.

## Build and verification

All application code is TypeScript; there is no Rust/Tauri backend. scripts/build.mjs bundles separate Electron and Node core entries. Locked core native dependencies are installed for Node 22 independently of Electron's ABI, including when deploying the helper inside WSL. electron-builder packages Linux deb and Windows NSIS targets with a local icon.

Tests cover URL/branch/path/state parsing, event normalization, argv handling, SQLite/recovery, real Git isolation/diffs/retry, PR snapshot change detection, renderer view state, official-auth PTYs, real task-terminal isolation and terminal crash-record reconciliation. The opt-in live test previously completed the authenticated Antigravity → Codex refine → Codex implementation → validation slice. Current Electron checks exercise real IPC, plans, explicit review gates, prompts and external editor actions with fixture providers; retained diff/review contracts have separate internal tests. Authenticated GitHub discovery and native Windows development have separate running-host checks. NSIS installation/update still needs separate verification. docs/VERIFICATION.md records the measured subscription run, Electron captures and built Linux/Windows artifacts.

## Frontend design direction

Settings use a local IDE navigation for General, Agents, GitHub/PR Watch, Repositories, Storage, Usage and Execution. Utility AI configuration is independent from all coding stages; PR use requires explicit Analyze. Local scan statistics, owned storage categories and confirmed cleanup actions are visible. Global, task and PR usage views show actual runs and each provider-reported token field independently; missing totals do not hide available input/output counts. Provider views and temporary auth dialogs render connected booleans and explicit success; they never derive state from display text or invent subscription tiers/limits.

Palette: app #17181b, sidebar #1b1c20, conversation #1f2025, elevated surfaces #27292f,
and subdued borders #34363e. Named surface, focus, text, spacing, radius and semantic
tokens keep the charcoal layers consistent; xterm authentication and task shells
read the same colors and Geist Mono family. Geist Sans serves interface prose.
Controls use 8px radii, inputs 10px, panels 12px and the composer 18px. Elevation,
spacing and typography distinguish sections. Blue indicates selection/activity,
green success, amber attention and red failure. Motion handles discrete navigation
selection; CSS handles simple control/dialog transitions. Both honor reduced motion.
No third-party IDE source or proprietary assets were copied. react-markdown and
remark-gfm render readable responses without raw HTML.

## Desktop window milestone

The host explicitly enables maximize/fullscreen/resize. Native Windows owns maximize/fullscreen transitions and display/DPI geometry. Only WSLg uses the delayed maximize geometry fallback; entering fullscreen cancels that fallback, and repeated resize events publish state only when it changes. Preload publishes maximize and fullscreen state, F11 toggles native fullscreen and Escape exits it. Native F11/Escape events are handled in the main process with browser key events prevented; the renderer retains a fallback for injected keyboard events. Native Windows keeps native app-region dragging and is the default development host when launched from WSL. The optional Linux/WSLg host uses Xwayland and a sender-validated pointer-drag fallback; its upstream frameless compositor offset is documented separately.

## GitHub and issue scope milestone

backend/github uses official gh authentication only. It stores repository metadata and authored upstream PRs separately from managed clones. Search partitions requests exceeding GitHub's 1,000-result limit. Known missing PRs require a confirmed closed/merged response before archival. Fork inference requires GitHub parent metadata; task linking requires matching upstream, head repository and branch. GitHub synchronization runs only after explicit Refresh PR List. Clones are prepared only on Use locally or task preparation. Migration 7 adds detached PR analysis run persistence. Migration 6 assigns existing tasks partial semantics and persists an explicit scope_mode column and JSON field. Whole issue tasks store no claimed scope; every stage receives the explicit entire-issue instruction.

PR metadata discovery never creates watches. Tracking is explicit and inactive; confirmed merged/closed tracked PRs are archived without inference. Inspections include paginated review threads, all CI transitions, head and base changes. Deterministic classification records failures/conflicts/requested changes; approvals, own comments, bots and unchanged snapshots avoid inference. Explicit Analyze PR uses a source-linked engineering report schema via the configured read-only Utility AI; legacy optional verification is disabled. Follow-ups can choose either provider with a next-run configuration; historical run settings and the approved stage order stay intact. Linked local PR feedback is included in explicitly requested continuations.

## Task-centered IDE shell

The composer intercepts Enter (except IME composition), preserves Shift+Enter, and explicitly prevents form navigation. Shared buttons default to non-submit; compact provider/model/effort menus use discovered capabilities. Persisted turns render immediately after the save response, independently of run success, with copy and retry/edit controls. Task Usage joins the utility dock. PR inbox rows show saved status, a concise summary and last-analysis metadata; full reports distinguish deterministic/reused results from explicit utility inference. Labelled actions and restrained green/amber/red/blue borders open a readable conversation/check/decision/analysis drawer with local run telemetry.

The task tree opens a task immediately. Tasks opens the active Overview queue landing. Chat, Plan and Usage are center views, with an optional resizable pipeline context pane and a resizable Changes/Problems/Tests/Terminal/Logs dock. Task-ID keyed state owns each draft, selected file, next-message provider/model/effort, and pane choices. The Changes panel shows file-level unified patches. Full source review opens an external editor on the task worktree. Actual preparation Git command results are persisted in task_activity and shown before the agent stages. Conversations group real events by run, interleave user turns chronologically, and render prose/structured results without raw JSON. Login PTYs exist only in an ephemeral authentication dialog, with scoped event subscriptions and cleanup.

Advanced repository overrides update managed remotes under the repository lock after rejecting active/queued tasks; existing tasks keep their saved base branch and SHA. Clone preparation now accepts task cancellation. Terminal worktree leases are distinguished from active agent execution in the renderer so opening a utility shell does not display a running agent.

Tracked PRs remain inactive across reopening. Legacy Check now performs one GitHub-only inspection without inference or scheduling. Deferred/retried analysis refreshes GitHub first, so stale pending feedback cannot bypass a new closed/merged state. Review attention persists through unrelated CI progress until discussion changes or the user dismisses it.

Development keeps Vite HMR for renderer files and watches backend/electron TypeScript to rebuild the core, main and preload and restart Electron. Vite is spawned directly so closing the desktop also stops its server; generated build/package directories are excluded from HMR. Shutdown uses a development-only stdin quit command on Linux and WM_CLOSE on Windows, where WSL interoperability does not forward GUI stdin reliably. The Windows main process writes its window handle and PID into a private temporary metadata file; the launcher validates them and checks the current native owner PID before sending the close message. Both paths perform existing graceful bridge shutdown before restart. Development CLI arguments can enable diagnostics; production remains unchanged.

Windows-host bounds alone missed the reproduced WSLg frameless maximize bug: the Xwayland parent retained a 32px shadow margin and the rendered surface was offset despite correct reported bounds. scripts/dev-host.mjs therefore selects the matching official native Windows Electron binary when launched from WSL, downloading with checksum-verifying @electron/get and extracting into a versioned Windows development cache. Unpackaged development configuration points the existing Windows WSL bridge at the current checkout's built core and the same Linux data root; it does not overwrite installed desktop configuration or move provider accounts. Windows interoperability and unzip are required; VIBESTAR_DEV_HOST=linux explicitly selects the legacy WSLg host. Initial window dimensions fit the current monitor's work area and DPI scaling.

scripts/test-windows.mjs exercises the native Windows host using isolated WSL state, with maximize, fullscreen viewport/DPI and restore checks on every connected monitor and a local Playwright cache. It distinguishes invisible native resize borders from visible content bounds and uses actual Win32 mouse input to verify dragging and double-click. Fullscreen and maximize/restore are also exposed through the command palette. Composer context uses an inline field instead of Electron's unsupported window.prompt dialog; the draft remains task-local.

### Live review and local telemetry refinement

Migration 13 extends `ai_usage` with official before/after subscription snapshots and provider session IDs, and adds content-bound reviewed files and selected-code questions. ReviewService obtains selected code from the isolated task itself, bounds the prompt, persists the question before execution, and uses UtilityAI with an optional review configuration. The existing stage-1 sandbox remains read-only; requests for edits use normal task continuation separately. Questions link to agent_runs, task messages, raw logs and ai_usage; cleanup treats these as task-owned history. Interrupted questions recover explicitly.

Editor discovery checks supported CLI executables in the execution environment. Task editor actions validate and open the task worktree; repository actions open the source checkout. Default editor and optional Review AI preferences use the existing settings record.

Editor opening uses the existing modal surface and displays a pending launch state. Official WSL CLI shims receive a fifteen-minute startup timeout to accommodate their first-use editor-server installation; they remain separate from sandboxed AI execution.

When `code` resolves to the Windows WSL shim and its adjacent native VS Code executable is present, the editor launches with the supported `--folder-uri` argument and a percent-encoded `vscode-remote://wsl+<distribution>/...` task/source URI. This delegates WSL connection setup to the installed Windows editor, avoids the shim's blocking shell bootstrap, and never kills the external GUI on normal CLI completion. Other editor CLIs retain their checked argv invocation. No shell interpolation is used for repository paths.

Managed clone jobs extend GitHubService's existing metadata/fork resolution and Engine.prepareClone. The registry records ownership and an incomplete-clone marker; task selection becomes active only after cloning, remotes and base verification succeed. Git CR/newline progress uses the existing process executor and redacted local log files. Jobs expose bounded activity in the repository snapshot and register cancellable lifecycle blockers. Cancellation terminates the Git process group and removes only incomplete destinations inside the managed repos root. A pending clone marker permits safe retry after a hard interruption; imported checkouts are excluded.

Queued clone preparation refreshes persisted completion markers after acquiring the Git lock, so a stale caller cannot remove a clone that another operation just completed. Catalog actions distinguish an active clone from a disconnected managed checkout.

The persistent current-run strip consumes agent_runs and normalized events across all task tabs. The Agent Output dock tails the existing bounded stdout/stderr files. Usage subscribes to local lifecycle events and refreshes while open; live durations use actual start times, and progressive token values appear only when reported. Official allowance changes are shown only across matching window/reset/plan snapshots and are labeled percentage-point deltas.

The desktop compares its bundled core hash with a `core.info` response and keeps a visible warning for stale/unverifiable WSL helpers. Usage displays the actual database path. Installed Antigravity stream evidence confirms per-step usage plus a final aggregate: Usage.observe sums reported per-step counters idempotently by step index for live display, then replaces them with the provider's final aggregate. It does not derive missing totals or quota estimates.

The task UI uses the Changes utility dock for unified patches and an external editor for full source review. Backend diffs, reviewed state, anchored notes and selected-code review contracts remain intact for compatibility; no Git/diff architecture is replaced. The visible primary action opens the task worktree in VS Code, with another-editor and folder/path fallbacks. Host editor launches alone may inherit WSL interoperability; sandboxed agent and terminal executions continue using the filtered environment without that escape path.

Selected-code answers preserve provider-emitted final prose when Antigravity separately reports a short structured completion summary. Only a valid trailing JSON envelope is removed from that prose; bounded Markdown is stored with the question. Context-building errors use the same persisted failure lifecycle as model errors, and both full-file and diff selections retain their line context.

New task creation refreshes the persisted workspace snapshot before selecting the newly created task. This prevents the initial stale snapshot from clearing the task selection before its workspace is opened.

### User-reviewed pipeline

Pipeline stages now pause durably after Antigravity planning, Codex refinement, implementation/validation, and Antigravity final review. The existing Task JSON carries an approval gate; explicit task.approve advances it, while feedback reruns the appropriate planning or implementation stage. No provider starts merely because a review gate was reached. Final review uses the original worktree read-only and records reported tests and unexecuted checks; unresolved findings prevent accepting the final review. Migration 14 moves legacy ready/completed stage-5 records to the new terminal stage 6 without inventing a historical review.

Issue retrieval paginates full authored comments and gathers linked PR body/discussion/reviews/file lists from GitHub links and timeline cross-references. Each approved provider stage refreshes fetched context, including historical fetched issues identified by their saved issue number. Caller-supplied offline context remains offline. Missing PR context and bounded link omissions are explicit prompt warnings. Planning prompts forbid edits, tests and formatters; implementation runs approved validation, and final Antigravity review checks the complete diff against the pinned base.

Streamed schema-valid planning messages are persisted as drafts in the existing artifact table, separate from successful canonical plans. Known Antigravity toolAction/toolSummary envelope metadata is excluded from the plan fields. Drafts survive cancellation and appear while streaming; they never automatically start another agent. An explicit recover-draft action stops the run, preserves its real outcome, validates the schema and worktree fingerprint, and presents the recovered plan at its approval gate. Historical initial drafts without comparable versioned fingerprints remain visible and require explicit fresh planning before approval. Canonical artifact reads exclude drafts. Exact redacted sent prompts are accessible from every task tab and beside historical runs.

New Task now supplies the existing provider discovery hook to the stage controls. Model dropdowns show official CLI capabilities, explicit unavailable selections and supported efforts, with manual refresh; metadata discovery never starts inference. Final Antigravity review reuses the task's Antigravity configuration.

Final review acceptance is bound to a worktree fingerprint. Edits after the review require a fresh review before acceptance or marking complete. The final review panel expands its actual findings and executed/unexecuted checks by default; the Tests dock also includes the final reviewer’s reported coverage.

The composer labels its provider as Follow-up so a saved next-message selection cannot be mistaken for the currently executing provider. The run strip continues to use the actual persisted run.

Desktop approval acceptance uses the real built Electron renderer and IPC with a test-only fixture RPC target, a separate empty production-core root with auto-watch disabled, and blocked AI executables. No fixture provider is made selectable in production. Approval waiting states do not mark a future stage as running.

Antigravity’s provider-facing output schema permits the two observed optional toolAction/toolSummary metadata fields. The adapter removes these only when they are not part of the application schema, then validates the original strict domain result. Arbitrary additional plan fields remain rejected. This compatibility uses the existing outputSchema/parseStructuredOutput provider hooks.

### Runtime dependencies, explicit review prompts and core compatibility

The core advertises pipeline approval support in core.info (protocol 3). The bridge blocks task creation/retry/follow-up/approval against helpers lacking that capability, while reads, cancellation and cleanup remain accessible. A durable gate opens a review-required dialog on first display; dismissing the dialog never approves the gate. Migration 15 moves legacy ready tasks without a final review to the implementation review gate, preserving their code and completed runs without starting inference. Completed history is retained.

Task runtime preparation reuses installed node_modules, third_party and virtualenv directories only when Git ignores them and neither checkout tracks their contents. Empty ignored worktree directories serve as sandbox mount targets; source dependencies are mounted read-only, without symlinks that bypass file-boundary checks or expose source files. Existing nonempty worktree installations remain task-owned. Local .venv/venv or a single safe .python-version pyenv selection identifies Python; only its validated environment/interpreter directories are exposed. No installation, reset or source edit occurs. Runtime paths and warnings are persisted in Task JSON and included in prompts and Tests; login-shell commands are instructed to use the explicit interpreter. Agents and task terminals share the runtime mounts; external editor terminals do not inherit bubblewrap mounts and can use their own task-local installations.

Projects that install a sibling toolchain named `<checkout-folder>_tools` reuse that directory read-only at the corresponding task-parent path (for example, Oppia's `../oppia_tools`). Only an existing directory at that exact canonical sibling location is exposed; escaping symlinks are rejected. The mount target exists only in the sandbox, with no sibling-directory creation on disk. Arbitrary home or sibling directories are not mounted.

Provider command sandbox connection errors retain their failed attempts and explain the dropped connection. Skipped provider-reported tests use an amber unavailable marker rather than a green success check. No provider sandbox is disabled and no model inference is used for this verification.
