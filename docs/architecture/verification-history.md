# Verification record

Earlier milestone logs were removed from the active documentation tree; their historical versions
remain in Git. This page records recent local acceptance runs and architectural verification history.

## 2026-11-17 — Architecture folder restructuring and output consolidation

Refactored repository folder structure to clearly delineate application layers without introducing
monorepo tooling, separate packages or new dependencies:

- Moved `src/` → `apps/desktop/` (Vite/React frontend renderer)
- Moved `electron/` → `apps/electron/` (Electron main process, preload, and platform bridge)
- Moved `backend/` → `apps/core/` (Node-based execution core, engine, agents, and persistence)
- Retained `tests/`, `assets/`, `scripts/`, and root configuration files at the repository root.

Consolidated all generated build, distribution, and test outputs into the root `out/` directory:

- `out/desktop/` — Vite renderer production build
- `out/electron/` — esbuild Electron main and preload bundles
- `out/core/` — Bundled execution core and locked native dependencies
- `out/release/` — Electron Builder packaged distributions and installers

Updated all affected TypeScript paths, Vite configs, build/dev scripts, packaging configurations,
unit/integration/security/desktop tests, and documentation. Cleaned up obsolete screenshots and legacy
test results.

Deterministic test verification results:

- `npm run check` (format check, ESLint, TypeScript check, unit test suite): 57 test files, 407 passed (1 skipped).
- `npm run test:integration`: 35 test files, 214 passed.
- `npm run test:security`: 20 test files, 148 passed.
- `npm run test:tui`: 2 test files, 7 passed.
- `npm run verify`: All deterministic suites and production builds passed cleanly.
- Built Electron desktop fixtures under Xvfb:
  - `npm run test:desktop` (isolated Viber flow): PASSED
  - `npm run test:desktop:sidebar`: PASSED
  - `npm run test:desktop:pr`: PASSED
  - `npm run test:desktop:repair`: PASSED
  - `npm run test:desktop:output`: PASSED
  - `npm run test:desktop:watch`: PASSED
- Desktop packaging: `npm run desktop:build` successfully generated `out/release/akkco-vibestar_0.1.0_amd64.deb` and unpacked Linux release.

No commits or pushes were made.

## 2026-11-14 — Notifications, runtime recovery and settings autosave

Added a shared bottom-right notification service and modal-aware Toaster. "Necessary only" is the
persisted default; errors, required input, blocking warnings, and essential installation progress
remain visible. Settings use serialized field patches, roll failed saves back to acknowledged values,
and retry without overwriting newer edits. Desktop environment changes require native confirmation
and atomic core activity refusal before restart. Managed WSL setup checks bundled bytes, locked
dependencies, and native ABI. Retired global AI settings; model selection is performed per-operation
in PR controls.

Validation:

- `npm run verify`: formatting, lint, types, 398 regular tests (one skip), 210 integration tests,
  148 security tests, 7 terminal tests, and production build (763 passing deterministic tests).
- Built Electron acceptance under Xvfb: Settings, PR analysis, PR watch, PR repair, and Issue Watch.
- Verified absence of Retry button in settings save failure toasts (changing setting resubmits).

Captures:

- [Notification preference dropdown](../screenshots/settings-notifications.png)
- [Repository search](../screenshots/settings-repository-toolbar.png)
- [Settings rollback](../screenshots/settings-save-rollback.png)
- [Bottom-right runtime progress](../screenshots/notifications-bottom-right.png)
- [Success toast](../screenshots/settings-toast-success.png)
- [Failure toast](../screenshots/settings-toast-failure.png)
- [Successful save in Settings](../screenshots/settings-save-success.png)

## 2026-11-07 — Settings workspace overlay and repository management

Settings opens in an ~80vw × 90vh modal overlay over the mounted workspace. A 248px grouped,
searchable sidebar and fixed breadcrumb/action header surround independently scrollable category
panels. Visited categories preserve local drafts and scroll positions. Shared preferences retain
their schema/RPCs and desktop saves. Dropdowns remain within the modal layer.

Connected repositories and the GitHub catalog use dark rounded panels matching Task settings. Rows
share the panel background with subtle inset dividers. The repository page features padded,
borderless search beside Connect local repository, Scan local, and Sync GitHub. Task preferences
in General feature a compact subheader and single panel with right-aligned dropdowns.

`npm run verify` passed: formatting, ESLint, TypeScript, 392 unit tests, 205 integration tests,
147 security tests, 7 terminal tests, and production build (751 passing deterministic tests). Built
Electron fixture verified modality, focus restoration, shortcut isolation, category navigation,
and draft retention.

Captures:

- [Settings workspace](../screenshots/settings-workspace.png)
- [Providers](../screenshots/settings-providers.png)
- [Storage](../screenshots/settings-storage.png)
- [Repository toolbar](../screenshots/settings-repository-toolbar.png)

## 2026-11-07 — Flat task sidebar, compact feed and search

Implemented a full-height sidebar with compact collapse control, expanding the workspace and
providing an accessible reopen control in the main window chrome. Sidebar items feature
repository/time metadata followed by title, with execution duration taking precedence over relative
creation age. Idle tasks suppress redundant status text. Meaningful states use a contextual icon
beside duration. Compact immediate search filters loaded task titles, repository identities, issue
numbers, and status labels across both task areas without altering collapse state. Escape clears the
field. Selected rows use a neutral background.

`npm run verify` passed: 385 unit tests, 205 integration tests, 147 security tests, 7 terminal
tests, and production build. Built Electron sidebar and Viber flow fixtures passed together under
Xvfb, verifying geometry, collapse/reopen, search, context menus, and scrolling.

Captures:

- [Populated task feed](../screenshots/sidebar.png)

## 2026-11-07 — Repository maintainability cleanup

Consolidated test suites, improved modularity across execution engines, and eliminated redundant
fixture harnesses while preserving full regression coverage.

Deterministic suite passed: formatting, ESLint, TypeScript, 356 unit tests, 205 integration
tests, 147 security tests, 7 terminal tests, and production build (715 passing deterministic tests).
Built Electron Viber flow fixture passed under Xvfb with isolated data roots and inert provider tools.

Captures:

- [Viber canvas](../screenshots/vibers.png)
