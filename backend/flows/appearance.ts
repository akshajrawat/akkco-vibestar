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

export const avatarPresets: { name: string; appearance: ViberAppearance }[] = [
  {
    name: "Planner",
    appearance: {
      ...base,
      shape: "triangle",
      accessory: "headphones",
      device: "laptop",
      eyes: "wide",
    },
  },
  {
    name: "Developer",
    appearance: {
      ...base,
      glasses: "square",
      eyebrows: "focused",
      device: "code-panel",
      accessory: "headphones",
    },
  },
  {
    name: "Reviewer",
    appearance: {
      ...base,
      color: avatarColors.Purple,
      glasses: "round",
      eyes: "focused",
      eyebrows: "raised",
    },
  },
  {
    name: "Tester",
    appearance: {
      ...base,
      color: avatarColors.Orange,
      accessory: "cap",
      device: "tablet",
      eyes: "curious",
    },
  },
  {
    name: "Analyst",
    appearance: {
      ...base,
      shape: "circle",
      color: avatarColors.Green,
      glasses: "oval",
      eyes: "wide",
    },
  },
  {
    name: "Researcher",
    appearance: {
      ...base,
      shape: "rounded-square",
      color: avatarColors.Pink,
      accessory: "wizard-hat",
      device: "phone",
      eyes: "sparkle",
    },
  },
];

export const defaultAppearance = (identity: string): ViberAppearance => {
  let hash = 0;
  for (const character of identity) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return { ...avatarPresets[hash % avatarPresets.length].appearance };
};

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
