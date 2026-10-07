# akkco vibestar

A local Electron Agent Development Environment for independent open-source contribution tasks. The task conversation is the workspace: each whole issue or claimed subtask owns its pinned Git branch, worktree, conversation and sequential Antigravity → Codex planning → Codex implementation pipeline. GitHub repository discovery and an automatic PR inbox use the official GitHub CLI. Nothing is automatically pushed, posted or merged.

The application uses React, TypeScript, Vite, Tailwind, shadcn-style components, Monaco and xterm.js. The Node/TypeScript execution core owns SQLite, Git, processes and scheduling inside Linux/WSL. There is no Rust or Tauri dependency.

## Prerequisites

- Windows with WSL2 Ubuntu and WSLg, or a Linux desktop. Windows can run the Electron GUI natively; execution remains in WSL.
- Node.js **22.x** available to noninteractive commands in the execution distro and on the desktop development machine; npm 10 or newer. Native core addons are built for Node, not Electron.
- Git, `gh`, and the installed official `codex` and `agy` CLIs inside the execution distro. Authenticate using your existing subscriptions.
- `bubblewrap` (`bwrap`) with working unprivileged namespaces. Missing isolation fails closed.
- Python 3 and a C/C++ build toolchain for native SQLite/PTY dependencies if prebuilt binaries are unavailable.

Ubuntu 24.04/26.04 example system dependencies:

```bash
sudo apt install git gh bubblewrap build-essential python3 unzip libgtk-3-0t64 libnss3 libgbm1 libasound2t64
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

If this machine still has npm 9, use `npx --yes npm@11 ci` for dependency installation. Development builds the local Node core and starts Vite and Electron. When launched from WSL on Windows, it downloads/caches the matching official Windows Electron runtime and runs the GUI natively; the core, data and provider accounts stay in the current WSL distro. Windows Node is not required. Backend/Electron changes rebuild and restart the desktop; renderer changes use Vite HMR. Close the application to stop the core and its active processes. `VIBESTAR_DEV_HOST=linux npm run dev` explicitly selects the WSLg host for diagnostics.

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
3. Select the WSL distro. Leave the Linux data directory blank for `~/.akkco-vibestar`, or set an absolute Linux directory.
4. Save and use **Install / update WSL helper**. This copies the bundled core and its locked npm manifest into the selected distro and installs its Linux SQLite/PTY dependencies there.
5. Keep repositories and data on the Linux filesystem. Do not choose `/mnt/c` or Windows temporary directories for large repositories.

Linux/WSLg builds execute directly in their current distro. The desktop process has a small local configuration file containing distro/path preferences; all execution data resides in the Linux root below. `VIBESTAR_HOME` overrides the data root when running directly on Linux.

```text
~/.akkco-vibestar/
  repos/<repository-id>/              # one managed upstream clone
  worktrees/<repository-id>/<scope>/  # independent task checkouts
  logs/<task-id>/                     # preparation and redacted provider logs
  artifacts/                         # temporary structured-output schemas
  state/vibestar.sqlite              # queue, context, settings and schedules
  cache/                             # disposable utility workspaces
  runtime/                           # Windows-installed WSL helper
  telemetry/                         # local usage exports
