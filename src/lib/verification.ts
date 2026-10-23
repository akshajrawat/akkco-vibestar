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
