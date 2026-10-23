# Chat-first coding workspace — delivered October 22, 2026

The October 22 brief is implemented across all five phases. Issue tasks and PR repairs now use a persistent conversation, a collapsible engineering sidebar and a secondary Terminal / Problems dock. The final source checkpoint passed 446 normal tests, 7 integration tests, 3 PTY tests and 6 built Electron fixtures. Historical phase checkpoints below describe the implementation sequence; final evidence, contracts, file inventory and environment limits follow.

## Phase A — validation correctness, verified

Two independent behaviors caused the misleading result:

- Stage 4 treated every legacy `testsFailed` string as an application/test failure, including dependency installation blockers.
- Chat displayed the last command's status as overall validation. A passing host `git diff --check` could appear green even while browser verification remained unresolved.

Implementation results now accept an optional `verification` list. Each entry records `name`, exact `command` or null, `kind` (`check` or `setup`), `outcome`, `required`, `detail` and `prerequisite` or null. Outcomes are `passed`, `failed`, `blocked`, `interrupted`, `not_run` and `unknown`. The existing arrays remain readable and are retained unchanged. Old failures with no structured evidence stay ambiguous and unresolved.

The shared evaluator distinguishes provider reports, observed commands and deterministic host diff validation. It uses the latest implementation attempt and later manual commands. Exact command matches connect reports to observed results; the latest exact-command retry can resolve a check. Original records, output and exits remain in command history. Simple recognized setup invocations can establish tooling failures. Shell chains and arbitrary scripts are not guessed to be installation commands. Exit 130 during recognized setup means interruption; it does not establish an application assertion failure. Explicit cancellation outranks exit zero. A missing exit does not establish success.

Required failures stop Stage 4 with `failed`; required gaps stop with the durable idle `verification_blocked` status. Both remain behind the implementation approval gate. Navigation uses the actual saved state, with amber for gaps. Implementation approval rechecks the evidence. There is no waiver into independent review: resolve required gaps, then explicitly approve the saved implementation. This retains the existing approval sequence and avoids equating review continuation with completed verification. The new status extends the task JSON contract without a SQLite migration.

Tests shows unresolved checks, their prerequisites, original command output and a manual command form. **Retry validation only** repeats diff hygiene and aggregates saved evidence; it starts no provider and delivers no saved instruction. **Diagnose in terminal** opens the existing task PTY. Fixing an actual implementation defect requires an explicit follow-up instruction.

The fixture provider implements a multiplication table in three files, runs JavaScript syntax, generated-table and source-structure checks, then runs a sandbox-local fake installer that exits 130. It uses no network, real provider or GitHub write. Backend tests verify the blocker, retry, restart, source preservation and instruction state; renderer tests cover evidence navigation and host failure wording. The opt-in `tests/desktop-chat-workspace.test.ts` exercises the built Electron renderer and real IPC.

The checkpoint passed 402 normal tests, 7 integration tests, 3 PTY tests and five built Electron fixtures, plus formatting, lint, type checking and build. The blocker screenshots were inspected at all three requested sizes. [Verification](VERIFICATION.md) records the exact command, evidence paths, earlier failed-run explanation and remaining limits. This establishes Phase A only.

## Phase B — shared conversation workspace, verified checkpoint

Chat is always mounted. The shared secondary workspace selects one engineering tool at a time, preserves per-tool scroll, supports keyboard tabs and remembered width, expands for focused review and becomes a dismissible focus-contained drawer below a usable workspace width. The bottom dock contains only Terminal and Problems; an attached terminal stays mounted across hiding, utility selection and maximize/restore. Task and repair UUIDs retain independent presentation state. Local storage version 2 migrates old center/dock choices without moving or clearing the separate draft record.

Plans selects the original or refined saved artifact. A gate's View plan selects its own artifact; expanded Plans shows the comparison. Changes opens a focused review while preserving chat/draft/file state. Run details contains selected-run metadata and prompts. Raw logs reuses the existing historical output browser. Pipeline shows actual persisted run models and saved future defaults. Phase C adds a separate `task.configureStage` contract rather than exposing the broader historical whole-settings call. Only an idle, never-started provider stage can receive its own saved override.

Approval controls now sit above the composer without automatic reopening dialogs. The header keeps editor, Stop and panel controls. Task navigation announces saved state and exposes keyboard/right-click actions through existing editor/archive/cleanup authority; cleanup still requires confirmation and ownership/lease checks. Repair review, local commit and explicit publication confirmation retain their distinct backend workflow. Repair drafts remain editable during execution, but Enter and submit cannot start a run in active, published, conflicted, stale or publication-pending states.

