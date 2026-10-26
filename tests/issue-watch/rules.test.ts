import { it, expect } from "vitest";

import {
  confirmConfiguration,
  previewRules,
  repositoryName,
} from "../../backend/issue-watch/rules";
import { watchConfiguration } from "./fixtures";

it("previews the exact Oppia scenario without a model and requires unresolved decisions", () => {
  const prompt =
    "Watch for open issues that are not triage needed and are not present in https://github.com/oppia/oppia/issues/27409. Make sure I can reasonably request assignment and no other contributor has already claimed them. Prefer actionable, well-scoped issues.";

  const preview = previewRules({
    repository: "https://github.com/Oppia/Oppia",
    prompt,
  });

  expect(preview.rules).toMatchObject({
    open_only: true,
    exclude_pull_requests: true,
    excluded_labels: ["triage needed"],
    trackers: [{ url: "https://github.com/oppia/oppia/issues/27409", comments: "none" }],
    unassigned_only: true,
  });

  expect(preview.preferences).toContain("well-scoped");
  const configuration = watchConfiguration(prompt);
  expect(confirmConfiguration("oppia/oppia", configuration).digest).toBe(preview.digest);

  expect(() =>
    confirmConfiguration("oppia/oppia", {
      ...configuration,
      ambiguity_decisions: [],
    }),
  ).toThrow("Confirm every");

  expect(() =>
    confirmConfiguration("oppia/oppia", {
      ...configuration,
      prompt: "Changed",
    }),
  ).toThrow("Preview");
});

it("distinguishes explicit bans, tracker proposals and bare references", () => {
  const preview = previewRules({
    repository: "oppia/oppia",
    prompt: "Exclude issue #12; not included in #27409. Consider #15, not difficult tasks.",
    controls: {
      excluded_labels: ["Needs Triage"],
      trackers: [
        {
          url: "https://github.com/Other/Repo/issues/1?x=1#comment",
          comments: "all",
        },
      ],
    },
  });

  expect(preview.rules.excluded_issues).toEqual([{ repository: "oppia/oppia", number: 12 }]);

  expect(preview.rules.trackers).toEqual([
    { url: "https://github.com/oppia/oppia/issues/27409", comments: "none" },
    { url: "https://github.com/other/repo/issues/1", comments: "all" },
  ]);

  expect(preview.ambiguities.some((item) => item.text === "#15")).toBe(true);
  expect(preview.ambiguities.some((item) => item.id === "remaining-requirements")).toBe(true);
  expect(preview.rules.excluded_labels).toEqual(["needs triage"]);
});

it.each([
  "https://evil.test/a/b",
  "https://user@github.com/a/b",
  "https://github.com:8443/a/b",
  "https://github.com/a/b/issues/1",
  "a/../b",
  "git@github.com:a/b",
])("rejects unsupported repository identity %s", (value) => {
  expect(() => repositoryName(value)).toThrow();
});
