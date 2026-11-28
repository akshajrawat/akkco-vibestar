import { useLayoutEffect, useRef } from "react";

import type { AgentProfile } from "../../../core/vibers/contracts";
import { pixelAppearance, type ViberAppearance } from "../../../core/vibers/appearance";
import { avatarGridSize, paintAvatar, type AvatarSample } from "./avatar-sprites";

export const ViberFace = ({
  className = "",
  animated = false,
  label,
  profile,
  appearance,
  sample,
}: {
  className?: string;
  animated?: boolean;
  label?: string;
  profile?: Pick<AgentProfile, "id" | "appearance">;
  appearance?: ViberAppearance;
  sample?: AvatarSample;
}) => {
  const source = appearance ?? profile?.appearance;
  const profileId = profile?.id;
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    if (typeof CanvasRenderingContext2D === "undefined") {
      return;
    }

    const drawing = canvas.current?.getContext("2d");
    if (!drawing) {
      return;
    }

    paintAvatar(drawing, pixelAppearance(source, profileId), sample);
  }, [source, profileId, sample]);

  return (
    <canvas
      ref={canvas}
      className={`viber-face ${animated ? "viber-face-animated" : ""} ${className}`}
      width={avatarGridSize}
      height={avatarGridSize}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
};