```

## Connect providers

Open **Providers** to inspect installation, authentication, current Antigravity model discovery and supported effort values.

**GitHub:** Status uses `gh auth status` and the authenticated account identity. Connect/Reconnect opens the official `gh auth login --hostname github.com --web --git-protocol https` flow in a temporary login dialog. Repository and authored upstream PR discovery starts after connection. Vibestar never extracts or stores OAuth tokens.

**Codex:** Connect opens the official `codex login` flow in a temporary PTY dialog that closes when success is detected. Detection uses `codex login status`. Subscription runs explicitly require ChatGPT authentication and remove API-key environment overrides. No API credit purchase or API key is needed for supported subscription operations.

**Antigravity:** Connect opens the installed official interactive `agy` flow in a temporary login dialog; select Done after authentication. Successful authenticated `agy models` discovery marks the provider Connected. Model names and supported efforts come from the official CLI; credentials remain provider-owned.

Settings has separate Agents, GitHub & PR Watch, Repositories, Storage, Usage and Execution sections. Utility AI is independent of the coding pipeline and is used only for ambiguous PR conversation semantics. Every model run is recorded locally, with token counts only when reported by the provider. Codex subscription windows are displayed when its official CLI exposes them; unavailable allowance information is labeled explicitly.

Connect a local repository explicitly by WSL path or Windows drive path; Windows paths are converted with `wslpath` inside the configured distro. Optional discovery searches configured roots with bounded depth and offers candidates to connect. Imported checkouts remain references; tasks use isolated worktrees under the data root. Storage cleanup never deletes an imported source repository. Existing `~/.akkco-ade` data presents Migrate, Use old location or Start fresh; migration preserves the old root and repairs copied worktree metadata.

In **Settings**, configure **three independent** models, effort values and deadlines. Empty model uses the official CLI default deliberately. Antigravity models come from `agy models`; a model with an effort suffix must match its selected effort. Codex accepts an explicit configured slug and reports provider rejection without silently substituting another model or effort.

Codex uses its verified `exec` structured-output interface, read-only planning and workspace-write implementation. Antigravity uses its verified headless plan-mode and stream-json interface. Neither adapter uses a dangerous permission bypass flag. Provider sessions are recorded when exposed; follow-ups reconstruct saved context as a fresh run rather than pretending to resume an unsupported session.

## Repository and task setup

**Repositories** shows active local connections first, discovered candidates second, and a searchable GitHub **All** catalog. There are no Recent/Owned/Forks tabs or advanced Git URL form. Discovery is optional and never activates a repository automatically.

1. Choose **Connect local repository**, select **WSL** or **Windows**, and enter the checkout path (for example `/home/aksha/oppia` or `D:\projects\my-repo`). **Verify repository** shows the canonical execution path, remotes, GitHub identities, current branch and available base branches. Confirm the upstream, fork and base, then **Connect repository**. No scan, clone or fetch is needed for this connection.
2. Choose **New task** and select an active **Repository**. Paste an issue URL, such as `https://github.com/oppia/oppia/issues/26831`. A unique matching active checkout is visibly suggested; an explicit mismatched selection blocks creation. Vibestar fetches the issue preview from GitHub using the selected repository ID.
3. Choose **Entire issue** or **Specific part / claimed subtask**, add any instructions, and inspect the source path, future worktree location and base. Expand **Agent configuration** if needed, then **Start task**.

GitHub catalog entries offer **Find local checkout**. If no candidate is found, **Create Vibestar-managed clone** explicitly confirms a download under the data root. Imported and managed ownership are labeled. **Disconnect** removes a repository from the active selector but keeps source files, branches, task history and worktrees. Verify/reconnect an imported checkout to use its existing ID again.

The SQLite migration preserves existing V1 tasks as partial tasks. Whole issue tasks have explicit `scope_mode: "whole_issue"` and an empty claimed scope; all three prompts receive whole issue semantics. No misleading claimed-scope string substitutes for this distinction.

For an imported Oppia checkout, verification reads `origin` as `akshajrawat/oppia`, `upstream` as `oppia/oppia`, and the remote HEAD as `develop`. The source checkout can remain on its own feature branch. Multiple checkout paths for the same upstream have separate registry IDs; task creation uses exactly the selected ID.

Every new task fetches upstream under a repository lock, saves the exact base SHA and creates a fresh isolated branch/worktree. Imported checkouts supply Git object storage; agents execute only in their task worktree, never in the source directory. At Ready for Review, **Finalize…** offers Review changes, Open worktree, Mark complete or Keep task in worktree. It never automatically commits, switches or modifies the source checkout. Duplicate branches receive deterministic suffixes; existing task bases remain pinned.

## Task workspace

