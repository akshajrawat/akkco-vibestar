# Workflow contracts

This guide collects the maintained contracts previously spread across milestone plans.
It describes current behavior; historical counts and experiments live in the separate
evidence records. See [architecture](../../ARCHITECTURE.md) for module ownership and
[security](../security.md) for trusted boundaries.

## Issue creation, chat and startup

The repository picker searches connected repository names and shows environment/base
branch information. Source paths and worktree ownership remain in Details. Selecting a
connected GitHub repository reuses its registration instead of offering it for import.
Discovery defaults to configured project folders, skips temporary/generated/managed
subtrees, and allows explicit unusual paths. Broad home scans are an advanced opt-in.

Creating a task writes an idle `not_started` record. It does not drain the queue,
prepare a worktree or invoke a provider. Whole-issue scope and claimed partial scope
retain their distinct meanings. Requests bind UUIDs to a canonical payload digest;
a repeated matching request returns its original task, including after transport failure.
Tombstones prevent history deletion from turning a retry into a new task.

A read-only question is persisted before execution. It may prepare the owned worktree,
uses the existing runner/logs/events/usage and leaves the workflow idle. Only completed
chat messages explicitly selected at startup, or a user-reviewed summary, enter the
implementation pipeline. Historical instruction messages retain their original purpose.

Explicit startup validates current repository identity, provider capabilities and
selected conversation ownership, then atomically saves durable startup authority.
Concurrent identical requests share settlement. Shutdown aborts and awaits validation.
Historical queued entries retain the authorization they already had.

## Stage gates, instructions and drafts

Preparation pins base identity and records real Git activity. Antigravity planning,
Codex refinement, implementation/validation and independent Antigravity review each
pause at their existing human gate. No future stage is shown as running merely
because approval is waiting. Provider/model/effort display comes from actual saved runs;
composer settings affect the next requested message.

Approval binds the artifact the user viewed. Pending saved instructions need an explicit
keep-saved/include-next-stage choice bound to current message IDs. Retry does not consume
unsent drafts. Feedback reruns the appropriate stage in the same worktree; it does not
silently discard source changes or reset the pinned base.

Streamed schema-valid plans are drafts, separate from canonical successful artifacts.
Recovering a draft stops its run, preserves the real outcome and checks schema plus
versioned worktree fingerprint before presenting approval. Legacy incomparable hashes
require fresh explicit planning/review. Unknown provider metadata remains rejected;
only known adapter envelope fields are removed before strict domain validation.

## Verification and independent review

Verification distinguishes application failures, environmental prerequisites and evidence
gaps. Observed command records retain argv, streams, exit and attempt identity. Provider
reports are separately attributed; unknown/skipped tests cannot become passing coverage.
Historical requirements and unresolved failures remain additive across repairs.

- **Recheck saved evidence** reuses retained command/tool exits and host diff hygiene.
  It runs no provider, installs nothing and does not deliver pending instructions.
- **Run missing checks** replays only supported validated recorded argv. A known literal
  shell wrapper can be decoded without interpreting an arbitrary shell program.
- **Prepare missing checks / Fix with Codex** explicitly authorizes one implementation
  iteration, retaining failures and environmental limitations.
- **Continue independent review with gaps** requires a fresh worktree/evidence-bound
  acknowledgment. Genuine application failures or ambiguous evidence cannot use it.

Repository policy requires automated checks and explicit issue requirements while extra
unexecuted manual browser checks can remain optional. Existing tasks change policy only
through an explicit journaled operation. Reports cannot downgrade protected requirements.
Passing optional evidence does not substitute for missing required execution.

The read-only final reviewer receives a complete retained evidence packet. Its source
verdict and coverage are distinct. `reviewed_with_gaps` retains unavailable checks and
blocks finalization. Acceptance binds the current review fingerprint; edits invalidate it.
An unchanged recheck preserves an accepted review rather than starting inference again.

Browser diagnostics have strict environment/report contracts. Opening the panel runs
nothing. Explicit selection may mount validated installed browser/cache paths read-only
for supported manual checks; provider-internal sandbox rules are unchanged. Capability
success proves tooling availability, not application correctness. No automatic download occurs.

