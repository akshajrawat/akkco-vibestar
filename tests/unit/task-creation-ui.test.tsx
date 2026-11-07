// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { NewTask } from "../../src/features/tasks/NewTask";
import { PrState } from "../../src/features/pull-requests/PrDetails";
import { defaultSettings } from "../../backend/domain";
import { viberProfile } from "../workspace/flow-fixtures";
import type { ScheduleJob } from "../../backend/scheduled/contracts";

afterEach(cleanup);

it("uses saved Viber profiles and editable templates for new issue tasks without inference", async () => {
  const rpc = vi.fn(async (method: string) =>
    method === "profile.list"
      ? [viberProfile]
      : { repositories: [], settings: defaultSettings, root: "/data" },
  );

  Object.defineProperty(window, "vibestar", { value: { rpc }, configurable: true });
  render(<NewTask close={vi.fn()} created={vi.fn()} />);
  const profile = await screen.findByLabelText<HTMLSelectElement>("Viber profile");
  expect(profile.value).toBe(viberProfile.id);
  expect(profile.textContent).toContain("workspace-write");
  const templates = screen.getByLabelText<HTMLSelectElement>("Starting flow");
  expect(templates.options).toHaveLength(4);
  fireEvent.change(templates, { target: { value: "full" } });
  expect(screen.queryByLabelText("Viber profile")).toBeNull();

  expect(
    rpc.mock.calls.some(([method]) => method === "flow.start" || method === "task.createIssue"),
  ).toBe(false);
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
    if (method === "profile.list") return [viberProfile];
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
    if (method === "task.createIssue") {
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
            name: "Create task",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await vi.waitFor(() => expect(attempts).toBe(attempt));
  }

  await vi.waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );

  fireEvent.change(screen.getByLabelText("Optional instructions"), {
    target: { value: "New user instructions" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith("created-task"));

  const requests = rpc.mock.calls
    .filter(([method]) => method === "task.createIssue")
    .map(([, input]) => input!);

  expect(requests).toHaveLength(3);
  expect(requests[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests[1].request_id).toBe(requests[0].request_id);
  expect(requests[2].request_id).not.toBe(requests[1].request_id);
});

it("does not let a previous inspection failure mask a retry that is currently analyzing", () => {
  render(<PrState job={{ status: "analyzing", error: "previous failure" } as ScheduleJob} />);
  expect(screen.getByText(/Checking discussion/)).toBeTruthy();
  expect(screen.queryByText(/Check failed/)).toBeNull();
});
