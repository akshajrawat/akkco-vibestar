import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Nodes } from "mdast";
import { now, parseIssue } from "../domain";
import { CollectionLimit, verifyIssueIdentity, type IssueSearch } from "../github/issue-search";
import type { WatchRules, WatchSource } from "./contracts";
import { digest, issueKey, repositoryName } from "./rules";
import { z } from "zod";

const parser = unified().use(remarkParse);
export const markdownIssueReferences = (
  markdown: string,
  repository: string,
  closingOnly = false,
) => {
  const tree = parser.parse(markdown);
  const references = new Map<string, { repository: string; number: number }>();
  const definitions = new Map(
    tree.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier.toLowerCase(), node.url] as const] : [],
    ),
  );
  const add = (reference: { repository: string; number: number }, offset: number) => {
    if (
      closingOnly &&
      !/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+$/i.test(
        markdown.slice(Math.max(0, offset - 100), offset),
      )
    )
      return;
    references.set(issueKey(reference), reference);
    if (references.size > 2000)
      throw new CollectionLimit("Tracker exceeded 2,000 unique issue references.");
  };
  const url = (value: string, offset: number) => {
    try {
      const ref = parseIssue(value);
      add(
        {
          repository: `${ref.owner}/${ref.repo}`.toLowerCase(),
          number: ref.number,
        },
        offset,
      );
    } catch (error) {
      if (error instanceof CollectionLimit) throw error;
      // Non-issue links, including /pull/, are outside the reference scope.
    }
  };
  const walk = (node: Nodes) => {
    if (["code", "inlineCode", "html", "image", "imageReference", "definition"].includes(node.type))
      return;
    if (node.type === "link") {
      url(node.url, node.position?.start.offset || 0);
      return;
    }
    if (node.type === "linkReference") {
      const target = definitions.get(node.identifier.toLowerCase());
      if (target) url(target, node.position?.start.offset || 0);
      return;
    }
    if (node.type === "text") {
      const raw = markdown.slice(node.position?.start.offset, node.position?.end.offset);
      for (const match of raw.matchAll(
        /(?<![\\\w])https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+(?:[?#][^\s<>]*)?|(?<![\\\w/#])(?:([\w.-]+\/[\w.-]+))?#([1-9]\d*)\b/g,
      )) {
        const offset = (node.position?.start.offset || 0) + match.index;
        if (match[2]) {
          const number = Number(match[2]);
          if (Number.isSafeInteger(number))
            add({ repository: repositoryName(match[1] || repository), number }, offset);
        } else url(match[0].replace(/[.,;)]+$/, ""), offset);
      }
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return [...references.values()].sort((a, b) => issueKey(a).localeCompare(issueKey(b)));
};

export const retainedSource = (input: Omit<WatchSource, "hash" | "fetched_at">) => {
  if (Buffer.byteLength(input.text) > 1048576)
    throw new CollectionLimit("Individual source exceeded 1 MiB.");
  return { ...input, hash: digest(input.text), fetched_at: now() };
};

export const trackerExclusions = async (
  reader: IssueSearch,
  rules: WatchRules,
  save: (source: WatchSource) => void,
  previous: WatchSource[] = [],
) => {
  const excluded = new Set<string>();
  for (const tracker of rules.trackers) {
    reader.signal.throwIfAborted();
    const ref = parseIssue(tracker.url);
    const prior = previous.find(
      (source) =>
        source.kind === "tracker" &&
        (source.requested_url || source.url).toLowerCase() === tracker.url.toLowerCase(),
    );
    const repository = await reader.repository(`${ref.owner}/${ref.repo}`, prior?.repository_id);
    const issue = await reader.issue(repository, ref.number);
    if (prior?.issue_id) verifyIssueIdentity(issue, { id: prior.issue_id, number: ref.number });
    if (issue.pull_request)
      throw new CollectionLimit("A required tracker identifies a pull request.");
    const references = markdownIssueReferences(issue.body, repository.full_name);
    references.push({ repository: repository.full_name, number: issue.number });
    // Retain both names if GitHub resolved a verified repository rename.
    references.push({
      repository: `${ref.owner}/${ref.repo}`.toLowerCase(),
      number: issue.number,
    });
    for (const reference of references) excluded.add(issueKey(reference));
    const source = retainedSource({
      key: `tracker:${issue.id}`,
      kind: "tracker",
      url: issue.url,
      requested_url: tracker.url,
      issue_id: issue.id,
      repository_id: repository.id,
      revision: issue.updated_at,
      complete: tracker.comments === "none",
      text: issue.body,
      actor: null,
      association: null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      references: [...new Map(references.map((item) => [issueKey(item), item])).values()],
    });
    save(source);
    if (tracker.comments === "all") {
      const comments = await reader.pages(
        `repos/${repository.full_name}/issues/${issue.number}/comments`,
      );
      if (comments.length !== issue.comment_count)
        throw new CollectionLimit("Tracker comment count changed during collection.");
      for (const raw of comments) {
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
          .parse(raw);
        const refs = markdownIssueReferences(comment.body, repository.full_name);
        for (const reference of refs) excluded.add(issueKey(reference));
        save(
          retainedSource({
            key: `tracker-comment:${comment.node_id}`,
            kind: "tracker_comment",
            url: comment.html_url,
            issue_id: issue.id,
            repository_id: repository.id,
            revision: comment.updated_at,
            complete: true,
            text: comment.body,
            actor: comment.user?.login || null,
            association: comment.author_association || null,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            references: refs,
          }),
        );
      }
      const current = await reader.issue(repository, issue.number);
      if (
        current.id !== issue.id ||
        current.updated_at !== issue.updated_at ||
        current.comment_count !== comments.length ||
        current.body !== issue.body
      )
        throw new CollectionLimit("Tracker changed while its comments were being verified.");
      save({ ...source, complete: true });
    }
    if (excluded.size > 10000)
      throw new CollectionLimit("Combined tracker reference budget exceeded.");
  }
  return excluded;
};
