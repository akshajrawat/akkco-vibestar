import { it, expect } from "vitest";
import { z } from "zod";

import { codexSchema, codexResult } from "../../apps/core/execution/providers/codex-schema";

const TestSchema = z.object({
  summary: z.string(),
  reason: z.string(),
  lastMeaningfulActor: z.string().optional(),
  outstandingRequests: z.array(
    z.object({
      author: z.string(),
      request: z.string(),
      path: z.string().optional(),
    }),
  ),
});

it("adapts optional review fields to the official Codex strict schema and restores application optional semantics", () => {
  const schema = z.toJSONSchema(TestSchema);
  const strict = codexSchema(schema);
  const properties = strict.properties as Record<string, Record<string, unknown>>;
  const items = properties.outstandingRequests.items as Record<string, unknown>;
  expect(items.required).toContain("path");
  expect(strict.required).toContain("lastMeaningfulActor");

  const result = codexResult(schema, {
    summary: "Add coverage",
    reason: "Reviewer request",
    outstandingRequests: [
      {
        author: "reviewer",
        request: "Please add a test",
        path: null,
      },
    ],
    lastMeaningfulActor: null,
  }) as {
    summary: string;
    lastMeaningfulActor?: string;
    outstandingRequests: { author: string; request: string; path?: string }[];
  };

  expect(result.summary).toBe("Add coverage");
  expect(result.lastMeaningfulActor).toBeUndefined();
  expect(result.outstandingRequests[0].path).toBeUndefined();
});
