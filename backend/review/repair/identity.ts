import { z } from "zod";
import { AdeError, now } from "../../domain";
import { GitHubClient } from "../../github/client";
import { parsePullRequest } from "../../scheduled/contracts";
import { PRIdentitySchema } from "./contracts";

const repository = z.object({
  node_id: z.string().min(1),
  full_name: z.string().min(1),
  clone_url: z.string().url(),
});
const branch = z.object({
  ref: z.string().min(1),
  sha: z.string(),
  repo: repository,
});
const pr = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  head: branch,
  base: branch,
});

// This only reads official gh API metadata. It never reads provider credentials.
export class PRIdentityReader {
  constructor(private readonly client: GitHubClient) {}
  read = async (url: string, signal: AbortSignal) => {
    const reference = parsePullRequest(url);
    const metadata = pr.parse(
      await this.client.api(
        `repos/${reference.owner}/${reference.repo}/pulls/${reference.number}`,
        signal,
      ),
    );
    const [head, viewer, base] = await Promise.all([
      this.client.api(`repos/${metadata.head.repo.full_name}`, signal),
      this.client.api("user", signal),
      this.client.api(
        `repos/${metadata.base.repo.full_name}/git/ref/heads/${metadata.base.ref.split("/").map(encodeURIComponent).join("/")}`,
        signal,
      ),
    ]);
    const source = repository
      .extend({ permissions: z.object({ push: z.boolean() }) })
      .parse(head);
    if (
      metadata.html_url !== reference.url ||
      metadata.number !== reference.number ||
      metadata.base.repo.full_name.toLowerCase() !==
        `${reference.owner}/${reference.repo}`.toLowerCase() ||
      source.node_id !== metadata.head.repo.node_id ||
      source.full_name.toLowerCase() !==
        metadata.head.repo.full_name.toLowerCase()
    )
      throw new AdeError(
        "pr_identity",
        "GitHub PR repository identity changed or is inconsistent.",
      );
    const repo = (value: z.infer<typeof repository>) => ({
      name: value.full_name,
      id: value.node_id,
      url: value.clone_url,
    });
    const identity = PRIdentitySchema.parse({
      url: reference.url,
      number: reference.number,
      id: metadata.node_id,
      upstream: repo(metadata.base.repo),
      head: {
        ...repo(source),
        branch: metadata.head.ref,
        sha: metadata.head.sha,
      },
      base: {
        branch: metadata.base.ref,
        sha: z.object({ object: z.object({ sha: z.string() }) }).parse(base)
          .object.sha,
      },
      viewer: z.object({ login: z.string().min(1) }).parse(viewer).login,
      can_push: source.permissions.push,
      state: metadata.state,
      checked_at: now(),
    });
    // Git commands validate refs too; reject ambiguous or option-like values here.
    for (const ref of [identity.head.branch, identity.base.branch])
      if (
        ref.startsWith("-") ||
        /[\x00-\x20~^:?*[\\]/.test(ref) ||
        ref.includes("..") ||
        ref.includes("@{")
      )
        throw new AdeError(
          "pr_identity",
          "GitHub returned an invalid branch ref.",
        );
    for (const remote of [identity.upstream, identity.head])
      if (remote.url !== `https://github.com/${remote.name}.git`)
        throw new AdeError(
          "pr_identity",
          "GitHub returned an unexpected repository transport.",
        );
    return identity;
  };
}
