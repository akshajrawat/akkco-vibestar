import { z } from "zod";
import { AdeError } from "../domain";
import type { IssueSearch } from "./issue-search";
import type {
  ClaimEvidence,
  IssueSnapshot,
  RepositoryIdentity,
  WatchSource,
} from "../issue-watch/contracts";
import {
  retainedSource,
  markdownIssueReferences,
} from "../issue-watch/tracker-exclusions";

const githubUrl = (input: string) => {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new AdeError(
      "github_identity",
      "GitHub evidence returned an unsafe source URL.",
    );
  return url;
};
export const contributionPolicy = async (
  reader: IssueSearch,
  repository: RepositoryIdentity,
  save: (source: WatchSource) => void,
) => {
  const warnings: string[] = [];
  try {
    const profile = z
      .object({
        files: z.object({
          contributing: z.object({ url: z.string() }).nullable().optional(),
        }),
      })
      .parse(
        await reader.read(`repos/${repository.full_name}/community/profile`),
      );
    if (!profile.files.contributing)
      return {
        complete: false,
        warnings: [
          "Contribution policy is unavailable; assignment permission is unknown.",
        ],
        source_keys: [],
      };
    const url = new URL(profile.files.contributing.url);
    const prefix = `/repos/${repository.full_name}/contents/`;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.github.com" ||
      url.username ||
      url.password ||
      url.port ||
      !url.pathname.toLowerCase().startsWith(prefix) ||
      url.hash
    )
      return {
        complete: false,
        warnings: [
          "External contribution policy was not fetched; inspect it manually.",
        ],
        source_keys: [],
      };
    const file = z
      .object({
        type: z.literal("file"),
        sha: z.string().min(1),
        html_url: z.string(),
        content: z.string(),
        encoding: z.literal("base64"),
        size: z.number().int().nonnegative(),
      })
      .parse(await reader.read(`${url.pathname.slice(1)}${url.search}`));
    githubUrl(file.html_url);
    if (file.size > 1048576)
      throw new Error("Contribution policy exceeds the source size limit.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(file.content, "base64"),
    );
    const source = retainedSource({
      key: `policy:${repository.id}:${file.sha}`,
      kind: "policy",
      url: file.html_url,
      issue_id: null,
      repository_id: repository.id,
      revision: file.sha,
      complete: true,
      text,
      actor: null,
      association: null,
      created_at: null,
      updated_at: null,
      references: [],
    });
    save(source);
    return { complete: true, warnings, source_keys: [source.key] };
  } catch (error) {
    reader.signal.throwIfAborted();
    warnings.push(
      `Contribution policy coverage is unknown: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { complete: false, warnings, source_keys: [] };
  }
};

export const issueContext = async (
  reader: IssueSearch,
  issue: IssueSnapshot,
  save: (source: WatchSource) => void,
) => {
  const sources: WatchSource[] = [];
  const evidence: ClaimEvidence[] = [];
  const warnings: string[] = [];
  const retain = (source: WatchSource) => {
    sources.push(source);
    save(source);
  };
  retain(
    retainedSource({
      key: `issue:${issue.id}`,
      kind: "issue",
      url: issue.url,
      issue_id: issue.id,
      repository_id: issue.repository_id,
      revision: issue.updated_at,
      complete: true,
      text: issue.body,
      actor: null,
      association: null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      references: [],
    }),
  );
  const base = `repos/${issue.repository}/issues/${issue.number}`;
  try {
    const comments = await reader.pages(`${base}/comments`, 1000);
    if (comments.length !== issue.comment_count)
      warnings.push("Issue comment count changed during collection.");
    for (const value of comments) {
      const comment = z
        .object({
          node_id: z.string(),
          body: z.string(),
          html_url: z.string(),
          created_at: z.string(),
          updated_at: z.string(),
          user: z.object({ login: z.string() }).nullable(),
          author_association: z.string().optional(),
        })
        .parse(value);
      const url = githubUrl(comment.html_url);
      if (url.pathname.toLowerCase() !== `/` + base.replace(/^repos\//, ""))
        throw new AdeError(
          "github_identity",
          "Comment belongs to another issue.",
        );
      retain(
        retainedSource({
          key: `comment:${comment.node_id}`,
          kind: "comment",
          url: comment.html_url,
          issue_id: issue.id,
          repository_id: issue.repository_id,
          revision: comment.updated_at,
          complete: true,
          text: comment.body,
          actor: comment.user?.login || null,
          association: comment.author_association || null,
          created_at: comment.created_at,
          updated_at: comment.updated_at,
          references: [],
        }),
      );
    }
  } catch (error) {
    reader.signal.throwIfAborted();
    warnings.push(
      `Discussion coverage is incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const timeline = await reader.pages(`${base}/timeline`);
    retain(
      retainedSource({
        key: `timeline:${issue.id}`,
        kind: "timeline",
        url: issue.url,
        issue_id: issue.id,
        repository_id: issue.repository_id,
        revision: issue.updated_at,
        complete: true,
        text: JSON.stringify(timeline),
        actor: null,
        association: null,
        created_at: null,
        updated_at: issue.updated_at,
        references: [],
      }),
    );
    const linked = new Map<
      string,
      { url: string; repository: string; number: number }
    >();
    for (const raw of timeline) {
      const event = z
        .object({
          event: z.string(),
          source: z
            .object({
              issue: z
                .object({
                  html_url: z.string(),
                  pull_request: z.unknown().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .parse(raw);
      if (
        event.event !== "cross-referenced" ||
        !event.source?.issue?.pull_request
      )
        continue;
      const url = githubUrl(event.source.issue.html_url);
      const match = url.pathname.match(
        /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/,
      );
      if (!match || !Number.isSafeInteger(Number(match[3])))
        throw new AdeError(
          "github_identity",
          "Timeline PR identity is invalid.",
        );
      linked.set(url.href, {
        url: url.href,
        repository: `${match[1]}/${match[2]}`.toLowerCase(),
        number: Number(match[3]),
      });
    }
    if (linked.size > 10)
      warnings.push(
        "More than 10 linked PRs; competing work coverage is incomplete.",
      );
    for (const link of [...linked.values()].slice(0, 10)) {
      const pr = z
        .object({
          node_id: z.string(),
          html_url: z.string(),
          body: z.string().nullable(),
          title: z.string(),
          state: z.enum(["open", "closed"]),
          merged_at: z.string().nullable(),
          updated_at: z.string(),
          user: z.object({ login: z.string() }),
          base: z.object({ repo: z.object({ node_id: z.string() }) }),
        })
        .parse(
          await reader.read(`repos/${link.repository}/pulls/${link.number}`),
        );
      if (githubUrl(pr.html_url).href !== link.url)
        throw new AdeError("github_identity", "Linked PR identity changed.");
      const source = retainedSource({
        key: `pr:${issue.id}:${pr.node_id}`,
        kind: "pull_request",
        url: link.url,
        issue_id: issue.id,
        repository_id: issue.repository_id,
        revision: pr.updated_at,
        complete: true,
        text: JSON.stringify({
          title: pr.title,
          body: pr.body,
          state: pr.state,
          merged_at: pr.merged_at,
          author: pr.user.login,
        }),
        actor: pr.user.login,
        association: null,
        created_at: null,
        updated_at: pr.updated_at,
        references: [],
      });
      retain(source);
      const closing = markdownIssueReferences(
        pr.body || "",
        link.repository,
        true,
      ).some(
        (reference) =>
          reference.repository === issue.repository &&
          reference.number === issue.number,
      );
      if (
        pr.state === "open" &&
        closing &&
        pr.base.repo.node_id === issue.repository_id
      )
        evidence.push({
          kind: "open_pr",
          source_key: source.key,
          actor: pr.user.login,
          excerpt: source.text.slice(0, 4000),
          authority: "github_fact",
        });
      else if (pr.state === "open")
        warnings.push(
          `Possibly related open PR ${link.url}; no confirmed closing relationship was established.`,
        );
      else {
        evidence.push({
          kind: "closed_pr",
          source_key: source.key,
          actor: pr.user.login,
          excerpt: source.text.slice(0, 4000),
          authority: "github_fact",
        });
        if (pr.merged_at)
          warnings.push(
            "A linked PR was merged while this issue remains open; inspect remaining work.",
          );
      }
    }
  } catch (error) {
    reader.signal.throwIfAborted();
    warnings.push(
      `Timeline/competing PR coverage is incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { sources, evidence, warnings, complete: warnings.length === 0 };
};
