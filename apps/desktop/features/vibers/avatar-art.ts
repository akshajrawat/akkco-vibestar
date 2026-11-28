import type { AvatarPart, PixelAppearance } from "../../../core/vibers/appearance";

type Point = readonly [x: number, y: number];

type Row = readonly [left: number, right: number, secondLeft?: number, secondRight?: number];

type Span = readonly [left: number, right: number, y: number];

type Body = {
  top: number;
  rows: readonly Row[];
  shine: Point;
  eyes: Span;
  mouth: Point;
  head: readonly [x: number, y: number, hatWidth: number];
  sides: Span;
  neck: Span;
  extra: Point;
};

// Each row has inclusive pixel bounds. Split runs preserve the clefts of the double blob.
export const bodies: Record<PixelAppearance["shape"], Body> = {
  round: {
    top: 7,
    rows: [
      [12, 19],
      [10, 21],
      [8, 23],
      [7, 24],
      [6, 25],
      [5, 26],
      [5, 26],
      [4, 27],
      [4, 27],
      [4, 27],
      [4, 27],
      [4, 27],
      [5, 26],
      [5, 26],
      [6, 25],
      [7, 24],
      [8, 23],
      [9, 22],
      [11, 20],
      [13, 18],
    ],
    shine: [10, 10],
    eyes: [11, 20, 16],
    mouth: [16, 20],
    head: [16, 9, 17],
    sides: [5, 26, 16],
    neck: [6, 25, 23],
    extra: [26, 6],
  },
  gumdrop: {
    top: 8,
    rows: [
      [13, 18],
      [11, 20],
      [9, 22],
      [8, 23],
      [7, 24],
      [7, 24],
      [6, 25],
      [6, 25],
      [5, 26],
      [5, 26],
      [4, 27],
      [4, 27],
      [3, 28],
      [3, 28],
      [3, 28],
      [4, 27],
      [5, 26],
      [7, 24],
      [9, 22],
    ],
    shine: [10, 11],
    eyes: [11, 20, 16],
    mouth: [16, 20],
    head: [16, 10, 16],
    sides: [6, 25, 16],
    neck: [4, 27, 23],
    extra: [26, 7],
  },
  bean: {
    top: 10,
    rows: [
      [20, 24],
      [7, 12, 18, 26],
      [5, 27],
      [4, 28],
      [3, 28],
      [3, 28],
      [3, 28],
      [3, 28],
      [3, 27],
      [4, 27],
      [4, 26],
      [5, 25],
      [6, 24],
      [7, 23],
      [9, 22],
      [11, 20],
      [13, 18],
    ],
    shine: [8, 13],
    eyes: [10, 19, 17],
    mouth: [15, 21],
    head: [22, 12, 15],
    sides: [4, 27, 16],
    neck: [6, 25, 23],
    extra: [7, 6],
  },
  cloud: {
    top: 8,
    rows: [
      [13, 17],
      [11, 20],
      [10, 21],
      [9, 22],
      [8, 24],
      [6, 26],
      [5, 27],
      [5, 27],
      [4, 28],
      [3, 29],
      [2, 29],
      [2, 30],
      [2, 30],
      [2, 30],
      [2, 29],
      [3, 28],
      [4, 28],
      [5, 26],
      [12, 22],
      [14, 20],
    ],
    shine: [12, 11],
    eyes: [12, 21, 17],
    mouth: [17, 21],
    head: [16, 10, 16],
    sides: [4, 28, 18],
    neck: [3, 29, 24],
    extra: [26, 7],
  },
  droplet: {
    top: 5,
    rows: [
      [15, 15],
      [15, 16],
      [14, 16],
      [14, 17],
      [13, 18],
      [12, 19],
      [12, 20],
      [11, 20],
      [10, 21],
      [9, 22],
      [8, 23],
      [7, 24],
      [6, 25],
      [5, 26],
      [5, 26],
      [5, 26],
      [5, 26],
      [6, 25],
      [7, 24],
      [8, 23],
      [9, 22],
      [11, 20],
      [13, 18],
    ],
    shine: [12, 13],
    eyes: [12, 20, 17],
    mouth: [16, 21],
    head: [15, 8, 13],
    sides: [6, 25, 18],
    neck: [6, 25, 24],
    extra: [25, 8],
  },
  pebble: {
    top: 11,
    rows: [
      [10, 21],
      [8, 23],
      [6, 25],
      [5, 26],
      [4, 27],
      [3, 28],
      [3, 28],
      [2, 29],
      [2, 29],
      [2, 29],
      [3, 28],
      [3, 28],
      [4, 27],
      [5, 26],
      [7, 24],
      [9, 22],
    ],
    shine: [8, 14],
    eyes: [11, 20, 17],
    mouth: [16, 21],
    head: [16, 13, 18],
    sides: [4, 27, 17],
    neck: [4, 27, 24],
    extra: [27, 7],
  },
  tall: {
    top: 5,
    rows: [
      [13, 18],
      [11, 20],
      [10, 21],
      [9, 22],
      [8, 23],
      [8, 23],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [7, 24],
      [8, 23],
      [8, 23],
      [9, 22],
      [10, 21],
      [11, 20],
      [12, 19],
      [14, 17],
    ],
    shine: [12, 8],
    eyes: [12, 19, 15],
    mouth: [16, 20],
    head: [16, 7, 13],
    sides: [7, 24, 15],
    neck: [8, 23, 23],
    extra: [26, 6],
  },
  "double-blob": {
    top: 10,
    rows: [
      [7, 11, 20, 24],
      [5, 13, 18, 26],
      [4, 14, 17, 27],
      [3, 28],
      [3, 28],
      [2, 29],
      [2, 29],
      [2, 29],
      [2, 29],
      [2, 29],
      [2, 29],
      [2, 29],
      [3, 28],
      [3, 28],
      [4, 27],
      [5, 12, 19, 26],
      [7, 10, 21, 24],
    ],
    shine: [7, 13],
    eyes: [10, 21, 16],
    mouth: [16, 20],
    head: [22, 12, 14],
    sides: [3, 28, 17],
    neck: [4, 27, 23],
    extra: [6, 6],
  },
};