The new fixture exercises plan approvals with an independent draft, panel resizing, three desktop sizes plus a narrow drawer, expanded review, actual PTY retention, command-palette focus restoration and reload persistence. The checkpoint passed the complete normal suite, 7 integration checks, 3 PTY checks, format/lint/type checks, build and all five built Electron fixtures. Latest blocker screenshots at 1920×1080, 1440×900 and 1280×720 and the explicit repair publication dialog were inspected. Evidence and limitations are recorded in VERIFICATION.md. Composer/instruction semantics and diff modernization remain active work.

## Phase C — approval and composer, verified checkpoint

Issue instructions now have distinct local draft, saved backend instruction, queued feedback and delivered states. Save for later retains the composer and approval gate without inference. Feedback sends only that message; retries no longer consume saved drafts. Approvals bind the viewed artifact ID and require an explicit keep-saved/include-next-stage decision for the exact pending instruction IDs. Including instructions retains the next pipeline stage provider/model, and final acceptance cannot include instructions because it starts no agent. Request IDs make transport retries idempotent. Issue feedback and repair follow-up scheduling persist atomically with their messages.

Task and repair share an expanding composer and compact action tray. Enter/Shift+Enter/IME handling and long-paste bounds are common. The context picker attaches previewable, removable snapshots of validated worktree files, changed paths, the selected file diff, saved plan/repair scope, incomplete checks and text notes. Snapshots are bounded to six items, 4,000 characters per item and 16,000 aggregate context characters; the full task/repair message limits remain authoritative. Context stays local until explicitly saved or sent. PR repair draft saving is explicitly local; sending still invokes its approved Codex then Antigravity sequence.

The concise chat selector shows official discovered models, efforts and account availability, with no provider fallback. Future-stage editing is separate in Pipeline; completed runs retain their actual settings. New stage overrides persist in the task JSON without changing historical runs or global settings. The desktop requires the new saved-instruction capability before task mutations, so stale helpers cannot silently apply the old draft-consuming semantics.

The checkpoint passed 429 normal tests, integration 7, PTY 3, format/lint/type checks, production build and five Electron fixtures. The desktop scenario saved one instruction, kept an independent unsent draft/context chip, chose keep-saved at the first gate and include-next-stage at the second, and reached the browser blocker with exactly three provider runs. Screenshot inspection exposed a stale success notice, now scoped to workflow/run/artifact state and covered by a targeted 19-test rerun. Diff modernization and the final complete acceptance audit remain active.

## Phases D/E — diff review and final acceptance, complete

Changes now has searchable tree/flat navigation, relative paths, rename/binary/status/statistics indicators and content-bound reviewed marks. Expanded review offers numbered unified and side-by-side views, escaped lexical syntax coloring, verified unchanged-context folding and bounded large-patch fallbacks. Hunk ranges are checked rather than guessed. Issue marks use the existing review service, including stale-hash rejection; repair marks retain their existing service. Original PR, upstream integration and repair changes keep separate baselines/statistics, and layer/file/mode choices survive returning to chat or reopening the conversation.

Final Electron acceptance saved an instruction without inference, retained a different unsent draft/context chip, explicitly kept the instruction at the first gate and included it at the second, then reached the interrupted-install/browser-blocked scenario with exactly three provider runs. It inspected the actual command and retried host validation without another provider; opened syntax-colored unified/split review and persisted a reviewed mark; hid/reopened the same real PTY; exercised Ctrl+B, composition protection, Ctrl+backtick, Ctrl+J and command-palette focus; used a narrow drawer; and reloaded draft, chips, panel width and selected tool. The original issue gates, output history, PR analysis, repair/manual publication and Issue Watch fixtures all passed separately through built Electron/IPC.

| Requirement                    | Delivered behavior and evidence                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat and secondary tools       | Shared mounted chat, eight distinct right tools, remembered resize/scroll, expanded review and narrow drawer; bottom dock contains only Terminal / Problems.                      |
| Approval and drafts            | No automatic review modal; saved artifact/ID checks, explicit pending-instruction choice, independent local draft, idempotent save/send and atomic continuation persistence.      |
| Composer and models            | Shared growing input, IME handling, visible busy state, bounded removable context snapshots, discovered chat models/account state and separate never-started stage editing.       |
| Validation                     | Recorded pass/fail/block/interruption/not-run/unknown evidence, exact host check, conservative legacy compatibility, no false green aggregate and provider-free validation retry. |
| Diff review                    | Unified/split counters, lexical colors, folded source context, relative tree/flat navigation, renamed/binary/large states, reviewed hashes and separate repair layers.            |
| Lifecycle and security         | Navigation status/menu, archive/unarchive and confirmed owned cleanup; actual PTY leases, fixed repair orchestration and explicit local commit/push gates retained.               |
| Accessibility and presentation | Focus-contained dialogs/drawer, restored opener/chat focus, keyboard menus/tabs/shortcuts, composition guards, independent scroll and reduced-motion-compatible activity.         |

