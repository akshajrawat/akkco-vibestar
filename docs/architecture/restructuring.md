# Repository restructuring and acceptance record

Baseline: `447b6a2bcef8779e91d59d38811d4b8fa2344b2b`, 337 tracked files,
clean worktree, Node 22.22.1. All changes remain local and uncommitted.
This is repository preparation, not an official release.

## Baseline audit

The audit inventoried maintained source/configuration/documentation, both package
manifests and lockfiles, build/development scripts, workflows, tests, assets and
public notices. Imports, literal/dynamic module references, CLI use, native bundle
externals, domain exports and existing test ownership informed the moves.

The main problems were the flat renderer directory, a 2,612-line engine, a
1,352-line RPC module, 6,202 lines of cumulative CSS, repeated milestone narratives,
limited formatting coverage and a CI job that repeated integration/PTY tests.
The baseline passed typecheck and 580 tests across 84 runnable files, with 17 tests
in existing opt-in conditions skipped. No live inference or GitHub write was used.

## Final source map

```text
.github/
  workflows/{quality,tests,build}.yml
  ISSUE_TEMPLATE/{bug_report,feature_request}.yml
  PULL_REQUEST_TEMPLATE.md
.husky/{pre-commit,pre-push}
backend/
  main.ts
  domain.ts
  execution/
    engine.ts
    engine/{state,scheduling,tasks,repositories,workflow,approvals,verification,commands,agents}.ts
    agents/
    providers/
    runtime/
    output/
    terminals/
    verification/browser/
  rpc.ts
  rpc/{services,validation,system,tasks,repositories,storage,terminals,output,review,repairs,pull-requests}.ts
  github/
  issue-watch/
  review/{pr,repair}/
  finalization/{contracts,store,files,workspaces,hooks,service}.ts
  workspace/
  storage/
  scheduled/
electron/{main,preload,bridge,contracts}.ts
src/
  main.tsx
  app/
  components/{ui,shared,diff}/
  features/
    tasks/
    chat/output/
    workflow/
    verification/
    repositories/
    pull-requests/repair/
    issue-watch/
    git-finalization/
    providers/
    usage/
    settings/
  hooks/
  lib/
  styles/{components,features}/
  assets/fonts/
tests/
  unit/
  integration/
  security/
  terminals/
  desktop/
  live/
  helpers/
  {workspace,verification,pr-repair,issue-watch,finalization,diff}/
scripts/
docs/
  development.md
  testing.md
  security.md
  third-party-notices.md
  architecture/{workflows,restructuring,verification-history,security-audit-history}.md
  screenshots/              # Four curated fixture captures
public/Geist-OFL.txt
assets/                    # App icons and editable SVG source
README.md
ARCHITECTURE.md
AGENTS.md
CONTRIBUTING.md
LICENSE
```

Electron's four closely related files remain flat deliberately. Existing backend
GitHub, Issue Watch, storage, finalization and review groups remain intact. No new
barrel exports, speculative framework, empty symmetry folders or second agent runner
were introduced. The legacy-named `scheduled` domain remains a manual PR coordinator.

## Organization and architectural changes

| Before                                       | After                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Flat `src/components`                        | Feature ownership under `src/features`; reusable controls remain shared                   |
| `src/App.tsx` and global navigation controls | `src/app` composition                                                                     |
| Shared React hooks mixed into `src/lib`      | `src/hooks`, with feature-only hooks next to their feature                                |
| Flat execution support                       | Agents, providers, runtime, output, terminals and verification groups                     |
| 2,612-line all-purpose engine                | 324-line façade and focused internal collaborators                                        |
| Engine-local concurrency/lifecycle fields    | One shared internal `ExecutionState`, with the original leases and cancellation semantics |
| 1,352-line central RPC switch                | 110-line service/dispatch boundary and explicit domain method registries                  |
| 1,253-line finalization UI                   | 178-line composition, one controller hook and three panel components                      |
| Optional hooks inside finalization service   | Dedicated `finalization/hooks.ts`; mandatory host guards remain separate                  |
| One stylesheet                               | 27 ordered chapters imported through `src/styles/index.css`                               |
| Mixed top-level tests                        | Named unit/domain, integration, security, PTY, desktop and live projects                  |

