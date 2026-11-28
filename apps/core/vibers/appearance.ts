import { z } from "zod";
import {
  detailOptions,
  effectOptions,
  eyesOptions,
  eyebrowsOptions,
  legacyShapeOptions,
  glassesOptions,
  headwearOptions,
  mouthOptions,
  neckwearOptions,
  propOptions,
} from "./avatar-catalog";

const LegacyAppearanceSchema = z
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

export const avatarPalette = {
  sky: "#4899f1",
  lilac: "#ae77f1",
  aqua: "#29cfcd",
  mint: "#63d97a",
  honey: "#ffca58",
  peach: "#ff986a",
  rose: "#f680b9",
  slate: "#8f9ec4",
  stone: "#646480",
  sand: "#e4b380",
  cloud: "#aebff3",
  lime: "#98e749",
} as const;

export const avatarColorChoices = ["lilac", "sky", "mint", "honey", "rose", "cloud"] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const PartColorsSchema = z
  .strictObject({
    eyes: hexColor,
    mouth: hexColor,
    headwear: hexColor,
    eyewear: hexColor,
    neckwear: hexColor,
    extra: hexColor,
  })
  .partial();

export type AvatarPart = keyof z.infer<typeof PartColorsSchema>;

const AtlasAppearanceSchema = z.strictObject({
  version: z.literal(2),
  face: z.enum(legacyShapeOptions),
  palette: z.enum(Object.keys(avatarPalette) as (keyof typeof avatarPalette)[]),
  hair: z.enum(["none", "swoop", "tuft", "fringe", "curls"]),
  eyebrows: z.enum(eyebrowsOptions),
  eyes: z.enum(eyesOptions),
  mouth: z.enum(mouthOptions),
  glasses: z.enum(glassesOptions),
  headwear: z.enum(headwearOptions),
  customColor: hexColor.optional(),
  nose: z.enum(["none", "dot", "button", "shine"]).optional(),
  detail: z.enum(detailOptions).optional(),
  neckwear: z.enum(neckwearOptions).optional(),
  prop: z.enum(propOptions).optional(),
  effect: z.enum(effectOptions).optional(),
});

export const PixelAppearanceSchema = z.strictObject({
  version: z.literal(3),
  shape: z.enum(["round", "gumdrop", "bean", "cloud", "droplet", "pebble", "tall", "double-blob"]),
  color: hexColor,
  colors: PartColorsSchema.optional(),
  eyes: z.enum(["none", "bright", "dot", "happy", "flat", "wink", "wide", "sparkle", "sleepy"]),
  nose: z.enum(["none", "dot", "dash", "button", "triangle"]).optional(),
  mouth: z.enum(["none", "smile", "grin", "flat", "surprised", "wavy", "tongue", "frown"]),
  headwear: z.enum(["none", "sprout", "cap", "beanie", "halo", "crown", "bow"]),
  eyewear: z.enum(["none", "round", "square", "visor", "eye-patch", "headset", "monocle"]),
  neckwear: z.enum(["none", "scarf", "tie", "bow-tie", "pendant", "collar"]),
  extra: z.enum(["none", "blush", "sparkles", "heart", "chat", "stars", "orbit"]),
});

export const ViberAppearanceSchema = z.discriminatedUnion("version", [
  LegacyAppearanceSchema,
  AtlasAppearanceSchema,
  PixelAppearanceSchema,
]);

export type ViberAppearance = z.infer<typeof ViberAppearanceSchema>;
export type PixelAppearance = z.infer<typeof PixelAppearanceSchema>;

type LegacyAppearance = z.infer<typeof LegacyAppearanceSchema>;

type AtlasAppearance = z.infer<typeof AtlasAppearanceSchema>;

export const defaultAppearance = (): PixelAppearance => ({
  version: 3,
  shape: "round",
  color: avatarPalette.lilac,
  eyes: "bright",
  mouth: "grin",
  headwear: "none",
  eyewear: "none",
  neckwear: "none",
  extra: "none",
});

const originalShapes: Record<LegacyAppearance["shape"], PixelAppearance["shape"]> = {
  circle: "round",
  "rounded-square": "pebble",
  triangle: "droplet",
  hexagon: "gumdrop",
  diamond: "droplet",
  capsule: "bean",
  rectangle: "tall",
};

const atlasShapes: Record<AtlasAppearance["face"], PixelAppearance["shape"]> = {
  round: "round",
  gumdrop: "gumdrop",
  droplet: "droplet",
  triangle: "droplet",
  cloud: "cloud",
  splat: "cloud",
  bean: "bean",
  pebble: "pebble",
  orb: "round",
  puff: "cloud",
  tall: "tall",
  "double-blob": "double-blob",
  star: "cloud",
  heart: "bean",
  block: "pebble",
  ring: "round",
};

const atlasEyes: Partial<Record<AtlasAppearance["eyes"], PixelAppearance["eyes"]>> = {
  short: "dot",
  squeezed: "happy",
  focused: "flat",
  glossy: "bright",
};

const atlasMouths: Partial<Record<AtlasAppearance["mouth"], PixelAppearance["mouth"]>> = {
  "soft-smile": "smile",
  laugh: "grin",
  dot: "surprised",
  zigzag: "wavy",
  "small-frown": "frown",
  tease: "tongue",
};

