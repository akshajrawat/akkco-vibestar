import type { KeyboardEvent } from "react";

export const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab")
    return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button[role=tab]:not(:disabled)",
    ),
  ];
  const index = tabs.indexOf(target as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) %
          tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
};
