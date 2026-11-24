import { createHash, randomUUID } from "node:crypto";
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
import { exists } from "../../apps/core/workspace/paths";
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
    let mode:
      | "success"
      | "invalid"
      | "partial"
      | "truncated"
      | "wait"
      | "wait-before-init"
      | "resume-rejected"
      | "resume-missing"
      | "startup-error" = "success";
    let advanceForFallback: (() => void) | undefined;
    let sourcePath = "";
    let otherWorkspace = "";
    let handoffThreadId: string | undefined;
    let answerText = "Native agent verified the edit.";
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
          if (!request.conversation?.threadId) {
            advanceForFallback?.();
          }

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
            const model = ${JSON.stringify(request.config.model)};
            const mode = ${JSON.stringify(mode)};
            const answer = ${JSON.stringify(answerText)};
            const toolLoop = prompt => {
              if (prompt !== ${JSON.stringify(request.prompt)}) throw Error('Wrong native prompt');
              if (mode === 'wait') { setInterval(() => {}, 1000); return; }
              for (const path of ${JSON.stringify(
                [
                  join(directory, "private.txt"),
                  join(directory, "data", "state", "vibestar.sqlite.viber-key"),
                  join(directory, "data", "state", "vibestar-v1.sqlite.viber-key"),
                  sourcePath,
                  otherWorkspace,
                ].filter(Boolean),
              )}) {
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
                emit({ method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:answer}} });
                if(mode === 'partial') process.exit(2);
                if(mode !== 'truncated') emit({method:'turn/completed',params:{turn:{status:'completed'}}});
                else process.exit(0);
              } else {
                emit({event:'step_update',step_update:{step_index:1,step_type:'tool',tool_name:'replace_file_content',state:'DONE',tool_info:{parameters:{TargetFile:'source.txt'},output:'RAW_TOOL_OUTPUT'}}});
                emit({event:'step_update',step_update:{step_index:2,step_type:'tool',tool_name:'run_command',state:'DONE',tool_info:{parameters:{CommandLine:command},exit_code:0,stdout:'verified'},usage:{input_tokens:12}}});
                emit({event:'step_update',step_update:{step_index:3,step_type:'agent_response',state:'DONE',text:answer}});
                if(mode === 'partial') process.exit(2);
                if(mode !== 'truncated') emit({event:'result',result:{status:'SUCCESS',response:answer,conversation_id:nativeId,usage:{input_tokens:12}}});
              }
            };
            if (mode === 'wait-before-init') {
              setInterval(() => {}, 1000);
            } else if (${JSON.stringify(name)} === 'codex') {
              const expected = ${JSON.stringify(request.preload?.context)};
              const preloadOnly = ${JSON.stringify(!!request.preload?.only)};
              let confirmed = false;
              let missing = false;
              let injected = false;
              const checkContext = () => {
                if (!confirmed || (!!expected !== injected)) throw Error('Expected reference context before dispatch or preload exit');
              };
              require('node:readline').createInterface({input:process.stdin}).on('close', () => {
                if (preloadOnly && !missing) checkContext();
              }).on('line', line => {
                const r=JSON.parse(line);
                if(r.method==='initialize') emit({id:r.id,result:{}});
                if(r.method==='thread/start' || r.method==='thread/resume') {
                  if (r.method !== (resumeId ? 'thread/resume' : 'thread/start') || r.params.threadId !== resumeId) throw Error('Wrong native thread request');
                  if(mode === 'invalid' || (mode === 'resume-rejected' && resumeId)) {
                    missing = !!resumeId;
                    emit({id:r.id,error:{message:'no rollout found for thread id ' + resumeId}});
                    return;
                  }
                  if(mode === 'startup-error') {
                    emit({id:r.id,error:{message:'Backend unavailable'}});
                    return;
                  }
                  confirmed = true;
                  emit({id:r.id,result:{thread:{id:nativeId}}});
                }
                if (r.method === 'thread/inject_items') {
                  const [item] = r.params.items;
                  if (!confirmed || !expected || injected || r.params.threadId !== nativeId ||
                    r.params.items.length !== 1 || item.type !== 'message' || item.role !== 'assistant' ||
                    item.content.length !== 1 || item.content[0].type !== 'output_text' ||
                    item.content[0].text !== expected) throw Error('Wrong reference context');
                  injected = true;
                  emit({id:r.id,result:{}});
                }
                if(r.method==='turn/start') {
                  if (preloadOnly) throw Error('Preload dispatched a turn');
                  checkContext();
                  if (r.params.model !== model || r.params.threadId !== nativeId) throw Error('Wrong turn model or thread');
                  emit({id:r.id,result:{turn:{id:'turn'}}});
                  toolLoop(r.params.input[0].text);
                }
              });
            } else {
              const args = process.argv.slice(1);
              if(args.includes('--json-schema')) throw Error('Unexpected output schema');
              const resume = args.indexOf('--conversation');
              if ((resume === -1 ? undefined : args[resume + 1]) !== resumeId) throw Error('Wrong resume identity');
              if (args[args.indexOf('--model') + 1] !== model) throw Error('Wrong turn model');
              if(mode === 'invalid') { console.error('Native thread not found'); process.exit(1); }
              if(mode === 'startup-error') { console.error('Backend unavailable'); process.exit(1); }
              if(mode === 'resume-missing' && resumeId) {
                console.error('error: conversation ' + JSON.stringify(resumeId) + ' not found');
                process.exit(1);
              }
              const rejected = mode === 'resume-rejected' && resumeId;
              emit({event:'init',conversation_id:rejected ? 'unexpected-thread' : nativeId,init:{model}});
              let input='';
              process.stdin.on('data', chunk => input += chunk);
              process.stdin.on('end', () => {
                if (rejected) throw Error('Prompt sent before the thread was confirmed');
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

    expect(await exists(join(directory, "data", "state", "vibestar-v1.sqlite.viber-key"))).toBe(
      true,
    );

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
                .at(-1),
            { timeout: 10000 },
          )
          .toMatchObject({ status });

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

      const legacyThread = {
        ...first.thread!,
        configuration: createHash("sha256")
          .update(
            JSON.stringify({
              provider: providerName,
              model: providerName === "codex" ? selection.model : "",
              access: profile.execution.access,
              instructions: profile.instructions,
            }),
          )
          .digest("hex"),
      };

      engine.db.run(
        "UPDATE viber_sessions SET thread=?,threads=? WHERE id=?",
        JSON.stringify(legacyThread),
        JSON.stringify({ [providerName]: legacyThread }),
        session.id,
      );

      const modelSwitch = "Continue on the newly selected model";

      await send({
        selection: { ...selection, model: "other-model", effort: "low" },
        content: modelSwitch,
      });

      const changed = await settled();

      expect(requests[3]).toMatchObject({
        conversation: { threadId: first.thread?.thread_id },
        config: { model: "other-model", effort: "low" },
        prompt: modelSwitch,
      });

      expect(changed.thread).toMatchObject({
        thread_id: first.thread?.thread_id,
        model: "other-model",
      });

      expect(changed.thread?.configuration).not.toBe(legacyThread.configuration);
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
        selection,
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

      const interrupted = {
        request_id: randomUUID(),
        content: "Finish the original edit",
        acknowledge_uncertain: true,
      };

      await send(interrupted);

      await expect
        .poll(
          () =>
            engine.db.all<{ pid: number }>(
              "SELECT pid FROM utility_runs WHERE viber_session_id=? ORDER BY rowid DESC LIMIT 1",
              session.id,
            )[0]?.pid,
        )
        .toBeGreaterThan(1);

      const nativeIdFor = (messageId: string) =>
        engine.db.all<{ conversation_id: string | null }>(
          "SELECT conversation_id FROM utility_runs WHERE viber_message_id=?",
          messageId,
        )[0]?.conversation_id;

      await expect.poll(() => nativeIdFor(interrupted.request_id)).toBeTruthy();
      const interruptedThread = nativeIdFor(interrupted.request_id);
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

      const continueRequest = (messageId: string) => ({
        acknowledge_uncertain: true,
        content: "Continue where you left off.",
        continue_message_id: messageId,
      });

      const resumePrompt = "Continue where you left off.";

      const checkFreshPrompt = (prompt: string, original: string, expectedHistory: string) => {
        const handoff = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));

        expect(handoff).toEqual({
          instructions: profile.instructions,
          inputs: [
            {
              role: "context",
              content: expect.stringContaining(expectedHistory),
            },
            {
              role: "user",
              content: `Original user prompt:\n${original}\n\nInspect the current workspace files and any partial edits before continuing from where the interrupted turn left off.`,
            },
          ],
        });

        expect(prompt).not.toContain("RAW_TOOL_OUTPUT");
      };

      const savedRun = (runId: string) =>
        engine.db.all<{ conversation_id: string | null; resume_thread_id: string | null }>(
          "SELECT conversation_id,json_extract(execution,'$.resumeThreadId') AS resume_thread_id FROM utility_runs WHERE id=?",
          runId,
        )[0];

      await send(continueRequest(interrupted.request_id));
      const continuedSession = await settled();
      expect(requests).toHaveLength(count + 1);

      const stopTurn = async (content: string) => {
        mode = "wait";

        const request = {
          request_id: randomUUID(),
          content,
          selection,
          acknowledge_uncertain: true,
        };

        await send(request);
        await expect.poll(() => nativeIdFor(request.request_id)).toBeTruthy();
        await rpc.call("viber.session.cancel", { session_id: session.id, profile_id: profileId });
        await settled("cancelled");
        return request;
      };

      expect(requests[count]).toMatchObject({
        conversation: { threadId: interruptedThread, confirmResume: true },
        prompt: resumePrompt,
      });

      expect(continuedSession.thread?.thread_id).toBe(interruptedThread);

      expect(savedRun(requests[count].runId)).toEqual({
        conversation_id: interruptedThread,
        resume_thread_id: interruptedThread,
      });

      const file = join(workspace.worktree_path, "source.txt");

      const rejectionModes =
        providerName === "antigravity"
          ? (["resume-rejected", "resume-missing"] as const)
          : (["resume-rejected"] as const);

      for (const rejectionMode of rejectionModes) {
        const stopped = await stopTurn("Continue this edit if the native thread is gone");
        const stoppedThread = nativeIdFor(stopped.request_id);
        const beforeFallback = requests.length;
        const beforeEdit = await readFile(file, "utf8");
        mode = rejectionMode;
        await send(continueRequest(stopped.request_id));
        const fresh = await settled();

        expect(requests.slice(beforeFallback)).toMatchObject([
          {
            conversation: { threadId: stoppedThread, confirmResume: true },
            prompt: resumePrompt,
          },
          { conversation: {} },
        ]);

        const freshRequest = requests[beforeFallback + 1];
        checkFreshPrompt(freshRequest.prompt, stopped.content, "User: Inspect current files");
        expect(requests[beforeFallback].runId).toBe(freshRequest.runId);
        expect(fresh.thread?.thread_id).toBe(freshRequest.runId);
        expect(fresh.thread?.thread_id).not.toBe(stoppedThread);

        expect(savedRun(freshRequest.runId)).toEqual({
          conversation_id: freshRequest.runId,
          resume_thread_id: null,
        });

        expect(await readFile(file, "utf8")).toBe(beforeEdit + "changed\n");
      }

      if (providerName === "codex") {
        for (const expires of [false, true]) {
          const stopped = await stopTurn("Continue this edit within the shared deadline");
          const beforeFallback = requests.length;
          const before = await readFile(file, "utf8");
          mode = "resume-rejected";
          const realNow = Date.now;
          let clockAdvance = 0;
          const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockAdvance);

          advanceForFallback = () => {
            clockAdvance = expires ? profile.execution.timeout_secs * 1000 : 1;
          };

          try {
            await send(continueRequest(stopped.request_id));
            await settled(expires ? "failed" : "completed");
          } finally {
            advanceForFallback = undefined;
            clock.mockRestore();
          }

          expect(requests).toHaveLength(beforeFallback + 2);
          if (expires) {
            expect(savedRun(requests[beforeFallback].runId).conversation_id).toBeNull();

            expect(
              engine.viberSessions.store.detail(session.id, profileId).messages.at(-1)?.error,
            ).toContain("deadline expired before provider dispatch");
          }

          expect(await readFile(file, "utf8")).toBe(expires ? before : before + "changed\n");
        }

        mode = "success";
        await send({ acknowledge_uncertain: true, content: "Inspect after the expired attempt" });
        await settled();
      }

      mode = "success";
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
        .filter(({ status }) => ["completed", "cancelled", "interrupted"].includes(status))
        .map(({ role, content, status }) => ({
          role,
          content:
            content +
            (status === "cancelled"
              ? " [Stopped]"
              : status === "interrupted"
                ? " [Interrupted]"
                : ""),
        }));

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

      expect(returned.thread).toMatchObject({
        thread_id: previousThread,
        provider: providerName,
        status: "ready",
      });

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

      const stoppedAgain = await stopTurn("Do not repeat an edit after an ambiguous result");
      const beforeTruncated = requests.length;
      const beforeTruncatedEdit = await readFile(workspaceFile, "utf8");
      mode = "truncated";
      await send(continueRequest(stoppedAgain.request_id));
      await settled("failed");
      expect(requests).toHaveLength(beforeTruncated + 1);
      expect(await readFile(workspaceFile, "utf8")).toBe(beforeTruncatedEdit + "changed\n");

      const stoppedOnStartup = await stopTurn("Continue only if the provider confirms the thread");
      const beforeError = requests.length;
      const beforeErrorEdit = await readFile(file, "utf8");
      mode = "startup-error";
      await send(continueRequest(stoppedOnStartup.request_id));
      await settled("failed");
      expect(requests).toHaveLength(beforeError + 1);
      expect(await readFile(file, "utf8")).toBe(beforeErrorEdit);

      mode = "success";
      await send({ content: "/clear" });
      await send({ content: `Old context after clear: ${"a".repeat(31000)}` });
      await settled();
      await send({ content: `Recent context after clear: ${"b".repeat(31000)}` });
      await settled();

      mode = "wait-before-init";

      const withoutThread = {
        request_id: randomUUID(),
        content: "Rename cookie=legacyFlag in the interrupted test fixture",
        new_thread: true,
      };

      await send(withoutThread);

      await expect
        .poll(
          () =>
            engine.db.all<{ pid: number }>(
              "SELECT pid FROM utility_runs WHERE viber_message_id=?",
              withoutThread.request_id,
            )[0]?.pid,
        )
        .toBeGreaterThan(1);

      expect(nativeIdFor(withoutThread.request_id)).toBeNull();
      await rpc.call("viber.session.cancel", { session_id: session.id, profile_id: profileId });
      await settled("cancelled");
      expect(nativeIdFor(withoutThread.request_id)).toBeNull();

      mode = "success";
      const beforeFresh = requests.length;
      handoffThreadId = undefined;
      await send(continueRequest(withoutThread.request_id));
      const fresh = await settled();
      expect(requests).toHaveLength(beforeFresh + 1);
      const freshRequest = requests[beforeFresh];
      expect(freshRequest.conversation).toEqual({});

      checkFreshPrompt(
        freshRequest.prompt,
        withoutThread.content,
        "User: Recent context after clear",
      );

      expect(freshRequest.prompt).not.toContain("Old context after clear");

      expect(engine.viberSessions.store.detail(session.id, profileId).messages).toContainEqual(
        expect.objectContaining({
          id: withoutThread.request_id,
          content: "Rename cookie=[REDACTED] in the interrupted test fixture",
        }),
      );

      expect(
        engine.db.all<{ prompt: string }>(
          "SELECT prompt FROM utility_runs WHERE id=?",
          freshRequest.runId,
        )[0].prompt,
      ).not.toContain("legacyFlag");

      expect(freshRequest.prompt).not.toContain(handoff.content);
      expect(fresh.thread?.thread_id).toBe(freshRequest.runId);

      expect(savedRun(freshRequest.runId)).toEqual({
        conversation_id: freshRequest.runId,
        resume_thread_id: null,
      });

      if (providerName === "antigravity") {
        const contextProfile = engine.vibers.saveProfile({ ...profile, id: randomUUID() }, null);
        const contextSession = await create(contextProfile.id);
        const scope = { session_id: contextSession.id, profile_id: contextProfile.id };
        const sendContext = (extra: Record<string, unknown>) => send({ ...scope, ...extra });

        const prepare = (messageId: string, provider: "codex" | "antigravity") =>
          rpc.call("viber.session.prepareContinuation", {
            ...scope,
            continue_message_id: messageId,
            selection: { ...selection, provider },
          });

        const stopContext = async (content: string) => {
          const request_id = randomUUID();
          mode = "wait";
          await sendContext({ request_id, content });
          await expect.poll(() => nativeIdFor(request_id)).toBeTruthy();
          await rpc.call("viber.session.cancel", scope);
          await settled("cancelled", contextSession);
          mode = "success";
          return request_id;
        };

        await sendContext({ content: "Keep this on the far side of clear" });
        await settled("completed", contextSession);
        await sendContext({ content: "/clear" });
        const firstStopped = await stopContext("Rename cookie=legacyFlag before any continuation");
        const beforePrepare = requests.length;
        const beforePreload = engine.viberSessions.detail(contextSession.id, contextProfile.id);

        const contextFile = join(
          engine.viberSessions.store.workspace(contextSession.id).worktree_path,
          "source.txt",
        );

        const beforePreloadFile = await readFile(contextFile, "utf8");
        await prepare(firstStopped, "codex");
        const preload = requests.at(-1)!;
        expect(requests).toHaveLength(beforePrepare + 1);

        expect(preload).toMatchObject({
          prompt: "",
          preload: {
            only: true,
            instructions: profile.instructions,
            context: expect.stringContaining(
              "User: Rename cookie=[REDACTED] before any continuation [Stopped]",
            ),
          },
        });

        expect(preload.preload?.context).not.toContain("legacyFlag");
        expect(preload.preload?.context).not.toContain("far side of clear");

        expect(engine.viberSessions.detail(contextSession.id, contextProfile.id).runs).toEqual(
          beforePreload.runs,
        );

        expect(await readFile(contextFile, "utf8")).toBe(beforePreloadFile);
        await prepare(firstStopped, "codex");
        expect(requests).toHaveLength(beforePrepare + 1);

        await rpc.close();
        await engine.close();
        engine = await createFixtureEngine(join(directory, "data"), providers);
        rpc = new Rpc(engine);

        const continueAcross = continueRequest(firstStopped);

        await expect(
          sendContext({ ...continueAcross, acknowledge_uncertain: undefined }),
        ).rejects.toThrow("acknowledge");

        expect(requests).toHaveLength(beforePrepare + 1);
        await sendContext(continueAcross);
        await settled("completed", contextSession);

        expect(requests.at(-1)).toMatchObject({
          prompt: resumePrompt,
          conversation: { threadId: preload.runId, confirmResume: true },
        });

        const codexStopped = await stopContext("Continue this edit on Codex");
        const beforeUnsupported = requests.length;
        await expect(prepare(codexStopped, "antigravity")).rejects.toThrow("cannot preload");
        expect(requests).toHaveLength(beforeUnsupported);
        await sendContext(continueRequest(codexStopped));
        await settled("completed", contextSession);

        expect(requests.at(-1)).toMatchObject({
          prompt: resumePrompt,
          conversation: { threadId: preload.runId },
        });

        await sendContext({
          selection,
          content: "Return to Antigravity",
          acknowledge_uncertain: true,
        });

        await settled("completed", contextSession);
        const secondStopped = await stopContext("Rename alpha to bravo");
        await sendContext(continueRequest(secondStopped));
        await settled("completed", contextSession);
        const thirdStopped = await stopContext("Continue checking bravo");
        await prepare(thirdStopped, "codex");
        const resumedPreload = requests.at(-1)!;
        expect(resumedPreload.conversation?.threadId).toBe(preload.runId);

        expect(resumedPreload.preload?.context).toContain(
          "User: Rename alpha to bravo [Stopped]\n\nUser: Continue where you left off.\n\nAssistant: Native agent verified the edit.",
        );

        expect(resumedPreload.preload?.context).toContain(
          "User: Continue checking bravo [Stopped]",
        );

        expect(resumedPreload.preload?.context).not.toContain("before any continuation");
        expect(resumedPreload.preload?.context).not.toContain("Continue this edit on Codex");

        mode = "resume-rejected";
        const oversized = "z".repeat(41000);
        answerText = oversized;
        const beforeRejected = requests.length;
        await sendContext(continueRequest(thirdStopped));
        const recovered = await settled("completed", contextSession);

        expect(requests.slice(beforeRejected)).toMatchObject([
          { conversation: { threadId: preload.runId, confirmResume: true }, prompt: resumePrompt },
          {
            conversation: {},
            prompt: resumePrompt,
            preload: {
              context: expect.stringContaining("User: Continue checking bravo [Stopped]"),
            },
          },
        ]);

        expect(recovered.thread?.thread_id).toBe(requests.at(-1)?.runId);
        expect(JSON.stringify(requests.at(-1))).not.toContain("legacyFlag");

        mode = "success";
        answerText = "Native agent verified the edit.";

        await sendContext({
          selection,
          content: "Move past the oversized response",
          acknowledge_uncertain: true,
        });

        await settled("completed", contextSession);
        expect(requests.at(-1)?.prompt).toContain(`Assistant: ${oversized}`);
        expect(requests.at(-1)?.prompt).not.toContain("User: Continue where you left off.");

        const afterOversized = await stopContext("Stopped before selecting a missing Codex thread");
        mode = "resume-rejected";
        const beforeMissing = requests.length;
        await prepare(afterOversized, "codex");

        expect(requests.slice(beforeMissing)).toMatchObject([
          {
            conversation: { threadId: recovered.thread?.thread_id },
            prompt: "",
            preload: { only: true },
          },
          {
            conversation: {},
            prompt: "",
            preload: {
              only: true,
              context: expect.stringContaining("Stopped before selecting a missing Codex thread"),
            },
          },
        ]);

        const replacement = requests.at(-1)!.runId;

        mode = "success";
        await sendContext(continueRequest(afterOversized));
        await settled("completed", contextSession);

        expect(requests.at(-1)).toMatchObject({
          conversation: { threadId: replacement },
          prompt: resumePrompt,
        });
      }

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
