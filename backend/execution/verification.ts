import { z } from "zod";

export const VerificationCheckSchema = z
  .object({
    name: z.string().min(1).max(1000),
    command: z.string().max(16000).nullable(),
    kind: z.enum(["check", "setup"]),
    outcome: z.enum([
      "passed",
      "failed",
      "blocked",
      "interrupted",
      "not_run",
      "unknown",
    ]),
    required: z.boolean(),
    detail: z.string().max(16000),
    prerequisite: z.string().max(1000).nullable(),
  })
  .strict();

export interface VerificationCommand {
  id: string;
  run_id?: string | null;
  command: string;
  status: string;
  exit_code: number | null;
}

interface VerificationEvidence extends z.infer<typeof VerificationCheckSchema> {
  source: "provider_reported" | "observed_command" | "vibestar";
  commandId?: string;
  legacy?: boolean;
  reportedOutcome?: z.infer<typeof VerificationCheckSchema>["outcome"];
}

// Only simple argv-shaped commands are recognized. Shell chains and arbitrary
// scripts remain unknown; an exit code alone cannot identify a test or setup.
const commandWords = (command: string) => {
  try {
    const argv: unknown = JSON.parse(command);
    if (
      Array.isArray(argv) &&
      argv.length &&
      argv.every((arg) => typeof arg === "string")
    )
      return argv as string[];
  } catch {
    /* Provider commands commonly arrive as text rather than JSON argv. */
  }
  return /^[\w./:@=+\s-]+$/.test(command.trim())
    ? command.trim().split(/\s+/)
    : null;
};

const commandKey = (command: string) =>
  JSON.stringify(commandWords(command) || command.trim());

const commandKind = (command: string) => {
  const words = commandWords(command);
  if (!words) return "unknown";
  const [program, ...args] = words;
  const executable = program.split("/").at(-1);
  if (
    (executable === "npm" && ["install", "ci"].includes(args[0])) ||
    (executable === "npx" &&
      args[0] === "playwright" &&
      ["install", "install-deps"].includes(args[1])) ||
    (executable === "python" &&
      args[0] === "-m" &&
      args[1] === "pip" &&
      args[2] === "install")
  )
    return "setup";
  if (
    (executable === "npm" &&
      (args[0] === "test" ||
        (args[0] === "run" &&
          /^(?:test(?::[\w-]+)?|lint|typecheck|build|format:check)$/.test(
            args[1] || "",
          )))) ||
    (executable === "node" &&
      args.some((arg) => ["--check", "--test"].includes(arg))) ||
    ["pytest", "tsc", "eslint"].includes(executable || "") ||
    (executable === "npx" &&
      (["tsc", "eslint", "vitest"].includes(args[0]) ||
        (args[0] === "playwright" && args[1] === "test"))) ||
    (executable === "git" && args[0] === "diff" && args.includes("--check"))
  )
    return "check";
  return "unknown";
};

export const commandVerification = (
  command: VerificationCommand,
  reported?: z.infer<typeof VerificationCheckSchema>,
): VerificationEvidence => {
  const recognized = commandKind(command.command);
  const kind =
    recognized === "unknown" ? reported?.kind || "check" : recognized;
  const interrupted =
    ["interrupted", "cancelled", "canceled"].includes(command.status) ||
    (recognized === "setup" &&
      command.exit_code !== null &&
      [130, 137, 143].includes(command.exit_code));
  const failed =
    command.status === "failed" ||
    (command.exit_code !== null && command.exit_code !== 0);
  const outcome = interrupted
    ? "interrupted"
    : failed
      ? recognized === "setup"
        ? "blocked"
        : command.exit_code !== null &&
            (recognized === "check" || reported?.kind === "check")
          ? "failed"
          : "unknown"
      : command.exit_code === 0
        ? "passed"
        : "unknown";
  return {
    name: reported?.name || command.command,
    command: command.command,
    kind,
    outcome,
    required: recognized !== "unknown" || reported?.required === true,
    detail: interrupted
      ? `${kind === "setup" ? "Tooling setup" : "Command"} was interrupted; no reliable check result was obtained.`
      : outcome === "blocked"
        ? "Tooling setup failed. Dependent checks remain unverified. Inspect the command output and repair the prerequisite."
        : outcome === "unknown"
          ? "The command's purpose or exit result is insufficient to establish a verification outcome."
          : `Recorded command exited ${command.exit_code ?? "without an exit code"}.`,
    prerequisite: reported?.prerequisite || null,
    source:
      !command.run_id &&
      commandWords(command.command)?.slice(0, 3).join(" ") ===
        "git diff --check"
        ? "vibestar"
        : "observed_command",
    commandId: command.id,
    ...(reported ? { reportedOutcome: reported.outcome } : {}),
  };
};

