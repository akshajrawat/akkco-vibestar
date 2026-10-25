# akkco vibestar

[Workflow-first IDE V3](docs/WORKFLOW-FIRST-IDE-V3.md) separates task creation,
repository conversation and implementation authorization. **Create task** opens
an idle chat without running a model or reserving an execution slot. Ask read-only
questions, then choose **Start workflow** in the right sidebar. Only selected chat
instructions or your reviewed summary reach the pipeline. Existing approvals and
Verification V2 remain in force.

**Checks** starts with a concise evidence summary. **Git Finalization** guides you
through Files → Commit → Publish → Confirm. Task management separates Archive,
history removal while preserving work, and an ownership-verified discard preview.
The PR inbox discovers authored history through explicit GitHub refresh and adds
bounded **Analyze All** with a visible AI cap. Issue Watch accepts pasted/dropped
GitHub label links as exact label chips; saving a watch never scans.

[Pipeline verification V2](docs/PIPELINE-VERIFICATION-V2.md) adds distinct saved-evidence
rechecks, executable missing checks, explicit Codex fixes and independently reviewed
environmental gaps. Code approval with incomplete verification stays local and
cannot bypass Git Finalization. The compact timeline and neutral task navigation
show actual execution and approval states. Settings → Storage → **Reset Local Test
Workspace** previews exact removals and creates a validated backup while preserving
dirty/unpushed work, repositories, settings and provider authentication.
New tasks require repository automated tests and explicit issue checks. Extra manual
browser checks are optional; existing tasks can select **Skip extra manual browser
checks** in Checks. This preserves real test failures, the independent review and
Git publishing confirmations. A saved-evidence recheck also recovers missing
Antigravity tool exits and preserves an unchanged accepted review.
[Current verification and screenshot evidence](docs/VERIFICATION.md) records the
V2 regression matrix, fixture-only inference and retained local-data limitations.
If a required check has no saved command or its prerequisites are unavailable,
**Prepare missing checks** explains what is missing and offers browser diagnostics
and an explicitly authorized Codex preparation step. **Run missing checks** appears
when a supported recorded command is ready. Rechecking saved evidence evaluates
existing results and diff hygiene; it does not create tests or install tooling.

The [premium workspace and Git Finalization delivery](docs/PREMIUM-UX-GIT-FINALIZATION.md)
adds a cohesive charcoal interface, bundled Geist typography, GitHub-first PR inbox,
clearer verification and local usage charts. Ordinary tasks support reviewed file
selection, exact commit messages, typed hook presets, separately confirmed guarded
publication and durable history/recovery. Its October 24 verification history
records 491 passing normal tests, seven built Electron fixtures and native Windows
window checks at 125%/150% DPI. Pushes and pull requests run the GitHub CI workflow.

The [chat-first workspace milestone](docs/CHAT-FIRST-WORKSPACE.md) is implemented and verified. Validation distinguishes tooling blockers from failing checks, and the shared task/repair shell keeps chat central with a collapsible engineering sidebar and a secondary Terminal / Problems dock. Saved-instruction choices, the shared expanding composer/model picker and numbered unified/split diff review are available. Existing reports remain readable; ambiguous historical failures are not rewritten as successes.

A local Electron Agent Development Environment for independent open-source contributions. Each whole issue or claimed subtask owns its pinned Git branch, worktree, conversation and sequential Antigravity → Codex planning → Codex implementation pipeline. Existing GitHub PRs have a separate manual analysis and repair workflow: isolated branch preparation, Codex fixes, independent Antigravity review and confirmed publication to the original fork/branch. GitHub access uses the official CLI. Nothing is automatically pushed, posted or merged.

The application uses React, TypeScript, Vite, Tailwind, shadcn-style components and xterm.js. The Node/TypeScript execution core owns SQLite, Git, processes and scheduling inside Linux/WSL. There is no Rust or Tauri dependency.

**Issue Watch** adds saved GitHub contribution searches with explicit **Scan Now**, current tracker/claim evidence, one bounded Codex screening invocation and persistent results/history/usage. Saving or opening a watch starts no scan. See the [Issue Watch guide](docs/ISSUE-WATCH.md) for the Oppia example, outcome meanings and verification commands. Antigravity is accurately unsupported for this new workflow; existing adapters remain available.

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

