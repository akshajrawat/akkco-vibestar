import { z } from "zod";
import { verificationCommandText } from "./verification-command";

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
    scope: z.enum(["repository", "issue", "manual", "discovery"]).optional(),
  })
  .strict();

export interface VerificationCommand {
  id: string;
  run_id?: string | null;
  command: string;
  status: string;
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
}

interface VerificationEvidence extends z.infer<typeof VerificationCheckSchema> {
  source: "provider_reported" | "observed_command" | "vibestar";
  commandId?: string;
  legacy?: boolean;
  reportedOutcome?: z.infer<typeof VerificationCheckSchema>["outcome"];
  environment?: string;
  priorFailure?: boolean;
  optionalReason?: string;
}

// Only simple argv-shaped commands are recognized. Shell chains and arbitrary
// scripts remain unknown; an exit code alone cannot identify a test or setup.
export const verificationArgv = (command: string) => {
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

const canonicalArgv = (command: string) => {
  const argv = verificationArgv(verificationCommandText(command));
  if (argv?.[0].split("/").at(-1) !== "npx") return argv;
  const [program, ...args] = argv;
  while (["--offline", "--no-install"].includes(args[0])) args.shift();
  return [program, ...args];
};
const commandKey = (command: string) =>
  JSON.stringify(
    canonicalArgv(command) || verificationCommandText(command).trim(),
  );

const commandKind = (command: string) => {
  const words = canonicalArgv(command);
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

// Match concrete startup errors, never an assertion merely mentioning a browser
// or network. Ambiguous output stays unresolved and requires inspection.
const applicationError = (output: string) =>
  /AssertionError|\bFAIL\b|error TS\d+|SyntaxError|TypeError|ReferenceError|RangeError|Expected:.*Received:/s.test(
    output,
  );
const environmentReason = (output: string) => {
  if (applicationError(output)) return undefined;
  if (
    /canceled due to missing packages|could not determine executable to run/i.test(
      output,
    )
  )
    return "Verification tooling unavailable";
  if (
    /\b(?:EAI_AGAIN|ENOTFOUND)\b|Temporary failure in name resolution|Could not resolve host:/i.test(
      output,
    )
  )
    return "DNS resolution unavailable";
  if (
    /(?:listen|bind|socket).*\b(?:EPERM|EACCES)\b|(?:operation not permitted|permission denied).*(?:listen|socket)/i.test(
      output,
    )
  )
    return "Loopback socket denied";
  if (
    /Executable doesn't exist|browser executable (?:missing|not found)|Cannot find (?:module|package).*playwright|playwright.*(?:not installed|unavailable)|browserType\.launch:.*(?:not found|missing)/i.test(
      output,
    )
  )
    return "Browser tooling unavailable";
  if (
    /unsupported platform|platform.*(?:unavailable|not supported)/i.test(output)
  )
    return "Platform unavailable";
  return undefined;
};

export const commandVerification = (
  command: VerificationCommand,
  reported?: z.infer<typeof VerificationCheckSchema>,
): VerificationEvidence => {
  const recognized = commandKind(command.command);
  let kind = recognized === "unknown" ? reported?.kind || "check" : recognized;
  const interrupted =
    ["interrupted", "cancelled", "canceled"].includes(command.status) ||
    (kind === "setup" &&
      command.exit_code !== null &&
      [130, 137, 143].includes(command.exit_code));
  const failed =
    command.status === "failed" ||
    (command.exit_code !== null && command.exit_code !== 0);
  const demonstratedFailure =
    failed &&
    recognized === "unknown" &&
    applicationError(`${command.stdout || ""}\n${command.stderr || ""}`);
  if (demonstratedFailure) kind = "check";
  const environment = failed
    ? environmentReason(`${command.stdout || ""}\n${command.stderr || ""}`)
    : undefined;
  const outcome = interrupted
    ? "interrupted"
    : failed
      ? kind === "setup" || environment
        ? "blocked"
        : command.exit_code !== null &&
            (demonstratedFailure ||
              recognized === "check" ||
              reported?.kind === "check")
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
    required:
      demonstratedFailure ||
      recognized !== "unknown" ||
      reported?.required === true,
    detail: interrupted
      ? `${kind === "setup" ? "Tooling setup" : "Command"} was interrupted; no reliable check result was obtained.`
      : outcome === "blocked"
        ? environment ||
          "Tooling setup failed. Dependent checks remain unverified. Inspect the command output and repair the prerequisite."
        : outcome === "unknown"
          ? "The command's purpose or exit result is insufficient to establish a verification outcome."
          : `Recorded command exited ${command.exit_code ?? "without an exit code"}.`,
    prerequisite: reported?.prerequisite || null,
    ...(reported?.scope ? { scope: reported.scope } : {}),
    source:
      !command.run_id &&
      verificationArgv(command.command)?.slice(0, 3).join(" ") ===
        "git diff --check"
        ? "vibestar"
        : "observed_command",
    commandId: command.id,
    ...(environment ? { environment } : {}),
    ...(reported ? { reportedOutcome: reported.outcome } : {}),
  };
};

