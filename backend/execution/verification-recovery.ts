import { verificationArgv, type verificationSummary } from "./verification";
import { verificationCommandText } from "./verification-command";
import type {
  BrowserEnvironmentReport,
  VerificationEnvironment,
} from "./browser/contracts";

// Re-execution accepts only exact recorded, recognizable verification argv.
// General user-authored commands retain the separate explicit manual command UI.
export const verificationRecoveryChecks = (
  verification: ReturnType<typeof verificationSummary>,
  environment?: {
    selected?: VerificationEnvironment;
    report?: BrowserEnvironmentReport;
  },
) =>
  verification.checks
    .filter((check) => check.required && check.outcome !== "passed")
    .map((check) => {
      const unavailable = (reason: string) => ({
        name: check.name,
        command: check.command,
        argv: null,
        reason,
      });
      if (check.kind === "setup")
        return unavailable(
          "This is a setup prerequisite. Inspect the environment or prepare the required tooling before rerunning dependent checks; installation is never replayed automatically.",
        );
      if (!check.command)
        return unavailable(
          "No executable command was saved for this check. Prepare a repeatable test command before it can be run.",
        );
      const capability =
        environment?.report?.environment ===
        (environment?.selected || "isolated")
          ? environment?.report
          : undefined;
      if (
        check.prerequisite &&
        !check.prerequisite.split(";").every((reference) =>
          verification.checks.some((parent) => {
            if (
              ![parent.name, parent.command].includes(reference.trim()) &&
              !reference.trim().startsWith(`${parent.name} for `)
            )
              return false;
            if (parent.outcome === "passed") return true;
            return (
              parent.kind === "setup" &&
              !!parent.environment &&
              !parent.priorFailure &&
              /playwright|browser/i.test(`${parent.name} ${parent.command}`) &&
              capability?.direct_file.outcome === "available" &&
              capability.packages.some((pkg) =>
                ["playwright", "@playwright/test"].includes(pkg.name),
              ) &&
              capability.browsers.length > 0
            );
          }),
        )
      )
        return unavailable(`Waiting for prerequisites: ${check.prerequisite}.`);
      const argv = verificationArgv(verificationCommandText(check.command));
      if (
        !argv ||
        argv.length > 20 ||
        argv.some((arg) => !/^[\w./:@=-]+$/.test(arg))
      )
        return unavailable(
          "The recorded command needs the explicit manual command form or a repeatable test script; it cannot be safely replayed by this action.",
        );
      const [program, ...rawArgs] = argv;
      if (
        program.includes("/") &&
        !/^\/(?:usr\/bin|usr\/local\/bin|bin)\/(?:node|npm|npx|pytest|tsc|eslint)$/.test(
          program,
        )
      )
        return unavailable(
          "The recorded executable is outside the supported verification commands. Prepare a supported test command or use the explicit manual command form.",
        );
      const executable = program.split("/").at(-1);
      const args = rawArgs;
      if (executable === "npx")
        while (["--offline", "--no-install"].includes(args[0])) args.shift();
      const npm =
        executable === "npm" &&
        ((args.length === 1 && args[0] === "test") ||
          (args.length === 2 &&
            args[0] === "run" &&
            /^(?:test(?::[\w-]+)?|lint|typecheck|build|format:check)$/.test(
              args[1],
            )));
      const node =
        executable === "node" &&
        ["--check", "--test"].includes(args[0]) &&
        args
          .slice(1)
          .every(
            (arg) =>
              !arg.startsWith("-") &&
              !arg.startsWith("/") &&
              !arg.split("/").includes(".."),
          );
      const npx =
        executable === "npx" &&
        ((args[0] === "playwright" && args[1] === "test") ||
          (args[0] === "vitest" && args[1] === "run") ||
          ["tsc", "eslint"].includes(args[0]));
      const direct = ["pytest", "tsc", "eslint"].includes(executable || "");
      if (
        args.some((arg) =>
          /^(?:--fix(?:=|$)|--write(?:=|$)|--update(?:Snapshot)?(?:=|$)|-u$)/.test(
            arg,
          ),
        )
      )
        return unavailable(
          "The recorded command changes files. Prepare a check-only command or run it explicitly through the manual command form.",
        );
      return npm || node || npx || direct
        ? {
            name: check.name,
            command: check.command,
            argv: npx ? [program, "--offline", "--no-install", ...args] : argv,
            reason: null,
          }
        : unavailable(
            "No supported test command was recorded. Prepare a repeatable test command or use the explicit manual command form.",
          );
    });

export const missingVerificationChecks = (
  ...args: Parameters<typeof verificationRecoveryChecks>
) =>
  verificationRecoveryChecks(...args).flatMap((check) =>
    check.argv && check.command
      ? [{ name: check.name, command: check.command, argv: check.argv }]
      : [],
  );
