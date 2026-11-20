import type { ViberAppearance } from "../../../core/vibers/appearance";

export const AvatarShape = ({ shape, fill }: { shape: ViberAppearance["shape"]; fill: string }) => {
  switch (shape) {
    case "circle":
      return <ellipse cx="80" cy="82" rx="51" ry="53" fill={fill} />;
    case "rounded-square":
      return (
        <path
          d="M29 67 Q29 29 66 29 H94 Q131 29 131 67 V99 Q131 136 94 136 H66 Q29 136 29 99Z"
          fill={fill}
        />
      );
    case "triangle":
      return (
        <path
          d="M64 39 C73 22 87 22 96 39 L136 113 C144 128 136 137 119 137 H41 C24 137 16 128 24 113Z"
          fill={fill}
        />
      );
    case "hexagon":
      return (
        <path
          d="M56 29 Q80 26 104 29 Q113 30 119 39 Q133 58 141 76 Q144 83 140 92 Q131 111 118 128 Q112 136 102 136 H58 Q48 136 42 128 Q29 111 20 92 Q16 83 19 76 Q27 58 41 39 Q47 30 56 29Z"
          fill={fill}
        />
      );
    case "diamond":
      return (
        <path
          d="M67 29 Q80 17 93 29 L131 65 Q149 82 131 99 L93 135 Q80 147 67 135 L29 99 Q11 82 29 65Z"
          fill={fill}
        />
      );
    case "capsule":
      return <rect x="16" y="46" width="128" height="78" rx="38" fill={fill} />;
    case "rectangle":
      return <rect x="18" y="38" width="124" height="94" rx="27" fill={fill} />;
  }
};

const star = "M0 -8 2.5 -2.5 8 0 2.5 2.5 0 8 -2.5 2.5 -8 0 -2.5 -2.5Z";

export const AvatarEyes = ({ eyes }: Pick<ViberAppearance, "eyes">) => (
  <g
    className="viber-face-eyes"
    fill="white"
    stroke="white"
    strokeWidth="4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {[63, 97].map((x, index) => {
      const transform = `translate(${x} ${index ? 80 : 77})`;
      switch (eyes) {
        case "happy":
          return <path key={x} transform={transform} d="M-6 3 Q0 -10 6 3" fill="none" />;
        case "focused":
          return <path key={x} transform={transform} d="M-6 -3 H6 M-5 -2 Q0 12 5 -2" fill="none" />;
        case "wide":
          return (
            <g key={x} transform={transform}>
              <ellipse rx="8" ry="9" stroke="none" />
              <circle r="4" cy="1" fill="#171717" stroke="none" />
            </g>
          );
        case "sparkle":
          return <path key={x} transform={transform} d={star} strokeWidth="1" />;
        case "closed":
          return <path key={x} transform={transform} d="M-6 0 H6" />;
        case "sleepy":
          return <path key={x} transform={transform} d="M-6 -2 Q0 8 6 -2" fill="none" />;
        case "curious":
          return (
            <ellipse
              key={x}
              transform={transform}
              rx={index ? 6 : 4}
              ry={index ? 8 : 5}
              strokeWidth="0"
            />
          );
        case "wink":
          return index ? (
            <path key={x} transform={transform} d="M-5 -5 3 0 -5 5" fill="none" />
          ) : (
            <ellipse key={x} transform={transform} rx="5" ry="8" strokeWidth="0" />
          );
        case "concerned":
          return (
            <path
              key={x}
              transform={transform}
              d={index ? "M-5 3 Q0 -5 5 -2" : "M-5 -2 Q0 -5 5 3"}
              fill="none"
            />
          );
        default:
          return <ellipse key={x} transform={transform} rx="5" ry="8" strokeWidth="0" />;
      }
    })}
  </g>
);

export const AvatarEyebrows = ({ eyebrows }: Pick<ViberAppearance, "eyebrows">) => {
  if (eyebrows === "none") {
    return null;
  }

  const paths = {
    none: "",
    calm: "M56 62 Q63 64 70 62 M90 62 Q97 64 104 62",
    raised: "M55 61 Q63 50 71 57 M89 57 Q97 50 105 61",
    angry: "M55 54 71 62 M89 62 105 54",
    focused: "M55 58 71 62 M89 62 105 58",
    concerned: "M55 62 71 54 M89 54 105 62",
    playful: "M55 59 H71 M89 54 Q99 50 105 58",
    sharp: "M55 53 71 60 M55 59 71 66 M89 60 105 53 M89 66 105 59",
  };

  return (
    <path
      d={paths[eyebrows]}
      fill="none"
      stroke="#171717"
      strokeWidth="4.5"
      strokeLinecap="round"
    />
  );
};

