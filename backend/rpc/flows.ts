import { z } from "zod";

import { AdeError, now } from "../domain";
import {
  AgentProfileSchema,
  CanvasLayoutSchema,
  FlowDefinitionSchema,
  GeneralTaskCreateSchema,
  IssueTaskCreateSchema,
} from "../flows/contracts";
import { ApprovalDecisionSchema, FlowStartSchema, ViberChatSchema } from "../flows/run-contracts";
import { flowTemplates } from "../flows/templates";
import type { RpcServices } from "./services";
import { managedFiles } from "../flows/files";
import { ContinuationTargetSchema, ContinuationApplySchema } from "../flows/continuation";
import { flowWorkspace, historicalWorkspace, viberInstances } from "../flows/workspace";

const identity = z.string().uuid();
const taskInput = z.object({ task_id: identity }).strict();
const runInput = z.object({ run_id: identity }).strict();

export const flowMethods = [
  "profile.list",
  "profile.save",
  "flow.templates",
  "flow.workspace",
  "flow.history",
  "flow.files",
  "flow.save",
  "flow.layout",
  "flow.start",
  "viber.chat",
  "viber.instances",
  "flow.pause",
  "flow.continue",
  "flow.continuation.preview",
  "flow.continuation.apply",
  "flow.cancel",
  "flow.node.run",
  "flow.node.retry",
  "flow.node.approve",
  "task.createGeneral",
  "task.createIssue",
  "task.lifecycle",
] as const;

export const callFlows = async (
  services: Pick<RpcServices, "engine">,
  method: string,
  raw: unknown,
) => {
  const e = services.engine;
  switch (method) {
    case "viber.instances":
      z.object({}).strict().parse(raw);
      return viberInstances(e);
    case "profile.list":
      return e.db
        .all<{ id: string }>("SELECT id FROM agent_profiles ORDER BY created_at,id")
        .flatMap(({ id }) => {
          try {
            return [e.flows.profile(id)];
          } catch (error) {
            if (error instanceof AdeError && error.kind === "corrupt_record") return [];
            throw error;
          }
        });
    case "profile.save": {
      e.assertAvailable();

      const p = z
        .object({
          profile: AgentProfileSchema,
          expected_revision: z.number().int().positive().nullable(),
        })
        .strict()
        .parse(raw);

      const saved = e.flows.saveProfile(p.profile, p.expected_revision);
      e.changed();
      return saved;
    }

    case "flow.templates":
      return flowTemplates;
    case "task.createGeneral":
      return e.createGeneralTask(GeneralTaskCreateSchema.parse(raw));
    case "task.createIssue":
      return e.createIssueTask(IssueTaskCreateSchema.parse(raw));
    case "flow.workspace":
      return flowWorkspace(e, taskInput.parse(raw).task_id);
    case "flow.history":
      return historicalWorkspace(
        e,
        z
          .object({ task_id: z.string().min(1).max(1000) })
          .strict()
          .parse(raw).task_id,
      );
    case "flow.files": {
      const p = taskInput
        .extend({ path: z.string().min(1).max(2000).optional() })
        .strict()
        .parse(raw);

      return managedFiles(e.root, e.db.task(p.task_id), p.path);
    }

    case "flow.save": {
      e.assertAvailable();

      const p = taskInput
        .extend({
          definition: FlowDefinitionSchema,
          expected_revision: z.number().int().positive(),
        })
        .strict()
        .parse(raw);

      const task = e.db.task(p.task_id);
      if (!task.flow_id) throw new AdeError("invalid_state", "This task has no editable flow.");

      const result = e.flows.saveDefinition(
        task.flow_id,
        p.definition,
        p.expected_revision,
        task.id,
      );

      e.changed(task.id);
      return result;
    }

    case "flow.layout": {
      e.assertAvailable();
      const p = taskInput.extend({ layout: CanvasLayoutSchema }).strict().parse(raw);
      const task = e.db.task(p.task_id);
      if (!task.flow_id) throw new AdeError("invalid_state", "This task has no canvas.");
      return e.flows.saveLayout(task.flow_id, p.layout);
    }

    case "flow.start":
      return e.startFlow(FlowStartSchema.parse(raw));
    case "viber.chat":
      return e.chatViber(ViberChatSchema.parse(raw));
    case "flow.pause":
      return e.pauseFlow(runInput.parse(raw).run_id);
    case "flow.cancel":
      return e.cancelFlow(runInput.parse(raw).run_id);
    case "flow.continue":
      return e.continueFlow(runInput.extend({ request_id: identity }).strict().parse(raw));
    case "flow.continuation.preview":
      return e.previewFlowContinuation(ContinuationTargetSchema.parse(raw));
    case "flow.continuation.apply":
      return e.applyFlowContinuation(ContinuationApplySchema.parse(raw));
    case "flow.node.run":
      return e.runFlowNode(
        runInput.extend({ request_id: identity, node_id: identity }).strict().parse(raw),
      );
    case "flow.node.retry":
      return e.retryFlowNode(
        runInput
          .extend({ request_id: identity, node_id: identity, attempt_id: identity })
          .strict()
          .parse(raw),
      );
    case "flow.node.approve":
      return e.approveFlowNode(ApprovalDecisionSchema.omit({ created_at: true }).parse(raw));
    case "task.lifecycle": {
      e.assertAvailable();

      const p = taskInput
        .extend({ action: z.enum(["finish", "reopen"]) })
        .strict()
        .parse(raw);

      const task = e.db.task(p.task_id);
      if (!task.flow_id)
        throw new AdeError(
          "invalid_state",
          "Inspect this task’s recovery diagnostic or create a new task with explicit Viber settings.",
        );
      if (
        e.cleanupBlockers(task.id).length ||
        e.db.all(
          "SELECT id FROM flow_runs WHERE task_id=? AND status IN ('queued','running','pausing','waiting')",
          task.id,
        ).length
      )
        throw new AdeError("busy", "Pause or stop execution before changing the task lifecycle.");

      e.db.saveTask({
        ...task,
        status: p.action === "finish" ? "completed" : "not_started",
        updated_at: now(),
      });

      e.changed(task.id);
      return e.db.task(task.id);
    }

    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
