// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AgentTimeline } from "../../apps/desktop/features/chat/AgentTimeline";
import type { AgentEvent, Run } from "../../apps/desktop/lib/types";

const run: Run = {
  id: "run",
  stage: 0,
  provider: "antigravity",
  model: "model",
  effort: "high",
  prompt: "Hello",
  purpose: "Orbit session",
  status: "running",
  started_at: "2026-11-17T12:00:00.000Z",
  ended_at: null,
  exit_code: null,
  pid: null,
  conversation_id: null,
  output: null,
  error: null,
};

const event: AgentEvent = {
  id: 1,
  run_id: "run",
  task_id: null,
  timestamp: run.started_at,
  kind: "command.started",
  data: JSON.stringify({ command: "npm test", call_id: "command" }),
  raw: "",
  stream: "stdout",
};

afterEach(cleanup);

it("shows animated work and tool subheadings during streaming, then collapses the completed activity", () => {
  const view = render(<AgentTimeline runs={[run]} events={[event]} compact standalone />);
  expect(screen.getByRole("status").textContent).toBe("Working…");
  expect(screen.getByText("Running command")).toBeTruthy();
  expect(document.querySelector(".work-log")?.hasAttribute("open")).toBe(true);

  view.rerender(
    <AgentTimeline
      runs={[
        {
          ...run,
          status: "completed",
          ended_at: "2026-11-17T12:00:03.000Z",
          output: '{"summary":"Finished"}',
        },
      ]}
      events={[
        {
          ...event,
          kind: "command.finished",
          data: JSON.stringify({ command: "npm test", call_id: "command", exit_code: 0 }),
        },
      ]}
      compact
      standalone
    />,
  );

  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("Finished")).toBeTruthy();
  expect(document.querySelector(".work-log")?.hasAttribute("open")).toBe(false);
});

it("shows one short standalone error and keeps complete diagnostics under Technical details", () => {
  const diagnostic =
    "antigravity model 'claude-opus-4-6-thinking' does not support 'high' effort. Supported: default.";

  render(
    <AgentTimeline
      runs={[{ ...run, status: "failed", error: diagnostic }]}
      events={[{ ...event, kind: "run.failed", data: JSON.stringify({ message: diagnostic }) }]}
      compact
      standalone
    />,
  );

  expect(screen.getAllByText("This model doesn't support High reasoning.")).toHaveLength(1);
  expect(screen.getAllByText(diagnostic)).toHaveLength(1);
  expect(screen.getByText(diagnostic).closest("details")?.open).toBe(false);
  expect(screen.getByText("Technical details")).toBeTruthy();
  expect(screen.queryByText(/preparation failed|This stage/)).toBeNull();
});