## Backend and compatibility contracts

- Implementation results accept optional structured verification entries alongside historical arrays. Task detail includes the shared validation aggregate. The new idle status is verification_blocked; old evidence is not rewritten.
- task.followup accepts an optional UUID request_id and save_only. task.message.send delivers the exact saved row, and task.message.retry accepts a retry request ID. Sending or retrying other work never implicitly consumes saved drafts.
- task.approve accepts artifact_id and an explicit instructions decision with current message_ids. The backend rejects stale or mismatched decisions; final acceptance permits keeping instructions saved only.
- task.configureStage accepts stage 1, 2, 3 or 5 plus StageConfig. It rejects active/queued work and stages already started, and persists only that stage's task JSON override. It cannot switch pipeline providers.
- repair.start accepts an optional request_id for nonempty follow-up instructions. The existing repair message ID journals the request atomically with continuation state; transport retries do not start another sequence.
- core.info advertises saved_instruction_choices. The desktop blocks changed task mutation paths on helpers lacking this capability. The protocol remains 3 with explicit feature negotiation.
- No presentation SQLite migration, new package dependency or new package index export was added. Existing worktree, sandbox, editor, review-hash and publication services retain authority.

## Verification and inspected screenshots

The complete measured commands and earlier checkpoint failures are recorded in [VERIFICATION.md](VERIFICATION.md). Final results are 446 passed / 14 opt-in skipped, integration 7, PTY 3, six built Electron fixtures, format/lint/type checks and build. The final normal suite took 75.38 seconds and Electron took 56.28 seconds on Linux x64, Node 22.22.1, npm 9.2.0 and Electron 41.10.7.

Workspace screenshots and results: /home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/. Inspected blocker screenshots at 1920×1080, 1440×900 and 1280×720 keep composer and tool scrolling usable, preserve the independent draft/chip, show the unresolved browser gap in amber and contain no stale approval-success notice. Refined-plan approval and the narrow drawer were also inspected. Numbered unified/split review shows escaped syntax tokens, relative file headers and a content-bound reviewed mark; the final checkbox is aligned on one row. Long lines scroll within review rather than overflowing the window.

Repair screenshots and results: /home/aksha/tmp/vibestar-pr-repair-desktop-5MhxDm/screenshots/. The inspected integration view compares original PR head to integrated head with its own +1/−1 statistics. Manual publication retains destination, branch, expected remote/prepared heads, validation gaps and explicit confirmation; the fixture pushes only to its local bare fork. Issue Watch evidence is /home/aksha/tmp/vibestar-watch-evidence-9sgJVE/; task handoff was inspected and the fixture reports no renderer errors, real inference or real GitHub writes.

- [1920×1080 validation blocker](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/validation-blocker-1920x1080.png)
- [1440×900 validation blocker](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/validation-blocker-1440x900.png)
- [1280×720 validation blocker](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/validation-blocker-1280x720.png)
- [Saved instruction and plan approval](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/codex-plan-approval.png)
- [Unified diff](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/expanded-review-unified.png)
- [Side-by-side diff](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/expanded-review.png)
- [Narrow drawer](/home/aksha/tmp/vibestar-chat-workspace-6dF3HG/screenshots/narrow-workspace-drawer.png)
- [Repair integration baseline](/home/aksha/tmp/vibestar-pr-repair-desktop-5MhxDm/screenshots/upstream-integration.png)
- [Explicit publication confirmation](/home/aksha/tmp/vibestar-pr-repair-desktop-5MhxDm/screenshots/explicit-push-confirmation.png)
- [Issue Watch task handoff](/home/aksha/tmp/vibestar-watch-evidence-9sgJVE/screenshots/task-handoff.png)

## Manual validation

