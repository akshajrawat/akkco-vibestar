import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import type { CoreEvent } from "../../apps/core/domain";
import { Rpc } from "../../apps/core/rpc";
import { testProfileIds as builtInProfiles } from "../helpers/viber-fixtures";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import type { ViberSession } from "../../apps/core/vibers/contracts";
import { migrateDataRoot } from "../../apps/core/storage/migrate-root";
import { createFixtureEngine, fixtureRepository, detectFixtureProvider } from "../helpers/fixtures";

const fixture = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (original) => {
  const module = await original<typeof import("node:os")>();
  return { ...module, homedir: () => fixture.home || module.homedir() };
});

it.each(["codex", "antigravity"] as const)(
  "%s runs its native tool loop, recovers explicitly, and hands off across a restart",
  async (providerName) => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-native-session-"));
    fixture.home = join(directory, "home");
    const codexState = join(fixture.home, ".codex");
    const geminiState = join(fixture.home, ".gemini");
    const antigravityState = join(fixture.home, ".config", "antigravity");
    const requests: AgentRunRequest[] = [];
    const adapters = { codex: new CodexProvider(), antigravity: new AntigravityProvider() };
    let mode: "success" | "invalid" | "partial" | "truncated" | "wait" = "success";
    let sourcePath = "";
    let otherWorkspace = "";
    let handoffThreadId: string | undefined;
    const events: string[] = [];

    const providers = (_stage: number, name: "codex" | "antigravity" = providerName) => {
      const adapter = adapters[name];
      return {
        ...adapter,
        detect: async () => {
          const detection = { ...(await detectFixtureProvider()), provider: name };
          detection.models.push({ id: "other-model", supportedEfforts: ["low", "high"] });
          return detection;
        },
        invocation: (request: AgentRunRequest) => {
          requests.push(request);
          const invocation = adapter.invocation(request);

          const nativeId =
            request.conversation?.threadId ||
            (name === "antigravity" ? handoffThreadId : undefined) ||
            request.runId;

          const script = `
            const fs = require('node:fs');
            const cp = require('node:child_process');
            const emit = value => console.log(JSON.stringify(value));
            const nativeId = ${JSON.stringify(nativeId)};
            const resumeId = ${JSON.stringify(request.conversation?.threadId)};
            const mode = ${JSON.stringify(mode)};
            const toolLoop = prompt => {
              if (prompt !== ${JSON.stringify(request.prompt)}) throw Error('Wrong native prompt');
              if (mode === 'wait') { setInterval(() => {}, 1000); return; }
              for (const path of ${JSON.stringify([join(directory, "private.txt"), sourcePath, otherWorkspace].filter(Boolean))}) {
                try { fs.readFileSync(path); throw Error('Host or sibling files were exposed: ' + path); }
                catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
              }
              const visible = ${JSON.stringify(name === "codex" ? [codexState] : [geminiState, antigravityState])};
              const hidden = ${JSON.stringify(name === "codex" ? [geminiState, antigravityState] : [codexState])};
              for (const path of visible) {
                if (fs.readFileSync(path + '/fixture', 'utf8') !== 'synthetic state') throw Error('Selected provider state was not mounted');
              }
              for (const path of hidden) {
                if (fs.existsSync(path + '/fixture')) throw Error('Unselected provider state was mounted');
              }
              if (${JSON.stringify(name)} === 'codex' && fs.readFileSync(${JSON.stringify(join(codexState, "config.toml"))}, 'utf8') !== '') {
                throw Error('Codex config was not masked');
              }
              const before = fs.readFileSync('source.txt', 'utf8');
              fs.writeFileSync('source.txt', before + 'changed\\n');
              const verification = "if(!require('node:fs').readFileSync('source.txt','utf8').includes('changed'))process.exit(1)";
              const command = JSON.stringify([process.execPath, '-e', verification]);
              cp.execFileSync(process.execPath, ['-e', verification]);
              if (${JSON.stringify(name)} === 'codex') {
                emit({ method:'item/completed', params:{item:{id:'edit',type:'fileChange',status:'completed',changes:[{path:'source.txt',kind:'update'}]}} });
                emit({ method:'item/started', params:{item:{id:'check',type:'commandExecution',status:'inProgress',command}} });
                emit({ method:'item/completed', params:{item:{id:'check',type:'commandExecution',status:'completed',command,exitCode:0,aggregatedOutput:'verified'}} });
                emit({ method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:1000},last:{inputTokens:12}}} });
                emit({ method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'Native agent verified the edit.'}} });
                if(mode === 'partial') process.exit(2);
                if(mode !== 'truncated') emit({method:'turn/completed',params:{turn:{status:'completed'}}});
                else process.exit(0);
              } else {
                emit({event:'step_update',step_update:{step_index:1,step_type:'tool',tool_name:'replace_file_content',state:'DONE',tool_info:{parameters:{TargetFile:'source.txt'},output:'edited'}}});
                emit({event:'step_update',step_update:{step_index:2,step_type:'tool',tool_name:'run_command',state:'DONE',tool_info:{parameters:{CommandLine:command},exit_code:0,stdout:'verified'},usage:{input_tokens:12}}});
                emit({event:'step_update',step_update:{step_index:3,step_type:'agent_response',state:'DONE',text:'Native agent verified the edit.'}});
                if(mode === 'partial') process.exit(2);
                if(mode !== 'truncated') emit({event:'result',result:{status:'SUCCESS',response:'Native agent verified the edit.',conversation_id:nativeId,usage:{input_tokens:12}}});
              }
            };
            if (${JSON.stringify(name)} === 'codex') {
              require('node:readline').createInterface({input:process.stdin}).on('line', line => {
                const r=JSON.parse(line);
                if(r.method==='initialize') emit({id:r.id,result:{}});
                if(r.method==='thread/start' || r.method==='thread/resume') {
                  if (r.method !== (resumeId ? 'thread/resume' : 'thread/start') || r.params.threadId !== resumeId) throw Error('Wrong native thread request');
                  if(mode === 'invalid') { emit({id:r.id,error:{message:'Native thread not found'}}); return; }
                  emit({id:r.id,result:{thread:{id:nativeId}}});
                }
                if(r.method==='turn/start') { emit({id:r.id,result:{turn:{id:'turn'}}}); toolLoop(r.params.input[0].text); }
              });
            } else {
              const args = process.argv.slice(1);
              if(args.includes('--json-schema')) throw Error('Unexpected output schema');
              const resume = args.indexOf('--conversation');
              if ((resume === -1 ? undefined : args[resume + 1]) !== resumeId) throw Error('Wrong resume identity');
              if(mode === 'invalid') { console.error('Native thread not found'); process.exit(1); }
              let input='';
              process.stdin.on('data', chunk => input += chunk);
              process.stdin.on('end', () => {
                emit({event:'init',init:{conversation_id:nativeId,model:${JSON.stringify(request.config.model)}}});
                toolLoop(JSON.parse(input).message.content);
              });
            }
          `;

          return {
            ...invocation,
            args: ["-e", script, "--", ...invocation.args],
          };
        },
      };
    };

    let engine = await createFixtureEngine(join(directory, "data"), providers);
    let rpc = new Rpc(engine);
    try {
      const bin = join(fixture.home, ".local", "bin");
      await mkdir(bin, { recursive: true });
      for (const executable of ["codex", "agy"]) {
        await writeFile(join(bin, executable), '#!/bin/sh\nexec node "$@"\n', { mode: 0o700 });
      }

      for (const state of [codexState, geminiState, antigravityState]) {
        await mkdir(state, { recursive: true });
        await writeFile(join(state, "fixture"), "synthetic state");
      }

      await writeFile(join(codexState, "config.toml"), "SYNTHETIC_CONFIG");
      await writeFile(join(directory, "private.txt"), "host-only");
      const { repo } = await fixtureRepository(engine, directory);
      sourcePath = join(repo.path, "source.txt");
      const profileId = builtInProfiles.implementer;
      const profile = engine.vibers.profile(profileId);
      const selection = { provider: providerName, model: "next-model", effort: "high" };

      const create = async (pId: string = profileId) =>
        (await rpc.call("viber.session.create", {
          request_id: randomUUID(),
          profile_id: pId,
          repository_id: repo.id,
          selection,
        })) as ViberSession;

      const session = await create();

      const send = (extra: Record<string, unknown> = {}) =>
        rpc.call("viber.session.send", {
          session_id: session.id,
          profile_id: profileId,
          request_id: randomUUID(),
          content: "Edit source and verify it",
          history_ids: [],
          ...extra,
        });

      const settled = async (status = "completed", target = session) => {
        await expect
          .poll(
            () =>
              engine.viberSessions.store
                .detail(target.id, target.profile_id)
                .messages.filter((message) => message.role === "user")
                .at(-1)?.status,
            { timeout: 10000 },
          )
          .toBe(status);

        await expect.poll(() => engine.isActive(`viber:${target.id}`)).toBe(false);
        return engine.viberSessions.store.session(target.id, target.profile_id);
      };

      const onEvent = (event: CoreEvent) => {
        if (event.event === "utility.event") {
          events.push(String(event.kind));
        }
      };

      engine.on("event", onEvent);
      expect(requests).toEqual([]);
      await send();
      const first = await settled();
      const workspace = engine.viberSessions.store.workspace(session.id);
      expect(workspace.repo_id).toBe(repo.id);
      expect(workspace.worktree_path).not.toBe(repo.path);
      expect(await engine.git.assertOwnedTask(workspace)).toBe(workspace.worktree_path);
      expect(await readFile(sourcePath, "utf8")).toBe("base\n");

      expect(await readFile(join(workspace.worktree_path, "source.txt"), "utf8")).toBe(
        "base\nchanged\n",
      );

      expect(
        await rpc.call("viber.session.inspect", {
          session_id: session.id,
          profile_id: profileId,
          path: "source.txt",
        }),
      ).toMatchObject({ files: ["source.txt"], text: "base\nchanged\n" });

      expect(events).toEqual(
        expect.arrayContaining(["file.changed", "command.finished", "message", "run.completed"]),
      );

      expect(engine.db.all("SELECT input_tokens,provider_session_id FROM ai_usage")).toEqual([
        { input_tokens: 12, provider_session_id: first.thread?.thread_id },
      ]);

      expect(first.thread).toMatchObject({
        provider: providerName,
        model: "next-model",
        status: "ready",
      });

      expect(engine.vibers.profile(profileId)).toEqual(profile);

      engine.off("event", onEvent);
      await rpc.close();
      await engine.close();
      engine = await createFixtureEngine(join(directory, "data"), providers);
      rpc = new Rpc(engine);
      expect(requests).toHaveLength(1);
      for (let index = 0; index < 60; index++) {
        engine.db.run(
          "INSERT INTO viber_messages(id,session_id,role,content,status,created_at) VALUES(?,?,'assistant',?,'completed',?)",
          randomUUID(),
          session.id,
          `Retained message ${index}`,
          new Date().toISOString(),
        );
      }

      await send({ content: "Continue with one new instruction" });
      await settled();
      expect(requests[1].conversation).toEqual({ threadId: first.thread?.thread_id });
      expect(requests[1].prompt).toBe("Continue with one new instruction");
      expect(requests[1].cwd).toBe(workspace.worktree_path);

      const siblingProfileId = randomUUID();

      engine.vibers.saveProfile(
        {
          ...profile,
          id: siblingProfileId,
          name: "Sibling Implementer",
        },
        null,
      );

      const sibling = await create(siblingProfileId);

      engine.viberSessions.send({
        session_id: sibling.id,
        profile_id: siblingProfileId,
        request_id: randomUUID(),
        content: "Sibling edit",
        history_ids: [],
      });

      await settled("completed", sibling);

      otherWorkspace = join(
        engine.viberSessions.store.workspace(sibling.id).worktree_path,
        "source.txt",
      );

      expect(requests[2].conversation).toEqual({});
      expect(requests[2].cwd).not.toBe(workspace.worktree_path);

      await send({ selection: { ...selection, model: "other-model", effort: "low" } });
      const changed = await settled();
      expect(requests[3].conversation).toEqual({});
      expect(requests[3].prompt).not.toContain("Retained message");
      expect(changed.thread?.thread_id).not.toBe(first.thread?.thread_id);
      expect(changed.selection).toMatchObject({ model: "other-model", effort: "low" });
      await send({ selection: { ...changed.selection, effort: "high" } });
      await settled();
      expect(requests[4].conversation).toEqual({ threadId: changed.thread?.thread_id });
      expect(requests[4].config.effort).toBe("high");

      mode = "invalid";
      const before = await readFile(join(workspace.worktree_path, "source.txt"), "utf8");
      const failedRequest = { request_id: randomUUID(), content: "Do not replay this request" };
      await send(failedRequest);
      await settled("failed");
      expect(await readFile(join(workspace.worktree_path, "source.txt"), "utf8")).toBe(before);
      expect(requests).toHaveLength(6);
      await send(failedRequest);
      expect(requests).toHaveLength(6);
      await expect(send()).rejects.toThrow("acknowledge");
      mode = "success";

      await send({
        selection,
        acknowledge_uncertain: true,
        content: "Inspect current files before the next edit",
      });

      await settled();
      expect(requests[6].conversation).toEqual({});
      expect(requests[6].prompt).not.toContain("Do not replay");

      mode = "partial";
      await send({ content: "A turn that changes files before failing" });
      await settled("failed");
      expect(await readFile(join(workspace.worktree_path, "source.txt"), "utf8")).not.toBe(before);
      await expect(send()).rejects.toThrow("acknowledge");
      mode = "success";

      const partialThread = engine.viberSessions.store.session(session.id, profileId).thread
        ?.thread_id;

      await send({
        acknowledge_uncertain: true,
        content: "Inspect partial changes; continue only this instruction",
      });

      await settled();
      expect(requests.at(-1)?.conversation).toEqual({ threadId: partialThread });

      expect(requests.at(-1)?.prompt).toBe(
        "Inspect partial changes; continue only this instruction",
      );

      mode = "truncated";
      await send();
      await settled("failed");

      expect(
        engine.viberSessions.store.detail(session.id, profileId).messages.at(-1)?.error,
      ).toContain("completed native turn");

      mode = "wait";
      await send({ acknowledge_uncertain: true });

      await expect
        .poll(
          () =>
            engine.db.all<{ pid: number }>(
              "SELECT pid FROM utility_runs WHERE viber_session_id=? ORDER BY rowid DESC LIMIT 1",
              session.id,
            )[0]?.pid,
        )
        .toBeGreaterThan(1);

      const count = requests.length;
      await rpc.close();
      await engine.close();
      engine = await createFixtureEngine(join(directory, "data"), providers);
      rpc = new Rpc(engine);
      expect(requests).toHaveLength(count);

      expect(engine.viberSessions.store.detail(session.id, profileId).messages.at(-1)?.status).toBe(
        "interrupted",
      );

      await expect(send()).rejects.toThrow("acknowledge");
      mode = "success";

      await send({
        acknowledge_uncertain: true,
        content: "Continue after inspecting interrupted activity",
      });

      await settled();
      expect(requests.at(-1)?.conversation?.threadId).toBeTruthy();
      const otherProvider = providerName === "codex" ? "antigravity" : "codex";

      const previousSession = engine.viberSessions.store.session(session.id, profileId);
      const previousThread = previousSession.thread?.thread_id;
      const previousSelection = previousSession.selection;
      expect(previousThread).toBeTruthy();
      if (providerName === "codex") {
        // Each provider owns its namespace and can issue the same opaque ID.
        handoffThreadId = previousThread;
      }

      const detail = () => engine.viberSessions.store.detail(session.id, profileId);
      const priorMessages = detail().messages;

      const priorHistory = priorMessages
        .filter(({ status }) => status === "completed")
        .map(({ role, content }) => ({ role, content }));

      const workspaceFile = join(workspace.worktree_path, "source.txt");
      const beforeHandoff = await readFile(workspaceFile, "utf8");
      const beforeHandoffCount = requests.length;

      const handoff = {
        request_id: randomUUID(),
        selection: { ...selection, provider: otherProvider },
        content: "Apply the first checkpoint with the other provider",
      };

      await send(handoff);
      const switched = await settled();
      const bootstrap = requests[beforeHandoffCount];
      expect(bootstrap.conversation).toEqual({});
      expect(bootstrap.cwd).toBe(workspace.worktree_path);

      const priorHistoryText = priorHistory
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n\n");

      expect(JSON.parse(bootstrap.prompt.slice(bootstrap.prompt.indexOf("\n\n") + 2))).toEqual({
        instructions: profile.instructions,
        inputs: [
          {
            role: "context",
            content: `[The following conversation occurred with another provider]:\n${priorHistoryText}`,
          },
          { role: "user", content: handoff.content },
        ],
      });

      expect(switched.thread).toMatchObject({
        provider: otherProvider,
        thread_id: handoffThreadId || bootstrap.runId,
        status: "ready",
      });

      const followUp = "Apply the second checkpoint with the other provider";
      await send({ content: followUp });
      await settled();

      expect(requests[beforeHandoffCount + 1]).toMatchObject({
        conversation: { threadId: switched.thread?.thread_id },
        prompt: followUp,
      });

      const afterSwitch = detail();
      await rpc.close();
      await engine.close();
      engine = await createFixtureEngine(join(directory, "data"), providers);
      rpc = new Rpc(engine);

      await send(handoff);
      expect(detail()).toEqual(afterSwitch);
      expect(requests).toHaveLength(beforeHandoffCount + 2);
      expect(await readFile(workspaceFile, "utf8")).toBe(`${beforeHandoff}changed\nchanged\n`);

      const returnTurn = {
        request_id: randomUUID(),
        selection: previousSelection,
        content: "Apply the final checkpoint with the original provider",
      };

      await send(returnTurn);
      const returned = await settled();
      expect(returned.thread).toEqual(previousSession.thread);
      const resumed = requests[beforeHandoffCount + 2];
      expect(resumed.conversation).toEqual({ threadId: previousThread });
      expect(resumed.cwd).toBe(workspace.worktree_path);

      expect(resumed.prompt).toBe(
        [
          "[Reference only. The following conversation occurred with another provider since your last turn in this thread. Act only on the current user instruction.]:",
          `User: ${handoff.content}`,
          "",
          "Assistant: Native agent verified the edit.",
          "",
          `User: ${followUp}`,
          "",
          "Assistant: Native agent verified the edit.",
          "",
          "[Current user instruction]:",
          returnTurn.content,
        ].join("\n"),
      );

      await send(returnTurn);
      expect(requests).toHaveLength(beforeHandoffCount + 3);
      const messages = detail().messages;
      expect(messages.slice(0, priorMessages.length)).toEqual(priorMessages);

      expect(
        messages
          .slice(priorMessages.length)
          .map(({ role, content, status }) => ({ role, content, status })),
      ).toEqual(
        [handoff.content, followUp, returnTurn.content].flatMap((content) => [
          { role: "user", content, status: "completed" },
          { role: "assistant", content: "Native agent verified the edit.", status: "completed" },
        ]),
      );

      const continued = "Continue after the round trip";
      await send({ content: continued });
      await settled();

      expect(requests.at(-1)).toMatchObject({
        conversation: { threadId: previousThread },
        prompt: continued,
      });

      await send({ selection: handoff.selection, content: "Switch again" });
      await settled();
      const nextSwitch = requests.at(-1)!;
      expect(nextSwitch.conversation).toEqual({ threadId: switched.thread?.thread_id });
      expect(nextSwitch.prompt).toContain(returnTurn.content);
      expect(nextSwitch.prompt).toContain(continued);
      expect(nextSwitch.prompt).not.toContain(handoff.content);
      expect(nextSwitch.prompt).not.toContain(followUp);

      expect(await readFile(workspaceFile, "utf8")).toBe(
        `${beforeHandoff}${"changed\n".repeat(5)}`,
      );

      expect(engine.vibers.profile(profileId)).toEqual(profile);
      expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);

      await expect(rpc.call("repository.remove", { id: repo.id, confirmed: true })).rejects.toThrow(
        "Viber sessions",
      );

      await rpc.close();
      await engine.close();

      await expect(migrateDataRoot(engine.root, join(directory, "moved"))).rejects.toThrow(
        "Viber workspaces",
      );
    } finally {
      await rpc.close();
      await engine.close();
      fixture.home = "";
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
