# Testing

Routine tests use disposable data roots, local Git repositories and inert constructor-
injected providers. They must not read normal application state, spend model allowance
or write to GitHub. Existing live tests retain explicit environment opt-ins.

## Commands and suite ownership

| Command                    | Scope                                                        |
| -------------------------- | ------------------------------------------------------------ |
| `npm run format:check`     | All maintained source/config/docs, including YAML and MJS    |
| `npm run lint`             | ESLint, type-only imports and React hook rules               |
| `npm run typecheck`        | Renderer, backend, Electron, tests and build/test config     |
| `npm test`                 | Unit and feature regressions, excluding separate projects    |
| `npm run test:integration` | Integration tests and contributor-hook lifecycle             |
| `npm run test:security`    | Deterministic sandbox, ownership, persistence and Git safety |
| `npm run test:tui`         | Authentication/task-terminal PTY behavior                    |
| `npm run test:regression`  | All four deterministic test projects in one invocation       |
| `npm run check`            | Formatting, lint, typecheck and regular regressions          |
| `npm run prepush`          | `check` plus security tests                                  |
| `npm run verify`           | `check`, integration, security, PTY and production build     |

`vitest.config.ts` declares mutually exclusive named projects. Domain directories
such as `tests/verification`, `tests/workspace`, `tests/pr-repair` and
`tests/diff` belong to regular regression coverage. Separate integration,
security, terminal, desktop and live directories are excluded from that project.
The worker limit is two to keep native/renderer fixtures practical on developer machines.

Run a relevant file during iteration without selecting an unrelated whole suite:

```bash
npm exec -- vitest run tests/unit/frontend.test.tsx
npm exec -- vitest run tests/integration/pipeline-approval.test.ts
npm exec -- vitest run tests/security/task-ownership.test.ts
```

`npm exec -- vitest list --json` inspects discovered active cases. Skipped opt-in files
remain in the source inventory; list output is not proof that their runtime assertions ran.
Do not use a passing narrow test to claim a broad workflow or migration is verified.

## What different changes require

- Display helpers/components: affected unit/UI tests, types, lint and formatting.
- Workflow/approvals/recovery: stage and saved-instruction regressions plus integration.
- Git, ownership, sandbox or cleanup: affected security/integration refusal and success paths.
- SQLite: upgrade/reopen, corrupt-record and foreign-key fixtures; preserve old migrations.
- Terminal interactions: PTY suite in addition to affected tests and quality checks.
- CSS/shared renderer structure: production build, applicable built Electron fixtures and
  representative size/keyboard/reduced-motion checks. Compare screenshots on the same host.
- Broad restructuring: the complete deterministic matrix and relevant desktop acceptance.

## Built desktop fixtures

Build first. On a headless Linux host, use Xvfb with enough virtual screen area for the 1920-wide fixture captures:

```bash
npm run build
xvfb-run -a -s "-screen 0 2560x1440x24" npm run test:desktop
xvfb-run -a -s "-screen 0 2560x1440x24" npm run test:desktop:pr
xvfb-run -a -s "-screen 0 2560x1440x24" npm run test:desktop:repair
xvfb-run -a -s "-screen 0 2560x1440x24" npm run test:desktop:output
xvfb-run -a -s "-screen 0 2560x1440x24" npm run test:desktop:watch
```

Other fixture files in `tests/desktop` retain their specific opt-in variables. They
exercise the real built renderer/IPC against isolated roots and blocked real CLIs.
Selected fixtures route RPC to test-owned services; production has no fixture-provider selector.
`VIBESTAR_KEEP_EVIDENCE=1` retains supported temporary evidence. The general desktop
fixture writes screenshots to ignored `test-results/desktop`, preserving curated docs images.

`npm run test:browser:environment` explicitly exercises installed browser/toolchain
capability without downloading dependencies or using a model. Its result proves the
fixture environment only. `VIBESTAR_PACKAGED_TEST=1 npm exec -- vitest run
 tests/desktop/packaged.test.ts` requires locally packaged Linux/Windows directories. Set `VIBESTAR_PACKAGE_DIR` to
an isolated packaging output root to avoid replacing existing local artifacts.

`npm run test:windows` needs the WSL-launched native Windows development host and Vite.
It checks real native input, monitor DPI, maximize/restore and fullscreen. Xvfb does
not substitute for those checks or for NSIS installation/update testing.

## Live opt-ins

`npm run test:live` uses real authenticated provider subscriptions and costs allowance.
The GitHub-write fixture in `tests/live/github-live.test.ts` requires
`VIBESTAR_GITHUB_WATCH_TEST=1`, refuses an unexpected destination and mutates a controlled
real test repository. Do not run either without explicit authorization. They are
excluded from `verify`, hooks and hosted CI. Historical success does not authorize a rerun.

## Hook acceptance

`tests/integration/contributor-hooks.test.ts` installs the actual hooks in disposable
repositories. It proves staged formatting, retained unstaged hunks/unrelated files,
failed-commit rollback, successful local push, failed quality/security push rejection
and preservation of private hook configuration. Test pushes target local bare remotes.

Terminal tests commit and push only to disposable local remotes. They verify inherited
Git configuration, session lifecycle, redaction and workspace execution exclusion.
Removed publication endpoints must fail dispatch; legacy migration and storage fixtures
preserve old journals without allowing operations to replay.

## CI

Three workflows expose independent status checks:

| Workflow      | Checks                                                   |
| ------------- | -------------------------------------------------------- |
| `quality.yml` | Formatting, ESLint, Typecheck                            |
| `tests.yml`   | Unit tests, Integration tests, PTY tests, Security tests |
| `build.yml`   | Production build                                         |

Each job uses pinned actions, read-only contents permission, credential-free checkout,
Node 22, npm caching/`npm ci`, explicit timeout and superseded-run cancellation.
No secrets, live inference or GitHub writes are needed for fork pull requests.
Integration, PTY and security suites are not repeated by the unit job. Packaging is
not required for each basic PR; local platform builds remain explicit commands.

Maintainers can later require all eight named statuses in branch protection. No
repository settings are changed by this work. YAML and local commands can be validated
locally; actual GitHub-hosted status execution requires a separately authorized push.

Current milestone evidence belongs in [the restructuring record](architecture/restructuring.md).
[Historical verification](architecture/verification-history.md) is retained as evidence,
not as a statement that all old live/native checks were rerun for this refactor.
