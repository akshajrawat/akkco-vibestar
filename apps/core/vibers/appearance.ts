import { z } from "zod";

export const ViberAppearanceSchema = z
  .object({
    version: z.literal(1),
    shape: z.enum([
      "circle",
      "rounded-square",
      "triangle",
      "hexagon",
      "diamond",
      "capsule",
      "rectangle",
    ]),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit HEX color, such as #2478ff."),
    device: z.enum(["laptop", "phone", "tablet", "monitor", "code-panel", "none"]),
    eyes: z.enum([
      "neutral",
      "happy",
      "focused",
      "wide",
      "sparkle",
      "closed",
      "sleepy",
      "curious",
      "wink",
      "concerned",
    ]),
    eyebrows: z.enum([
      "none",
      "calm",
      "raised",
      "angry",
      "focused",
      "concerned",
      "playful",
      "sharp",
    ]),
    glasses: z.enum(["none", "round", "square", "oval", "oversized"]),
    lips: z.enum(["none", "smile", "grin", "neutral", "open", "pout", "surprised"]).optional(),
    accessory: z.enum([
      "headphones",
      "cap",
      "beanie",
      "crown",
      "wizard-hat",
      "sparkle",
      "badge",
      "none",
    ]),
  })
  .strict();

export type ViberAppearance = z.infer<typeof ViberAppearanceSchema>;

export const avatarColors = {
  Blue: "#2478ff",
  Purple: "#9b5cff",
  Green: "#2fc77b",
  Yellow: "#f6c84a",
  Orange: "#ff983e",
  Pink: "#ec64a5",
  Red: "#ef5269",
  Teal: "#19c6ce",
  Gray: "#8998b1",
} as const;

const base: ViberAppearance = {
  version: 1,
  shape: "hexagon",
  color: avatarColors.Blue,
  device: "none",
  eyes: "neutral",
  eyebrows: "none",
  glasses: "none",
  accessory: "none",
};

export const defaultAppearance = (): ViberAppearance => ({ ...base });

export const randomAppearance = (): ViberAppearance => {
  const pick = <T>(options: readonly T[]): T => options[Math.floor(Math.random() * options.length)];
  const fields = ViberAppearanceSchema.shape;
  return {
    version: 1,
    shape: pick(fields.shape.options),
    color: pick(Object.values(avatarColors)),
    device: pick(fields.device.options),
    eyes: pick(fields.eyes.options),
    eyebrows: pick(fields.eyebrows.options),
    glasses: pick(fields.glasses.options),
    accessory: pick(fields.accessory.options),
    lips: pick(fields.lips.unwrap().options),
  };
};

export const builtInProfiles = {
  planner: "e1bc5ab8-3a96-4d53-96c5-3103cf484501",
  refiner: "e1bc5ab8-3a96-4d53-96c5-3103cf484502",
  implementer: "e1bc5ab8-3a96-4d53-96c5-3103cf484503",
  reviewer: "e1bc5ab8-3a96-4d53-96c5-3103cf484504",
} as const;

export const isCustomViber = (profile: { id: string }): boolean =>
  !Object.values(builtInProfiles).includes(
    profile.id as (typeof builtInProfiles)[keyof typeof builtInProfiles],
  );
