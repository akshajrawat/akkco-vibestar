import { it, expect } from "vitest";
import { z } from "zod";
import {
  codexSchema,
  codexResult,
} from "../backend/execution/providers/codex-schema";
import { ActionSchema } from "../backend/scheduled/action";
it("adapts optional review fields to the official Codex strict schema and restores application optional semantics", () => {
  const schema = z.toJSONSchema(ActionSchema);
  const strict = codexSchema(schema);
  const properties = strict.properties as Record<
    string,
    Record<string, unknown>
  >;
  const items = properties.outstandingRequests.items as Record<string, unknown>;
  expect(items.required).toContain("path");
  expect(strict.required).toContain("lastMeaningfulActor");
  const result = codexResult(schema, {
    manualActionRequired: true,
    conversationState: "waiting_for_me",
    severity: "action_required",
    summary: "Add coverage",
    reason: "Reviewer request",
    outstandingRequests: [
      {
        author: "reviewer",
        request: "Please add a test",
        sourceId: "1",
        path: null,
      },
    ],
    alreadyAddressed: [],
    recommendedNextAction: "Add test",
    affectedFiles: [],
    newActivity: [],
    lastMeaningfulActor: null,
    lastMeaningfulActivityAt: null,
  });
  expect(ActionSchema.parse(result).outstandingRequests[0]).toEqual({
    author: "reviewer",
    request: "Please add a test",
    sourceId: "1",
  });
  expect(ActionSchema.parse(result).lastMeaningfulActor).toBeUndefined();
  expect(schema.required).not.toContain("lastMeaningfulActor");
});
it("preserves intentional nullable fields and rejects unsupported dynamic object output", () => {
  const schema = z.toJSONSchema(
    z.object({
      optional: z.string().optional(),
      nullable: z.string().nullable(),
    }),
  );
  expect(codexResult(schema, { optional: null, nullable: null })).toEqual({
    nullable: null,
  });
  expect(() =>
    codexSchema(z.toJSONSchema(z.record(z.string(), z.string()))),
  ).toThrow("fixed object fields");
});
