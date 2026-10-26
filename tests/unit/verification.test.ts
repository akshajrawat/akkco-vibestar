import { expect, it } from "vitest";
import {
  commandVerification,
  verificationSummary,
} from "../../backend/execution/verification/verification";
import { validatePlan } from "../../backend/execution/providers/contracts";
import { codexResult, codexSchema } from "../../backend/execution/providers/codex-schema";
import { schemaFor } from "../../backend/execution/providers/contracts";

const check = (
  name: string,
  outcome: "passed" | "failed" | "blocked" | "interrupted" | "not_run" | "unknown",
  command: string | null = null,
) => ({
  name,
  outcome,
  command,
  kind: "check" as const,
  required: true,
  detail: name,
  prerequisite: null,
});
const command = (name: string, exit: number | null, status = exit === 0 ? "passed" : "failed") => ({
  id: name,
  run_id: "implementation",
  command: name,
  status,
  exit_code: exit,
});
const report = {
  summary: "Multiplication table",
  filesChanged: ["index.html", "script.js", "style.css"],
  testsPassed: [],
  testsFailed: [],
  testsSkipped: [],
  remainingRisks: [],
  verification: [
    check("JavaScript syntax", "passed", "node --check script.js"),
    check("Generated table", "passed"),
    check("Source structure", "passed"),
    {
      ...check("Playwright installation", "interrupted", "npm install --no-save playwright"),
      kind: "setup",
      detail: "Dependency installation interrupted with exit 130",
    },
    {
      ...check("Browser rendering and accessibility", "blocked", "npx playwright test"),
      prerequisite: "Playwright installation",
      detail: "Browser tests did not run because tooling setup was interrupted.",
    },
  ],
};

it("separates passing code checks, interrupted setup and blocked browser checks even after a passing host diff check", () => {
  const summary = verificationSummary(report, [
    command("node --check script.js", 0),
    command("npm install --no-save playwright", 130),
    { ...command('["git","diff","--check","base","--"]', 0), run_id: null },
  ]);
  expect(summary).toMatchObject({ outcome: "blocked", canReview: false });
  expect(summary.summary).toContain("Recorded checks passed");
  expect(summary.summary).toContain("Browser rendering and accessibility (blocked)");
  expect(summary.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "JavaScript syntax",
        outcome: "passed",
        source: "observed_command",
      }),
      expect.objectContaining({
        name: "Playwright installation",
        outcome: "interrupted",
        kind: "setup",
      }),
      expect.objectContaining({ outcome: "passed", source: "vibestar" }),
    ]),
  );
});

it.each([
  ["npm test", 1, "failed"],
  ["node --test assertions.cjs", 1, "failed"],
  ["npm run lint", 1, "failed"],
  ["npm run typecheck", 2, "failed"],
  ["npm run build", 1, "failed"],
  ["node --check script.js", 0, "passed"],
  ["npm ci", 1, "blocked"],
  ["npx playwright install chromium", 1, "blocked"],
  ["npx playwright install chromium", 130, "interrupted"],
  ["npx playwright test", 1, "failed"],
  ["npm test", 130, "failed"],
  ["custom-check", 130, "unknown"],
  ["npm install x && npm test", 1, "unknown"],
  ["npm test", null, "unknown"],
])("classifies %s exit %s using command purpose and evidence: %s", (name, exit, outcome) => {
  expect(commandVerification(command(name, exit)).outcome).toBe(outcome);
});

it("never downgrades an observed assertion failure to a provider-reported pass or setup blocker", () => {
  for (const outcome of ["passed", "blocked"] as const) {
    const summary = verificationSummary(
      {
        verification: [
          {
            ...check("Assertions", outcome, "npm test"),
            kind: "setup",
            required: false,
          },
        ],
      },
      [command("npm test", 1)],
    );
    expect(summary).toMatchObject({ outcome: "failed", canReview: false });
    expect(summary.checks[0]).toMatchObject({
      outcome: "failed",
      reportedOutcome: outcome,
      kind: "check",
    });
  }
});

it.each(["not_run", "unknown", "blocked", "interrupted"] as const)(
  "keeps a required %s check unresolved",
  (outcome) => {
    expect(
      verificationSummary({ verification: [check("Required browser", outcome)] }, [
        command("node --check script.js", 0),
      ]),
    ).toMatchObject({ outcome: "blocked", canReview: false });
  },
);

it("does not let a successful dependency installation count as successful verification", () => {
  expect(verificationSummary({}, [command("npm ci", 0)])).toMatchObject({
    outcome: "unknown",
    canReview: false,
  });
});