## PR discovery, analysis and batches

Explicit Refresh uses official `gh` to collect authored PR history and local inactive
review identities. Metadata discovery does not clone, start analysis or create a timer.
Search partitions avoid GitHub result limits. A missing search result never proves
closed/merged state; direct retrieved identity wins and partial budgets retain warnings.

Analyze refreshes bounded complete context, source discussion/threads/checks/files and
identity before using UtilityAI when semantic assessment is necessary. Complete unchanged
reports and deterministic acknowledgments can reuse evidence without inference. Source IDs,
quotations, reply evidence, thread resolution and verified code outcomes stay distinct.
Missing coverage is visible and does not become a complete assessment.

Analyze All previews saved reusable reports, selects at most 20 PRs and exposes a visible
AI limit (default five). Each item refreshes again. A durable counter is charged immediately
before semantic invocation; deterministic/reused results consume none. Completed results
survive cancellation. Startup interrupts unfinished batches without replaying work.

## Isolated PR repair

Repair uses a separate immutable session because PR head/base identity and selected
observations differ from issue planning. It records exact upstream/fork repository IDs,
current PR head/base, source-linked selections, user instructions and provider configuration.
Constructor-only local transports support fixtures and cannot come from renderer input.

Preparation creates its own owned branch/worktree, integrates the actual latest PR base
in the correct direction and protects existing ignored files against incoming tracked paths.
Conflicts preserve files/index and require explicit resolution/resume. Source checkout,
issue worktrees and unrelated branch/index state remain unchanged.

Codex implements selected concerns; independent Antigravity review receives read-only
source and full retained context. Every selected action requires one schema-valid result.
Observed tests remain separate from reported summaries. The workflow stops at manual review.
Explicit further fixes reuse that worktree and retain earlier evidence.

Local-only approval/commit works independently of remote push permission. Preparation of
a publication plan and Confirm Push are separate. Publication rechecks open PR identity,
viewer permission, selected fingerprint, ancestry, exact head destination and expected
remote SHA. Stale heads stop for fresh analysis. Unknown network outcomes reconcile
read-only; reopening never repeats a push. Cleanup needs owner/ref evidence and clean,
non-conflicted content, and retains history unless history deletion is separately confirmed.

Changes exposes original PR, upstream integration and repair baselines. Content-bound
review marks invalidate when the file changes. Shared terminal leases exclude agent or
publication writers; editor actions resolve the exact owned repair assignment.

## Manual Issue Watch

A saved watch has immutable criteria/configuration revisions. Local preview compiles
hard filters deterministically. The editor separates guaranteed GitHub filters from
preferences requiring evidence inspection; saving records the latter as semantic
preferences without promoting them into guarantees. A bare issue reference asks a
concrete context/exclusion question. The core still validates every compiled rule,
digest and ambiguity decision. Label chips
accept plain labels and verified repository-matching GitHub links. Label discovery is
an explicit bounded read, never a scan.

Scan Now, Recheck, Retry and Continue each authorize a distinct attempt. Collection uses
official gh with bounded concurrency, request/time/byte/source limits and fresh tracker
identity. Tracker bodies are default; comments are opt-in. Assignments, excluded labels,
verified tracker references, competing PRs and accepted claims override model preferences.
Claim age alone does not establish abandonment. Missing evidence stays uncertain.

Default bounds are 200 candidate identities, 40 detailed contexts, 20 semantic candidates,
400 GitHub requests, a 128 KiB semantic packet and a 120-second model timeout. At most one
host-started semantic invocation is reserved per attempt; CLI-internal requests are not
misrepresented as separate host authorizations. No provider fallback or automatic retry occurs.

Final metadata is checked after screening. Changed evidence makes the attempt partial.
Partial, blocked, cancelled and interrupted attempts preserve the last complete baseline.
Result history distinguishes initial discoveries, new GitHub creation, newly matching older
issues, eligibility reentry, criteria changes and not-rechecked uncertainty. Dismissal is a
local overlay, not a rewritten scan or baseline advance. Tracker IDs survive renames and
cannot be silently replaced by preference editing.

