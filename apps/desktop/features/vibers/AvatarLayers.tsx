import type { ViberAppearance } from "../../../core/vibers/appearance";

export const AvatarShape = ({ shape, color }: Pick<ViberAppearance, "shape" | "color">) => {
  const props = {
    fill: color,
    stroke: "#101c32",
    strokeWidth: 3,
    strokeLinejoin: "round" as const,
  };

  switch (shape) {
    case "circle":
      return <circle cx="80" cy="82" r="51" {...props} />;
    case "rounded-square":
      return <rect x="29" y="31" width="102" height="102" rx="25" {...props} />;
    case "triangle":
      return (
        <path d="M72 30 Q80 17 88 30 L139 121 Q145 134 130 134 H30 Q15 134 21 121Z" {...props} />
      );
    case "hexagon":
      return (
        <path
          d="M55 31 H105 Q111 31 115 38 L138 77 Q141 82 138 88 L115 127 Q111 133 105 133 H55 Q49 133 45 127 L22 88 Q19 82 22 77 L45 38 Q49 31 55 31Z"
          {...props}
        />
      );
    case "diamond":
      return (
        <path
          d="M74 24 Q80 18 86 24 L140 76 Q146 82 140 88 L86 140 Q80 146 74 140 L20 88 Q14 82 20 76Z"
          {...props}
        />
      );
    case "capsule":
      return <rect x="16" y="48" width="128" height="72" rx="36" {...props} />;
    case "rectangle":
      return <rect x="18" y="41" width="124" height="86" rx="15" {...props} />;
  }
};

const star = "M0 -8 2.5 -2.5 8 0 2.5 2.5 0 8 -2.5 2.5 -8 0 -2.5 -2.5Z";

export const AvatarEyes = ({ eyes }: Pick<ViberAppearance, "eyes">) => (
  <g fill="#f5f8ff" stroke="#f5f8ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    {[63, 97].map((x, index) => {
      const transform = `translate(${x} 79)`;
      switch (eyes) {
        case "happy":
          return <path key={x} transform={transform} d="M-6 3 Q0 -8 6 3" fill="none" />;
        case "focused":
          return <path key={x} transform={transform} d="M-6 -3 H6 M-5 -2 Q0 12 5 -2" fill="none" />;
        case "wide":
          return <circle key={x} transform={transform} r="6" fill="#101c32" />;
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
            <ellipse key={x} transform={transform} rx="4" ry="7" strokeWidth="0" />
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
          return <ellipse key={x} transform={transform} rx="4" ry="7" strokeWidth="0" />;
      }
    })}
  </g>
);

export const AvatarEyebrows = ({ eyebrows }: Pick<ViberAppearance, "eyebrows">) => {
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
    <path d={paths[eyebrows]} fill="none" stroke="#101c32" strokeWidth="4" strokeLinecap="round" />
  );
};

export const AvatarGlasses = ({ glasses }: Pick<ViberAppearance, "glasses">) => {
  if (glasses === "none") {
    return null;
  }

  const round = glasses === "round" || glasses === "oval";
  const width = glasses === "oversized" ? 34 : 27;
  return (
    <g fill="#0b142826" stroke="#101c32" strokeWidth="3.5">
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

export const AvatarAccessory = ({ accessory }: Pick<ViberAppearance, "accessory">) => {
  const props = {
    fill: "#26374f",
    stroke: "#b4c4df",
    strokeWidth: 2.5,
    strokeLinejoin: "round" as const,
  };

  switch (accessory) {
    case "none":
      return null;
    case "headphones":
      return (
        <g {...props}>
          <path d="M25 85 V69 a55 55 0 0 1 110 0 V85" fill="none" strokeWidth="7" />
          <rect x="19" y="70" width="16" height="34" rx="7" />
          <rect x="125" y="70" width="16" height="34" rx="7" />
        </g>
      );
    case "cap":
      return (
        <g {...props}>
          <path d="M40 42 Q44 9 79 14 Q108 15 117 42Z" />
          <path d="M78 39 Q121 35 137 49 Q107 55 78 45Z" />
          <path d="M79 15 Q65 23 68 40" fill="none" />
        </g>
      );
    case "beanie":
      return (
        <g {...props}>
          <circle cx="80" cy="13" r="8" />
          <path d="M43 44 Q42 18 80 18 Q118 18 117 44Z" />
          <rect x="39" y="38" width="82" height="13" rx="5" />
        </g>
      );
    case "crown":
      return (
        <path
          d="M45 43 37 16 64 28 80 8 96 28 123 16 115 43Z"
          fill="#f6c84a"
          stroke="#6a4c13"
          strokeWidth="3"
          strokeLinejoin="round"
        />
      );
    case "wizard-hat":
      return (
        <g {...props}>
          <path d="M51 39 76 3 91 15 108 39Z" fill="#57529a" />
          <ellipse cx="80" cy="42" rx="48" ry="9" fill="#57529a" />
          <path d={star} transform="translate(79 28) scale(.6)" fill="#f6c84a" stroke="none" />
        </g>
      );
    case "sparkle":
      return (
        <g fill="#75b6ff">
          <path d={star} transform="translate(130 29)" />
          <path d={star} transform="translate(143 49) scale(.6)" />
        </g>
      );
    case "badge":
      return (
        <g>
          <path d="M116 100 133 106 131 124 116 134 101 124 99 106Z" {...props} />
          <path d={star} transform="translate(116 116) scale(.8)" fill="#f6c84a" />
        </g>
      );
  }
};

export const AvatarDevice = ({ device }: Pick<ViberAppearance, "device">) => {
  if (device === "none") {
    return null;
  }

  const props = {
    fill: "#202d43",
    stroke: "#b4c4df",
    strokeWidth: 2.5,
    strokeLinejoin: "round" as const,
  };

  if (device === "phone" || device === "tablet") {
    return (
      <g {...props}>
        <rect
          x={device === "phone" ? 111 : 94}
          y="99"
          width={device === "phone" ? 27 : 47}
          height="45"
          rx="5"
        />
        <path d={device === "phone" ? "M121 105 H128 M122 137 H127" : "M113 137 H122"} />
      </g>
    );
  }

  return (
    <g {...props}>
      <path d="M91 103 H143 Q147 103 145 108 L138 137 H81 L88 108 Q89 103 91 103Z" />
      {device === "laptop" ? (
        <path d="M81 137 H138 L143 143 H74Z" />
      ) : device === "monitor" ? (
        <path d="M109 137 V145 M97 145 H121" />
      ) : null}
      <path
        d="M109 115 103 120 108 124 M124 115 130 119 123 124 M120 113 114 127"
        fill="none"
        stroke="#f5f8ff"
      />
    </g>
  );
};

export const AvatarLips = ({ lips = "none" }: Pick<ViberAppearance, "lips">) => {
  const props = {
    stroke: "#101c32",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (lips) {
    case "none":
      return null;
    case "smile":
      return <path d="M68 99 Q80 112 92 99" fill="none" {...props} />;
    case "grin":
      return <path d="M67 98 H93 Q91 113 80 113 Q69 113 67 98Z" fill="#f5f8ff" {...props} />;
    case "neutral":
      return <path d="M70 103 H90" fill="none" {...props} />;
    case "open":
      return <ellipse cx="80" cy="104" rx="9" ry="6" fill="#101c32" />;
    case "pout":
      return (
        <path d="M72 100 Q80 96 88 102 Q80 104 73 107 Q81 112 88 107" fill="none" {...props} />
      );
    case "surprised":
      return <ellipse cx="80" cy="104" rx="6" ry="9" fill="#101c32" />;
  }
};
