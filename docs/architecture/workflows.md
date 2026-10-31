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

Preparation pins base identity and records real Git activity.
Each issue gets a dedicated branch. An explicitly started workflow may use a clean,
unreserved source checkout already on its up-to-date base branch; otherwise it gets
an isolated worktree. Another task never commits, stashes or moves existing edits to
make room. Both providers receive the assigned directory and branch through the same
host ownership boundary. Source checkout files and branches are retained by task cleanup.

Plan, Plan refinement and Implementation with its checks pause for human approval.
Independent Review ends the workflow with a verdict and numbered next steps, on either
success or findings. Queued feedback remains saved, never an automatic fix loop.
No future stage is shown as running merely
because approval is waiting. Provider/model/effort display comes from actual saved runs;
composer settings affect the next requested message.

Planning prompts contain the issue, comments and scoped instructions; refinement adds
the original plan. Implementation receives the refined plan directly. Workflow prompts
are shown as user messages and provider replies remain visible in chat. Completed
activity is collapsed under “Worked for…”; technical protocol details remain in Raw logs.

After the final verdict, the ordinary composer can request one independent workspace
conversation turn with the selected model. It can edit only the assigned task workspace,
does not advance workflow stages, and invalidates the review fingerprint if content
changes even when the provider fails. Greetings and complete app-identity questions
use an empty read-only workspace with host-app context and skip source preparation.

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

Implementation reuses existing dependencies and runs all applicable test, lint, formatting
and required platform/stress commands. Agents do not install, upgrade or download packages,
browsers or toolchains. Existing ignored nested package dependencies are connected read-only;
missing prerequisites are reported with unrun checks. Package runners use offline/no-fetch
operation. It pauses at implementation approval, then independent review
runs the applicable checks again in its read-only source boundary. Missing implementation
evidence is supplied to the reviewer; it does not require a separate validation action or
gap-acknowledgment dialog before review. Genuine failures still prevent final acceptance.
The Checks tab records evidence rather than scheduling another workflow stage.

Legacy stage 4 remains readable and an explicit approval can continue its saved
implementation to review. Recovery RPCs remain compatible for older clients and retained
history; they are not offered as an additional user workflow. No change replays providers
on restart or discards saved instructions.

Repository policy requires automated checks and explicit issue requirements while extra
unexecuted manual browser checks can remain optional. Existing tasks change policy only
through an explicit journaled operation. Reports cannot downgrade protected requirements.
Passing optional evidence does not substitute for missing required execution.

The read-only final reviewer receives a complete retained evidence packet. Its source
verdict and coverage are distinct. `reviewed_with_gaps` retains findings or unavailable
checks and blocks task completion. Completion binds the current review fingerprint; edits invalidate it.
An unchanged recheck preserves an accepted review rather than starting inference again.

Browser diagnostics have strict environment/report contracts. Opening the panel runs
nothing. Explicit selection may mount validated installed browser/cache paths read-only
for supported manual checks; provider-internal sandbox rules are unchanged. Capability
success proves tooling availability, not application correctness. No automatic download occurs.

## PR discovery, analysis and batches

Explicit Refresh uses official `gh` with bulk GraphQL metadata to collect authored PR history
and local inactive review identities. The inbox action skips the repository catalog,
full review context and AI, and bounds the entire refresh to 30 seconds. Metadata
discovery does not clone, start analysis or create a timer.
Search partitions avoid GitHub result limits. A missing search result never proves
closed/merged state; batched direct identity lookups confirm known PRs missing from search.
Incomplete retrieval retains saved results and exposes an error without advancing freshness.

Analyze refreshes bounded complete context, source discussion/threads/checks/files and
identity before using UtilityAI when semantic assessment is necessary. Complete unchanged
reports and deterministic acknowledgments can reuse evidence without inference. Source IDs,
quotations, reply evidence, thread resolution and verified code outcomes stay distinct.
Missing coverage is visible and does not become a complete assessment.

The lightweight PR watch runs **once per app launch**. **Recheck open PRs** requests
another fresh pass; filtering, window focus and navigating away/back do not start another.
Core capability negotiation gates automatic startup. The core deduplicates repeated startup
requests and never resumes cancelled/interrupted runs. A saved failure needs explicit recheck.

Watch retrieval refreshes current PR status, then reads up to four conversations concurrently
with a 30-second collection budget. Each GraphQL request includes the PR body, comments,
reviews/threads, active review requests and up to 20 linked issue bodies. Connections retain
pagination flags; more than 100 comments/reviews/threads or 100 comments in a thread makes
coverage incomplete. Missing/oversized context stays **Needs a closer look**, never clear.
Pending reviewer assignments are neutral **Waiting for reviewer**, not work owed by the
authenticated viewer (normally akshajrawat). Formal review decisions and unresolved thread
markers alone cannot flag work. Complete conversations include author replies: answered or
addressed requests await the reviewer unless a later follow-up or explicitly unfinished work
remains. The watch does not require code verification or reviewer acknowledgment to recognize
a conversational response. Missing comment bodies for requested changes stay uncertain.
Requests from the authenticated viewer are ignored. Policy-versioned fingerprints invalidate
older classifications made using the previous assignment-based rule.

