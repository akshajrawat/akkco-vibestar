import { z } from "zod";

export const viberMemoryFactLimit = 2000;

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
  suggestion_model: "",
};

export const ViberMemorySettingsSchema = z.strictObject({
  automatic_saving: z.boolean().default(false),
  recall: z.boolean().default(false),
  share_with: z
    .strictObject({ codex: z.boolean().default(false), antigravity: z.boolean().default(false) })
    .default(defaultViberMemorySettings.share_with),
  embedding_model: model.default(defaultViberMemorySettings.embedding_model),
  suggestion_model: model.default(""),
});

const topic = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .+#/&-]*$/u);

const scope = z.strictObject({ profile_id: z.uuid() });
const fact = scope.extend({ id: z.uuid() });

const location = {
  repository_id: z.uuid().nullable().optional(),
  topic: topic.nullable().optional(),
};

const text = z.string().trim().min(1).max(viberMemoryFactLimit);

export const MemorySuggestionSchema = z.strictObject({
  action: z.literal("save_memory"),
  text: z.string().trim().min(1).max(320),
  evidence: z.string().trim().min(1).max(500),
  topic: topic.nullable(),
});

export type MemorySuggestion = z.output<typeof MemorySuggestionSchema>;

export interface ViberMemoryFact {
  id: string;
  text: string;
  repository_id?: string;
  repository_label?: string;
  topic?: string;
  needs_review?: true;
  source?: { message_id: string; session_id: string; created_at: string; evidence: string };
  shared?: { provider: "codex" | "antigravity"; at: string; earlier_revision: boolean }[];
}

export const viberMemoryInputs = {
  "viber.memory.list": scope,
  "viber.memory.create": scope.extend({ text, ...location }),
  "viber.memory.update": fact.extend({ text, ...location }),
  "viber.memory.forget": fact,
};

export interface ViberMemoryResults {
  "viber.memory.list": ViberMemoryFact[];
  "viber.memory.create": ViberMemoryFact;
  "viber.memory.update": ViberMemoryFact;
  "viber.memory.forget": null;
}
