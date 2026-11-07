import { expect, it, vi } from "vitest";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRunner } from "../../backend/execution/agents/agent-runner";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";
import { AntigravityProvider } from "../../backend/execution/providers/antigravity";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  plan1,
  prepareFixtureTask,
  fixtureFlowTask,
  waitForFixtureFlow,
} from "../helpers/fixtures";

vi.mock("../../backend/workspace/issue", () => ({
  fetchIssue: vi.fn(async () => ({ title: "Fixture issue", body: "Unrelated project context" })),
}));

it("delivers a large planning prompt and schema through the production sandbox without oversized argv or source writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-antigravity-input-"));
  const antigravity = new AntigravityProvider();
  let promptBytes = 0;

  const fixtureProvider = {
    ...antigravity,
    detect: () => new FixtureProvider().detect(),
    invocation: (request: AgentRunRequest) => {
      const invocation = antigravity.invocation(request);
      promptBytes = Buffer.byteLength(request.prompt);
      const digest = createHash("sha256").update(request.prompt).digest("hex");

      // Replace only the executable with an inert CLI; retain the adapter's
      // actual argv/stdin and the production runner's read-only sandbox.
      const script = `
        (async () => {
          const fs = require('node:fs/promises');
          const args = process.argv.slice(1);
          if (args[args.indexOf('--input-format') + 1] !== 'stream-json')
            throw Error('Missing streaming input mode');
          if (args.includes('-p') || args.includes('--print'))
            throw Error('Prompt still supplied through argv');
          const schema = JSON.parse(await fs.readFile(args[args.indexOf('--json-schema') + 1], 'utf8'));
          if (!schema.properties.summary) throw Error('Missing schema');
          let input = '';
          process.stdin.setEncoding('utf8');
          for await (const chunk of process.stdin) input += chunk;
          const lines = input.trimEnd().split('\\n');
          if (lines.length !== 1) throw Error('Expected exactly one prompt');
          const message = JSON.parse(lines[0]);
          if (message.event !== 'user') throw Error('Invalid input event');
          const digest = require('node:crypto').createHash('sha256').update(message.message.content).digest('hex');
          if (digest !== ${JSON.stringify(digest)}) throw Error('Prompt changed in transit');
          let denied = false;
          try { await fs.writeFile('source.txt', 'UNAUTHORIZED'); }
          catch (error) { if (error.code !== 'EROFS') throw error; denied = true; }
          if (!denied) throw Error('Planning source was writable');
          console.log(JSON.stringify({event: 'result', result: {
            status: 'SUCCESS', structured_output: ${JSON.stringify(plan1)}
          }}));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `;

      return {
        program: process.execPath,
        args: ["-e", script, "--", ...invocation.args],
        input: invocation.input,
      };
    },
  };

  const engine = await createFixtureEngine(join(directory, "data"), () => fixtureProvider);

  try {
    const { repo } = await fixtureRepository(engine, directory);

    const task = await prepareFixtureTask(engine, repo, randomUUID());

    const runner = new AgentRunner(engine.root, engine.db, engine.git, engine.publish, () => ({
      ...antigravity,
      detect: () => new FixtureProvider().detect(),
      invocation: fixtureProvider.invocation,
    }));

    const result = await runner.runConfigured(
      task,
      new AbortController().signal,
      {
        provider: "antigravity",
        model: "next-model",
        effort: "low",
        timeout_secs: 30,
        access: "read-only",
        output: "plan",
      },
      {
        purpose: "Large planning transport",
        prompt: 'Context "quoted"\n第二行 🪐\n'.repeat(16000),
      },
    );

    const detail = engine.db.detail(task.id);
    expect(promptBytes).toBeGreaterThan(128 * 1024);
    expect(detail.task.status).toBe("cancelled");
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: "completed", exit_code: 0, error: null });
    expect(result).toEqual(plan1);
    expect(await readFile(join(detail.task.worktree_path, "source.txt"), "utf8")).toBe("base\n");
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it.each(["streamed", "result-only"])(
  "saves a normal Antigravity %s answer without a response schema or workflow instructions",
  async (delivery) => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-antigravity-chat-"));
    const antigravity = new AntigravityProvider();

    const engine = await createFixtureEngine(join(directory, "data"), () => ({
      ...antigravity,
      detect: () => new FixtureProvider().detect(),
      invocation: (request) => {
        const invocation = antigravity.invocation(request);

        return {
          program: process.execPath,
          args: [
            "-e",
            `
              (async () => {
                const args = process.argv.slice(1);
                if (args.includes('--json-schema')) throw Error('Chat still requires JSON');
                if (!args.includes('--sandbox') || !args.includes('plan')) throw Error('Missing provider isolation');
                let input = '';
                for await (const chunk of process.stdin) input += chunk;
                const content = JSON.parse(input).message.content;
                if (!content.includes('hi?') || !content.includes('hi?') || content.includes('TASK CONTEXT:')) throw Error('Missing selected chat input or unexpected workflow instructions');
                const emit = value => console.log(JSON.stringify(value));
                if (${JSON.stringify(delivery)} === 'streamed') {
                  emit({event:'step_update',step_update:{step_type:'agent_response',step_index:1,state:'RUNNING',text_delta:'Hello! '}});
                  emit({event:'step_update',step_update:{step_type:'agent_response',step_index:1,state:'DONE',text_delta:'What can I help with?'}});
                  emit({event:'step_update',step_update:{step_type:'finish',step_index:2,state:'DONE'}});
                  emit({event:'result',result:{status:'SUCCESS'}});
                } else emit({event:'result',result:{status:'SUCCESS',response:'Hello! What can I help with?'}});
              })().catch(error => { console.error(error); process.exitCode = 1; });
            `,
            "--",
            ...invocation.args,
          ],
          input: invocation.input,
        };
      },
    }));

    try {
      const task = fixtureFlowTask(engine, null, "Direct Viber chat", {
        provider: "antigravity",
        access: "read-only",
        output: "conversation",
      });

      const node = engine.flows.definition(task.flow_id!).definition.nodes[0];
      if (node.type !== "agent") throw new Error("Missing Viber");

      const run = engine.chatViber({
        task_id: task.id,
        node_id: node.id,
        profile_id: node.profile_id,
        expected_revision: 1,
        request_id: randomUUID(),
        content: "hi?",
        history_ids: [],
        inputs: [],
      });

      await waitForFixtureFlow(engine, run);
      const detail = engine.db.detail(task.id);
      expect(detail.runs[0]).toMatchObject({ status: "completed", error: null });

      expect(JSON.parse(String(detail.messages.at(-1)?.content))).toEqual({
        summary: "Hello! What can I help with?",
      });

      expect(detail.task).toMatchObject({
        status: "not_started",
        stage: 0,
        repo_id: null,
        workspace_kind: "managed",
      });

      expect(detail.artifacts).toEqual([]);

      expect(
        detail.events.some(
          (event) =>
            String(event.kind).startsWith("command.") ||
            JSON.parse(String(event.data)).tool === "finish",
        ),
      ).toBe(false);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