export const verificationSummary = (
  implementation: unknown,
  commands: VerificationCommand[],
  requiredDiff?: string,
) => {
  const report =
    implementation && typeof implementation === "object"
      ? (implementation as Record<string, unknown>)
      : {};
  const parsed = z
    .array(VerificationCheckSchema)
    .max(200)
    .safeParse(report.verification);
  const checks: VerificationEvidence[] = [];
  const used = new Set<string>();
  const latest = new Map<string, VerificationCommand>();
  for (const command of commands)
    latest.set(commandKey(command.command), command);
  for (const reported of parsed.success ? parsed.data : []) {
    const observed = reported.command
      ? latest.get(commandKey(reported.command))
      : undefined;
    if (observed) {
      used.add(observed.id);
      checks.push(commandVerification(observed, reported));
    } else {
      checks.push({ ...reported, source: "provider_reported" });
    }
  }
  for (const [key, outcome] of [
    ["testsPassed", "passed"],
    ["testsFailed", "unknown"],
    ["testsSkipped", "not_run"],
  ] as const) {
    const entries = report[key];
    if (!Array.isArray(entries)) continue;
    for (const name of entries.filter((entry) => typeof entry === "string")) {
      const structured = parsed.success
        ? parsed.data.find((check) =>
            [check.name, check.command, check.detail].includes(name),
          )
        : undefined;
      if (structured) {
        const observed = structured.command
          ? latest.get(commandKey(structured.command))
          : undefined;
        // A contradictory legacy failure cannot disappear behind an unobserved
        // structured pass. An actual matching command retry can settle it.
        if (
          key !== "testsFailed" ||
          structured.outcome !== "passed" ||
          observed
        )
          continue;
      }
      checks.push({
        name,
        command: null,
        kind: "check",
        outcome,
        required: true,
        detail:
          key === "testsFailed"
            ? "Legacy provider-reported failure. Application failure versus tooling blockage is ambiguous; inspect the original report and command evidence."
            : "Legacy provider report; no structured command link or requirement classification was saved.",
        prerequisite: null,
        source: "provider_reported",
        legacy: true,
      });
    }
  }
  for (const command of latest.values()) {
    if (used.has(command.id)) continue;
    const evidence = commandVerification(command);
    if (evidence.required || evidence.outcome !== "passed")
      checks.push(evidence);
  }
  if (requiredDiff && !latest.has(commandKey(requiredDiff)))
    checks.push({
      name: "Pinned-base diff hygiene",
      command: requiredDiff,
      kind: "check",
      outcome: "not_run",
      required: true,
      detail:
        "Vibestar has no recorded result for its required comparison against the pinned base. Retry validation only; provider-reported success does not establish this host check.",
      prerequisite: null,
      source: "vibestar",
    });
  if (report.verification !== undefined && !parsed.success)
    checks.push({
      name: "Invalid structured verification report",
      command: null,
      kind: "check",
      outcome: "unknown",
      required: true,
      detail:
        "The saved structured report could not be validated. Original evidence is retained.",
      prerequisite: null,
      source: "provider_reported",
    });
  const required = checks.filter((check) => check.required);
  const failures = required.filter((check) => check.outcome === "failed");
  const gaps = required.filter(
    (check) => !["passed", "failed"].includes(check.outcome),
  );
  const passed = checks.filter(
    (check) => check.kind === "check" && check.outcome === "passed",
  );
  const outcome = failures.length
    ? "failed"
    : gaps.length
      ? "blocked"
      : passed.length
        ? "passed"
        : "unknown";
  const summary = failures.length
    ? `${failures.length} required check${failures.length === 1 ? "" : "s"} failed. Inspect the application/test evidence before retrying implementation.`
    : gaps.length
      ? `${passed.length ? "Recorded checks passed · " : ""}Verification incomplete: ${gaps.map((check) => `${check.name} (${check.outcome.replaceAll("_", " ")})`).join("; ")}`
      : passed.length
        ? "Recorded checks passed. This establishes only the checks listed below."
        : "Verification outcome unknown. No successful check evidence is available.";
  return { outcome, summary, checks, canReview: outcome === "passed" };
};
