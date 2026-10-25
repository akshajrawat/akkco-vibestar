import { expect, it } from "vitest";
import { verificationSummary } from "../../backend/execution/verification";
import {
  missingVerificationChecks,
  verificationRecoveryChecks,
} from "../../backend/execution/verification-recovery";

const check = (command: string) => ({
  name: command,
  command,
  kind: "check" as const,
  outcome: "not_run" as const,
  required: true,
  detail: "Required recorded command",
  prerequisite: null,
});

it("offers recognizable recorded checks with local-only package execution, excluding installation, shell prose and mutating flags", () => {
  const commands = [
    "npx playwright test",
    "npx --offline --no-install vitest run",
    "pytest tests",
    "/usr/bin/node --check script.js",
    "npm install playwright",
    "npx playwright install",
    "npm test && curl example.invalid",
    "/tmp/npx playwright test",
    "npx eslint --fix=true",
  ];
  const summary = verificationSummary(
    { verification: commands.map(check) },
    [],
  );
  const candidates = missingVerificationChecks(summary);
  expect(candidates.map((candidate) => candidate.command)).toEqual(
    commands.slice(0, 4),
  );
  expect(candidates[0].argv).toEqual([
    "npx",
    "--offline",
    "--no-install",
    "playwright",
    "test",
  ]);
  expect(candidates[1].argv).toEqual([
    "npx",
    "--offline",
    "--no-install",
    "vitest",
    "run",
  ]);
  const observed = verificationSummary(
    { verification: [check("npx playwright test")] },
    [
      {
        id: "browser",
        command: JSON.stringify(candidates[0].argv),
        status: "passed",
        exit_code: 0,
      },
    ],
  );
  expect(observed).toMatchObject({ canReview: true });
  expect(observed.checks[0]).toMatchObject({
    source: "observed_command",
    outcome: "passed",
  });
  expect(
    verificationSummary({ verification: [check("npx playwright test")] }, [
      {
        id: "different-browser-command",
        command: JSON.stringify([...candidates[0].argv, "--offline"]),
        status: "passed",
        exit_code: 0,
      },
    ]).canReview,
  ).toBe(false);
});

it("uses matching selected browser capabilities to offer direct-file checks without waiving setup evidence or unrelated HTTP prerequisites", () => {
  const browser = {
    ...check("npx playwright test"),
    name: "Direct-file browser",
    outcome: "blocked" as const,
    prerequisite: "Playwright setup",
  };
  const summary = verificationSummary(
    {
      verification: [
        {
          ...check("npm install playwright"),
          name: "Playwright setup",
          kind: "setup",
          outcome: "blocked",
          detail: "EAI_AGAIN registry.npmjs.org",
        },
        browser,
        {
          ...check("serve"),
          name: "HTTP setup",
          kind: "setup",
          outcome: "blocked",
          detail: "listen EPERM 127.0.0.1",
        },
        {
          ...check("npm run test:http"),
          name: "HTTP browser",
          outcome: "blocked",
          prerequisite: "Playwright setup; HTTP setup",
        },
      ],
    },
    [],
  );
  const available = {
    outcome: "available" as const,
    detail: "Observed fixed capability fixture",
  };
  const report = {
    checked_at: "2026-10-25T12:00:00Z",
    environment: "installed_browsers" as const,
    packages: [
      {
        name: "playwright",
        path: "/project/node_modules/playwright/package.json",
      },
    ],
    browsers: ["/usr/bin/chromium"],
    dns: available,
    socket: { outcome: "blocked" as const, detail: "listen EPERM" },
    direct_file: available,
    http: { outcome: "blocked" as const, detail: "HTTP unavailable" },
    note: "Capability only",
  };
  expect(missingVerificationChecks(summary)).toEqual([]);
  expect(
    missingVerificationChecks(summary, { selected: "isolated", report }),
  ).toEqual([]);
  expect(
    missingVerificationChecks(summary, {
      selected: "installed_browsers",
      report,
    }).map((candidate) => candidate.name),
  ).toEqual(["Direct-file browser"]);
  expect(summary.canReview).toBe(false);
  expect(
    summary.checks.find((check) => check.name === "Playwright setup")?.outcome,
  ).toBe("blocked");
});

it("explains missing commands, unavailable prerequisites, setup and unsupported commands without losing any requirement", () => {
  const report = {
    verification: [
      {
        ...check("npm install playwright"),
        name: "Browser setup",
        kind: "setup",
        outcome: "blocked",
        detail: "EAI_AGAIN registry.npmjs.org",
      },
      {
        ...check("npx playwright test"),
        name: "Browser assertions",
        prerequisite: "Browser setup",
      },
      { ...check(""), name: "Responsive layout", command: null },
      check("npm test && curl example.invalid"),
    ],
  };
  const verification = verificationSummary(report, []);
  const recovery = verificationRecoveryChecks(verification);
  expect(recovery.map((check) => check.name)).toEqual(
    report.verification.map((check) => check.name),
  );
  expect(recovery.every((check) => check.argv === null)).toBe(true);
  expect(recovery[0].reason).toContain("setup prerequisite");
  expect(recovery[1].reason).toBe("Waiting for prerequisites: Browser setup.");
  expect(recovery[2].reason).toContain("No executable command was saved");
  expect(recovery[3].reason).toContain("manual command form");
  expect(missingVerificationChecks(verification)).toEqual([]);
});

it("replays a literal simple shell-wrapped check as validated direct argv and retains the recorded identity", () => {
  const recorded = "/bin/bash -lc 'node --check script.js'";
  const verification = verificationSummary(
    { verification: [check(recorded)] },
    [],
  );
  expect(missingVerificationChecks(verification)).toEqual([
    {
      name: recorded,
      command: recorded,
      argv: ["node", "--check", "script.js"],
    },
  ]);
  expect(
    missingVerificationChecks(
      verificationSummary(
        {
          verification: [
            check("/bin/bash -lc 'npm install playwright'"),
            check("/bin/bash -lc 'node --check script.js && true'"),
          ],
        },
        [],
      ),
    ),
  ).toEqual([]);
});
