# Contributing

Vibestar is pre-stable. Contributions should improve a concrete problem while
preserving isolated workspaces, saved data and explicit execution/publication decisions.

## Before starting

Read the [README](README.md), [architecture](ARCHITECTURE.md) and
[security boundaries](docs/security.md). Use an existing issue when one describes
the problem. Otherwise describe the proposed change and its expected behavior in
an issue before investing in a large redesign. There is no formal governance process.

Small documentation fixes, focused bug fixes and regression tests are good starting
points. Changes to authorization, migrations, publication or provider trust boundaries
need maintainer agreement on the contract before implementation.

## Setup and branch

Install Node 22.12+, npm 10+, Git and the Linux sandbox/native build prerequisites
listed in [development](docs/development.md), then work from your checkout:

```bash
npm ci
git switch -c fix/descriptive-name
npm run dev
```

Use a separate `VIBESTAR_HOME` for manual experiments. Routine fixture tests do not
need real provider authentication. Do not use personal source checkouts as test data.

## Code style

Prettier defines formatting: two spaces, semicolons, double quotes, trailing commas
and a 100-column print width. ESLint checks JavaScript/TypeScript and React hooks.
Use type-only imports and existing domain schemas. Keep local types local unless
they represent a shared or substantial contract.

Put renderer changes in the owning feature, trusted operations in the owning backend
domain, and reusable controls in shared components. Reuse existing helpers. Avoid
unrelated cleanups, speculative abstractions and broad public exports.

## Local checks and hooks

```bash
npm run check
npm run verify
```

The first command runs formatting, lint, types and regular regressions. The second
adds integration, security, PTY and production build checks. Run targeted test files
while iterating, then broaden for the change's actual risk. See [testing](docs/testing.md).

`npm ci` installs Husky hooks only when no existing policy would be overwritten.
Pre-commit uses lint-staged to format/lint staged files while hiding and restoring
unstaged hunks. Pre-push runs `check` and security tests. A failure prevents the
ordinary Git operation. Existing hook policies are preserved; `npm run hooks:install`
can retry installation after you deliberately resolve a conflicting local policy.

These are contributor convenience checks. Bypassing them does not bypass Vibestar's
mandatory publishing authorization. Never weaken application guards to make a hook pass.

## Pull requests

Use a short imperative commit subject explaining the change; a specific prefix such
as `fix:`, `refactor:` or `docs:` is welcome but not enforced. Keep commits reviewable.

A PR should explain the problem, resulting behavior, tests actually run, remaining
verification gaps and related issue. Include screenshots for visible UI changes.
Call out migrations, compatibility changes and security-sensitive effects explicitly.
Do not include generated binaries, local databases, logs, credentials or test captures.

Update architecture documentation when boundaries change, and operational guides
when commands or contracts change. Preserve third-party notices. Do not introduce
release automation or change remote settings without maintainer approval.

## Security-sensitive work

Filesystem ownership, sandboxing, provider auth, persistence recovery, Git configuration,
content fingerprints and publication are security boundaries. Preserve refusal cases
as well as success paths and add focused regression coverage when behavior changes.
Use fake secrets, local remotes and fixture providers. Live inference costs allowance;
GitHub-write tests require explicit authorization and a controlled destination.

For a sensitive report, avoid publishing credentials or an exploit against a real
repository in a public issue. Use an available private maintainer contact or private
security reporting channel if the repository offers one; no response SLA is promised.