it("does not count a provider-identified custom setup script as application verification", () => {
  const result = verificationSummary(
    {
      verification: [
        {
          ...check("Custom setup", "passed", "node prepare-browser.cjs"),
          kind: "setup",
        },
      ],
    },
    [command("node prepare-browser.cjs", 0)],
  );
  expect(result).toMatchObject({ outcome: "unknown", canReview: false });
  expect(result.checks[0]).toMatchObject({ kind: "setup", outcome: "passed" });
});

it("retains contradictory provider failures unless matching observed evidence resolves the check", () => {
  const report = {
    testsFailed: ["Assertions"],
    verification: [check("Assertions", "passed", "npm test")],
  };
  expect(verificationSummary(report, []).canReview).toBe(false);
  expect(verificationSummary(report, [command("npm test", 0)]).canReview).toBe(true);
});

it("retains historical reports as ambiguous provider evidence without rewriting them or waiving failures", () => {
  const legacy = {
    ...report,
    verification: undefined,
    testsFailed: ["Playwright installation exited 130"],
    testsSkipped: ["Browser accessibility"],
  };
  const original = structuredClone(legacy);
  const summary = verificationSummary(legacy, [command("node --check script.js", 0)]);
  expect(summary).toMatchObject({ outcome: "blocked", canReview: false });
  expect(summary.checks[0]).toMatchObject({
    legacy: true,
    source: "provider_reported",
    outcome: "unknown",
  });
  expect(summary.checks[1]).toMatchObject({ outcome: "not_run" });
  expect(legacy).toEqual(original);
  expect(validatePlan(3, legacy)).toEqual(legacy);
});

it("supports optional verification through the official Codex nullable schema transport", () => {
  const schema = schemaFor(3);
  const transported = codexSchema(schema);
  expect(transported.required).toContain("verification");
  const restored = codexResult(schema, { ...report, verification: null });
  expect(validatePlan(3, restored)).not.toHaveProperty("verification");
  expect(validatePlan(3, report)).toEqual(report);
});

it("uses the latest exact-command retry while retaining unresolved dependent checks", () => {
  const commands = [
    command("npm ci", 1),
    { ...command('["npm","ci"]', 0), id: "retry" },
    command("npx playwright test", 0),
  ];
  const summary = verificationSummary(
    {
      verification: [
        { ...check("Install", "blocked", "npm ci"), kind: "setup" },
        check("Browser", "blocked", "npx playwright test"),
      ],
    },
    commands,
  );
  expect(summary).toMatchObject({ outcome: "passed", canReview: true });
  expect(summary.checks[0]).toMatchObject({
    commandId: "retry",
    outcome: "passed",
  });
  const incomplete = verificationSummary(report, [command("npm install --no-save playwright", 0)]);
  expect(incomplete.canReview).toBe(false);
});

it("treats completion without an exit and explicit cancellation with exit zero as unverified", () => {
  expect(commandVerification(command("npm test", null, "completed")).outcome).toBe("unknown");
  expect(commandVerification(command("npm test", 0, "interrupted")).outcome).toBe("interrupted");
});

it("keeps malformed structured reports unresolved", () => {
  expect(
    verificationSummary({ verification: [{ name: "Missing fields" }] }, [
      command("node --check script.js", 0),
    ]),
  ).toMatchObject({ outcome: "blocked", canReview: false });
});

it("keeps a missing required host diff check unresolved despite passing implementation evidence", () => {
  const diff = JSON.stringify(["git", "diff", "--check", "pinned-base", "--"]);
  const summary = verificationSummary(
    { verification: [check("Syntax", "passed", "node --check script.js")] },
    [command("node --check script.js", 0)],
    diff,
  );
  expect(summary).toMatchObject({ outcome: "blocked", canReview: false });
  expect(summary.checks.at(-1)).toMatchObject({
    source: "vibestar",
    outcome: "not_run",
    name: "Pinned-base diff hygiene",
  });
});

it("requires the exact pinned-base check rather than an unrelated passing Git check", () => {
  const diff = JSON.stringify(["git", "diff", "--check", "pinned-base", "--"]);
  expect(
    verificationSummary({}, [command("git diff --check other-base --", 0)], diff).canReview,
  ).toBe(false);
  expect(verificationSummary({}, [{ ...command(diff, 0), run_id: null }], diff).canReview).toBe(
    true,
  );
});

