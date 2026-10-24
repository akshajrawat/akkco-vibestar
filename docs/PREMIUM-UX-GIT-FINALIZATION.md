# Premium workspace and Git Finalization

Delivery against `47ffb1175fe6ae2f690904fbeb6cd8199caebee1` plus the working tree,
October 24, 2026. The original seven-phase brief is one combined delivery.
All seven phases are implemented and verified through the current-tree source,
browser, built-desktop and native window checks below. Historical results are
identified separately from final results.

## Design system

Deep charcoal surfaces distinguish the app canvas, sidebar, conversation and
elevated controls. Semantic CSS tokens cover surfaces, borders, focus, text and
blue/green/amber/red information, success, attention and failure states. Spacing,
radii and typography use shared scales: controls 8px, inputs 10px, panels 12px and
composer 18px. Reading width and line height take precedence over nested borders.

Geist Sans serves interface prose; Geist Mono serves commands, diffs, code and
xterm. Vite bundles two original variable WOFF2 files, about 140.7 kB combined,
and copies the OFL license into the renderer distribution. There is no font CDN.
Lucide remains the icon language; provider icons describe integration roles and
do not claim official brand artwork.

Shared `Button` variants cover primary, secondary, ghost, outline, destructive and
icon sizing, with focus, hover, press, disabled and busy states. `PageHeader`,
`EmptyState` and `ListSkeleton` establish page hierarchy. Native labelled inputs,
selects, checkboxes, textareas, progress/status text and details disclosures share
CSS rules. Existing focus-managed dialogs, keyboard model picker, command palette
and workspace tabs remain the interaction boundaries. Radix Slot is reused for
button composition; no redundant component framework was introduced.

Motion handles sidebar presence/selection and workspace tab selection. Exiting
navigation becomes inert immediately. CSS handles short dialog, popover, menu,
notice, result-row and initial-content entrances plus control/status transitions.
Reduced motion disables movement through MotionConfig and CSS. Stable keys keep
saved rows from reanimating on every update. Streamed tokens, huge histories and
PTY surfaces have no per-event layout animation. PTY lifetime remains task-owned.

## Main pages and workspace

| Surface              | Delivered behavior                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation and Tasks | Shared heading/action spacing, animated selected surface, keyboard navigation and unchanged Electron titlebar/command palette. Task workspace state remains keyed by task ID.                                                                                                                                                                                                                                                                 |
| Pull Requests        | Saved GitHub discoveries and legacy records merge into one searchable list with repository/status/review filters and honest CI/review/analysis metadata. Refresh has actual retrieval phases and persisted last-success/error state. Disconnected, unrefreshed, empty, filtered and failed states differ. The primary manual URL/Track form is removed.                                                                                       |
| GitHub retrieval     | Existing partitioned/paginated authored discovery is retained; complete retrieval precedes atomic catalog updates. Failed or partial retrieval preserves saved data. Detail state wins over search state, stable identities prevent duplicates, and task association requires a current unique upstream/fork/head match.                                                                                                                      |
| PR workspace         | Opening a discovered PR creates an inactive compatible saved record. Analyze remains explicit; sync, list, open and error recovery start no coding model. Existing repair observation selection, integration, independent verification and actual PR-head publication remain intact.                                                                                                                                                          |
| Issue Watch          | Focused onboarding replaces empty panes. Saved watches retain repository/model/state/last-scan/new-result metadata. Scan Now and Cancel expose real GitHub/filter/AI phases and grounded counts. Result groups, filters, claimability/source evidence and explicit task handoff preserve strict tracker exclusions.                                                                                                                           |
| Repositories         | Shared header with local import/scan and GitHub sync, connected/available/managed repository lists, identity/path/runtime facts and existing cancellable clone progress. Source checkouts stay unchanged.                                                                                                                                                                                                                                     |
| Providers            | Restrained integration cards show actual CLI version, connection/account/capabilities/models/errors, official authentication and detection feedback. Missing plan/account data stays unavailable.                                                                                                                                                                                                                                             |
| Settings             | General, Agents, Models, GitHub, Repositories, Execution, Storage and Usage groups, explicit validation and dirty/save feedback. Dirty edits survive snapshot refreshes. Four separately configurable pipeline stages retain provider constraints.                                                                                                                                                                                            |
| Usage                | Runtime/token/run/failure/interruption metrics, independently reported token-channel bars with coverage, official allowance snapshots and unavailable provider states. UTC daily token/run charts, runtime and task distributions have keyboard/pointer tooltips. Searchable/filterable run history pages every matching saved row in groups of 50 and links to saved runs. Scoped task/repair usage retains its existing disclosure history. |
| Chat                 | Existing chat-first layout is retained. User turns, provider prose, workflow notices, tools, commands, errors and approvals remain distinct. Safe GFM/Markdown adds exact code copying and bounded syntax styling. Raw/search/copy views remain accessible.                                                                                                                                                                                   |
| Pipeline             | Icon timeline reads actual persisted runs, provider/model, elapsed time, current action and approval state. Inspect/retry remain grounded in real execution. Unknown exits remain unknown; cancellation is distinct from success.                                                                                                                                                                                                             |
| Tests                | Overall result separates observed passes, provider reports and required gaps. Root blockers precede grouped failed/blocked/not-run/passed/optional checks; full commands, transcripts, timestamps and classifications remain accessible.                                                                                                                                                                                                      |

