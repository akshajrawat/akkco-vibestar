# Verification: 5 October 2026

This is a runnable Electron/TypeScript application with real official CLI integrations. It was tested in Ubuntu 26.04 on WSL2/WSLg, Node 22.22.1, Electron 41.10.7, Git 2.53.0, gh 2.46.0, Codex 0.160.0 and Antigravity 1.2.17. CLI version/help and model discovery were inspected before constructing commands. No provider credential files were read.

## Checks

- Formatting, ESLint and TypeScript checks passed.
- Normal suite: 38 tests passed; real-provider and desktop suites are opt-in and run separately.
- Frontend: independent stage configuration, task preview, plan comparison, preload controls, diff tree, task draft preservation, command palette, tool-call grouping and structured response rendering.
- Integration: 7 tests passed, covering real Git clone/worktree preparation, two concurrent isolated worktrees, unrelated-checkout branch independence, pinned upstream fetch/SHA, staged/unstaged/untracked/renamed/deleted diffs, stage-specific retry, crash recovery, read-only scheduled analysis and local review feedback.
- PTY/TUI: official login PTY streaming and a real sandboxed task terminal passed. A second task completes independently while the first task's shell retains its lease and edits its own source file. Terminal crash records become Interrupted.
- Electron smoke test passed with the real completed live-provider worktree: dark frameless chrome, no menu, context isolation/no Node integration, native maximize/restore/close, real IPC, Settings, Scheduled, command palette, pane resizing, terminal input/output/docking, preserved draft, Monaco modes and local note save/delete.
- Packaged Linux executable was launched successfully: app.isPackaged=true, isolated profile, bundled Node core, actual provider detection and working preload RPC; no renderer errors.
- Production build and Linux deb / Windows NSIS packaging passed. npm audit reported zero vulnerabilities.

## Real provider evidence

The final opt-in authenticated subscription pipeline completed in **107 seconds**:

1. Antigravity model discovered through agy models: gemini-3.8-flash-low, low effort, exit 0, read-only planning.
2. Codex CLI default model, independently configured low effort, exit 0, read-only refinement.
3. Codex CLI default model, independently configured low effort, exit 0, isolated workspace-write implementation.
4. Relevant Python assertion executed by Codex, provider-reported successful validation, and harness git diff --check passed.
5. Task reached Ready for Review. Exactly source.txt changed from base to vibestar verified; no additional files changed. Both providers exposed conversation IDs that were persisted.

Evidence remains on this PC at /home/aksha/tmp/vibestar-live-E0AfUX/verification.json and its ade/ database/worktrees/logs. This tiny fixture tests actual inference and orchestration, not a claimed completion of Oppia's migration. Public issue retrieval for oppia/oppia#26831 was also verified separately; the personal Oppia checkout was not used or modified.

Actual app captures are under docs/screenshots/: overview.png, plans.png, diff.png, diff-review.png and chat-terminal.png. They show real provider/Git/PTY results; no sample agent activity is connected in production.

## Limits requiring external verification

- The live Antigravity plan completed through read-only file tools after its built-in shell tool reported a sandbox-server connection error. That tool failure is surfaced; neither isolation nor permissions are bypassed. Larger repository planning should be checked with the installed CLI sandbox on the target machine.
- gh is not authenticated on this machine. PR snapshot/change/no-op behavior is tested locally, but real authenticated PR monitoring requires gh auth login.
- Windows installer was successfully cross-built with Wine. Native Windows installation, WSL helper deployment and window behavior still require a Windows desktop test.
- WSLg's compositor did not acknowledge minimized state to Electron in this automation session; the correct native minimize API is wired, and maximize/restore/close passed.
- Scheduled monitoring runs while Vibestar is open. It is not a background OS service.
- Signing certificates are not configured; generated installers are local development releases.

See README.md for installation and documented V1 boundaries, and ARCHITECTURE.md for the execution and provider authentication trust boundaries.
