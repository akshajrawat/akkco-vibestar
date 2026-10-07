import { GitHubClient } from "../github/client";
import { AdeError } from "../domain";
import {
  parsePullRequest,
  type PullRequestState,
  type DiscussionEntry,
} from "./contracts";
import { object } from "../execution/providers/contracts";
export class GitHubMonitor {
  constructor(private readonly cwd: string) {}
  private gh = (args: string[], signal: AbortSignal) =>
    new GitHubClient(this.cwd).gh(args, signal);
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
  inspect = async (
    url: string,
    signal: AbortSignal,
  ): Promise<PullRequestState> => {
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
    const pages = async (endpoint: string) => {
      const rows: Record<string, unknown>[] = [];
      for (let page = 1; page <= 100; page++) {
        const response: unknown = JSON.parse(
          await this.gh(
            ["api", "--method", "GET", `${endpoint}?per_page=100&page=${page}`],
            signal,
          ),
        );
        if (!Array.isArray(response))
          throw new AdeError("github", "Unexpected GitHub pagination response");
        rows.push(...response.map(object));
        if (response.length < 100) return rows;
      }
      throw new AdeError(
        "github",
        "PR discussion exceeds the inspection safety limit; snapshot was not advanced",
      );
    };
    const base = `repos/${ref.owner}/${ref.repo}`;
    const [comments, reviews, inline, viewer] = await Promise.all([
      pages(`${base}/issues/${ref.number}/comments`),
      pages(`${base}/pulls/${ref.number}/reviews`),
      pages(`${base}/pulls/${ref.number}/comments`),
      new GitHubClient(this.cwd).api<{ login: string }>("user", signal),
    ]);
    const threads: NonNullable<PullRequestState["threads"]> = [];
    let cursor: string | null = null;
    let baseRefOid = "";
    let threadPages = 0;
    do {
      if (++threadPages > 100)
        throw new AdeError(
          "github",
          "Review thread pagination exceeded its safety limit",
        );
      const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){baseRefOid reviewThreads(first:100,after:$cursor){nodes{id isResolved path comments(first:100){nodes{id body} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;
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
        throw new AdeError(
          "github",
          "Review thread inspection failed; snapshot was not advanced",
        );
      baseRefOid = result.data.repository.pullRequest.baseRefOid;
      const page = result.data.repository.pullRequest.reviewThreads;
      for (const t of page.nodes as {
        id: string;
        isResolved: boolean;
        path: string;
        comments: {
          nodes: { id: string; body: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      }[]) {
        const nodes = [...t.comments.nodes];
        let info = t.comments.pageInfo;
        let count = 0;
        while (info.hasNextPage) {
          if (++count > 100)
            throw new AdeError(
              "github",
              "Thread history exceeds the inspection safety limit",
            );
          const part = JSON.parse(
            await this.gh(
              [
                "api",
                "graphql",
                "-f",
                "query=query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id body} pageInfo{hasNextPage endCursor}}}}}",
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
          nodes.push(...part.data.node.comments.nodes);
          info = part.data.node.comments.pageInfo;
        }
        threads.push({
          id: t.id,
          resolved: t.isResolved,
          path: t.path,
          body: nodes.at(-1)?.body || "",
          commentIds: nodes.map((c) => c.id),
        });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    const entry = (
      c: Record<string, unknown>,
      type: DiscussionEntry["type"],
    ): DiscussionEntry => {
      const id = String(c.node_id || c.id);
      const thread = threads.find((t) => t.commentIds?.includes(id));
      const user = object(c.user);
      const createdAt = String(c.created_at || c.submitted_at || "");
      return {
        id,
        type,
        author: String(user.login || "unknown"),
        body: String(c.body || ""),
        createdAt,
        updatedAt: String(c.updated_at || c.submitted_at || createdAt),
        authorAssociation: String(c.author_association || ""),
        bot: user.type === "Bot",
        ...(c.path ? { path: String(c.path) } : {}),
        ...(typeof c.line === "number" ? { line: c.line } : {}),
        ...(type === "review" ? { reviewState: String(c.state) } : {}),
        ...(c.pull_request_review_id || type === "review"
          ? { reviewId: String(c.pull_request_review_id || c.id) }
          : {}),
        ...(thread ? { threadId: thread.id, resolved: thread.resolved } : {}),
      };
    };
    const discussion = [
      ...comments.map((c) => entry(c, "issue_comment")),
      ...inline.map((c) => entry(c, "review_comment")),
      ...reviews.map((r) => entry(r, "review")),
    ].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    return {
      authenticatedUser: viewer.login,
      discussion,
      threads,
      author: String(object(pr.author).login || ""),
      baseRefOid,
      title: String(pr.title || ""),
      body: String(pr.body || ""),
      state: String(pr.state),
      mergeable: String(pr.mergeable),
      reviewDecision: String(pr.reviewDecision || ""),
      headRefOid: String(pr.headRefOid),
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
      checks: (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
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