Remaining complete conversations share one compact model prompt up to 85,000 bytes; larger
sets are partitioned into bounded prompts. No diffs, commit history, CI history or file reads
are requested. The saved review/explain model takes precedence over the utility default;
the compact picker overrides provider/model/effort/time limit for recheck. The result is
an attention flag, short reason and validated source IDs, not proof of code correctness.
Unchanged successful classifications are reused after fresh retrieval. Timeout, invalid model
evidence, missing results or capacity limits remain uncertain and do not automatically retry.
The shared sandbox, usage accounting and execution-slot rules apply to every model call.

Detailed **Analyze PR** in the review workspace remains explicit and retrieves full context
for engineering observations and repairs. Its complete source packets and coverage validation
remain independent of the lightweight watch. Contexts up to 96 KB are supplied directly;
larger detailed contexts stay in complete on-disk packets. Timeouts never trigger paid retry
or silently raise the configured limit.

The inbox opens on **Open**; a compact status filter also offers **Merged**, **Closed** and **All** history. The
freshest known lifecycle determines terminal status, so old analysis state cannot label
a merged or closed PR as waiting for checks. Report coverage, stale context, failed checks,
work requests and unanswered questions retain separate outcomes. Model findings do not
prove code correctness. Filtering and refreshing metadata start no inference; only the once-per-launch watch and explicit recheck/analysis can do so.

Legacy explicit engineering batches retain their persisted authorization before work. A durable counter is charged immediately
before semantic invocation, bounded to the selected list; deterministic/reused results
consume none. Cancellation preserves completed and partial evidence. Startup interrupts
unfinished batches without replaying checks or inference. Retrieval publishes concrete
API/page phases and elapsed time under a two-minute per-PR deadline. One batch Stop
control immediately enters a durable cancelling state; it does not replay later PRs.

## Isolated PR repair

Repair uses a separate immutable session because PR head/base identity and selected
observations differ from issue planning. It records exact upstream/fork repository IDs,
current PR head/base, source-linked selections, user instructions and provider configuration.
Constructor-only local transports support fixtures and cannot come from renderer input.

Preparation creates its own owned branch/worktree, integrates the actual latest PR base
in the correct direction and protects existing ignored files against incoming tracked paths.
Conflicts preserve files/index and require explicit resolution/resume. Source checkout,
issue worktrees and unrelated branch/index state remain unchanged.

The selected implementation provider implements concerns; independent review receives read-only
source and full retained context. Every selected action requires one schema-valid result.
Observed tests remain separate from reported summaries. The workflow stops at manual review.
Explicit further fixes reuse that worktree and retain earlier evidence.

Users commit and push manually through the terminal after inspecting the retained
review evidence. The application starts no publication operation. Cleanup needs
owner/ref evidence and clean, non-conflicted content, and retains history unless
history deletion is separately confirmed.

Changes exposes original PR, upstream integration and repair baselines. Content-bound
review marks invalidate when the file changes. Shared terminal leases exclude agent or
other workspace writers; editor actions resolve the exact owned repair assignment.

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
official gh with serialized reads, request/time/byte/source limits and fresh tracker
identity. Tracker bodies are default; comments are opt-in. Assignments, excluded labels,
verified tracker references, competing PRs and accepted claims override model preferences.
Claim age alone does not establish abandonment. Missing evidence stays uncertain.

Discovery uses pages of up to 10 issues. Choose newest or oldest by creation time;
Scan now starts the first page and Next 10 advances the selected saved attempt.
Recheck accepts at most 10 selected candidates. Retry repeats the saved page.
Prior pages stay saved and are not automatically re-fetched. A successfully checked
batch retains its results without claiming complete repository coverage. GitHub
search pages can shift between requests; restart the first batch to discover new issues.

Default bounds are 10 candidate identities, 10 detailed contexts, 10 semantic candidates,
80 GitHub requests (also the host maximum for legacy configurations), a 128 KiB semantic packet and a 120-second model timeout. At most one
host-started semantic invocation is reserved per attempt; CLI-internal requests are not
misrepresented as separate host authorizations. No provider fallback or automatic retry occurs.
Authenticated conditional requests reuse persistent ETag response bodies only on a
GitHub 304 response. A rate-limit response stops queued watch reads for at least
60 seconds; the user must retry explicitly. Settings → Storage → Clear cache
also removes the bounded HTTP response cache.

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

## Manual Git in the terminal

Use **Open terminal** after reviewing task or repair changes, or open **Terminal** in
the workspace footer at any time after preparation. This starts and focuses the
normal Linux/WSL interactive user shell in the owned worktree. The shell uses your
Git configuration, credential helpers, SSH agent and CLI authentication like a VS Code
integrated terminal. Run `git status`, stage files, commit and push manually. For a
repair, push `HEAD` to the PR's existing head branch explicitly; its local isolated
branch may have a different name. For issue tasks, `git push -u origin HEAD` publishes
the current task branch. Managed checkouts receive a missing `origin` alias pointing
to the registered fork or repository; existing remotes and imported checkouts are
preserved. Remotes and hook policy can be managed with Git commands.

An open shell retains the workspace lease and blocks agents in that workspace until
the trash button (**Close shell**). Hiding the dock retains the session and output;
opening it again focuses the same shell. The plus button (**Start terminal**) starts
a new shell after the previous one exits. The shell has normal user filesystem/network
access; agent and verification commands stay sandboxed. Terminal output and saved logs remain bounded
and redacted. Restart stops sessions and never repeats commands, commits or pushes.

The removed commit/push workflow has no callable mutation endpoints. Legacy Git
records and migrations are retained, and storage continues to preserve unresolved
or dependent work rather than deleting its files or journals automatically.

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
