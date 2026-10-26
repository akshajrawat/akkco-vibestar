// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { VerificationRecovery } from "../../src/features/verification/VerificationRecovery";
import { FinalReviewSummary } from "../../src/features/verification/FinalReviewSummary";
import { verificationSummary } from "../../backend/execution/verification/verification";
import { workspaceDetail } from "../workspace/fixtures";
import { PipelineView } from "../../src/features/workflow/TaskEngineering";
import { VerificationSummary } from "../../src/features/verification/VerificationSummary";

afterEach(cleanup);

it("requires an explicit policy change and presents skipped browser checks as optional evidence", async () => {
  const value = detail();

  const report = {
    verification: [
      {
        name: "Manual browser rendering",
        command: null,
        kind: "check",
        outcome: "not_run",
        required: true,
        scope: "manual",
        detail: "Manual rendering was not executed",
        prerequisite: null,
      },
    ],
  };

  const commands = [
    {
      id: "syntax",
      command: "node --check script.js",
      status: "passed",
      exit_code: 0,
    },
  ];

  value.validation = verificationSummary(report, commands);
  const rpc = vi.fn(async () => ({}));

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  const ui = render(<VerificationRecovery detail={value} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Skip extra manual browser checks" }));
  expect(rpc).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Verification policy" });
  expect(within(dialog).getByText("Manual browser rendering")).toBeTruthy();

  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Use repository checks and skip extra manual checks",
    }),
  );

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.verification.policy", {
      id: value.task.id,
      policy: "repository",
      confirmed: true,
    }),
  );

  ui.unmount();
  value.task.verification_policy = "repository";
  value.validation = verificationSummary(report, commands, undefined, [], "repository");
  render(<VerificationSummary detail={value} />);
  expect(screen.getByText("Manual browser rendering · skipped (optional)")).toBeTruthy();
  expect(screen.queryByText(/required checks remain unverified/)).toBeNull();
  expect(screen.queryByLabelText("Root blockers")).toBeNull();
});

it("shows genuine review concerns as changes requested with evidence and a Codex repair action even when test checks passed", () => {
  const value = detail();

  value.task = {
    ...value.task,
    stage: 6,
    status: "awaiting_approval",
    approval_gate: "final_review",
    final_review_verdict: "changes_requested",
  };

  value.validation = verificationSummary({}, [
    { id: "pass", command: "npm test", status: "passed", exit_code: 0 },
  ]);

  value.artifacts.push({
    id: "changes-review",
    stage: 5,
    kind: "plan",
    created_at: value.task.updated_at,
    content: JSON.stringify({
      approval: "changes_requested",
      summary: "Incorrect rendering path",
      findings: ["Result rows disappear on reload"],
      testsRun: [],
      testsNotRun: [],
      issues: [
        {
          severity: "high",
          file: "script.js",
          summary: "Rows disappear on reload",
          evidence: "The render target is removed before rows are appended",
        },
      ],
    }),
  });

  const pipeline = render(
    <PipelineView detail={value} busy={false} action={vi.fn()} finalize={vi.fn()} />,
  );

  expect(
    pipeline.container.querySelector(".pipeline-step.changes_requested .pipeline-icon.failure"),
  ).toBeTruthy();

  expect(screen.getByRole("button", { name: "Fix with Codex" })).toBeTruthy();
  pipeline.unmount();
  render(<FinalReviewSummary detail={value} changes={vi.fn()} tests={vi.fn()} />);
  expect(screen.getByText("Code review: Changes requested")).toBeTruthy();
  expect(screen.getByText("script.js", { selector: "code" })).toBeTruthy();

  expect(
    screen.getAllByText("The render target is removed before rows are appended", { selector: "p" })
      .length,
  ).toBeGreaterThan(0);
});

const detail = () => {
  const value = workspaceDetail("v2-ui");
  value.task.stage = 4;
  value.task.status = "verification_blocked";

  value.artifacts.push({
    id: "implementation",
    stage: 3,
    kind: "plan",
    content: "{}",
    created_at: value.task.updated_at,
  });

  value.validation = verificationSummary(
    {
      verification: [
        {
          name: "Browser tooling",
          command: "npm ci",
          kind: "setup",
          outcome: "blocked",
          required: true,
          detail: "EAI_AGAIN registry.npmjs.org",
          prerequisite: null,
        },
        {
          name: "Browser rendering",
          command: "npm run test:browser",
          kind: "check",
          outcome: "blocked",
          required: true,
          detail: "Not executed",
          prerequisite: "Browser tooling",
        },
      ],
    },
    [
      {
        id: "syntax",
        command: "node --check script.js",
        status: "passed",
        exit_code: 0,
      },
    ],
  );

  return value;
};

