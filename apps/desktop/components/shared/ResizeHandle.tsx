import { useRef } from "react";

export const ResizeHandle = ({
  label,
  value,
  onChange,
  min,
  max,
  vertical = false,
  reverse = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  vertical?: boolean;
  reverse?: boolean;
}) => {
  const drag = useRef<{ origin: number; value: number } | null>(null);
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  return (
    <div
      className={`resize-handle ${vertical ? "vertical" : ""}`}
      role="separator"
      aria-label={label}
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { origin: vertical ? e.clientY : e.clientX, value };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          onChange(
            clamp(
              drag.current.value +
                ((vertical ? e.clientY : e.clientX) - drag.current.origin) * (reverse ? -1 : 1),
            ),
          );
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault();

          onChange(
            clamp(
              value + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -16 : 16) * (reverse ? -1 : 1),
            ),
          );
        }
      }}
    />
  );
};
