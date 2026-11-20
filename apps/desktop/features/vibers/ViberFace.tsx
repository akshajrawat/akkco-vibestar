import { useId } from "react";

import type { AgentProfile } from "../../../core/vibers/contracts";
import { defaultAppearance, type ViberAppearance } from "../../../core/vibers/appearance";
import {
  AvatarShape,
  AvatarEyes,
  AvatarEyebrows,
  AvatarGlasses,
  AvatarAccessory,
  AvatarDevice,
  AvatarLips,
} from "./AvatarLayers";

export const ViberFace = ({
  className = "",
  animated = false,
  compact = false,
  profile,
  appearance,
}: {
  className?: string;
  animated?: boolean;
  compact?: boolean;
  profile?: Pick<AgentProfile, "id" | "appearance">;
  appearance?: ViberAppearance;
}) => {
  const id = useId();
  const parts = appearance || profile?.appearance || defaultAppearance();

  return (
    <svg
      className={`viber-face ${animated ? "viber-face-animated" : ""} ${className}`}
      viewBox={compact ? "12 14 136 136" : "0 0 160 160"}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`${id}-body`} cx="33%" cy="21%" r="80%">
          <stop stopColor={`color-mix(in oklab, ${parts.color} 50%, white)`} />
          <stop offset=".49" stopColor={parts.color} />
          <stop offset=".83" stopColor={`color-mix(in oklab, ${parts.color} 86%, black)`} />
          <stop offset="1" stopColor={`color-mix(in oklab, ${parts.color} 72%, black)`} />
        </radialGradient>
        <radialGradient id={`${id}-shadow`}>
          <stop stopColor="black" stopOpacity=".62" />
          <stop offset="1" stopColor="black" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-accessory`} x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#525252" />
          <stop offset="1" stopColor="#171717" />
        </linearGradient>
        <linearGradient id={`${id}-detail`} x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="white" />
          <stop offset=".54" stopColor="#e0e0e0" />
          <stop offset="1" stopColor="#a3a3a3" />
        </linearGradient>
        <linearGradient id={`${id}-device`} x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#d4d4d4" />
          <stop offset=".55" stopColor="#858585" />
          <stop offset="1" stopColor="#525252" />
        </linearGradient>
      </defs>
      <ellipse
        className="viber-face-shadow"
        cx="81"
        cy="145"
        rx="63"
        ry="11"
        fill={`url(#${id}-shadow)`}
      />
      <g className="viber-face-body">
        <AvatarShape shape={parts.shape} fill={`url(#${id}-body)`} />
        <AvatarEyes {...parts} />
        <AvatarEyebrows {...parts} />
        <AvatarGlasses {...parts} />
        <AvatarLips {...parts} />
        <AvatarAccessory
          {...parts}
          material={`url(#${id}-accessory)`}
          detail={`url(#${id}-detail)`}
        />
        <AvatarDevice device={parts.device} surface={`url(#${id}-device)`} />
      </g>
    </svg>
  );
};