type Sprites<Part extends AvatarPart> = Record<Exclude<PixelAppearance[Part], "none">, string[]>;

// Dots are transparent. Digits select solid colors from the sprite palette.
export const eyes = {
  bright: [".1.", "121", "111", ".1."],
  dot: ["11", "11"],
  happy: [".11.", "1..1", "1..1"],
  flat: ["111"],
  wink: ["1..", ".11", "1.."],
  wide: [".11.", "1221", "1211", "1111", ".11."],
  sparkle: [".1.", "121", "222", "121", ".1."],
  sleepy: ["1..1", ".11."],
} satisfies Sprites<"eyes">;

export const mouths = {
  smile: ["1...1", ".111."],
  grin: ["111111", "113311", ".1111."],
  flat: ["111"],
  surprised: [".1.", "111", "131", ".1."],
  wavy: ["11..1", "..11."],
  tongue: ["11111", ".1331", "..131", "...1."],
  frown: [".111.", "1...1"],
} satisfies Sprites<"mouth">;

export const toppers = {
  sprout: [
    "1111...1111",
    "14331.13341",
    ".123313321.",
    "..1123211..",
    "....131....",
    "....131....",
  ],
  cap: [
    ".....111111.....",
    "...1133333211...",
    "..133444333221..",
    ".13433333332221.",
    ".133333332211111",
    "1333221111123331",
    "1111111111111111",
  ],
  beanie: [
    "......111.......",
    ".....14321......",
    "...113333211....",
    "..13433333221...",
    ".1343333333221..",
    ".1111111111111..",
    "143434343433221.",
    ".1111111111111..",
  ],
  halo: ["..1111111..", ".144333331.", "131.....131", ".132222231.", "..1111111.."],
  crown: [
    ".....11.....",
    "1...1441...1",
    "11.133331.11",
    "133335333331",
    ".1433533341.",
    ".1222222221.",
    "..11111111..",
  ],
  bow: [".11.....11.", "1431...1341", "13321112331", "13213413231", "121.121.121", ".1...1...1."],
} satisfies Sprites<"headwear">;