`antigravity_review` is an optional settings JSON field. Older settings fall back
to the planning Antigravity configuration; new tasks snapshot independent review
settings and retain stage overrides. Utility and selected-code models remain
separate. `core.info.independent_final_review` protects against older helpers
silently dropping the setting. Historical tasks/runs are not rewritten.

## Verification environment

`backend/execution/browser` contains strict choice/report contracts and one fixed,
bounded, host-authored diagnostic script. Per-task `verification_environment` is
`isolated` or `installed_browsers`. Only explicit manual verification commands use
the optional profile; provider and terminal restrictions remain unchanged.

Installed-browser mode mounts only physical existing Playwright browser cache and
Chrome installation paths read-only. Aliases/private paths fail closed. The probe
checks installed packages/executables, npm DNS, a loopback listening socket,
direct-file browser loading and HTTP loading separately. It installs nothing,
starts no provider and has a 20-second deadline. Prompts tell providers to inspect
installed tools before downloading and distinguish provider-inner restrictions
from manual-host capabilities.

The Tests disclosure starts no RPC merely by opening. Changing the environment
requires Use environment; Inspect is a separate action. Unapplied choices survive
background snapshots. Validated reports persist in Task JSON and are cleared when
the choice changes. Capability success is environment evidence and cannot waive
or pass application checks. Required DNS/socket/tooling gaps remain blocked until
the actual required checks execute. Genuine assertion failures remain failed.

## Git architecture

`backend/finalization` groups contracts, validated persistence, selected-file
inspection, owned workspaces and orchestration. Electron remains presentation-only;
the core validates every mutation independently of renderer state.

1. Inspect verifies the original positively owned task worktree, current Git
   common directory, branch, content/index fingerprint and required verification.
   The picker shows changed/new/deleted/renamed files, sizes, line counts, staged
   state and exclusions, with a separate ignored-file disclosure. Path search
   preserves hidden selections. Safe implementation-reported files are defaults;
   unrelated additions require explicit selection.
2. Preview copies only exact selected physical files/deletions into a separate
   owned `vibestar-finalization/<UUID>` branch/worktree. Literal pathspecs stage
   only those paths into its independent index. Task/source indexes are untouched
   during selection. Already-staged selected hunks require an explicit decision;
   excluded staged entries are preserved through commit.
3. The projected cumulative tree is inspected for unsafe content, including
   earlier task commits. A full identical tree can reuse its bound final review.
   A subset or changed fingerprint requires an explicit fresh independent
   Antigravity review in the read-only projection. It uses AgentRunner with
   `git-finalization-review` purpose, shared provider capacity and separate
   telemetry, without replacing the canonical pipeline artifact.
4. Fresh review must settle the original required application commands. Missing
   evidence persists separately as `verification_gap`, beside the intact provider
   verdict. Host diff hygiene also executes. Manual selected-file approval is
   explicit and cannot proceed with required gaps.
5. Commit rechecks source/index/review/approval and writes an immutable Git commit
   object whose UTF-8 message body is exactly the textbox contents. Leading and
   trailing spaces, blank lines, comment-looking lines and absence of a final
   newline are preserved. Only empty/NUL input is rejected; no trailer/template
   or generated message is appended. Issue-text prefill is opt-in. A journal is
   saved before compare-and-swap updates of the task branch/selected index.
6. Prepare resolves actual configured fetch/push URLs, canonical repository and
   upstream identities, current authenticated viewer, GitHub repository ID and
   write permission. Only the configured contribution fork is eligible; upstream
   publication is refused. The same local commit can be rebound to another safe
   feature branch with fresh preparation, without another commit.
