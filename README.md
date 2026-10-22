# akkco vibestar

A local Electron Agent Development Environment for independent open-source contributions. Each whole issue or claimed subtask owns its pinned Git branch, worktree, conversation and sequential Antigravity → Codex planning → Codex implementation pipeline. Existing GitHub PRs have a separate manual analysis and repair workflow: isolated branch preparation, Codex fixes, independent Antigravity review and confirmed publication to the original fork/branch. GitHub access uses the official CLI. Nothing is automatically pushed, posted or merged.

The application uses React, TypeScript, Vite, Tailwind, shadcn-style components and xterm.js. The Node/TypeScript execution core owns SQLite, Git, processes and scheduling inside Linux/WSL. There is no Rust or Tauri dependency.

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
  worktrees/<repository-id>/<scope>/  # independent issue/PR repair checkouts
  logs/<task-or-repair-id>/            # preparation and redacted provider logs
  artifacts/                         # temporary structured-output schemas
  state/vibestar.sqlite              # queue, context, settings and schedules
  cache/                             # disposable utility workspaces
  runtime/                           # Windows-installed WSL helper
  telemetry/                         # local usage exports
```

## Connect providers

Open **Providers** to inspect installation, authentication, current Antigravity model discovery and supported effort values.

**GitHub:** Status uses `gh auth status` and the authenticated account identity. Connect/Reconnect opens the official `gh auth login --hostname github.com --web --git-protocol https` flow in a temporary login dialog. Repository and authored upstream PR discovery runs only when you click Refresh PR List. Vibestar never extracts or stores OAuth tokens.

**Codex:** Connect opens the official `codex login` flow in a temporary PTY dialog that closes when success is detected. Detection uses `codex login status`. Subscription runs explicitly require ChatGPT authentication and remove API-key environment overrides. No API credit purchase or API key is needed for supported subscription operations.

**Antigravity:** Connect opens the installed official interactive `agy` flow in a temporary login dialog; select Done after authentication. Successful authenticated `agy models` discovery marks the provider Connected. Model names and supported efforts come from the official CLI; credentials remain provider-owned.

Settings has separate Agents, GitHub & PR Watch, Repositories, Storage, Usage and Execution sections. Utility AI is independent of the coding pipeline and is used for explicitly requested PR semantic analysis. Every model run is recorded locally, with token counts only when reported by the provider. Codex subscription windows are displayed when its official CLI exposes them; unavailable allowance information is labeled explicitly.

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

The compact IDE shell has a collapsible, resizable repository/task tree, a dominant conversation, optional resizable pipeline context, and a bottom **Changes / Problems / Tests / Terminal / Logs** dock. **Chat / Plan / Usage** are views of the same task. Tasks opens the queue overview; selecting a task opens its workspace. Ctrl+Shift+P opens commands; Ctrl+B toggles the sidebar.

Chat shows actual preparation commands, Antigravity planning, Codex refinement, Codex implementation, validation and final Antigravity review in one continuous conversation. Exact saved prompts are available from every tab and each historical run. Streamed planning drafts appear immediately in Plan and survive a cancelled run. Stop run & use this draft explicitly recovers a schema-valid draft only if the worktree is unchanged, then pauses for plan approval. Structured provider streams become collapsible read/search/command/edit/test events. Prose and structured results render as readable content; raw events stay in Logs. Changed-file counts appear in Chat. The Changes dock displays file-level patches; **Open in VS Code** opens the assigned task worktree for full editor review.

The composer sends follow-up messages through the selected Codex or Antigravity headless adapter in the same worktree. Provider, model and effort apply to the next follow-up; historical run metadata and saved pipeline settings remain unchanged. During execution, Stop cancels the current run and a draft stays local until submitted afterward. Text is never silently injected into a running process. Each task keeps separate drafts, events, plans, diffs, view preferences and PTY sessions.

Retry Stage retains successful earlier results. Resume explicitly retries an interrupted stage. Restart Pipeline reuses the same pinned worktree and reruns planning; it does not discard changes. Each completed plan pauses for explicit approval. After implementation and validation, review the task worktree in VS Code before starting Antigravity’s final review/tests, then inspect the final report before finalizing. Required checks that cannot run are reported, never counted as passing.

**Open in VS Code** is the prominent task-header action. Its adjacent menu offers other detected editors or Open folder/Copy path. The source checkout is never opened by a task editor action. Review plans in Vibestar; inspect code and diffs in the editor. Each approval gate opens an explicit review prompt and stays paused until you approve. Existing ready tasks from the older flow pause for implementation review before the new final Antigravity stage.

Task sandboxes reuse ignored source dependencies read-only and honor the checkout's selected Python virtualenv/.python-version. A sibling project toolchain named `<checkout-folder>_tools`, such as Oppia's `oppia_tools`, is exposed read-only at the corresponding task-parent path. Tests shows the selected runtime. Skipped or blocked checks remain unverified; no missing dependencies are installed automatically. External editor terminals use their own environment; source dependency mounts are limited to agent/task-terminal execution.

The optional **Terminal** utility dock provide a real xterm.js PTY shell restricted to the task worktree. Close its shell before starting another agent execution in that same task; other tasks can continue. Switching views preserves the process and replays a bounded transcript. Terminal sessions are reconciled after a crash and are not silently restarted.

Manual commands are explicit argv JSON arrays, for example `["npm","test","--","specific.spec.ts"]`. No shell is implicitly invoked. The assigned working directory remains visible. Results include stdout, stderr, duration, exit code and Passed/Failed status; provider-reported skipped tests are separate.

## Manual PR review analysis

PR review is manual only. Startup, authentication, opening the inbox, tracking and GitHub metadata synchronization never invoke PR-analysis models. Legacy enabled watches are disabled on upgrade while their snapshots, conversations, decisions, provider logs and usage remain available. The existing issue queue and recovery behavior are preserved.

1. **Refresh PR List** retrieves authored PR metadata through official gh; no inference or tracking starts.
2. **Track PR** saves a PR from the list or a pasted GitHub URL. It does not start inspection or a timer.
3. **Analyze PR / Analyze Again** retrieves fresh complete discussion/context and invokes the displayed Utility AI provider/model/effort only when semantic classification is needed. Cancellation and errors require an explicit new request; restart never retries PR analysis.
4. **Review report** shows PR/fork/head/base identity, complete original Markdown reviews/replies, independently tracked observations, unanswered questions, response evidence, positive feedback, checks, patches and analysis history. Replies, commits, dismissed reviews and resolved threads do not prove code correctness.

An unchanged complete report can be reused without AI; simple acknowledgments and author/bot-only activity also use GitHub inspection only. Every actual invocation uses the existing AgentRunner, read-only utility sandbox, saved prompt/redacted logs and ai_usage. Missing token or subscription information stays unavailable. Long comments are preserved in bounded context packets with explicit per-source coverage. API limits, missing context and partial model coverage are shown; the app never claims every request was assessed when coverage is incomplete.

### Solve an existing PR review

1. Complete **Analyze PR**, then click **Solve Review**. Select source-linked observations, add instructions and explicitly choose a connected upstream checkout or use the existing local connection/managed-clone controls. A manually created PR needs no Vibestar issue task.
2. Confirm the displayed Codex and Antigravity model/effort settings. Vibestar verifies the immutable upstream/fork/PR identity and current head, creates its own repair branch/worktree and merges the actual latest PR base into that branch. Your source checkout and issue worktrees stay untouched.
3. Codex implements the selected concerns and executes applicable checks. Antigravity independently reviews the changes with read-only source access. The repair stops at **Manual Review Required**. Original comments, per-item findings, actual command exits, reported tests, logs, usage and the three diff layers remain available.
4. Review the files in **Changes** or open the exact repair worktree in your editor. **Request Further Fix** explicitly repeats Codex → Antigravity in the same worktree, retaining earlier history. A blocked check remains unverified.
5. **Commit Locally** approves the current reviewed content and creates a local-only commit, including when you lack remote push permission. **Keep Local** retains the workspace. **Approve and Prepare Push** opens a separate publication dialog with the exact fork/ref, expected remote SHA, local head, changes and validation. Commit there if necessary, then explicitly **Confirm Push**.
6. Publication checks the open PR, identity, permission, remote freshness, approved fingerprint and ancestry again. It uses a normal fast-forward push to the original PR branch. The resulting SHA and publication history are saved; **Analyze PR Again** remains a separate click.

Conflicts preserve the worktree and staged conflict state. Resolve and stage them in the editor, then explicitly resume preparation. A stale remote head stops the session for fresh analysis. Cancellation/restart preserve checkpoints and never replay inference or pushes; an uncertain push must first be reconciled by a read-only remote check. Clean owned worktrees can be removed explicitly while retaining repair history.

[PR repair implementation and manual test guide](docs/PR-REPAIR-SYSTEM.md) covers the contracts, safeguards and verification evidence. [Milestone checklist](docs/IDE-HARNESS-PR-REVIEW-PLAN.md) records the complete five-milestone delivery.

## Security boundaries

- Host Git uses inspected local/worktree configuration, suppresses system/global executable settings, binds managed network operations to GitHub HTTPS and delegates authentication to official gh. Unsupported local includes, filters, drivers, helpers and rewrites receive an actionable refusal; source/global configuration is not edited. New managed clones use full objects. Existing partial clones need Git 2.45 or newer; implicit object downloads are disabled.
- Managed category/repository/worktree aliases are refused. Issue review uses versioned content fingerprints; pending legacy reviews/drafts without comparable integrity evidence require explicit fresh review/planning. Saved completed history remains available.
- Renderer: sandboxed Electron, context isolation enabled, Node integration disabled, narrow sender-validated preload IPC, restrictive CSP, denied navigation/webviews/new windows.
- Processes: argv arrays, no interpolation into shells, filtered environment, bounded streaming buffers, deadlines, graceful interrupt followed by termination, persisted PID plus process-start identity.
- Files: canonicalized managed paths, traversal and escaping-symlink rejection, editor size limits, confirmation enforced in RPC for destructive operations.
- Agents: required outer bubblewrap mount namespace plus official provider sandboxes. Planning worktrees are read-only; implementation sees only its assigned writable worktree. Other worktrees, personal home files and Windows drives are hidden. Missing isolation blocks execution.
- Provider-owned auth/session directories remain mounted because the official CLI must authenticate and store conversations. Vibestar never reads, deserializes or copies their credentials. This is a trust boundary: an OS mount cannot distinguish provider authentication code from tools running inside that same provider process. Provider security restrictions and prompts remain necessary, and this is not a claim of complete protection against a malicious provider executable.
- SQLite and logs store task context and **redacted** events, not provider OAuth tokens. Authentication PTY output is ephemeral. Raw logs are redacted too.
- PTY redaction retains bounded recognition state across chunks before output reaches events, snapshots or logs. Output and pending writes have explicit limits; redaction remains best effort. Corrupt SQLite records retain their source bytes and appear in Settings diagnostics while unrelated history remains readable. Unsafe operations on corrupt ownership records are blocked.
- Issue-task submissions use durable request identities. Retrying the same submission returns its original task; reusing an identity with different content is refused. Worktree cleanup requires ownership evidence, a clean index/worktree and the expected branch SHA.
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
npm run test:desktop:repair
npm run desktop:build
```

