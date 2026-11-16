// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ViberAppearanceSchema,
  defaultAppearance,
  randomAppearance,
} from "../../backend/flows/appearance";
import { AgentProfileSchema } from "../../backend/flows/contracts";
import { ProfileEditor } from "../../src/features/flows/ProfileEditor";
import { ViberFace } from "../../src/features/flows/ViberFace";
import { viberProfile } from "../workspace/flow-fixtures";
import { mockDialog } from "../helpers/dialog";

const rpc = vi.fn();

beforeEach(() => {
  mockDialog();
  rpc.mockImplementation(async (method: string) => (method === "providers.detect" ? [] : {}));
  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("validates every layer option and rejects unsupported versions, unknown parts and invalid colors", () => {
  const base = defaultAppearance();
  for (const [key, value] of Object.entries(ViberAppearanceSchema.shape)) {
    const field = key === "lips" ? ViberAppearanceSchema.shape.lips.unwrap() : value;
    if (!("options" in field)) continue;
    for (const option of field.options) {
      const appearance = ViberAppearanceSchema.parse({ ...base, [key]: option });
      const markup = renderToStaticMarkup(<ViberFace appearance={appearance} />);
      expect(markup).toContain('viewBox="0 0 160 160"');
      expect(markup).not.toMatch(/NaN|undefined/);
    }
  }

  for (const input of [
    { version: 2 },
    { eyes: "unrecognized" },
    { lips: "unrecognized" },
    { color: "red" },
    { color: "#abc" },
    { extra: true },
  ])
    expect(ViberAppearanceSchema.safeParse({ ...base, ...input }).success).toBe(false);
  expect(AgentProfileSchema.parse(viberProfile)).toEqual(viberProfile);
  expect(defaultAppearance()).toEqual(defaultAppearance());
  expect(viberProfile.appearance).toBeUndefined();
  for (let index = 0; index < 30; index++)
    expect(ViberAppearanceSchema.safeParse(randomAppearance()).success).toBe(true);
});

it("keeps appearance selections across categories and saves customizations using the existing revision API", async () => {
  const saved = vi.fn();
  const close = vi.fn();
  render(<ProfileEditor profile={viberProfile} saved={saved} close={close} />);
  expect(screen.queryByRole("region", { name: "Preset Vibers" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Shape" }));
  fireEvent.click(screen.getByRole("button", { name: "Diamond" }));
  fireEvent.click(screen.getByRole("tab", { name: "Lips" }));
  fireEvent.click(screen.getByRole("button", { name: "Grin" }));
  fireEvent.click(screen.getByRole("tab", { name: "Color" }));
  fireEvent.change(screen.getByLabelText("Custom HEX"), { target: { value: "#123abc" } });
  fireEvent.click(screen.getByRole("tab", { name: "Eyes" }));
  expect(screen.queryByRole("button", { name: "Diamond" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Wink" }));
  fireEvent.click(screen.getByRole("tab", { name: "Shape" }));

  expect(screen.getByRole("button", { name: "Diamond" }).getAttribute("aria-pressed")).toBe("true");

  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "An independent developer." },
  });

  fireEvent.click(screen.getByRole("button", { name: "Save Viber" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());

  expect(rpc).toHaveBeenCalledWith("profile.save", {
    expected_revision: viberProfile.revision,
    profile: {
      ...viberProfile,
      revision: viberProfile.revision + 1,
      description: "An independent developer.",
      appearance: {
        ...defaultAppearance(),
        shape: "diamond",
        color: "#123abc",
        eyes: "wink",
        lips: "grin",
      },
    },
  });

  expect(close).toHaveBeenCalledOnce();
});

it("protects appearance-only edits, validates custom color drafts and retains drafts after a failed save", async () => {
  rpc.mockRejectedValue(new Error("Profile changed. Reload before saving."));
  const close = vi.fn();

  render(
    <ProfileEditor profile={{ ...viberProfile, revision: 0 }} saved={vi.fn()} close={close} />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Color" }));
  fireEvent.change(screen.getByLabelText("Custom HEX"), { target: { value: "#nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Viber" }));
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const confirm = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Custom HEX") as HTMLInputElement).value).toBe("#nope");
  fireEvent.change(screen.getByLabelText("Custom HEX"), { target: { value: "#123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Viber" }));
  await screen.findByText("Profile changed. Reload before saving.");
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Custom HEX") as HTMLInputElement).value).toBe("#123456");
});