export const AvatarGlasses = ({ glasses }: Pick<ViberAppearance, "glasses">) => {
  if (glasses === "none") {
    return null;
  }

  const round = glasses === "round" || glasses === "oval";
  const width = glasses === "oversized" ? 34 : 27;
  return (
    <g fill="#0000001f" stroke="#171717" strokeWidth="4">
      <path d="M43 73 H49 M76 76 Q80 72 84 76 M111 73 H117" fill="none" />
      {[63, 97].map((x) =>
        round ? (
          <ellipse key={x} cx={x} cy="78" rx="14" ry={glasses === "oval" ? 10 : 14} />
        ) : (
          <rect key={x} x={x - width / 2} y="65" width={width} height="27" rx="7" />
        ),
      )}
    </g>
  );
};

const hatFit: Record<ViberAppearance["shape"], { seatY: number; scale: number }> = {
  circle: { seatY: 36, scale: 0.72 },
  "rounded-square": { seatY: 35, scale: 0.74 },
  triangle: { seatY: 32, scale: 0.56 },
  hexagon: { seatY: 34, scale: 0.72 },
  diamond: { seatY: 29, scale: 0.54 },
  capsule: { seatY: 52, scale: 0.84 },
  rectangle: { seatY: 44, scale: 0.86 },
};

export const AvatarAccessory = ({
  accessory,
  shape,
  material,
  detail,
}: Pick<ViberAppearance, "accessory" | "shape"> & { material: string; detail: string }) => {
  const { seatY, scale } = hatFit[shape];
  const hatPosition = `translate(80 ${seatY}) scale(${scale}) translate(-80 -50)`;

  switch (accessory) {
    case "none":
      return null;
    case "headphones": {
      const widths: Partial<Record<ViberAppearance["shape"], number>> = {
        circle: 51,
        "rounded-square": 51,
        triangle: 37,
      };

      const width = widths[shape] ?? 60;
      // Set the midpoint of the cubic arch just above the crown.
      const archControlY = (4 * (seatY - 11) - 72) / 3;
      return (
        <g>
          <path
            d={`M${80 - width} 84 V72 C${80 - width} ${archControlY} ${80 + width} ${archControlY} ${80 + width} 72 V84`}
            fill="none"
            stroke={material}
            strokeWidth="9"
          />
          <rect x={71 - width} y="67" width="21" height="37" rx="10" fill={material} />
          <rect x={68 + width} y="67" width="21" height="37" rx="10" fill={material} />
          <ellipse cx={80 - width} cy="85" rx="6" ry="12" fill={detail} />
          <ellipse cx={80 + width} cy="85" rx="6" ry="12" fill={detail} />
        </g>
      );
    }

    case "cap":
      return (
        <g transform={hatPosition}>
          <path d="M39 43 Q42 12 74 12 Q108 11 119 43Z" fill={material} />
          <path d="M39 43 Q71 31 117 39 Q135 42 137 49 Q115 56 80 49 Q56 47 39 43Z" fill={detail} />
          <circle cx="76" cy="12" r="3" fill={material} />
        </g>
      );
    case "beanie":
      return (
        <g transform={hatPosition}>
          <circle cx="78" cy="14" r="8" fill={detail} />
          <path d="M41 44 Q42 17 78 17 Q113 17 119 44Z" fill={material} />
          <rect x="38" y="37" width="84" height="14" rx="7" fill={detail} />
        </g>
      );
    case "crown":
      return (
        <g transform={hatPosition}>
          <path
            d="M45 24 Q44 20 48 22 L64 30 L77 15 Q80 11 83 15 L96 30 L112 22 Q116 20 115 24 L110 45 Q109 49 105 49 H55 Q51 49 50 45Z"
            fill={detail}
          />
          <circle cx="80" cy="35" r="4" fill={material} />
        </g>
      );
    case "wizard-hat":
      return (
        <g transform={hatPosition}>
          <ellipse cx="80" cy="44" rx="47" ry="8" fill={material} />
          <path d="M47 43 L73 12 Q78 5 85 10 L98 18 L91 23 L111 43 Q80 52 47 43Z" fill={detail} />
          <path d={star} transform="translate(79 34) scale(.7)" fill="#171717" />
        </g>
      );
    case "sparkle":
      return (
        <g fill={detail}>
          <path d={star} transform="translate(131 29)" />
          <path d={star} transform="translate(145 47) scale(.6)" />
        </g>
      );
    case "badge":
      return (
        <g transform="translate(-64 -12)">
          <circle cx="116" cy="116" r="10" fill={material} />
          <path d={star} transform="translate(116 116) scale(.8)" fill={detail} />
        </g>
      );
  }
};

