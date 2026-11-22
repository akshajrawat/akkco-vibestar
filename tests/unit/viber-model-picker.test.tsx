// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import { ViberModelPicker } from "../../apps/desktop/features/vibers/ViberModelPicker";
import { useProviders } from "../../apps/desktop/hooks/useWorkspace";
import { viberProfile } from "../helpers/viber-fixtures";

vi.mock("../../apps/desktop/hooks/useWorkspace", () => ({
  useProviders: vi.fn(() => ({
    providers: [
      {
        provider: "codex",
        models: [
          { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", supportedEfforts: ["low", "xhigh"] },
          { id: "gpt-6-luna", label: "GPT-6-Luna", supportedEfforts: ["low", "high"] },
        ],
        efforts: ["low", "xhigh"],
      },
      {
        provider: "antigravity",
        models: [
          {
            id: "gemini-3.8-flash-high",
            label: "Gemini 3.8 Flash (High)",
            supportedEfforts: ["high"],
            isDefault: true,
          },
          {
            id: "gemini-3.8-flash-medium",
            label: "Gemini 3.8 Flash (Medium)",
            supportedEfforts: ["medium"],
          },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash Low", supportedEfforts: ["low"] },
          {
            id: "claude-sonnet-4-6",
            label: "Claude Sonnet 4.6 (Thinking)",
            supportedEfforts: ["default"],
          },
          { id: "oss-120b-medium", label: "OSS 120B (Medium)", supportedEfforts: ["medium"] },
        ],
        efforts: ["low", "medium", "high", "xhigh"],
      },
    ],
  })),
}));

afterEach(() => {
  cleanup();
  vi.mocked(useProviders).mockReset();
});

const Harness = ({
  change,
  initial = {
    ...viberProfile.execution,
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "xhigh",
  },
}: {
  change: (execution: typeof viberProfile.execution) => void;
  initial?: typeof viberProfile.execution;
}) => {
  const [execution, setExecution] = useState(initial);
  return (
    <ViberModelPicker
      execution={execution}
      change={(next) => {
        change(next);
        setExecution(next);
      }}
    />
  );
};

it("keeps model and reasoning edits in one open picker and saves the final configuration once on dismissal", () => {
  const change = vi.fn();
  render(<Harness change={change} />);
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(trigger.textContent).toBe("6.1 Sol Extra High");
  fireEvent.click(trigger);
  expect(screen.queryByRole("option", { name: /default/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Antigravity" }));
  expect(screen.queryByRole("option", { name: "6 Luna" })).toBeNull();
  expect(screen.queryByRole("option", { name: /default/i })).toBeNull();
  expect(screen.getByText("Choose a model to set reasoning.")).toBeTruthy();
  expect(screen.getAllByRole("option", { name: "Gemini 3.8 Flash" })).toHaveLength(1);
  expect(screen.queryByRole("option", { name: /Flash.*(High|Medium|Low)/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "Gemini 3.8 Flash" }));
  expect(screen.getByRole("listbox")).toBeTruthy();
  const reasoning = screen.getByRole("region", { name: "Reasoning effort" });

  expect(
    within(reasoning)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Low", "Medium", "High"]);

  fireEvent.click(within(reasoning).getByRole("button", { name: "Medium" }));
  expect(trigger.textContent).toBe("Gemini 3.8 Flash Medium");
  expect(change).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  const search = screen.getByRole("combobox", { name: "Search model" });
  fireEvent.change(search, { target: { value: "Sol" } });
  expect(screen.queryByRole("option", { name: "6 Luna" })).toBeNull();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(screen.getByRole("listbox")).toBeTruthy();
  const high = within(reasoning).getByRole("button", { name: "Extra High" });
  fireEvent.click(high);
  expect(trigger.textContent).toBe("6.1 Sol Extra High");
  fireEvent.click(within(reasoning).getByRole("button", { name: "Low" }));
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  expect(change).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "low",
    }),
  );
});

it("loads models through the provider RPC and saves a concrete selection", async () => {
  const { useProviders: actualUseProviders } = await vi.importActual<
    typeof import("../../apps/desktop/hooks/useWorkspace")
  >("../../apps/desktop/hooks/useWorkspace");

  vi.mocked(useProviders).mockImplementation(actualUseProviders);

  const rpc = vi
    .fn(async () => [
      {
        provider: "codex",
        models: [{ id: "gpt-6.2-sol", isDefault: true, supportedEfforts: ["high"] }],
      },
    ])
    .mockResolvedValueOnce([{ provider: "codex", models: [] }]);

  const CatalogConsumer = () => {
    const { providers } = actualUseProviders();
    return (
      <output>{providers[0]?.models[0]?.id || (providers.length ? "Empty catalog" : "")}</output>
    );
  };

  vi.stubGlobal("vibestar", { rpc, subscribe: () => () => {} });
  try {
    const change = vi.fn();

    render(
      <>
        <CatalogConsumer />
        <Harness change={change} initial={{ ...viberProfile.execution, model: "" }} />
      </>,
    );

    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger.textContent).toBe("Choose model");
    expect(trigger.querySelector(".lucide-chevron-down")).toBeNull();
    await screen.findByText("Empty catalog");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("providers.detect", {});
    fireEvent.click(trigger);

    const model = await screen.findByRole("option", { name: "6.2 Sol" });
    expect(screen.getByText("gpt-6.2-sol")).toBeTruthy();
    expect(model.getAttribute("aria-selected")).toBe("true");
    expect(trigger.textContent).toBe("6.2 Sol Low");
    fireEvent.click(model);
    fireEvent.click(trigger);

    expect(change).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: "gpt-6.2-sol", effort: "high" }),
    );

    expect(rpc.mock.calls).toEqual([
      ["providers.detect", {}],
      ["providers.detect", {}],
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("maps grouped reasoning choices to discovered CLI IDs and supports models with automatic reasoning", () => {
  const change = vi.fn();

  render(
    <Harness
      change={change}
      initial={{
        ...viberProfile.execution,
        provider: "antigravity",
        model: "gemini-3.8-flash-high",
        effort: "high",
      }}
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(trigger.textContent).toBe("Gemini 3.8 Flash High");
  fireEvent.click(trigger);

  expect(
    screen.getByRole("option", { name: "Gemini 3.8 Flash" }).getAttribute("aria-selected"),
  ).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Low" }));
  fireEvent.pointerDown(document.body);

  expect(change).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      provider: "antigravity",
      model: "gemini-3.8-flash-low",
      effort: "low",
    }),
  );

  expect(trigger.textContent).toBe("Gemini 3.8 Flash Low");

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 4.6 (Thinking)" }));
  expect(screen.queryByRole("button", { name: "High" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Extra High" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
  fireEvent.click(trigger);

  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      effort: "default",
    }),
  );

  expect(change).toHaveBeenCalledTimes(2);

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "OSS 120B" }));

  expect(
    within(screen.getByRole("region", { name: "Reasoning effort" })).getAllByRole("button"),
  ).toHaveLength(1);

  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search model" }), { key: "Escape" });

  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({ model: "oss-120b-medium", effort: "medium" }),
  );
});

it("does not save unchanged selections and keeps unknown stored models intact", () => {
  const change = vi.fn();

  render(
    <Harness change={change} initial={{ ...viberProfile.execution, model: "stored-model" }} />,
  );

  const trigger = screen.getByRole("combobox", { name: "Model" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Stored Model" }));
  fireEvent.click(trigger);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(trigger);

  fireEvent.blur(screen.getByRole("combobox", { name: "Search model" }), {
    relatedTarget: document.body,
  });

  expect(screen.queryByRole("listbox")).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

it("resolves existing CLI defaults to a real model and stores its concrete reasoning variant", () => {
  const change = vi.fn();

  render(
    <Harness
      change={change}
      initial={{ ...viberProfile.execution, provider: "antigravity", model: "", effort: "high" }}
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(trigger.textContent).toBe("Gemini 3.8 Flash High");
  fireEvent.click(trigger);
  expect(screen.queryByRole("option", { name: /default/i })).toBeNull();

  expect(
    screen.getByRole("option", { name: "Gemini 3.8 Flash" }).getAttribute("aria-selected"),
  ).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Low" }));
  fireEvent.click(trigger);

  expect(change).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      provider: "antigravity",
      model: "gemini-3.8-flash-low",
      effort: "low",
    }),
  );
});