The compact IDE shell has a collapsible, resizable repository/task tree, a dominant conversation, optional resizable Changes/pipeline context, and a bottom **Problems / Tests / Terminal / Logs** dock. **Chat / Plan / Changes** are views of the same task. There is no global Diffs destination or dashboard Overview. Ctrl+Shift+P opens commands; Ctrl+B toggles the sidebar.

Chat shows actual preparation commands, Antigravity planning, Codex refinement, Codex implementation and validation in one continuous conversation. Structured provider streams become collapsible read/search/command/edit/test events. Prose and structured results render as readable content; raw events stay in Logs. Live Git changes appear in Chat and Changes, and file links open the corresponding Monaco diff beside Chat.

The composer sends follow-up messages through the selected Codex or Antigravity headless adapter in the same worktree. Provider, model and effort apply to the next follow-up; historical run metadata and autonomous pipeline settings remain unchanged. During execution, Stop cancels the current run and a draft stays local until submitted afterward. Text is never silently injected into a running process. Each task keeps separate drafts, events, plans, diffs, view preferences and PTY sessions.

Retry Stage retains successful earlier results. Resume explicitly retries an interrupted stage. Restart Pipeline reuses the same pinned worktree and reruns Antigravity → Codex → Codex; it does not discard changes.

The **Changes** tab includes a directory tree, filtering, rename metadata, per-file statistics, staged/working indicators, Monaco side-by-side and inline modes, unified patches, expanded/collapsed context and read-only file inspection. F7 / Shift-F7 navigate hunks; Alt-Down / Alt-Up navigate files. Final diff compares saved base to the entire current worktree, including uncommitted and untracked content. Discard file/all restores the saved base only after confirmation. **Review** saves local notes on selected lines with version hashes. **Send feedback to Codex** explicitly starts a task-local implementation continuation; notes are never posted on GitHub.

The optional **Terminal** utility dock provide a real xterm.js PTY shell restricted to the task worktree. Close its shell before starting another agent execution in that same task; other tasks can continue. Switching views preserves the process and replays a bounded transcript. Terminal sessions are reconciled after a crash and are not silently restarted.

Manual commands are explicit argv JSON arrays, for example `["npm","test","--","specific.spec.ts"]`. No shell is implicitly invoked. The assigned working directory remains visible. Results include stdout, stderr, duration, exit code and Passed/Failed status; provider-reported skipped tests are separate.

## Automatic PR monitoring

**PR watch** is an inbox with **Needs attention**, **Watching**, **Paused** and **Recently completed** lists. Connecting GitHub discovers all currently open PRs authored by the account, including fork branches targeting other owners’ upstream repositories. Repository catalog, PR metadata and watches persist locally. Sync runs at startup and every five minutes while open; known PRs are confirmed closed/merged before archival.

Every discovered open PR receives one watch by default. Pause survives sync; Resume and Check now are row actions. Toolbar settings control automatic watching, the default interval (1 hour, 2 hours or custom) and optional Codex verification. Manual URL tracking stays under Advanced.

Cheap GitHub inspections run first: conversation and inline comments, review submissions/decisions, unresolved threads, CI status transitions/failures, merge conflicts, head/base commits and merged/closed state. The initial baseline can flag existing failures, conflicts and requested changes. **Unchanged snapshots never invoke a model.** Approvals, own comments, bot messages and routine CI progress use deterministic decisions.

Ambiguous new feedback invokes configured Antigravity analysis and optional Codex verification, returning a strict action decision: `manualActionRequired`, `severity`, `summary`, `reason`, `newActivity`, `recommendedNextAction` and `affectedFiles`. An unlinked PR uses an empty, read-only analysis workspace with GitHub context; it does not clone a repository or create a task. A safely linked task supplies its worktree for deeper inspection. All inference shares task concurrency limits; pipelines take priority, and worktree leases prevent concurrent access. Failed/interrupted inference requires an explicit retry.

Task/PR linking requires a unique match of upstream repository, head fork and branch. **Open task** opens that conversation. Explicit follow-ups include saved review context so “fix the reviewer feedback” can be acted on within the task scope. Reviewer feedback is never implemented automatically. No GitHub write is performed.