7. Publish requires an additional explicit confirmation of repository, remote,
   branch, exact local commit and expected remote SHA (or confirmed absence).
   It rechecks all authority/content/identity/ancestry and concurrent-writer gates.
   Success is reported only after the remote ref is verified at the exact commit.
   No PR is created automatically.

### Independent publication boundary

Both ordinary tasks and PR repair call `backend/workspace/publication.ts`.
The host proves the proposed immutable commit descends from the exact expected
remote object. It then uses a single explicit ref/object compare-and-swap lease,
closing the race between checking the remote and Git's update. Git calls this
`--force-with-lease=refs/heads/<branch>:<expected>`; the independent ancestry proof
ensures every allowed update is fast-forward. Broad `--force`, wildcard leases and
plus refspecs are not allowed. New branches bind a pinned ancestry base and an
explicit absent-ref lease. A remote that moves to another ancestor still fails
the exact lease and requires re-preparation.

This follows Git's [documented explicit-lease semantics](https://git-scm.com/docs/git-push).
The existing repair private hook remains defense in depth. Skipping optional hooks
cannot bypass the host's workspace, repository, exact remote/ref/SHA, ancestry,
reviewed tree, approval, allowed files, permission or writer-exclusion checks.
Repair continues publishing to its actual verified PR head branch.

### Hook policy and presets

Typed presets persist only name, commit hook policy, push policy, allowlisted
remote name and branch. Standard, local only, normal commit/no-verify push,
no-verify commit/normal push and both skipped are supported, including per-task
customization. No shell command or arbitrary flag string is executable.

