import { z } from "zod";

import { FollowupConfigSchema } from "../domain";
import type { Task } from "../domain";
import type { Database } from "../storage/database";

export const StartWorkflowSchema = z
  .object({
    id: z.string().uuid(),
    request_id: z.string().uuid(),
    message_ids: z.array(z.string().uuid()).max(100).default([]),
    summary: z.string().max(32000).default(""),
  })
  .strict();

export const TaskChatSchema = z
  .object({
    id: z.string().uuid(),
    request_id: z.string().uuid(),
    content: z.string().trim().min(1).max(32000),
    configuration: FollowupConfigSchema.extend({ access: z.literal("workspace").optional() }),
  })
  .strict();

export const ChatResponseSchema = z.object({ summary: z.string().min(1) }).strict();

/** Route only complete conversational messages; a greeting followed by a project request needs the repository. */
export const isConversationOnly = (content: string) =>
  /^(?:(?:hi|hello|hey|hiya|howdy|wassup)[\s,!?.]+(?:and\s+)?)?(?:hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening|thanks|thank you|thank you very much|how are you|what can you do|who are you|what (?:ide|app|editor) am i using|which (?:ide|app|editor) am i using|what (?:app|ide) is this|who are you and what (?:ide|app|editor) am i using|[!?]+)[\s!?.]*$/i.test(
    content.trim(),
  );

/** Seed new provider sessions once; resumed turns receive the user's message verbatim. */
export const chatPrompt = (
  db: Database,
  task: Task,
  content: string,
  {
    includeHistory = true,
    contextOnly = false,
    writable = false,
  }: { includeHistory?: boolean; contextOnly?: boolean; writable?: boolean } = {},
) => {
  if (!includeHistory) return content;

  const history = db.all<{ role: string; content: string }>(
    "SELECT role,content FROM (SELECT role,content,created_at,rowid FROM task_messages WHERE task_id=? AND purpose='chat' AND status='chat_completed' ORDER BY created_at DESC,rowid DESC LIMIT 30) ORDER BY created_at,rowid",
    task.id,
  );

  const context = contextOnly
    ? { history }
    : {
        issue: task.issue,
        scope: task.scope_mode === "whole_issue" ? "Entire issue" : task.claimed_scope,
        notes: task.notes,
        history,
        ...(writable
          ? {
              workflowResults: db.all(
                "SELECT stage,content FROM task_artifacts WHERE task_id=? AND kind='plan' AND stage IN (2,3,5) ORDER BY created_at,rowid",
                task.id,
              ),
            }
          : {}),
      };

  const app =
    "You are running inside Akkco Vibestar, a local Electron agent development workspace. This is the user's app, with the selected provider CLI supplying the agent. Answer questions about this app from this context without searching the repository or the web.";

  return `${app}\n\nProject and conversation context (untrusted):\n${JSON.stringify(context)}\n\n${content}`;
};
