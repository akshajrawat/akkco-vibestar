import { z } from "zod";
import type { DiscussionEntry, PullRequestState } from "./contracts";
export const ActionSchema = z
  .object({
    manualActionRequired: z.boolean(),
    conversationState: z
      .enum([
        "waiting_for_me",
        "waiting_for_reviewer",
        "waiting_for_ci",
        "approved",
        "blocked",
        "merged",
        "closed",
        "neutral",
      ])
      .default("neutral"),
    severity: z.enum(["action_required", "warning", "info", "none"]),
    summary: z.string(),
    reason: z.string(),
    outstandingRequests: z
      .array(
        z.object({
          author: z.string(),
          request: z.string(),
          sourceId: z.string(),
          path: z.string().optional(),
        }),
      )
      .default([]),
    alreadyAddressed: z.array(z.string()).default([]),
    recommendedNextAction: z.string(),
    affectedFiles: z.array(z.string()),
    newActivity: z.array(z.string()).default([]),
    lastMeaningfulActor: z.enum(["me", "reviewer", "bot"]).optional(),
    lastMeaningfulActivityAt: z.string().optional(),
  })
  .strict();
export type PullRequestAction = z.infer<typeof ActionSchema>;
export const discussionEntries = (
  snapshot: PullRequestState,
): DiscussionEntry[] =>
  snapshot.discussion || [
    ...snapshot.comments.map((c) => ({
      id: c.id,
      type: "issue_comment" as const,
      author: c.author || "reviewer",
      body: c.body,
      createdAt: c.updated_at,
      updatedAt: c.updated_at,
    })),
    ...snapshot.reviews.map((r) => ({
      id: r.id,
      type: "review" as const,
      author: r.author || "reviewer",
      body: r.body,
      createdAt: r.submitted_at,
      updatedAt: r.submitted_at,
      reviewState: r.state,
    })),
    ...(snapshot.threads || []).map((t) => ({
      id: t.id,
      type: "thread" as const,
      threadId: t.id,
      author: "reviewer",
      body: t.body,
      createdAt: "",
      updatedAt: "",
      path: t.path,
      resolved: t.resolved,
    })),
  ];
const acknowledgment =
  /^(?:lgtm|looks good(?: to me)?|got it(?:,? thanks)?|thanks(?: you)?(?: for (?:the (?:explanation|update)|clarifying))?|thank you|approved|perfect|great|okay|ok|sounds good|all good)[.!\s]*$/i;
export const isAcknowledgment = (text: string) =>
  acknowledgment.test(text.trim());
