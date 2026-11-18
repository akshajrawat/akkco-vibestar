# Architecture

Vibestar separates the desktop interface from the local authority that owns processes, Git,
workspaces and saved state. This page is a map of those boundaries; operational and compatibility
details live in the linked guides.

## System overview

```mermaid
flowchart LR
  UI[React renderer] --> Preload[Isolated Electron preload]
  Preload --> Main[Electron main process]
  Main <-->|Validated JSON lines over stdio| Core[Node core in Linux or WSL]
  Core --> DB[(SQLite)]
  Core --> Git[Owned workspaces and worktrees]
  Core --> Sandbox[Execution sandbox]
  Sandbox --> CLI[Official provider CLIs]
  Core --> GH[Official gh client]
```

On Linux, Electron and the Node core run on the host. On Windows, Electron presents the desktop and
starts the core inside a selected WSL distribution. Git, provider tools, SQLite and task data remain
in Linux. The application uses a narrow stdio bridge rather than an application HTTP server.

## Runtime boundaries

The React renderer presents saved and observed state. It has no Node integration. Electron keeps
context isolation and Chromium sandboxing enabled. The preload exposes a typed API; the main process
validates the sender and forwards requests to the core. Compatibility negotiation prevents a newer
renderer from sending unsupported mutations to an older WSL helper.

The core validates each request and owns database access, filesystem operations, Git, process
lifecycles and provider invocation. Repository content, issue text and model output provide context;
they do not grant permission to mutate host data. Core-managed provider and verification commands
run inside the required sandbox. The user-operated terminal runs with the user's Linux/WSL
permissions after workspace ownership checks. See the [security guide](docs/security.md).

## Module ownership

| Area                                                 | Responsibility                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/electron/`                                     | Desktop lifecycle, isolated preload, stdio bridge and platform contracts     |
| `apps/desktop/app/`                                  | Navigation, desktop composition and global actions                           |
| `apps/desktop/features/`                             | Feature-owned UI: Vibers, Sessions, Computer, Settings, Usage                |
| `apps/desktop/components/` and `apps/desktop/hooks/` | Reusable controls and hooks shared across features                           |
| `apps/core/rpc/`                                     | Validated domain requests; `apps/core/rpc.ts` composes services and dispatch |
| `apps/core/vibers/`                                  | Viber profiles, appearance, sessions, message store and continuity           |
| `apps/core/computers/`                               | Isolated Viber execution environments, containers and home volumes           |
| `apps/core/execution/`                               | Agent runner, providers (Codex, Antigravity), sandbox, output and usage      |
| `apps/core/workspace/`                               | Git operations, path ownership, worktrees and runtime mounts                 |
| `apps/core/storage/`                                 | SQLite lifecycle, migrations, recovery, inspection and cleanups              |
| `tests/`                                             | Unit, domain, integration, security, terminal and live coverage              |

Feature-specific code belongs with its owner. Shared renderer primitives stay under `apps/desktop/components`
and ordered CSS chapters under `apps/desktop/styles/`. Detailed folder and check ownership is documented in
the [contributor guide](CONTRIBUTING.md) and [testing guide](docs/testing.md).

## Workspace overlays

Settings opens independently of page navigation in the shared `WorkspaceOverlay`. The native modal
keeps the current task/workflow mounted and makes the underlying interface inert, contains keyboard
focus and restores the opener on close. Select popovers use the modal's portal target so they remain
interactive in its top layer. Workspace shortcuts cannot run through the overlay.

Settings owns one long-lived autosave queue for core settings and another for desktop configuration,
including while the overlay is closed. Serialized field patches roll failures back to acknowledged
values without replaying a failed field in another setting's save. Changing the setting again
creates a new serialized save.
Visited panels retain local form values and scroll positions while the overlay is open. Desktop
configuration changes require native confirmation; the core atomically refuses restart when activity
exists and closes admission before stopping. Providers, Repositories and Storage reuse their existing
feature and guarded service boundaries.

One root `react-hot-toast` Toaster renders through `apps/desktop/lib/notifications.tsx`. It follows the active
native modal's top layer without stealing focus. The saved notification preference filters optional
messages; errors, required input, blocking warnings and essential runtime installation progress remain
visible. A display-only cache of the acknowledged preference covers startup before the core connects;
the core remains authoritative. Runtime status is cached by Electron so a renderer arriving after startup can display the
current stage. The existing WSL installer runs before helper loading only when bundled bytes, the
locked dependency manifest or native ABI/dependencies need recovery. It acquires the existing core
ownership lock and refuses runtime aliases. Custom helper paths remain user-managed. Retry probes
again; explicit Repair Runtime can reinstall. Linux launches bypass this WSL setup path.

Retired global Utility AI and Review AI fields are stripped when reading settings and disappear on the
next settings save; reads preserve original saved bytes. Historical analysis configurations and
`utility_ai` method labels remain readable. Current utility execution requires an operation-owned
configuration. Existing PR controls select a provider/model per operation and default to the provider
CLI; they no longer read a global model setting. No historical run is rewritten or replayed.

## Viber architecture and sessions

Vibestar is built entirely around persistent AI employees called **Vibers**:

- **Viber identities & profiles**: Each Viber possesses a name, appearance avatar, description, default system instructions, and execution defaults. Built-in profiles and custom user-created Vibers are stored in `agent_profiles`.
- **Sessions & workspaces**: A Viber owns multiple independent sessions. Each session has its own workspace (either an isolated Git worktree or managed scratch workspace) and native conversation continuity.
- **Dedicated Computers**: A Viber can have an associated persistent Computer environment (`viber_computers`) with dedicated container isolation, sandboxed tool execution, and private home volume persistence.
- **Provider threads & BYOS**: Native thread continuity is maintained per session across application restarts with official Codex or Antigravity providers. Dynamic per-turn model and reasoning effort selection allow flexible execution.

## Persistence, verification and recovery

SQLite migrations (migration 42) safely pruned all obsolete Task, Graph Workflow, Issue Watch, and PR Watch tables and indices while preserving all Viber identities, appearances, sessions, messages, native threads, and usage records.

Data-root migration, backup procedures, and workspace isolation enforce strict ownership boundaries so user files and repositories are never silently deleted.

## Maintainer guides

- [Security boundaries](docs/security.md)
- [Development and platform setup](docs/development.md)
- [Testing Guide](docs/testing.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](docs/third-party-notices.md)