export const verificationSummary = (
  implementation: unknown,
  commands: VerificationCommand[],
  requiredDiff?: string,
  history: { report: unknown; commands: VerificationCommand[] }[] = [],
  policy: "repository" | "extended_browser" = "extended_browser",
) => {
  const report =
    implementation && typeof implementation === "object"
      ? { ...(implementation as Record<string, unknown>) }
      : {};
  const parsed = z
    .array(VerificationCheckSchema)
    .max(200)
    .safeParse(report.verification);
  const reportedChecks = parsed.success ? [...parsed.data] : [];
  const currentTemplates = new Set(reportedChecks);
  const priorFailures = new Map<string, VerificationEvidence>();
  const ambiguousFailures = new Set<string>();
  const observeAttempt = (
    command: VerificationCommand,
    reported?: z.infer<typeof VerificationCheckSchema>,
    uniqueName = true,
  ) => {
    const evidence = commandVerification(command, reported);
    const key =
      reported && uniqueName
        ? `name:${reported.name}`
        : commandKey(command.command);
    if (evidence.required && evidence.outcome === "failed")
      priorFailures.set(key, evidence);
    else if (evidence.outcome === "passed") {
      for (const [identity, failure] of priorFailures)
        if (
          identity === key ||
          (failure.command &&
            commandKey(failure.command) === commandKey(command.command))
        )
          priorFailures.delete(identity);
      ambiguousFailures.delete(evidence.name);
    }
    return evidence;
  };
  let invalidHistory = false;
  for (const entry of history) {
    const previous =
      entry.report && typeof entry.report === "object"
        ? (entry.report as Record<string, unknown>)
        : {};
    const previousChecks = z
      .array(VerificationCheckSchema)
      .max(200)
      .safeParse(previous.verification);
    invalidHistory ||=
      previous.verification !== undefined && !previousChecks.success;
    const previousCommands = new Map<string, VerificationCommand>();
    for (const command of entry.commands)
      previousCommands.set(commandKey(command.command), command);
    for (const old of previousChecks.success ? previousChecks.data : []) {
      if (old.required || old.kind === "setup") {
        const current =
          reportedChecks.find((check) =>
            old.kind === "setup"
              ? check.kind === "setup" && check.name === old.name
              : old.command && check.command
                ? commandKey(old.command) === commandKey(check.command)
                : check.name === old.name,
          ) ||
          (previousChecks.success &&
          previousChecks.data.filter((check) => check.name === old.name)
            .length === 1 &&
          reportedChecks.filter((check) => check.name === old.name).length === 1
            ? reportedChecks.find(
                (check) => check.name === old.name && check.kind === old.kind,
              )
            : undefined);
        if (current) {
          current.required ||= old.required;
          if (old.scope === "repository" || old.scope === "issue")
            current.scope = old.scope;
          if (old.kind === "check") current.kind = "check";
          if (!currentTemplates.has(current)) {
            current.command = old.command;
            current.detail = old.detail;
            current.prerequisite = old.prerequisite;
            current.outcome = old.kind === "setup" ? old.outcome : "not_run";
          }
        } else
          reportedChecks.push({
            ...old,
            outcome: old.kind === "setup" ? old.outcome : "not_run",
          });
      }
      const command = old.command
        ? previousCommands.get(commandKey(old.command))
        : undefined;
      if (!command && old.required && old.outcome === "failed")
        priorFailures.set(
          previousChecks.success &&
            previousChecks.data.filter((check) => check.name === old.name)
              .length === 1
            ? `name:${old.name}`
            : old.command
              ? commandKey(old.command)
              : `name:${old.name}`,
          { ...old, source: "provider_reported" },
        );
    }
    for (const command of entry.commands) {
      const reported = previousChecks.success
        ? previousChecks.data.find(
            (check) =>
              check.command &&
              commandKey(check.command) === commandKey(command.command),
          )
        : undefined;
      const evidence = observeAttempt(
        command,
        reported,
        !!reported &&
          previousChecks.success &&
          previousChecks.data.filter((check) => check.name === reported.name)
            .length === 1,
      );
      if (evidence.required) {
        if (
          previousChecks.success &&
          previousChecks.data.some(
            (check) =>
              check.command &&
              commandKey(check.command) === commandKey(command.command),
          )
        )
          continue;
        const current = reportedChecks.find(
          (check) =>
            check.command &&
            commandKey(check.command) === commandKey(command.command),
        );
        if (current) {
          current.required = true;
          current.kind = evidence.kind;
        } else
          reportedChecks.push({
            name: evidence.name,
            command: evidence.command,
            kind: evidence.kind,
            outcome: "not_run",
            required: true,
            detail:
              "A required observed check from a previous implementation needs verification after implementation changes.",
            prerequisite: evidence.prerequisite,
          });
      }
    }
    for (const key of ["testsPassed", "testsFailed", "testsSkipped"]) {
      if (!Array.isArray(previous[key])) continue;
      const names = previous[key].filter((name) => {
        if (typeof name !== "string") return false;
        const structured = previousChecks.success
          ? previousChecks.data.find((check) =>
              [check.name, check.command, check.detail].includes(name),
            )
          : undefined;
        return (
          !structured ||
          (key === "testsFailed" &&
            structured.outcome === "passed" &&
            (!structured.command ||
              !previousCommands.has(commandKey(structured.command))))
        );
      });
      if (key === "testsFailed")
        for (const name of names)
          if (
            !previousChecks.success ||
            !previousChecks.data.some((check) =>
              [check.name, check.command, check.detail].includes(name),
            )
          )
            ambiguousFailures.add(name);
      if (key === "testsFailed")
        for (const name of names) {
          const current = reportedChecks.find((check) =>
            [check.name, check.command, check.detail].includes(name),
          );
          if (current) current.required = true;
        }
      report[key] = [
        ...new Set([
          ...(Array.isArray(report[key]) ? report[key] : []),
          ...names,
        ]),
      ];
    }
  }
  const checks: VerificationEvidence[] = [];
  const used = new Set<string>();
  const latest = new Map<string, VerificationCommand>();
  for (const command of commands) {
    latest.set(commandKey(command.command), command);
    const reported = reportedChecks.find(
      (check) =>
        check.command &&
        commandKey(check.command) === commandKey(command.command),
    );
    observeAttempt(
      command,
      reported,
      !!reported &&
        reportedChecks.filter((check) => check.name === reported.name)
          .length === 1,
    );
  }
  for (const reported of reportedChecks) {
    const observed = reported.command
      ? latest.get(commandKey(reported.command))
      : undefined;
    if (observed) {
      used.add(observed.id);
      checks.push(commandVerification(observed, reported));
    } else {
      checks.push({
        ...reported,
        outcome:
          reported.outcome === "passed" && reported.required
            ? "unknown"
            : reported.outcome,
        source: "provider_reported",
        ...(reported.outcome === "passed" && reported.required
          ? {
              reportedOutcome: reported.outcome,
              detail: `${reported.detail} No matching executed command evidence was recorded.`,
            }
          : {}),
      });
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
      const structured = reportedChecks.find((check) =>
        [check.name, check.command, check.detail].includes(name),
      );
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
        outcome: outcome === "passed" ? "unknown" : outcome,
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
  for (const check of checks) {
    const failedBefore =
      [...priorFailures].some(
        ([identity, failure]) =>
          identity === `name:${check.name}` ||
          (failure.command && check.command
            ? commandKey(failure.command) === commandKey(check.command)
            : check.name === failure.name),
      ) ||
      [...ambiguousFailures].some((name) =>
        [check.name, check.command, check.detail].includes(name),
      );
    if (
      failedBefore &&
      check.outcome !== "failed" &&
      !(check.outcome === "passed" && check.source !== "provider_reported")
    ) {
      check.priorFailure = true;
      check.detail +=
        " A previous implementation reported or demonstrated failure here. Repair requires an observed passing rerun; a new environmental blocker cannot establish that the failure was fixed.";
    }
  }
  if (invalidHistory)
    checks.push({
      name: "Invalid historical verification requirements",
      command: null,
      kind: "check",
      outcome: "unknown",
      required: true,
      detail:
        "A prior implementation's required verification could not be decoded. Preserve and inspect the original report before proceeding.",
      prerequisite: null,
      source: "vibestar",
    });
  if (requiredDiff && !latest.has(commandKey(requiredDiff)))
    checks.push({
      name: "Pinned-base diff hygiene",
      command: requiredDiff,
      kind: "check",
      outcome: "not_run",
      required: true,
      detail:
        "Vibestar has no recorded result for its required comparison against the pinned base. Recheck saved evidence to execute this host check.",
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
  const parents = (check: VerificationEvidence) =>
    check.prerequisite
      ?.split(";")
      .map((reference) =>
        checks.find(
          (candidate) =>
            [candidate.name, candidate.command].includes(reference.trim()) ||
            reference.trim().startsWith(`${candidate.name} for `),
        ),
      ) || [];
  const optional = new Map<VerificationEvidence, string>();
  for (const check of checks)
    if (
      check.kind === "check" &&
      !check.command &&
      !check.legacy &&
      !check.priorFailure &&
      !["passed", "failed"].includes(check.outcome) &&
      !["repository", "issue"].includes(check.scope || "") &&
      /browser|viewport|responsive|zoom|screenshot/i.test(
        `${check.name} ${check.detail}`,
      )
    )
      optional.set(
        check,
        "Extra manual browser verification is optional under the repository-check policy. This check was not run.",
      );
  let added = true;
  while (added) {
    added = false;
    for (const check of checks) {
      if (
        check.kind !== "setup" ||
        check.outcome === "passed" ||
        check.legacy ||
        check.priorFailure ||
        check.outcome === "failed" ||
        optional.has(check) ||
        ["repository", "issue"].includes(check.scope || "")
      )
        continue;
      const dependents = checks.filter(
        (candidate) => candidate.required && parents(candidate).includes(check),
      );
      if (
        dependents.every(
          (candidate) =>
            optional.has(candidate) || candidate.outcome === "passed",
        )
      ) {
        optional.set(
          check,
          "Setup observation is not needed by any outstanding required application check. Its original result is retained.",
        );
        added = true;
      }
    }
  }
  const optionalCandidates = [...optional]
    .filter(([check]) => check.required)
    .map(([check, reason]) => ({ name: check.name, reason }));
  if (policy === "repository")
    for (const [check, reason] of optional) {
      if (check.required) check.optionalReason = reason;
      check.required = false;
    }
  const roots = checks.filter(
    (check) =>
      check.outcome !== "passed" &&
      check.outcome !== "failed" &&
      !check.priorFailure &&
      ((check.kind === "setup" &&
        ["blocked", "interrupted"].includes(check.outcome) &&
        (!check.prerequisite ||
          parents(check).every((parent) => parent?.outcome === "passed"))) ||
        check.environment ||
        environmentReason(check.detail)),
  );
  const environmentFor = (
    check: VerificationEvidence,
    visited = new Set<VerificationEvidence>(),
  ): string | undefined => {
    if (
      visited.has(check) ||
      check.priorFailure ||
      ["passed", "failed"].includes(check.outcome)
    )
      return undefined;
    visited.add(check);
    if (roots.includes(check))
      return (
        check.environment ||
        environmentReason(check.detail) ||
        (check.outcome === "interrupted"
          ? "Tooling setup interrupted"
          : "Tooling setup unavailable")
      );
    const dependencies = parents(check);
    const unresolved = dependencies.filter(
      (parent) => parent?.outcome !== "passed",
    );
    const reasons = unresolved.map(
      (parent) => parent && environmentFor(parent, new Set(visited)),
    );
    return reasons.length && reasons.every(Boolean)
      ? reasons.join("; ")
      : undefined;
  };
  for (const check of checks) {
    const environment = environmentFor(check);
    if (environment) check.environment = environment;
  }
  const blockers = roots.map((root) => ({
    title: root.environment!,
    reason: root.detail,
    source: root.source,
    checks: checks.filter((check) => {
      if (["passed", "failed"].includes(check.outcome)) return false;
      const visited = new Set<VerificationEvidence>();
      const queue = [check];
      while (queue.length) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        if (current === root) return true;
        visited.add(current);
        queue.push(
          ...parents(current).filter((parent) => parent !== undefined),
        );
      }
      return false;
    }),
  }));
  const grouped = new Map<string, (typeof blockers)[number]>();
  for (const blocker of blockers.filter((blocker) =>
    blocker.checks.some((check) => check.required),
  )) {
    const key = `${blocker.title}:${blocker.source}`;
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, blocker);
    else {
      previous.checks = [...new Set([...previous.checks, ...blocker.checks])];
      if (previous.reason !== blocker.reason)
        previous.reason += `\n${blocker.reason}`;
    }
  }
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
  const canReviewWithGaps =
    failures.length === 0 &&
    gaps.length > 0 &&
    passed.length > 0 &&
    gaps.every(
      (check) =>
        !!check.environment &&
        !check.priorFailure &&
        check.source !== "vibestar",
    );
  return {
    outcome,
    summary,
    checks,
    blockers: [...grouped.values()],
    canReview: outcome === "passed",
    canReviewWithGaps,
    policy,
    optionalCandidates,
  };
};
