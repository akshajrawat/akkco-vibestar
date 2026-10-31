# T3 Code chat parity

## Reference analysis before implementation

Reference: [pingdotgg/t3code](https://github.com/pingdotgg/t3code), commit
`861a51a6c4a036a6f14fea2a6f093808de1d96ce` (inspected 2026-10-29).
Its MIT license permits adaptation with the copyright and permission notice retained.
Vibestar's existing provider, execution and persistence boundaries remain authoritative.

| Concern           | Reference implementation                                                                                                                                                                                    | Vibestar before reconstruction                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition       | `ChatView.tsx` composes `chat/ChatCanvas`, `MessagesTimeline`, composer surfaces and separate workflow panels.                                                                                              | Task and repair already share `ChatSurface`, `AgentTimeline` and `Composer`, but expose prompts and setup operations as conversation.                                                                    |
| Submission        | `chat/useComposerSend.ts` inserts a stable optimistic message and clears a draft before dispatch; restores failed drafts without overwriting later typing. `optimisticUserMessages.ts` reconciles the echo. | `TaskWorkspace.tsx` inserts messages only after RPC resolves and retains acknowledged copies indefinitely.                                                                                               |
| Draft promotion   | `chat/draftHeroTransition.ts` and `useDraftHeroLayoutTransition.ts` capture composer bounds and apply a FLIP transform with `cubic-bezier(0.4, 0, 0.2, 1)`; reduced motion disables animation.              | No draft promotion transition; context and preparation blocks occupy the initial conversation.                                                                                                           |
| Layout            | `chat/ChatCanvas.tsx` measures canvas/composer widths; `index.css` defaults to a 46rem reading lane; `ComposerSurface.tsx` uses 16px corners.                                                               | 1050px reading lane, large full-width user cards, provider avatars and repeated provider/model/stage labels.                                                                                             |
| Messages          | `TimelineUserMessageRow.tsx` uses right-aligned bubbles capped at 80%, hover/focus actions and distinct projected failure states. Assistant prose is unboxed.                                               | User actions and internal chat status remain permanently visible. Saved assistant messages can disappear whenever any matching run exists, even without renderable output.                               |
| Activity          | `MessagesTimeline.tsx` groups actual provider work; `WorkLog.tsx` uses compact rows and expandable, selectable details.                                                                                     | Tools are expandable but per-run repeated event filtering and lookup add avoidable work. Tool/status transitions can regress when events arrive out of order.                                            |
| Streaming         | Stable projected item IDs and incremental deltas; structured output is a separate presentation concern.                                                                                                     | Call IDs merge deltas, but incomplete JSON becomes a placeholder and final output can duplicate prose already emitted as a message.                                                                      |
| Scrolling         | `timelineScrollAnchoring.ts`, `useTimelineFollow.ts`, `timelineViewport.ts` and `pageScrollController.ts` distinguish following, anchoring and free navigation. Positions are scoped to a thread visit.     | Revision effect assigns scrollTop, persists every scroll through the view store, has no jump-to-latest, and misses asynchronous content resize.                                                          |
| Provider sessions | Server `provider/CodexProvider.ts`, `codexLaunchArgs.ts` and drivers use the official Codex app-server protocol; sessions start/resume threads and turns.                                                   | Official subscription authentication already exists, but each authorized turn starts `codex exec` with a schema and a fresh prompt. Ordinary chat prepares an isolated worktree before its first answer. |
| Review            | Execution completion and review/check outcomes are separate facts.                                                                                                                                          | UI labels code review as changes requested whenever verification fails, even if the reviewer approves code with environmental blockers.                                                                  |
| Terminal          | A user shell has an explicit usable lifecycle independent of agent tools.                                                                                                                                   | Renderer can miss a terminal exit during status/open replay, leaving a stale session; open failures only reach the global banner.                                                                        |

## Implementation boundaries

Use the shared task/repair chat components for presentation, optimistic submission,
activity and scroll behavior. Retain exact prompts in Run details and show workflow
briefs as ordinary user messages. Show changed files beside
the relevant implementation turn rather than as a permanent tail on every conversation.
Preserve persisted stage 4 validation/recovery records and their RPCs.

Chat before final review remains read-only. After review, the ordinary composer requests
explicit workspace access with the selected model; this never advances workflow stages.
New sessions include completed conversation and relevant workflow results as context.
Greetings and app-identity questions
must not instruct the provider to inspect the repository. Repository investigation is
appropriate only when needed to answer the actual question.

Provider transport changes must retain the outer sandbox, per-assignment filesystem
authority, subscription authentication, redaction, observed outcomes, cancellation,
execution slots and no replay after restart. Session reuse cannot cross task, provider
configuration or stage permissions. No credential extraction or alternative inference
endpoint is needed for CLI-managed subscriptions.

## Implemented behavior and audit

Task and PR repair share optimistic reconciliation, the composer, timeline and scroll
surface. Server echoes win by message identity, failed submissions restore an untouched
draft, and a saved instruction retains its approval-boundary behavior. Workflow prompts
appear as user turns; setup logs stay in workflow/run tools. Plans and final replies appear
directly in chat; completed activity folds under “Worked for…”. Protocol user-message echoes
and diagnostic metadata remain out of the conversation. Changed-file summaries
sit with implementation. Provider icons no longer repeat on assistant turns.

The timeline groups events by run and call, sorts/deduplicates persisted event IDs and
preserves terminal tool states when late output arrives. Structured summaries render
incrementally, with final prose/schema echoes reconciled once. Message call IDs stay
stable when the 2,000-event detail window moves. Shared conversation event handling
retains observed deltas and uses existing owner-checked event pages to restore missing
prefixes after refresh or missed updates; it starts no provider and adds no retry timer.

Scrolling follows the latest output while preserving deliberate navigation through history.
Messages remain in natural document flow without a new-prompt anchor or synthetic spacer.
Content/composer resize drives alignment, Latest returns to live output, and scroll
persistence is deferred rather than rebuilding the workspace for every scroll event.
Draft promotion uses a measured transform, 300ms duration and the reference easing;
reduced motion bypasses the transform. Response rendering and live activity lookup are
memoized so an elapsed-time tick does not reparse the entire transcript.

Ordinary conversations use native text responses without workflow output schemas. New
sessions receive project context and bounded history once; resumed turns send only the
user's message. The composer has one conversation path; Send to workflow explicitly routes
pipeline feedback. Greetings, thanks and app-identity questions
call the real selected provider from an empty read-only workspace, with no clone,
worktree preparation or source fingerprinting. Codex uses app-server thread/turn messages;
Antigravity uses its documented explicit `--conversation` flag. A completed session can
continue only within the same task, provider configuration and conversation scope.
Successful official capability discovery is cached for 30 seconds, invalidated by an
explicit refresh or failed run. Chat does not wait for a second model-discovery process
at completion. Authentication remains CLI-owned.

Terminal attachment now accounts for a shell exiting during status/open replay and
shows startup/busy errors inside the terminal. Code approval is displayed separately
from observed verification. Concrete read-only-filesystem and Unix-socket-length blockers
remain unverified; assertion failures still fail and prevent final acceptance. The final
review reports findings and next manual steps in chat and ends the workflow on either
verdict. Host verification remains authoritative in Checks. Explicit chat edits invalidate
the previous review even if the provider fails. Older callers retain read-only semantics;
workspace access requires the core's advertised capability.

The secondary audit removed confirmed-unused avatar, preparation, old composer and
current-run text selectors, plus obsolete nested changed-file button rules. It removed
the acknowledged-message accumulation and draft synchronization effects. TypeScript
unused checks and ESLint pass. A runtime import-graph review found the unmounted
`VerificationRecovery.tsx` UI referenced by compatibility tests; it was retained with
its stage-4 tests and backend recovery contracts rather than treating historical
compatibility as disposable. No migration, approval gate, publication endpoint or
persisted stage identifier was removed.

## Verification

`npm run verify` passed 377 regular, 138 integration, 132 security and 6 terminal tests
(653 total), with one existing opt-in regular case skipped. Formatting, lint, types and
the production build passed. A final saved-instruction restoration adjustment then
passed the 24 focused chat/composer cases and a fresh production build.

The final build passed all three applicable Electron fixtures under Xvfb, run with one
worker: `desktop-chat-workspace`, `desktop-agent-output` and `desktop-pr-repair`. They
exercise keyboard controls, workflow gates, refresh/recovery, live fixture tool events,
redacted output and a real manual PTY against disposable local Git remotes. Two stale
provider-specific assertions in the output fixture were updated to the current generic
plan label and scoped usage cards.

Visual comparison used the actual upstream `WorkLog` and `ComposerSurface` components,
upstream CSS compiled locally, and the user-bubble markup extracted from its source.
It compared completed, streaming and failed states at 1100px and 760px on the same
Electron host. At 1100px both reading/composer lanes measure 736px, composer height is
114px, and the sample bubble measures 354.5 × 36px. No compared state overflows the
viewport. The 760px Vibestar lane is about 2.4px wider because of its responsive gutter.
This is an isolated component comparison, not a running copy of the entire T3 service.

Local comparison captures are in `test-results/chat-reference/`. Built workspace,
output and terminal captures and command results are referenced in the historical
verification record. The installed Codex-generated app-server schema was also inspected
without inference to check request fields, read-only sandbox values and event shapes.

## Remaining visual and behavioral differences

- Vibestar retains its task header, workflow sidebar, human approval gates and exclusive
  terminal lease. A manual shell waits while an agent owns the workspace; that reason is
  now visible. Code approval does not waive failed or missing checks.
- The composer remains the existing accessible textarea with text context snapshots,
  rather than T3's rich attachment/mention editor. App fonts, minor gutters, tool wording,
  provenance badges and severity colors retain some Vibestar styling.
- The timeline uses DOM measurements and owner-scoped message retention rather than
  LegendList virtualization, minimaps, rich citations and T3's custom page-scroll controller.
  Older raw tool history is paginated in Raw logs. Completed provider answers remain saved.
- The 300ms draft transition is fixed; T3's animation preference controls (including its
  zero-duration default) are not copied. Reduced-motion handling remains available.
- Codex owns one sandboxed app-server process per explicitly requested turn rather than
  keeping a permanently warm process. Provider/configuration/scope changes start a new
  session with bounded saved context. The first repository question may still prepare an
  isolated worktree; greetings skip that work.
- T3's remote/mobile shell, multi-account controls and canvas preview player are outside
  this local Electron chat scope. Native Windows installation/input and actual provider
  response latency were not measured. No live-provider or GitHub-write tests were run.
