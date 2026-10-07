# akkco vibestar architecture

## Runtime boundaries

Electron is a thin desktop host. React runs with context isolation, no Node integration and Chromium sandboxing. Its preload exposes a small sender-validated RPC/event bridge and window-control API. Navigation, webviews and arbitrary new windows are denied. A frameless 34px React titlebar provides native minimize, maximize/restore and close operations; Electron's application menu is removed and the loading background matches the app.

All orchestration lives in a Node 22 TypeScript execution core. Linux/WSLg launches it directly. Native Windows launches the configured WSL distribution with argv-safe wsl.exe --exec calls. A constant helper receives structured configuration and starts the core; newline-delimited JSON carries RPC requests and events over stdin/stdout. There is no application HTTP server or external database. Changing desktop execution settings updates only the host configuration.

## Frontend

React, Vite, Tailwind and shadcn-style primitives provide the dense IDE shell. Components separate navigation, task workspace, timeline, plans, changes, tests, terminals, logs, provider authentication and schedules. Task state comes from SQLite-backed snapshots and real core events. A lightweight task-ID keyed view store preserves drafts, selected tabs, diff files, review visibility and terminal docking while switching tasks. Pane dimensions persist locally. Ctrl+Shift+P opens a keyboard-operable command palette calling existing navigation and task actions.

Chat is the main task workspace. Structured agent results show their real summary or goal with expandable readable details; prose uses safe Markdown without raw HTML. Raw JSON stays in Logs. Normalized provider events form expandable file/search/command/edit/test calls, preserving command results and failures. New task configuration snapshots the three independent pipeline settings; global settings are defaults for future tasks. The composer selects a next-run follow-up provider/model/effort without mutating historical run metadata or autonomous stage order. Scheduled analysis does not replace task plans. Monaco and its workers are bundled locally and loaded on demand. xterm.js renders actual PTY streams.

## SQLite and persistence

backend/storage owns better-sqlite3, WAL, transactions, numbered migrations and redacted local logs. Tables cover repositories, issues, tasks, agent_runs, agent_events, task_messages, task_artifacts, test_runs, settings, scheduled_jobs, scheduled_attention, task_review_notes, terminal_sessions, task_activity, github_repositories, github_pull_requests and scheduled_agent_runs. JSON domain records retain issue context and task execution settings. A GitHub issue may have multiple independently runnable tasks.

Run records are written before spawning processes. Provider run IDs, model, effort, prompt, timestamps, PID/start identity, conversation ID, exit status and normalized structured outputs remain local. Redacted raw JSONL and separate stderr streams are retained under the task's logs directory. UI timelines show the most recent 2,000 events; raw-log inspection reads a bounded 1 MiB tail from complete files. Authentication PTY output is ephemeral and credentials are never read or copied.

## Git and worktrees

backend/workspace owns URL parsing, branch sanitization, safe paths, issue retrieval and Git commands. Each upstream repository has one harness-managed partial clone with complete history. Upstream and optional fork/origin remain separate. A repository-level filesystem lock serializes fetch and shared worktree/branch operations.

Every new task fetches upstream --prune, resolves the configured upstream base branch, saves its exact SHA and creates an independent branch/worktree from that commit. Preparation checkpoints allow recovery without abandoning or silently replacing a worktree. Personal checkouts and their current branches never participate. Existing task bases remain pinned. Collision suffixes are deterministic.

Final changes compare the saved base SHA with current worktree content, including committed, staged, unstaged, renamed, deleted and untracked files. A separate untracked flag distinguishes an untracked addition from indexed or committed additions in the file tree and editor toolbar. Monaco renders side-by-side or inline text; unified patches are also available. Binary and oversized files remain listed but text rendering is limited to 4 MiB. Canonical paths reject traversal, escaping symlinks and Git metadata access. Discard operations require explicit RPC confirmation and cannot run while the worktree is active.

Local review notes anchor selected base/working lines with a content hash. Sending notes to Codex is a deliberate task-local continuation, never a GitHub comment. Agents must verify anchors if source versions drift.

## Providers and execution

backend/execution/providers contains real Antigravity and Codex adapters. Detection inspects installed version/help, safe authentication status where available and Antigravity model discovery. Commands use only verified official flags. No mock adapter is selectable in production. Tests inject fixtures at the execution boundary.

Antigravity runs verified headless plan mode with structured JSONL and a schema. Codex uses official exec with JSON events, output schemas, independent reasoning configuration and read-only planning or workspace-write implementation. Unsupported configurations surface provider/stage/exit/error detail and are not silently downgraded. Subscription runs filter API-key overrides and keep authentication owned by each official CLI.

Adapters preserve raw events and normalize run.started, message, analysis.status, file.read, file.changed, command.started, command.output, command.finished, test.result and terminal run outcomes. Generic call IDs, paths, commands, output, durations and exit codes allow renderer grouping without CLI-specific parsing. Lifecycle/input envelopes remain raw debug events rather than fabricated thinking activity; empty metadata is not promoted into chat content. Observed Antigravity tool ERROR events normalize to finished/failed calls with their captured error, rather than remaining visually active. Follow-ups reconstruct persisted issue/scope/plans/messages in a fresh official run when stable headless session resumption is unavailable.

