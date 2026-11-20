// DO NOT MODIFY THIS FILE

## Core Principles

- Understand the existing implementation before making changes.
- Make the smallest correct change that satisfies the requirements.
- Follow repository-specific conventions, architecture and tooling.
- Preserve existing behavior unless a change is explicitly requested.
- Prefer simple, readable solutions over unnecessary abstractions.
- Never introduce speculative features, refactors or dependencies.

## Code Quality

- Follow the repository's formatter, linter and type conventions.
- Reuse existing utilities, schemas and established patterns.
- Keep functions focused, responsibilities clear and public APIs minimal.
- Prefer readable control flow over compressed or clever code.
- Keep files organized by responsibility; avoid unnecessary indirection.
- Prefer self-explanatory code. Add comments only for non-obvious
  invariants, constraints or reasoning.
- Do not use comments to justify workarounds or architectural flaws.
- Avoid silent failures, arbitrary delays and unnecessary fallback logic.
- Prefer arrow functions for new functions and callbacks where appropriate.
  Follow repository conventions when function declarations are preferable.
- Import only what is needed. Avoid unused imports, unnecessary
  dependencies and broad module imports when specific imports suffice.
- Prefer asynchronous, non-blocking filesystem APIs over synchronous
  equivalents, especially in servers and UI-sensitive processes.
- Always use curly braces `{}` for control-flow statements (`if`, `else`, `for`, `while`, etc.), including single-statement bodies. Never omit braces.

## Process Boundaries in case of electron

- Renderer code must not directly import Electron main-process
  or backend runtime implementations.
- Communicate across processes through approved typed contracts
  and IPC interfaces.
- Shared types and schemas must not depend on privileged runtime code.
- Enforce these boundaries through ESLint and dependency checks,
  not agent instructions alone.

## Deterministic Guardrails

- Prefer architecture, types, lint rules and tests over instructions
  that merely ask agents to avoid mistakes.
- When repeated mistakes occur, identify their root cause and propose
  an enforceable solution.
- Do not copy known anti-patterns simply because they already exist.
- Prefer fixing underlying problems over introducing workarounds.
- Do not introduce new rules or abstractions for hypothetical issues.

## React Guidelines (When Applicable)

- Avoid `useEffect` unless synchronizing with an external system.
- Prefer derived state, event handlers and established hooks.
- Prefer `useSyncExternalStore` for external store subscriptions.
- Necessary Effects must have correct dependencies and cleanup.
- Never suppress dependency warnings to hide incorrect Effects.
- Avoid timers, polling and animation frames as workarounds for
  broken state management or lifecycle logic.
- Keep expensive computations off performance-critical UI paths.

## Security and Change Safety

- Respect existing architectural boundaries and security guarantees.
- Validate untrusted inputs and follow least-privilege principles.
- Never expose credentials or sensitive data.
- Use safe process execution; avoid shell injection.
- Inspect the current worktree and preserve existing user changes.
- Never delete user data or modify external systems without authorization.
- Do not commit, push, release or publish changes unless requested.
- Use isolated test environments and avoid production data.

## Testing and Verification

- Run the smallest relevant tests first, then broader checks when needed.
- Use the repository's existing verification tools and commands.
- Verify observable behavior, not only compilation or unit tests.
- Test relevant edge cases, state transitions and failure paths.
- For UI changes, exercise affected interactions when practical.
- Inspect screenshots, logs or traces when useful.
- Prefer repeatable, deterministic verification over AI-only review.
- Do not add new testing frameworks without a demonstrated need.
- Never claim tests or runtime verification passed without executing them.
- Report actual results, limitations and unverified assumptions.

## Documentation

- Do not routinely modify documentation for unrelated code changes.
- Update documentation only when explicitly requested or when changes
  would otherwise leave important existing documentation incorrect.
- Keep documentation minimal, accurate and relevant.
- Prefer executable checks and clear APIs over prose-based rules.
- Avoid unnecessary Markdown files, repetitive explanations and
  comments documenting implementation history.
- Preserve required licensing and third-party notices.
- keep the FEATUREMAP.md updated and only visual
