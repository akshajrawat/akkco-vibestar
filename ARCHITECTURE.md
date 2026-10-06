# akkco vibestar architecture

## Runtime boundaries

Electron is a thin desktop host. React runs with context isolation, no Node integration and Chromium sandboxing. Its preload exposes a small sender-validated RPC/event bridge and window-control API. Navigation, webviews and arbitrary new windows are denied. A frameless 34px React titlebar provides native minimize, maximize/restore and close operations; Electron's application menu is removed and the loading background matches the app.

All orchestration lives in a Node 22 TypeScript execution core. Linux/WSLg launches it directly. Native Windows launches the configured WSL distribution with argv-safe wsl.exe --exec calls. A constant helper receives structured configuration and starts the core; newline-delimited JSON carries RPC requests and events over stdin/stdout. There is no application HTTP server or external database. Changing desktop execution settings updates only the host configuration.

## Frontend

React, Vite, Tailwind and shadcn-style primitives provide the dense IDE shell. Components separate navigation, task workspace, timeline, plans, changes, tests, terminals, logs, provider authentication and schedules. Task state comes from SQLite-backed snapshots and real core events. A lightweight task-ID keyed view store preserves drafts, selected tabs, diff files, review visibility and terminal docking while switching tasks. Pane dimensions persist locally. Ctrl+Shift+P opens a keyboard-operable command palette calling existing navigation and task actions.

Chat is the main task workspace. Structured agent results show their real summary or goal with expandable full JSON; ordinary prose remains intact. Normalized provider events form expandable file/search/command/edit/test calls, preserving command results and failures. Composer controls explicitly save three independent provider/model/effort configurations for the selected task; global settings are defaults for future tasks. Scheduled analysis does not replace task plans. Monaco and its workers are bundled locally and loaded on demand. xterm.js renders actual PTY streams.

## SQLite and persistence

backend/storage owns better-sqlite3, WAL, transactions, numbered migrations and redacted local logs. Tables cover repositories, issues, tasks, agent_runs, agent_events, task_messages, task_artifacts, test_runs, settings, scheduled_jobs, scheduled_attention, task_review_notes and terminal_sessions. JSON domain records retain issue context and task execution settings. A GitHub issue may have multiple independently runnable tasks.

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

backend/scheduled is an incremental module sharing the existing engine, providers, database and sandbox. Durable jobs support hourly, two-hourly and custom intervals. gh performs cheap GET inspections of tracked PRs, paginated comments/reviews and CI status. Last-seen snapshots detect discussion/review changes, requested changes, failing CI, merge conflicts and merged/closed state. Initial baselines and unchanged snapshots never call models.

Actionable open-PR changes optionally acquire a linked idle task worktree for read-only Antigravity analysis and independent Codex refinement. Notifications appear under Needs Attention. Pipelines take priority, and schedules cannot overwrite task artifacts. Expensive failures/interrupted analysis require explicit retry. Auto implementation is OFF with no background implementation path; Fix with Codex is an explicit task-local follow-up. Monitoring runs while the desktop app is open, not through an installed OS service.

## Security model

Mandatory bubblewrap mount isolation hides other worktrees, home data, Windows drives and ADE state/configuration. The managed clone is read-only, and only the assigned worktree is mounted read-only for planning or writable for implementation/terminal commands. System files are read-only; temporary files use sandbox tmpfs. SSH-agent and desktop-bus environment access are removed inside the sandbox. WSL DNS resolver targets are mounted explicitly. Missing isolation fails closed.

Provider-owned authentication/session directories must remain available to official CLIs. Vibestar does not inspect their contents. This is a documented trust boundary: mount isolation cannot distinguish a provider's authentication code from a tool in the same provider process. Provider tooling and its restrictions remain trusted. Network inference and upstream/issue reads are permitted; no application feature automatically pushes, creates PRs, comments, merges or changes issue administration.

## Build and verification

All application code is TypeScript; there is no Rust/Tauri backend. scripts/build.mjs bundles separate Electron and Node core entries. Locked core native dependencies are installed for Node 22 independently of Electron's ABI, including when deploying the helper inside WSL. electron-builder packages Linux deb and Windows NSIS targets with a local icon.

Tests cover URL/branch/path/state parsing, event normalization, argv handling, SQLite/recovery, real Git isolation/diffs/retry, PR snapshot change detection, renderer view state, official-auth PTYs, real task-terminal isolation and terminal crash-record reconciliation. The opt-in live test has completed the real authenticated Antigravity → Codex refine → Codex implementation → validation → final diff slice. Electron smoke tests exercise real IPC, window controls, plans, Monaco and local notes. gh authentication is required for live PR monitoring verification; native Windows installer/runtime behavior needs Windows verification. docs/VERIFICATION.md records the measured real subscription run, actual Electron captures, packaged Linux smoke test and built Linux/Windows artifacts.

## Frontend design direction

The requested anthropics/frontend-design skill guides incremental visual critique, not a backend rewrite. Palette: workspace #101217, panels #15181f, separators #292d36, primary text #d4d7df, secondary text #858d9e, restrained focus/action accent #8fa4ff. Segoe UI/system UI typography serves navigation and conversation; Cascadia Code/Consolas monospace serves paths, commands, SHAs and diffs. Layout is left-aligned task tree → central chat/editor → narrow stage pane, with an optional bottom terminal. Status colors encode actual outcomes. There are no decorative gradients, marketing heroes, fabricated activity or generic oversized cards. Screenshots from real task execution guide a second critique pass. Chat and terminal flex surfaces explicitly allow width shrinkage so long assigned paths cannot push shell controls beyond the window.
