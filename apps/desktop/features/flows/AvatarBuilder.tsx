import { useId, useRef, useState } from "react";
import {
  Circle,
  Droplet,
  Laptop,
  Eye,
  Glasses,
  Headphones,
  Spline,
  Shuffle,
  Smile,
} from "lucide-react";

import {
  avatarColors,
  ViberAppearanceSchema,
  type ViberAppearance,
} from "../../../core/flows/appearance";
import { Button } from "../../components/ui/button";
import { ViberFace } from "./ViberFace";

const categories = [
  { key: "shape", label: "Shape", icon: Circle },
  { key: "color", label: "Color", icon: Droplet },
  { key: "device", label: "Device", icon: Laptop },
  { key: "eyes", label: "Eyes", icon: Eye },
  { key: "eyebrows", label: "Eyebrows", icon: Spline },
  { key: "glasses", label: "Glasses", icon: Glasses },
  { key: "lips", label: "Lips", icon: Smile },
  { key: "accessory", label: "Accessories", icon: Headphones },
] as const;

const optionLabel = (value: string) =>
  value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());

export const AvatarBuilder = ({
  appearance,
  change,
  randomize,
  customColor,
  setCustomColor,
}: {
  appearance: ViberAppearance;
  change: (appearance: ViberAppearance) => void;
  randomize: () => void;
  customColor: string;
  setCustomColor: (color: string) => void;
}) => {
  const [category, setCategory] = useState<(typeof categories)[number]>(categories[0]);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const options =
    category.key === "color"
      ? []
      : category.key === "lips"
        ? ViberAppearanceSchema.shape.lips.unwrap().options
        : ViberAppearanceSchema.shape[category.key].options;

  return (
    <section className="avatar-builder" aria-label="Appearance">
      <div role="tablist" aria-label="Appearance categories" className="avatar-categories">
        {categories.map((item, index) => (
          <button
            key={item.key}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-${item.key}`}
            aria-controls={`${id}-options`}
            aria-selected={category.key === item.key}
            tabIndex={category.key === item.key ? 0 : -1}
            onClick={() => setCategory(item)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % categories.length;
              else if (event.key === "ArrowLeft")
                next = (index + categories.length - 1) % categories.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = categories.length - 1;
              else return;
              event.preventDefault();
              setCategory(categories[next]);
              tabs.current[next]?.focus();
            }}
          >
            <item.icon size={19} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-options`}
        aria-labelledby={`${id}-${category.key}`}
        className="avatar-options-panel"
      >
        <div className="avatar-options-heading">
          <strong>{category.label}</strong>
          <Button type="button" variant="ghost" size="sm" onClick={randomize}>
            <Shuffle size={14} />
            Randomize Appearance
          </Button>
        </div>
        <div className="avatar-options">
          {category.key === "color"
            ? Object.entries(avatarColors).map(([label, color]) => (
                <button
                  type="button"
                  key={label}
                  aria-label={label}
                  aria-pressed={appearance.color.toLowerCase() === color}
                  onClick={() => {
                    change({ ...appearance, color });
                    setCustomColor(color);
                  }}
                >
                  <span className="avatar-color" style={{ background: color }} />
                  <small>{label}</small>
                </button>
              ))
            : options.map((option) => (
                <button
                  type="button"
                  key={option}
                  aria-label={optionLabel(option)}
                  aria-pressed={(appearance[category.key] ?? "none") === option}
                  onClick={() => change({ ...appearance, [category.key]: option })}
                >
                  <ViberFace appearance={{ ...appearance, [category.key]: option }} />
                  <small>{optionLabel(option)}</small>
                </button>
              ))}
        </div>
        {category.key === "color" && (
          <label className="avatar-custom-color">
            Custom HEX
            <input
              aria-label="Custom HEX"
              value={customColor}
              maxLength={7}
              placeholder="#2478ff"
              spellCheck={false}
              aria-invalid={!/^#[0-9a-fA-F]{6}$/.test(customColor)}
              onChange={(event) => {
                const color = event.target.value;
                setCustomColor(color);
                if (/^#[0-9a-fA-F]{6}$/.test(color)) change({ ...appearance, color });
              }}
            />
            {!/^#[0-9a-fA-F]{6}$/.test(customColor) && (
              <small role="alert">Enter # followed by six HEX digits.</small>
            )}
          </label>
        )}
      </div>
    </section>
  );
};