const atlasHeadwear: Partial<Record<AtlasAppearance["headwear"], PixelAppearance["headwear"]>> = {
  "rainbow-beanie": "beanie",
  "backwards-cap": "cap",
  beret: "cap",
  "bucket-hat": "cap",
  "small-crown": "crown",
  "royal-crown": "crown",
  tiara: "crown",
  circlet: "halo",
  leaf: "sprout",
  clover: "sprout",
  flower: "sprout",
  sunflower: "sprout",
};

const atlasEffects: Partial<
  Record<NonNullable<AtlasAppearance["effect"]>, PixelAppearance["extra"]>
> = {
  "little-hearts": "heart",
  ellipsis: "chat",
  rays: "sparkles",
  leaves: "sparkles",
};

const atlasDetails: Partial<
  Record<NonNullable<AtlasAppearance["detail"]>, PixelAppearance["extra"]>
> = {
  blush: "blush",
  slashes: "blush",
  sparkle: "sparkles",
  star: "stars",
  glint: "sparkles",
  shine: "sparkles",
  rays: "sparkles",
};

const fields = PixelAppearanceSchema.shape;

const expressions = [
  { eyes: "bright", mouth: "grin" },
  { eyes: "happy", mouth: "tongue" },
  { eyes: "wink", mouth: "smile" },
  { eyes: "wide", mouth: "surprised" },
  { eyes: "sleepy", mouth: "flat" },
  { eyes: "dot", mouth: "smile" },
  { eyes: "sparkle", mouth: "grin" },
] as const;

export const randomAppearance = (): PixelAppearance => {
  const pick = <T>(options: readonly T[]) => options[Math.floor(Math.random() * options.length)];
  const accessory = pick(["headwear", "eyewear", "neckwear", "extra"] as const);

  return {
    ...defaultAppearance(),
    shape: pick(fields.shape.options),
    color: avatarPalette[pick(avatarColorChoices)],
    ...pick(expressions),
    [accessory]: pick(fields[accessory].options),
  };
};

export const pixelAppearance = (
  appearance?: ViberAppearance,
  profileId?: string,
): PixelAppearance => {
  if (appearance?.version === 3) {
    if (appearance.nose === undefined) {
      return appearance;
    }

    const current = { ...appearance };
    delete current.nose;
    return current;
  }

  const base = defaultAppearance();

  if (appearance?.version === 2) {
    const { eyes, mouth, headwear, glasses, neckwear, effect, detail } = appearance;
    const parsedEyes = fields.eyes.safeParse(eyes);
    const parsedMouth = fields.mouth.safeParse(mouth);
    const parsedHeadwear = fields.headwear.safeParse(headwear);
    const eyewear = fields.eyewear.safeParse(glasses);
    const parsedExtra = fields.extra.safeParse(effect);
    return {
      ...base,
      shape: atlasShapes[appearance.face],
      color: appearance.customColor ?? avatarPalette[appearance.palette],
      eyes: parsedEyes.success ? parsedEyes.data : (atlasEyes[eyes] ?? "wide"),
      mouth: parsedMouth.success ? parsedMouth.data : (atlasMouths[mouth] ?? "flat"),
      headwear: parsedHeadwear.success ? parsedHeadwear.data : (atlasHeadwear[headwear] ?? "none"),
      eyewear:
        headwear.includes("headset") || headwear.includes("headphones")
          ? "headset"
          : headwear.endsWith("-visor") || !eyewear.success
            ? "visor"
            : eyewear.data,
      neckwear:
        neckwear === "striped-scarf"
          ? "scarf"
          : neckwear === "pink-bow"
            ? "bow-tie"
            : (neckwear ?? "none"),
      extra:
        parsedExtra.success && parsedExtra.data !== "none"
          ? parsedExtra.data
          : ((effect && atlasEffects[effect]) ?? (detail && atlasDetails[detail]) ?? "none"),
    };
  }

  if (appearance?.version === 1) {
    const { shape, color, eyes, lips, glasses, accessory } = appearance;
    const parsedEyes = fields.eyes.safeParse(eyes);
    const parsedMouth = fields.mouth.safeParse(lips);
    const headwear = fields.headwear.safeParse(accessory);
    return {
      ...base,
      shape: originalShapes[shape],
      color,
      eyes: parsedEyes.success ? parsedEyes.data : eyes === "closed" ? "sleepy" : "bright",
      mouth: parsedMouth.success
        ? parsedMouth.data
        : lips === "open"
          ? "surprised"
          : lips
            ? "flat"
            : "none",
      headwear: headwear.success ? headwear.data : "none",
      eyewear:
        accessory === "headphones"
          ? "headset"
          : glasses === "oval"
            ? "round"
            : glasses === "oversized"
              ? "square"
              : glasses,
      extra: accessory === "sparkle" ? "sparkles" : "none",
    };
  }

  if (!profileId) {
    return base;
  }

  let seed = 0;
  for (const character of profileId) {
    seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  }

  const colors = Object.values(avatarPalette);
  return {
    ...base,
    shape: fields.shape.options[Math.floor(seed / colors.length) % fields.shape.options.length],
    color: colors[seed % colors.length],
  };
};

export const appearanceAccent = (appearance?: ViberAppearance) => {
  if (appearance?.version === 2) {
    return appearance.customColor ?? avatarPalette[appearance.palette];
  }

  return appearance?.color ?? "#2478ff";
};
