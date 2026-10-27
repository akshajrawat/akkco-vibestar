import { Plug } from "lucide-react";

import openai from "../../assets/brands/openai.svg";
import antigravity from "../../assets/brands/antigravity.svg";
import anthropic from "../../assets/brands/anthropic.svg";
import gemini from "../../assets/brands/gemini.svg";
import github from "../../assets/brands/github.svg";

/** Product identity stays distinct from the model vendor reported by its CLI. */
export const ProviderIcon = ({
  provider,
  model = "",
  size = 16,
}: {
  provider: string;
  model?: string;
  size?: number;
}) => {
  const brand = /^gemini(?:-|$)/i.test(model)
    ? { source: gemini, name: "gemini" }
    : /^claude(?:-|$)/i.test(model)
      ? { source: anthropic, name: "anthropic" }
      : provider === "codex"
        ? { source: openai, name: "openai" }
        : provider === "antigravity"
          ? { source: antigravity, name: "antigravity" }
          : provider === "github"
            ? { source: github, name: "github" }
            : null;

  return brand ? (
    <img
      className={`brand-icon brand-${brand.name}`}
      src={brand.source}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  ) : (
    <Plug className="brand-icon" size={size} aria-hidden="true" />
  );
};