Database, ownership, RPC confirmation, provider, stage-gate and publication contracts
retain their existing meanings. Repository operations and startup validation still
settle before SQLite closes. Constructor-only fixture capabilities cannot come from
the renderer. Runtime import analysis found no cycles after extraction.

Large remaining task/repair views compose their feature-specific workflow, shared
chat/output/diff/verification controls and persisted UI state. Storage and finalization
services retain their domain-specific journal/ownership transitions rather than
introducing a general state-machine framework. Their nontrivial guards remain covered
by the existing focused persistence, recovery and publication regressions.

## Contracts and shared utilities

- Renderer `Task` fields derive from the canonical backend contract while preserving
  sparse historical view fields. `CoreEvent` is a type-only canonical re-export.
- Renderer diff-file fields derive from the existing Git domain type, keeping the
  historical optional `untracked` display field.
- Canonical domain Zod schemas and existing SQLite migrations are retained.
- `src/lib/api.ts` owns transport/error presentation; `lib/format.ts` owns shared
  duration/token display. Chat event decoding and verification argv parsing have
  feature ownership. Existing keyboard, focus, pane, usage and diff helpers are reused.
- The finalization controller's inferred contract supplies panel state/actions without
  duplicating a manually maintained interface or changing rendered element structure.

## Confirmed cleanup

- Removed `@testing-library/jest-dom`: no imports, setup hooks or matcher use existed.
  Its exclusive transitive dependencies disappeared from the lockfile.
- Removed `components.json`: no shadcn generator dependency/invocation existed, and
  its aliases were not supported by this checkout. The working Button and Radix Slot,
  class-variance-authority, clsx and tailwind-merge remain.
- Removed the unmounted `CodeAskAI` component and its single component-only test.
  Production entrypoint reachability and repository-wide imports proved it had no
  mounted consumer. Backend selected-code review APIs/history and their tests remain.
- Removed unused `eventText` and its isolated assertion; live event decoding remains.
- Removed 37 exclusively unused legacy style rules for the retired selected-code/
  editor-review surfaces after checking static and dynamic class construction.
- Removed an unused `homedir` import from the development host script.
- Consolidated eight superseded milestone documents into maintained workflow/security
  guides. Two distinct historical evidence records remain, labelled as historical.
- Replaced stale screenshots with four current built-renderer fixture captures and
  removed six redundant images. Routine captures now go to ignored test output.

The rest of the dependency inventory has actual source, CLI, CSS, ambient-type or
native-runtime use. `@types/mdast` supplies the active `mdast` type import. Bundled
renderer/core dependencies can legitimately be build-time dependencies. New tooling
is limited to Husky, lint-staged and explicit ESLint globals. Lint-staged 16 retains
compatibility with the documented Node minimum. The only existing lockfile package
version changed was direct `globals`; ESLint's older required copy remains nested.

## Formatting, hooks and CI

Prettier is authoritative: two spaces, semicolons, double quotes, trailing commas,
100-column print width. Repository-wide commands cover hidden configuration, YAML,
MJS, CSS, JSON and Markdown. Generated outputs, lockfiles and verbatim licenses are
excluded deliberately. ESLint covers maintained JavaScript as well as TypeScript,
checks type-only imports and enforces the existing React hook rules.

Pre-commit uses lint-staged with its backup and partial-staging protection enabled.
Pre-push runs formatting, lint, types, unit/domain regressions and security tests.
`npm run verify` additionally runs integration, PTY and the production build.

The installer skips CI/production/disabled installs, archives and linked worktrees;
it preserves non-Husky hook configuration and existing ordinary private hooks, and
refuses symlinked generated hook directories. Nine disposable-repository tests cover
successful formatting/push, lint/parse rejection, staged rollback, retained unstaged
hunks/unrelated files, failed quality/security pushes and private-hook protection.
Application publication remains guarded independently of either contributor or
optional application hooks, including `--no-verify` cases.

