import { object } from "./contracts";

// Codex's official structured output requires every object property in required.
// Optional application fields are represented by nullable transport fields.
export const codexSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const copy = structuredClone(schema);
  const properties = object(copy.properties);
  if (copy.type === "object" || Object.keys(properties).length) {
    if (copy.additionalProperties && copy.additionalProperties !== false)
      throw new Error(
        "Codex structured output requires fixed object fields. Use an object schema with explicit properties.",
      );
    const required = Array.isArray(copy.required) ? copy.required : [];
    copy.additionalProperties = false;
    copy.required = Object.keys(properties);
    copy.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const child = codexSchema(object(value));
        return [key, required.includes(key) ? child : { anyOf: [child, { type: "null" }] }];
      }),
    );
  }
  if (copy.items) copy.items = codexSchema(object(copy.items));
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(copy[key])) copy[key] = copy[key].map((child) => codexSchema(object(child)));
  if (copy.$defs)
    copy.$defs = Object.fromEntries(
      Object.entries(object(copy.$defs)).map(([key, value]) => [key, codexSchema(object(value))]),
    );
  return copy;
};
export const codexResult = (schema: Record<string, unknown>, value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => codexResult(object(schema.items), item));
  if (!value || typeof value !== "object") return value;
  const properties = object(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const child = object(properties[key]);
      const nullable =
        child.type === "null" ||
        (Array.isArray(child.type) && child.type.includes("null")) ||
        (Array.isArray(child.anyOf) &&
          child.anyOf.some((branch) => object(branch).type === "null"));
      if (item === null && key in properties && !required.includes(key) && !nullable) return [];
      return [[key, codexResult(child, item)]];
    }),
  );
};
