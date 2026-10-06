# akkco vibestar

A local Electron Agent Development Environment for independent open-source contribution tasks. An issue can have multiple claimed scopes; each task owns its own pinned Git branch, worktree, conversation and sequential Antigravity → Codex planning → Codex implementation pipeline. Nothing is automatically pushed, posted or merged.

The application uses React, TypeScript, Vite, Tailwind, shadcn-style components, Monaco and xterm.js. The Node/TypeScript execution core owns SQLite, Git, processes and scheduling inside Linux/WSL. There is no Rust or Tauri dependency.

## Prerequisites

- Windows with WSL2 Ubuntu and WSLg, or a Linux desktop. Windows can run the Electron GUI natively; execution remains in WSL.
- Node.js **22.x** available to noninteractive commands in the execution distro and on the desktop development machine; npm 10 or newer. Native core addons are built for Node, not Electron.
- Git, `gh`, and the installed official `codex` and `agy` CLIs inside the execution distro. Authenticate using your existing subscriptions.
- `bubblewrap` (`bwrap`) with working unprivileged namespaces. Missing isolation fails closed.
- Python 3 and a C/C++ build toolchain for native SQLite/PTY dependencies if prebuilt binaries are unavailable.

Ubuntu 24.04/26.04 example system dependencies:

```bash
sudo apt install git gh bubblewrap build-essential python3 libgtk-3-0t64 libnss3 libgbm1 libasound2t64
node --version
npm --version
codex --version
agy --version
```

Provider command construction verifies installed CLI help. The tested environment has Codex 0.160.0, Antigravity 1.2.17, Git 2.53.0, gh 2.46.0 and Electron 41.10.7. These are tested versions, not hardcoded model requirements.

## Install and run

```bash
cd /home/aksha/akkco-vibestar
npm ci
npm run dev
```

If this machine still has npm 9, use `npx --yes npm@11 ci` for dependency installation. Development starts Vite and Electron, and builds the local Node core first. Close the application to stop the core and its active processes.

To run the production build locally:

```bash
npm run build
npm start
```

Build an Ubuntu/WSLg installer:

```bash
npm run desktop:build
sudo apt install ./release/akkco-vibestar_0.1.0_amd64.deb
```

The unpacked desktop executable is also under `release/linux-unpacked/akkco-vibestar`. The installer requires the execution prerequisites above, including Node 22.

To build the native Windows installer, use a Windows terminal from the project checkout:

```powershell
npm ci
npm run desktop:build:windows
```

Both Linux deb and Windows NSIS installers were built on this machine. Cross-building NSIS on Linux requires Wine. Windows signing certificates are optional for local development; release signing is not configured.

## Windows and WSL configuration

1. Install Node 22, Git, gh, bubblewrap and both official CLIs inside the chosen WSL distribution. Verify `wsl.exe --distribution Ubuntu --exec node --version` works from Windows; shell startup scripts are not used.
2. Start the Windows Electron application and open **Settings**.
3. Select the WSL distro. Leave the Linux data directory blank for `~/.akkco-ade`, or set an absolute Linux directory.
4. Save and use **Install / update WSL helper**. This copies the bundled core and its locked npm manifest into the selected distro and installs its Linux SQLite/PTY dependencies there.
5. Keep repositories and data on the Linux filesystem. Do not choose `/mnt/c` or Windows temporary directories for large repositories.

Linux/WSLg builds execute directly in their current distro. The desktop process has a small local configuration file containing distro/path preferences; all execution data resides in the Linux root below. `VIBESTAR_HOME` overrides the data root when running directly on Linux.

```text
~/.akkco-ade/
  repos/<repository-id>/              # one managed upstream clone
  worktrees/<repository-id>/<scope>/  # independent task checkouts
  logs/<task-id>/                     # preparation and redacted provider logs
  artifacts/                         # temporary structured-output schemas
  state/vibestar.sqlite              # queue, context, settings and schedules
  state/runtime/                     # Windows-installed WSL helper
```

## Connect providers

Open **Providers** to inspect installation, authentication, current Antigravity model discovery and supported effort values.

**Codex:** Connect opens the official `codex login` flow in a PTY. Detection uses `codex login status`. Subscription runs explicitly require ChatGPT authentication and remove API-key environment overrides. No API credit purchase or API key is needed for supported subscription operations.

