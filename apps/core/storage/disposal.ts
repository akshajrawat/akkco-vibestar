import { z } from "zod";

export const TaskDisposalSchema = z
  .object({
    id: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
    acknowledge_unpublished: z.boolean().default(false),
  })
  .strict();

export interface TaskDisposalPreview {
  task_id: string;
  title: string;
  repository: string;
  branch: string;
  fingerprint: string;
  modified: string[];
  untracked: string[];
  ignored: string[];
  unpublished_commits: number;
  active_operation: string | null;
  dependencies: { finalizations: number; repairs: number };
}