Separate CI statuses are Formatting, ESLint, Typecheck, Unit tests, Integration tests,
PTY tests, Security tests and Production build. Suites are mutually exclusive across
jobs. Pinned official actions were verified against their v7 refs; actionlint passed.
Jobs use read-only contents, no retained checkout credentials, npm caching/`npm ci`,
Node 22, explicit timeouts and cancellation. No hosted job needs secrets, live models
or real GitHub writes. Suggested branch protections are documented, not applied.

## Packaging and licensing

Packaged smoke exposed an existing electron-builder omission: a resource root's
`node_modules` directory was excluded. Explicitly mapping `dist-core/node_modules`
restores Node-native SQLite/PTY resources. The smoke test initializes both Linux-built
helper copies and the packaged Linux app with isolated state and blocked live CLIs.
It checks the current migration version instead of its stale schema-23 expectation.

Linux and Windows unpacked packages are generated only in a disposable external
output root. Pre-existing ignored local release artifacts are preserved. Native
Windows helpers install Linux dependencies inside WSL from the existing locked manifest.
The project MIT license also travels in the helper build/installation payload.

The root license is standard MIT with `Copyright (c) 2026 akkco`. History lists
Akshaj Rawat as its source author; attribution is not rewritten. No conflicting
tracked source/asset notice was found. Geist's original Vercel/basement.studio SIL
OFL text is unchanged. MIT, third-party notice and font notice are included in the
app packages; third-party dependencies retain their own licenses.

## Acceptance evidence

| Check                         | Result                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run verify`              | Passed all constituent checks and real production build                                                           |
| Unit/domain regression        | 358 passed; one opt-in browser case skipped                                                                       |
| Integration                   | 104 passed, including nine contributor-hook cases                                                                 |
| Security                      | 123 passed                                                                                                        |
| PTY                           | 3 passed                                                                                                          |
| Complete deterministic matrix | 588 passing cases across 85 runnable files                                                                        |
| Built Electron acceptance     | Eight flows passed: workspace, approvals, verification, PR analysis, repair, finalization, output and Issue Watch |
| Installed-browser environment | Both checks passed                                                                                                |
| Fresh installation            | npm 10 `ci` passed; native SQLite query and PTY process passed                                                    |
| Platform packaging            | Linux/Windows unpacked builds passed in external output                                                           |
| Packaged smoke                | Passed Linux app and both helper copies, schema 26, isolated state                                                |
| YAML/actions                  | actionlint passed; both pinned action refs verified                                                               |
| Import/asset/document checks  | No runtime cycles; bundled fonts/notices/native resources inspected; local Markdown links resolve                 |
| Diff hygiene                  | `git diff --check` passed; no tracked build/database/log/package artifacts                                        |

The final MIT-helper payload check passed after adding its license file. Five CoreBridge
regressions also passed after that narrow installer-payload update.

For visual comparison, a clean baseline checkout was built on the same host. All
original authored rule order was preserved before removing confirmed dead rules.
Tailwind also stopped emitting unused shadow/truncate utilities. Of 42 paired desktop
captures at 1280×720, 1440×900 and 1920×1080, 23 were byte-identical. Remaining captures
changed less than one percent of pixels, with fixture SHAs, timestamps, durations,
paths or transient scroll positions; inspected pairs retained the same layout.
Headless tests use a 2560×1440 virtual screen so 1920-wide native windows fit.

## Compatibility and remaining limits

Internal source import paths changed. `npm test` now means unit/domain regression;
use `npm run verify` or the named projects for the full deterministic matrix.
Saved records, migrations and RPC/workflow/publication semantics are unchanged.
Installed WSL helpers need the normal update after a new core build.

GitHub-hosted workflow execution and actual status presentation remain unverified
because no push is authorized. Native Windows GUI/DPI/NSIS installation/update,
code signing and real account/provider/GitHub-write behavior were not rerun.
Windows helper execution on Linux is not native Windows installation evidence.
No paid inference or real GitHub mutation was used. The build retains upstream
Rollup annotation warnings; fixture jsdom reports its existing unimplemented canvas
method. Neither caused a failed check or justified adding unrelated dependencies.

No repository commit, remote push, tag, release or GitHub setting change occurred.
Only disposable fixtures pushed to local bare remotes. Root HEAD remains the baseline.