backend/execution/process executes argv arrays without implicit shells, streams stdout/stderr separately, filters environment variables, redacts secrets, bounds capture, enforces deadlines and tracks process groups. Cancellation sends a graceful interrupt, then escalates termination if necessary. No dangerous global permission bypass is enabled.

## Job queue and recovery

Engine owns a SQLite-backed queue with default concurrency 2, configurable 1–4. Different tasks run concurrently; stages inside one task are sequential: prepare, Antigravity plan, Codex refinement, Codex implementation, validation, Ready for Review. Stage-specific retries reuse successful earlier artifacts. Follow-up instructions affect only their task.

On startup, recorded PID and process-start identities prevent accidentally killing recycled PIDs. Disappeared/terminated active agent, test and terminal records become Interrupted. Expensive inference is never automatically repeated after a crash. Resume, Retry Stage and Restart Pipeline are explicit actions. Shutdown aborts the engine, stops the scheduler and PTYs, then closes persistence.

TaskTerminals owns real node-pty shells in the same required outer sandbox. Starting an interactive terminal acquires an exclusive task-worktree lease: other tasks can continue, but agents/manual command runs/scheduled analysis cannot race that shell in the same worktree. Closing the shell releases the lease. Switching renderer tabs only detaches xterm; the process stays alive and replays a bounded sequenced transcript. Terminal log errors surface in the UI without preventing PTY cleanup. Terminal PID identities and redacted transcripts are persisted; a crashed shell is not silently restarted. Authentication PTYs are separate official CLI login sessions.

## Local PR scheduler

backend/scheduled is an incremental module sharing the existing engine, providers, database and sandbox. Durable jobs support hourly, two-hourly and custom intervals. gh performs cheap GET inspections of tracked PRs, paginated comments/reviews and CI status. Last-seen snapshots detect discussion/review changes, requested changes, failing CI, merge conflicts and merged/closed state. Initial baselines flag deterministic existing problems without inference; unchanged snapshots never call models.

Actionable open-PR changes optionally acquire a linked idle task worktree for read-only Antigravity analysis and independent Codex refinement. Unlinked PRs use a managed empty read-only analysis workspace with GitHub context, without clones or tasks. The same AgentRunner handles structured inference, logging and provider validation; detached runs persist in scheduled_agent_runs and participate in PID recovery. Notifications appear under Needs Attention. Pipelines take priority, and schedules cannot overwrite task artifacts. Expensive failures/interrupted analysis require explicit retry. Auto implementation is OFF with no background implementation path; opening a linked task and submitting a follow-up explicitly requests a fix. Monitoring runs while the desktop app is open, not through an installed OS service.

## Security model

Mandatory bubblewrap mount isolation hides other worktrees, home data, Windows drives and ADE state/configuration. The managed clone is read-only, and only the assigned worktree is mounted read-only for planning or writable for implementation/terminal commands. System files are read-only; temporary files use sandbox tmpfs. SSH-agent and desktop-bus environment access are removed inside the sandbox. WSL DNS resolver targets are mounted explicitly. Missing isolation fails closed.

Provider-owned authentication/session directories must remain available to official CLIs. Vibestar does not inspect their contents. This is a documented trust boundary: mount isolation cannot distinguish a provider's authentication code from a tool in the same provider process. Provider tooling and its restrictions remain trusted. Network inference and upstream/issue reads are permitted; no application feature automatically pushes, creates PRs, comments, merges or changes issue administration.

## Build and verification

All application code is TypeScript; there is no Rust/Tauri backend. scripts/build.mjs bundles separate Electron and Node core entries. Locked core native dependencies are installed for Node 22 independently of Electron's ABI, including when deploying the helper inside WSL. electron-builder packages Linux deb and Windows NSIS targets with a local icon.

Tests cover URL/branch/path/state parsing, event normalization, argv handling, SQLite/recovery, real Git isolation/diffs/retry, PR snapshot change detection, renderer view state, official-auth PTYs, real task-terminal isolation and terminal crash-record reconciliation. The opt-in live test completed the real authenticated Antigravity → Codex refine → Codex implementation → validation → final diff slice. Electron tests exercise real IPC, window controls, plans, Monaco and local notes; authenticated GitHub discovery and native Windows development have separate running-host checks. NSIS installation/update still needs separate verification. docs/VERIFICATION.md records the measured subscription run, Electron captures and built Linux/Windows artifacts.

## Frontend design direction

Palette: workspace #181818, panels #141414, separators #2d2d2d, neutral text and restrained warm focus controls. Segoe UI/system UI serves navigation and conversation; Cascadia Code/Consolas serves technical information. Dense 12–14px controls, 4–6px radii, tab strips and thin separators keep conversation dominant. Status colors encode actual outcomes. Monaco remains the original bundled lazy-loaded editor. No third-party IDE source or proprietary assets were copied. react-markdown and remark-gfm render readable agent responses; their dependency licenses remain in npm metadata/package distributions.

