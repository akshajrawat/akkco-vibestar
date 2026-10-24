import type { Detail } from "./types";
import { verificationSummary } from "../../backend/execution/verification";

export const detailVerification = (detail: Detail) => {
  if (detail.validation) return detail.validation;
  const implementation = [...detail.runs]
    .reverse()
    .find((run) => run.stage === 3);
  const artifact = [...detail.artifacts]
    .reverse()
    .find((entry) => entry.stage === 3 && entry.kind === "plan");
  let report: unknown;
  try {
    report = artifact ? JSON.parse(artifact.content) : null;
  } catch {
    report = { verification: "invalid" };
  }
  return verificationSummary(
    report,
    detail.tests.filter(
      (command) =>
        implementation &&
        (command.run_id === implementation.id ||
          (!command.run_id && command.started_at >= implementation.started_at)),
    ),
    detail.task.stage >= 4
      ? JSON.stringify([
          "git",
          "diff",
          "--check",
          detail.task.base_commit_sha,
          "--",
        ])
      : undefined,
  );
};

export const verificationRoots = (detail: Detail) => {
  const { checks } = detailVerification(detail);
  const roots = new Map<
    string,
    { title: string; reason: string; source: string; checks: typeof checks }
  >();
  for (const check of checks) {
    if (check.kind !== "setup" || check.outcome === "passed") continue;
    const command = detail.tests.find(
      (record) => record.id === check.commandId,
    );
    const output = `${command?.stdout || ""}\n${command?.stderr || ""}\n${check.detail}`;
    const browser = /playwright|browser/i.test(
      `${check.name} ${check.command}`,
    );
    const dns =
      /\b(?:EAI_AGAIN|ENOTFOUND)\b/.test(output) &&
      /registry\.npmjs\.org/i.test(output);
    const socket =
      /(?:listen|bind).*\b(?:EPERM|EACCES)\b|(?:operation not permitted|permission denied).*(?:listen|socket)/i.test(
        output,
      );
    const title = browser
      ? "Browser tooling unavailable"
      : socket
        ? "Local HTTP server unavailable"
        : dns
          ? "Package registry unavailable"
          : check.outcome === "interrupted"
            ? "Tooling setup interrupted"
            : "Tooling setup needs attention";
    const reason = dns
      ? "Cannot resolve registry.npmjs.org. Installation did not complete."
      : socket
        ? "This environment denied the listening socket. Server-dependent checks did not execute."
        : check.detail;
    const key = `${title}:${reason}:${check.source}`;
    const root = roots.get(key) || {
      title,
      reason,
      source: check.source,
      checks: [],
    };
    root.checks.push(check);
    for (const dependent of checks) {
      if (
        !dependent.prerequisite ||
        ["passed", "failed"].includes(dependent.outcome)
      )
        continue;
      if (
        (browser && /playwright|browser/i.test(dependent.prerequisite)) ||
        dependent.prerequisite === check.name
      )
        if (!root.checks.includes(dependent)) root.checks.push(dependent);
    }
    roots.set(key, root);
  }
  return [...roots.values()];
};