In **Settings → Agents**, configure each of the four pipeline stages: Antigravity
planning, Codex refinement, Codex implementation and Antigravity final review.
Each stage has its own model, effort and deadline controls. Older settings fall
back to the planning configuration for final review until you change it; existing
tasks retain their saved settings. Empty model uses the official CLI default.
Antigravity models come from `agy models`; effort suffixes must match the selected
effort. Rejected Codex models/efforts are reported without silent substitution.

Codex uses its verified `exec` structured-output interface, read-only planning and workspace-write implementation. Antigravity uses its verified headless plan-mode and stream-json interface. Neither adapter uses a dangerous permission bypass flag. Provider sessions are recorded when exposed; follow-ups reconstruct saved context as a fresh run rather than pretending to resume an unsupported session.

## Repository and task setup

**Repositories** shows active local connections first, discovered candidates second, and a searchable GitHub **All** catalog. There are no Recent/Owned/Forks tabs or advanced Git URL form. Discovery is optional and never activates a repository automatically.

1. Choose **Connect local repository**, select **WSL** or **Windows**, and enter the checkout path (for example `/home/aksha/oppia` or `D:\projects\my-repo`). **Verify repository** shows the canonical execution path, remotes, GitHub identities, current branch and available base branches. Confirm the upstream, fork and base, then **Connect repository**. No scan, clone or fetch is needed for this connection.
2. Choose **New task** and select an active **Repository**. Paste an issue URL, such as `https://github.com/oppia/oppia/issues/26831`. A unique matching active checkout is visibly suggested; an explicit mismatched selection blocks creation. Vibestar fetches the issue preview from GitHub using the selected repository ID.
3. Choose **Entire issue** or **Specific part / claimed subtask**, add instructions and inspect the repository. Expand **Agent configuration** if needed, then **Create task**. The new task stays **not started**, including after reopening Vibestar.
4. Ask repository questions through **Question · read-only**. An explicit question may prepare an isolated worktree for reading; it does not start planning or implementation. Use **Save for later** for instructions you want to retain without a model run.
5. Review future stage models in **Workflow**. Optionally select completed chat messages or write a reviewed summary, then choose **Start workflow**. Repeated delivery of that start request cannot start a second pipeline.

GitHub catalog entries offer **Find local checkout**. If no candidate is found, **Create Vibestar-managed clone** explicitly confirms a download under the data root. Imported and managed ownership are labeled. **Disconnect** removes a repository from the active selector but keeps source files, branches, task history and worktrees. Verify/reconnect an imported checkout to use its existing ID again.

The SQLite migration preserves existing V1 tasks as partial tasks. Whole issue tasks have explicit `scope_mode: "whole_issue"` and an empty claimed scope; all three prompts receive whole issue semantics. No misleading claimed-scope string substitutes for this distinction.

For an imported Oppia checkout, verification reads `origin` as `akshajrawat/oppia`, `upstream` as `oppia/oppia`, and the remote HEAD as `develop`. The source checkout can remain on its own feature branch. Multiple checkout paths for the same upstream have separate registry IDs; task creation uses exactly the selected ID.

An explicitly started workflow fetches upstream under a repository lock, saves the exact base SHA and creates a fresh isolated branch/worktree. Imported checkouts supply Git object storage; agents execute only in their task worktree. After final acceptance, **Git Finalization** offers reviewed file selection, an exact message editor, local commits and separately confirmed publication. Ready and completed tasks retain this action. The source checkout's branch, index and working files remain unchanged. Duplicate branches receive deterministic suffixes; existing task bases remain pinned.

## Task workspace

Chat is the permanent task workspace. The collapsible right sidebar selects **Workflow / Plans / Changes / Checks / Final review / Usage / Run details / Raw logs**; its selected tool, width and scroll position persist per conversation. Expand a tool for focused review, then return to the same chat, draft and selected file. Smaller windows use a dismissible drawer. The bottom **Terminal / Problems** dock starts hidden. Ctrl+Shift+P opens commands, Ctrl+B toggles navigation, and Ctrl+backtick or Ctrl+J toggles the dock.

