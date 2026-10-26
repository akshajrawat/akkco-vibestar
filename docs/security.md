# Security boundaries

Vibestar processes untrusted repository files, issue text, review comments and model
output. Those inputs provide context; they do not grant host or publication authority.
The primary boundaries are the Electron bridge, owned filesystem/Git assignments,
execution sandbox, persistence contracts and independent publishing checks.

## Renderer and transport

Electron keeps context isolation and Chromium sandboxing enabled and Node integration
disabled. Main-frame sender checks protect the narrow preload API. Navigation,
webviews and arbitrary new windows are refused. Markdown skips raw HTML.
The core validates request envelopes and domain payloads. Confirmation fields and
current owner checks are enforced by the host, not by dialog visibility.
Compatibility negotiation blocks unsupported mutations against stale helpers.

## Execution and provider trust

Processes use argv arrays, bounded input/output, deadlines, filtered environments and
process-group cancellation. Restart checks PID plus process-start identity before
terminating a saved process. Provider and terminal output is redacted across stream
chunks before events, snapshots and logs; redaction remains best effort.

Bubblewrap starts from an empty root and an explicit mount manifest. Only the assigned
worktree, permitted system/toolchain/runtime paths, managed artifacts and selected
provider state are exposed. Planning/review source and Git mounts are read-only.
Implementation and PTYs have their assigned worktree access. Missing isolation fails
closed. Dependency reuse is read-only and requires safe ignored/untracked ownership.

Official provider authentication/session directories remain accessible because those
CLIs must authenticate and keep conversations. The provider process is trusted within
that boundary. Vibestar does not read, deserialize or copy OAuth credentials, and does
not claim complete credential isolation from a malicious provider executable. Provider
sandboxes and official account restrictions remain separate requirements.

## Filesystem and saved authority

Managed paths are bound to the canonical startup root, with no-follow parent/file
inspection and rejection of symlinked categories, aliases and replaced roots. Imported
checkouts have a separate explicit boundary. Worktree/common-directory/branch markers
must prove ownership before mutation or cleanup. Unknown ownership is preserved.

Integrity fingerprints use exact content, modes, index and Git identifiers rather than
redacted or truncated display output. Oversized integrity evidence fails explicitly.
Content changes invalidate pending review, discard and publication authority.

SQLite upgrades take a private backup and validate foreign keys transactionally.
Invalid collection records are isolated with payload-free diagnostics while original
bytes remain. Exact unsafe reads fail. Display fallbacks cannot authorize execution.
Root migration preserves staged journals, imported-worktree boundaries and recovery.

Ordinary cleanup refuses dirty, untracked, ignored, hidden-index and unpublished work.
Explicit discard binds the exact preview and acknowledgment and still requires owner,
Git-operation and dependency checks. History-only removal retains worktree ownership.
No broad recursive data-root reset is permitted.

## Git operations and publication

The shared Git executor inspects local/worktree config and suppresses global/system
executable configuration, implicit lazy fetch, unsafe helpers/filters/includes/rewrites
and arbitrary executable commands. Managed network operations use canonical GitHub
HTTPS and official gh credential delegation. Local transports are constructor-only fixtures.

Local review approval, local commit and remote publication are distinct operations.
The host verifies immutable repository/fork identity, viewer permission, exact selected
content, required verification, current fingerprint, branch, ancestry and remote SHA.
Publication targets the authorized contribution fork or verified PR head, never upstream.

The independent host publisher proves fast-forward ancestry and applies an exact
compare-and-swap ref lease. Broad force, wildcard leases and non-fast-forward writes
are refused. Network ambiguity is journaled and reconciled read-only before retry.
Restart does not replay pushes or model invocations.

Optional application hooks run under the existing read-only sandbox policy and bounded
output, not as arbitrary unsandboxed host commands. Contributor Husky hooks are separate
local quality checks. Their installer preserves existing hook configuration/private
scripts and skips linked worktrees. `--no-verify` never waives mandatory application guards.

## Evidence and explicit execution

Observed command exits, model-reported tests and environmental prerequisites remain
separate. Missing/skipped/unknown evidence is not a pass. Required historical checks
and unresolved application failures survive repairs. Environmental-gap review needs
fresh content/evidence-bound acknowledgment; it cannot authorize publication.

Task creation is idle. Workflow startup, approval, saved-instruction delivery, PR
analysis, Issue Watch scans and repair continuation require explicit requests.
Saving/opening/refreshing metadata does not start inference. Incomplete/cancelled
attempts preserve evidence without inventing a completed baseline.

## Verification and reports

Run deterministic security and relevant integration regressions for boundary changes.
Use fake secrets, disposable roots, inert providers and local remotes. Do not probe
real credentials or publish to GitHub as part of ordinary testing.

For a sensitive report, use a private maintainer contact or private security reporting
channel when available. Include affected behavior and a minimal isolated reproduction;
do not attach real credentials, private issue data or personal SQLite/log files.
There is no promised response SLA or claimed formal disclosure program.

The [historical security audit](architecture/security-audit-history.md) retains earlier
findings, remediation reasoning and experiment limits. It is historical evidence;
current code and regression results determine present behavior.
