# Testing

Routine tests use disposable data roots, local Git repositories and inert constructor-injected providers. They must not read normal application state, spend model allowance or write to GitHub.

## Commands and suite ownership

| Command                    | Scope                                                         |
| -------------------------- | ------------------------------------------------------------- |
| `npm run format:check`     | Check formatting across maintained source, config, and docs   |
| `npm run format`           | Automatically format source code with Prettier                |
| `npm run lint`             | ESLint, type-only imports and React hook rules                |
| `npm run typecheck`        | TypeScript typechecking (`tsc --noEmit`)                      |
| `npm test`                 | Unit and component regressions (`unit` project)               |
| `npm run test:integration` | Integration tests for Viber sessions, computers, and runtime  |
| `npm run test:security`    | Deterministic sandbox, ownership, persistence and Git safety  |
| `npm run test:regression`  | All deterministic test projects (unit, integration, security) |
| `npm run check`            | Formatting, lint, typecheck and unit tests                    |
| `npm run prepush`          | Complete verification suite (`npm run verify`)                |
| `npm run verify`           | `check`, integration, security, and production build          |

`vitest.config.ts` declares three named test projects:

- `unit`: Unit and feature tests under `tests/unit/` and `tests/workspace/`.
- `integration`: Multi-component and container/workspace integration tests under `tests/integration/`.
- `security`: Filesystem isolation, sandbox manifests, redaction, and Git safety tests under `tests/security/`.

The worker limit is two to keep native/renderer fixtures practical on developer machines.

Run a relevant test file during iteration without selecting an entire suite:

```bash
npm exec -- vitest run tests/unit/domain.test.ts
npm exec -- vitest run tests/integration/viber-sessions.test.ts
npm exec -- vitest run tests/security/workspace.test.ts
```

## What different changes require

- Display helpers and UI components: affected unit/UI tests, types, lint and formatting.
- Viber lifecycle, continuity, and session handling: affected unit and integration tests.
- Git, ownership, sandbox or storage cleanup: affected security and integration tests.
- SQLite persistence: migration fixtures, foreign-key consistency, and recovery tests. Old migrations must be preserved.

## CI Workflows

Three GitHub Actions CI workflows expose independent status checks:

| Workflow      | Checks                                        |
| ------------- | --------------------------------------------- |
| `quality.yml` | Formatting, ESLint, Typecheck                 |
| `tests.yml`   | Unit tests, Integration tests, Security tests |
| `build.yml`   | Production build                              |

Each job uses pinned actions, read-only contents permission, credential-free checkout, Node 22, npm caching (`npm ci`), explicit timeout and superseded-run cancellation.