Normal mode honors effective repository/worktree `core.hooksPath` and normal
pre-commit, prepare-commit-msg, commit-msg, post-commit and pre-push hooks. The
configuration is bound to the preview; changing it requires a fresh preview or
explicit skip. `/dev/null` is visibly identified as repository-disabled hooks.
Hooks run in the read-only sandbox without provider state, with bounded output
and exact-message read-only input. Configured hooks missing from the authorized
projection, paths outside its/shared hook boundary, mutating formatters and other
unsupported hook behavior fail with an explanation. The user can explicitly skip
these optional checks; mandatory Vibestar gates still run. Hook semantics follow
the [repository configuration contract](https://git-scm.com/docs/git-config).

### File and workspace boundaries

The picker cannot select ignored paths, credential/provider state, private keys,
unexpected new/large binaries, untracked generated output or debug artifacts.
Content inspection additionally rejects known token/private-key/secret patterns.
Symlinks, submodules, physical aliases and escaping paths require separate manual
handling. File reads are bounded and use no-follow handles. These conservative
checks supplement independent review; filenames alone never establish trust.

Mutations share the engine workspace lease and repository/common-directory/branch
and destination leases with other writers. Local external editors/Git processes
do not join these leases; host fingerprints and ref comparison detect changes.
Cleanup requires explicit owned-preview removal and refuses unknown ownership,
changed preview data or unresolved commit/publication recovery. An early hard
interruption before ownership markers are written is preserved for manual
inspection; startup never adopts or deletes an unproven worktree.

### Persistence, output and recovery

Migration 24 adds `git_finalizations`, `git_operation_events` and
`task_git_presets`, with task/operation foreign keys and history indexes. Existing
backup-before-migration behavior remains. Strict JSON decoding checks both record
ID and task ownership; cross-task request-ID collisions cannot overwrite history.
Renderer views omit internal index snapshots, request digests and process identity.

Readable phases, real exits/timestamps and redacted raw Git/hook output persist in
SQLite. Output pages contain 200 events with an older-page cursor; each event has
a 64 KiB UTF-8-safe tail limit and explicit truncation marker. Hooks additionally
have process output/line budgets. Missing preview files produce `diff_error` while
saved diagnostics remain accessible. No missing diff is presented as a clean tree.

Cancellation stops the tracked process group. Startup checks saved PID/start
identities and marks interrupted mutations durably. Local commit reconciliation
is read-only; explicitly confirmed resume applies only the original journaled
branch/index transition and cannot duplicate the commit. An interrupted or
ambiguous push stays uncertain until read-only remote reconciliation establishes
published/not-published/changed state. A retry needs fresh preparation/confirmation.
Duplicate preview requests return the same saved operation only for the same
request digest; changed payloads are refused.

## RPC and compatibility contracts

`core.info.git_finalization: 1`, `exact_commit_messages` and
`browser_verification_environment` allow Electron to reject unsupported mutations
on older helpers instead of silently degrading semantics.

| RPC                           | Authority and result                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.inspect`                 | Task ID; file metadata, fingerprint, typed preset and saved public history. No model or mutation.                                                 |
| `git.preview`                 | Request UUID, expected fingerprint, exact paths, explicit selected-staged replacement decision and typed preset. Creates the isolated projection. |
| `git.review`                  | Task/operation IDs; explicitly invokes independent selection review.                                                                              |
| `git.approve`                 | IDs and `confirmed:true`; binds manual approval to the exact reviewed projection.                                                                 |
| `git.commit`                  | IDs, exact message, `skip_hooks` and `confirmed:true`; local commit only.                                                                         |
| `git.prepare`                 | IDs and optional typed `{remote,branch}` destination; validates current publication identity/state.                                               |
| `git.publish`                 | IDs, explicit hook policy and `confirmed:true`; rechecks and performs guarded publication.                                                        |
| `git.preset`                  | Task ID and strict typed preset; saves task preference.                                                                                           |
| `git.detail`, `git.output`    | IDs and optional event cursor; public journal/events, plus bounded diff or distinct error for detail.                                             |
| `git.cancel`, `git.reconcile` | Stop active task operation / read-only recovery. No automatic retry.                                                                              |
| `git.resumeCommit`            | IDs and explicit confirmation; guarded interrupted-local transition only.                                                                         |
| `git.remove`                  | IDs and explicit confirmation; removes only an unchanged positively owned preview/history. Task branch/local commit remain.                       |
| `task.browser.configure`      | Task ID, supported environment and explicit confirmation; changes manual verification profile and clears stale diagnostics.                       |
| `task.browser.inspect`        | Task ID; bounded fixed diagnostic using existing recorded-command lifecycle.                                                                      |

The frontend opens Git Finalization from ready or completed tasks. Its responsive
focus-contained dialog combines selection/diff, independent/manual review, exact
message/preview, presets, destination and separate push confirmation. Busy actions
prevent duplicates and show elapsed time/cancellation. Snapshot ordering preserves
edits and newer operation state; frequent output uses the lightweight journal RPC.
Message drafts use existing task-local persistence and storage-error handling.

## Dependencies and continuous integration

Motion 14.6.0 is the only added runtime package. Its React integration/reduced
motion policy follows the [official documentation](https://motion.dev/docs/react-motion-config).
Geist 1.8.2 was inspected from the official npm distribution; its JS exports require
Next.js, so only the original Sans/Mono WOFF2 assets and OFL license were retained.
The package and unnecessary peer were removed. See [Geist](https://vercel.com/font).
No incoming design-assets directory or additional icon collection was present.

`.github/workflows/ci.yml` runs on every push, pull request and manual dispatch.
The Ubuntu 22.04/Node 22 job installs bubblewrap/native build prerequisites, runs
`npm ci`, formatting, lint, typecheck, normal regression, integration, PTY and
production build. Official actions are pinned to verified commits; contents
permissions are read-only, checkout retains no credentials and superseded runs
on the same ref are cancelled. Desktop/live opt-ins remain explicit. The workflow
passed local Prettier/actionlint validation; no hosted run has been triggered.

## Verification and acceptance evidence

The unchanged-source baseline passed 445 tests and timed out in an existing
transport-retry UI test; that file passed all five tests on bounded-concurrency
rerun. Earlier changed checkpoints and failed attempts are retained in
[VERIFICATION.md](VERIFICATION.md). A new migration fixture initially used an
already-inserted migration version and the wrong scope enum; both fixture setup
errors were corrected before the passing migration/reopen/backup assertions.

The final current-tree command table, fresh screenshots and visual notes are
recorded in VERIFICATION.md. No live model allowance or real GitHub write was used.
Git transport tests use disposable local bare remotes only.

The Git matrix includes all normal/skip combinations, local-only commits, exact
multiline/Unicode/no-final-newline messages, selected subsets, unsafe/untracked
files, staged-state preservation, literal names/renames/deletions, changed review
fingerprints, remote/ref/viewer/permission failures, stale/new-branch/diverged
ancestry races, independent skip guards, hook configuration/failures, network
ambiguity, restart/reconciliation/resume, duplicate requests and concurrent writers.
Existing repair publication runs against the same new host boundary.

Browser fixtures cover installed/absent packages/binaries, npm DNS failure,
listening-socket denial, direct-file independence, required/optional gaps and
observed/provider distinctions. An opt-in actual installed Chromium/Playwright
fixture executes without inference; capability success never changes task gates.

Built Electron fixtures exercise real renderer/IPC with isolated state and blocked
real AI/GitHub executables. The new Git acceptance opens a completed task, checks
safe defaults and unsafe exclusions, explicitly reviews a subset, preserves
excluded staged bytes, commits the exact message, confirms a verified destination,
pushes to a local bare fork and reopens saved publication history. It records raw
Git object/remote SHA/event evidence and source/index preservation. Main pages and
Git selection are captured at 1920×1080, 1440×900 and 1280×720; visual notes and
retained paths belong to the final current-tree record.

## Completion audit and limits

The numbered requirements below map to concrete implementation and executable
evidence. Final command results and retained captures are in VERIFICATION.md;
overlapping suite counts are not added together.

| Requirement                   | Implementation and evidence                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2. Repository audit/baseline  | HEAD matches the supplied base. Repository guidance and renderer/core/Git/storage boundaries were inspected; baseline attempts are recorded above.                           |
| 3. Design language            | Semantic CSS, local Geist, consistent geometry and shared Button states; premium UI tests and three-size captures.                                                           |
| 4. Motion                     | Sidebar presence/selection, workspace tab indicator and bounded CSS transitions; reduced-motion and inert-exit/keyboard desktop assertions.                                  |
| 5. Navigation/headers         | Shared headings across seven pages, retained command palette/window controls and task switching; workspace/native Windows checks.                                            |
| 6. GitHub-first discovery     | Complete-refresh preservation, pagination, identity/task association and inactive opening; github.test.ts and pr-review-ui.test.tsx.                                         |
| 7. PR presentation            | Saved list/overview/filter/search/empty/error states and manual analysis; PR analysis/repair Electron fixtures.                                                              |
| 8. Issue Watch                | Onboarding, watch facts, real phases/cancel, grouped/evidence-supported candidates and explicit handoff; issue-watch suites and built Watch fixture.                         |
| 9. Usage                      | Reported-only metrics/channels/coverage/allowance, charts and complete paged table; premium/product-quality UI tests and populated captures.                                 |
| 10. Settings                  | Grouped sections, dirty/save validation and four independent stages; premium UI/pipeline tests and Settings captures.                                                        |
| 11. Providers                 | Official CLI/account/model/capability/error states and auth controls; adapter regressions and integration-card captures.                                                     |
| 12. Repositories              | Local import/scan, catalog/clones, identity/runtime and real progress; repository/security regressions and repository captures.                                              |
| 13. Chat                      | Safe Markdown/exact code copying, compact activity and retained raw/search/copy tools; premium UI and output/workspace desktop fixtures.                                     |
| 14. Pipeline                  | Persisted run/approval timeline, actual elapsed/activity/inspect/retry and unknown/cancelled states; premium UI and approval fixtures.                                       |
| 15. Tests hierarchy           | Observed/provider distinction, root causes, grouped outcomes and complete evidence/retry/terminal; verification suites and blocker/interruption captures.                    |
| 16. Browser environment       | Explicit manual profile and fixed installed-tool/DNS/socket/file/HTTP probe with no waiver; probe/boundary/actual-toolchain fixtures.                                        |
| 17. Git center                | Ready/completed entry points, isolated preview, exact commit and separate publication; finalization suites and built Git fixture.                                            |
| 18. Hook combinations         | Typed presets and independent commit/push policies; four normal/skip combinations, local-only and actual sandboxed-hook tests.                                               |
| 19. Independent guards        | Host ancestry plus exact atomic ref/SHA lease; boundary and repair/finalization race tests, including skipped private hooks.                                                 |
| 20. Exact message             | Shared immutable object writer, empty multiline editors and opt-in prefill; whitespace/Unicode/no-final-LF assertions and built desktop message.                             |
| 21. File selection            | Literal paths, unsafe-content exclusions, staged preservation/decision, renames/deletions and review invalidation; service/desktop source/index assertions.                  |
| 22. Destination               | Actual URLs/fork/upstream/repository ID/viewer/permission/ref/SHA; wrong-identity/branch/permission/race tests and confirmation capture.                                     |
| 23. Presets                   | Strict per-task structured GitPreset with safe defaults/custom policy; schema/idempotency tests. No executable shell strings.                                                |
| 24. Output/recovery           | Paged redacted real exits/phases, cancellation, process identity, uncertain-push reconciliation and explicit local resume; network/restart/output tests.                     |
| 25. Git UI                    | File search/diff/review/manual gates, exact message, modes/presets, verified destination, separate push confirmation, output/history/removal; renderer/built acceptance.     |
| 26. Async feedback            | Busy/skeleton/status surfaces retain saved data; real sync/Watch/clone/agent/Git phases and supported cancellation; workspace/PR/repair/Git/browser desktop flows.           |
| 27. Shared components         | Button/Radix Slot, page/skeleton/empty primitives and existing native/focus/keyboard controls; interaction tests and visual inspection.                                      |
| 28. Assets                    | Motion only runtime addition, two bundled OFL fonts and Lucide; final build assets and actual desktop rendering, no runtime CDN.                                             |
| 29. Accessibility/performance | Focus containment, keyboard/focus/contrast, reduced motion, bounded/paged history and stable PTY; three sizes, workspace/output/Git and native DPI checks.                   |
| 30. Core regression           | 491 passing normal tests cover original tasks/scope/order/approval/worktrees/repair/Watch/usage/sandbox/Git. Opt-ins are separately recorded.                                |
| 31. UI matrix                 | Premium/frontend/workspace/verification/repair UI plus seven Electron fixtures cover states, filtering, models, task switch, long output, narrow layouts and reduced motion. |
| 32. Git matrix                | Local bare-remotes fixtures cover requested hook/selection/identity/race/network/restart/duplicate/writer cases and source preservation.                                     |
| 33. Verification matrix       | Probe/boundary, existing assertion/reconciliation/provider-evidence tests and actual installed-browser rerun; capability observations never promote application outcomes.    |
| 34. Commands                  | Format, lint, typecheck, normal, integration, PTY, build, browser, seven Electron and native window checks; exact results in VERIFICATION.md.                                |
| 35. Documentation             | README, ARCHITECTURE, this report, PR repair guide and verification log record contracts, migrations, RPCs, assets, safeguards, captures and limits.                         |

| Brief requirement             | Implementation/evidence boundary                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 / sections 2–4, 27–28 | Baseline/architecture audit, semantic CSS/shared controls, bundled Geist, Lucide and reduced-motion-aware interaction system.                                                                           |
| Phase 2 / sections 5–12       | All seven main pages use the current shell/hierarchy; GitHub-first PR and manual-only Watch behavior remain tested. Usage covers populated/empty/partial measurement states and complete paged history. |
| Phase 3 / sections 13–15, 26  | Safe readable chat/code, real pipeline states, verification source/root-cause hierarchy, grounded busy/skeleton/progress/retry surfaces.                                                                |
| Phase 4 / section 16          | Explicit manual-only browser environment, installed capability probe, DNS/socket/direct-file distinctions, actual opt-in browser execution and unchanged required gates.                                |
| Phase 5 / sections 17–24      | Typed host service, selected projection, required evidence/review/manual approval, exact commits, independent atomic publication boundary, optional hook modes, presets/history/recovery.               |
| Phase 6 / section 25          | Built desktop selection/review/message/preset/destination/confirmation/output/history flow, ready/completed entry points and persisted drafts.                                                          |
| Phase 7 / sections 29–35      | Final full checks, migration/recovery and Git matrix, seven Electron fixtures, three-size screenshot inspection and platform review recorded in VERIFICATION.md.                                        |

Native Windows uses the existing renderer, packaged local assets and WSL core/RPC
boundary. The new backend Git/browser logic executes in that Linux core; existing
Windows window/DPI/editor/bridge mechanisms are preserved and reviewed, not
replaced. Native window regression passed on two connected displays at 125% and
150% scaling, including maximize/fullscreen/restore/resize, actual pointer dragging
and double-click, correct viewport/DPI and isolated WSL data configuration. It used
the current Vite renderer and native Electron host. Signed packaging, installer/
update and live Codex/Antigravity/GitHub account behavior were not rerun for this
delivery. Fixtures do not prove those remaining environment-specific outcomes.

Read-only optional hooks may require explicit skip when their workflow writes
files or lives outside the authorized projection. Unsupported files/ownership and
uncertain remote outcomes deliberately stop for review; no fallback weakens the
boundary. Secret inspection is conservative pattern detection, not proof that
arbitrary content contains no secret. External Git/editor concurrency retains its
documented limits. These restrictions are visible in the workflow.