Chat shows actual preparation commands, Antigravity planning, Codex refinement, Codex implementation, validation and final review in one conversation. The compact activity strip opens the actual run in Run details. Plans selects the original or refined artifact, with comparison available in the expanded tool; streamed drafts remain recoverable after cancellation under the existing schema/fingerprint checks. Readable tool calls and results remain in chat. Raw logs retains redacted stdout/stderr, structured events, saved prompts and historical search. Changes provides searchable tree/flat files, status/statistics, content-bound reviewed marks and focused numbered unified/split review with lexical syntax colors, folded context and explicit binary/large-file states. Repair keeps its three diff baselines separate. **Open in VS Code** opens the assigned task worktree.

The composer defaults to read-only questions through the selected Codex or Antigravity adapter. After workflow startup, choose Request code changes to explicitly authorize a code-changing follow-up in the task worktree. Provider, model and effort apply to the next follow-up; historical run metadata and saved pipeline settings remain unchanged. During execution, Stop cancels the current run. Unsent drafts stay local; explicitly sending feedback queues it for the next safe stage boundary. Save for later persists an instruction without starting an agent. Text is never silently injected into a running process. Each conversation keeps separate drafts, context chips, model selections and layout preferences. The context picker previews bounded snapshots from validated worktree files, changed paths, selected file diffs, saved plans/scopes, incomplete checks and text notes. Task approval explicitly chooses whether saved pending instructions stay saved or reach the next configured stage; unrelated unsent drafts are retained. Repair saves are labelled local, and repair sending retains its approved Codex → Antigravity sequence. Future task stage models can be edited from Workflow only while idle and before the stage has ever started.

Retry Stage retains successful earlier results. Resume explicitly retries an interrupted stage. Restart Pipeline reuses the same pinned worktree and reruns planning; it does not discard changes. Each completed plan pauses for explicit approval. After implementation and validation, review the task worktree in VS Code before starting Antigravity’s final review/tests, then inspect the final report before finalizing. Required checks that cannot run are reported, never counted as passing.

Verification recovery offers **Recheck saved evidence** (diff hygiene and recorded
outcomes, no AI), **Run missing checks** (previewed supported recorded argv, no
installer), and **Fix with Codex** (one explicitly authorized iteration in the same
worktree with exact failure evidence). Environmental gaps offer **Continue to
independent review**, with an implementation review and explicit acknowledgment
bound to current contents/evidence. Genuine failures and ambiguous legacy evidence
cannot use this path. Antigravity receives a read-only evidence packet, executes
feasible checks and reports code findings separately from test coverage. Accepting
code with gaps enters **reviewed with gaps**; publishing stays blocked until required
verification completes. No model starts automatically at any approval boundary.

**Open in VS Code** is the prominent task-header action. Its adjacent menu offers other detected editors or Open folder/Copy path. The source checkout is never opened by a task editor action. Approval controls stay beside the composer and open the relevant saved artifact without automatic blocking dialogs. Task status belongs in navigation. Right-click a task, use its actions button, or press Shift+F10 for Open, editor, copy, Archive/Unarchive and confirmed cleanup. Workflow contains safe retry/finalization actions. No next stage starts without its existing explicit backend approval.

Task sandboxes reuse ignored source dependencies read-only and honor the checkout's selected Python virtualenv/.python-version. A sibling project toolchain named `<checkout-folder>_tools`, such as Oppia's `oppia_tools`, is exposed read-only at the corresponding task-parent path. Checks shows the selected runtime under Advanced evidence and tools. Skipped or blocked checks remain unverified; no missing dependencies are installed automatically. External editor terminals use their own environment; source dependency mounts are limited to agent/task-terminal execution.

The optional **Terminal** utility dock provide a real xterm.js PTY shell restricted to the task worktree. Close its shell before starting another agent execution in that same task; other tasks can continue. Switching views preserves the process and replays a bounded transcript. Terminal sessions are reconciled after a crash and are not silently restarted.

Manual commands are explicit argv JSON arrays, for example `["npm","test","--","specific.spec.ts"]`. No shell is implicitly invoked. The assigned working directory remains visible. Results include stdout, stderr, duration, exit code and Passed/Failed status; provider-reported skipped tests are separate.

