import { expect, it } from "vitest";
import { verificationSummary } from "../../backend/execution/verification/verification";
import { missingVerificationChecks } from "../../backend/execution/verification/verification-recovery";

const check = (name: string, command: string, kind = "check") => ({
  name,
  command,
  kind,
  outcome: "passed",
  required: true,
  detail: "Provider report; execution evidence must establish the result.",
  prerequisite: null,
});

const observed = (command: string, exit_code = 0, stdout = "") => ({
  id: command,
  run_id: "implementation",
  command,
  status: exit_code ? "failed" : "passed",
  exit_code,
  stdout,
});

it.each([
  "/bin/bash -lc 'node --check script.js'",
  '/usr/bin/bash -lc "node --check script.js"',
  "bash -c 'node --check script.js'",
  "sh -c 'node --check script.js'",
  JSON.stringify(["/bin/bash", "-lc", "node --check script.js"]),
])("links an exact recorded shell wrapper to the reported check: %s", (command) => {
  const result = verificationSummary(
    { verification: [check("Syntax", "node --check script.js")] },
    [observed(command)],
  );
  expect(result).toMatchObject({ canReview: true });
  expect(result.checks).toMatchObject([{ command, outcome: "passed", source: "observed_command" }]);
});

it("links the complete logged script without dropping pipelines or granting shell execution to recovery", () => {
  const script = "set -o pipefail && node --check script.js 2>&1 | tee /tmp/syntax.log";
  const command = `/bin/bash -lc '${script}'`;
  const report = { verification: [check("Syntax", script)] };
  expect(verificationSummary(report, [observed(command)]).canReview).toBe(true);
  expect(
    verificationSummary(report, [observed("/bin/bash -lc 'node --check script.js'")]).canReview,
  ).toBe(false);
  const failed = verificationSummary(report, [observed(command, 1, "SyntaxError: Invalid token")]);
  expect(failed).toMatchObject({ outcome: "failed", canReviewWithGaps: false });
  expect(missingVerificationChecks(failed)).toEqual([]);
});

it("preserves literal embedded quotes and expansions inside a quoted script", () => {
  const script = "node -e 'console.log(`${process.version}: \"available\"`)'";
  const command = "/bin/bash -lc '" + script.replaceAll("'", "'\"'\"'") + "'";
  const result = verificationSummary({ verification: [check("Inventory", script, "setup")] }, [
    observed(command),
  ]);
  expect(result.checks[0]).toMatchObject({
    outcome: "passed",
    source: "observed_command",
  });
});

it.each([
  "/tmp/bash -lc 'node --check script.js'",
  "/bin/bash -lc 'node --check script.js' ignored",
  "/bin/bash -lc 'node --check script.js' && true",
  "/bin/bash -lc 'node --check script.js' # comment",
  "/bin/bash -lc 'node --check script.js",
  '/bin/bash -lc "node --check $FILE"',
  '/bin/bash -lc "node --check `get-file`"',
])(
  "does not infer a reported check from an ambiguous or different shell invocation: %s",
  (command) => {
    const result = verificationSummary(
      { verification: [check("Syntax", "node --check script.js")] },
      [observed(command)],
    );
    expect(result).toMatchObject({
      canReview: false,
      canReviewWithGaps: false,
    });
    expect(result.checks[0]).toMatchObject({
      outcome: "unknown",
      source: "provider_reported",
    });
  },
);

it("recognizes curl DNS failure and keeps dependent browser setup under that root while permitting only acknowledged review", () => {
  const dns =
    "set -o pipefail && (getent hosts registry.npmjs.org; curl -I --max-time 10 https://registry.npmjs.org/playwright) 2>&1 | tee /tmp/dns.log";
  const report = {
    verification: [
      check("Syntax", "node --check script.js"),
      { ...check("DNS preflight", dns, "setup"), outcome: "blocked" },
      {
        ...check("Install browser", "npm install playwright", "setup"),
        outcome: "blocked",
        prerequisite: "DNS preflight",
      },
      {
        ...check("Render", "npx playwright test"),
        outcome: "blocked",
        prerequisite: "Install browser",
      },
    ],
  };
  const result = verificationSummary(report, [
    observed("/bin/bash -lc 'node --check script.js'"),
    observed(`/bin/bash -lc '${dns}'`, 6, "curl: (6) Could not resolve host: registry.npmjs.org"),
  ]);
  expect(result).toMatchObject({
    outcome: "blocked",
    canReview: false,
    canReviewWithGaps: true,
  });
  expect(result.blockers).toMatchObject([
    {
      title: "DNS resolution unavailable",
      checks: [{ name: "DNS preflight" }, { name: "Install browser" }, { name: "Render" }],
    },
  ]);
  expect(result.blockers).toHaveLength(1);
  expect(result.checks.find((check) => check.name === "Render")?.outcome).toBe("blocked");
});

it("does not turn a setup with an unknown prerequisite into an environmental waiver", () => {
  const result = verificationSummary(
    {
      verification: [
        check("Syntax", "node --check script.js"),
        {
          ...check("Install browser", "npm install playwright", "setup"),
          outcome: "blocked",
          prerequisite: "Unrecorded preflight",
        },
      ],
    },
    [observed("node --check script.js")],
  );
  expect(result.canReviewWithGaps).toBe(false);
});

it("keeps genuine failures ahead of DNS wording and prevents a wrapped test from being mislabeled as setup", () => {
  const result = verificationSummary(
    {
      verification: [{ ...check("Tests", "npm test", "setup"), outcome: "passed" }],
    },
    [
      observed(
        "/bin/bash -lc 'npm test'",
        1,
        "AssertionError: expected text 'Could not resolve host: registry.npmjs.org'",
      ),
    ],
  );
  expect(result).toMatchObject({ outcome: "failed", canReviewWithGaps: false });
  expect(result.checks[0]).toMatchObject({
    kind: "check",
    outcome: "failed",
    source: "observed_command",
  });
});
