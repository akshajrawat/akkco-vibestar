// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
  const view = render(<AgentTimeline runs={[run]} events={[event]} />);
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
    />,
  );

  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("Finished")).toBeTruthy();
  expect(document.querySelector(".work-log")?.hasAttribute("open")).toBe(false);
});

it("shows one standalone error with its diagnostic visible inline", () => {
  const diagnostic =
    "antigravity model 'claude-opus-4-6-thinking' does not support 'high' effort. Supported: default.";

  render(
    <AgentTimeline
      runs={[{ ...run, status: "failed", error: diagnostic }]}
      events={[{ ...event, kind: "run.failed", data: JSON.stringify({ message: diagnostic }) }]}
    />,
  );

  expect(screen.getAllByText("This model doesn't support High reasoning.")).toHaveLength(1);
  expect(screen.getAllByText(diagnostic)).toHaveLength(1);
  expect(screen.getByText(diagnostic).closest("details")).toBeNull();
  expect(screen.queryByText("Technical details")).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss run notice" })).toBeNull();
  expect(screen.queryByText(/preparation failed|This stage/)).toBeNull();
});

it("hides empty message events between tools and shows text when a stream has content", () => {
  const placeholder: AgentEvent = {
    ...event,
    id: 2,
    kind: "message",
    data: JSON.stringify({ call_id: "reply", text: " " }),
  };

  const view = render(<AgentTimeline runs={[run]} events={[placeholder, event]} />);

  expect(screen.getByText("Running command")).toBeTruthy();
  expect(view.container.querySelector(".message-event")).toBeNull();

  view.rerender(
    <AgentTimeline
      runs={[run]}
      events={[
        event,
        placeholder,
        { ...placeholder, id: 3, data: JSON.stringify({ call_id: "reply", text_delta: "Reply" }) },
      ]}
    />,
  );

  expect(screen.getByText("Reply")).toBeTruthy();
  expect(view.container.querySelectorAll(".message-event")).toHaveLength(1);
});

it("keeps the streamed reply outside a collapsed Work Log when an empty thought arrives", () => {
  const reply: AgentEvent = {
    ...event,
    id: 2,
    kind: "message",
    data: JSON.stringify({ text: "Streamed reply" }),
  };

  const view = render(<AgentTimeline runs={[run]} events={[event, reply]} />);
  const workLog = view.container.querySelector<HTMLDetailsElement>(".work-log")!;
  fireEvent.click(workLog.querySelector("summary")!);
  expect(workLog.open).toBe(false);

  view.rerender(
    <AgentTimeline
      runs={[run]}
      events={[
        event,
        reply,
        { ...event, id: 3, kind: "analysis.status", data: JSON.stringify({ text_delta: " " }) },
      ]}
    />,
  );

  expect(workLog.open).toBe(false);
  expect(screen.getByText("Streamed reply").closest(".work-log")).toBeNull();
});
