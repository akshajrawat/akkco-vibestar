// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { defaultSettings } from "../../backend/domain";
import { SolveReview } from "../../src/components/repair/SolveReview";
import { RepairWorkspace } from "../../src/components/repair/RepairWorkspace";
import { PublicationDialog } from "../../src/components/repair/PublicationDialog";
import { LocalCommitDialog } from "../../src/components/repair/LocalCommitDialog";
import type {
  RepairPublication,
  RepairDetail,
} from "../../src/components/repair/types";
import type { RepairSession } from "../../backend/review/repair/contracts";
import { observations, prSnapshot } from "../pr-fixtures";
vi.mock("../../src/components/TaskTerminal", () => ({
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
const plan: RepairPublication = {
  id: "publication",
  repair_id: session.id,
  pr_url: session.identity.url,
  destination: {
    repository: session.identity.head.name,
    repository_id: session.identity.head.id,
    url: session.identity.head.url,
    branch: session.identity.head.branch,
  },
  expected_remote_head: "a".repeat(40),
  local_head: "f".repeat(40),
  fingerprint: session.review_hash!,
  upstream_base: { branch: "develop", sha: "c".repeat(40) },
  dirty: true,
  changes: { files: 3, additions: 20, deletions: 4 },
  validation: { observed_passed: 2, observed_failed: 0, reported_blocked: 1 },
  commits: [],
  confirmation: {
    viewer: "akshajrawat",
    approved_at: "2026-10-14T10:00:00Z",
    reviewed_hash: session.review_hash!,
    confirmed_at: null,
  },
  outcome: "prepared",
  error: null,
  created_at: "2026-10-14T10:00:00Z",
  updated_at: "2026-10-14T10:00:00Z",
  published_at: null,
};
const install = (
  handler: (method: string, params: Record<string, unknown>) => unknown,
) => {
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
  await screen.findByRole("heading", {
    name: "PR Review Repair Complete — Manual Review Required",
  });
  expect(screen.getByText("Targeted implementation report")).toBeTruthy();
  expect(screen.getByText("Independent verification report")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
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
  fireEvent.click(screen.getByRole("tab", { name: "Agent Output" }));
  expect(screen.getByRole("button", { name: "Readable" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Raw" })).toBeTruthy();
  const tabs = screen.getByRole("tablist", { name: "PR repair utilities" });
  const first = within(tabs).getByRole("tab", { name: "Changes" });
  first.focus();
  fireEvent.keyDown(first, { key: "End" });
  expect(
    within(tabs)
      .getByRole("tab", { name: "Terminal" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("shows exact publication values and requires separate commit and explicit push confirmation", async () => {
  const clean = { ...plan, dirty: false };
  const rpc = install((method) =>
    method === "repair.preparePublication"
      ? clean
      : method === "repair.publish"
        ? { ...clean, outcome: "published" }
        : {},
  );
  const close = vi.fn();
  render(
    <PublicationDialog
      publication={plan}
      close={close}
      refresh={async () => {}}
    />,
  );
  expect(screen.getByText("akshajrawat/oppia")).toBeTruthy();
  expect(screen.getByText("fix-translation-tests")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Confirm Push" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Commit Locally" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm Push",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(rpc.mock.calls.some(([method]) => method === "repair.publish")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm Push" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(rpc).toHaveBeenCalledWith("repair.publish", {
    id: session.id,
    publication_id: plan.id,
    confirmed: true,
  });
});

it("makes local-only approval and commit explicit without preparing or confirming a remote push", async () => {
  const rpc = install(() => ({}));
  const close = vi.fn();
  render(
    <LocalCommitDialog
      session={{
        ...session,
        identity: { ...session.identity, can_push: false },
      }}
      close={close}
      refresh={async () => {}}
    />,
  );
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm Local Commit" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(rpc.mock.calls.map(([method]) => method)).toEqual([
    "repair.approveLocal",
    "repair.commit",
    "repair.keepLocal",
  ]);
  expect(rpc).toHaveBeenCalledWith(
    "repair.commit",
    expect.objectContaining({
      expected_hash: session.review_hash,
      confirmed: true,
    }),
  );
});