1. Open an issue task. Confirm chat is primary, the right tool panel collapses/resizes and Terminal / Problems starts hidden. Open Plans and inspect the original/refined saved artifact.
2. Type an instruction and choose Save for later. Confirm no provider starts and the gate remains. Type a different unsent draft, attach/preview a note or validated worktree file, switch conversations and restart. Confirm each conversation keeps its own text, chips and model selection.
3. At approval, explicitly choose keep-saved or include-next-stage for the displayed instructions. Confirm approval leaves the unrelated draft intact and preserves the configured pipeline provider. Sending feedback is a separate action that states its continuation consequence.
4. In Pipeline, inspect completed run models and edit a never-started future stage while idle. Change the chat model separately; check unavailable models/accounts and supported effort choices. Repair's model link explains its approved Codex then Antigravity sequence.
5. Reproduce or inspect the multiplication fixture's passing code checks, interrupted Playwright setup and blocked browser check. Open the exact command transcript and retained exit/output. Retry validation only and confirm no provider call. Resolve required evidence before review; no gap waiver is provided.
6. Open Changes and expand review. Switch unified/split and tree/flat views, filter a renamed path, reveal unchanged context and mark a file reviewed. Change its worktree contents and refresh; the old mark must invalidate and a stale hash must be rejected. Return to chat and confirm draft/model/file/panel state.
7. Open the real terminal, hide and reopen its dock, then close the shell explicitly. Check Ctrl+backtick/Ctrl+J, Ctrl+B, Ctrl+Shift+P/Escape and IME Enter/Shift+Enter. Inspect 1920×1080, 1440×900, 1280×720 and the narrow dismissible drawer.
8. In PR repair, inspect all three separately labelled diff layers and review findings/commands. Keep the original manual review, local commit and publication confirmations. Use Keep Local when validating against a real repository without intending a push.

## Limits and remaining UX boundaries

There are no remaining implementation items from this brief. Native Windows dragging/maximize/fullscreen and installer packaging were not rerun for this renderer milestone. Real provider subscriptions, account-specific capability variations and real GitHub publication were deliberately excluded; automated providers and Git transports are fixtures. These are verification limits, not claims that those environments were exercised.

Required unresolved checks still block review. Coverage is limited to recorded evidence; ambiguous legacy or compound command strings remain unresolved rather than guessed into success. Repair deferred saving is explicitly local because its workflow has no general backend instruction queue. Syntax coloring is lexical, unsupported languages remain plain text, and binary/oversized files require the external editor. Interactive patches are bounded to 750,000 characters / 12,000 lines, coloring to 4,000-character lines / bounded tokens, and revealed unchanged context to 2,000 lines per region in 200-line increments. Context snapshots allow six items and 16,000 aggregate characters, with 4,000 source characters plus a truncation marker per item; task and repair total message limits remain 32,000 and 16,000 characters. These bounds are explicit UI states rather than silent content loss.

## File inventory

Against baseline 5411c9e58d8bb2a64fb1b56c7b336dd7acbfa11e, 49 existing files changed, 29 files were added and one component moved (80 paths total). No feature was removed. The former root DiffFileTree now lives with its renderer under components/diff; its internal consumer/test imports were updated. Changes remain in the working tree.

### Added

- [backend/execution/task-verification.ts](../backend/execution/task-verification.ts)
- [backend/execution/verification.ts](../backend/execution/verification.ts)
- [docs/CHAT-FIRST-WORKSPACE.md](../docs/CHAT-FIRST-WORKSPACE.md)
- [src/components/VerificationSummary.tsx](../src/components/VerificationSummary.tsx)
- [src/components/diff/DiffView.tsx](../src/components/diff/DiffView.tsx)
- [src/components/repair/RepairContext.tsx](../src/components/repair/RepairContext.tsx)
- [src/components/workspace/ActionTray.tsx](../src/components/workspace/ActionTray.tsx)
- [src/components/workspace/BottomDock.tsx](../src/components/workspace/BottomDock.tsx)
- [src/components/workspace/ChatSurface.tsx](../src/components/workspace/ChatSurface.tsx)
- [src/components/workspace/Composer.tsx](../src/components/workspace/Composer.tsx)
- [src/components/workspace/SecondaryWorkspace.tsx](../src/components/workspace/SecondaryWorkspace.tsx)
- [src/components/workspace/TaskEngineering.tsx](../src/components/workspace/TaskEngineering.tsx)
- [src/components/workspace/context.ts](../src/components/workspace/context.ts)
- [src/lib/diff/highlight.ts](../src/lib/diff/highlight.ts)
- [src/lib/diff/parse.ts](../src/lib/diff/parse.ts)
- [src/lib/useWorkspaceKeys.ts](../src/lib/useWorkspaceKeys.ts)
- [src/lib/verification.ts](../src/lib/verification.ts)
- [tests/desktop-chat-workspace.test.ts](../tests/desktop-chat-workspace.test.ts)
- [tests/diff/parse.test.ts](../tests/diff/parse.test.ts)
- [tests/diff/ui.test.tsx](../tests/diff/ui.test.tsx)
- [tests/verification.test.ts](../tests/verification.test.ts)
- [tests/verification/pipeline.test.ts](../tests/verification/pipeline.test.ts)
- [tests/verification/provider.ts](../tests/verification/provider.ts)
- [tests/verification/ui.test.tsx](../tests/verification/ui.test.tsx)
- [tests/workspace/composer.test.tsx](../tests/workspace/composer.test.tsx)
- [tests/workspace/fixtures.ts](../tests/workspace/fixtures.ts)
- [tests/workspace/instructions.test.ts](../tests/workspace/instructions.test.ts)
- [tests/workspace/layout.test.tsx](../tests/workspace/layout.test.tsx)
- [tests/workspace/navigation.test.tsx](../tests/workspace/navigation.test.tsx)

