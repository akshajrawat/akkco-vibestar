import { z } from "zod";

const model = z
  .string()
  .trim()
  .max(128)
  .regex(/^(?:[\w][\w.-]*(?:\/[\w][\w.-]*)?(?::[\w][\w.-]*)?)?$/);

export const defaultViberMemorySettings = {
  automatic_saving: false,
  recall: false,
  share_with: { codex: false, antigravity: false },
  embedding_model: "nomic-embed-text",
  suggestion_model: "qwen2.5:1.5b",
};

export const ViberMemorySettingsSchema = z.strictObject({
  automatic_saving: z.boolean().default(false),
  recall: z.boolean().default(false),
  share_with: z
    .strictObject({ codex: z.boolean().default(false), antigravity: z.boolean().default(false) })
    .default(defaultViberMemorySettings.share_with),
  embedding_model: model.default(defaultViberMemorySettings.embedding_model),
  suggestion_model: model.default(defaultViberMemorySettings.suggestion_model),
});

const topic = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .+#/&-]*$/u);

export const MemorySuggestionSchema = z.strictObject({
  action: z.literal("save_memory"),
  text: z.string().trim().min(1).max(320),
  evidence: z.string().trim().min(1).max(500),
  topic: topic.nullable(),
});
