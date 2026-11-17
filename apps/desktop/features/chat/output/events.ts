export const eventData = (data: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { text: value };
  } catch {
    return { text: data };
  }
};
