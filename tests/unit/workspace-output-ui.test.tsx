// @vitest-environment jsdom
import { selectValue } from "../helpers/select";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { randomUUID } from "node:crypto";

import { CommandRuns } from "../../src/features/verification/CommandRuns";
import { LogView } from "../../src/features/chat/LogView";
import { TaskCleanup } from "../../src/features/tasks/TaskCleanup";
import type { Detail } from "../../src/lib/types";
import { NodeAttemptSchema } from "../../backend/flows/run-contracts";
import { resolveAgentNode, type FlowNode } from "../../backend/flows/contracts";
import { viberProfile } from "../workspace/flow-fixtures";

afterEach(cleanup);

const detail: Detail = {
  task: {
    id: "workspace-output",
    repo_id: "repo",
    issue_number: 1,
    issue_url: "https://github.com/a/b/issues/1",
    claimed_scope: "source.ts",
    notes: "",
    issue: { title: "Migration" },
    branch_name: "migrate-test",
    base_branch: "main",
    base_commit_sha: "abcdef",
    worktree_path: "/tasks/worktree",
    created_at: "2026-10-09T00:00:00Z",
    updated_at: "2026-10-09T00:00:00Z",
    status: "implementing",
    stage: 3,
    error: null,
  },
  runs: [
    {
      id: "implement",
      stage: 3,
      provider: "codex",
      purpose: "Codex Implementation",
      model: "gpt-test",
      effort: "high",
      prompt: "Exact instructions",
      status: "running",
      started_at: "2026-10-09T00:00:00Z",
      ended_at: null,
      exit_code: null,
      pid: 1,
      conversation_id: null,
      output: null,
      error: null,
    },
  ],
  events: [],
  messages: [],
  artifacts: [],
  tests: [],
};

const bridge = () => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: () => {},
    configurable: true,
  });

  const rpc = vi.fn(async (method: string) =>
    method === "task.diff"
      ? {
          files: [
            {
              path: "source.ts",
              old_path: null,
              status: "M",
              staged: false,
              unstaged: true,
              insertions: 1,
              deletions: 1,
              binary: false,
            },
          ],
          base: "abcdef",
          insertions: 1,
          deletions: 1,
        }
      : method === "task.file"
        ? {
            original: "old",
            modified: "new",
            unified: "--- source.ts\n+++ source.ts\n@@ -1 +1 @@\n-old\n+new\n",
            binary: false,
          }
        : method === "editors.list"
          ? { editors: [] }
          : null,
  );

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  return rpc;
};

it("removes task history while preserving work through a distinct explicit choice", async () => {
  const rpc = bridge();
  const done = vi.fn();
  render(<TaskCleanup id="owned-task" close={vi.fn()} done={done} />);
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /^Remove task history, preserve work/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove history and preserve work" }));
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());

  expect(rpc).toHaveBeenCalledWith("task.disposal.preserve", {
    id: "owned-task",
    confirmed: true,
  });
});

it("separates command transcripts by attempt and stage, highlights failures, keeps both streams and updates live output", () => {
  bridge();

  const tests = [
    {
      id: "first",
      run_id: "implement",
      command: "npm test",
      status: "passed",
      started_at: detail.task.created_at,
      ended_at: detail.task.updated_at,
      exit_code: 0,
      stdout: "desktop passed",
      stderr: "warning from desktop",
    },
    {
      id: "second",
      run_id: "review",
      command: "npm test -- --mobile",
      status: "failed",
      started_at: detail.task.created_at,
      ended_at: detail.task.updated_at,
      exit_code: 1,
      stdout: "mobile started",
      stderr: "mobile assertion failed",
    },
    {
      id: "third",
      run_id: "implement",
      command: "npm run lint",
      status: "running",
      started_at: detail.task.created_at,
      ended_at: null,
      exit_code: null,
      stdout: "linting",
      stderr: "",
    },
  ];

  const props = {
    ...detail,
    tests,
    runs: [
      detail.runs[0],
      {
        ...detail.runs[0],
        id: "review",
        provider: "antigravity",
        purpose: "Antigravity Final Review",
        stage: 5,
        status: "completed",
      },
    ],
  };

  const ui = render(<CommandRuns detail={props} />);
  expect(screen.getByLabelText("Selected command output").textContent).toContain("linting");

  selectValue(screen.getByLabelText("Command run"), "run:review");

  expect(screen.getByLabelText("Selected command output").textContent).toContain(
    "mobile assertion failed",
  );

  expect(screen.getByLabelText("Selected command output").textContent).toContain("mobile started");
  expect(within(screen.getByLabelText("Recorded commands")).getAllByRole("button")).toHaveLength(1);
  expect(ui.container.querySelector(".command-failed[aria-current='true']")).toBeTruthy();

  selectValue(screen.getByLabelText("Command run"), "all");

  fireEvent.click(within(screen.getByLabelText("Recorded commands")).getAllByRole("button")[0]);
  expect(screen.getByLabelText("Selected command output").textContent).toContain("desktop passed");

  expect(screen.getByLabelText("Selected command output").textContent).toContain(
    "warning from desktop",
  );

  fireEvent.change(screen.getByLabelText("Search commands"), {
    target: { value: "lint" },
  });

  ui.rerender(
    <CommandRuns
      detail={{
        ...props,
        tests: [tests[0], tests[1], { ...tests[2], stdout: "linting\nchecked 4 files" }],
      }}
    />,
  );

  expect(screen.getByLabelText("Selected command output").textContent).toContain("checked 4 files");
});

