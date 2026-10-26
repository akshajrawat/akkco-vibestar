// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TestsView } from "../../src/features/verification/TestsView";
import { RunError } from "../../src/features/chat/RunError";
import type { Detail } from "../../src/lib/types";
import { verificationSummary } from "../../backend/execution/verification/verification";
import { AgentTimeline } from "../../src/features/chat/AgentTimeline";

afterEach(cleanup);

it("shows an observed socket denial as blocked in chat while keeping the exact failed exit evidence", () => {
  const data = {
    command: JSON.stringify(["node", "-e", "startServer()"]),
    status: "failed",
    exit_code: 1,
    stdout: "Error: listen EPERM 127.0.0.1:8000",
  };
  render(
    <AgentTimeline
      runs={[]}
      events={[
        {
          id: 1,
          run_id: "socket-run",
          task_id: null,
          timestamp: "2026-10-25T12:00:00Z",
          kind: "command.finished",
          stream: "stdout",
          raw: JSON.stringify(data),
          data: JSON.stringify(data),
        },
      ]}
    />,
  );
  expect(screen.getByText(/^Command blocked/)).toBeTruthy();
  expect(screen.queryByText(/^Command failed/)).toBeNull();
  expect(screen.getByText("Error: listen EPERM 127.0.0.1:8000")).toBeTruthy();
});
const setup = {
  id: "install",
  command: "npm install --no-save playwright",
  status: "failed",
  exit_code: 130,
  started_at: "2026-10-22T00:00:00Z",
  ended_at: "2026-10-22T00:01:00Z",
  stdout: "",
  stderr: "Playwright installation interrupted",
  run_id: "implementation",
};
const detail: Detail = {
  task: {
    id: "verification-ui",
    repo_id: "repo",
    issue_number: 1,
    issue_url: "https://github.com/a/b/issues/1",
    claimed_scope: "Multiplication table",
    notes: "",
    issue: {},
    branch_name: "task",
    base_branch: "main",
    base_commit_sha: "base",
    worktree_path: "/owned/task",
    created_at: setup.started_at,
    updated_at: setup.ended_at,
    status: "failed",
    stage: 4,
    error: "Verification blocked",
  },
  runs: [],
  messages: [],
  artifacts: [],
  events: [],
  tests: [setup],
  validation: verificationSummary(
    {
      verification: [
        {
          name: "JavaScript syntax",
          command: null,
          kind: "check",
          outcome: "passed",
          required: true,
          detail: "Syntax check passed",
          prerequisite: null,
        },
        {
          name: "Browser rendering",
          command: "npx playwright test",
          kind: "check",
          outcome: "blocked",
          required: true,
          detail: "Browser tests did not run.",
          prerequisite: "Playwright installation",
        },
      ],
    },
    [setup],
  ),
};

it("shows code success with unresolved browser evidence, opens the exact command, and retries only host validation", async () => {
  const rpc = vi.fn(async () => null);
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });
  const terminal = vi.fn();
  render(<TestsView detail={detail} onError={vi.fn()} terminal={terminal} />);
  const evidence = screen.getByRole("region", {
    name: "Verification evidence",
  });
  expect(within(evidence).getByText("Browser rendering · blocked")).toBeTruthy();
  expect(within(evidence).getByText("Prerequisite: Playwright installation")).toBeTruthy();
  fireEvent.click(
    within(evidence).getByRole("button", {
      name: "Inspect exact command",
      hidden: true,
    }),
  );
  expect(screen.getByLabelText("Selected command output").textContent).toContain(
    "Playwright installation interrupted",
  );
  expect(document.activeElement?.className).toBe("command-transcript");
  fireEvent.click(screen.getByRole("button", { name: "Diagnose in terminal" }));
  expect(terminal).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Recheck saved evidence" }));
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.verification.recheck", {
      id: detail.task.id,
    }),
  );
  expect(rpc).toHaveBeenCalledTimes(1);
});

it("does not describe a host-side blocker as a cancelled provider run or missing provider exit", () => {
  render(
    <RunError
      stage={4}
      error="Browser verification blocked: Playwright installation interrupted"
    />,
  );
  expect(screen.getByText("Verification needs attention")).toBeTruthy();
  expect(screen.queryByText("Run cancelled")).toBeNull();
  expect(screen.getByText("Host validation · no provider process is launched")).toBeTruthy();
  expect(screen.queryByText(/Exit: unavailable/)).toBeNull();
});

it("groups a recorded DNS setup failure with browser prerequisites without changing evidence or marking them passed", () => {
  const failed = {
    ...setup,
    exit_code: 1,
    stderr: "npm error getaddrinfo EAI_AGAIN registry.npmjs.org",
  };
  const value = {
    ...detail,
    tests: [failed],
    validation: verificationSummary(
      {
        verification: [
          {
            name: "Browser layout",
            command: "npx playwright test",
            kind: "check",
            outcome: "blocked",
            required: true,
            detail: "Not executed",
            prerequisite: "Playwright installation",
          },
        ],
      },
      [failed],
    ),
  };
  const before = structuredClone(value);
  render(<TestsView detail={value} onError={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Verification evidence" }).textContent).toContain(
    "DNS resolution unavailable",
  );
  expect(screen.getAllByText("DNS resolution unavailable").length).toBeTruthy();
  expect(screen.getByText("Browser layout · blocked")).toBeTruthy();
  expect(value).toEqual(before);
  expect(value.validation.canReview).toBe(false);
});