## Git Finalization

1. **Files:** inspect the changed files and select their complete contents. Unsafe paths/content are excluded; ignored files are never included automatically. **Prepare staged preview** copies only selected literal paths into an owned review worktree/index. A subset needs an explicit fresh Antigravity review.
2. **Commit:** type an **Exact commit message**. It starts empty, supports multiple lines and retains a local draft. **Use original issue text** is optional. Normal commit is the default; optional hook skipping is under Advanced commit options.
3. **Publish:** choose the destination repository/branch and a saved preset: **Standard**, **Local only**, **Normal commit + no-verify push**, or custom hook options. Normal push is the default. If a fork is missing, **Connect Fork** opens the verified local connection flow; local commits remain available.
4. **Confirm:** review the selected files, exact message and operation summary, explicitly approve and create the local commit. Publication then requires a live destination check and a separate push confirmation bound to the contribution repository, remote, branch, account, local commit and expected remote SHA. A changed destination requires another check and confirmation.

Skipping optional hooks never skips Vibestar's authorization, required verification,
review, ancestry, destination or remote-SHA checks. Actual commands, output and
recovery/history remain under **Saved operation log and recovery**.

The task's unrelated staged content is preserved. Selecting a file with staged hunks requires an explicit choice to use its complete reviewed contents. Existing task commits are included in publication and cannot be silently omitted. Messages retain exact UTF-8 contents, including trailing spaces and absence of a final newline. There is no generated title or trailer.

The host proves fast-forward ancestry and binds publication atomically to the exact remote SHA. It permits creation of an explicitly confirmed absent feature branch; it never permits a non-fast-forward update. A preset cannot authorize publication. Cancelled or disconnected pushes are reconciled against the actual remote before retry. Real redacted output, exits and saved history are available in the dialog. Explicit preview removal keeps the task branch/local commit and is required before deleting its task history.

Publication requires the configured contribution fork and current GitHub write permission. It does not create a PR. Existing PR repairs retain their verified PR head destination and separate approval flow. See [the delivery and contract record](docs/PREMIUM-UX-GIT-FINALIZATION.md).

## Browser verification environment

Checks → Advanced evidence and tools includes a collapsed **Browser verification environment** panel. Opening it runs nothing. An explicit **Use environment** choice can expose installed Playwright browser caches and Chrome read-only for manual verification; provider-internal sandboxes remain separate. **Inspect browser environment** reports installed tooling, DNS, loopback socket support and separate direct-file/HTTP fixture capability without downloading packages or starting a model. It never changes application verification results or waives a required check.

The installed-toolchain fixture runs with `npm run test:browser:environment` and uses disposable worktrees. Saved diagnostics identify their environment and timestamp.

## PR batch analysis

**Analyze All** starts with a selection, scope, verified reusable-report count,
utility model/effort and maximum AI authorization. Defaults are five selected PRs
and five AI attempts; the hard selection and allowance bounds are 20. Each PR is
refreshed again before analysis, and unchanged reports consume no model invocation.
Cancel keeps completed results; reopening never resumes an interrupted batch.

## Task disposal

The task context menu offers **Manage task**. Archive keeps everything. **Remove
task history, preserve work** removes conversation/run/log/plan history and keeps
the files, branch and an archived ownership record. Dependent records stay linked.
That ownership record cannot restart implementation.

**Discard task and delete** first verifies ownership and previews modified,
untracked and ignored paths, locally unpublished commits and dependencies. Confirm
the exact preview to remove the task-owned worktree, eligible branch and history.
Unique commits require a separate acknowledgment. Changed contents, unknown owners,
symlinks, active agents/terminals, pending merges, hidden index flags and unresolved
finalization/repair dependencies stop the operation with a reason. Imported source
checkouts and unrelated worktrees/branches are preserved. Ordinary cleanup remains
conservative. Never use this feature on work you intend to retain without reviewing
the preview.

## Manual PR review analysis

