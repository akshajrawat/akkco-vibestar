// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TestsView } from "../../src/components/TestsView";
import { RunError } from "../../src/components/RunError";
import type { Detail } from "../../src/lib/types";
import { verificationSummary } from "../../backend/execution/verification";

afterEach(cleanup);
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
  expect(
    within(evidence).getByText("Browser rendering · blocked"),
  ).toBeTruthy();
  expect(
    within(evidence).getByText("Prerequisite: Playwright installation"),
  ).toBeTruthy();
  fireEvent.click(
    within(evidence).getByRole("button", { name: "Inspect exact command" }),
  );
  expect(
    screen.getByLabelText("Selected command output").textContent,
  ).toContain("Playwright installation interrupted");
  expect(document.activeElement?.className).toBe("command-transcript");
  fireEvent.click(screen.getByRole("button", { name: "Diagnose in terminal" }));
  expect(terminal).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry validation only" }),
  );
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.retry", {
      id: detail.task.id,
      stage: 4,
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
  expect(
    screen.getByText("Host validation · no provider process is launched"),
  ).toBeTruthy();
  expect(screen.queryByText(/Exit: unavailable/)).toBeNull();
});
