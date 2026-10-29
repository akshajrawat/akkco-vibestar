// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import {
  defaultSettings,
  SettingsSchema,
  pipelineConfiguration,
  type Settings,
} from "../../backend/domain";
import { StageSettings } from "../../src/features/providers/StageSettings";

afterEach(cleanup);

it("selects providers independently and resets incompatible model choices without changing review defaults", () => {
  const changed = vi.fn();

  const initial = {
    ...defaultSettings,
    antigravity: { model: "agy-high", effort: "high", timeout_secs: 1800 },
  };

  const Harness = () => {
    const [settings, setSettings] = useState<Settings>(initial);
    return (
      <StageSettings
        settings={settings}
        onChange={(value) => {
          changed(value);
          setSettings(value);
        }}
      />
    );
  };

  render(<Harness />);

  expect(screen.getAllByRole("combobox", { name: "Provider" })).toHaveLength(4);
  const plan = screen.getByRole("region", { name: "1 · Plan" });
  fireEvent.click(within(plan).getByRole("combobox", { name: "Provider" }));
  fireEvent.click(screen.getByRole("option", { name: "Codex" }));
  const saved = changed.mock.lastCall![0] as Settings;
  expect(pipelineConfiguration(saved, 1)).toMatchObject({ provider: "codex", model: "" });

  expect(pipelineConfiguration(saved, 5)).toMatchObject({
    provider: "antigravity",
    model: "agy-high",
  });

  expect(pipelineConfiguration(saved, 3).provider).toBe("codex");

  fireEvent.click(
    within(screen.getByRole("region", { name: "2 · Plan refinement" })).getByRole("combobox", {
      name: "Provider",
    }),
  );

  fireEvent.click(screen.getByRole("option", { name: "Antigravity" }));
  expect(pipelineConfiguration(changed.mock.lastCall![0], 2).provider).toBe("antigravity");
  expect(pipelineConfiguration(changed.mock.lastCall![0], 1).provider).toBe("codex");
});

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
