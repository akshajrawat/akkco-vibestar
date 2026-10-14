import { createHash, randomUUID } from "node:crypto";
import { AdeError, now } from "../../domain";
import type { Database } from "../../storage/database";
import { discussionEntries } from "../../scheduled/action";
import type { PullRequestState } from "../../scheduled/contracts";
import type { ReviewAction, ReviewObservation } from "./contracts";

export const persistReviewActions = (
  db: Database,
  jobId: string,
  analysisId: string,
  snapshot: PullRequestState,
  observations: ReviewObservation[],
  previous: ReviewAction[],
) => {
  const sources = discussionEntries(snapshot);
  const knownCommits = new Set(snapshot.commits?.map((c) => c.sha));
  const used = new Set<string>();
  return observations.map((observation) => {
    const source = sources.find((s) => s.id === observation.sourceId);
    if (!source || !source.body.includes(observation.originalText))
      throw new AdeError(
        "analysis_evidence",
        "Analysis cited an unknown source or a quotation absent from the original review.",
      );
    if (source.author.toLowerCase() === snapshot.author?.toLowerCase())
      throw new AdeError(
        "analysis_evidence",
        "An author reply cannot be a reviewer request.",
      );
    if (
      source.bot &&
      !["positive_feedback", "informational"].includes(
        observation.classification,
      )
    )
      throw new AdeError(
        "analysis_evidence",
        "Bot activity cannot be attributed to a human reviewer.",
      );
    const replies = observation.authorReplyIds.map((id) => {
      const reply = sources.find((s) => s.id === id);
      if (
        !reply ||
        reply.author.toLowerCase() !== snapshot.author?.toLowerCase() ||
        reply.createdAt <= (source.updatedAt || source.createdAt) ||
        (source.threadId && reply.threadId !== source.threadId)
      )
        throw new AdeError(
          "analysis_evidence",
          "Author-response evidence does not answer this source.",
        );
      return reply;
    });
    for (const id of observation.reviewerAcknowledgmentIds) {
      const acknowledgment = sources.find((s) => s.id === id);
      if (
        !acknowledgment ||
        acknowledgment.author !== source.author ||
        acknowledgment.createdAt <= source.createdAt ||
        (source.threadId && acknowledgment.threadId !== source.threadId)
      )
        throw new AdeError(
          "analysis_evidence",
          "Reviewer acknowledgment has no valid later source.",
        );
    }
    if (
      observation.evidenceIds.some((id) => !sources.some((s) => s.id === id)) ||
      observation.commitShas.some((sha) => !knownCommits.has(sha))
    )
      throw new AdeError(
        "analysis_evidence",
        "Analysis evidence references unavailable GitHub items.",
      );
    if (
      observation.responseState === "answered" &&
      observation.classification !== "question"
    )
      throw new AdeError(
        "analysis_evidence",
        "A reply does not establish that a code request was fixed.",
      );
    if (
      ["author_replied", "partially_answered", "answered"].includes(
        observation.responseState,
      ) &&
      !replies.length
    )
      throw new AdeError(
        "analysis_evidence",
        "Analysis claimed a response without author evidence.",
      );
    const anchor = `${source.id}/${createHash("sha256").update(observation.originalText.trim()).digest("hex")}`;
    const matched = previous.find(
      (a) =>
        a.sourceId === source.id &&
        a.originalText.trim() === observation.originalText.trim(),
    );
    const existing = observation.existingActionId
      ? previous.find((a) => a.id === observation.existingActionId)
      : matched;
    if (
      observation.existingActionId &&
      (!existing ||
        existing.reviewer !== source.author ||
        existing.sourceId !== source.id)
    )
      throw new AdeError(
        "analysis_evidence",
        "Existing observation does not belong to the same review source.",
      );
    const stored = db.all<{ id: string }>(
      "SELECT id FROM pr_review_actions WHERE job_id=? AND anchor=?",
      jobId,
      anchor,
    )[0];
    const id = existing?.id || stored?.id || randomUUID();
    if (used.has(id))
      throw new AdeError(
        "analysis_evidence",
        "Separate observations cannot overwrite one action identity.",
      );
    used.add(id);
    db.run(
      "INSERT OR IGNORE INTO pr_review_actions VALUES(?,?,?,?)",
      id,
      jobId,
      anchor,
      now(),
    );
    const action: ReviewAction = {
      ...observation,
      affectedFiles: [...new Set(observation.affectedFiles)],
      authorReplyIds: [...new Set(observation.authorReplyIds)],
      reviewerAcknowledgmentIds: [
        ...new Set(observation.reviewerAcknowledgmentIds),
      ],
      evidenceIds: [...new Set(observation.evidenceIds)],
      commitShas: [...new Set(observation.commitShas)],
      id,
      reviewer: source.author,
      sourceUrl: source.url || null,
      sourceThreadId: source.threadId || null,
      threadResolved: source.resolved ?? null,
      outdated: source.outdated ?? null,
      responseState: replies.length
        ? observation.responseState
        : observation.responseState === "needs_manual_judgment"
          ? "needs_manual_judgment"
          : "no_author_reply",
      codeStatus: "unverified",
      confidence: source.author === "unknown" ? "low" : observation.confidence,
    };
    db.run(
      "INSERT INTO pr_action_assessments VALUES(?,?,?)",
      analysisId,
      id,
      JSON.stringify(action),
    );
    return action;
  });
};
