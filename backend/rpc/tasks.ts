import { z } from "zod";

import { AdeError, now, parseIssue } from "../domain";
import {
  BrowserEnvironmentReportSchema,
  VerificationEnvironmentSchema,
} from "../execution/verification/browser/contracts";
import { browserEnvironmentProbe } from "../execution/verification/browser/probe";
import { taskVerification } from "../execution/verification/task-verification";
import { fetchIssue } from "../workspace/issue";
import type { RpcServices } from "./services";
import { idInput } from "./validation";

export const tasksMethods = [
  "task.browser.configure",
  "task.browser.inspect",
  "task.detail",
  "task.preview",
  "task.cancel",
  "task.diff",
  "task.file",
  "task.discard",
  "task.command",
] as const;

/** Validates and dispatches tasks requests through their existing domain services. */
export const callTasks = async (
  services: Pick<RpcServices, "engine" | "terminals">,
  method: string,
  input: unknown,
) => {
  const e = services.engine;

  switch (method) {
    case "task.browser.configure": {
      const p = idInput
        .extend({
          environment: VerificationEnvironmentSchema,
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input);

      e.assertAvailable();
      const task = e.db.task(p.id);
      if (e.isActive(p.id) || task.status === "queued")
        throw new AdeError(
          "busy",
          "Wait for this task's run and terminal to stop before changing verification environments.",
        );
      await e.git.assertTask(task);
      const latest = e.db.task(p.id);
      if (e.isActive(p.id) || latest.status === "queued")
        throw new AdeError(
          "busy",
          "This task became active while its verification environment was being checked.",
        );

      e.db.saveTask({
        ...latest,
        verification_environment: p.environment,
        browser_environment_report: undefined,
        updated_at: now(),
      });

      e.changed(p.id);
      return { environment: p.environment };
    }

    case "task.browser.inspect": {
      const p = idInput.strict().parse(input);
      const task = e.db.task(p.id);
      await e.git.assertTask(task);

      const result = await e.runCommand(
        p.id,
        [
          process.execPath,
          "-e",
          browserEnvironmentProbe,
          e.db.task(p.id).verification_environment || "isolated",
        ],
        true,
      );

      if (result.code !== 0)
        throw new AdeError(
          "browser_environment",
          result.stderr || "Browser environment probe failed. Inspect the saved command evidence.",
        );
      const report = BrowserEnvironmentReportSchema.parse(JSON.parse(result.stdout));
      const latest = e.db.task(p.id);
      if ((latest.verification_environment || "isolated") !== report.environment)
        throw new AdeError(
          "stale_environment",
          "The verification environment changed. Inspect it again explicitly.",
        );

      e.db.saveTask({
        ...latest,
        browser_environment_report: report,
        updated_at: now(),
      });

      e.changed(p.id);
      return report;
    }

    case "task.detail": {
      const id = z
        .object({ id: z.string().min(1).max(1000) })
        .strict()
        .parse(input).id;

      const detail = e.db.detail(id);
      return {
        ...detail,
        validation: taskVerification(e.db, id),
        active: e.isActive(id),
        executing: e.isExecuting(id),
      };
    }

    case "task.preview": {
      const p = z
        .object({
          repository_id: z.string().uuid(),
          issue_url: z.string().max(2000),
        })
        .strict()
        .parse(input);

      const reference = parseIssue(p.issue_url);
      const repository = e.taskRepository(p.repository_id, reference);
      const issue = await fetchIssue(reference, e.root);
      return {
        reference,
        issue,
        repository,
      };
    }

    case "task.cancel": {
      const id = idInput.parse(input).id;
      await services.terminals.close(id);
      await e.cancel(id);
      return null;
    }

    case "task.diff":
      return e.git.diff(e.db.task(idInput.parse(input).id));

    case "task.file": {
      const p = idInput
        .extend({
          path: z.string(),
          old_path: z.string().nullable().optional(),
        })
        .parse(input);

      return e.git.file(e.db.task(p.id), p.path, p.old_path);
    }

    case "task.discard": {
      const p = idInput
        .extend({ path: z.string().optional(), confirmed: z.literal(true) })
        .parse(input);

      if (e.isActive(p.id))
        throw new AdeError("invalid_state", "Stop the task before discarding changes");
      await e.git.discard(e.db.task(p.id), p.path);
      e.changed(p.id);
      return null;
    }

    case "task.command": {
      const p = idInput.extend({ argv: z.array(z.string()).min(1).max(100) }).parse(input);
      return e.runCommand(p.id, p.argv);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