it.each([
  ["npm test", "Error: getaddrinfo EAI_AGAIN registry.npmjs.org", "DNS resolution unavailable"],
  [
    "npx playwright test",
    "browserType.launch: Executable doesn't exist at /cache/chromium",
    "Browser tooling unavailable",
  ],
  ["npm test", "Error: listen EPERM 127.0.0.1", "Loopback socket denied"],
  ["npm test", "unsupported platform: requires macOS", "Platform unavailable"],
])(
  "classifies an observed startup failure in %s as environmental without passing it",
  (name, stderr, environment) => {
    const evidence = commandVerification({ ...command(name, 1), stderr });
    expect(evidence).toMatchObject({ outcome: "blocked", environment });
  },
);

it("keeps actual assertions failed even when the output also mentions a DNS problem", () => {
  expect(
    commandVerification({
      ...command("npm test", 1),
      stdout: "AssertionError: expected 10 rows; EAI_AGAIN mentioned in fixture",
    }).outcome,
  ).toBe("failed");
});

it("links exact multiple prerequisite references transitively and keeps ambiguous dependencies ineligible", () => {
  const setup = {
    ...check("Browser setup", "blocked", "npm ci"),
    kind: "setup",
    detail: "EAI_AGAIN registry.npmjs.org",
  };
  const server = {
    ...check("Server setup", "blocked"),
    kind: "setup",
    required: false,
    detail: "listen EPERM 127.0.0.1",
  };
  const loading = {
    ...check("Loading", "blocked"),
    prerequisite: "Browser setup; Server setup for HTTP launch",
  };
  const layout = { ...check("Layout", "blocked"), prerequisite: "Loading" };
  const report = { verification: [setup, server, loading, layout] };
  const result = verificationSummary(report, [command("node --check script.js", 0)]);
  expect(result).toMatchObject({ canReview: false, canReviewWithGaps: true });
  expect(result.blockers[0].checks.map((check) => check.name)).toEqual([
    "Browser setup",
    "Loading",
    "Layout",
  ]);
  expect(result.blockers[1].checks.map((check) => check.name)).toEqual([
    "Server setup",
    "Loading",
    "Layout",
  ]);
  expect(
    verificationSummary(
      {
        verification: [
          ...report.verification,
          {
            ...check("Unknown check", "not_run"),
            prerequisite: "Unknown dependency",
          },
        ],
      },
      [command("node --check script.js", 0)],
    ).canReviewWithGaps,
  ).toBe(false);
});

it("never uses an unobserved provider pass to certify a required check", () => {
  const result = verificationSummary(
    { verification: [check("Assertions", "passed", "npm test")] },
    [command("git diff --check", 0)],
  );
  expect(result).toMatchObject({ canReview: false, canReviewWithGaps: false });
  expect(result.checks[0]).toMatchObject({
    source: "provider_reported",
    outcome: "unknown",
    reportedOutcome: "passed",
  });
});

it("does not count a genuinely passed dependent check as an unresolved root-blocker item", () => {
  const summary = verificationSummary(
    {
      verification: [
        {
          ...check("Browser setup", "blocked", "npm ci"),
          kind: "setup",
          detail: "EAI_AGAIN registry.npmjs.org",
        },
        {
          ...check("Direct-file check", "passed", "node --test browser.cjs"),
          prerequisite: "Browser setup",
        },
      ],
    },
    [command("node --test browser.cjs", 0)],
  );
  expect(summary.blockers[0].checks.map((check) => check.name)).toEqual(["Browser setup"]);
  expect(summary.checks.find((check) => check.name === "Direct-file check")?.outcome).toBe(
    "passed",
  );
});

it("retains required checks across implementations without reusing stale passing outcomes", () => {
  const history = [
    {
      report: { verification: [check("Assertions", "passed", "npm test")] },
      commands: [command("npm test", 0)],
    },
  ];
  const missing = verificationSummary({}, [command("git diff --check", 0)], undefined, history);
  expect(missing).toMatchObject({ canReview: false, canReviewWithGaps: false });
  expect(missing.checks.find((check) => check.name === "Assertions")).toMatchObject({
    required: true,
    outcome: "not_run",
  });
  expect(verificationSummary({}, [command("npm test", 0)], undefined, history).canReview).toBe(
    true,
  );
});