Watches, snapshots and attention survive restarts. Monitoring runs **while Vibestar is open**, rather than through an OS service. A linked worktree may differ from the PR head; analysis is told to identify that mismatch instead of silently checking out a different branch.

## Security boundaries

- Renderer: sandboxed Electron, context isolation enabled, Node integration disabled, narrow sender-validated preload IPC, local bundled Monaco assets, restrictive CSP, denied navigation/webviews/new windows.
- Processes: argv arrays, no interpolation into shells, filtered environment, bounded streaming buffers, deadlines, graceful interrupt followed by termination, persisted PID plus process-start identity.
- Files: canonicalized managed paths, traversal and escaping-symlink rejection, editor size limits, confirmation enforced in RPC for destructive operations.
- Agents: required outer bubblewrap mount namespace plus official provider sandboxes. Planning worktrees are read-only; implementation sees only its assigned writable worktree. Other worktrees, personal home files and Windows drives are hidden. Missing isolation blocks execution.
- Provider-owned auth/session directories remain mounted because the official CLI must authenticate and store conversations. Vibestar never reads, deserializes or copies their credentials. This is a trust boundary: an OS mount cannot distinguish provider authentication code from tools running inside that same provider process. Provider security restrictions and prompts remain necessary, and this is not a claim of complete protection against a malicious provider executable.
- SQLite and logs store task context and **redacted** events, not provider OAuth tokens. Authentication PTY output is ephemeral. Raw logs are redacted too.
- Remote access is limited to issue/PR reads, upstream Git fetch, and official inference/authentication. Vibestar never automatically pushes, comments, creates PRs, merges, assigns or closes issues. Model instructions prohibit remote writes; official provider tooling and its auth directory remain trusted.

The window keeps its dark frameless titlebar and native resizing, and its initial size fits the current display. Maximize checks the current display’s work area and retains restore bounds for a geometry fallback. State events drive the icon; titlebar double-click toggles maximize, F11 enters actual fullscreen, and Escape exits it. Fullscreen and maximize/restore are also available through Ctrl+Shift+P. Native Windows keeps native titlebar dragging and avoids WSLg's frameless maximize shadow offset. `npm run test:windows` tests Windows DPI-aware client bounds, restore, fullscreen, resize and real mouse dragging/double-click through the running host; it requires the dev Vite server. The optional WSLg path retains a pointer-driven drag fallback.

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

`npm run test:live` is opt-in and uses your authenticated real provider subscriptions against a small isolated local fixture. It consumes model quota. Normal tests use injectable **test-only** provider fixtures; production has no mock-provider selection. The live slice verified Antigravity planning, Codex refinement, Codex implementation, relevant validation, final diff and Ready for Review with the official CLIs. Live GitHub verification detected the authenticated account, discovered 26 repositories and 5 open authored PRs, inspected watch snapshots and exercised pause/resume. The Oppia issue and proven fork/default-branch inference were verified without executing its migration.

[Verification results](docs/VERIFICATION.md) record the real provider run, tests and packaged-app checks. `docs/screenshots/` holds actual Electron smoke-test captures when that test is run. `ARCHITECTURE.md` explains implementation boundaries. `AGENTS.md` was copied from the local akkco-code instructions.

## Deliberate V1 limits

No automatic upstream rebase, push, PR creation, GitHub comments, merges or issue administration. Updating a pinned base is reserved for a deliberate later action. Provider model slugs and errors remain provider-owned. Binary or larger-than-4-MiB files remain in the changed-file list but are not rendered as editable text. Live event inspection keeps the latest 2,000 events in the UI; raw-log inspection reads the last 1 MiB directly from the complete redacted logs on disk. Application-closed monitoring, signed Windows release distribution, and execution of Windows installer tests require the corresponding external environment or credentials.

Interaction references include Codex, Antigravity, Cursor and T3 Code. This milestone copies no proprietary source/assets or third-party IDE components. Vibestar keeps its own issue/scope/pinned-worktree orchestration and official CLI integrations; it does not adopt remote-account services or provider credential extraction.