## Desktop window milestone

The host explicitly enables maximize/fullscreen/resize. Native maximize is checked against the current display work area after transition; a geometry fallback retains restore bounds. Preload publishes maximize and fullscreen state, F11 toggles native fullscreen and Escape exits it. Native Windows keeps native app-region dragging and is the default development host when launched from WSL. The optional Linux/WSLg host uses Xwayland and a sender-validated pointer-drag fallback; its upstream frameless compositor offset is documented separately.

## GitHub and issue scope milestone

backend/github uses official gh authentication only. It stores repository metadata and authored upstream PRs separately from managed clones. Search partitions requests exceeding GitHub's 1,000-result limit. Known missing PRs require a confirmed closed/merged response before archival. Fork inference requires GitHub parent metadata; task linking requires matching upstream, head repository and branch. Sync runs at startup and every five minutes while open. Clones are prepared only on Use locally or task preparation. Migration 7 adds detached PR analysis run persistence. Migration 6 assigns existing tasks partial semantics and persists an explicit scope_mode column and JSON field. Whole issue tasks store no claimed scope; every stage receives the explicit entire-issue instruction.

PR watches are idempotently created for each discovered open authored PR, paused watches survive sync, and confirmed merged/closed PRs are archived. Inspections include paginated review threads, all CI transitions, head and base changes. Deterministic classification records failures/conflicts/requested changes; approvals, own comments, bots and unchanged snapshots avoid inference. Ambiguous feedback uses a strict action schema via read-only Antigravity and optional Codex verification. Follow-ups can choose either provider with a next-run configuration; historical run settings and the autonomous stage order stay intact. Linked local PR feedback is included in explicitly requested continuations.

## Task-centered IDE shell

The task tree opens a task immediately. Global Diffs and Overview destinations are removed. Chat, Plan and Changes are center views, with an optional resizable Changes or pipeline context pane and a resizable Problems/Tests/Terminal/Logs dock. Task-ID keyed state owns each draft, selected file, next-message provider/model/effort, and pane choices. Monaco remains the existing diff/review implementation; real edit events open task-local file diffs and active task changes are polled. Actual preparation Git command results are persisted in task_activity and shown before the agent stages. Conversations group real events by run, interleave user turns chronologically, and render prose/structured results without raw JSON. Login PTYs exist only in an ephemeral authentication dialog, with scoped event subscriptions and cleanup.

Advanced repository overrides update managed remotes under the repository lock after rejecting active/queued tasks; existing tasks keep their saved base branch and SHA. Clone preparation now accepts task cancellation. Monaco panes own separate models; models are released after the diff editor is disposed, and live updates retain the existing editor rather than resetting it on every poll. Terminal worktree leases are distinguished from active agent execution in the renderer so opening a utility shell does not display a running agent.

PR watches retain pause state across reopening, and Check now on a paused watch performs one inspection without resuming its schedule. Deferred/retried analysis refreshes GitHub first, so stale pending feedback cannot bypass a new closed/merged state. Review attention persists through unrelated CI progress until discussion changes or the user dismisses it.

Development keeps Vite HMR for renderer files and watches backend/electron TypeScript to rebuild the core, main and preload and restart Electron. Vite is spawned directly so closing the desktop also stops its server; generated build/package directories are excluded from HMR. Shutdown uses a development-only stdin quit command on Linux and WM_CLOSE on Windows, where WSL interoperability does not forward GUI stdin reliably. The Windows main process writes its window handle and PID into a private temporary metadata file; the launcher validates them and checks the current native owner PID before sending the close message. Both paths perform existing graceful bridge shutdown before restart. Development CLI arguments can enable diagnostics; production remains unchanged.

Windows-host bounds alone missed the reproduced WSLg frameless maximize bug: the Xwayland parent retained a 32px shadow margin and the rendered surface was offset despite correct reported bounds. scripts/dev-host.mjs therefore selects the matching official native Windows Electron binary when launched from WSL, downloading with checksum-verifying @electron/get and extracting into a versioned Windows development cache. Unpackaged development configuration points the existing Windows WSL bridge at the current checkout's built core and the same Linux data root; it does not overwrite installed desktop configuration or move provider accounts. Windows interoperability and unzip are required; VIBESTAR_DEV_HOST=linux explicitly selects the legacy WSLg host. Initial window dimensions fit the current monitor's work area and DPI scaling.

scripts/test-windows.mjs exercises the native Windows host using isolated WSL state and a local Playwright cache. It distinguishes invisible native resize borders from visible content bounds and uses actual Win32 mouse input to verify dragging and double-click. Fullscreen and maximize/restore are also exposed through the command palette. Composer context uses an inline field instead of Electron's unsupported window.prompt dialog; the draft remains task-local.
