import { expect, it } from "vitest";

import { defaultSettings, SettingsSchema, pipelineConfiguration } from "../../backend/domain";

it("preserves legacy defaults and validates effort against the chosen stage provider", () => {
  const legacy = SettingsSchema.parse(defaultSettings);

  expect([1, 2, 3, 5].map((stage) => pipelineConfiguration(legacy, stage).provider)).toEqual([
    "antigravity",
    "codex",
    "codex",
    "antigravity",
  ]);

  expect(
    SettingsSchema.safeParse({
      ...legacy,
      codex_implementation: {
        provider: "antigravity",
        model: "model-high",
        effort: "low",
        timeout_secs: 30,
      },
    }).success,
  ).toBe(false);

  expect(
    SettingsSchema.safeParse({
      ...legacy,
      codex_plan: { provider: "unknown", model: "", effort: "high", timeout_secs: 30 },
    }).success,
  ).toBe(false);
});
