# Workflow-first IDE V3

## Audit and architecture decisions

The checkout started clean at `b96e65cc17744574a76f1a7b252bd96705da23ce`,
exactly the requested baseline. The existing Electron renderer delegates execution,
SQLite and Git authority to the Linux/WSL core. V3 retains this boundary.

The initial audit identified immediate enqueue in `Engine.createTask`, implicit
instruction delivery through the conversation table, cleanup tied to clean-worktree
removal, manual PR analysis identities, and technically dense secondary views.
AgentRunner already supplied the required read-only sandbox, streaming, cancellation,
redacted output and usage. Storage already supplied ownership checks and checkpointed
Git removal. The PR services already supplied source-linked semantic analysis.
Verification V2 and Git Finalization already supplied evidence and publication gates.
V3 extends these contracts rather than introducing another runtime or state store.

## Idle tasks and explicit startup

`task.create` validates the selected repository and issue and persists a versioned
`not_started` task. It does not prepare a worktree, drain the queue, run a model or
reserve execution capacity. Idle tasks stay idle after restart. Historical queued
tasks retain their existing authorization and queue behavior.

The right sidebar's **Workflow** view explains the idle state, exposes future stage
configuration, and offers **Start workflow**. `task.startWorkflow` validates a strict
request, checks the physical repository and all four provider configurations, and
records the request identity, digest and reviewed context before entering the
existing queue. A task maintenance lease blocks conflicting operations during
validation. Duplicate identical requests return the original authorization;
changed or competing starts fail. Startup validation is visible as an activity.
Failed validation leaves the task idle and can be retried explicitly.

## Repository conversation

The composer defaults to **Question · read-only** and supports the existing Codex
and Antigravity model/effort controls. `task.chat` saves the request, uses an existing
execution slot and AgentRunner, and streams normal persisted events/output/usage.
If necessary, it prepares the owned task worktree as **chat preparation**, without
changing the workflow state. Both source files and Git metadata are read-only in
the production sandbox. Chat cannot create commits, publish, alter scope or advance
pipeline stages. Stopping a question does not start/retry the workflow. Interrupted
questions remain interrupted after restart and are never replayed automatically.

Completed user and assistant messages persist in SQLite. Workflow startup offers
explicit message selection and a reviewed summary; all other chat is excluded
from implementation prompts. **Save for later** keeps the existing instruction
contract. After startup, questions remain read-only even at an approval gate;
**Request code changes** is a distinct explicit authorization using the existing
follow-up path. The four pipeline approval boundaries remain in force.

## Persistence and compatibility

- Migration **25** adds `task_messages.purpose`, defaulting historical records to
  `instruction`, and an index for conversations. New questions and answers use
  `chat`. Historical instructions and queued tasks keep their original meaning.
- Migration **26** adds `pr_analysis_batches`, a journal for manual bounded batches.
- Task JSON adds optional workflow-start and discard-authorization records and
  the `not_started` / `preserved` statuses. Existing task records remain readable.
- `Database.open` retains its private pre-migration SQLite backup behavior.
- The desktop requires core capability `workflow_first:1` for creation, questions
  and startup, preventing an older helper from interpreting idle creation as
  execution authorization.
- Existing saved tool keys remain stable despite renaming Pipeline to Workflow
  and Tests to Checks. Git wizard position uses the task-local view preferences.

## Archive, preserve work and discard

Task navigation's context menu or **Manage task…** opens three distinct choices:

| Operation                          | Result                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Archive                            | Hides the task while retaining history, files and branch.                                                                                |
| Remove task history, preserve work | Removes conversation/run/log/artifact history; retains an archived `preserved` ownership record, worktree, branch and dependent records. |
| Discard task and delete            | Previews, then deliberately removes eligible task-owned files/branch/history after separate confirmation.                                |

A preserved ownership record is intentionally retained so storage migration and
linked finalization/repair records can still locate and protect the work. It cannot
be restarted as a workflow; the retained editor action opens its worktree.

