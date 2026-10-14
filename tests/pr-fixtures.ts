import { FixtureProvider } from "./fixtures";
import type { AgentRunRequest } from "../backend/execution/providers/contracts";
import { object } from "../backend/execution/providers/contracts";
import type { PullRequestState } from "../backend/scheduled/contracts";
import type { ReviewObservation } from "../backend/review/pr/contracts";

export const reviewBody = `Hi, I have reviewed this and tested it locally, and it works fine in both desktop and mobile.

A few observations:

Some selectors and expect functions are placed in the spec file directly. But usually in other migrated spec files, those selectors and expect functions are moved into the utility files. It may be good to move them there too.

The test now tests a different exploration compared to the previous puppeteer test. Is this intentional? This is not mentioned in the PR description.

The test for the draft seems to be testing something that will pass regardless, so it may miss some problem in that behavior. It might be better to make it stricter?

Apart from that, everything seems to be fine to me.`;

export const prSnapshot: PullRequestState = {
  title: "Review fixture",
  body: "Migrate acceptance tests",
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "CHANGES_REQUESTED",
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
  author: "contributor",
  authenticatedUser: "contributor",
  coverage: { complete: true, missing: [], warnings: [] },
  identity: {
    prId: "PR_1",
    headRepository: "contributor/project",
    headRepositoryId: "R_fork",
    headBranch: "existing-pr",
    baseRepository: "upstream/project",
    baseRepositoryId: "R_upstream",
    baseBranch: "develop",
  },
  discussion: [
    {
      id: "review-1",
      type: "review",
      author: "reviewer",
      body: reviewBody,
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      url: "https://github.com/upstream/project/pull/1#pullrequestreview-1",
      reviewState: "COMMENTED",
    },
  ],
  comments: [],
  reviews: [
    {
      id: "review-1",
      author: "reviewer",
      body: reviewBody,
      state: "COMMENTED",
      submitted_at: "2026-10-01T10:00:00Z",
    },
  ],
  threads: [],
  files: [
    {
      path: "spec.ts",
      previousPath: null,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
  checks: [],
  commits: [],
};

export const observations: ReviewObservation[] = [
  [
    "Some selectors and expect functions are placed in the spec file directly.",
    "suggested_change",
    "Inspect analogous migrated tests and reuse utility selectors/assertions.",
  ],
  [
    "The test now tests a different exploration compared to the previous puppeteer test. Is this intentional?",
    "question",
    "Compare the old and new test and restore parity or explain the intentional change.",
  ],
  [
    "The test for the draft seems to be testing something that will pass regardless",
    "suggested_change",
    "Demonstrate the vacuous assertion and verify meaningful draft behavior.",
  ],
  [
    "it works fine in both desktop and mobile.",
    "positive_feedback",
    "Preserve the reviewer's reported verification; this is not a new task.",
  ],
].map(([originalText, classification, recommendedAction]) => ({
  existingActionId: null,
  sourceId: "review-1",
  originalText,
  classification: classification as ReviewObservation["classification"],
  priority: "medium",
  affectedFiles: classification === "positive_feedback" ? [] : ["spec.ts"],
  recommendedAction,
  authorReplyIds: [],
  reviewerAcknowledgmentIds: [],
  responseState: "no_author_reply",
  evidenceIds: ["review-1"],
  commitShas: [],
  evidence: "Original review text; code requires inspection and verification.",
  confidence: "high",
}));

export const analysisResult = (snapshot = prSnapshot) => ({
  summary: "Three observations require consideration, plus positive feedback.",
  observations: structuredClone(observations),
  coverage: (snapshot.discussion || []).map((source) => ({
    sourceId: source.id,
    segmentIds: Array.from(
      {
        length: Math.max(1, Math.ceil(Array.from(source.body).length / 12000)),
      },
      (_, index) => `${source.id}:${index}`,
    ),
    disposition: "analyzed" as const,
    reason: "Complete source inspected.",
  })),
  warnings: [],
});

export class PRFixtureProvider extends FixtureProvider {
  invocation = (request: AgentRunRequest) => {
    if (!("observations" in object(request.schema.properties)))
      return new FixtureProvider().invocation(request);
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `(async()=>{const fs=require('node:fs/promises');const path=require('node:path');const manifestPath=${JSON.stringify(request.prompt.match(/analysis-[\w-]+\/manifest\.json/)?.[0])};const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));for(const source of manifest.sources)for(const segment of source.segments)await fs.readFile(path.join(path.dirname(manifestPath),segment.path),'utf8');for(const context of manifest.contextPaths)await fs.readFile(path.join(path.dirname(manifestPath),context),'utf8');console.log(JSON.stringify({type:'thread.started',thread_id:'pr-fixture-session'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(analysisResult()))}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:50,output_tokens:10}}));})().catch(e=>{console.error(e);process.exit(1);});`,
      ],
    };
  };
}
