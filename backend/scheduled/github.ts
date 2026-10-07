import { GitHubClient } from "../github/client";
import { AdeError } from "../domain";
import { parsePullRequest, type PullRequestState } from "./contracts";
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
    const [comments, reviews, inline] = await Promise.all([
      pages(`${base}/issues/${ref.number}/comments`),
      pages(`${base}/pulls/${ref.number}/reviews`),
      pages(`${base}/pulls/${ref.number}/comments`),
    ]);
    const threads: NonNullable<PullRequestState["threads"]> = [];
    let cursor: string | null = null;
    let baseRefOid = "";
    do {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){baseRefOid reviewThreads(first:100,after:$cursor){nodes{id isResolved path comments(last:1){nodes{body}}} pageInfo{hasNextPage endCursor}}}}}`;
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
      threads.push(
        ...page.nodes.map(
          (t: {
            id: string;
            isResolved: boolean;
            path: string;
            comments: { nodes: { body: string }[] };
          }) => ({
            id: t.id,
            resolved: t.isResolved,
            path: t.path,
            body: t.comments.nodes[0]?.body || "",
          }),
        ),
      );
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return {
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
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      checks: (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
        .map(object)
        .map((c) => ({
          name: String(c.name || c.context || "CI"),
          state: String(c.conclusion || c.state || c.status).toUpperCase(),
          url: String(c.detailsUrl || c.targetUrl || ""),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  };
}
