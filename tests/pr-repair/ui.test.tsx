// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { defaultSettings } from "../../backend/domain";
import { SolveReview } from "../../src/features/pull-requests/repair/SolveReview";
import { RepairWorkspace } from "../../src/features/pull-requests/repair/RepairWorkspace";
import type { RepairDetail } from "../../src/features/pull-requests/repair/types";
import type { RepairSession } from "../../backend/review/repair/contracts";
import { observations, prSnapshot } from "../helpers/pr-fixtures";

vi.mock("../../src/components/shared/TaskTerminal", () => ({
  TaskTerminal: () => <p>Terminal fixture view</p>,
}));

HTMLElement.prototype.scrollTo = vi.fn();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const session: RepairSession = {
  id: "repair-ui",
  job_id: "job",
  repo_id: "repo",
  analysis_id: "analysis",
  identity: {
    id: "PR_27527",
    number: 27527,
    url: "https://github.com/oppia/oppia/pull/27527",
    upstream: {
      name: "oppia/oppia",
      id: "R_base",
      url: "https://github.com/oppia/oppia.git",
    },
    head: {
      name: "akshajrawat/oppia",
      id: "R_head",
      url: "https://github.com/akshajrawat/oppia.git",
      branch: "fix-translation-tests",
      sha: "a".repeat(40),
    },
    base: { branch: "develop", sha: "b".repeat(40) },
    viewer: "akshajrawat",
    can_push: true,
    state: "open",
    checked_at: "2026-10-14T10:00:00Z",
  },
  context: {
    id: "analysis",
    job_id: "job",
    status: "completed",
    phase: "complete",
    started_at: "2026-10-14T10:00:00Z",
    ended_at: "2026-10-14T10:00:00Z",
    configuration: defaultSettings.utility_ai,
    snapshot: {
      ...prSnapshot,
      identity: { ...prSnapshot.identity!, baseRepository: "oppia/oppia" },
    },
    report: {
      summary: "Three concerns",
      complete: true,
      warnings: [],
      actions: [],
      coverage: [],
    },
  },
  actions: observations.slice(0, 3).map((item, index) => ({
    ...item,
    id: `action-${index}`,
    reviewer: "reviewer",
    sourceUrl: null,
    sourceThreadId: null,
    threadResolved: null,
    outdated: null,
    codeStatus: "unverified",
  })),
  instructions: "",
  configuration: {
    codex: defaultSettings.codex_implementation,
    antigravity: defaultSettings.antigravity,
  },
  workspace: {
    branch_name: "akkco/pr-27527-session",
    worktree_path: "/data/worktrees/repo/pr-27527-session",
    branch_owned: true,
    git_common_dir: "/source/.git",
    source_worktrees: "",
    original_head: "a".repeat(40),
    original_base: "b".repeat(40),
    fetched_base: "c".repeat(40),
    integrated_head: "d".repeat(40),
    merge_commit: "d".repeat(40),
    merge_state: "complete",
    conflict_paths: [],
    conflict_index: "",
    preparation: "ready",
    remote_head: "a".repeat(40),
    remote_checked_at: "2026-10-14T10:00:00Z",
  },
  status: "awaiting_manual_review",
  error: null,
  created_at: "2026-10-14T10:00:00Z",
  updated_at: "2026-10-14T10:00:00Z",
  review_hash: "e".repeat(64),
  approved_hash: null,
  implementation: null,
  verification: null,
};

session.context.report!.actions = session.actions;

session.implementation = {
  summary: "Targeted implementation report",
  items: session.actions.map((item) => ({
    actionId: item.id,
    status: "implemented",
    explanation: "Implemented and tested",
    files: ["spec.ts"],
    tests: [],
  })),
  tests: [],
  risks: [],
};

session.verification = {
  overall: "approved",
  summary: "Independent verification report",
  items: session.actions.map((item) => ({
    actionId: item.id,
    status: "accepted",
    explanation: "Review concern addressed",
    files: ["spec.ts"],
  })),
  tests: [
    {
      command: "browser integration",
      status: "blocked",
      evidence: "Browser unavailable",
    },
  ],
  risks: [],
};

const install = (handler: (method: string, params: Record<string, unknown>) => unknown) => {
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>) =>
    handler(method, params),
  );

  window.vibestar = {
    rpc,
    subscribe: vi.fn(() => () => {}),
    openExternal: vi.fn(async () => {}),
  } as unknown as typeof window.vibestar;

  return rpc;
};