`npm run test:live` is opt-in and uses your authenticated real provider subscriptions against a small isolated local fixture. It consumes model quota. Normal tests use injectable **test-only** provider fixtures; production has no mock-provider selection. The earlier live slice verified the previous autonomous pipeline with the official CLIs. The current approval workflow is verified with fixtures without consuming provider quota. Live GitHub verification detected the authenticated account, discovered 26 repositories and 5 open authored PRs, inspected watch snapshots and exercised pause/resume. The Oppia issue and proven fork/default-branch inference were verified without executing its migration.

[Verification results](docs/VERIFICATION.md) record the real provider run, tests and packaged-app checks. `docs/screenshots/` holds actual Electron smoke-test captures when that test is run. `ARCHITECTURE.md` explains implementation boundaries. `AGENTS.md` was copied from the local akkco-code instructions.

## Deliberate V1 limits

No automatic upstream rebase, push, PR creation, GitHub comments, PR merges or issue administration. Issue-task bases stay pinned; explicit PR repair preparation integrates its current base in a separate branch. Provider model slugs and errors remain provider-owned. Binary or larger-than-4-MiB files remain in the changed-file list but are not rendered as editable text. The output browser pages persisted events and redacted stdout/stderr, with full-file search; legacy tail reads stay bounded. Repair requires a complete saved analysis, a connected upstream checkout and available dependencies. Application-closed monitoring, signed Windows release distribution and Windows installer execution require the corresponding external environment or credentials.

Interaction references include Codex, Antigravity, Cursor and T3 Code. This milestone copies no proprietary source/assets or third-party IDE components. Vibestar keeps its own issue/scope/pinned-worktree orchestration and official CLI integrations; it does not adopt remote-account services or provider credential extraction.