export const compactHats = {
  cap: [
    "....11111....",
    "..113333211..",
    ".13444333221.",
    ".133333322211",
    "1333111123331",
    "1111111111111",
  ],
  beanie: [
    ".....111.....",
    "....14321....",
    "...1333321...",
    "..134333221..",
    ".13333332221.",
    "1111111111111",
    "1434343433221",
    ".11111111111.",
  ],
};

export const lenses = {
  round: [".111.", "13.31", "13..1", "1..31", ".111."],
  square: ["111111", "133431", "134321", "132221", ".1111."],
  visor: [
    "..111111111111..",
    ".14343333333331.",
    "1343333333422221",
    "1333333343222221",
    ".12222222222221.",
    "..111111111111..",
  ],
  "eye-patch": [".111.", "13321", "13221", ".121.", "..1.."],
  monocle: [".111..", "14..1.", "13..1.", "1..31.", ".1111.", "....13", ".....1"],
  headset: [".111.", "13321", "14321", "13321", "13221", ".111."],
} satisfies Sprites<"eyewear">;

export const neckpieces = {
  tie: ["11111", ".131.", "..1..", ".131.", ".132.", ".121.", "..1.."],
  "bow-tie": ["11.....11", "141111131", "133141321", "121.1.121", ".1.....1."],
  pendant: ["11.......11", "..11...11..", "....111....", "....151....", ".....1....."],
  collar: ["1111.....1111", "14331...13321", ".13331113321.", "..111151111..", "......1......"],
  "scarf-tail": ["1111", "1331", "1431", "1331", "1321", "1221", "1111"],
};

export const decorations = {
  blush: [".33.", "332"],
  sparkles: ["..1....", ".141..3", "14341..", ".131...", "..1...."],
  heart: [".11.11.", "1431331", "1333331", ".13331.", "..121..", "...1..."],
  chat: [".111111.", "13333331", "13535351", "13333331", ".111311.", "....11.."],
  stars: ["..1....", "..3....", "13331..", ".131..3", ".1.1..."],
};

type Defaults = {
  [Part in AvatarPart]: Record<Exclude<PixelAppearance[Part], "none">, string>;
};

const ink = "#0b0811";

const defaults: Defaults = {
  eyes: {
    bright: ink,
    dot: ink,
    happy: ink,
    flat: ink,
    wink: ink,
    wide: ink,
    sparkle: ink,
    sleepy: ink,
  },
  mouth: { smile: ink, grin: ink, flat: ink, surprised: ink, wavy: ink, tongue: ink, frown: ink },
  headwear: {
    sprout: "#80d34f",
    cap: "#3c58ae",
    beanie: "#26a889",
    halo: "#ffdb59",
    crown: "#ffc851",
    bow: "#ee5d9d",
  },
  eyewear: {
    round: "#6595c9",
    square: "#39bfd7",
    visor: "#51c6ef",
    "eye-patch": "#505372",
    headset: "#e54754",
    monocle: "#e5a646",
  },
  neckwear: {
    scarf: "#ec4857",
    tie: "#4c9ae6",
    "bow-tie": "#e864a5",
    pendant: "#e6aa49",
    collar: "#d9e9ff",
  },
  extra: {
    blush: "#f26ea9",
    sparkles: "#ffe08c",
    heart: "#ed719f",
    chat: "#75d6f5",
    stars: "#ffcb58",
    orbit: "#78d4f1",
  },
};

export const partDefaultColor = (part: AvatarPart, value: string) => {
  const palette: Partial<Record<string, string>> = defaults[part];
  return palette[value] ?? ink;
};
