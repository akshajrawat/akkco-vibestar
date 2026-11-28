// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  appearanceAccent,
  defaultAppearance,
  PixelAppearanceSchema,
  pixelAppearance,
  ViberAppearanceSchema,
  type PixelAppearance,
  type ViberAppearance,
} from "../../apps/core/vibers/appearance";
import { AgentProfileSchema } from "../../apps/core/vibers/contracts";
import {
  avatarGridSize,
  paintAvatar,
  type AvatarSample,
} from "../../apps/desktop/features/vibers/avatar-sprites";
import { CreateViberDialog } from "../../apps/desktop/features/vibers/CreateViberDialog";
import { viberProfile } from "../helpers/viber-fixtures";
import { mockDialog } from "../helpers/dialog";

const rpc = vi.fn();

const legacyAppearance = {
  version: 1,
  shape: "capsule",
  color: "#123aBc",
  device: "laptop",
  eyes: "wink",
  eyebrows: "sharp",
  glasses: "oversized",
  accessory: "headphones",
} satisfies ViberAppearance;

const atlasAppearance = {
  version: 2,
  face: "triangle",
  palette: "mint",
  customColor: "#34B98f",
  hair: "swoop",
  eyebrows: "focused",
  eyes: "wide",
  nose: "shine",
  mouth: "soft-smile",
  glasses: "none",
  headwear: "red-headset",
  neckwear: "striped-scarf",
  effect: "sparkles",
} satisfies ViberAppearance;

