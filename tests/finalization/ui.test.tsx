// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { GitFinalization } from "../../src/features/git-finalization/GitFinalization";
import { workspaceDetail } from "../workspace/fixtures";
import { FinalizationSchema, type Finalization } from "../../backend/finalization/contracts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ReviewFlow = (props: React.ComponentProps<typeof GitFinalization>) => {
  const [mode, setMode] = useState<"git" | "review">("review");
  return <GitFinalization {...props} mode={mode} onModeChange={setMode} />;
};

const fixture = () => {
  const task = {
    ...workspaceDetail(crypto.randomUUID()).task,
    status: "ready_for_review",
    issue: {
      title: "Original issue title",
      body: "Original issue instructions",
    },
  };

  const preset = {
    name: "Normal commit + no-verify push",
    commit_hooks: "normal" as const,
    push: "skip" as const,
    remote: "origin",
    branch: task.branch_name,
  };

  let record: Finalization | undefined;
  let fingerprint = "reviewed-source";

  const file = {
    path: "source.txt",
    old_path: null,
    status: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    insertions: 2,
    deletions: 1,
    binary: false,
    size: 60,
    excluded: null,
    committed: false,
    reviewed: true,
  };

  const destination = {
    remote: "origin",
    url: "https://github.com/contributor/fixture.git",
    repository: "contributor/fixture",
    repository_id: "42",
    upstream: "fixture/fixture",
    branch: task.branch_name,
    viewer: "contributor",
    expected_remote: "a".repeat(40),
  };

  const rpc = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "repository.configureDestination")
      return {
        id: task.repo_id,
        origin_url: "https://github.com/contributor/fixture.git",
        origin_remote: "origin",
      };
    if (method === "git.checkDestination") return structuredClone(destination);
    if (method === "git.inspect")
      return {
        files: [
          file,
          { ...file, path: "notes.log", reviewed: false, untracked: true },
          {
            ...file,
            path: ".env",
            reviewed: false,
            excluded: "Credential paths cannot be selected.",
          },
        ],
        ignored: ["ignored.txt"],
        fingerprint,
        preset,
        history: record ? [structuredClone(record)] : [],
        active: false,
      };
    if (method === "git.preview") {
      record = FinalizationSchema.parse({
        id: input.request_id,
        task_id: task.id,
        request_digest: "digest",
        status: "draft",
        source_hash: fingerprint,
        source_content_hash: "content",
        source_index: "index",
        projected_index: "projected",
        parent: "a".repeat(40),
        base: "b".repeat(40),
        paths: input.paths,
        staged_paths: [],
        preview_path: "/owned/preview",
        preview_branch: "vibestar-finalization/fixture",
        tree: "c".repeat(40),
        review: null,
        review_source: null,
        approved_at: null,
        message: null,
        preset: input.preset,
        head: null,
        committed_source_hash: null,
        destination: null,
        error: null,
        pid: null,
        process_identity: null,
        created_at: "2026-10-24T00:00:00Z",
        updated_at: "2026-10-24T00:00:00Z",
      });
    } else if (method === "git.review") {
      record = {
        ...record!,
        status: "reviewed",
        review: {
          approval: "approved",
          summary: "Selected patch is independently acceptable",
          findings: [],
          testsRun: ["fixture inspection"],
          testsNotRun: [],
        },
        review_source: "selection",
      };
    } else if (method === "git.approve")
      record = {
        ...record!,
        status: "approved",
        approved_at: "2026-10-24T01:00:00Z",
      };
    else if (method === "git.commit") {
      fingerprint = "committed-source";

      record = {
        ...record!,
        status: "committed",
        head: "d".repeat(40),
        message: input.message as string,
        committed_source_hash: fingerprint,
      };
    } else if (method === "git.prepare")
      record = {
        ...record!,
        status: "prepared",
        destination: structuredClone(destination),
      };
    else if (method === "git.publish") record = { ...record!, status: "published" };
    else if (method === "git.detail" || method === "git.output")
      return {
        record,
        events: [
          {
            id: 1,
            phase: "Fixture Git output",
            output: "exact redacted fixture output",
            exit_code: 0,
            timestamp: "2026-10-24T00:00:00Z",
          },
        ],
        diff: "diff --git a/source.txt b/source.txt\n+reviewed selected content",
        diff_truncated: false,
      };
    return structuredClone(record);
  });

  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });

  return { task, rpc, destination };
};

