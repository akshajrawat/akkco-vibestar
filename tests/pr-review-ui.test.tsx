// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { ScheduledPage } from "../src/components/ScheduledPage";
import { PrDetails } from "../src/components/PrDetails";
import { defaultSettings } from "../backend/domain";
import type { Snapshot } from "../src/lib/types";
import type { ScheduleJob } from "../backend/scheduled/contracts";
import type { PRAnalysisSession } from "../backend/review/pr/contracts";
import { prSnapshot, observations } from "./pr-fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const job: ScheduleJob = {
  id: "job",
  url: "https://github.com/upstream/project/pull/1",
  task_id: null,
  interval_minutes: 60,
  verify_codex: false,
  enabled: false,
  next_run_at: "before",
  status: "idle",
  last_checked_at: "2026-10-01T10:00:00Z",
  last_analyzed_at: "2026-10-01T10:00:00Z",
  last_snapshot: prSnapshot,
  pending_snapshot: null,
  changes: [],
  error: null,
  title: "Review fixture",
};
const session: PRAnalysisSession = {
  id: "analysis",
  job_id: "job",
  status: "completed",
  started_at: "2026-10-01T10:00:00Z",
  ended_at: "2026-10-01T10:01:00Z",
  phase: "Analysis complete",
  configuration: defaultSettings.utility_ai,
  snapshot: prSnapshot,
  method: "utility_ai",
  report: {
    summary: "Three observations require consideration.",
    complete: true,
    warnings: [],
    coverage: [
      {
        sourceId: "review-1",
        segmentIds: ["review-1:0"],
        disposition: "analyzed",
        reason: "Reviewed",
      },
    ],
    actions: observations.map((observation, index) => ({
      ...observation,
      id: `action-${index}`,
      reviewer: "reviewer",
      sourceUrl:
        "https://github.com/upstream/project/pull/1#pullrequestreview-1",
      sourceThreadId: null,
      threadResolved: null,
      outdated: null,
      codeStatus: "unverified",
    })),
  },
};
const install = (analyses = [session]) => {
  const rpc = vi.fn(async (method: string) =>
    method === "scheduled.detail" ? { analyses, runs: [], usage: [] } : {},
  );
  window.vibestar = {
    rpc,
    openExternal: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(() => () => {}),
  } as unknown as typeof window.vibestar;
  return rpc;
};
const snapshot: Snapshot = {
  repositories: [],
  tasks: [],
  root: "/data",
  settings: {
    ...defaultSettings,
    utility_ai: {
      ...defaultSettings.utility_ai,
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "xhigh",
    },
  },
  scheduled: [job],
  attention: [],
};

