// @vitest-environment jsdom
import { useState } from "react";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IssueWatchPage } from "../../src/features/issue-watch/IssueWatchPage";
import { IssueMarkdown } from "../../src/features/issue-watch/IssueMarkdown";
import { NewTask } from "../../src/features/tasks/NewTask";
import { useWatchNotifications } from "../../src/features/issue-watch/notifications";
import type { CoreEvent, Snapshot } from "../../src/lib/types";
import { githubIssue, watchFixture } from "./fixtures";
import { ScanResults } from "../../src/features/issue-watch/ScanResults";
import type { CandidateSummary } from "../../backend/issue-watch/contracts";

vi.mock("../../src/hooks/useWorkspace", () => ({
  useProviders: () => ({
    providers: [
      {
        provider: "codex",
        installed: true,
        connected: true,
        capabilities: ["fixture"],
        models: [
          {
            id: "fixture-model",
            label: "Fixture model",
            supportedEfforts: ["medium"],
          },
        ],
        efforts: ["medium"],
        error: null,
      },
    ],
    loading: false,
    error: "",
    refresh: vi.fn(),
  }),
}));

const resources: Awaited<ReturnType<typeof watchFixture>>[] = [];

afterEach(async () => {
  cleanup();
  localStorage.clear();
  for (const f of resources.splice(0)) await f.close();
  vi.restoreAllMocks();
});

const setup = async () => {
  localStorage.clear();
  const f = await watchFixture();
  resources.push(f);

  const snapshot: Snapshot = {
    repositories: [],
    tasks: [],
    root: f.engine.root,
    settings: f.engine.db.settings(),
    capabilities: { manual_issue_watch: true, issue_watch_contract: 1 },
  };

  const listeners = new Set<(event: CoreEvent) => void>();

  const api = vi.fn(async (method: string, params: unknown) => {
    if (method.startsWith("issueWatch.")) return f.service.call(method.slice(11), params);
    if (method === "snapshot") return snapshot;
    if (method === "usage.info") return { database: "fixture.sqlite" };
    throw new Error(`Unexpected renderer RPC ${method}`);
  });

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: {
      rpc: api,
      subscribe: (listener: (event: CoreEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  });

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });

  f.engine.on("event", (event) => listeners.forEach((listener) => listener(event)));
  return {
    f,
    snapshot,
    api,
    emit: (event: CoreEvent) => listeners.forEach((listener) => listener(event)),
  };
};

it("loads older local history pages without GitHub reads or inference", async () => {
  const { f, snapshot } = await setup();
  const { watch } = await f.create();
  const first = await f.scan(watch.id);
  for (let index = 0; index < 52; index++)
    f.service.store.reserve({ ...first, id: randomUUID() }, randomUUID(), randomUUID());
  const reads = f.api.mock.calls.length;
  const infer = vi.spyOn(f.engine.utility, "run");
  render(<IssueWatchPage snapshot={snapshot} initialWatchId={watch.id} startTask={vi.fn()} />);

  const load = await screen.findByRole(
    "button",
    {
      name: "Load older attempts",
    },
    { timeout: 5000 },
  );

  fireEvent.click(load);

  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Load older attempts" })).toBeNull(),
  );

  const select = screen.getByLabelText("Scan history");
  fireEvent.click(select);
  expect(screen.getAllByRole("option")).toHaveLength(54);

  fireEvent.click(
    screen.getAllByRole("option").find((option) => option.getAttribute("data-value") === first.id)!,
  );

  await screen.findByRole("button", { name: /Select #1: Issue 1/ });
  expect(f.api).toHaveBeenCalledTimes(reads);
  expect(infer).not.toHaveBeenCalled();
});

it("previews and saves a watch without inference or a scan, using an explicitly selected official model", async () => {
  const { f, snapshot, api } = await setup();
  const infer = vi.spyOn(f.engine.utility, "run");
  render(<IssueWatchPage snapshot={snapshot} startTask={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "New watch" }));
  const dialog = screen.getByRole("dialog", { name: "New Issue Watch" });

  fireEvent.change(within(dialog).getByLabelText("Watch name"), {
    target: { value: "Contribution search" },
  });

  fireEvent.change(within(dialog).getByLabelText("GitHub repository"), {
    target: { value: "oppia/oppia" },
  });

  fireEvent.change(within(dialog).getByLabelText("Describe issues to find"), {
    target: { value: "Open issues" },
  });

  fireEvent.click(within(dialog).getByRole("combobox", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "Fixture model" }));

  expect(within(dialog).queryByRole("button", { name: "Preview hard filters" })).toBeNull();
  await within(dialog).findByText(/Open issues · Unassigned/);
  expect(f.api).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save watch" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByRole("button", { name: "Scan now" });
  expect(f.service.store.list()).toHaveLength(1);
  expect(f.service.store.history(f.service.store.list()[0].id)).toEqual([]);
  expect(f.api).toHaveBeenCalledTimes(1);
  expect(infer).not.toHaveBeenCalled();
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(api).toHaveBeenCalledWith("issueWatch.detail", expect.anything()));
  expect(api.mock.calls.some(([method]) => method === "issueWatch.scan")).toBe(false);
  expect(infer).not.toHaveBeenCalled();
});

