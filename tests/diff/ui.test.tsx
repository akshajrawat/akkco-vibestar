// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DiffView } from "../../apps/desktop/components/diff/DiffView";
import type { FileDiff } from "../../apps/desktop/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const file: FileDiff = {
  original: "const value = 1;\n",
  modified: "const value = 2;\n",
  binary: false,
  unified: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n",
};

it("renders numbered unified and split changes with inert syntax tokens", () => {
  const ui = render(<DiffView file={file} path="src/example.ts" mode="unified" />);

  expect(
    ui.container.querySelector('.diff-code[data-side="working"][data-line="1"]')?.textContent,
  ).toBe("const value = 2;");

  expect(ui.container.querySelector(".syntax-keyword")?.textContent).toBe("const");
  ui.rerender(<DiffView file={file} path="src/example.ts" mode="side" />);
  expect(screen.getByRole("columnheader", { name: "Base" })).toBeTruthy();

  expect(
    ui.container.querySelector('.diff-code[data-side="base"][data-line="1"]')?.textContent,
  ).toBe("const value = 1;");

  const html = '<img src=x onerror="alert(1)">';

  ui.rerender(
    <DiffView
      file={{
        original: "",
        modified: html,
        binary: false,
        unified: `@@ -0,0 +1 @@\n+${html}\n`,
      }}
      path="index.html"
      mode="side"
    />,
  );

  expect(ui.container.querySelector("img")).toBeNull();
  expect(ui.container.querySelector('.diff-code[data-side="working"]')?.textContent).toBe(html);
});

it("reveals and folds verified unchanged context with the correct line numbers", () => {
  const prefix = Array.from({ length: 10 }, (_, index) => `prefix ${index + 1}`).join("\n") + "\n";

  const ui = render(
    <DiffView
      file={{
        original: prefix + "old\ntail\n",
        modified: prefix + "new\ntail\n",
        binary: false,
        unified: "@@ -11 +11 @@\n-old\n+new\n",
      }}
      path="file.txt"
      mode="unified"
    />,
  );

  expect(screen.queryByText("prefix 3")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 10 of 10 unchanged lines" }));
  expect(ui.container.querySelector('.diff-code[data-line="3"]')?.textContent).toBe("prefix 3");
  fireEvent.click(screen.getByRole("button", { name: "Fold 10 unchanged lines" }));
  expect(screen.queryByText("prefix 3")).toBeNull();
});

it("keeps binary, oversized, unmappable and metadata-only states explicit", () => {
  const ui = render(<DiffView file={{ ...file, binary: true }} path="image.bin" mode="side" />);
  expect(screen.getByText("Binary file. Review it in your editor.")).toBeTruthy();

  ui.rerender(
    <DiffView file={{ ...file, unified: "+".repeat(750001) }} path="large.ts" mode="side" />,
  );

  expect(screen.getByText(/exceeds the interactive view limit/)).toBeTruthy();
  expect(ui.container.querySelector("table")).toBeNull();

  ui.rerender(
    <DiffView file={{ ...file, unified: "malformed patch" }} path="file.ts" mode="unified" />,
  );

  expect(screen.getByText(/no reliable hunk mappings/)).toBeTruthy();
  expect(screen.getByText("malformed patch")).toBeTruthy();

  ui.rerender(
    <DiffView
      file={{
        ...file,
        modified: file.original,
        unified: "diff --git a/old b/new\nrename from old\nrename to new\n",
      }}
      path="new.ts"
      mode="unified"
    />,
  );

  expect(screen.getByText(/File identity or permissions may have changed/)).toBeTruthy();
});
