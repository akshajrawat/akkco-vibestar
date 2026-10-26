import { expect, it } from "vitest";

import { verificationSummary } from "../../backend/execution/verification/verification";

const check = (name: string, command: string | null, kind = "check") => ({
  name,
  command,
  kind,
  outcome: "blocked",
  required: true,
  detail: "Browser tooling unavailable",
  prerequisite: null,
});

const syntax = {
  id: "syntax",
  command: "node --check script.js",
  status: "passed",
  exit_code: 0,
};

const evaluate = (
  verification: unknown[],
  policy: "repository" | "extended_browser" = "repository",
) => verificationSummary({ verification }, [syntax], undefined, [], policy);

it("skips extra unexecuted manual browser checks and their exclusive setup without inventing passes", () => {
  const checks = [
    check("Registry DNS", "curl https://registry.npmjs.org", "setup"),
    {
      ...check("Browser installation", null, "setup"),
      prerequisite: "Registry DNS",
    },
    {
      ...check("Browser rendering", null),
      prerequisite: "Browser installation",
    },
    check("Repository guidance discovery", "rg --files", "setup"),
  ];

  const original = structuredClone(checks);
  const result = evaluate(checks);

  expect(result).toMatchObject({
    outcome: "passed",
    canReview: true,
    blockers: [],
    policy: "repository",
  });

  expect(result.checks.filter((check) => check.optionalReason)).toHaveLength(4);

  expect(result.checks.find((check) => check.name === "Browser rendering")).toMatchObject({
    outcome: "blocked",
    required: false,
  });

  expect(checks).toEqual(original);
  expect(evaluate(checks, "extended_browser").canReview).toBe(false);
});

it("preserves required repository browser suites, issue checks and their shared setup", () => {
  const result = evaluate([
    check("Browser setup", "npm ci", "setup"),
    { ...check("Browser rendering", null), prerequisite: "Browser setup" },
    {
      ...check("Repository browser suite", "npm run test:browser"),
      scope: "repository",
      prerequisite: "Browser setup",
    },
    { ...check("Required mobile acceptance", null), scope: "issue" },
  ]);

  expect(result.canReview).toBe(false);
  for (const name of ["Browser setup", "Repository browser suite", "Required mobile acceptance"])
    expect(result.checks.find((check) => check.name === name)?.required).toBe(true);
  expect(result.checks.find((check) => check.name === "Browser rendering")?.required).toBe(false);
});

it("never skips an observed test failure mislabeled as manual setup", () => {
  const result = verificationSummary(
    {
      verification: [
        {
          ...check("Browser test", "custom-browser-check", "setup"),
          scope: "manual",
        },
      ],
    },
    [
      syntax,
      {
        id: "failure",
        command: "custom-browser-check",
        status: "failed",
        exit_code: 1,
        stdout: "AssertionError: expected 20, received 0",
      },
    ],
    undefined,
    [],
    "repository",
  );

  expect(result).toMatchObject({ outcome: "failed", canReview: false });

  expect(result.checks[0]).toMatchObject({
    kind: "check",
    required: true,
    outcome: "failed",
  });
});

it("preserves unexecuted automated commands and explicit repository requirements even without a command", () => {
  const result = evaluate([
    check("Browser assertions", "npx playwright test"),
    { ...check("Repository browser requirement", null), scope: "repository" },
  ]);

  expect(result.canReview).toBe(false);
  expect(result.checks.slice(0, 2).every((check) => check.required)).toBe(true);
});

it.each(["repository", "issue"] as const)(
  "preserves historical %s obligations when a later report relabels them manual",
  (scope) => {
    const result = verificationSummary(
      {
        verification: [
          {
            ...check("Browser acceptance", null),
            scope: "manual",
            required: false,
          },
        ],
      },
      [syntax],
      undefined,
      [
        {
          report: {
            verification: [{ ...check("Browser acceptance", null), scope }],
          },
          commands: [],
        },
      ],
      "repository",
    );

    expect(result.canReview).toBe(false);
    expect(result.checks[0]).toMatchObject({ scope, required: true });
  },
);
