// @vitest-environment jsdom
import { useState } from "react";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { IssueWatchPage } from "../../src/components/issue-watch/IssueWatchPage";
import { IssueMarkdown } from "../../src/components/issue-watch/IssueMarkdown";
import { NewTask } from "../../src/components/NewTask";
import { useWatchNotifications } from "../../src/lib/issue-watch/notifications";
import type { CoreEvent, Snapshot } from "../../src/lib/types";
import { watchFixture } from "./fixtures";

vi.mock("../../src/lib/useWorkspace", () => ({
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
    if (method.startsWith("issueWatch."))
      return f.service.call(method.slice(11), params);
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
  f.engine.on("event", (event) =>
    listeners.forEach((listener) => listener(event)),
  );
  return {
    f,
    snapshot,
    api,
    emit: (event: CoreEvent) =>
      listeners.forEach((listener) => listener(event)),
  };
};

it("loads older local history pages without GitHub reads or inference", async () => {
  const { f, snapshot } = await setup();
  const { watch } = await f.create();
  const first = await f.scan(watch.id);
  for (let index = 0; index < 52; index++)
    f.service.store.reserve(
      { ...first, id: randomUUID() },
      randomUUID(),
      randomUUID(),
    );
  const reads = f.api.mock.calls.length;
  const infer = vi.spyOn(f.engine.utility, "run");
  render(
    <IssueWatchPage
      snapshot={snapshot}
      initialWatchId={watch.id}
      startTask={vi.fn()}
    />,
  );
  const load = await screen.findByRole(
    "button",
    {
      name: "Load older attempts",
    },
    { timeout: 5000 },
  );
  fireEvent.click(load);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Load older attempts" }),
    ).toBeNull(),
  );
  const select = screen.getByLabelText("Scan history");
  expect(within(select).getAllByRole("option")).toHaveLength(54);
  fireEvent.change(select, { target: { value: first.id } });
  await screen.findByText("Initial discoveries");
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
  fireEvent.change(
    within(dialog).getByLabelText("What issues are you looking for?"),
    { target: { value: "Open issues" } },
  );
  fireEvent.change(within(dialog).getByLabelText("Model"), {
    target: { value: "fixture-model" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Preview hard filters" }),
  );
  await within(dialog).findByText(/Confirmed rule preview/);
  expect(f.api).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save watch" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByRole("button", { name: "Scan Now" });
  expect(f.service.store.list()).toHaveLength(1);
  expect(f.service.store.history(f.service.store.list()[0].id)).toEqual([]);
  expect(f.api).toHaveBeenCalledTimes(1);
  expect(infer).not.toHaveBeenCalled();
  fireEvent(window, new Event("focus"));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("issueWatch.detail", expect.anything()),
  );
  expect(api.mock.calls.some(([method]) => method === "issueWatch.scan")).toBe(
    false,
  );
  expect(infer).not.toHaveBeenCalled();
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
  fireEvent.click(await screen.findByRole("button", { name: "Scan Now" }));
  await screen.findByText("Scan complete within the declared collection scope");
  expect(f.service.store.history(watch.id)).toHaveLength(1);
  expect(infer).not.toHaveBeenCalled();
  await screen.findByText("Original issue 1");
  fireEvent.click(screen.getByRole("button", { name: "Start Vibestar Task" }));
  const form = screen.getByRole("dialog", { name: "New task" });
  expect(
    (within(form).getByLabelText("Issue URL") as HTMLInputElement).value,
  ).toBe("https://github.com/oppia/oppia/issues/1");
  expect(
    (
      within(form).getByLabelText(
        "Optional instructions",
      ) as HTMLTextAreaElement
    ).value,
  ).toContain("Issue Watch discovery");
  expect(api.mock.calls.some(([method]) => method === "task.create")).toBe(
    false,
  );
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
  await screen.findByText(
    /2 initial discoveries, 0 existing matches, 1 require manual review/,
  );
  expect(screen.getAllByText(/2 initial discoveries/)).toHaveLength(1);
  page.unmount();
  render(<Notices />);
  await Promise.resolve();
  emit(event);
  expect(screen.queryByText(/2 initial discoveries/)).toBeNull();
  expect(api).not.toHaveBeenCalled();
});