### Changed

- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [README.md](../README.md)
- [backend/domain.ts](../backend/domain.ts)
- [backend/execution/agent-runner.ts](../backend/execution/agent-runner.ts)
- [backend/execution/engine.ts](../backend/execution/engine.ts)
- [backend/execution/prompt.ts](../backend/execution/prompt.ts)
- [backend/execution/providers/contracts.ts](../backend/execution/providers/contracts.ts)
- [backend/main.ts](../backend/main.ts)
- [backend/review/repair/service.ts](../backend/review/repair/service.ts)
- [backend/review/repair/store.ts](../backend/review/repair/store.ts)
- [backend/rpc.ts](../backend/rpc.ts)
- [backend/storage/contracts.ts](../backend/storage/contracts.ts)
- [backend/storage/service.ts](../backend/storage/service.ts)
- [docs/VERIFICATION.md](../docs/VERIFICATION.md)
- [electron/bridge.ts](../electron/bridge.ts)
- [src/App.tsx](../src/App.tsx)
- [src/components/AgentResponse.tsx](../src/components/AgentResponse.tsx)
- [src/components/AgentTimeline.tsx](../src/components/AgentTimeline.tsx)
- [src/components/ChangesView.tsx](../src/components/ChangesView.tsx)
- [src/components/CodeAskAI.tsx](../src/components/CodeAskAI.tsx)
- [src/components/CommandPalette.tsx](../src/components/CommandPalette.tsx)
- [src/components/CommandRuns.tsx](../src/components/CommandRuns.tsx)
- [src/components/ComposerSettings.tsx](../src/components/ComposerSettings.tsx)
- [src/components/CurrentRun.tsx](../src/components/CurrentRun.tsx)
- [src/components/PlanView.tsx](../src/components/PlanView.tsx)
- [src/components/RunError.tsx](../src/components/RunError.tsx)
- [src/components/TaskCleanup.tsx](../src/components/TaskCleanup.tsx)
- [src/components/TaskNavigation.tsx](../src/components/TaskNavigation.tsx)
- [src/components/TaskWorkspace.tsx](../src/components/TaskWorkspace.tsx)
- [src/components/TestsView.tsx](../src/components/TestsView.tsx)
- [src/components/repair/RepairWorkspace.tsx](../src/components/repair/RepairWorkspace.tsx)
- [src/lib/agent-output/activity.ts](../src/lib/agent-output/activity.ts)
- [src/lib/keyboard.ts](../src/lib/keyboard.ts)
- [src/lib/taskView.ts](../src/lib/taskView.ts)
- [src/lib/types.ts](../src/lib/types.ts)
- [src/lib/useDialogFocus.ts](../src/lib/useDialogFocus.ts)
- [src/styles.css](../src/styles.css)
- [tests/agent-output-ui.test.tsx](../tests/agent-output-ui.test.tsx)
- [tests/core-bridge.test.ts](../tests/core-bridge.test.ts)
- [tests/desktop-agent-output.test.ts](../tests/desktop-agent-output.test.ts)
- [tests/desktop-pipeline-approval.test.ts](../tests/desktop-pipeline-approval.test.ts)
- [tests/desktop-pr-repair.test.ts](../tests/desktop-pr-repair.test.ts)
- [tests/fixtures.ts](../tests/fixtures.ts)
- [tests/frontend.test.tsx](../tests/frontend.test.tsx)
- [tests/pipeline-approval-ui.test.tsx](../tests/pipeline-approval-ui.test.tsx)
- [tests/pr-repair/pipeline.test.ts](../tests/pr-repair/pipeline.test.ts)
- [tests/pr-repair/ui.test.tsx](../tests/pr-repair/ui.test.tsx)
- [tests/product-quality-ui.test.tsx](../tests/product-quality-ui.test.tsx)
- [tests/workspace-output-ui.test.tsx](../tests/workspace-output-ui.test.tsx)

### Moved

- `src/components/DiffFileTree.tsx` → `src/components/diff/DiffFileTree.tsx`
