// @vitest-environment jsdom
import { selectValue } from "../helpers/select";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Button } from "../../src/components/ui/button";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { UsageCharts } from "../../src/features/usage/UsageCharts";
import { UsageView } from "../../src/features/usage/UsageView";
import { defaultSettings } from "../../backend/domain";
import type { UsageRecord } from "../../backend/execution/output/usage";
import { AgentResponse } from "../../src/features/chat/AgentResponse";
import { PipelineView } from "../../src/features/workflow/TaskEngineering";
import { workspaceDetail } from "../workspace/fixtures";
import { BrowserEnvironment } from "../../src/features/verification/BrowserEnvironment";
import type { BrowserEnvironmentReport } from "../../backend/execution/verification/browser/contracts";

vi.mock("../../src/hooks/useWorkspace", () => ({
  useProviders: () => ({ providers: [] }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("requires an explicit environment choice before inspection and preserves an unapplied choice across snapshots", async () => {
  const observation = {
    outcome: "available" as const,
    detail: "Fixture capability",
  };

  const report: BrowserEnvironmentReport = {
    checked_at: "2026-10-23T12:00:00Z",
    environment: "isolated",
    packages: [],
    browsers: [],
    dns: observation,
    socket: observation,
    direct_file: observation,
    http: observation,
    note: "Fixture capability snapshot; no application checks.",
  };

  const rpc = vi.fn(async (method: string) =>
    method === "task.browser.inspect" ? { ...report, environment: "installed_browsers" } : {},
  );

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  const task = {
    ...workspaceDetail("browser-ui").task,
    browser_environment_report: report,
  };

  const onError = vi.fn();
  const ui = render(<BrowserEnvironment task={task} unavailable={false} onError={onError} />);
  fireEvent.click(screen.getByText("Browser verification environment"));
  expect(rpc).not.toHaveBeenCalled();

  selectValue(screen.getByLabelText("Verification environment"), "installed_browsers");

  ui.rerender(
    <BrowserEnvironment
      task={{ ...task, browser_environment_report: { ...report } }}
      unavailable={false}
      onError={onError}
    />,
  );

  expect(screen.getByLabelText("Verification environment").getAttribute("data-value")).toBe(
    "installed_browsers",
  );

  expect(
    (
      screen.getByRole("button", {
        name: "Inspect browser environment",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Use environment" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("task.browser.configure", {
      id: task.id,
      environment: "installed_browsers",
      confirmed: true,
    }),
  );

  ui.rerender(
    <BrowserEnvironment
      task={{
        ...task,
        verification_environment: "installed_browsers",
        browser_environment_report: undefined,
      }}
      unavailable={false}
      onError={onError}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Inspect browser environment" }));
  await screen.findByText("Fixture capability snapshot; no application checks.");

  expect(rpc.mock.calls.map(([method]) => method)).toEqual([
    "task.browser.configure",
    "task.browser.inspect",
  ]);

  expect(onError).not.toHaveBeenCalled();
});

it("copies exact fenced source and keeps repository HTML inert while highlighting code", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  const code = 'const value = "<img src=x onerror=alert(1)>";\n';
  const ui = render(<AgentResponse text={"```ts\n" + code + "```"} />);
  expect(ui.container.querySelector("img")).toBeNull();
  expect(ui.container.querySelector(".syntax-keyword")?.textContent).toBe("const");
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await screen.findByRole("button", { name: "Code copied" });
  expect(writeText).toHaveBeenCalledWith(code);
});

it("keeps completed runs without exit evidence neutral and represents cancellation separately", () => {
  const detail = workspaceDetail("pipeline-evidence");
  detail.task.stage = 4;
  detail.task.status = "verification_blocked";

  detail.runs = [
    {
      id: "run",
      provider: "codex",
      model: "fixture-model",
      effort: "low",
      stage: 3,
      status: "completed",
      started_at: detail.task.created_at,
      ended_at: detail.task.updated_at,
      exit_code: null,
      pid: null,
      prompt: "",
      conversation_id: null,
      output: null,
      error: null,
    },
  ];

  const ui = render(
    <PipelineView detail={detail} busy={false} action={vi.fn()} finalize={vi.fn()} />,
  );

  const implementation = screen.getByText(/fixture-model/).closest("li");
  expect(implementation?.textContent).toContain("Evidence unavailable");
  expect(implementation?.querySelector(".success")).toBeNull();

  ui.rerender(
    <PipelineView
      detail={{
        ...detail,
        task: { ...detail.task, stage: 3, status: "cancelled" },
        runs: [{ ...detail.runs[0], status: "cancelled" }],
      }}
      busy={false}
      action={vi.fn()}
      finalize={vi.fn()}
    />,
  );

  expect(screen.getByText(/fixture-model/).closest("li")?.className).toContain("cancelled");
});

it("keeps busy actions labelled and prevents duplicate activation or accidental form submission", () => {
  const action = vi.fn();
  const submit = vi.fn((event) => event.preventDefault());

  render(
    <form onSubmit={submit}>
      <Button busy onClick={action}>
        Refresh metadata
      </Button>
    </form>,
  );

  const button = screen.getByRole("button", { name: "Refresh metadata" });
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  expect(action).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("retains dirty settings through background snapshots and separates utility models from the coding pipeline", async () => {
  const rpc = vi.fn(async (method: string) => (method === "editors.list" ? { editors: [] } : {}));

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc,
      subscribe: () => () => {},
      saveDesktopSettings: vi.fn().mockResolvedValue(undefined),
      desktopSettings: async () => ({
        config: { distro: "", data_home: "", helper_path: "" },
        distros: [],
        native_windows: false,
      }),
    },
  });

  const refresh = vi.fn().mockResolvedValue(undefined);
  const ui = render(<SettingsPage settings={defaultSettings} refresh={refresh} />);
  await screen.findByText("All changes saved");
  const models = screen.getAllByLabelText("Model");

  fireEvent.change(screen.getAllByLabelText("Timeout (seconds)")[0], {
    target: { value: "1234" },
  });

  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  ui.rerender(<SettingsPage settings={{ ...defaultSettings }} refresh={refresh} />);
  expect((screen.getAllByLabelText("Timeout (seconds)")[0] as HTMLInputElement).value).toBe("1234");
  expect(models).toHaveLength(5);
  expect(screen.queryByRole("button", { name: "Models" })).toBeNull();
  expect(screen.getByRole("button", { name: "Agents & Models" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "GitHub & PR Watch" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Utility AI" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "settings.save",
      expect.objectContaining({
        antigravity: { ...defaultSettings.antigravity, timeout_secs: 1234 },
      }),
    ),
  );

  expect(rpc.mock.calls.every(([method]) => !String(method).includes("analyze"))).toBe(true);
});

it("keeps missing totals unavailable and pages every saved run while charts report exact counts and coverage", async () => {
  const row: UsageRecord = {
    id: "one",
    task_id: null,
    job_id: null,
    repository: null,
    purpose: "Fixture",
    provider: "codex",
    model: "fixture",
    effort: "low",
    started_at: "2026-10-23T12:00:00Z",
    ended_at: "2026-10-23T12:01:00Z",
    duration_ms: 60000,
    status: "completed",
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    subscription_limits: null,
    subscription_limits_after: null,
    provider_session_id: null,
    error: null,
  };

  const ui = render(<UsageCharts rows={[row]} />);

  expect(
    screen.getByRole("button", {
      name: /2026-10-23: Unavailable tokens · 0\/1/,
    }),
  ).toBeTruthy();

  expect(screen.getByRole("button", { name: "2026-10-23: 1 runs" })).toBeTruthy();
  ui.rerender(<UsageCharts rows={[row, { ...row, id: "two", total_tokens: 75 }]} />);

  const tokenBar = screen.getByRole("button", {
    name: /2026-10-23: 75 tokens · 1\/2/,
  });

  fireEvent.focus(tokenBar);

  expect(
    screen.getAllByText("2026-10-23: 75 tokens · 1/2 runs reported totals").length,
  ).toBeGreaterThan(0);

  ui.unmount();
  const scoped = render(<UsageView records={[row]} />);
  expect(scoped.container.querySelector(".usage-run summary strong")?.textContent).toBe("Fixture");
  expect(screen.queryByRole("table")).toBeNull();
  scoped.unmount();

  const rows = Array.from({ length: 201 }, (_, index) => ({
    ...row,
    id: `run-${index}`,
    purpose: `Fixture ${index + 1}`,
  }));

  const rpc = vi.fn(async (method: string) =>
    method === "usage.list" ? rows : { database: "/fixture.sqlite" },
  );

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc, subscribe: () => () => {} },
  });

  render(<UsageView />);
  await screen.findByRole("table");

  expect(
    screen.getByRole("img", {
      name: /Input: .* tokens · 201\/201 runs reported/,
    }),
  ).toBeTruthy();

  expect(screen.getByRole("img", { name: /Cached: Unavailable tokens · 0\/201/ })).toBeTruthy();
  for (let page = 0; page < 4; page++)
    fireEvent.click(screen.getByRole("button", { name: "Next runs" }));
  expect(screen.getByRole("cell", { name: "Fixture 201" })).toBeTruthy();

  expect((screen.getByRole("button", { name: "Next runs" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  fireEvent.change(screen.getByLabelText("Search usage runs"), {
    target: { value: "Fixture 201" },
  });

  expect(
    (screen.getByRole("button", { name: "Previous runs" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  expect(screen.getByRole("cell", { name: "Fixture 201" })).toBeTruthy();
});
