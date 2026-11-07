import { expect, it } from "vitest";

import {
  flowTaskActivity,
  taskExecutionDuration,
  taskNavigationState,
} from "../../src/features/tasks/taskNavigationState";
import type { TaskActivity } from "../../src/features/tasks/taskNavigationState";
import { viberDetail, viberWorkspace } from "./flow-fixtures";
import type { FlowRun, NodeAttempt } from "../../backend/flows/run-contracts";

const activity = (update: Partial<TaskActivity> = {}): TaskActivity => ({
  runId: "run",
  kind: "flow",
  status: "running",
  stage: "Implementer",
  executing: true,
  intervals: [{ start: "2026-11-06T00:00:00Z", end: null }],
  ...update,
});

it("uses authoritative execution status without conflating task, flow and Viber completion", () => {
  const task = { ...viberDetail().task, status: "completed" };
  const summary = { status: "running", verification: "missing", run_id: "run" } as const;

  expect(taskNavigationState(task, summary, activity({ kind: "conversation" }))).toMatchObject({
    label: "Viber running",
    taskLabel: "Task: Completed",
    working: true,
    active: true,
    stage: "Implementer",
  });

  const finished = { ...summary, status: "completed" } as const;

  expect(
    taskNavigationState(
      { ...task, status: "not_started" },
      finished,
      activity({ status: "completed", executing: false, kind: "conversation" }),
    ),
  ).toMatchObject({
    label: "Viber completed",
    taskLabel: "Task: Not started",
    working: false,
    active: false,
  });

  expect(
    taskNavigationState(task, finished, activity({ status: "completed", executing: false })),
  ).toMatchObject({ label: "Flow completed", taskLabel: "Task: Completed" });

  expect(taskNavigationState(task, summary, activity({ runId: "old-run" }))).toMatchObject({
    label: "Execution running",
    active: false,
    activity: undefined,
  });
});

it.each(["paused", "waiting", "failed", "interrupted", "needs_recovery"] as const)(
  "keeps %s flows in Tasks even when the legacy task status still says implementing",
  (status) => {
    expect(
      taskNavigationState(
        { ...viberDetail().task, status: "implementing" },
        { status, verification: "missing", run_id: "run" },
      ),
    ).toMatchObject({ working: false, active: false });
  },
);

it("measures the union of recorded execution intervals without counting parallel work or approval waits twice", () => {
  const now = Date.parse("2026-11-06T00:05:00Z");

  const saved = activity({
    executing: false,
    intervals: [
      { start: "2026-11-06T00:00:00Z", end: "2026-11-06T00:01:00Z" },
      { start: "2026-11-06T00:00:30Z", end: "2026-11-06T00:01:30Z" },
      { start: "2026-11-06T00:04:00Z", end: "2026-11-06T00:05:00Z" },
    ],
  });

  expect(taskExecutionDuration(saved, now)).toBe("2m 30s");
  expect(taskExecutionDuration(saved, now + 60000)).toBe("2m 30s");
  expect(taskExecutionDuration(activity(), now)).toBe("5m 0s");
  expect(taskExecutionDuration(activity(), now + 1000)).toBe("5m 1s");
});

it("omits timing when evidence is missing, invalid, future-dated or unfinished after execution stops", () => {
  const now = Date.parse("2026-11-06T00:05:00Z");
  for (const value of [
    undefined,
    activity({ intervals: [] }),
    activity({ executing: false }),
    activity({ intervals: [{ start: "invalid", end: null }] }),
    activity({ intervals: [{ start: "2026-11-06T01:00:00Z", end: null }] }),
    activity({ intervals: [{ start: "2026-11-06T00:00:00Z", end: "2026-11-06T01:00:00Z" }] }),
    activity({ intervals: [{ start: "2026-11-06T00:04:00Z", end: "2026-11-06T00:03:00Z" }] }),
  ])
    expect(taskExecutionDuration(value, now)).toBeUndefined();
});

it("reads the exact captured run and excludes approval attempts and unrelated Viber turns", () => {
  const detail = viberDetail();
  const workspace = viberWorkspace(detail);

  const run: FlowRun = {
    id: "run",
    flow_id: detail.task.flow_id!,
    revision: 1,
    task_id: detail.task.id,
    kind: "flow",
    status: "running",
    origin: "user",
    request_id: "request",
    request_digest: "hash",
    parent_run_id: null,
    snapshot: { goal: "Goal", agents: {} },
    created_at: detail.task.created_at,
    updated_at: detail.task.updated_at,
    error: null,
  };

  const attempt: NodeAttempt = {
    id: "attempt",
    run_id: run.id,
    node_id: workspace.revision.definition.nodes[0].id,
    ordinal: 1,
    configuration: { node: workspace.revision.definition.nodes[0], agent: null },
    configuration_hash: "hash",
    inputs: [],
    inputs_hash: "hash",
    workspace_fingerprint: "fingerprint",
    completed_fingerprint: null,
    agent_run_id: "agent",
    command_run_id: null,
    dispatch_id: null,
    started_at: detail.task.created_at,
    ended_at: null,
    status: "running",
    output: null,
    verification: "missing",
    error: null,
  };

  workspace.runs = [run];

  workspace.attempts = [
    attempt,
    {
      ...attempt,
      id: "approval",
      configuration: {
        agent: null,
        node: { id: "gate", type: "approval", name: "Review gate", inputs: [], instructions: "" },
      },
    },
  ];

  workspace.conversation_attempts = [{ ...attempt, run_id: "other-run" }];

  expect(flowTaskActivity(workspace, run.id)).toMatchObject({
    kind: "flow",
    stage: "Fixture Viber",
    executing: true,
    intervals: [{ start: detail.task.created_at, end: null }],
  });

  expect(flowTaskActivity(workspace, "missing-run")).toBeUndefined();

  workspace.attempts.push({
    ...attempt,
    id: "incomplete-history",
    status: "completed",
    ended_at: null,
  });

  expect(flowTaskActivity(workspace, run.id)?.intervals).toEqual([]);
});

it("shows task completion even when no flow has ever run", () => {
  expect(
    taskNavigationState(
      { ...viberDetail().task, status: "completed" },
      { status: "draft", verification: "missing", run_id: null },
    ),
  ).toMatchObject({ label: "Completed", tone: "success", working: false, taskLabel: undefined });
});
