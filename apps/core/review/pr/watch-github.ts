import { z } from "zod";

import { AdeError } from "../../domain";
import type { GitHubClient } from "../../github/client";
import { parsePullRequest } from "../../scheduled/contracts";

const author = z.object({ login: z.string() }).nullable();

const comment = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  author,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    nodes: z.array(node),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  });

const responseSchema = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z
      .object({
        pullRequest: z
          .object({
            url: z.string(),
            title: z.string(),
            body: z.string(),
            state: z.enum(["OPEN", "CLOSED", "MERGED"]),
            updatedAt: z.string(),
            headRefOid: z.string(),
            reviewDecision: z.string().nullable(),
            reviewRequests: z.object({ totalCount: z.number().int().nonnegative() }),
            comments: connection(comment),
            reviews: connection(comment.extend({ state: z.string() })),
            reviewThreads: connection(
              z.object({
                id: z.string(),
                isResolved: z.boolean(),
                isOutdated: z.boolean(),
                comments: connection(
                  comment.extend({ replyTo: z.object({ id: z.string() }).nullable().optional() }),
                ),
              }),
            ),
            closingIssuesReferences: connection(
              z.object({
                url: z.string(),
                title: z.string(),
                body: z.string(),
                state: z.string(),
              }),
            ),
          })
          .nullable(),
      })
      .nullable(),
  }),
  errors: z.array(z.unknown()).optional(),
});

/** Quick watch reads discussion and linked issue bodies, never diffs, commits or CI history. */
export class PRWatchReader {
  constructor(private readonly client: GitHubClient) {}

  read = async (url: string, signal: AbortSignal) => {
    const ref = parsePullRequest(url);

    const result = responseSchema.parse(
      await this.client.graphql(
        `query {
      viewer { login }
      repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) {
        pullRequest(number: ${ref.number}) {
          url title body state updatedAt headRefOid reviewDecision
          reviewRequests(first: 1) { totalCount }
          comments(first: 100) { nodes { id body url createdAt updatedAt author { login } } pageInfo { hasNextPage } }
          reviews(first: 100) { nodes { id body url createdAt updatedAt state author { login } } pageInfo { hasNextPage } }
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated comments(first: 100) { nodes { id body url createdAt updatedAt replyTo { id } author { login } } pageInfo { hasNextPage } } }
            pageInfo { hasNextPage }
          }
          closingIssuesReferences(first: 20) { nodes { url title body state } pageInfo { hasNextPage } }
        }
      }
    }`,
        {},
        signal,
      ),
    );

    if (result.errors?.length || !result.data.repository?.pullRequest)
      throw new AdeError("github", "PR discussion is unavailable; review it on GitHub.");
    const pr = result.data.repository.pullRequest;
    if (parsePullRequest(pr.url).url.toLowerCase() !== ref.url.toLowerCase())
      throw new AdeError("github", "PR identity changed during the quick check.");

    const sources = [
      ...pr.comments.nodes.map((entry) => ({ ...entry, kind: "comment" })),
      ...pr.reviews.nodes.map((entry) => ({ ...entry, kind: "review" })),
      ...pr.reviewThreads.nodes.flatMap((thread) =>
        thread.comments.nodes.map((entry) => ({
          ...entry,
          kind: "inline",
          thread_id: thread.id,
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
        })),
      ),
    ].map(({ author: account, ...entry }) => ({
      ...entry,
      author: account?.login || "deleted-user",
    }));

    const complete = ![
      pr.comments,
      pr.reviews,
      pr.reviewThreads,
      pr.closingIssuesReferences,
      ...pr.reviewThreads.nodes.map((thread) => thread.comments),
    ].some((part) => part.pageInfo.hasNextPage);

    return {
      url: ref.url,
      title: pr.title,
      body: pr.body,
      lifecycle: pr.state,
      updated_at: pr.updatedAt,
      head: pr.headRefOid,
      viewer: result.data.viewer.login,
      review_decision: pr.reviewDecision,
      requested_reviewers: pr.reviewRequests.totalCount,
      issues: pr.closingIssuesReferences.nodes,
      sources,
      complete,
    };
  };
}

export type PRWatchContext = Awaited<ReturnType<PRWatchReader["read"]>>;
