import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Database } from "../../backend/storage/database";
import { RepositoryIndex } from "../../backend/workspace/discovery";
import type { Engine } from "../../backend/execution/engine";
import { Rpc } from "../../backend/rpc";
import { RepositoryPage } from "../../src/components/RepositoryPage";
import { TaskNavigation } from "../../src/components/TaskNavigation";
import { ScheduledPage } from "../../src/components/ScheduledPage";
import type { Snapshot } from "../../src/lib/types";

it("isolates schema-invalid catalog, index, task and PR records before rendering shared history views", async () => {
  const db = new Database(":memory:");
  const engine = {
    db,
    root: "/tmp",
    repositoryIndex: new RepositoryIndex("/tmp", db),
    isActive: () => false,
  } as unknown as Engine;
  const rpc = new Rpc(engine);
  try {
    const repo = {
      id: "repo",
      owner: "fixture",
      name: "project",
      path: "/fixture/repo",
    };
    db.run(
      "INSERT INTO repositories VALUES('repo','fixture','project',?)",
      JSON.stringify(repo),
    );
    const healthy = {
      id: "healthy",
      repo_id: "repo",
      status: "completed",
      stage: 6,
      issue: { title: "Healthy saved task" },
    };
    db.run(
      "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('healthy','repo','completed',6,?,'fixture')",
      JSON.stringify(healthy),
    );
    const badTask = JSON.stringify({
      ...healthy,
      id: "bad",
      issue: { title: { bad: true } },
    });
    db.run(
      "INSERT INTO tasks(id,repo_id,status,stage,data,created_at) VALUES('bad','repo','completed',6,?,'fixture')",
      badTask,
    );
    db.run(
      "INSERT INTO local_repositories VALUES('/fixture/bad','{}','fixture')",
    );
    db.run(
      "INSERT INTO settings VALUES('repository_index',?)",
      JSON.stringify({ repositories: true }),
    );
    db.run(
      "INSERT INTO github_repositories VALUES(1,'fixture/bad',?,'fixture')",
      JSON.stringify({
        id: 1,
        full_name: { bad: true },
        owner: { login: "fixture", type: "User" },
        name: "bad",
        description: null,
        default_branch: "main",
        private: false,
        fork: false,
        clone_url: "https://github.com/fixture/bad.git",
        updated_at: "fixture",
      }),
    );
    const job = {
      id: "healthy-job",
      url: "https://github.com/fixture/project/pull/1",
      task_id: null,
      title: "Healthy saved PR",
      status: "idle",
      enabled: false,
      verify_codex: false,
      interval_minutes: 60,
      next_run_at: "fixture",
      last_checked_at: null,
      last_snapshot: null,
      pending_snapshot: null,
      changes: [],
      error: null,
    };
    db.run(
      "INSERT INTO scheduled_jobs VALUES(?,?)",
      job.id,
      JSON.stringify(job),
    );
    db.run(
      "INSERT INTO scheduled_jobs VALUES('bad-job',?)",
      JSON.stringify({ ...job, id: "bad-job", pending_snapshot: {} }),
    );
    db.run(
      "INSERT INTO pr_analyses VALUES('bad-analysis',?,'completed','fixture',NULL,?)",
      job.id,
      JSON.stringify({
        id: "bad-analysis",
        job_id: job.id,
        status: "completed",
        snapshot: {},
      }),
    );
    const snapshot = (await rpc.call("snapshot", {})) as Snapshot;
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["healthy"]);
    expect(snapshot.scheduled?.map((record) => record.id)).toEqual([job.id]);
    expect(snapshot.repository_index?.repositories).toEqual([]);
    expect(snapshot.github?.repositories).toEqual([]);
    const pages = [
      renderToStaticMarkup(
        <RepositoryPage snapshot={snapshot} refresh={async () => {}} />,
      ),
      renderToStaticMarkup(
        <TaskNavigation
          repositories={snapshot.repositories}
          tasks={snapshot.tasks}
          selected={null}
          open={() => {}}
        />,
      ),
      renderToStaticMarkup(
        <ScheduledPage
          snapshot={snapshot}
          refresh={async () => {}}
          open={() => {}}
        />,
      ),
    ];
    expect(pages[0]).toContain("fixture");
    expect(pages[1]).toContain("Healthy saved task");
    expect(pages[2]).toContain("Healthy saved PR");
    expect(
      new Set(db.records.diagnostics().map((record) => record.table_name)),
    ).toEqual(
      new Set([
        "tasks",
        "local_repositories",
        "settings",
        "github_repositories",
        "scheduled_jobs",
        "pr_analyses",
      ]),
    );
    expect(db.all("SELECT data FROM tasks WHERE id='bad'")).toEqual([
      { data: badTask },
    ]);
  } finally {
    await rpc.close();
    db.close();
  }
});
