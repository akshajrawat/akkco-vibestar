import { z } from "zod";

export const viberMemoryFactLimit = 2000;

export interface ViberMemoryFact {
  id: string;
  text: string;
}

const scope = z.strictObject({ profile_id: z.uuid() });
const fact = scope.extend({ id: z.uuid() });
const text = z.string().trim().min(1).max(viberMemoryFactLimit);

export const viberMemoryInputs = {
  "viber.memory.list": scope,
  "viber.memory.create": scope.extend({ text }),
  "viber.memory.update": fact.extend({ text }),
  "viber.memory.forget": fact,
};

export interface ViberMemoryResults {
  "viber.memory.list": ViberMemoryFact[];
  "viber.memory.create": ViberMemoryFact;
  "viber.memory.update": ViberMemoryFact;
  "viber.memory.forget": null;
}
