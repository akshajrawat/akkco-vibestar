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
  profile,
  appearance,
}: {
  className?: string;
  profile?: Pick<AgentProfile, "id" | "appearance">;
  appearance?: ViberAppearance;
}) => {
  const parts = appearance || profile?.appearance || defaultAppearance();
  return (
    <svg className={`viber-face ${className}`} viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <ellipse cx="80" cy="146" rx="48" ry="5" fill="#060d1b" opacity=".3" />
      <AvatarShape {...parts} />
      <AvatarEyes {...parts} />
      <AvatarEyebrows {...parts} />
      <AvatarGlasses {...parts} />
      <AvatarLips {...parts} />
      <AvatarAccessory {...parts} />
      <AvatarDevice {...parts} />
    </svg>
  );
};
