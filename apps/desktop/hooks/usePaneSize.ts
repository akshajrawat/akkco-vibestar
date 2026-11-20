import { useEffect, useState } from "react";

export const usePaneSize = (
  key: string,
  initial: number | (() => number),
  min: number,
  max: number,
) => {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(`vibestar.${key}`));
    const value = saved || (typeof initial === "function" ? initial() : initial);
    return Math.max(min, Math.min(max, value));
  });

  useEffect(() => {
    const timer = setTimeout(() => localStorage.setItem(`vibestar.${key}`, String(size)), 200);
    return () => clearTimeout(timer);
  }, [key, size]);

  return [size, setSize] as const;
};
