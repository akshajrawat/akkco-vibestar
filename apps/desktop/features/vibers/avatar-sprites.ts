import type { AvatarPart, PixelAppearance } from "../../../core/vibers/appearance";
import {
  bodies,
  compactHats,
  decorations,
  eyes,
  lenses,
  mouths,
  neckpieces,
  partDefaultColor,
  toppers,
} from "./avatar-art";

export const avatarGridSize = 32;
export type AvatarSample = "shape" | AvatarPart;

type Texture = readonly string[];

type Paint = (x: number, y: number, width: number, height: number, color: string) => void;

type Span = Parameters<Paint>;

const ink = "#120b1c";
const warmWhite = "#fff4f0";
const tongue = "#ff719c";

const channels = (color: string) =>
  [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));

const mix = (color: string, tint: string, amount: number) => {
  const target = channels(tint);
  return (
    "#" +
    channels(color)
      .map((channel, index) =>
        Math.round(channel + (target[index] - channel) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

const lightness = (color: string) =>
  channels(color).reduce((value, channel, index) => {
    const fraction = channel / 255;
    const linear = fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
    return value + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);

const contrast = (first: string, second: string) => {
  const a = lightness(first) + 0.05;
  const b = lightness(second) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
};

const paletteFor = (color: string, accent = warmWhite) => {
  const dark = contrast(color, ink) < 2.5;
  const outline = dark ? mix(color, "#c6b7e5", 0.62) : ink;
  const shade = mix(color, dark ? "#6c5f8a" : ink, dark ? 0.35 : 0.34);
  const light = mix(color, lightness(color) > 0.82 ? "#c9b1df" : warmWhite, 0.55);
  return [outline, shade, color, light, accent];
};

const sprite = (
  paint: Paint,
  rows: Texture,
  palette: readonly string[],
  center: number,
  top: number,
) => {
  const width = Math.max(...rows.map((row) => row.length));
  const left = center - Math.floor(width / 2);

  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[Number(row[x]) - 1];
      if (color) {
        paint(left + x, top + y, 1, 1, color);
      }
    }
  });
};

const line = (paint: Paint, x: number, y: number, endX: number, endY: number, color: string) => {
  const steps = Math.max(Math.abs(endX - x), Math.abs(endY - y), 1);
  for (let step = 0; step <= steps; step++) {
    paint(
      Math.round(x + ((endX - x) * step) / steps),
      Math.round(y + ((endY - y) * step) / steps),
      1,
      1,
      color,
    );
  }
};

const contains = (body: (typeof bodies)[keyof typeof bodies], x: number, y: number) => {
  const row = body.rows[y - body.top];
  if (!row) {
    return false;
  }

  const [left, right, secondLeft, secondRight] = row;
  return (
    (x >= left && x <= right) ||
    (secondLeft !== undefined && secondRight !== undefined && x >= secondLeft && x <= secondRight)
  );
};

const bodyStencil = (body: (typeof bodies)[keyof typeof bodies]) => {
  const [shineX, shineY] = body.shine;
  const runs: [x: number, y: number, width: number, shade: number][] = [];

  for (let y = body.top; y < body.top + body.rows.length; y++) {
    for (let x = 0; x < avatarGridSize; x++) {
      if (!contains(body, x, y)) {
        continue;
      }

      const edge =
        !contains(body, x - 1, y) ||
        !contains(body, x + 1, y) ||
        !contains(body, x, y - 1) ||
        !contains(body, x, y + 1);

      const shine =
        (y === shineY && x >= shineX && x <= shineX + 2) ||
        (y === shineY + 1 && x >= shineX - 1 && x <= shineX) ||
        (y === shineY + 2 && x === shineX - 1);

      const shadow =
        y >= body.mouth[1] - 2 && (!contains(body, x + 1, y + 2) || !contains(body, x, y + 3));

      const shade = edge ? 0 : shine ? 3 : shadow ? 1 : 2;
      const previous = runs.at(-1);
      if (
        previous &&
        previous[1] === y &&
        previous[0] + previous[2] === x &&
        previous[3] === shade
      ) {
        previous[2]++;
      } else {
        runs.push([x, y, 1, shade]);
      }
    }
  }

  return runs;
};

const stencils = new Map(
  (Object.keys(bodies) as PixelAppearance["shape"][]).map((shape) => [
    shape,
    bodyStencil(bodies[shape]),
  ]),
);

export const paintAvatar = (
  context: CanvasRenderingContext2D,
  appearance: PixelAppearance,
  sample?: AvatarSample,
) => {
  context.clearRect(0, 0, avatarGridSize, avatarGridSize);

  const body = bodies[appearance.shape];
  const bodyPalette = paletteFor(appearance.color);
  const [leftEye, rightEye, eyeY] = body.eyes;
  const [leftSide, rightSide, sideY] = body.sides;
  const [neckLeft, neckRight, neckY] = body.neck;
  const [headX, headY, hatWidth] = body.head;
  const faceX = body.mouth[0];

  const draw: Paint = (x, y, width, height, color) => {
    context.fillStyle = color;
    context.fillRect(x, y, width, height);
  };

  const samplePixels: Span[] = [];

  const layer = (part: AvatarPart, render: (paint: Paint, color: string) => void) => {
    if ((sample && sample !== part) || appearance[part] === "none") {
      return;
    }

    render(
      sample ? (...pixel) => samplePixels.push(pixel) : draw,
      appearance.colors?.[part] ?? partDefaultColor(part, appearance[part]),
    );
  };

  const faceSprite = (
    paint: Paint,
    rows: Texture,
    color: string,
    detail: string,
    center: number,
    top: number,
  ) => {
    const surface = sample ? "#202020" : appearance.color;
    if (contrast(color, surface) < 2.6) {
      const rim = contrast(ink, surface) >= 3 ? ink : mix(surface, warmWhite, 0.55);

      const touch = (x: number, y: number) => {
        if (sample || contains(body, x, y)) {
          paint(x, y, 1, 1, rim);
        }
      };

      sprite(
        (x, y) => {
          touch(x - 1, y);
          touch(x + 1, y);
          touch(x, y - 1);
          touch(x, y + 1);
        },
        rows,
        [rim, rim, rim],
        center,
        top,
      );
    }

    sprite(paint, rows, [color, detail, tongue], center, top);
  };

  // Rear segments follow the silhouette and get occluded naturally by the body.
  layer("extra", (paint, color) => {
    if (!sample && appearance.extra === "orbit") {
      const [edge, shade, fill] = paletteFor(color);
      line(paint, 1, 25, 30, 15, edge);
      line(paint, 1, 26, 30, 16, fill);
      line(paint, 1, 27, 30, 17, shade);
    }
  });

  layer("eyewear", (paint, color) => {
    if (appearance.eyewear !== "headset") {
      return;
    }

    const [edge, shade, fill, light] = paletteFor(color);
    const top = body.top - 2;
    const radius = Math.round((rightSide - leftSide) / 4);
    const band: Span[] = [];
    const collect: Paint = (...pixel) => band.push(pixel);
    let left = leftSide + radius;
    let right = rightSide - radius;
    line(collect, left, top, right, top, fill);
    line(collect, left, top, left + radius, top, light);

    for (let y = top + 1; y <= sideY; y++) {
      const [rowLeft, rowRight, , secondRight] = body.rows[Math.max(0, y - body.top)];
      const nextLeft = Math.max(1, Math.min(left, rowLeft - 2));
      const nextRight = Math.min(30, Math.max(right, (secondRight ?? rowRight) + 2));
      const bandColor = y < body.top + 3 ? fill : shade;
      line(collect, left, y - 1, nextLeft, y, bandColor);
      line(collect, right, y - 1, nextRight, y, bandColor);
      left = nextLeft;
      right = nextRight;
    }

    for (const [x, y] of band) {
      paint(x - 1, y, 3, 1, edge);
      paint(x, y - 1, 1, 3, edge);
    }

    for (const [x, y, width, height, color] of band) {
      paint(x, y, width, height, color);
    }
  });

  if (!sample || sample === "shape") {
    for (const [x, y, width, shade] of stencils.get(appearance.shape)!) {
      draw(x, y, width, 1, bodyPalette[shade]);
    }
  }

  layer("eyes", (paint, color) => {
    const value = appearance.eyes;
    if (value === "none") {
      return;
    }

    const left = value === "wink" ? eyes.bright : eyes[value];
    for (const [x, rows] of [
      [sample ? 13 : leftEye, left],
      [sample ? 19 : rightEye, eyes[value]],
    ] as const) {
      const catchlight = contrast(color, warmWhite) < 2 ? ink : warmWhite;
      faceSprite(paint, rows, color, catchlight, x, eyeY - Math.floor(rows.length / 2));
    }
  });

  layer("mouth", (paint, color) => {
    if (appearance.mouth !== "none") {
      faceSprite(paint, mouths[appearance.mouth], color, warmWhite, ...body.mouth);
    }
  });

  layer("headwear", (paint, color) => {
    const value = appearance.headwear;
    if (value === "none") {
      return;
    }

    const rows =
      hatWidth < 16 && (value === "cap" || value === "beanie")
        ? compactHats[value]
        : toppers[value];

    const center = value === "bow" && headX <= 16 ? headX + 4 : headX;

    const mount =
      value === "halo"
        ? body.top - 1
        : value === "sprout"
          ? body.top + 1
          : headY + (value === "bow" ? 2 : value === "cap" || value === "beanie" ? 1 : 0);

    sprite(paint, rows, paletteFor(color, "#51d9ef"), center, mount - rows.length + 1);
  });

  layer("eyewear", (paint, color) => {
    const value = appearance.eyewear;
    const palette = paletteFor(color);
    const [edge, shade] = palette;
    switch (value) {
      case "round":
      case "square":
        line(paint, leftSide, eyeY - 1, leftEye - 2, eyeY - 1, edge);
        line(paint, leftEye + 2, eyeY - 1, rightEye - 2, eyeY - 1, edge);
        line(paint, rightEye + 2, eyeY - 1, rightSide, eyeY - 1, edge);
        for (const x of [leftEye, rightEye]) {
          sprite(paint, lenses[value], palette, x, eyeY - 2);
        }

        break;
      case "visor":
        line(paint, leftSide, eyeY - 1, rightSide, eyeY - 1, edge);
        sprite(paint, lenses.visor, palette, faceX, eyeY - 3);
        break;
      case "eye-patch": {
        const strapY = Math.max(eyeY - 2, body.top);
        const [, strapRight] = body.rows[strapY - body.top] ?? [leftSide, rightSide];
        line(paint, leftSide, eyeY + 2, leftEye, eyeY, edge);
        line(paint, leftEye, eyeY, Math.min(rightSide - 1, strapRight), strapY, edge);
        sprite(paint, lenses[value], palette, leftEye, eyeY - 2);
        break;
      }

      case "monocle":
        sprite(paint, lenses[value], palette, rightEye + 1, eyeY - 2);
        break;
      case "headset":
        for (const x of [leftSide, rightSide]) {
          sprite(paint, lenses.headset, palette, x, sideY - 2);
        }

        line(paint, rightSide, sideY + 2, rightSide - 2, sideY + 5, edge);
        paint(rightSide - 3, sideY + 5, 2, 1, edge);
        paint(rightSide - 3, sideY + 4, 1, 1, shade);
        break;
    }
  });

  layer("neckwear", (paint, color) => {
    const value = appearance.neckwear;
    const palette = paletteFor(color);

    const faceBottom =
      appearance.mouth === "none" ? body.mouth[1] : body.mouth[1] + mouths[appearance.mouth].length;

    if (value === "scarf") {
      const knot = Math.min(neckRight - 2, faceX + 6);
      const scarfY = Math.max(neckY + 1, faceBottom);

      for (let x = neckLeft; x <= neckRight; x++) {
        const inset = Math.min(x - neckLeft, neckRight - x);
        const y = scarfY - 3 + Math.min(inset, 3);
        const trim = inset === 0 ? palette[0] : palette[2];
        paint(x, y, 1, 1, palette[0]);
        paint(x, y + 1, 1, 1, trim);
        paint(x, y + 2, 1, 1, inset === 0 ? palette[0] : palette[1]);
        paint(x, y + 3, 1, 1, palette[0]);
      }

      const tail = neckpieces["scarf-tail"];
      sprite(paint, tail, palette, knot, Math.min(scarfY, avatarGridSize - tail.length));
    } else if (value !== "none") {
      sprite(paint, neckpieces[value], palette, faceX, Math.max(neckY, faceBottom));
    }
  });

  layer("extra", (paint, color) => {
    const value = appearance.extra;
    const palette = paletteFor(color, ink);
    if (value === "blush") {
      const cheekY = eyeY + 3;
      const [cheekLeft, cheekRight] = body.rows[cheekY + 1 - body.top];
      for (const x of [
        Math.max(cheekLeft + 3, leftEye - 3),
        Math.min(cheekRight - 2, rightEye + 3),
      ]) {
        sprite(paint, decorations.blush, palette, x, cheekY);
      }
    } else if (value === "orbit") {
      const [edge, , fill, bright] = palette;
      line(paint, 1, 26, 7, 28, edge);
      line(paint, 7, 28, 21, 27, edge);
      line(paint, 21, 27, 30, 17, edge);
      line(paint, 2, 26, 7, 27, bright);
      line(paint, 7, 27, 21, 26, fill);
      line(paint, 21, 26, 30, 16, fill);
    } else if (value !== "none") {
      const [x, y] = body.extra;
      sprite(paint, decorations[value], palette, x, y - 2);
    }
  });

  if (samplePixels.length) {
    const left = Math.min(...samplePixels.map(([x]) => x));
    const top = Math.min(...samplePixels.map(([, y]) => y));
    const width = Math.max(...samplePixels.map(([x, , w]) => x + w)) - left;
    const height = Math.max(...samplePixels.map(([, y, , h]) => y + h)) - top;
    const scale = Math.max(1, Math.min(5, Math.floor(30 / Math.max(width, height))));
    const startX = Math.floor((avatarGridSize - scale * width) / 2);
    const startY = Math.floor((avatarGridSize - scale * height) / 2);

    for (const [x, y, w, h, color] of samplePixels) {
      draw(startX + (x - left) * scale, startY + (y - top) * scale, w * scale, h * scale, color);
    }
  }
};