export const AvatarDevice = ({
  device,
  surface,
}: Pick<ViberAppearance, "device"> & { surface: string }) => {
  const edge = "#262626";

  switch (device) {
    case "none":
      return null;
    case "phone":
      return (
        <g transform="rotate(-13 126 122)">
          <rect x="116" y="101" width="25" height="43" rx="7" fill={edge} />
          <rect x="113" y="101" width="25" height="43" rx="7" fill={surface} />
          <rect x="117" y="105" width="10" height="11" rx="3" fill={edge} />
          <circle cx="121" cy="109" r="2" fill="#e5e5e5" />
        </g>
      );
    case "tablet":
      return (
        <g transform="rotate(-9 124 126)">
          <rect x="103" y="104" width="42" height="40" rx="6" fill={edge} />
          <rect x="100" y="104" width="42" height="40" rx="6" fill={surface} />
          <circle cx="106" cy="110" r="2" fill="#e5e5e5" />
        </g>
      );
    case "laptop":
      return (
        <g>
          <path d="M94 136 H144 L151 139 Q153 143 146 144 H87Z" fill={edge} />
          <path
            d="M80 107 Q79 102 85 102 H130 Q135 102 136 107 L143 139 H91 Q87 139 86 134Z"
            fill={surface}
          />
          <path d={star} transform="translate(112 120) scale(.65)" fill="white" opacity=".85" />
        </g>
      );
    case "monitor":
      return (
        <g>
          <path
            d="M119 132 H127 V141 H135 Q138 141 138 144 H107 Q107 141 111 141 H119Z"
            fill={edge}
          />
          <rect x="98" y="102" width="49" height="32" rx="5" fill={edge} />
          <rect x="101" y="105" width="43" height="25" rx="3" fill={surface} />
          <path
            d="M107 121 L114 114 L119 119 L124 116 L137 126 H107Z"
            fill="#e5e5e5"
            opacity=".65"
          />
        </g>
      );
    case "code-panel":
      return (
        <g>
          <rect x="98" y="107" width="49" height="35" rx="6" fill={edge} />
          <path d="M98 113 Q98 107 104 107 H141 Q147 107 147 113 V116 H98Z" fill={surface} />
          <path
            d="M114 121 L110 125 L114 129 M130 121 L134 125 L130 129 M124 120 L120 130"
            fill="none"
            stroke="#e5e5e5"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );
  }
};

export const AvatarLips = ({ lips = "none" }: Pick<ViberAppearance, "lips">) => {
  const ink = "#171717";
  const props = { fill: "none", stroke: ink, strokeWidth: 3.5, strokeLinecap: "round" as const };

  switch (lips) {
    case "none":
      return null;
    case "smile":
      return <path d="M70 98 Q79 109 91 99" {...props} />;
    case "grin":
      return (
        <g>
          <path d="M68 98 Q80 101 92 97 C91 117 70 119 68 98Z" fill={ink} />
          <path d="M72 107 Q80 103 88 107 Q81 116 72 107Z" fill="#a3a3a3" />
        </g>
      );
    case "neutral":
      return <path d="M73 103 H87" {...props} />;
    case "open":
      return (
        <g>
          <ellipse cx="80" cy="103" rx="9" ry="6" fill={ink} />
          <path d="M74 106 Q80 103 86 106 Q80 110 74 106Z" fill="#a3a3a3" />
        </g>
      );
    case "pout":
      return <path d="M73 101 Q80 97 87 101 Q85 103 78 104 Q82 107 87 106" {...props} />;
    case "surprised":
      return <ellipse cx="80" cy="104" rx="6" ry="8" fill={ink} />;
  }
};
