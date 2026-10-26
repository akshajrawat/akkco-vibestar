import { object, planSchemas } from "../providers/contracts";

// A streamed answer is a draft, never evidence of successful CLI completion.
export class StreamedPlan {
  private readonly messages = new Map<string, string>();

  constructor(private readonly stage: number) {}

  observe = (value: unknown) => {
    const data = object(value);
    const key = String(data.call_id ?? "answer");
    const previous = this.messages.get(key) || "";

    const text =
      typeof data.text === "string"
        ? data.text
        : typeof data.text_delta === "string"
          ? previous + data.text_delta
          : previous;

    if (text.length > 1048576) return;
    this.messages.set(key, text);
    try {
      const candidate = object(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
      // Observed Antigravity response metadata is separate from the plan schema.
      const plan = { ...candidate };
      delete plan.toolAction;
      delete plan.toolSummary;
      const schema = planSchemas[this.stage as keyof typeof planSchemas];
      const parsed = schema?.safeParse(plan);
      return parsed?.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
}