PR review is manual only. Startup, authentication, opening the inbox, tracking and GitHub metadata synchronization never invoke PR-analysis models. Legacy enabled watches are disabled on upgrade while their snapshots, conversations, decisions, provider logs and usage remain available. The existing issue queue and recovery behavior are preserved.

1. **Refresh PR List** retrieves authored PR metadata through official gh, including closed/merged history, and creates inactive local review identities. It never starts inference.
2. Open a discovered PR to view its saved metadata and existing inactive review record. It does not start inspection or a timer; the main page has no URL/Track form.
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
- Issue-task submissions use durable request identities. Retrying the same submission returns its original task; reusing an identity with different content is refused. Ordinary worktree cleanup requires ownership evidence, a clean index/worktree and the expected branch SHA. Deliberate discard requires a fresh content-bound preview and explicit loss confirmation, retaining ownership, Git-operation and dependency guards.
- Remote access is limited to issue/PR reads, upstream Git fetch, and official inference/authentication. Vibestar never automatically pushes, comments, creates PRs, merges, assigns or closes issues. Model instructions prohibit remote writes; official provider tooling and its auth directory remain trusted.

The window keeps its dark frameless titlebar and native resizing, and its initial size fits the current display. Maximize checks the current display’s work area and retains restore bounds for a geometry fallback. State events drive the icon; titlebar double-click toggles maximize, F11 enters actual fullscreen, and Escape exits it. Fullscreen and maximize/restore are also available through Ctrl+Shift+P. Native Windows keeps native titlebar dragging and avoids WSLg's frameless maximize shadow offset. `npm run test:windows` tests Windows DPI-aware client bounds, restore, fullscreen, resize and real mouse dragging/double-click through the running host; it requires the dev Vite server. The optional WSLg path retains a pointer-driven drag fallback.

## Verification

GitHub Actions runs [CI](.github/workflows/ci.yml) on every push and pull request,
and supports manual runs from the Actions tab. It installs Node.js 22 and the Linux
sandbox/build dependencies, then checks formatting, lint, types, the normal test
suite, integration tests, real PTY tests and the production build. Live-provider,
real GitHub publication and desktop opt-ins remain separate local checks.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:tui
npm run build
npm run test:desktop:watch
npm run test:desktop:output
npm run test:desktop:git
npm run test:desktop:pr
npm run test:desktop:repair
npm run desktop:build
```

`npm run test:live` is opt-in and uses your authenticated real provider subscriptions against a small isolated local fixture. It consumes model quota. Normal tests use injectable **test-only** provider fixtures; production has no mock-provider selection. The earlier live slice verified the previous autonomous pipeline with the official CLIs. The current approval workflow is verified with fixtures without consuming provider quota. Live GitHub verification detected the authenticated account, discovered 26 repositories and 5 open authored PRs, inspected watch snapshots and exercised pause/resume. The Oppia issue and proven fork/default-branch inference were verified without executing its migration.

[Security and Issue Watch delivery](docs/ISSUE-WATCH-DELIVERY.md) records the S1–S5 changes, migrations, compatibility and limits. [Verification results](docs/VERIFICATION.md) record the real provider run, tests and packaged-app checks. `docs/screenshots/` holds actual Electron smoke-test captures when that test is run. `ARCHITECTURE.md` explains implementation boundaries. `AGENTS.md` was copied from the local akkco-code instructions.

## Deliberate V1 limits

No automatic upstream rebase, push, PR creation, GitHub comments, PR merges or issue administration. Issue-task bases stay pinned; explicit PR repair preparation integrates its current base in a separate branch. Provider model slugs and errors remain provider-owned. Binary or larger-than-4-MiB files remain in the changed-file list but are not rendered as editable text. The output browser pages persisted events and redacted stdout/stderr, with full-file search; legacy tail reads stay bounded. Repair requires a complete saved analysis, a connected upstream checkout and available dependencies. Application-closed monitoring, signed Windows release distribution and Windows installer execution require the corresponding external environment or credentials.

Interaction references include Codex, Antigravity, Cursor and T3 Code. This milestone copies no proprietary source/assets or third-party IDE components. Vibestar keeps its own issue/scope/pinned-worktree orchestration and official CLI integrations; it does not adopt remote-account services or provider credential extraction.