it("shows the configured analysis model and performs no inspection/inference merely by opening the inbox", () => {
  const rpc = install();
  render(
    <ScheduledPage snapshot={snapshot} refresh={vi.fn()} open={vi.fn()} />,
  );
  expect(screen.getByText(/gpt-6.1-sol/).textContent).toContain("xhigh");
  expect(screen.queryByText("Resume")).toBeNull();
  expect(screen.queryByText("Automatically watch new PRs")).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it("refreshes GitHub metadata without a manual tracking form or inference", async () => {
  const rpc = install();
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(
    <ScheduledPage
      snapshot={{ ...snapshot, scheduled: [] }}
      refresh={refresh}
      open={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh PR List" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("github.sync", {}));
  expect(screen.queryByLabelText("PR URL")).toBeNull();
  expect(screen.queryByRole("button", { name: "Track PR" })).toBeNull();
  expect(
    rpc.mock.calls.some(([method]) => method === "scheduled.analyze"),
  ).toBe(false);
});

const discoveredPR = {
  url: job.url,
  repository: "upstream/project",
  number: 1,
  title: "Discovered contribution",
  state: "OPEN",
  draft: true,
  head_branch: "contribution",
  head_repository: "viewer/project",
  updated_at: "2026-10-23T12:00:00Z",
  task_id: null,
};
const discoveredSnapshot: Snapshot = {
  ...snapshot,
  scheduled: [],
  github: {
    status: {
      installed: true,
      connected: true,
      username: "viewer",
      version: "gh",
      error: null,
    },
    error: null,
    last_sync: "2026-10-23T12:00:00Z",
    repositories: [],
    settings: { auto_watch: false, interval_minutes: 60, verify_codex: false },
    pull_requests: [discoveredPR],
  },
};

it("opens discovered PRs through an inactive saved record without analyzing them", async () => {
  const rpc = install();
  rpc.mockImplementation(async (method) =>
    method === "scheduled.add" ? job : {},
  );
  const refresh = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <ScheduledPage
      snapshot={discoveredSnapshot}
      refresh={refresh}
      open={vi.fn()}
    />,
  );
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: discoveredPR.title }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(rpc).toHaveBeenCalledWith("scheduled.add", {
    url: job.url,
    task_id: null,
    interval_minutes: 60,
    verify_codex: false,
  });
  rerender(
    <ScheduledPage
      snapshot={{ ...discoveredSnapshot, scheduled: [job] }}
      refresh={refresh}
      open={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Pull request details" }),
  ).toBeTruthy();
  expect(
    rpc.mock.calls.some(
      ([method]) =>
        method === "scheduled.analyze" || method === "scheduled.run",
    ),
  ).toBe(false);
});

it("merges duplicate discoveries, filters saved metadata and retains rows after a failed refresh", () => {
  const rpc = install();
  render(
    <ScheduledPage
      snapshot={{
        ...discoveredSnapshot,
        scheduled: [job],
        github: {
          ...discoveredSnapshot.github!,
          error: "GitHub rate limit reached",
        },
      }}
      refresh={vi.fn()}
      open={vi.fn()}
    />,
  );
  expect(
    screen.getAllByRole("button", { name: discoveredPR.title }),
  ).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain(
    "GitHub rate limit reached",
  );
  expect(screen.getByRole("button", { name: "Retry refresh" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search pull requests"), {
    target: { value: "not found" },
  });
  expect(
    screen.getByRole("heading", { name: "No matching pull requests" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("button", { name: discoveredPR.title })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Filter by status"), {
    target: { value: "MERGED" },
  });
  expect(screen.queryByRole("button", { name: discoveredPR.title })).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it("launches one explicit analysis and reads local saved details when opening its report", async () => {
  const rpc = install();
  render(
    <ScheduledPage
      snapshot={snapshot}
      refresh={vi.fn().mockResolvedValue(undefined)}
      open={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Analyze Again" }));
  await waitFor(() =>
    expect(
      rpc.mock.calls.filter(([method]) => method === "scheduled.analyze"),
    ).toHaveLength(1),
  );
  expect(
    rpc.mock.calls.some(
      ([method]) => method === "github.sync" || method === "scheduled.run",
    ),
  ).toBe(false);
  expect(
    screen.getByRole("dialog", { name: "Pull request details" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Solve Review" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("renders the entire original multiline review, source links, independent observations and positive feedback", async () => {
  install();
  const { container } = render(
    <PrDetails
      job={job}
      configuration={defaultSettings.utility_ai}
      close={vi.fn()}
    />,
  );
  await screen.findByText("Three observations require consideration.");
  fireEvent.click(screen.getByRole("tab", { name: "Full Conversation" }));
  expect(container.textContent).toContain(
    "those selectors and expect functions are moved into the utility files",
  );
  expect(container.textContent).toContain(
    "This is not mentioned in the PR description.",
  );
  expect(container.textContent).toContain(
    "it may miss some problem in that behavior",
  );
  expect(container.textContent).toContain(
    "Apart from that, everything seems to be fine to me.",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Original GitHub discussion" }),
  );
  expect(window.vibestar.openExternal).toHaveBeenCalledWith(
    prSnapshot.discussion![0].url,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Review Actions" }));
  expect(
    screen.getByRole("heading", { name: "Outstanding observations" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Questions I should answer" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Positive feedback / information" }),
  ).toBeTruthy();
  expect(container.textContent).toContain("positive feedback");
  expect(container.textContent).toContain("no author reply");
  expect(container.textContent).toContain("Code: unverified");
  fireEvent.click(
    screen.getAllByRole("button", { name: "Original review" })[0],
  );
  expect(
    screen.getByRole("button", { name: "Original GitHub discussion" }),
  ).toBeTruthy();
});

it("keeps incomplete coverage and cancellation visible and preserves a complete historical report", async () => {
  const cancelled: PRAnalysisSession = {
    ...session,
    id: "cancelled",
    status: "cancelled",
    phase: "Analysis cancelled — no automatic retry",
    error: "Stopped by user",
    report: undefined,
    method: "utility_ai",
  };
  install([cancelled, session]);
  render(<PrDetails job={{ ...job, status: "interrupted" }} close={vi.fn()} />);
  await screen.findByText(/Stopped by user/);
  fireEvent.click(screen.getByRole("tab", { name: "Analysis History" }));
  fireEvent.click(screen.getByRole("button", { name: /completed/ }));
  expect(
    screen.getByText("Three observations require consideration."),
  ).toBeTruthy();
  cleanup();
  install([
    {
      ...session,
      status: "partial",
      report: {
        ...session.report!,
        complete: false,
        warnings: ["Source review-2 was deferred."],
      },
    },
  ]);
  render(<PrDetails job={job} close={vi.fn()} />);
  await screen.findByText(/Every request has not been assessed/);
  expect(screen.getByText("Source review-2 was deferred.")).toBeTruthy();
});
