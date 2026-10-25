// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseLabelInput } from "../../src/lib/issue-watch/labels";
import { LabelExclusions } from "../../src/components/issue-watch/LabelExclusions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const link =
  "https://github.com/oppia/oppia/issues?q=state%3Aopen%20label%3A%22triage%20needed%22";
it("decodes exact labels from Markdown, encoded GitHub search, plain names and multiple URL lines", () => {
  expect(parseLabelInput(`[triage needed](${link})`, "oppia/oppia")).toEqual([
    "triage needed",
  ]);
  expect(parseLabelInput("area: tests", "oppia/oppia")).toEqual([
    "area: tests",
  ]);
  expect(() => parseLabelInput(link + "%ZZ", "oppia/oppia")).toThrow(
    "malformed",
  );
  expect(() =>
    parseLabelInput("www.example.com/label", "oppia/oppia"),
  ).toThrow();
  expect(
    parseLabelInput(
      link + "\nhelp wanted, bug",
      "https://github.com/oppia/oppia",
    ),
  ).toEqual(["triage needed", "help wanted", "bug"]);
  for (const input of [
    link.replace("oppia/oppia", "other/repo"),
    "https://example.com/oppia/oppia/issues?q=label:bug",
    "javascript:alert(1)",
    "<img src=x onerror=alert(1)>",
    "https://github.com/oppia/oppia/issues?q=state:open",
  ])
    expect(() => parseLabelInput(input, "oppia/oppia")).toThrow();
});
it("supports pasted and URI-dropped links as removable text chips and loads official label suggestions without scans", async () => {
  const rpc = vi.fn().mockResolvedValue(["bug", "help wanted"]);
  Object.defineProperty(window, "vibestar", {
    configurable: true,
    value: { rpc },
  });
  const Control = () => {
    const [labels, setLabels] = useState<string[]>([]);
    return (
      <LabelExclusions
        repository="oppia/oppia"
        labels={labels}
        change={setLabels}
      />
    );
  };
  render(<Control />);
  fireEvent.paste(screen.getByLabelText("Excluded labels"), {
    clipboardData: { getData: () => `[triage needed](${link})` },
  });
  expect(
    screen.getByRole("button", { name: "Remove label triage needed" }),
  ).toBeTruthy();
  fireEvent.drop(screen.getByRole("region", { name: "Label exclusions" }), {
    dataTransfer: {
      getData: (type: string) =>
        type === "text/uri-list" ? link.replace("triage%20needed", "bug") : "",
    },
  });
  expect(screen.getByRole("button", { name: "Remove label bug" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove label triage needed" }),
  );
  expect(
    screen.queryByRole("button", { name: "Remove label triage needed" }),
  ).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Find GitHub labels" }));
  await vi.waitFor(() =>
    expect(document.querySelector('option[value="help wanted"]')).toBeTruthy(),
  );
  expect(rpc).toHaveBeenCalledExactlyOnceWith("issueWatch.labels", {
    repository: "oppia/oppia",
  });
});