it("connects a managed push destination explicitly without starting a commit or push", async () => {
  const { task, rpc } = fixture();

  render(
    <GitFinalization
      task={task}
      repository={{
        id: task.repo_id,
        owner: "fixture",
        name: "fixture",
        path: "/managed/source",
        upstream_url: "https://github.com/fixture/fixture.git",
        origin_url: null,
        base_branch: "main",
        source: "managed",
        last_fetched: null,
        created_at: task.created_at,
      }}
      revision={0}
      close={vi.fn()}
      complete={vi.fn()}
    />,
  );

  await screen.findByText("source.txt");
  fireEvent.click(screen.getByText("Task options", { selector: "summary" }));
  fireEvent.click(screen.getByText("Connect a push repository", { selector: "summary" }));

  fireEvent.change(screen.getByRole("textbox", { name: "Push repository" }), {
    target: { value: "contributor/fixture" },
  });

  expect(rpc.mock.calls.every(([method]) => method === "git.inspect")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
  await screen.findByText("Destination connected. Check and confirm your next push separately.");

  expect(rpc).toHaveBeenCalledWith("repository.configureDestination", {
    id: task.repo_id,
    repository: "contributor/fixture",
    confirmed: true,
  });

  expect(
    rpc.mock.calls.some(([method]) =>
      ["git.commit", "git.prepare", "git.publish"].includes(method),
    ),
  ).toBe(false);
});

it("requires explicit subset review, exact-message confirmation and a separate destination confirmation", async () => {
  const { task, rpc } = fixture();

  render(
    <ReviewFlow
      task={task}
      repository={{
        id: task.repo_id,
        owner: "upstream",
        name: "fixture",
        path: "/imported/source",
        upstream_url: "https://github.com/upstream/fixture.git",
        origin_url: "https://github.com/contributor/fixture.git",
        base_branch: "main",
        last_fetched: null,
        created_at: task.created_at,
      }}
      revision={0}
      close={vi.fn()}
      complete={vi.fn()}
    />,
  );

  await screen.findByText("source.txt");
  expect(rpc.mock.calls.every(([method]) => method === "git.inspect")).toBe(true);

  expect((screen.getByRole("checkbox", { name: /source.txt/ }) as HTMLInputElement).checked).toBe(
    true,
  );

  expect((screen.getByRole("checkbox", { name: /notes.log/ }) as HTMLInputElement).checked).toBe(
    false,
  );

  expect((screen.getByRole("checkbox", { name: /\.env/ }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View diff & review" }));
  await screen.findByText(/This selection needs a fresh independent review/);
  expect(rpc.mock.calls.some(([method]) => method === "git.review")).toBe(false);

  expect(rpc.mock.calls.find(([method]) => method === "git.preview")?.[1].paths).toEqual([
    "source.txt",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Review selection with Antigravity" }));
  await screen.findByText("Selected patch is independently acceptable");
  fireEvent.click(screen.getByRole("button", { name: "Approve selected files" }));

  await waitFor(() =>
    expect(rpc.mock.calls.some(([method]) => method === "git.approve")).toBe(true),
  );

  fireEvent.click(screen.getByRole("button", { name: "Back to Git Changes" }));
  expect(screen.queryByRole("button", { name: "Review selection with Antigravity" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve selected files" })).toBeNull();
  const editor = screen.getByLabelText("Exact Git commit message") as HTMLTextAreaElement;
  expect(editor.value).toBe("");
  const message = "  My exact title  \n\n# Literal message text  ";
  fireEvent.change(editor, { target: { value: message } });
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  await screen.findByRole("region", { name: "Confirm Git operation" });

  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm commit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );

  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I confirm these files, exact message and local commit.",
    }),
  );

  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm commit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );

  fireEvent.click(screen.getByRole("button", { name: "Confirm commit" }));
  await screen.findByText("Local commit saved");
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await screen.findByRole("button", { name: "Confirm push" });

  expect(rpc.mock.calls.find(([method]) => method === "git.commit")?.[1]).toMatchObject({
    message,
    skip_hooks: false,
    confirmed: true,
  });

  expect((screen.getByRole("button", { name: "Confirm push" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  expect(rpc.mock.calls.some(([method]) => method === "git.publish")).toBe(false);

  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I confirm these files, exact message and destination.",
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Confirm push" }));
  await screen.findByText("Push verified against the remote branch.");

  expect(rpc.mock.calls.find(([method]) => method === "git.publish")?.[1]).toMatchObject({
    skip_hooks: true,
    confirmed: true,
  });
});

it("preserves file and message edits across snapshots, and exposes loading failures with a retry", async () => {
  const { task, rpc } = fixture();

  const ui = render(
    <GitFinalization task={task} revision={0} close={vi.fn()} complete={vi.fn()} />,
  );

  await screen.findByText("source.txt");
  fireEvent.click(screen.getByRole("checkbox", { name: /notes.log/ }));

  fireEvent.change(screen.getByRole("searchbox", { name: "Search changed files" }), {
    target: { value: "source" },
  });

  expect(screen.queryByRole("checkbox", { name: /notes.log/ })).toBeNull();

  fireEvent.change(screen.getByRole("searchbox", { name: "Search changed files" }), {
    target: { value: "" },
  });

  expect((screen.getByRole("checkbox", { name: /notes.log/ }) as HTMLInputElement).checked).toBe(
    true,
  );

  fireEvent.change(screen.getByLabelText("Exact Git commit message"), {
    target: { value: "Unsent exact draft" },
  });

  ui.rerender(
    <GitFinalization task={{ ...task }} revision={1} close={vi.fn()} complete={vi.fn()} />,
  );

  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));

  expect((screen.getByRole("checkbox", { name: /notes.log/ }) as HTMLInputElement).checked).toBe(
    true,
  );

  expect((screen.getByLabelText("Exact Git commit message") as HTMLTextAreaElement).value).toBe(
    "Unsent exact draft",
  );

  ui.unmount();
  rpc.mockRejectedValue(new Error("Update the execution helper before using Git Finalization."));
  render(<GitFinalization task={task} revision={0} close={vi.fn()} complete={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Retry loading files" })).toBeTruthy();
  expect(screen.queryByText("No changed files.")).toBeNull();
});

it.each([false, true])(
  "confirms Commit & Push once and preserves the local commit on destination drift (%s)",
  async (drift) => {
    const { task, rpc, destination } = fixture();
    render(<ReviewFlow task={task} revision={0} close={vi.fn()} complete={vi.fn()} />);
    await screen.findByText("source.txt");
    fireEvent.click(screen.getByRole("button", { name: "View diff & review" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Review selection with Antigravity" }),
    );

    await screen.findByText("Selected patch is independently acceptable");
    fireEvent.click(screen.getByRole("button", { name: "Back to Git Changes" }));

    fireEvent.change(screen.getByLabelText("Exact Git commit message"), {
      target: { value: "  exact combined message\n\nbody  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Commit & Push" }));
    await screen.findByRole("region", { name: "Confirm Git operation" });

    expect(
      rpc.mock.calls.some(([method]) => method === "git.commit" || method === "git.publish"),
    ).toBe(false);

    expect(screen.getByText("contributor/fixture")).toBeTruthy();

    expect(
      within(screen.getByRole("region", { name: "Confirm Git operation" })).getByText(
        task.branch_name,
      ),
    ).toBeTruthy();

    expect(
      (screen.getByRole("button", { name: "Confirm Commit & Push" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    if (drift) destination.expected_remote = "f".repeat(40);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I confirm these files, exact message and destination.",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Commit & Push" }));
    if (drift) {
      await screen.findByText(/destination changed after confirmation/);
      expect(rpc.mock.calls.some(([method]) => method === "git.publish")).toBe(false);
      await screen.findByText("Local commit saved");
    } else {
      await screen.findByText("Push verified against the remote branch.");

      const writes = rpc.mock.calls.filter(([method]) =>
        ["git.approve", "git.commit", "git.prepare", "git.publish"].includes(method),
      );

      expect(writes.map(([method]) => method)).toEqual([
        "git.approve",
        "git.commit",
        "git.prepare",
        "git.publish",
      ]);

      expect(writes[1][1]).toMatchObject({
        message: "  exact combined message\n\nbody  ",
        skip_hooks: false,
        confirmed: true,
      });

      expect(writes[3][1]).toMatchObject({ skip_hooks: true, confirmed: true });
    }
  },
);

it("keeps Git Changes focused on files, commit and push, and refuses unreviewed selections", async () => {
  const { task, rpc } = fixture();
  render(<GitFinalization task={task} revision={0} close={vi.fn()} complete={vi.fn()} />);
  await screen.findByText("source.txt");
  expect(screen.queryByRole("button", { name: "View diff & review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Mark task complete" })).toBeNull();

  fireEvent.change(screen.getByLabelText("Exact Git commit message"), {
    target: { value: "Pending review" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  await screen.findByText(/This selection needs a fresh review/);

  expect(
    rpc.mock.calls.some(([method]) =>
      ["git.review", "git.approve", "git.commit", "git.publish"].includes(method),
    ),
  ).toBe(false);
});
