# Akkco Vibestar

A local desktop workspace for open-source contribution tasks and pull-request repairs.
Vibestar uses isolated Git worktrees, official provider CLIs, explicit review gates,
and recorded verification evidence. It does not automatically publish work.

This project is pre-stable. This repository preparation milestone is not an official release.

![Vibestar conversation workspace](docs/screenshots/chat.png)

Screenshots use isolated fixture data.

More previews: [task overview](docs/screenshots/overview.png),
[PR inbox](docs/screenshots/pr-inbox.png), [repositories](docs/screenshots/repositories.png).

## What it does

- Creates idle issue tasks with optional read-only repository conversations.
- Runs an explicitly started Antigravity → Codex planning → Codex implementation →
  independent Antigravity review workflow, with human approval between stages.
- Keeps each task's pinned base, files, conversation, command evidence and usage separate.
- Discovers authored GitHub PRs and supports manual analysis and isolated review repairs.
- Saves Issue Watch topics in a full-width list. Open a topic for claim status,
  one-click GitHub links, search, and newest/oldest/update sorting. Scans run only
  when requested; incomplete evidence stays uncertain.
- Reviews selected files from Changes and provides Git Changes for exact commits
  and confirmed pushes to a verified writable repository or contribution fork.
- Shows actual provider output, verification gaps and reported usage without inventing results.

## Architecture

React runs in a sandboxed Electron renderer. A narrow preload bridge sends requests
and events to a Node execution core over standard input/output. Linux runs the core
directly; native Windows runs it inside WSL. SQLite stores local state.

The core owns processes, provider invocation, filesystem access, Git operations and
publication authorization. See [ARCHITECTURE.md](ARCHITECTURE.md) for module ownership
and [the security guide](docs/security.md) for trust boundaries.

## Prerequisites

- Linux desktop, or Windows with WSL2 and a Linux execution distribution.
- Node.js 22.12 or newer and npm 10 or newer.
- Git, official `gh`, `codex` and `agy` CLIs in the execution environment.
- Bubblewrap with working unprivileged namespaces. Missing isolation blocks execution.
- Python 3 and a C/C++ build toolchain if native SQLite/PTY binaries need compilation.
- A graphical desktop and the system libraries required by Electron.

Authenticate provider CLIs through their official login flows. Routine tests use
fixtures and do not require provider subscriptions. Advanced Linux and Windows setup
is covered in [development](docs/development.md).

## Quick start

From your checkout:

```bash
cd ~/projects/akkco-vibestar
npm ci
npm run dev
```

Renderer changes use Vite HMR; backend and Electron changes rebuild and restart the
desktop. When launched from WSL, development selects native Windows Electron by
default while execution and provider accounts stay in WSL.

For a local production build:

```bash
npm run build
npm start
```

Use an isolated `VIBESTAR_HOME` when experimenting with task creation or cleanup.
Never point automated tests at your normal application state.

## Repository map

```text
backend/                 Node execution core and trusted domain services
  execution/             Engine, agents, providers, sandbox/runtime, PTYs and evidence
  github/                Official gh client and repository/PR discovery
  issue-watch/           Manual bounded discovery and saved scan history
  review/                File review, PR analysis and isolated repair workflows
  finalization/          Selected-file review, exact commits and publication journals
  workspace/             Git, ownership, paths, runtimes and editor integration
  storage/               SQLite, migrations, backup and owned cleanup
  rpc/                   Domain request validation and dispatch
src/
  app/                   Application composition and desktop navigation
  features/              Feature-owned components, hooks and contracts
  components/            UI primitives and shared workspace/diff controls
  hooks/                 Reusable renderer hooks
  lib/                   Transport, display and shared view-state utilities
  styles/                Ordered CSS chapters, tokens and responsive rules
electron/                Desktop main process, preload and core transport
scripts/                 Development, build, platform and contributor tooling
tests/                   Unit, integration, security, PTY, desktop and domain tests
docs/                    Contributor guides, architecture contracts and evidence
```

## Development checks

```bash
npm run check            # Formatting, ESLint, TypeScript and unit/domain regression
npm run verify           # All deterministic suites plus production build
npm run test:integration
npm run test:security
npm run test:tui
```

`npm ci` installs optional contributor hooks when no existing hook policy would be
overwritten. Pre-commit formats/lints staged files and preserves unstaged hunks.
Pre-push runs `check` and the security suite. [Testing](docs/testing.md) explains
suite boundaries, desktop fixtures and opt-in tests. CI reports eight separate checks.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md), then read the relevant architecture
contracts before changing execution, persistence, ownership or publishing code.
Changes should preserve saved data, explicit authorization and existing behavior.

Live-provider tests consume subscription allowance. Live GitHub fixtures can write
to a real repository. Neither belongs in routine verification without explicit authorization.

## License

Project code is available under the [MIT License](LICENSE).
Bundled Geist fonts retain their [SIL Open Font License](public/Geist-OFL.txt).
Dependencies and other third-party material retain their own licenses; see
[third-party notices](docs/third-party-notices.md).