it("filters stage-zero commands by their actual Viber attempt and attributes direct command nodes", () => {
  const nodes: FlowNode[] = ["Scout", "Builder"].map((name) => ({
    id: randomUUID(),
    type: "agent",
    name,
    profile_id: viberProfile.id,
    inputs: [],
    instructions: "",
    overrides: {},
    completion: { verification: "record-only", review: "none" },
  }));

  nodes.push({
    id: randomUUID(),
    type: "command",
    name: "Syntax check",
    argv: ["node", "--check", "source.js"],
    access: "read-only",
    timeout_secs: 30,
    inputs: [],
  });

  const runs = nodes.slice(0, 2).map(() => ({
    ...detail.runs[0],
    id: randomUUID(),
    stage: 0,
    purpose: "Shared role",
    status: "completed",
    exit_code: 0,
  }));

  const tests = nodes.map((node, index) => ({
    id: randomUUID(),
    run_id: runs[index]?.id || null,
    command: "node --check source.js",
    status: "passed",
    exit_code: 0,
    started_at: detail.task.created_at,
    ended_at: detail.task.updated_at,
    stdout: `${node.name} output`,
    stderr: "",
  }));

  const runId = randomUUID();

  const attempts = nodes.map((node, index) =>
    NodeAttemptSchema.parse({
      id: randomUUID(),
      run_id: runId,
      node_id: node.id,
      ordinal: 1,
      status: "completed",
      configuration: {
        node,
        agent: node.type === "agent" ? resolveAgentNode(node, viberProfile) : null,
      },
      configuration_hash: "a".repeat(64),
      inputs_hash: "b".repeat(64),
      inputs: [],
      workspace_fingerprint: "fixture:before",
      completed_fingerprint: "fixture:after",
      agent_run_id: runs[index]?.id || null,
      command_run_id: index === 2 ? tests[index].id : null,
      dispatch_id: null,
      started_at: detail.task.created_at,
      ended_at: detail.task.updated_at,
      output: "Retained output",
      verification: "missing",
      error: null,
    }),
  );

  render(<CommandRuns detail={{ runs, tests }} attempts={attempts} />);
  selectValue(screen.getByLabelText("Command run"), `attempt:${attempts[1].id}`);
  expect(within(screen.getByLabelText("Recorded commands")).getAllByRole("button")).toHaveLength(1);
  expect(screen.getByLabelText("Selected command output").textContent).toContain("Builder output");

  expect(screen.getByLabelText("Selected command output").textContent).not.toContain(
    "Scout output",
  );

  selectValue(screen.getByLabelText("Command run"), `attempt:${attempts[2].id}`);

  expect(screen.getByLabelText("Selected command output").textContent).toContain(
    "Syntax check output",
  );

  expect(screen.getAllByText(/Syntax check · attempt 1/).length).toBeGreaterThan(0);
  expect(screen.queryByText("Manual / unassigned")).toBeNull();
});

it("opens readable agent output with expanded results and both command streams, while retaining raw inspection", async () => {
  bridge();

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc: vi.fn(async () => ({
        text: '{"raw":"provider envelope"}',
        truncated: false,
      })),
    },
  });

  render(
    <LogView
      taskId={detail.task.id}
      liveOutput
      runs={[
        {
          ...detail.runs[0],
          status: "completed",
          output: JSON.stringify({
            summary: "Implemented the migration",
            testsPassed: ["desktop check"],
            testsSkipped: ["remote stress run"],
          }),
        },
      ]}
      events={[
        {
          id: 1,
          task_id: detail.task.id,
          run_id: "implement",
          kind: "command.finished",
          timestamp: detail.task.created_at,
          stream: "stdout",
          raw: "",
          data: JSON.stringify({
            command: "npm test",
            call_id: 1,
            stdout: "actual stdout",
            stderr: "actual stderr",
            exit_code: 0,
          }),
        },
      ]}
    />,
  );

  expect(screen.getByText("Implemented the migration")).toBeTruthy();
  expect(screen.getByText("remote stress run")).toBeTruthy();
  expect(screen.getByText("actual stdout")).toBeTruthy();
  expect(screen.getByText("actual stderr")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Raw" }));
  expect(await screen.findByText('{"raw":"provider envelope"}')).toBeTruthy();
});
