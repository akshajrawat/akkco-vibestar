import { useId, useRef, useState } from "react";
import { Circle, Eye, Headphones, Minus, RotateCcw } from "lucide-react";

import {
  avatarColorChoices,
  avatarPalette,
  PixelAppearanceSchema,
  type AvatarPart,
  type PixelAppearance,
} from "../../../core/vibers/appearance";
import { partDefaultColor } from "./avatar-art";
import { ViberFace } from "./ViberFace";

const tabs = [
  { key: "shape", label: "Shapes", icon: Circle },
  { key: "face", label: "Face", icon: Eye },
  { key: "accessories", label: "Accessories", icon: Headphones },
] as const;

const faceGroups = [
  ["eyes", "Eyes"],
  ["mouth", "Mouth"],
] as const;

const accessoryGroups = [
  ["headwear", "Head"],
  ["eyewear", "Face accessories"],
  ["neckwear", "Neck"],
  ["extra", "Extras"],
] as const;

const fields = PixelAppearanceSchema.shape;

const optionLabel = (value: string) =>
  value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());

export const AvatarBuilder = ({
  appearance,
  change,
}: {
  appearance: PixelAppearance;
  change: (appearance: PixelAppearance) => void;
}) => {
  const [active, setActive] = useState<(typeof tabs)[number]["key"]>("shape");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const changePartColor = (part: AvatarPart, color?: string) => {
    const colors = { ...appearance.colors };
    if (color && color !== partDefaultColor(part, appearance[part])) {
      colors[part] = color;
    } else {
      delete colors[part];
    }

    const next = { ...appearance };
    if (Object.keys(colors).length) {
      next.colors = colors;
    } else {
      delete next.colors;
    }

    return next;
  };

  return (
    <section className="avatar-builder min-w-0" aria-label="Appearance">
      <div role="tablist" aria-label="Appearance categories" className="avatar-categories">
        {tabs.map(({ key, label, icon: Icon }, index) => (
          <button
            key={key}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-${key}`}
            aria-controls={`${id}-options`}
            aria-selected={active === key}
            tabIndex={active === key ? 0 : -1}
            onClick={() => setActive(key)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") {
                next = (index + 1) % tabs.length;
              } else if (event.key === "ArrowLeft") {
                next = (index + tabs.length - 1) % tabs.length;
              } else if (event.key === "Home") {
                next = 0;
              } else if (event.key === "End") {
                next = tabs.length - 1;
              } else {
                return;
              }

              event.preventDefault();
              setActive(tabs[next].key);
              tabRefs.current[next]?.focus();
            }}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${id}-options`} aria-labelledby={`${id}-${active}`}>
        {(active === "shape"
          ? ([["shape", "Base shapes"]] as const)
          : active === "face"
            ? faceGroups
            : accessoryGroups
        ).map(([key, label]) => (
          <section key={key} aria-label={label} className="avatar-part-group">
            <header className="avatar-part-heading">
              <h3>{label}</h3>
              {key !== "shape" && appearance[key] !== "none" && (
                <div className="avatar-part-color">
                  <input
                    type="color"
                    aria-label={`${label} color`}
                    title={`${label} color`}
                    value={appearance.colors?.[key] ?? partDefaultColor(key, appearance[key])}
                    onChange={(event) => change(changePartColor(key, event.currentTarget.value))}
                  />
                  {appearance.colors?.[key] && (
                    <button
                      type="button"
                      aria-label={`Reset ${label.toLowerCase()} color`}
                      title="Restore default color"
                      onClick={() => change(changePartColor(key))}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </header>
            <div className={`avatar-options ${key === "shape" ? "avatar-shapes" : ""}`}>
              {fields[key].options.map((value) => {
                const title = optionLabel(value);
                return (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={appearance[key] === value}
                    onClick={() =>
                      change({
                        ...(value === "none" && key !== "shape"
                          ? changePartColor(key)
                          : appearance),
                        [key]: value,
                      })
                    }
                  >
                    {value === "none" ? (
                      <span className="avatar-empty-option" aria-hidden="true">
                        <Minus size={14} />
                      </span>
                    ) : (
                      <ViberFace appearance={{ ...appearance, [key]: value }} sample={key} />
                    )}
                    <small>{title}</small>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {active === "shape" && (
          <section aria-label="Color" className="avatar-part-group">
            <header className="avatar-part-heading">
              <h3>Body color</h3>
            </header>
            <div className="avatar-colors">
              {avatarColorChoices.map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={appearance.color.toLowerCase() === avatarPalette[key]}
                  aria-label={optionLabel(key)}
                  title={optionLabel(key)}
                  style={{ backgroundColor: avatarPalette[key] }}
                  onClick={() => change({ ...appearance, color: avatarPalette[key] })}
                />
              ))}
              <label>
                <input
                  type="color"
                  value={appearance.color}
                  onChange={(event) => change({ ...appearance, color: event.target.value })}
                />
                Custom color
              </label>
            </div>
          </section>
        )}
      </div>
    </section>
  );
};