beforeEach(() => {
  mockDialog();
  rpc.mockResolvedValue({});
  Object.defineProperty(window, "vibestar", { configurable: true, value: { rpc } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  rpc.mockReset();
});

it("validates the current appearance and reads both older profile formats", () => {
  const base = defaultAppearance();
  for (const input of [
    { version: 4 },
    { shape: "unrecognized" },
    { nose: "unrecognized" },
    { color: "bad input" },
    { colors: { eyes: "bad input" } },
    { colors: { nonAvatarSlot: "#f3c3ff" } },
    { extra: true },
  ]) {
    expect(ViberAppearanceSchema.safeParse({ ...base, ...input }).success).toBe(false);
  }

  expect(ViberAppearanceSchema.parse(legacyAppearance)).toEqual(legacyAppearance);

  expect(pixelAppearance(legacyAppearance)).toMatchObject({
    shape: "bean",
    eyes: "wink",
    eyewear: "headset",
    color: "#123aBc",
  });

  expect(ViberAppearanceSchema.parse(atlasAppearance)).toEqual(atlasAppearance);

  expect(pixelAppearance(atlasAppearance)).toMatchObject({
    shape: "droplet",
    eyes: "wide",
    mouth: "smile",
    eyewear: "headset",
    neckwear: "scarf",
    extra: "sparkles",
    color: "#34B98f",
  });

  expect(
    pixelAppearance({
      ...atlasAppearance,
      eyes: "squeezed",
      mouth: "small-frown",
      headwear: "rainbow-beanie",
      effect: "little-hearts",
    }),
  ).toMatchObject({ eyes: "happy", mouth: "frown", headwear: "beanie", extra: "heart" });

  expect(
    pixelAppearance({ ...atlasAppearance, headwear: "vr-visor", effect: "none", detail: "glint" }),
  ).toMatchObject({ eyewear: "visor", extra: "sparkles" });

  expect(appearanceAccent(legacyAppearance)).toBe(legacyAppearance.color);
  expect(appearanceAccent(atlasAppearance)).toBe(atlasAppearance.customColor);
  expect(appearanceAccent(base)).toBe(base.color);
  expect(AgentProfileSchema.parse(viberProfile)).toEqual(viberProfile);

  expect(ViberAppearanceSchema.parse({ ...base, nose: "button" })).toEqual({
    ...base,
    nose: "button",
  });

  expect(pixelAppearance({ ...base, nose: "button" })).toEqual(base);

  expect(pixelAppearance(undefined, viberProfile.id)).toEqual(
    pixelAppearance(undefined, viberProfile.id),
  );
});

it("creates a Viber from a custom color, face parts and accessories chosen on separate tabs", async () => {
  const saved = vi.fn();

  render(
    <CreateViberDialog profile={{ ...viberProfile, revision: 0 }} saved={saved} close={vi.fn()} />,
  );

  expect(screen.getByRole("tab", { name: "Shapes" }).getAttribute("aria-selected")).toBe("true");

  const shapes = within(screen.getByRole("region", { name: "Base shapes" }));
  expect(shapes.getAllByRole("button")).toHaveLength(8);
  fireEvent.click(shapes.getByRole("button", { name: "Cloud" }));
  fireEvent.change(screen.getByLabelText("Custom color"), { target: { value: "#a7238f" } });
  fireEvent.click(shapes.getByRole("button", { name: "Droplet" }));
  expect((screen.getByLabelText("Custom color") as HTMLInputElement).value).toBe("#a7238f");

  fireEvent.click(screen.getByRole("tab", { name: "Face" }));
  expect(screen.queryByRole("region", { name: "Nose" })).toBeNull();

  fireEvent.click(
    within(screen.getByRole("region", { name: "Eyes" })).getByRole("button", { name: "Sparkle" }),
  );

  fireEvent.change(screen.getByLabelText("Eyes color"), { target: { value: "#09f3bb" } });

  fireEvent.click(
    within(screen.getByRole("region", { name: "Mouth" })).getByRole("button", { name: "Smile" }),
  );

  fireEvent.change(screen.getByLabelText("Mouth color"), { target: { value: "#a0b0f0" } });

  fireEvent.click(screen.getByRole("tab", { name: "Accessories" }));
  fireEvent.click(screen.getByRole("button", { name: "Crown" }));
  fireEvent.change(screen.getByLabelText("Head color"), { target: { value: "#fd0033" } });
  fireEvent.click(screen.getByRole("button", { name: "Round" }));
  fireEvent.click(screen.getByRole("button", { name: "Scarf" }));
  fireEvent.change(screen.getByLabelText("Neck color"), { target: { value: "#aabbcc" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset neck color" }));
  fireEvent.click(screen.getByRole("button", { name: "Sparkles" }));
  fireEvent.click(screen.getByRole("tab", { name: "Shapes" }));
  expect(screen.getByRole("button", { name: "Droplet" }).getAttribute("aria-pressed")).toBe("true");

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Viber" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Viber" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());

  expect(rpc).toHaveBeenCalledWith("profile.save", {
    expected_revision: null,
    profile: {
      ...viberProfile,
      name: "New Viber",
      appearance: {
        ...pixelAppearance(undefined, viberProfile.id),
        shape: "droplet",
        color: "#a7238f",
        eyes: "sparkle",
        mouth: "smile",
        headwear: "crown",
        eyewear: "round",
        neckwear: "scarf",
        extra: "sparkles",
        colors: { eyes: "#09f3bb", mouth: "#a0b0f0", headwear: "#fd0033" },
      },
    },
  });
});

it("randomizes the appearance from below the name without changing the name or submitting", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);

  const profile = {
    ...viberProfile,
    name: "My Viber",
    revision: 0,
    appearance: defaultAppearance(),
  };

  render(<CreateViberDialog profile={profile} saved={vi.fn()} close={vi.fn()} />);

  const name = screen.getByRole("textbox", { name: "Name" });
  const random = screen.getByRole("button", { name: "Random" });
  expect(name.closest("label")?.nextElementSibling).toBe(random);
  fireEvent.click(random);

  expect(screen.getByRole("img", { name: /#ffca58 droplet/ })).toBeTruthy();
  expect((name as HTMLInputElement).value).toBe("My Viber");
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  { kind: "a version 1 appearance", appearance: legacyAppearance },
  { kind: "a version 2 appearance", appearance: atlasAppearance },
  {
    kind: "an older version 3 appearance",
    appearance: { ...defaultAppearance(), nose: "button" } as const,
  },
  { kind: "an absent appearance", appearance: undefined },
])(
  "preserves $kind on ordinary edit and saves the chosen parts on appearance edit",
  async ({ appearance }) => {
    const original = { ...viberProfile, appearance, description: "Existing profile summary" };
    const saved = vi.fn();
    const close = vi.fn();
    const dialog = render(<CreateViberDialog profile={original} saved={saved} close={close} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed Viber" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0][0]).toEqual({ ...original, revision: 2, name: "Renamed Viber" });

    dialog.unmount();
    render(<CreateViberDialog profile={saved.mock.calls[0][0]} saved={saved} close={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Tall" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));

    expect(saved.mock.calls[1][0]).toEqual({
      ...original,
      name: "Renamed Viber",
      revision: 3,
      appearance: { ...pixelAppearance(appearance, original.id), shape: "tall" },
    });
  },
);

it("uses keyboard tab navigation and protects appearance edits after save failure", async () => {
  rpc.mockRejectedValue(new Error("Profile changed. Reload before saving."));
  const close = vi.fn();

  render(<CreateViberDialog profile={viberProfile} saved={vi.fn()} close={close} />);

  const shape = screen.getByRole("tab", { name: "Shapes" });
  fireEvent.keyDown(shape, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Accessories" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Face" }));

  fireEvent.click(
    within(screen.getByRole("region", { name: "Eyes" })).getByRole("button", { name: "Wink" }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const confirm = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Profile changed. Reload before saving.");
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("img", { name: /wink eyes/ })).toBeTruthy();
});

const drawnPixels = (appearance: PixelAppearance, sample?: AvatarSample) => {
  const pixels = new Map<string, string>();

  const context = {
    fillStyle: "",
    clearRect: vi.fn(),
    fillRect(x: number, y: number, width: number, height: number) {
      expect([x, y, width, height].every(Number.isInteger)).toBe(true);

      expect(x >= 0 && y >= 0 && x + width <= avatarGridSize && y + height <= avatarGridSize).toBe(
        true,
      );

      for (let row = y; row < y + height; row++) {
        for (let column = x; column < x + width; column++) {
          pixels.set(`${column},${row}`, this.fillStyle);
        }
      }
    },
  };

  paintAvatar(context as unknown as CanvasRenderingContext2D, appearance, sample);
  expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, avatarGridSize, avatarGridSize);
  return pixels;
};

it.each(PixelAppearanceSchema.shape.shape.options)(
  "renders every face part and accessory for the %s shape and keeps facial features within its outline",
  (shape) => {
    const appearance = {
      ...defaultAppearance(),
      shape,
      color: "#28ac97",
      eyes: "none",
      mouth: "none",
    } as const;

    const base = drawnPixels(appearance);
    expect([...base.values()]).toContain(appearance.color);
    expect(drawnPixels({ ...appearance, eyes: "wink" }, "shape")).toEqual(base);

    for (const part of ["eyes", "mouth", "headwear", "eyewear", "neckwear", "extra"] as const) {
      for (const value of PixelAppearanceSchema.shape[part].options) {
        if (value === "none") {
          continue;
        }

        const selected = { ...appearance, [part]: value };
        const image = drawnPixels(selected);
        const changed = [...image.keys()].filter((pixel) => image.get(pixel) !== base.get(pixel));
        expect(changed.length).toBeGreaterThan(0);
        expect(drawnPixels(selected, part).size).toBeGreaterThan(0);

        if (part === "eyes" || part === "mouth") {
          expect(changed.every((pixel) => base.has(pixel) && base.get(pixel) !== "#120b1c")).toBe(
            true,
          );
        }
      }
    }
  },
);

it("preserves the two lobes and the gap beneath the double blob", () => {
  const base = drawnPixels({ ...defaultAppearance(), shape: "double-blob" }, "shape");
  expect(base.has("9,10")).toBe(true);
  expect(base.has("22,10")).toBe(true);
  expect(base.has("16,10")).toBe(false);
  expect(base.has("16,25")).toBe(false);
  expect(base.has("16,20")).toBe(true);
});