it("explains non-runnable browser checks, exposes diagnostics and requires explicit preparation authorization", async () => {
  const value = detail();
  value.validation!.checks.find((check) => check.name === "Browser rendering")!.command = null;
  const rpc = vi.fn(async () => ({}));

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  render(<VerificationRecovery detail={value} onError={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Run missing checks" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Prepare missing checks" }));
  let dialog = screen.getByRole("dialog", { name: "Prepare missing checks" });
  expect(within(dialog).getByText(/No executable command was saved/)).toBeTruthy();
  expect(within(dialog).getByText(/setup prerequisite/)).toBeTruthy();
  expect(within(dialog).getByText("Browser verification environment")).toBeTruthy();
  expect(rpc).not.toHaveBeenCalled();

  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Prepare runnable checks with Codex",
    }),
  );

  dialog = screen.getByRole("dialog", { name: "Fix with Codex" });
  expect(within(dialog).getByText(/prepares repeatable test scripts/)).toBeTruthy();
  expect(rpc).not.toHaveBeenCalled();

  const authorize = within(dialog).getByRole("button", {
    name: "Authorize one Codex fix",
  });

  expect(document.activeElement).toBe(authorize);
  fireEvent.click(authorize);

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.verification.fix",
      expect.objectContaining({
        id: value.task.id,
        request_id: expect.any(String),
      }),
    ),
  );
});

it("executes a runnable recorded check separately from unavailable requirements without invoking preparation", async () => {
  const value = detail();
  const recorded = "/bin/bash -lc 'node --check script.js'";

  value.validation = verificationSummary(
    {
      verification: [
        {
          name: "Additional syntax",
          command: recorded,
          kind: "check",
          outcome: "not_run",
          required: true,
          detail: "Recorded verifier",
          prerequisite: null,
        },
      ],
    },
    [],
  );

  const rpc = vi.fn(async () => ({}));

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  render(<VerificationRecovery detail={value} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Run missing checks" }));
  expect(rpc).not.toHaveBeenCalled();

  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Run Additional syntax",
    }),
  );

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.verification.run", {
      id: value.task.id,
      command: recorded,
    }),
  );

  expect(rpc).toHaveBeenCalledTimes(1);
});

it("keeps a visible approval handoff when missing checks have passed but host validation still needs rechecking", () => {
  const value = detail();

  value.task.preparation_timing = {
    started_at: "2026-10-25T12:00:00Z",
    ended_at: "2026-10-25T12:00:25Z",
  };

  value.validation = verificationSummary({}, [
    {
      id: "check",
      command: "node --check script.js",
      status: "passed",
      exit_code: 0,
    },
  ]);

  render(<PipelineView detail={value} busy={false} action={vi.fn()} finalize={vi.fn()} />);

  expect(
    screen.getByText(
      "Required checks passed. Recheck saved evidence to open implementation approval.",
    ),
  ).toBeTruthy();

  const recovery = screen.getByText(
    "Required checks passed. Recheck saved evidence to open implementation approval.",
  ).parentElement!;

  expect(within(recovery).getByRole("button", { name: "Recheck saved evidence" })).toBeTruthy();
  expect(screen.getByText("Host · 25s")).toBeTruthy();
});

it("keeps gap review explicit, shows outstanding checks and requires acknowledgment before any provider starts", async () => {
  const value = detail();

  const rpc = vi.fn(async () => ({
    eligible: true,
    fingerprint: "current-tree",
    evidence_hash: "current-evidence",
    checks: value.validation!.checks.filter((check) => check.outcome !== "passed"),
  }));

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  const before = structuredClone(value);
  render(<VerificationRecovery detail={value} onError={vi.fn()} />);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue to independent review" }));
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect current gaps" }));

  const approve = await screen.findByRole("button", {
    name: "Approve implementation & start independent review",
  });

  expect((approve as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByRole("dialog")).getByText("Browser rendering")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /acknowledge these verification gaps/,
    }),
  );

  fireEvent.click(approve);

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.verification.continueReview", {
      id: value.task.id,
      artifact_id: "implementation",
      acknowledge_gaps: true,
      fingerprint: "current-tree",
      evidence_hash: "current-evidence",
    }),
  );

  expect(value).toEqual(before);
});

it("does not offer review with gaps for actual failures, and requires a separate one-iteration Codex request", async () => {
  const value = detail();

  value.validation = verificationSummary({}, [
    { id: "assertion", command: "npm test", status: "failed", exit_code: 1 },
  ]);

  value.task.status = "failed";
  const rpc = vi.fn(async () => ({}));

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  const ui = render(<VerificationRecovery detail={value} onError={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Continue to independent review" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fix with Codex" }));
  expect(rpc).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize one Codex fix" }));

  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "task.verification.fix",
      expect.objectContaining({
        id: value.task.id,
        request_id: expect.any(String),
      }),
    ),
  );

  ui.unmount();
});

it("shows a code approval separately from unverified browser coverage and next steps", () => {
  const value = detail();

  value.artifacts.push({
    id: "review",
    stage: 5,
    kind: "plan",
    created_at: value.task.updated_at,
    content: JSON.stringify({
      approval: "approved",
      summary: "Source inspected",
      findings: [],
      testsRun: [],
      testsNotRun: ["Browser rendering"],
    }),
  });

  render(<FinalReviewSummary detail={value} changes={vi.fn()} tests={vi.fn()} />);
  expect(screen.getByText("Code review: Approved")).toBeTruthy();
  expect(screen.getByText("Tests: 1 passed, 1 unverified")).toBeTruthy();
  expect(screen.getByText("Unverified: Browser rendering")).toBeTruthy();
  expect(screen.getByText(/Keep reviewed changes locally/)).toBeTruthy();
});
