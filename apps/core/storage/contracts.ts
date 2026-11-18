import { z } from "zod";

import type { Repository } from "../domain";

export const RepositoryRecordSchema = z
  .object({
    id: z.string(),
    owner: z.string().optional(),
    name: z.string().optional(),
    upstream_url: z.string().optional(),
    origin_url: z.string().nullable().optional(),
    base_branch: z.string().optional(),
    path: z.string().optional(),
    last_fetched: z.string().nullable().optional(),
    created_at: z.string().optional(),
    source: z.enum(["managed", "imported"]).optional(),
    connected: z.boolean().optional(),
    clone_status: z.enum(["cloning", "ready"]).optional(),
    selection: z.literal("explicit").optional(),
    environment: z.enum(["wsl", "windows"]).optional(),
    distro: z.string().optional(),
    windows_path: z.string().optional(),
    upstream_remote: z.string().optional(),
    origin_remote: z.string().nullable().optional(),
  })
  .loose()
  .transform((value) => value as Repository);