it("preserves reviewer text, item deselection and instructions while requiring an explicit selected repository", async () => {
  const rpc = install((method) => (method === "repair.create" ? session : {}));
  const open = vi.fn();

  render(
    <SolveReview
      analysis={session.context}
      repositories={[
        {
          id: "repo",
          owner: "oppia",
          name: "oppia",
          upstream_url: session.identity.upstream.url,
          origin_url: null,
          base_branch: "develop",
          path: "/personal/oppia",
          connected: true,
          source: "imported",
          created_at: session.created_at,
          last_fetched: null,
        },
      ]}
      settings={defaultSettings}
      close={vi.fn()}
      refresh={async () => {}}
      open={open}
    />,
  );

  expect(screen.getByText(session.actions[1].originalText)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Solve review item 2"));

  fireEvent.change(screen.getByLabelText("Additional repair instructions"), {
    target: { value: "Keep changes focused" },
  });

  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Solve selected items" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(session.id));

  expect(rpc).toHaveBeenCalledWith(
    "repair.create",
    expect.objectContaining({
      repository_id: "repo",
      action_ids: ["action-0", "action-2"],
      instructions: "Keep changes focused",
    }),
  );
});

it("keeps complete repair history and manual review visible, shares Readable/Raw output and requests each diff layer explicitly", async () => {
  const detail: RepairDetail = {
    session,
    active: false,
    runs: [],
    events: [],
    messages: [],
    tests: [],
    usage: [],
    activity: [],
    publications: [],
  };

  const rpc = install((method) =>
    method === "repair.detail"
      ? detail
      : method === "repair.diff"
        ? { files: [], insertions: 0, deletions: 0, base: "d".repeat(40) }
        : method === "repair.reviewFiles"
          ? []
          : {},
  );

  render(
    <RepairWorkspace
      id={session.id}
      revision={0}
      refresh={async () => {}}
      back={vi.fn()}
      analyze={vi.fn()}
    />,
  );

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Review repair",
    }),
  );

  await screen.findByRole("heading", {
    name: "PR Review Repair Complete — Manual Review Required",
  });

  expect(screen.getByText("Targeted implementation report")).toBeTruthy();
  expect(screen.getByText("Independent verification report")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Commit Locally" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve and Prepare Push" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(screen.getByText("Terminal fixture view")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Toggle utility dock"));

  expect(
    rpc.mock.calls.some(([method]) =>
      [
        "repair.create",
        "repair.start",
        "repair.approve",
        "repair.publish",
        "scheduled.analyze",
      ].includes(method),
    ),
  ).toBe(false);

  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Original PR changes" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("repair.diff", {
      id: session.id,
      layer: "original",
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Upstream integration" }));

  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith("repair.diff", {
      id: session.id,
      layer: "upstream",
    }),
  );

  fireEvent.click(screen.getByRole("tab", { name: "Raw logs" }));
  expect(screen.getByRole("button", { name: "Readable" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Raw" })).toBeTruthy();
  const tabs = screen.getByRole("tablist", { name: "Workspace tools" });

  const first = within(tabs).getByRole("tab", {
    name: "Workflow",
  });

  first.focus();
  fireEvent.keyDown(first, { key: "End" });

  expect(within(tabs).getByRole("tab", { name: "Raw logs" }).getAttribute("aria-selected")).toBe(
    "true",
  );

  fireEvent.click(screen.getByLabelText("Toggle utility dock"));

  expect(
    within(screen.getByRole("tablist", { name: "Utilities" }))
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Terminal", "Problems"]);
});

it.each([
  ["active", true, "codex_implementing"],
  ["published", false, "published"],
  ["conflict", false, "merge_conflict"],
  ["stale", false, "stale_remote_head"],
  ["publication", false, "ready_to_publish"],
] as const)(
  "retains a local draft and rejects Enter-to-run in a %s repair",
  async (label, active, status) => {
    const id = `repair-draft-${label}`;

    const detail: RepairDetail = {
      session: { ...session, id, status },
      active,
      runs: [],
      events: [],
      messages: [],
      tests: [],
      usage: [],
      activity: [],
      publications: [],
    };

    const rpc = install((method) =>
      method === "repair.detail"
        ? detail
        : method === "repair.reviewFiles"
          ? []
          : method === "repair.diff"
            ? { files: [], insertions: 0, deletions: 0, base: "base" }
            : {},
    );

    render(
      <RepairWorkspace
        id={id}
        revision={0}
        refresh={async () => {}}
        back={vi.fn()}
        analyze={vi.fn()}
      />,
    );

    const input = (await screen.findByLabelText("PR repair follow-up")) as HTMLTextAreaElement;

    fireEvent.change(input, {
      target: { value: "Keep this instruction for later" },
    });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("Keep this instruction for later");

    if (detail.active) expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy();
    else
      expect(
        (screen.getByRole("button", { name: "Request Further Fix" }) as HTMLButtonElement).disabled,
      ).toBe(true);

    expect(rpc.mock.calls.some(([method]) => method === "repair.start")).toBe(false);
  },
);