**Antigravity:** Connect opens the installed official interactive `agy` flow in a PTY. Version 1.2.17 does not advertise a separate login subcommand, so Vibestar does not invent one. Account detection is limited to the safe CLI interfaces; it never examines the keyring. If account status is unavailable, authenticate in the official flow and let a run report any authentication failure.

In **Settings**, configure **three independent** models, effort values and deadlines. Empty model uses the official CLI default deliberately. Antigravity models come from `agy models`; a model with an effort suffix must match its selected effort. Codex accepts an explicit configured slug and reports provider rejection without silently substituting another model or effort.

Codex uses its verified `exec` structured-output interface, read-only planning and workspace-write implementation. Antigravity uses its verified headless plan-mode and stream-json interface. Neither adapter uses a dangerous permission bypass flag. Provider sessions are recorded when exposed; follow-ups reconstruct saved context as a fresh run rather than pretending to resume an unsupported session.

## Repository and task setup

1. **Repositories → Add repository**: set original upstream URL, optional fork/origin URL and actual upstream base branch, such as `develop` for a project that uses it.
2. **New task**: paste `https://github.com/oppia/oppia/issues/26831`, claimed scope `check-improvements-tab.spec.ts`, and optional notes limiting the scope.
3. Preview owner/repository, issue, scope, base and branch, then **Create & Run**.

Every new task fetches upstream under a repository lock, resolves the configured remote branch's exact SHA, saves it and creates a worktree from that SHA. It never uses your personal checkout or the managed clone's currently checked-out branch. Existing tasks stay pinned. Duplicate branches receive deterministic suffixes.

GitHub issue retrieval tries authenticated `gh issue view` first, then the documented public REST API for public issues. For private issues, reliable rate limits, and PR scheduling, authenticate gh inside WSL:

```bash
gh auth login
gh auth status
```

Inspect plans, live events, prompts, raw logs and tests from Chat / Plan / Changes / Tests / Terminal / Logs. Ctrl+Shift+P opens the command palette. Resize the sidebar, stage pane or terminal dock by dragging their separators. Task drafts, tabs and diff preferences remain available when switching tasks. Composer model/effort changes apply only to that task and are explicitly saved. Retry Stage retains earlier successful results. Resume explicitly retries an interrupted stage. Restart Pipeline reuses the same worktree and pinned base and reruns planning; it does not discard your changes.

The **Changes** tab includes a directory tree, filtering, rename metadata, per-file statistics, staged/working indicators, Monaco side-by-side and inline modes, unified patches, expanded/collapsed context and read-only file inspection. F7 / Shift-F7 navigate hunks; Alt-Down / Alt-Up navigate files. Final diff compares saved base to the entire current worktree, including uncommitted and untracked content. Discard file/all restores the saved base only after confirmation. **Review** saves local notes on selected lines with version hashes. **Send feedback to Codex** explicitly starts a task-local implementation continuation; notes are never posted on GitHub.

The **Terminal** tab and bottom dock provide a real xterm.js PTY shell restricted to the task worktree. Close its shell before starting another agent execution in that same task; other tasks can continue. Switching views preserves the process and replays a bounded transcript. Terminal sessions are reconciled after a crash and are not silently restarted.

Manual commands are explicit argv JSON arrays, for example `["npm","test","--","specific.spec.ts"]`. No shell is implicitly invoked. The assigned working directory remains visible. Results include stdout, stderr, duration, exit code and Passed/Failed status; provider-reported skipped tests are separate.

## Scheduled PR monitoring

**Scheduled** is owned by Vibestar, not a provider. Discover your open authored PRs in a registered repository through `gh`, or track a specific HTTPS GitHub PR URL. Choose every 1 hour, 2 hours, or a custom interval from 5 minutes to 7 days.

Link a prepared task worktree to enable safe analysis; tracking without one still produces notifications. Optional Codex verification uses its independent planning settings after Antigravity. The first successful check establishes a baseline. Subsequent checks detect new/edited discussion and inline comments, reviews, requested changes, CI failures, merge conflicts, and merged/closed state.

