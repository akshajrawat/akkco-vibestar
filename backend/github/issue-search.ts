import { z } from "zod";
import { AdeError, now, parseIssue } from "../domain";
import type { GitHubClient } from "./client";
import {
  IssueSnapshotSchema,
  RepositoryIdentitySchema,
  type IssueSnapshot,
  type RepositoryIdentity,
  type WatchLimits,
} from "../issue-watch/contracts";
import { digest, repositoryName } from "../issue-watch/rules";

export class CollectionLimit extends AdeError {
  constructor(message: string) {
    super("coverage_limit", message);
  }
}
export class GitHubReadPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  run = async <T>(operation: () => Promise<T>, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (this.active >= 4)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = () => {
          this.waiting = this.waiting.filter((item) => item !== ready);
          reject(signal.reason);
        };
        this.waiting.push(ready);
        signal.addEventListener("abort", aborted, { once: true });
      });
    else this.active++;
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  };
}
const rawRepository = z.object({
  node_id: z.string().min(1),
  full_name: z.string(),
  html_url: z.string(),
});
const rawIssue = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive().safe(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(z.object({ login: z.string() })),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int().nonnegative(),
  pull_request: z.unknown().optional(),
});

export class IssueSearch {
  requests = 0;
  bytes = 0;
  constructor(
    private readonly client: GitHubClient,
    readonly signal: AbortSignal,
    readonly limits: WatchLimits,
    private readonly pool: GitHubReadPool,
  ) {}
  read = async (endpoint: string): Promise<unknown> => {
    this.signal.throwIfAborted();
    if (
      !/^(?:repos\/[\w.-]+\/[\w.-]+(?:\/|\?|$)|search\/issues\?)/.test(
        endpoint,
      ) ||
      endpoint.includes("..") ||
      endpoint.includes("#")
    )
      throw new AdeError(
        "invalid_input",
        "Issue Watch only reads bounded GitHub repository endpoints.",
      );
    if (this.requests >= this.limits.max_requests)
      throw new CollectionLimit("GitHub request budget exhausted.");
    this.requests++;
    const value = await this.pool.run(
      () => this.client.api<unknown>(endpoint, this.signal),
      this.signal,
    );
    this.signal.throwIfAborted();
    this.bytes += Buffer.byteLength(JSON.stringify(value));
    if (this.bytes > 20 * 1024 * 1024)
      throw new CollectionLimit("Collected GitHub data exceeded 20 MiB.");
    return value;
  };
  repository = async (name: string, expectedId?: string) => {
    const value = rawRepository.parse(
      await this.read(`repos/${repositoryName(name)}`),
    );
    const fullName = repositoryName(value.html_url);
    if (
      fullName !== repositoryName(value.full_name) ||
      (expectedId && expectedId !== value.node_id)
    )
      throw new AdeError(
        "github_identity",
        "Repository identity changed. Correct the saved repository explicitly before scanning.",
      );
    return RepositoryIdentitySchema.parse({
      id: value.node_id,
      full_name: fullName,
      url: `https://github.com/${fullName}`,
    });
  };
  issue = async (repository: RepositoryIdentity, number: number) => {
    const value = rawIssue.parse(
      await this.read(`repos/${repository.full_name}/issues/${number}`),
    );
    const ref = value.pull_request ? null : parseIssue(value.html_url);
    if (
      value.number !== number ||
      (ref &&
        (`${ref.owner}/${ref.repo}`.toLowerCase() !== repository.full_name ||
          ref.number !== number))
    )
      throw new AdeError(
        "github_identity",
        "Issue response does not match the requested repository and number.",
      );
    if (Buffer.byteLength(value.body || "") > 1048576)
      throw new CollectionLimit("Issue body exceeded the 1 MiB source limit.");
    return IssueSnapshotSchema.parse({
      id: value.node_id,
      repository_id: repository.id,
      repository: repository.full_name,
      number,
      url: `https://github.com/${repository.full_name}/issues/${number}`,
      title: value.title,
      body: value.body || "",
      state: value.state,
      pull_request: Boolean(value.pull_request),
      labels: value.labels.map((label) =>
        typeof label === "string" ? label : label.name,
      ),
      assignees: value.assignees.map((actor) => actor.login),
      created_at: value.created_at,
      updated_at: value.updated_at,
      comment_count: value.comments,
    });
  };
  pages = async (endpoint: string, maxRows = 2000) => {
    const rows: unknown[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 21; page++) {
      const value = await this.read(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(value))
        throw new AdeError(
          "github",
          "Unexpected Issue Watch pagination response.",
        );
      if (value.length > 100)
        throw new AdeError("github", "Oversized GitHub page.");
      const hash = digest(value);
      if (value.length && seen.has(hash))
        throw new CollectionLimit("GitHub pagination did not advance.");
      seen.add(hash);
      rows.push(...value);
      if (rows.length > maxRows)
        throw new CollectionLimit(
          "Discussion or tracker exceeded its declared entry limit.",
        );
      if (value.length < 100) return rows;
    }
    throw new CollectionLimit("GitHub discussion pagination limit reached.");
  };
  discover = async (repository: RepositoryIdentity, query: string) => {
    const identities: { id: string; number: number }[] = [];
    const seen = new Map<string, number>();
    const pages = new Set<string>();
    let total = 0;
    let complete = true;
    const warnings: string[] = [];
    for (
      let page = 1;
      page <= Math.ceil(this.limits.max_candidates / 100);
      page++
    ) {
      const value = z
        .object({
          total_count: z.number().int().nonnegative(),
          incomplete_results: z.boolean(),
          items: z
            .array(
              z.object({
                node_id: z.string().min(1),
                number: z.number().int().positive().safe(),
                html_url: z.string(),
                pull_request: z.unknown().optional(),
              }),
            )
            .max(100),
        })
        .parse(
          await this.read(
            `search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100&page=${page}`,
          ),
        );
      if (page > 1 && total !== value.total_count) {
        complete = false;
        warnings.push("Search total changed during collection.");
      }
      total = value.total_count;
      if (value.incomplete_results) {
        complete = false;
        warnings.push("GitHub reported incomplete search results.");
      }
      if (total > this.limits.max_candidates || total > 1000) {
        complete = false;
        warnings.push(
          `Search has ${total} results; at most ${this.limits.max_candidates} identities are checked.`,
        );
      }
      const hash = digest(value.items);
      if (value.items.length && pages.has(hash)) {
        complete = false;
        warnings.push("Search pages repeated.");
        break;
      }
      pages.add(hash);
      for (const item of value.items) {
        if (item.pull_request) {
          complete = false;
          warnings.push("Search returned a PR-shaped result; it was excluded.");
          continue;
        }
        const ref = parseIssue(item.html_url);
        if (
          `${ref.owner}/${ref.repo}`.toLowerCase() !== repository.full_name ||
          ref.number !== item.number
        )
          throw new AdeError(
            "github_identity",
            "Search result belongs to a different repository.",
          );
        if (seen.has(item.node_id)) {
          complete = false;
          warnings.push("Search identities overlapped between pages.");
          continue;
        }
        seen.set(item.node_id, item.number);
        if (identities.length < this.limits.max_candidates)
          identities.push({ id: item.node_id, number: item.number });
      }
      if (value.items.length < 100 || page * 100 >= total) break;
    }
    if (seen.size < Math.min(total, this.limits.max_candidates)) {
      complete = false;
      warnings.push("Search coverage did not reach the declared result count.");
    }
    return { identities, total, complete, warnings, fetched_at: now() };
  };
}
export const issueQuery = (
  repository: RepositoryIdentity,
  rules: import("../issue-watch/contracts").WatchRules,
) =>
  [
    `repo:${repository.full_name}`,
    "is:issue",
    "is:open",
    ...(rules.unassigned_only ? ["no:assignee"] : []),
    ...rules.excluded_labels.map((label) => `-label:${JSON.stringify(label)}`),
  ].join(" ");
export const verifyIssueIdentity = (
  actual: IssueSnapshot,
  expected: { id: string; number: number },
) => {
  if (actual.id !== expected.id || actual.number !== expected.number)
    throw new AdeError(
      "github_identity",
      "Issue identity changed; this result needs manual correction.",
    );
};
