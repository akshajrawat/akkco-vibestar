import { redact } from "../execution/runtime/process";
import { MemorySuggestionSchema } from "./memory-contracts";

const sensitive =
  /\b(?:password|passphrase|credential|secret|api[\s_-]*key|bearer|token|social security|ssn|passport|bank account|credit card|medical|diagnos\w+|home address|salary|date of birth)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\d[ -]?){9,}|\b[A-Za-z0-9_+-]{24,}\b/i;

const otherSource =
  /```|~~~|^\s*>|\[(?:attachment|context|tool output)\b|\b(?:readme|tool output|shell output|terminal output|according to|copied from|(?:webpage|website|the file|the docs|the log) (?:says|shows|reports))\b|https?:\/\//im;

export const memoryTextKey = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();

export const canExtractMemory = (text: string) =>
  text.length <= 8000 && !otherSource.test(text) && !sensitive.test(text) && redact(text) === text;

const preferenceValue = (verb: string, value: string) =>
  `preference:${/avoid|never|not|n['’]t/i.test(verb) ? "against" : "for"}:${memoryTextKey(value)}`;

const evidenceShape = (evidence: string) => {
  const correction = /^(?:actually|correction|update|instead)[:,]\s*/i;
  const text = evidence.replace(correction, "").trim();
  const durable = /\b(?:from now on|going forward|by default|always|as a rule)\b/i;

  const directive = text
    .replace(/^(?:from now on|going forward|by default|as a rule),?\s*/i, "")
    .replace(/(?:,?\s+(?:from now on|going forward|by default|as a rule))?[.!]?$/i, "");

  const scopedPreference =
    directive.match(
      /^(?:for|when working on) (.{2,80}?),\s*(?:please )?(?:always )?(use|prefer|avoid|never use|do not use|don['’]t use) (.+)$/i,
    ) ??
    directive.match(
      /^(?:please )?(?:always )?(use|prefer|avoid|never use|do not use|don['’]t use) (.+?) (?:for|when working on) (.{2,80})$/i,
    );

  if (scopedPreference) {
    const [, first, second, third] = scopedPreference;
    const prefix = /^(?:for|when working on) /i.test(directive);
    const topic = prefix ? first : third;
    const verb = prefix ? second : first;
    return {
      text,
      topic,
      subject: `preference:${memoryTextKey(topic)}`,
      value: preferenceValue(verb, prefix ? third : second),
      correction: correction.test(evidence),
    };
  }

  const preference =
    directive.match(
      /^(?:please )?(i (?:generally |usually )?prefer|(?:i )?always (?:use|prefer|avoid)|(?:i )?never use|my default is) (.+)$/i,
    ) ??
    (durable.test(text)
      ? directive.match(/^(?:please )?(use|prefer|avoid|do not use|don['’]t use) (.+)$/i)
      : null);

  const project = directive.match(
    /^(?:this|our|the current) (?:project|repo|repository|codebase) (uses|requires|runs on|defaults to|targets|stores) (.+)$/i,
  );

  const decision = directive.match(
    /^(?:we|i) (?:have )?(?:decided|agreed|standardized) (?:to |on )?(.+)$/i,
  );

  if (project) {
    return {
      text,
      topic: null,
      subject: null,
      value: `project:${memoryTextKey(`${project[1]} ${project[2]}`)}`,
      correction: correction.test(evidence),
    };
  }

  if (preference || decision) {
    const value = preference
      ? preferenceValue(preference[1], preference[2])
      : `decision:${memoryTextKey(decision![1])}`;

    return { text, topic: null, subject: null, value, correction: correction.test(evidence) };
  }

  return null;
};

export const validateMemorySuggestion = (message: string, raw: unknown) => {
  const result = MemorySuggestionSchema.safeParse(raw);
  if (!result.success || !canExtractMemory(message)) {
    return null;
  }

  const { evidence, topic: proposedTopic } = result.data;
  const sentences = message.trim().split(/\r?\n|(?<=[.!?])\s+/);
  if (
    !sentences.some((sentence) => sentence.trim() === evidence) ||
    /\?|\b(?:maybe|probably|might|for now|today|temporarily|only this time|this time only|this (?:task|turn|file|example|run|message|week|sprint)|ignore previous|system prompt)\b/i.test(
      evidence,
    )
  ) {
    return null;
  }

  const shaped = evidenceShape(evidence);
  if (!shaped || shaped.text.length > 320) {
    return null;
  }

  const topic = shaped.topic ?? proposedTopic;
  if (
    topic &&
    (!/^[\p{L}\p{N}][\p{L}\p{N} .+#/&-]*$/u.test(topic) ||
      !` ${memoryTextKey(evidence)} `.includes(` ${memoryTextKey(topic)} `))
  ) {
    return null;
  }

  return {
    ...shaped,
    evidence,
    topic,
    subject:
      shaped.subject ??
      (topic
        ? `${shaped.value.startsWith("project:") ? "project" : "topic"}:${memoryTextKey(topic)}`
        : null),
  };
};

export const memoryValue = (text: string) => evidenceShape(text)?.value ?? memoryTextKey(text);

export const storedMemorySubject = (subject: string | null, topic: string | null) =>
  subject?.startsWith("project:") ? (topic ? `project:${memoryTextKey(topic)}` : null) : subject;
