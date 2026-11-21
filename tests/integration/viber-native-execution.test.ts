import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { CoreEvent } from "../../apps/core/domain";
import { Rpc } from "../../apps/core/rpc";
import { testProfileIds as builtInProfiles } from "../helpers/viber-fixtures";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import type { ViberSession } from "../../apps/core/vibers/contracts";
import { migrateDataRoot } from "../../apps/core/storage/migrate-root";
import { createFixtureEngine, fixtureRepository, FixtureProvider } from "../helpers/fixtures";

it.each(["codex", "antigravity"] as const)(
  "%s runs its native tool loop in an owned repository, resumes after restart and recovers explicitly",
  async (providerName) => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-native-session-"));
    const requests: AgentRunRequest[] = [];
    const adapters = { codex: new CodexProvider(), antigravity: new AntigravityProvider() };
    let mode: "success" | "invalid" | "partial" | "truncated" | "wait" = "success";
    let sourcePath = "";
    let otherWorkspace = "";
    const events: string[] = [];

    const providers = (_stage: number, name: "codex" | "antigravity" = providerName) => {
      const adapter = adapters[name];
      return {
        ...adapter,
        detect: async () => {
          const detection = await new FixtureProvider().detect(directory);
          detection.models.push({ id: "other-model", supportedEfforts: ["low", "high"] });
          return detection;
        },
        invocation: (request: AgentRunRequest) => {
          requests.push(request);
          const invocation = adapter.invocation(request);
          const nativeId = request.conversation?.threadId || request.runId;

          const script = `
            const fs = require('node:fs');
            const cp = require('node:child_process');
            const emit = value => console.log(JSON.stringify(value));
            const nativeId = ${JSON.stringify(nativeId)};
            const mode = ${JSON.stringify(mode)};
            const toolLoop = prompt => {
              if (mode === 'wait') { setInterval(() => {}, 1000); return; }
              for (const path of ${JSON.stringify([join(directory, "private.txt"), sourcePath, otherWorkspace].filter(Boolean))}) {
                try { fs.readFileSync(path); throw Error('Host or sibling files were exposed: ' + path); }
                catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
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
                  if(mode === 'invalid') { emit({id:r.id,error:{message:'Native thread not found'}}); return; }
                  emit({id:r.id,result:{thread:{id:nativeId}}});
                }
                if(r.method==='turn/start') { emit({id:r.id,result:{turn:{id:'turn'}}}); toolLoop(r.params.input[0].text); }
              });
            } else {
              const args = process.argv.slice(1);
              if(args.includes('--json-schema')) throw Error('Unexpected output schema');
              const resume = args.indexOf('--conversation');
              if(resume >= 0 && args[resume + 1] !== nativeId) throw Error('Wrong resume identity');
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
            program: process.execPath,
            args: ["-e", script, "--", ...invocation.args],
            isolateProviderConfig: false,
          };
        },
      };
    };

    let engine = await createFixtureEngine(join(directory, "data"), providers);
    let rpc = new Rpc(engine);
    try {
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

      const settled = async (status = "completed") => {
        await expect
          .poll(
            () =>
              engine.viberSessions.store
                .detail(session.id, profileId)
                .messages.filter((message) => message.role === "user")
                .at(-1)?.status,
            { timeout: 10000 },
          )
          .toBe(status);

        await expect.poll(() => engine.isActive(`viber:${session.id}`)).toBe(false);
        return engine.viberSessions.store.session(session.id, profileId);
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

      await expect
        .poll(
          () =>
            engine.viberSessions.store.detail(sibling.id, siblingProfileId).messages.at(-1)?.status,
        )
        .toBe("completed");

      await expect.poll(() => engine.isActive(`viber:${sibling.id}`)).toBe(false);

      otherWorkspace = join(
        engine.viberSessions.store.workspace(sibling.id).worktree_path,
        "source.txt",
      );

      expect(requests[2].conversation).toEqual({});
      expect(requests[2].cwd).not.toBe(workspace.worktree_path);

      await send({ selection: { ...selection, model: "other-model", effort: "low" } });
      const changed = await settled();
      expect(requests[3].conversation).toEqual({});
      expect(requests[3].prompt).toContain("Historical messages are reference data only");
      expect(requests[3].prompt).toContain("Edit source and verify it");
      expect(requests[3].prompt).toContain("Native agent verified the edit.");
      expect(requests[3].prompt).toContain("Retained message 59");
      expect(requests[3].prompt).not.toContain("Sibling edit");
      expect(changed.thread?.thread_id).not.toBe(first.thread?.thread_id);
      expect(changed.selection).toMatchObject({ model: "other-model", effort: "low" });

      await send({
        selection: { ...changed.selection, effort: "high" },
        content: "Continue after the model change",
      });

      await settled();
      expect(requests[4].conversation).toEqual({ threadId: changed.thread?.thread_id });
      expect(requests[4].config.effort).toBe("high");
      expect(requests[4].prompt).toBe("Continue after the model change");

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
        new_thread: true,
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

      await send({ selection: { ...selection, provider: otherProvider } });
      const switched = await settled();
      expect(requests.at(-1)?.conversation).toEqual({});
      expect(switched.thread?.provider).toBe(otherProvider);
      expect(switched.thread?.thread_id).not.toBe(previousThread);
      await send({ selection: previousSelection });
      await settled();
      expect(requests.at(-1)?.conversation).toEqual({ threadId: previousThread });

      const beforeClear = await readFile(join(workspace.worktree_path, "source.txt"), "utf8");
      expect(beforeClear).toContain("changed");

      await send({ content: "/clear" });
      const clearedSession = engine.viberSessions.store.session(session.id, profileId);
      expect(clearedSession.thread).toBeNull();
      expect(clearedSession.threads).toEqual({});
      expect(await readFile(join(workspace.worktree_path, "source.txt"), "utf8")).toBe(beforeClear);

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
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