it("keeps failures pending through blocked attempts and clears them only after chronological observed passes", () => {
  const report = { verification: [check("Assertions", "blocked", "npm test")] };
  const failed = {
    ...command("npm test", 1),
    stdout: "AssertionError: incorrect table",
  };
  const environment = {
    ...command("npm test", 1),
    stdout: "getaddrinfo EAI_AGAIN registry.npmjs.org",
  };
  const hygiene = command("git diff --check", 0);
  expect(verificationSummary(report, [failed, environment, hygiene]).canReviewWithGaps).toBe(false);
  expect(
    verificationSummary(report, [failed, command("npm test", 0), environment, hygiene])
      .canReviewWithGaps,
  ).toBe(true);
  const history = [
    { report, commands: [failed] },
    { report, commands: [command("npm test", 0)] },
  ];
  expect(
    verificationSummary(report, [environment, hygiene], undefined, history).canReviewWithGaps,
  ).toBe(true);
});

it("retains stable requirements when ephemeral test commands move, requiring an observed passing replacement", () => {
  const old = check("Generated rows", "passed", "python3 /tmp/old-proof/check.py");
  const replacement = check("Generated rows", "passed", "python3 /tmp/new-proof/check.py");
  const history = [
    {
      report: { verification: [old], testsPassed: [old.name] },
      commands: [command(old.command!, 1)],
    },
  ];
  const report = { verification: [replacement] };
  expect(verificationSummary(report, [], undefined, history).canReview).toBe(false);
  expect(
    verificationSummary(
      report,
      [
        {
          ...command(replacement.command!, 1),
          stderr: "getaddrinfo EAI_AGAIN registry.npmjs.org",
        },
        command("git diff --check", 0),
      ],
      undefined,
      history,
    ).canReviewWithGaps,
  ).toBe(false);
  expect(
    verificationSummary(report, [command(replacement.command!, 0)], undefined, history).canReview,
  ).toBe(true);
  const renamed = {
    ...replacement,
    name: "Verified generated rows",
    command: old.command,
  };
  expect(
    verificationSummary({ verification: [renamed] }, [command(old.command!, 0)], undefined, history)
      .canReview,
  ).toBe(true);
  const ambiguous = [
    {
      report: {
        verification: [old, { ...old, command: "python3 /tmp/other-platform/check.py" }],
      },
      commands: [],
    },
  ];
  expect(
    verificationSummary(report, [command(replacement.command!, 0)], undefined, ambiguous).canReview,
  ).toBe(false);
});

it("does not waive a prior assertion failure when the repair encounters an environment error", () => {
  const history = [
    {
      report: { verification: [check("Assertions", "passed", "npm test")] },
      commands: [
        {
          ...command("npm test", 1),
          stderr: "AssertionError: expected 10 rows",
        },
      ],
    },
  ];
  const current = {
    verification: [
      {
        ...check("Assertions", "blocked", "npm test"),
        required: false,
        kind: "setup",
      },
    ],
  };
  const blocked = verificationSummary(
    current,
    [
      {
        ...command("npm test", 1),
        stderr: "getaddrinfo EAI_AGAIN registry.npmjs.org",
      },
      command("git diff --check", 0),
    ],
    undefined,
    history,
  );
  expect(blocked).toMatchObject({ canReview: false, canReviewWithGaps: false });
  expect(blocked.checks.find((check) => check.name === "Assertions")).toMatchObject({
    kind: "check",
    required: true,
    outcome: "blocked",
    priorFailure: true,
  });
  expect(verificationSummary(current, [command("npm test", 0)], undefined, history).canReview).toBe(
    true,
  );
});

it("preserves observed obligations and ambiguous legacy failures even when a later report omits or downgrades them", () => {
  const history = [
    {
      report: { testsFailed: ["Browser assertions"] },
      commands: [command("npm test", 1)],
    },
  ];
  const summary = verificationSummary(
    {
      verification: [
        {
          ...check("Browser assertions", "blocked", "npm test"),
          kind: "setup",
          required: false,
          detail: "EAI_AGAIN registry.npmjs.org",
        },
      ],
    },
    [{ ...command("npm test", 1), stderr: "EAI_AGAIN registry.npmjs.org" }],
    undefined,
    history,
  );
  expect(summary).toMatchObject({ canReview: false, canReviewWithGaps: false });
  expect(summary.checks.find((check) => check.name === "Browser assertions")).toMatchObject({
    required: true,
    priorFailure: true,
  });
  const passedHistory = [{ report: {}, commands: [command("node --test assertions.cjs", 0)] }];
  expect(
    verificationSummary({}, [command("git diff --check", 0)], undefined, passedHistory).canReview,
  ).toBe(false);
});