it("saves ordinary natural-language preferences without an interpretation dropdown or upgrading them to hard filters", async () => {
  const { f, snapshot } = await setup();
  const infer = vi.spyOn(f.engine.utility, "run");
  render(<IssueWatchPage snapshot={snapshot} startTask={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "New watch" }));
  const editor = screen.getByRole("dialog", { name: "New Issue Watch" });

  fireEvent.change(within(editor).getByLabelText("Watch name"), {
    target: { value: "Triaged contributions" },
  });

  fireEvent.change(within(editor).getByLabelText("GitHub repository"), {
    target: { value: "oppia/oppia" },
  });

  fireEvent.change(within(editor).getByLabelText("Describe issues to find"), {
    target: {
      value: "Find open unassigned issues, only small triaged tasks without competing PRs.",
    },
  });

  fireEvent.click(within(editor).getByRole("combobox", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: "Fixture model" }));
  await within(editor).findByText("Guaranteed GitHub filters");
  expect(within(editor).getByText("Requires evidence inspection")).toBeTruthy();
  expect(within(editor).queryByText("Treat remaining text as AI preferences")).toBeNull();
  fireEvent.click(within(editor).getByRole("button", { name: "Save watch" }));
  await screen.findByRole("button", { name: "Scan now" });
  const watch = f.service.store.list()[0];
  const config = f.service.store.revision(watch.id).configuration;

  expect(config.rules).toMatchObject({
    open_only: true,
    unassigned_only: true,
    excluded_labels: [],
  });

  expect(config.ambiguity_decisions).toContainEqual({
    id: "remaining-requirements",
    interpretation: "semantic_preference",
  });

  expect(f.service.store.history(watch.id)).toEqual([]);
  expect(infer).not.toHaveBeenCalled();
});