The discard preview includes identity, repository, branch, modified/staged,
untracked and ignored filenames, locally known unpublished commits, active work
and dependencies. Expandable lists make the loss reviewable. Unique commits need
an additional acknowledgment. Remote publication is inferred only from local
remote refs; this is conservative and may require acknowledgment for commits that
have not been fetched locally.

Discard reuses common-directory locking, managed physical paths, worktree/branch
ownership markers, expected branch SHA and scoped Git worktree removal. A fresh
streaming no-follow fingerprint covers tracked, untracked and ignored contents
and binds the exact task/path/branch. Changed previews fail. Only this distinct
confirmed path permits `git worktree remove --force`. Hidden index flags, pending
Git operations, symlink/path ambiguity, wrong ownership, active agents/terminals,
linked PR repairs and Git Finalization records still block removal. Imported source
checkouts, other worktrees and unrelated branches are never removal targets.

Authorization is saved before Git removal; an interrupted operation can finish
only the previously confirmed loss after new ownership/ref checks. Recreated files
do not inherit that authorization. Ordinary cleanup retains clean-worktree checks
and protects unique unpublished commits. History preservation refuses unresolved
publication/removal rather than erasing recovery evidence.

## PR discovery and Analyze All

**Refresh PR List** uses the connected GitHub account to discover authored PRs
across open/draft/closed/merged states, including upstream contributions. New PRs
receive inactive analysis identities automatically, without a pasted URL or model
run. Search is paginated/partitioned with a 200-request ceiling. Each refresh has a
500-detail budget with space reserved for known PRs absent from search. Persisted
cursors let later explicit refreshes inspect the next page. Partial refreshes show
an error/next step and retain the last complete-refresh timestamp and saved data.
Search absence never proves closure. Known missing identities are retrieved
directly; failures show unknown/inaccessible with separate last-known state.

The inbox separates GitHub lifecycle, saved CI, and review/action state. States
include Not analyzed, Analysis stale/incomplete, Needs my response, Needs code
changes, Waiting for reviewer/CI, Approved, No action identified and Requires manual
judgment. Source-linked reports, thread resolution, author responses, confidence,
review decisions and checks determine these states; the last commenter is not a
resolution rule. Saved timestamps and analyzed head SHA remain visible. Existing
details expose requests, original messages, addressed work and **Solve Review**.

**Analyze PR** remains explicit. **Analyze All** previews scope (Open / Needs
attention / Stale / Selected), selection, reusable reports, utility configuration
and maximum AI authorization. The default is five selected PRs and five AI attempts;
the server accepts at most 20 selected PRs and 20 attempts. Zero allows reuse and
deterministic analysis only. Reuse is checked again against freshly retrieved
context before inference.

Batches call the same Scheduler/PRAnalysis/UtilityAI pipeline sequentially. The
journal increments the allowance immediately before each semantic attempt; failed
provider attempts conservatively consume it. Unchanged complete reports and
rule-based outcomes consume none. Completed, partial, failed and cancelled items
persist separately; cancellation preserves completed results. Existing per-PR
active guards prevent duplicate concurrent analysis. Restart marks unfinished
batches interrupted and never resumes inference automatically. There is no timer
or automatic GitHub write.

## Issue Watch

The primary editor contains name, repository, criteria, excluded label chips,
tracker references and model/effort. Individual issue exclusions, assignment and
collection bounds are advanced controls. **Scan Now** remains manual; saving,
opening, compiling or discovering labels starts no scan.

Criteria compile deterministically as the user edits. A short rule summary and
AI-only criteria explanation replace the dedicated preview step. Real ambiguities
still require interpretation; save validates the same compiler digest and revision
contract. Historical scans, candidate evidence, eligibility checks and the
no-automatic-claim policy remain unchanged.

Label input supports plain names, Markdown links, encoded HTTPS GitHub issues
search links, text/URI paste/drop, removable chips and explicit GitHub suggestions.
Links must match the selected repository and contain a label query. Unsupported
hosts/protocols, credentials, malformed percent encoding and markup are rejected.
Dropped HTML is never rendered. The stored value is the decoded label name;
backend exact-label exclusions retain their case-insensitive matching. Catalog
loading is bounded to ten pages/1,000 names and cannot display an old repository's
results after selection changes. Type a name and press Enter or **Add label**.
Production placeholders use neutral repository/path samples.

