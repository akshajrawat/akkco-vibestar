// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlanView } from "../src/components/PlanView";
import { TaskWorkspace } from "../src/components/TaskWorkspace";
import { NewTask } from "../src/components/NewTask";
import { PrState } from "../src/components/PrDetails";
import { defaultSettings } from "../backend/domain";
import { plan1 } from "./fixtures";
import type { Detail, Run } from "../src/lib/types";
import type { ScheduleJob } from "../backend/scheduled/contracts";
vi.mock("../src/lib/useWorkspace", () => ({
  useProviders: () => ({
    providers: [
      {
        provider: "antigravity",
        models: [
          {
            id: "gemini-fixture-low",
            label: "Gemini fixture · Low",
            supportedEfforts: ["low"],
          },
        ],
        efforts: ["low"],
        capabilities: [],
        error: null,
      },
      {
        provider: "codex",
        models: [
          {
            id: "codex-fixture",
            label: "Codex fixture",
            supportedEfforts: ["low", "medium"],
          },
        ],
        efforts: ["low", "medium"],
        capabilities: [],
        error: null,
      },
    ],
    loading: false,
    error: "",
    refresh: vi.fn(),
  }),
}));
afterEach(cleanup);
const task: Detail["task"] = {
  id: "gate-ui",
  repo_id: "repo",
  issue_number: 1,
  issue_url: "https://github.com/a/b/issues/1",
  claimed_scope: "source.txt",
  notes: "",
  issue: { title: "Issue" },
  branch_name: "akkco/test",
  base_branch: "main",
  base_commit_sha: "abc",
  worktree_path: "",
  created_at: "2026-10-09T00:00:00Z",
  updated_at: "2026-10-09T00:00:00Z",
  status: "awaiting_approval",
  stage: 2,
  error: null,
  approval_gate: "antigravity_plan",
};
const run: Run = {
  id: "draft",
  stage: 1,
  provider: "antigravity",
  model: "gemini-fixture-low",
  effort: "low",
  prompt: "Read entire issue and all comments. Exact fixture prompt.",
  status: "cancelled",
  started_at: task.created_at,
  ended_at: task.updated_at,
  exit_code: null,
  pid: null,
  conversation_id: null,
  output: null,
  error: "Cancelled",
};
it("shows a cancelled streamed draft and exact prompt with an explicit recovery action", () => {
  const recover = vi.fn();
  render(
    <PlanView
      artifacts={[]}
      runs={[run]}
      events={[
        {
          id: 1,
          run_id: run.id,
          task_id: task.id,
          timestamp: task.created_at,
          kind: "message",
          data: JSON.stringify({
            call_id: 143,
            text_delta: JSON.stringify({ ...plan1, toolAction: "Finish" }),
          }),
          raw: "",
          stream: "stdout",
        },
      ]}
      acceptDraft={recover}
    />,
  );
  expect(screen.getByText("Streamed draft")).toBeTruthy();
  expect(screen.getByText("Fixture plan")).toBeTruthy();
  expect(screen.getByText(run.prompt)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use this draft…" }));
  expect(recover).toHaveBeenCalledWith(run);
});
it("keeps compact review controls beside the composer without an automatic modal and preserves an independent draft on approval", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: () => {},
    configurable: true,
  });
  const rpc = vi.fn(async () => null);
  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });
  render(
    <TaskWorkspace
      detail={{
        task,
        runs: [{ ...run, status: "completed" }],
        events: [],
        artifacts: [
          {
            id: "plan",
            stage: 1,
            kind: "plan",
            content: JSON.stringify(plan1),
            created_at: task.created_at,
          },
        ],
        messages: [],
        tests: [],
      }}
      revision={0}
      back={vi.fn()}
      onError={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Pipeline review required" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  expect(
    screen.queryByRole("dialog", { name: "Stage review required" }),
  ).toBeNull();
  expect(screen.queryByRole("tab", { name: "Changes" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Split Changes beside chat" }),
  ).toBeNull();
  const draft = screen.getByLabelText("Task follow-up") as HTMLTextAreaElement;
  fireEvent.change(draft, {
    target: { value: "Do not submit this draft on approval" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View plan" }));
  expect(screen.getByText("Antigravity original plan")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Approve → Codex refinement" }),
  );
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.approve", {
      id: task.id,
      artifact_id: "plan",
    }),
  );
  expect(draft.value).toBe("Do not submit this draft on approval");
  expect(rpc).not.toHaveBeenCalledWith("task.followup", expect.anything());
});
it("populates actual model selectors and supported efforts in New Task", async () => {
  const rpc = vi.fn(async () => ({
    repositories: [],
    settings: defaultSettings,
    root: "/data",
  }));
  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });
  render(<NewTask close={vi.fn()} created={vi.fn()} />);
  expect(await screen.findAllByText("Gemini fixture · Low")).toHaveLength(2);
  const models = screen
    .getAllByRole("combobox", { hidden: true })
    .filter((e) => e.id.endsWith("-models"));
  expect(models).toHaveLength(4);
  fireEvent.change(models[0], { target: { value: "gemini-fixture-low" } });
  expect((models[0] as HTMLSelectElement).value).toBe("gemini-fixture-low");
  expect(screen.queryByText(/discovering/)).toBeNull();
  expect(screen.getByText(/discovery does not run AI/)).toBeTruthy();
});

it("retains the task request identity across transport retries and changes it after editing the submitted payload", async () => {
  const repository = {
    id: "fixture-repository",
    owner: "fixture",
    name: "project",
    path: "/fixture/project",
    base_branch: "main",
  };
  let attempts = 0;
  const rpc = vi.fn(async (method: string, input?: Record<string, unknown>) => {
    if (method === "snapshot")
      return {
        repositories: [repository],
        settings: defaultSettings,
        root: "/data",
      };
    if (method === "task.preview")
      return {
        repository,
        reference: { owner: "fixture", repo: "project", number: 1 },
        issue: { title: "Fixture preview", body: "Requirements", comments: [] },
      };
    if (method === "task.create") {
      attempts++;
      if (attempts < 3) throw new Error("fixture transport failure");
      return { id: "created-task", ...input };
    }
    return {};
  });
  Object.defineProperty(window, "vibestar", {
    value: { rpc },
    configurable: true,
  });
  const created = vi.fn();
  render(<NewTask close={vi.fn()} created={created} />);
  fireEvent.change(screen.getByLabelText("Issue URL"), {
    target: { value: "https://github.com/fixture/project/issues/1" },
  });
  await screen.findByText("Fixture preview");
  for (let attempt = 1; attempt <= 2; attempt++) {
    await vi.waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Start task",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await vi.waitFor(() => expect(attempts).toBe(attempt));
  }
  await vi.waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Start task" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText("Optional instructions"), {
    target: { value: "New user instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start task" }));
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith("created-task"));
  const requests = rpc.mock.calls
    .filter(([method]) => method === "task.create")
    .map(([, input]) => input!);
  expect(requests).toHaveLength(3);
  expect(requests[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests[1].request_id).toBe(requests[0].request_id);
  expect(requests[2].request_id).not.toBe(requests[1].request_id);
});
it("does not let a previous inspection failure mask a retry that is currently analyzing", () => {
  render(
    <PrState
      job={{ status: "analyzing", error: "previous failure" } as ScheduleJob}
    />,
  );
  expect(screen.getByText(/ANALYZING DISCUSSION/)).toBeTruthy();
  expect(screen.queryByText(/INSPECTION FAILED/)).toBeNull();
});
