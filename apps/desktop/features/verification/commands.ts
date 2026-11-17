export const parseArgv = (text: string): string[] => {
  const v: unknown = JSON.parse(text);
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string"))
    throw new Error("Enter a JSON array of executable and arguments.");
  return v as string[];
};