## Workspace and secondary pages

Chat, inline approval/recovery trays and composer share reading width/gutter tokens.
The composer has one surface and one focus indicator. Drafts, attachments, model
selection, keyboard controls and saved instructions retain their existing behavior.
The resizable/collapsible sidebar remains the engineering controller; smaller
windows use its accessible drawer. Long evidence is expandable. No UI dependency,
new font or decorative animation was added; reduced-motion CSS remains active.

Repository rows show identity, status, ownership type, base branch and editor.
Their actions button opens a native Details popover containing paths, remotes,
verification and lifecycle actions, with Escape/light dismissal and focus return.
Settings uses neutral selection and presents the four independently configured
stages as one sequence. Usage keeps real run/runtime/token/provider/failure/history
metrics and official allowance data where reported; its empty state fabricates
nothing and keeps the database path under Storage information.

## Checks and guided Git Finalization

**Checks** opens on actual observed counts, required Failed / Needs verification /
Passed groups and root blockers. Detailed commands, provider reports, stdout/stderr,
argv execution, browser/runtime diagnostics and reports live under **Advanced
evidence and tools**. Recovery provides one contextual primary action with remaining
choices under **More options**. Optional evidence retains both its reason and actual
recorded outcome. Failed, blocked, missing, interrupted, unknown and optional results
remain distinct; `reviewed_with_gaps` never becomes fully verified approval.

Git Finalization now progresses through **Files → Commit → Publish → Confirm**.
Files retain selected-path/index isolation and on-demand diff/review. Commit retains
exact UTF-8 message content with normal hooks by default. Publish offers the
verified destination, branch and existing presets with normal push by default;
**Connect Fork** uses the existing verified connection flow when needed. Confirm
shows reviewed files, exact message and operation before an explicit local commit.
Publishing requires its own live destination check and separate push confirmation.
Operation output/history/recovery is expandable.

File-review fingerprints, required verification, manual approval, source protection,
remote identity, expected remote SHA, branch ownership, fast-forward checks,
idempotency and interrupted-publication journals remain authoritative. Optional
hook skipping does not bypass them. No automatic PR creation or force push exists.

## Acceptance procedure and evidence

Use disposable repositories, isolated app/HOME roots and fixture providers. The
built Electron suites exercise the real renderer, IPC, SQLite, sandbox and Git,
with local bare publication remotes. The end-to-end acceptance covers:

1. Navigate repositories/providers/settings/usage at 1280×720, 1440×900 and
   1920×1080; open repository details by keyboard, dismiss with Escape and verify
   focus return. Check no document/form horizontal overflow.
2. Create a task and verify no worktree, run, usage or capacity reservation. Ask a
   question through the production read-only sandbox and verify denied source/Git
   writes, saved response, restart-idle behavior and no canonical plan artifact.
3. Review selected context, explicitly start once, inspect plans/changes/Checks,
   exercise approvals and blocker recovery, and retain draft/layout/PTY state.
4. Complete reviewed Files/Commit/Publish/Confirm with an exact multiline message,
   preserve unrelated staging/source files and publish only to the confirmed local
   bare fixture. Exercise wrong-remote/stale-SHA/interruption guards in service tests.
5. Open discovered PRs, analyze one, inspect source-linked history, preview a
   reusable Analyze All selection and complete it with a zero-AI cap. Service tests
   cover capped/partial/cancelled/interrupted batches and large discovery catalogs.
6. Drop an encoded label URI into Issue Watch, verify the exact chip/live digest,
   then scan only explicitly. Preserve historic watches and ambiguity decisions.
7. Preview an experimental task's files, confirm discard, verify the task-owned
   worktree is removed and the imported source is unchanged. Service tests cover
   ignored/staged/hidden-index/merge/unpublished/ownership/path/dependency cases,
   history preservation and interrupted discard recovery.

Final commands, observed counts, retained screenshot locations, inspected layouts
and environment limits are recorded in [VERIFICATION.md](VERIFICATION.md). Historical
verification sections describe earlier source states and are not V3 test results.
