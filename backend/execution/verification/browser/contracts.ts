import { z } from "zod";

export const VerificationEnvironmentSchema = z.enum(["isolated", "installed_browsers"]);
export type VerificationEnvironment = z.infer<typeof VerificationEnvironmentSchema>;

const observation = z
  .object({
    outcome: z.enum(["available", "blocked", "unavailable"]),
    detail: z.string().max(6000),
  })
  .strict();

export const BrowserEnvironmentReportSchema = z
  .object({
    checked_at: z.string().datetime(),
    environment: VerificationEnvironmentSchema,
    packages: z.array(z.object({ name: z.string(), path: z.string() }).strict()).max(3),
    browsers: z.array(z.string()).max(30),
    dns: observation,
    socket: observation,
    direct_file: observation,
    http: observation,
    note: z.string(),
  })
  .strict();

export type BrowserEnvironmentReport = z.infer<typeof BrowserEnvironmentReportSchema>;