Progress reports real collection phases, requests and checked/discovered/excluded
counts without synthetic percentages. Previous complete results remain available during
a scan. Each result has a visible GitHub action bound to its retrieved issue identity.
Details open on selection and can be collapsed or resized. Incomplete attempts never
display a successful empty-result state.

Issue Watch uses supported Codex integration. The existing Antigravity adapter is not
exposed as a supported watch provider. Saving, opening, changing models and restarting
never authorize a scan. Task handoff only prefills the existing idle task form.

## Selected-file Git Finalization

Git Changes presents selected files, an exact commit message and commit/push actions
on one surface. Options hold presets and hook policy. Inspection proves task/worktree/branch identity and
records exact content/index fingerprints. Bounded no-follow file inspection excludes
unsafe aliases, credentials/private keys, unexpected binaries and generated/debug additions.
Ignored files remain unselectable.

Preview stages complete selected literal paths in a separate owned worktree/index.
Unrelated task/source staged content survives, including rename/deletion cases. Selecting
already staged paths needs an explicit full-content decision. The projected cumulative
patch includes earlier task commits; a subset or changed tree needs fresh independent review.

Required task verification is checked before selection, approval, commit and publication.
The review must settle required commands; prose alone cannot waive missing evidence.
Host diff hygiene runs independently. Manual approval binds the exact projected tree.

Exact commit objects preserve UTF-8 bytes, multiline content, spaces and the absence
of a final newline. They add no template, trailer or generated title. The journal precedes
branch/index compare-and-swap mutation and retains snapshots for explicit recovery.
Presets contain typed policy/destination fields, never arbitrary command strings.

Optional hook configuration is captured and rechecked. Authorized repository/worktree
hooks execute in the existing read-only sandbox with exact message input and bounded
output. Unsupported/missing/mutating hooks fail explicitly. Skipping these hooks cannot
waive host authorization, fingerprint, verification, ancestry or exact remote-SHA guards.

Publication verifies actual fetch/push URLs, the writable source or canonical contribution fork, viewer,
stable repository ID, permissions and exact remote object/absence. A different safe
feature branch requires fresh preparation. Confirm Push binds destination, commit and
SHA. Host ancestry proof plus an exact-ref lease permits only fast-forward updates or
an explicitly absent feature branch. A source destination requires fresh write permission;
an external contribution destination must be its verified fork. Non-fast-forward writes
are refused. No writable destination is required for a local commit.

Task options can connect a push repository for a managed clone. This explicit local
configuration requires fresh write permission and matching source identity or fork
parent ID/name. It observes repository locks, active tasks and terminal leases, and
requires the helper's destination capability. Imported checkouts choose existing
verified remotes without rewriting their Git configuration. Connecting a destination
does not commit or push.

Commit & Push first performs a read-only destination check. Confirmation shows the
exact destination, branch, selected files, unchanged message and hook policy. The click
then invokes the existing guarded approval/commit/prepare/publish operations in order.
Any destination, viewer, repository-ID or remote-head drift stops publication and keeps
the local commit. Saved presets never authorize execution or replay after restart.

Startup interrupts local mutations and marks uncertain pushes for read-only reconciliation.
Explicit resume applies only the original journaled local transition without duplicate
commits. Cleanup refuses unresolved journals or changed/unknown preview ownership.
Removing a preview preserves the task branch/local commit and cannot orphan dependent history.

## Storage reset and task disposal

Reset Local Test Workspace previews only eligible owned task resources and creates a
validated private SQLite/log/artifact backup plus result journal before removal. Dirty,
unpublished, uncertain and dependent work is preserved. Repositories, settings, provider
authentication, repair/finalization journals and independent Issue Watch/PR history remain.

Archive keeps data. History-only removal preserves work and an archived owner record.
Discard verifies a complete content fingerprint, task/path/branch identity, dependencies
and unpublished commit acknowledgment. Changed/recreated files, symlinks, pending Git
operations, hidden index flags and active leases stop removal. Interrupted checkpoints
can finish only the original authorized scope, never a newly recreated personal worktree.
