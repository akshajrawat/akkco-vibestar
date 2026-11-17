import { useEffect, useState } from "react";

export const usePaneSize = (key: string, initial: number, min: number, max: number) => {
  const [size, setSize] = useState(() =>
    Math.max(min, Math.min(max, Number(localStorage.getItem(`vibestar.${key}`)) || initial)),
  );

  useEffect(() => {
    const timer = setTimeout(() => localStorage.setItem(`vibestar.${key}`, String(size)), 200);
    return () => clearTimeout(timer);
  }, [key, size]);

  return [size, setSize] as const;
};
