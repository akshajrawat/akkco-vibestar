import { GitHubClient } from "../github/client";
import { AdeError, now, parseIssue } from "../domain";
import { parsePullRequest, type PullRequestState, type DiscussionEntry } from "./contracts";
import { object } from "../execution/providers/contracts";

export class GitHubMonitor {
  constructor(
    cwd: string,
    private readonly client = new GitHubClient(cwd),
  ) {}

  private gh = (args: string[], signal: AbortSignal) => this.client.gh(args, signal);

  discover = async (repository: string, signal: AbortSignal) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new AdeError("invalid_input", "Use owner/repository");
    return JSON.parse(
      await this.gh(
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--author",
          "@me",
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,title,url,headRefName",
        ],
        signal,
      ),
    ) as { number: number; title: string; url: string; headRefName: string }[];
  };

  inspect = async (url: string, signal: AbortSignal): Promise<PullRequestState> => {
    const ref = parsePullRequest(url);

    const pr = object(
      JSON.parse(
        await this.gh(
          [
            "pr",
            "view",
            ref.url,
            "--json",
            "title,body,state,mergeable,reviewDecision,headRefOid,author,statusCheckRollup",
          ],
          signal,
        ),
      ),
    );

    const client = this.client;

    const pages = (endpoint: string) =>
      client.pages<Record<string, unknown>>(endpoint, signal, 100);

    const coverage = {
      complete: true,
      missing: [] as string[],
      warnings: [] as string[],
    };

    const optional = async <T>(name: string, get: () => Promise<T>, fallback: T) => {
      try {
        return await get();
      } catch (error) {
        signal.throwIfAborted();
        coverage.complete = false;
        coverage.missing.push(name);

        coverage.warnings.push(
          `${name} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );

        return fallback;
      }
    };

    const base = `repos/${ref.owner}/${ref.repo}`;

    const metadata = await optional(
      "PR identity",
      () => client.api<Record<string, unknown>>(`${base}/pulls/${ref.number}`, signal),
      {},
    );

    const linkedUrls = new Set<string>();
    for (const match of String(metadata.body || pr.body || "").matchAll(
      /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*/g,
    ))
      linkedUrls.add(match[0]);

    const [comments, reviews, inline, viewer] = await Promise.all([
      pages(`${base}/issues/${ref.number}/comments`),
      pages(`${base}/pulls/${ref.number}/reviews`),
      pages(`${base}/pulls/${ref.number}/comments`),
      client.api<{ login: string }>("user", signal),
    ]);

    const threads: NonNullable<PullRequestState["threads"]> = [];
    let cursor: string | null = null;
    let baseRefOid = "";
    let threadPages = 0;
    do {
      if (++threadPages > 100)
        throw new AdeError("github", "Review thread pagination exceeded its safety limit");
      const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){baseRefOid closingIssuesReferences(first:100){nodes{url} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line startLine comments(first:100){nodes{id body author{login} createdAt updatedAt url} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;

      const result = JSON.parse(
        await this.gh(
          [
            "api",
            "graphql",
            "-f",
            `query=${query}`,
            "-f",
            `owner=${ref.owner}`,
            "-f",
            `repo=${ref.repo}`,
            "-F",
            `number=${ref.number}`,
            ...(cursor ? ["-f", `cursor=${cursor}`] : []),
          ],
          signal,
        ),
      );

      if (result.errors)
        throw new AdeError("github", "Review thread inspection failed; snapshot was not advanced");
      baseRefOid = result.data.repository.pullRequest.baseRefOid;
      const linked = result.data.repository.pullRequest.closingIssuesReferences;
      for (const issue of linked?.nodes || []) linkedUrls.add(issue.url);
      if (linked?.pageInfo.hasNextPage && !coverage.missing.includes("linked issue references")) {
        coverage.complete = false;
        coverage.missing.push("linked issue references");

        coverage.warnings.push(
          "More than 100 linked issue references; additional linked context is incomplete.",
        );
      }

      const page = result.data.repository.pullRequest.reviewThreads;
      for (const t of page.nodes as {
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        line: number | null;
        startLine: number | null;
        path: string;
        comments: {
          nodes: {
            id: string;
            body: string;
            author?: { login: string } | null;
            createdAt?: string;
            updatedAt?: string;
            url?: string;
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      }[]) {
        const nodes = [...t.comments.nodes];
        let info = t.comments.pageInfo;
        let count = 0;
        while (info.hasNextPage) {
          if (!info.endCursor)
            throw new AdeError(
              "github",
              "Thread comment pagination did not advance; context is incomplete.",
            );
          if (++count > 100)
            throw new AdeError("github", "Thread history exceeds the inspection safety limit");

          const part = JSON.parse(
            await this.gh(
              [
                "api",
                "graphql",
                "-f",
                "query=query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id body author{login} createdAt updatedAt url} pageInfo{hasNextPage endCursor}}}}}",
                "-f",
                `id=${t.id}`,
                "-f",
                `cursor=${info.endCursor}`,
              ],
              signal,
            ),
          );

          if (part.errors)
            throw new AdeError(
              "github",
              "Thread history inspection failed; snapshot was not advanced",
            );
          const next = part.data.node.comments;
          if (next.pageInfo.hasNextPage && next.pageInfo.endCursor === info.endCursor)
            throw new AdeError(
              "github",
              "Thread comment pagination did not advance; context is incomplete.",
            );
          nodes.push(...next.nodes);
          info = next.pageInfo;
        }

        threads.push({
          id: t.id,
          resolved: t.isResolved,
          outdated: t.isOutdated,
          line: t.line,
          startLine: t.startLine,
          path: t.path,
          body: nodes.at(-1)?.body || "",
          commentIds: nodes.map((c) => c.id),
          comments: nodes,
        });
      }

      if (
        page.pageInfo.hasNextPage &&
        (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)
      )
        throw new AdeError(
          "github",
          "Review thread pagination did not advance; context is incomplete.",
        );
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    const commentIds = new Map(
      inline.map((comment) => [String(comment.id), String(comment.node_id || comment.id)]),
    );

    const reviewIds = new Map(
      reviews.map((review) => [String(review.id), String(review.node_id || review.id)]),
    );

    const entry = (c: Record<string, unknown>, type: DiscussionEntry["type"]): DiscussionEntry => {
      const id = String(c.node_id || c.id);
      const thread = threads.find((t) => t.commentIds?.includes(id));
      const user = object(c.user);
      const createdAt = String(c.created_at || c.submitted_at || "");
      return {
        id,
        type,
        author: String(user.login || "unknown"),
        body: String(c.body || ""),
        url: String(c.html_url || ""),
        authorId: String(user.node_id || user.id || ""),
        ...(c.in_reply_to_id
          ? {
              inReplyToId: commentIds.get(String(c.in_reply_to_id)) || String(c.in_reply_to_id),
            }
          : {}),
        ...(c.commit_id ? { commitId: String(c.commit_id) } : {}),
        ...(c.original_commit_id ? { originalCommitId: String(c.original_commit_id) } : {}),
        ...(typeof c.start_line === "number" ? { startLine: c.start_line } : {}),
        ...(typeof c.original_line === "number" ? { originalLine: c.original_line } : {}),
        ...(typeof c.original_start_line === "number"
          ? { originalStartLine: c.original_start_line }
          : {}),
        ...(c.side ? { side: String(c.side) } : {}),
        ...(c.diff_hunk ? { diffHunk: String(c.diff_hunk) } : {}),
        createdAt,
        updatedAt: String(c.updated_at || c.submitted_at || createdAt),
        authorAssociation: String(c.author_association || ""),
        bot: user.type === "Bot",
        ...(c.path ? { path: String(c.path) } : {}),
        ...(typeof c.line === "number" ? { line: c.line } : {}),
        ...(type === "review" ? { reviewState: String(c.state) } : {}),
        ...(c.pull_request_review_id || type === "review"
          ? {
              reviewId:
                reviewIds.get(String(c.pull_request_review_id || c.id)) ||
                String(c.pull_request_review_id || c.id),
            }
          : {}),
        ...(thread
          ? {
              threadId: thread.id,
              resolved: thread.resolved,
              outdated: thread.outdated,
            }
          : {}),
      };
    };

    const discussion = [
      ...new Map(
        [
          ...comments.map((c) => entry(c, "issue_comment")),
          ...inline.map((c) => entry(c, "review_comment")),
          ...reviews.map((r) => entry(r, "review")),
        ].map((entry) => [entry.id, entry]),
      ).values(),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

    for (const thread of threads) {
      for (const comment of thread.comments || []) {
        if (discussion.some((source) => source.id === comment.id)) continue;
        const raw = object(comment);

        discussion.push({
          id: comment.id,
          type: "review_comment",
          author: String(object(raw.author).login || "unknown"),
          body: comment.body,
          createdAt: String(raw.createdAt || ""),
          updatedAt: String(raw.updatedAt || raw.createdAt || ""),
          url: String(raw.url || ""),
          threadId: thread.id,
          resolved: thread.resolved,
          outdated: thread.outdated,
          path: thread.path,
        });

        coverage.complete = false;
        coverage.missing.push(`REST review metadata for ${comment.id}`);

        coverage.warnings.push(
          `Thread source ${comment.id} was absent from REST comments; its full body is retained, but reply/diff metadata is incomplete.`,
        );
      }
    }

    discussion.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const source of discussion) {
      if (
        !source.id ||
        source.id === "undefined" ||
        !source.createdAt ||
        source.author === "unknown"
      ) {
        coverage.complete = false;

        coverage.warnings.push(
          `Missing identity, timestamp or author for source ${source.id}; chronology or response state is uncertain.`,
        );

        coverage.missing.push(`source metadata: ${source.id}`);
      }
    }

    const head = object(metadata.head),
      baseInfo = object(metadata.base);

    const headSha = String(head.sha || pr.headRefOid);

    const [files, commits, checks, statuses] = await Promise.all([
      optional("changed-file patches", () => pages(`${base}/pulls/${ref.number}/files`), []),
      optional("commit history", () => pages(`${base}/pulls/${ref.number}/commits`), []),
      optional(
        "check runs",
        () =>
          client.pages<Record<string, unknown>>(
            `${base}/commits/${headSha}/check-runs`,
            signal,
            100,
            "check_runs",
          ),
        [],
      ),
      optional("commit statuses", () => pages(`${base}/commits/${headSha}/statuses`), []),
    ]);

    for (const [name, expected, actual] of [
      ["changed files", metadata.changed_files, files.length],
      ["commits", metadata.commits, commits.length],
    ]) {
      if (typeof expected === "number" && expected !== actual) {
        coverage.complete = false;
        coverage.missing.push(String(name));

        coverage.warnings.push(
          `${name}: GitHub reports ${expected}, retrieved ${actual}; API coverage is incomplete.`,
        );
      }
    }

    const missingPatches = files.filter((f) => typeof f.patch !== "string");
    if (missingPatches.length)
      coverage.warnings.push(
        `Patches unavailable for ${missingPatches.length} binary or omitted files; code evidence may be incomplete.`,
      );
    const linkedIssues: Record<string, unknown>[] = [];
    for (const url of [...linkedUrls].slice(0, 20)) {
      const issue = parseIssue(url);
      const endpoint = `repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;

      const context = await optional(
        `linked issue ${url}`,
        async () => ({
          ...(await client.api<Record<string, unknown>>(endpoint, signal)),
          comments: await pages(`${endpoint}/comments`),
        }),
        null as Record<string, unknown> | null,
      );

      if (context) linkedIssues.push(context);
    }

    if (linkedUrls.size > 20) {
      coverage.complete = false;
      coverage.missing.push("linked issue bodies");

      coverage.warnings.push(
        "Only 20 linked issue bodies retrieved; remaining references require another inspection.",
      );
    }

    const fresh = await optional(
      "final PR identity check",
      () => client.api<Record<string, unknown>>(`${base}/pulls/${ref.number}`, signal),
      metadata,
    );

    if (
      object(fresh.head).sha !== head.sha ||
      object(fresh.base).sha !== baseInfo.sha ||
      fresh.updated_at !== metadata.updated_at ||
      fresh.state !== metadata.state
    ) {
      coverage.complete = false;

      coverage.warnings.push(
        "PR changed during retrieval; refresh before relying on this analysis.",
      );

      coverage.missing.push("consistent PR snapshot");
    }

    const observedChecks = [
      ...checks.map((c) => ({
        contextKey: `check:${object(c.app).id || "unknown"}:${String(c.name || "CI")}`,
        id: String(c.id),
        name: String(c.name || "CI"),
        state: String(c.conclusion || c.status).toUpperCase(),
        url: String(c.html_url || c.details_url || ""),
        startedAt: String(c.started_at || ""),
        completedAt: String(c.completed_at || ""),
      })),
      ...statuses.map((c) => ({
        contextKey: `status:${String(c.context || "CI")}`,
        id: String(c.id),
        name: String(c.context || "CI"),
        state: String(c.state).toUpperCase(),
        url: String(c.target_url || ""),
        startedAt: String(c.created_at || ""),
        completedAt: String(c.updated_at || ""),
      })),
    ];

    const latestChecks = [
      ...new Map(
        observedChecks
          .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""))
          .map((c) => [c.contextKey, c]),
      ).values(),
    ];

    return {
      fetchedAt: now(),
      coverage,
      identity: {
        prId: String(metadata.node_id || metadata.id || ""),
        headRepository: object(head.repo).full_name ? String(object(head.repo).full_name) : null,
        headRepositoryId: object(head.repo).node_id ? String(object(head.repo).node_id) : null,
        headBranch: String(head.ref || ""),
        baseRepository: String(object(baseInfo.repo).full_name || `${ref.owner}/${ref.repo}`),
        baseRepositoryId: String(object(baseInfo.repo).node_id || ""),
        baseBranch: String(baseInfo.ref || ""),
      },
      files: files.map((f) => ({
        path: String(f.filename),
        previousPath: f.previous_filename ? String(f.previous_filename) : null,
        status: String(f.status),
        patch: typeof f.patch === "string" ? f.patch : null,
      })),
      commits: commits.map((c) => ({
        sha: String(c.sha),
        author: object(c.author).login ? String(object(c.author).login) : null,
        message: String(object(c.commit).message || ""),
        date: String(object(object(c.commit).author).date || ""),
        url: String(c.html_url || ""),
      })),
      linkedIssues,
      authenticatedUser: viewer.login,
      discussion,
      threads,
      author: String(object(pr.author).login || ""),
      baseRefOid: String(baseInfo.sha || baseRefOid),
      title: String(pr.title || ""),
      body: String(pr.body || ""),
      state: String(pr.state),
      mergeable: String(pr.mergeable),
      reviewDecision: String(pr.reviewDecision || ""),
      headRefOid: headSha,
      comments: [...comments, ...inline]
        .map((c) => ({
          id: String(c.node_id || c.id),
          body: String(c.body || ""),
          updated_at: String(c.updated_at || ""),
          author: String(object(c.user).login || ""),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      reviews: reviews
        .map((r) => ({
          id: String(r.node_id || r.id),
          body: String(r.body || ""),
          state: String(r.state),
          submitted_at: String(r.submitted_at || ""),
          author: String(object(r.user).login || ""),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      checks: latestChecks.length
        ? latestChecks
        : (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
            .map(object)
            .map((c) => ({
              name: String(c.name || c.context || "CI"),
              state: String(c.conclusion || c.state || c.status).toUpperCase(),
              url: String(c.detailsUrl || c.targetUrl || ""),
              completedAt: String(c.completedAt || ""),
              startedAt: String(c.startedAt || ""),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
  };
}
