# Working on Akkco Vibestar

## Overview

Vibestar is a local Electron workspace for issue contributions, PR repairs and
manual issue discovery. Read `ARCHITECTURE.md` before changing architectural code.
The renderer presents state; the Linux/WSL Node core owns all execution authority.

## Repository map

- `src/app`: app composition, desktop navigation and title bar.
- `src/features`: feature-owned components, state, hooks and renderer contracts.
- `src/components/ui`: reusable UI primitives; `shared` and `diff`: shared workspace controls.
- `src/hooks`: reusable React hooks; `src/lib`: transport, view state and display utilities.
- `src/styles/index.css`: ordered CSS imports. Preserve cascade order when moving rules.
- `backend/execution/engine.ts`: stable engine façade and startup/shutdown composition.
- `backend/execution/engine`: scheduling, lifecycle, workflow, approval and recovery internals.
- `backend/execution/{agents,providers,runtime,output,terminals,verification}`: execution support.
- `backend/rpc`: domain request handlers; `backend/rpc.ts`: service composition and dispatch.
- `backend/{github,issue-watch,review,finalization,workspace,storage}`: trusted domain services.
- `electron`: main process, isolated preload, stdio bridge and desktop contracts.
- `tests/{unit,integration,security,terminals,desktop,live}`: named suite categories.
- `tests/{workspace,verification,pr-repair,issue-watch,finalization,diff}`: domain regressions.
- `tests/helpers`: shared fixture constructors. Keep domain-only fixtures with their tests.

## Code conventions

Follow the repository-wide formatting configuration. Prettier is authoritative.
Use npm for dependencies and scripts. Prefer inferred types when they are clear.
Use `import type` for type-only dependencies, particularly renderer/backend contracts.
Small local types can stay inline; name substantial domain concepts and shared boundaries.
Prefer existing canonical Zod schemas and inferred types over duplicate contracts.
Use clear syntax and async filesystem APIs; do not impose syntax changes solely for uniformity.

Keep public exports minimal. Internal helpers need no package barrel or public API.
Reuse existing error, display, parsing, focus, layout and ownership utilities.
Add concise block comments for architectural entrypoints and non-obvious invariants;
avoid comments that simply repeat a trivial function's name.

Keep directories flat while they contain only a few related files. Group growing
responsibilities by domain, without empty folders or symmetrical `index.ts` files.
Move feature code to its owner instead of treating nearby reuse as global utility.

## Code Readability

Code must be organized for human review. Separate logical sections with blank
lines, keep functions focused, avoid compressed control flow, and prefer explicit
readable code over dense expressions. Passing Prettier is necessary but not
sufficient.

Keep import groups together, with a blank line after each group. Separate top-level
functions and classes, and put blank lines between class methods. Use spacing to
mark meaningful phases and conclusions; keep short related statements compact.
Avoid adding a blank line after every statement. Prettier and ESLint enforce layout.

## Security invariants

- Keep renderer Node integration disabled, context isolation and Chromium sandbox enabled.
- Validate the main-frame IPC sender and every host mutation's input/confirmation.
- Preserve core capability negotiation before unsupported mutations.
- Use argv arrays. Do not interpolate repository paths or model text into a shell.
- Require the outer sandbox and provider restrictions; missing isolation fails closed.
- Planning/review stays read-only. Implementation/PTY access is limited to its owned assignment.
- Keep shared execution slots, maintenance leases and cancellation state authoritative.
- Canonicalize managed paths, reject aliases and prove worktree/branch/common-directory ownership.
- Never remove imported source checkouts or unknown/dirty/unpublished work automatically.
- Keep content fingerprints and integrity Git output separate from redacted display output.
- Preserve SQLite migrations, backup-before-upgrade, ownership checks and corrupt-record bytes.
- Provider authentication/session directories are a trusted CLI boundary; do not extract credentials.
- Persist bounded redacted logs, not OAuth tokens. Preserve streaming redaction across chunks.
- Distinguish observed command outcomes from provider reports and missing evidence.
- Preserve explicit workflow startup, approval gates and saved-instruction decisions.
- PR analysis and Issue Watch require explicit requests; startup/opening must not invoke inference.
- Publication requires fresh identity, permission, fingerprint, verification, ancestry and remote-SHA checks.
- Optional contributor/application hooks are not a security boundary. `--no-verify` cannot waive host guards.
- Do not change the application publisher to execute repository hooks unsandboxed.
- Contributor hook installers must preserve existing private hooks and hook configuration.
- Cancellation/restart must not replay provider runs or remote writes.

## Testing

Run tests for code changes, choosing the specific affected test files first:

```bash
npm exec -- vitest run tests/unit/frontend.test.tsx
npm exec -- vitest run tests/security/task-ownership.test.ts
```

`npm test` runs regular unit and domain regressions. Separate projects are available
through `test:integration`, `test:security` and `test:tui`. Follow the named project
boundaries when changing test discovery or CI; do not duplicate a full suite in each job.

For interactive terminal behavior, run `npm run test:tui` in addition to relevant
unit/type/format checks. Execution, storage, Git and authorization changes need the
relevant integration/security tests. Renderer/style changes need applicable built
Electron fixtures, keyboard checks and visual comparisons.

Use `npm run verify` for substantial refactors and before final acceptance. It runs
formatting, lint, types, all deterministic suites and the production build. Desktop,
installed-browser and native Windows checks have separate prerequisites in `docs/testing.md`.
Never run live-provider or GitHub-write tests without explicit authorization.

## Source and change discipline

Inspect the current worktree before relying on earlier context. Preserve user edits.
Keep changes within the task; explain required architectural contract changes first.
Refactor behavior-preservingly unless a behavior change is explicitly requested.
Do not invent passing evidence, subscription limits, ownership or migration defaults.
Do not add speculative abstractions or replace working libraries merely to simplify a tree.

Do not automatically commit, push, tag, release, post messages or change repository settings.
Do not wipe application state or user-owned files. Tests must use temporary isolated roots,
local remotes and inert fixture providers rather than live accounts or production data.

## Documentation

Update `ARCHITECTURE.md` when responsibilities, boundaries or data flows change.
Update README for setup/user-facing entry points and detailed guides for operational contracts.
Trivial implementation, comment and spelling changes do not require architecture edits.
Keep chronological evidence in the historical verification record, not the README.
Preserve third-party notices and avoid unsupported licensing or release claims.
