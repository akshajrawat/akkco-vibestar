import { z } from "zod";
import { now } from "../domain";
import type { Engine } from "../execution/engine";
import type { Scheduler } from "../scheduled/scheduler";
import { parsePullRequest } from "../scheduled/contracts";
import { GitHubClient } from "./client";
import type {
  GitHubRepository,
  GitHubPullRequest,
  GitHubStatus,
} from "./contracts";
const watchSchema = z.object({
  auto_watch: z.boolean(),
  interval_minutes: z.number().int().min(5).max(10080),
  verify_codex: z.boolean(),
});
export class GitHubService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private running: Promise<unknown> | undefined;
  private status: GitHubStatus | null = null;
  private lastSync: string | null = null;
  private error: string | null = null;
  readonly client: GitHubClient;
  constructor(
    private readonly engine: Engine,
    private readonly scheduler: Scheduler,
  ) {
    this.client = new GitHubClient(engine.root);
  }
  catalog = () =>
    this.engine.db
      .all<{ data: string }>(
        "SELECT data FROM github_repositories ORDER BY full_name",
      )
      .map((r) => JSON.parse(r.data) as GitHubRepository);
  prs = () =>
    this.engine.db
      .all<{ data: string }>(
        "SELECT data FROM github_pull_requests ORDER BY updated_at DESC",
      )
      .map((r) => JSON.parse(r.data) as GitHubPullRequest);
  settings = () => {
    const row = this.engine.db.all<{ value: string }>(
      "SELECT value FROM settings WHERE key='github_watch'",
    )[0];
    return row
      ? watchSchema.parse(JSON.parse(row.value))
      : { auto_watch: true, interval_minutes: 60, verify_codex: false };
  };
  configure = (input: unknown) => {
    const value = watchSchema.parse(input);
    this.engine.db.run(
      "INSERT INTO settings VALUES('github_watch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(value),
    );
    this.engine.changed();
    return value;
  };
  snapshot = () => ({
    status: this.status,
    last_sync: this.lastSync,
    error: this.error,
    settings: this.settings(),
    repositories: this.catalog(),
    pull_requests: this.prs(),
  });
  resolve = async (name: string) => {
    const repository = await this.client.repository(
      name,
      this.controller.signal,
    );
    let fork: GitHubRepository | undefined;
    const status =
      this.status || (await this.client.detect(this.controller.signal));
    if (status.connected) {
      const candidates = this.catalog().filter(
        (r) =>
          r.fork &&
          r.owner.login === status.username &&
          r.name === repository.name,
      );
      for (const candidate of candidates) {
        const info = await this.client.repository(
          candidate.full_name,
          this.controller.signal,
        );
        if (
          info.parent?.full_name.toLowerCase() ===
          repository.full_name.toLowerCase()
        ) {
          fork = info;
          break;
        }
      }
      // A direct lookup handles a new fork not present in the last catalog sync.
      if (!fork && repository.owner.login !== status.username) {
        try {
          const info = await this.client.repository(
            `${status.username}/${repository.name}`,
            this.controller.signal,
          );
          if (
            info.fork &&
            info.parent?.full_name.toLowerCase() ===
              repository.full_name.toLowerCase()
          )
            fork = info;
        } catch {
          /* A fork is optional; absence never guesses a relationship. */
        }
      }
    }
    return {
      repository,
      upstream_url: repository.clone_url,
      origin_url: fork?.clone_url || null,
      base_branch: repository.default_branch,
    };
  };
  useLocally = async (name: string, deferred = false) => {
    let metadata = await this.client.repository(name, this.controller.signal);
    if (metadata.fork && metadata.parent)
      metadata = await this.client.repository(
        metadata.parent.full_name,
        this.controller.signal,
      );
    const existing = this.engine.db
      .repositories()
      .find(
        (r) =>
          `${r.owner}/${r.name}`.toLowerCase() ===
          metadata.full_name.toLowerCase(),
      );
    if (existing) {
      if (!deferred) await this.engine.prepareClone(existing);
      return existing;
    }
    const resolved = await this.resolve(metadata.full_name);
    return this.engine.register(
      resolved.upstream_url,
      resolved.origin_url,
      resolved.base_branch,
      deferred,
    );
  };
  sync = () => {
    if (this.running) return this.running;
    this.running = this.performSync().finally(() => {
      this.running = undefined;
    });
    return this.running;
  };
  private performSync = async () => {
    try {
      this.status = await this.client.detect(this.controller.signal);
      this.engine.changed();
      if (!this.status.connected || !this.status.username)
        return this.snapshot();
      const repos = await this.client.pages<GitHubRepository>(
        "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed",
        this.controller.signal,
      );
      const catalogTime = now();
      for (const repo of repos)
        this.engine.db.run(
          "INSERT INTO github_repositories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,data=excluded.data,synced_at=excluded.synced_at",
          repo.id,
          repo.full_name,
          JSON.stringify(repo),
          catalogTime,
        );
      this.engine.db.run(
        "DELETE FROM github_repositories WHERE synced_at<>?",
        catalogTime,
      );
      const found = await this.client.authored(
        this.status.username,
        this.controller.signal,
      );
      const urls = new Set(found.map((p) => p.html_url));
      for (const pr of found) {
        const ref = parsePullRequest(pr.html_url);
        const info = await this.client.api<{
          head: { ref: string; repo: { full_name: string } | null };
          state: string;
          merged: boolean;
        }>(
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
          this.controller.signal,
        );
        const repository = `${ref.owner}/${ref.repo}`;
        // Both upstream identity and fork + head branch must agree, uniquely.
        const matches = this.engine.db.tasks().filter((t) => {
          const repo = this.engine.db.repository(t.repo_id);
          return (
            `${repo.owner}/${repo.name}`.toLowerCase() ===
              repository.toLowerCase() &&
            t.branch_name === info.head.ref &&
            (repo.origin_url || repo.upstream_url)
              .replace(/^git@github.com:/, "https://github.com/")
              .replace(/\.git$/, "")
              .toLowerCase() ===
              `https://github.com/${info.head.repo?.full_name}`.toLowerCase()
          );
        });
        const saved = this.prs().find((p) => p.url === pr.html_url);
        const value: GitHubPullRequest = {
          url: pr.html_url,
          repository,
          number: pr.number,
          title: pr.title,
          state: "OPEN",
          head_branch: info.head.ref,
          head_repository: info.head.repo?.full_name || null,
          updated_at: pr.updated_at,
          task_id:
            saved?.task_id || (matches.length === 1 ? matches[0].id : null),
        };
        this.savePR(value);
        this.scheduler.discovered(value, this.settings());
      }
      // Missing search results are not proof of closure. Confirm each known PR.
      for (const old of this.prs().filter(
        (p) => p.state === "OPEN" && !urls.has(p.url),
      )) {
        const ref = parsePullRequest(old.url);
        const info = await this.client.api<{ state: string; merged: boolean }>(
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
          this.controller.signal,
        );
        if (info.state === "closed") {
          const value = {
            ...old,
            state: info.merged ? "MERGED" : "CLOSED",
            updated_at: now(),
          };
          this.savePR(value);
          this.scheduler.discovered(value, this.settings());
        }
      }
      this.lastSync = now();
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    this.engine.changed();
    return this.snapshot();
  };
  private savePR = (pr: GitHubPullRequest) =>
    this.engine.db.run(
      "INSERT INTO github_pull_requests VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      pr.url,
      JSON.stringify(pr),
      pr.updated_at,
    );
  start = () => {
    const poll = async () => {
      await this.sync();
      if (!this.controller.signal.aborted) {
        this.timer = setTimeout(() => void poll(), 5 * 60000);
        this.timer.unref();
      }
    };
    void poll();
  };
  close = async () => {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  };
}