**Unchanged snapshots never call a model.** Actionable open-PR changes use read-only analysis and appear under **Needs Attention**. Merged/closed notifications do not invoke a model. Saved task plans remain unchanged. Pipelines have priority over scheduled analysis, and an active worktree is never used by two runs at once. A model error or interrupted analysis needs an explicit retry; it does not automatically spend quota again.

Automatic implementation is **OFF**, with no background implementation path. **Fix with Codex** is an explicit user action using the linked task's follow-up pipeline, scope and sandbox. Both planning stages must already have succeeded. All changes remain local for review.

Jobs, due times and snapshots survive application restarts. Monitoring runs **while Vibestar is open**; it is not an installed background OS service. After reopening, overdue cheap inspections run once, without a burst of catch-up model calls. The linked worktree can differ from the PR head; prompts explicitly expose both and require analysis to identify that mismatch rather than silently checking out another branch.

## Security boundaries

- Renderer: sandboxed Electron, context isolation enabled, Node integration disabled, narrow sender-validated preload IPC, local bundled Monaco assets, restrictive CSP, denied navigation/webviews/new windows.
- Processes: argv arrays, no interpolation into shells, filtered environment, bounded streaming buffers, deadlines, graceful interrupt followed by termination, persisted PID plus process-start identity.
- Files: canonicalized managed paths, traversal and escaping-symlink rejection, editor size limits, confirmation enforced in RPC for destructive operations.
- Agents: required outer bubblewrap mount namespace plus official provider sandboxes. Planning worktrees are read-only; implementation sees only its assigned writable worktree. Other worktrees, personal home files and Windows drives are hidden. Missing isolation blocks execution.
- Provider-owned auth/session directories remain mounted because the official CLI must authenticate and store conversations. Vibestar never reads, deserializes or copies their credentials. This is a trust boundary: an OS mount cannot distinguish provider authentication code from tools running inside that same provider process. Provider security restrictions and prompts remain necessary, and this is not a claim of complete protection against a malicious provider executable.
- SQLite and logs store task context and **redacted** events, not provider OAuth tokens. Authentication PTY output is ephemeral. Raw logs are redacted too.
- Remote access is limited to issue/PR reads, upstream Git fetch, and official inference/authentication. Vibestar never automatically pushes, comments, creates PRs, merges, assigns or closes issues. Model instructions prohibit remote writes; official provider tooling and its auth directory remain trusted.

The window is frameless with a dark 34px React titlebar, draggable region and non-draggable controls. Minimize, maximize/restore and close invoke Electron through preload; the application menu is removed. WSLg tests confirm maximize/restore and close. This automation session's compositor does not report minimized state after Electron's native minimize call; native Windows minimization still requires verification on Windows.

## Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:tui
npm run build
npm run test:desktop
npm run desktop:build
```

`npm run test:live` is opt-in and uses your authenticated real provider subscriptions against a small isolated local fixture. It consumes model quota. Normal tests use injectable **test-only** provider fixtures; production has no mock-provider selection. The live slice verified Antigravity planning, Codex refinement, Codex implementation, relevant validation, final diff and Ready for Review with the official CLIs. PR monitoring cannot be live-verified until gh is authenticated.

[Verification results](docs/VERIFICATION.md) record the real provider run, tests and packaged-app checks. `docs/screenshots/` holds actual Electron smoke-test captures when that test is run. `ARCHITECTURE.md` explains implementation boundaries. `AGENTS.md` was copied from the local akkco-code instructions.

## Deliberate V1 limits

No automatic upstream rebase, push, PR creation, GitHub comments, merges or issue administration. Updating a pinned base is reserved for a deliberate later action. Provider model slugs and errors remain provider-owned. Binary or larger-than-4-MiB files remain in the changed-file list but are not rendered as editable text. Live event inspection keeps the latest 2,000 events in the UI; raw-log inspection reads the last 1 MiB directly from the complete redacted logs on disk. Application-closed monitoring, signed Windows release distribution, and execution of Windows installer tests require the corresponding external environment or credentials.

UI work also applies the requested [frontend-design skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design), with screenshot-based critique and the existing compact IDE direction.

Interaction references: [T3 Code](https://github.com/pingdotgg/t3code), especially its diff tree, collapsed context and local review patterns. Vibestar keeps its own issue/scope/pinned-worktree orchestration and official CLI integrations; it does not adopt remote-account services or provider credential extraction.