it("keeps completed results visible during real pending GitHub activity and cancels without advancing the baseline", async () => {
  const { f, snapshot, api } = await setup();
  const { watch } = await f.create();
  const first = await f.scan(watch.id);
  let release = () => {};

  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  f.overrides.set("repos/oppia/oppia", async () => {
    await pending;
    return {
      node_id: "R_oppia",
      full_name: "oppia/oppia",
      html_url: "https://github.com/oppia/oppia",
    };
  });

  try {
    render(<IssueWatchPage snapshot={snapshot} initialWatchId={watch.id} startTask={vi.fn()} />);
    await screen.findByRole("button", { name: /Select #1: Issue 1/ });
    fireEvent.click(await screen.findByRole("button", { name: "Scan now" }));
    await screen.findAllByText("Fetching GitHub issues");
    expect(screen.getByRole("button", { name: /Select #1: Issue 1/ })).toBeTruthy();
    await screen.findByText(/Showing previous complete results/);
    expect(screen.queryByText("No matching issues in this scan")).toBeNull();
    expect(screen.getByText(/1 GitHub requests/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
    release();
    await waitFor(() => expect(f.service.store.history(watch.id)[0].status).toBe("cancelled"));
    expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(first.id);
    expect(api.mock.calls.filter(([method]) => method === "issueWatch.scan")).toHaveLength(1);
  } finally {
    release();
  }
});

it("opens saved results and the existing prefilled task form without queueing a task or claiming an issue", async () => {
  const { f, snapshot, api } = await setup();
  const { watch } = await f.create();
  const infer = vi.spyOn(f.engine.utility, "run");

  const Handoff = () => {
    const [prefill, setPrefill] = useState<{ url: string; notes: string }>();
    return (
      <>
        <IssueWatchPage
          snapshot={snapshot}
          startTask={(url, notes) => setPrefill({ url, notes })}
        />

        {prefill && (
          <NewTask
            initialIssueUrl={prefill.url}
            initialNotes={prefill.notes}
            close={() => setPrefill(undefined)}
            created={vi.fn()}
          />
        )}
      </>
    );
  };

  render(<Handoff />);
  fireEvent.click(await screen.findByRole("button", { name: /Oppia opportunities/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Scan now" }));
  await screen.findByText("Scan complete");
  expect(f.service.store.history(watch.id)).toHaveLength(1);
  expect(infer).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: /Select #1: Issue 1/ }));
  await screen.findByRole("complementary", { name: "Selected issue details" });
  expect(screen.queryByText("Original issue 1")).toBeNull();
  expect(screen.queryByText("Original issue description")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  const form = screen.getByRole("dialog", { name: "New task" });

  expect((within(form).getByLabelText("Issue URL") as HTMLInputElement).value).toBe(
    "https://github.com/oppia/oppia/issues/1",
  );

  expect(
    (within(form).getByLabelText("Optional instructions") as HTMLTextAreaElement).value,
  ).toContain("Issue Watch discovery");

  expect(api.mock.calls.some(([method]) => method === "task.create")).toBe(false);
  expect(f.engine.db.tasks()).toEqual([]);
  expect(infer).not.toHaveBeenCalled();
});

it("isolates unsafe Markdown, skips images and opens only verified HTTPS GitHub links", async () => {
  await setup();
  const error = vi.fn();

  const rendered = render(
    <IssueMarkdown
      text={
        "<script>alert(1)</script>\n\n![remote image](https://evil.test/pixel)\n\n[bad](javascript:alert(1)) [external](https://evil.test/a) [issue](https://github.com/oppia/oppia/issues/1)"
      }
      onError={error}
    />,
  );

  expect(rendered.container.querySelector("script")).toBeNull();
  expect(rendered.container.querySelector("img")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  fireEvent.click(screen.getByRole("link", { name: "issue" }));

  expect(window.vibestar.openExternal).toHaveBeenCalledWith(
    "https://github.com/oppia/oppia/issues/1",
  );
});

it("requires a helper capability before any feature RPC and keeps completion notices local and deduplicated", async () => {
  const { snapshot, api, emit } = await setup();

  const rendered = render(
    <IssueWatchPage
      snapshot={{
        ...snapshot,
        capabilities: { manual_issue_watch: false, issue_watch_contract: null },
      }}
      startTask={vi.fn()}
    />,
  );

  expect(screen.getByText(/Update the execution helper/)).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
  rendered.unmount();

  const Notices = () => {
    const { notices } = useWatchNotifications(true);
    return (
      <div>
        {notices.map((notice) => (
          <p key={notice.id}>{notice.text}</p>
        ))}
      </div>
    );
  };

  const page = render(<Notices />);
  await Promise.resolve();

  const event = {
    event: "issue-watch.completed",
    watch_id: "watch",
    scan_id: "scan",
    data: {
      status: "completed",
      summary: { initial_discovery: 2, manual_review: 1 },
    },
  };

  emit(event);
  emit(event);
  await screen.findByText(/2 initial discoveries, 0 existing matches, 1 require manual review/);
  expect(screen.getAllByText(/2 initial discoveries/)).toHaveLength(1);
  page.unmount();
  render(<Notices />);
  await Promise.resolve();
  emit(event);
  expect(screen.queryByText(/2 initial discoveries/)).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

it("opens a full-width watch list and returns to it without scanning", async () => {
  const { f, snapshot, api } = await setup();
  await f.create();
  const infer = vi.spyOn(f.engine.utility, "run");
  render(<IssueWatchPage snapshot={snapshot} startTask={vi.fn()} />);
  const topic = await screen.findByRole("button", { name: /Oppia opportunities/ });
  expect(screen.queryByRole("button", { name: "Scan now" })).toBeNull();
  fireEvent.click(topic);
  await screen.findByRole("button", { name: "Scan now" });
  fireEvent.click(screen.getByRole("button", { name: "All watches" }));
  await screen.findByRole("button", { name: /Oppia opportunities/ });
  expect(screen.queryByRole("button", { name: "Scan now" })).toBeNull();

  expect(api.mock.calls.some(([method]) => /issueWatch\.(scan|retry|continue)$/.test(method))).toBe(
    false,
  );

  expect(infer).not.toHaveBeenCalled();
});

it("sorts globally by creation or update date, persists sorting and keeps provisional availability uncertain", async () => {
  const { f } = await setup();

  f.issues.set(3, {
    ...githubIssue(3),
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2026-10-26T00:00:00Z",
  });

  f.issues.get(1)!.created_at = "2026-10-25T00:00:00Z";
  const { watch } = await f.create();
  const scan = await f.scan(watch.id);

  const candidates: CandidateSummary[] = f.service.store
    .candidates(watch.id, scan.id)
    .filter((candidate) => [1, 3].includes(candidate.issue.number))
    .map((candidate, index) => ({
      ...candidate,
      classification: index ? "existing_match" : "initial_discovery",
      eligible: true,
      uncertainty: [],
      claim_state: "candidate_for_claim_request",
      body_bytes: 0,
      evidence_count: 0,
      source_count: 0,
    }));

  const props = {
    candidates,
    selected: "",
    onSelect: vi.fn(),
    provisional: false,
    showDismissed: false,
    onError: vi.fn(),
  };

  const ui = render(<ScanResults {...props} />);

  const numbers = () =>
    screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".watch-issue-number")!.textContent);

  expect(numbers()).toEqual(["#1", "#3"]);
  fireEvent.click(screen.getByRole("combobox", { name: "Sort issues" }));
  fireEvent.click(screen.getByRole("option", { name: "Oldest first" }));
  expect(numbers()).toEqual(["#3", "#1"]);
  ui.unmount();
  const restored = render(<ScanResults {...props} />);
  expect(numbers()).toEqual(["#3", "#1"]);
  fireEvent.click(screen.getByRole("combobox", { name: "Sort issues" }));
  fireEvent.click(screen.getByRole("option", { name: "Recently updated" }));
  expect(numbers()).toEqual(["#3", "#1"]);

  fireEvent.change(screen.getByRole("searchbox", { name: "Search issues" }), {
    target: { value: "Issue 1" },
  });

  expect(numbers()).toEqual(["#1"]);
  restored.rerender(<ScanResults {...props} provisional />);
  expect(screen.queryByText("Available to request")).toBeNull();
  expect(screen.getByText("Recheck needed")).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "Filter results" }));
  fireEvent.click(screen.getByRole("option", { name: "Available to request" }));
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
});

it("starts with matching issues and exposes exclusions through All results", async () => {
  const { f } = await setup();
  f.issues.set(3, { ...githubIssue(3), state: "closed" });
  const { watch } = await f.create();
  const scan = await f.scan(watch.id);

  const candidates: CandidateSummary[] = f.service.store
    .candidates(watch.id, scan.id)
    .map((candidate) => ({
      ...candidate,
      body_bytes: 0,
      evidence_count: candidate.evidence.length,
      source_count: candidate.source_keys.length,
    }));

  expect(candidates.some((candidate) => !candidate.eligible)).toBe(true);

  render(
    <ScanResults
      candidates={candidates}
      selected=""
      onSelect={vi.fn()}
      provisional={false}
      showDismissed={false}
      onError={vi.fn()}
    />,
  );

  expect(screen.getAllByRole("listitem")).toHaveLength(
    candidates.filter((candidate) => candidate.eligible).length,
  );

  fireEvent.click(screen.getByRole("combobox", { name: "Filter results" }));
  fireEvent.click(screen.getByRole("option", { name: "All results" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(candidates.length);
});
