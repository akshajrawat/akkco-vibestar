import { createHash } from "node:crypto";
import { z } from "zod";
import { AdeError, parseIssue, remoteIdentity } from "../domain";
import { WatchRulesSchema, type WatchConfiguration } from "./contracts";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const repositoryName = (input: string) => {
  const value = input.trim();
  const identity = remoteIdentity(value.includes("://") ? value : `https://github.com/${value}`);
  if (!identity || (value.includes("://") && !value.startsWith("https://github.com/")))
    throw new AdeError("invalid_input", "Use owner/repository or its HTTPS GitHub URL.");
  return `${identity.owner}/${identity.name}`.toLowerCase();
};
export const issueKey = (reference: { repository: string; number: number }) =>
  `${reference.repository.toLowerCase()}#${reference.number}`;
const controls = WatchRulesSchema.pick({
  excluded_labels: true,
  excluded_issues: true,
  trackers: true,
  unassigned_only: true,
})
  .partial()
  .strict();
export const PreviewInput = z
  .object({
    repository: z.string().min(1).max(500),
    prompt: z.string().min(1).max(8000),
    controls: controls.optional(),
  })
  .strict();

export const previewRules = (input: unknown) => {
  const p = PreviewInput.parse(input);
  const repository = repositoryName(p.repository);
  const explanation: {
    start: number;
    end: number;
    text: string;
    rule: string;
  }[] = [];
  const ambiguities: { id: string; text: string; explanation: string }[] = [];
  const labels = new Set<string>();
  const trackers = new Map<string, "none" | "all">();
  const excluded = new Map<string, { repository: string; number: number }>();
  const add = (start: number, text: string, rule: string) => {
    explanation.push({ start, end: start + text.length, text, rule });
  };
  for (const match of p.prompt.matchAll(
    /(?:not|exclude|without|no)[^.!?\n]{0,35}?\btriage[ -]needed\b/gi,
  )) {
    labels.add("triage needed");
    add(
      match.index,
      match[0],
      'Exclude exact label "triage needed" (case insensitive); similar labels need explicit controls.',
    );
  }
  for (const match of p.prompt.matchAll(/(?:-label:|exclude\s+labels?\s+)"([^"\n]{1,100})"/gi)) {
    labels.add(match[1].trim().toLowerCase());
    add(match.index, match[0], `Exclude exact label ${match[1]}.`);
  }
  const references = p.prompt.matchAll(
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+(?:[?#][^\s)>,]*)?|(?<![\w/#])#([1-9]\d*)\b/g,
  );
  for (const match of references) {
    const reference = match[1]
      ? { repository, number: Number(match[1]) }
      : (() => {
          const ref = parseIssue(match[0].replace(/[.,;]+$/, ""));
          return {
            repository: `${ref.owner}/${ref.repo}`.toLowerCase(),
            number: ref.number,
          };
        })();
    const before = p.prompt.slice(Math.max(0, match.index - 100), match.index);
    const url = `https://github.com/${reference.repository}/issues/${reference.number}`;
    if (
      /(?:tracker|not\s+(?:present|included|listed)\s+in|not\s+in|excluded?\s+by)[^.!?\n]*$/i.test(
        before,
      )
    ) {
      trackers.set(url, "none");
      add(match.index, match[0], `Dynamically exclude references in ${url}; body only.`);
    } else if (/(?:exclude|ban|except|not\s+issue)\s+(?:issues?\s*)?$/i.test(before)) {
      excluded.set(issueKey(reference), reference);
      add(match.index, match[0], `Exclude ${issueKey(reference)}.`);
    } else {
      ambiguities.push({
        id: `reference:${match.index}`,
        text: match[0],
        explanation:
          "Choose an excluded issue/tracker control, or acknowledge this as an AI preference. A bare reference has no assumed role.",
      });
    }
  }
  const unassigned =
    /\b(?:unassigned|no\s+assignee|not\s+(?:already\s+)?claimed|no\s+other\s+contributor[^.!?\n]*claimed|request\s+assignment)\b/i.test(
      p.prompt,
    );
  for (const match of p.prompt.matchAll(
    /\b(?:open issues?|unassigned|no\s+assignee|not\s+(?:already\s+)?claimed|no\s+other\s+contributor[^.!?\n]*claimed|request\s+assignment)\b/gi,
  ))
    add(
      match.index,
      match[0],
      "Open issues only; inspect assignments, active claims and competing PRs. Uncertain claims require manual review.",
    );
  for (const label of p.controls?.excluded_labels || []) labels.add(label.trim().toLowerCase());
  for (const reference of p.controls?.excluded_issues || []) {
    const normalized = {
      ...reference,
      repository: repositoryName(reference.repository),
    };
    excluded.set(issueKey(normalized), normalized);
  }
  for (const tracker of p.controls?.trackers || []) {
    const ref = parseIssue(tracker.url);
    trackers.set(
      `https://github.com/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}/issues/${ref.number}`,
      tracker.comments,
    );
  }
  let remaining = p.prompt;
  for (const span of [...explanation].sort((a, b) => b.start - a.start))
    remaining =
      remaining.slice(0, span.start) +
      " ".repeat(span.end - span.start) +
      remaining.slice(span.end);
  if (/\b(?:not|exclude|only|must|make sure|without|no other)\b/i.test(remaining))
    ambiguities.push({
      id: "remaining-requirements",
      text: remaining.trim(),
      explanation:
        "Some requirements are outside this small deterministic grammar. Confirm the visible hard controls or acknowledge the remaining text as AI preferences; they are not guaranteed hard filters.",
    });
  const rules = WatchRulesSchema.parse({
    compiler_version: 1,
    open_only: true,
    exclude_pull_requests: true,
    excluded_labels: [...labels].filter(Boolean).sort(),
    excluded_issues: [...excluded.values()].sort((a, b) => issueKey(a).localeCompare(issueKey(b))),
    trackers: [...trackers]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([url, comments]) => ({ url, comments })),
    unassigned_only: unassigned || p.controls?.unassigned_only === true,
    active_claims: "review_possible_exclude_confirmed",
    competing_pull_requests: "exclude_confirmed_open",
  });
  return {
    compiler_version: 1 as const,
    repository,
    rules,
    explanation,
    ambiguities,
    preferences: remaining.trim(),
    digest: digest({
      repository,
      prompt: p.prompt,
      rules,
      explanation,
      ambiguities,
    }),
  };
};

export const confirmConfiguration = (repository: string, configuration: WatchConfiguration) => {
  const preview = previewRules({
    repository,
    prompt: configuration.prompt,
    controls: controls.parse({
      excluded_labels: configuration.rules.excluded_labels,
      excluded_issues: configuration.rules.excluded_issues,
      trackers: configuration.rules.trackers,
      unassigned_only: configuration.rules.unassigned_only,
    }),
  });
  if (
    preview.digest !== configuration.preview_digest ||
    digest(preview.rules) !== digest(configuration.rules)
  )
    throw new AdeError(
      "stale_preview",
      "Preview the current prompt and hard controls again before saving.",
    );
  const decisions = new Map(
    configuration.ambiguity_decisions.map((decision) => [decision.id, decision.interpretation]),
  );
  if (
    decisions.size !== configuration.ambiguity_decisions.length ||
    [...decisions.keys()].some((id) => !preview.ambiguities.some((item) => item.id === id)) ||
    preview.ambiguities.some((item) => !decisions.has(item.id))
  )
    throw new AdeError("ambiguous_rules", "Confirm every rule ambiguity before saving this watch.");
  return preview;
};
