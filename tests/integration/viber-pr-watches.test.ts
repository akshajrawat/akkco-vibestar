import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AntigravityProvider } from "../../apps/core/execution/providers/antigravity";
import { CodexProvider } from "../../apps/core/execution/providers/codex";
import type { AgentRunRequest } from "../../apps/core/execution/providers/contracts";
import { GitHubClient } from "../../apps/core/github/client";
import { Rpc } from "../../apps/core/rpc";
import type {
  ViberMessage,
  ViberSession,
  ViberSessionDetail,
} from "../../apps/core/vibers/contracts";
import { createFixtureEngine, detectFixtureProvider } from "../helpers/fixtures";
import { testProfileIds } from "../helpers/viber-fixtures";

const scope = (session: ViberSession) => ({
  session_id: session.id,
  profile_id: session.profile_id,
});

describe("Viber PR Watches Integration", () => {
  it("manages PR watches through chat with zero provider invocations, restart deduplication, and safe cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-pr-watches-"));
    const providerRequests: AgentRunRequest[] = [];
    const adapters = { codex: new CodexProvider(), antigravity: new AntigravityProvider() };

    let currentPrData = {
      url: "https://github.com/acme/widgets/pull/101",
      number: 101,
      title: "Add reactive widget sync",
      state: "OPEN" as "OPEN" | "CLOSED" | "MERGED",
      isDraft: false,
      updatedAt: "2026-11-24T12:00:00Z",
      headRefName: "feat/reactive-sync",
      headRefOid: "sha11111111111111111111111111111111111111",
      mergeable: "MERGEABLE" as const,
      reviewDecision: null as "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null,
      commits: {
        nodes: [
          {
            commit: {
              oid: "sha11111111111111111111111111111111111111",
              statusCheckRollup: { state: "PENDING" },
            },
          },
        ],
      },
    };

    const mockGhClient = new GitHubClient(join(directory, "data"));

    mockGhClient.graphql = async (_query, vars) => {
      if (vars.owner !== "acme" || vars.repo !== "widgets") {
        return { data: { repository: null } };
      }

      return {
        data: {
          repository: {
            pullRequest: currentPrData,
          },
        },
      };
    };

    const engineFactory = async () =>
      createFixtureEngine(
        join(directory, "data"),
        (_stage, name = "codex") => ({
          ...adapters[name],
          detect: async () => ({ ...(await detectFixtureProvider()), provider: name }),
          invocation: (request) => {
            providerRequests.push(request);
            return {
              program: process.execPath,
              args: ["-e", 'console.log(JSON.stringify({ type: "turn.completed" }))'],
            };
          },
        }),
        mockGhClient,
      );

    let engine = await engineFactory();
    let rpc = new Rpc(engine);

    try {
      const profileId = testProfileIds.implementer;

      const session = (await rpc.call("viber.session.create", {
        profile_id: profileId,
        request_id: randomUUID(),
        selection: { provider: "codex", model: "next-model", effort: "high" },
      })) as ViberSession;

      const send = (content: string, requestId = randomUUID()) =>
        rpc.call("viber.session.send", {
          ...scope(session),
          request_id: requestId,
          content,
          history_ids: [],
        }) as Promise<ViberMessage>;

      const detail = () =>
        rpc.call("viber.session.detail", scope(session)) as Promise<ViberSessionDetail>;

      // 1. Create PR watch from chat
      const createRes = await send("/watch https://github.com/Acme/Widgets/pull/101");
      expect(createRes.role).toBe("user");
      expect(createRes.status).toBe("completed");

      // Verify ZERO provider invocations
      expect(providerRequests.length).toBe(0);

      // Verify chat timeline has user message and assistant reply
      let currentDetail = await detail();
      expect(currentDetail.messages.length).toBe(2);

      expect(currentDetail.messages[0].content).toBe(
        "/watch https://github.com/Acme/Widgets/pull/101",
      );

      expect(currentDetail.messages[1].role).toBe("assistant");

      expect(currentDetail.messages[1].content).toContain(
        'Watching PR #101 (acme/widgets): "Add reactive widget sync" [OPEN]',
      );

      // Verify database state
      const watches = engine.db.all<{
        id: string;
        url: string;
        status: string;
        pull_number: number;
        owner: string;
        repo: string;
      }>("SELECT * FROM viber_pr_watches WHERE session_id=?", session.id);

      expect(watches.length).toBe(1);
      expect(watches[0].pull_number).toBe(101);
      expect(watches[0].owner).toBe("acme");
      expect(watches[0].repo).toBe("widgets");
      expect(watches[0].status).toBe("active");

      // 2. Reject canonical duplicate watch in same session
      const dupRes = await send("/watch https://github.com/acme/widgets/pull/101/");
      expect(dupRes.status).toBe("completed");
      currentDetail = await detail();

      expect(currentDetail.messages.at(-1)?.content).toBe(
        "Already watching PR #101 (acme/widgets).",
      );

      expect(providerRequests.length).toBe(0);

      // 3. List active watches
      await send("/watch list");
      currentDetail = await detail();

      expect(currentDetail.messages.at(-1)?.content).toContain(
        "Active PR watches in this session:",
      );

      expect(currentDetail.messages.at(-1)?.content).toContain("• **#101** (acme/widgets)");

      // 4. Poll without change -> no new messages
      const countBefore = currentDetail.messages.length;
      await engine.prWatches.pollAll();
      currentDetail = await detail();
      expect(currentDetail.messages.length).toBe(countBefore);

      // 5. Change checks status to FAILURE -> poll emits notification
      currentPrData = {
        ...currentPrData,
        commits: {
          nodes: [
            {
              commit: {
                oid: "sha11111111111111111111111111111111111111",
                statusCheckRollup: { state: "FAILURE" },
              },
            },
          ],
        },
      };

      await engine.prWatches.pollAll();
      currentDetail = await detail();
      expect(currentDetail.messages.length).toBe(countBefore + 1);
      expect(currentDetail.messages.at(-1)?.content).toContain("[PR Watch] #101 (acme/widgets)");
      expect(currentDetail.messages.at(-1)?.content).toContain("Checks failed");

      // 6. Change reviewDecision to APPROVED -> poll emits notification
      currentPrData = {
        ...currentPrData,
        reviewDecision: "APPROVED",
      };

      await engine.prWatches.pollAll();
      currentDetail = await detail();
      expect(currentDetail.messages.at(-1)?.content).toContain("Reviews approved");

      // 7. Restart deduplication: close and re-create engine
      await rpc.close();
      await engine.close();

      engine = await engineFactory();
      rpc = new Rpc(engine);

      // Verify watch is still active with stored cursor
      const restoredWatches = engine.db.all<{ status: string; cursor: string }>(
        "SELECT status, cursor FROM viber_pr_watches WHERE session_id=?",
        session.id,
      );

      expect(restoredWatches[0].status).toBe("active");

      // Polling with identical PR data must NOT produce duplicate reports!
      const messagesAfterRestart = (await detail()).messages.length;
      await engine.prWatches.pollAll();
      expect((await detail()).messages.length).toBe(messagesAfterRestart);

      // 8. Lifecycle transition to MERGED -> poll completes watch
      currentPrData = {
        ...currentPrData,
        state: "MERGED",
      };

      await engine.prWatches.pollAll();
      currentDetail = await detail();
      expect(currentDetail.messages.at(-1)?.content).toContain("Merged into base branch");

      const completedWatch = engine.db.all<{ status: string }>(
        "SELECT status FROM viber_pr_watches WHERE session_id=?",
        session.id,
      )[0];

      expect(completedWatch.status).toBe("completed");

      // 9. Cancellation: create a second watch and cancel it
      const secondPrUrl = "https://github.com/acme/widgets/pull/202";

      mockGhClient.graphql = async (_query, vars) => {
        if (Number(vars.repo) === 202 || vars.repo === "widgets") {
          return {
            data: {
              repository: {
                pullRequest: {
                  ...currentPrData,
                  number: 202,
                  url: secondPrUrl,
                  state: "OPEN",
                },
              },
            },
          };
        }

        return { data: { repository: null } };
      };

      await send(`/watch ${secondPrUrl}`);

      expect(
        engine.db.all("SELECT id FROM viber_pr_watches WHERE pull_number=202 AND status='active'")
          .length,
      ).toBe(1);

      await send(`/watch cancel ${secondPrUrl}`);
      currentDetail = await detail();

      expect(currentDetail.messages.at(-1)?.content).toBe(
        "Stopped watching PR #202 (acme/widgets).",
      );

      const cancelledWatch = engine.db.all<{ status: string }>(
        "SELECT status FROM viber_pr_watches WHERE pull_number=202",
      )[0];

      expect(cancelledWatch.status).toBe("cancelled");

      // 10. Same request replay (idempotent command)
      const testReqId = randomUUID();
      const firstSend = await send("/watches", testReqId);
      const secondSend = await send("/watches", testReqId);
      expect(firstSend.id).toBe(secondSend.id);
      expect(firstSend.content).toBe(secondSend.content);

      // Total provider turns throughout all watch tests should remain 0!
      expect(providerRequests.length).toBe(0);
    } finally {
      await rpc.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails safely on malformed requests and missing auth or network errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-pr-watches-error-"));
    const mockGhClient = new GitHubClient(join(directory, "data"));

    // Network / Auth error
    mockGhClient.graphql = async () => {
      throw new Error("Could not resolve host: api.github.com");
    };

    const engine = await createFixtureEngine(join(directory, "data"), undefined, mockGhClient);
    const rpc = new Rpc(engine);

    try {
      const profileId = testProfileIds.implementer;

      const session = (await rpc.call("viber.session.create", {
        profile_id: profileId,
        request_id: randomUUID(),
        selection: { provider: "codex", model: "next-model", effort: "high" },
      })) as ViberSession;

      const send = (content: string) =>
        rpc.call("viber.session.send", {
          ...scope(session),
          request_id: randomUUID(),
          content,
          history_ids: [],
        }) as Promise<ViberMessage>;

      const detail = () =>
        rpc.call("viber.session.detail", scope(session)) as Promise<ViberSessionDetail>;

      // Malformed URL in command
      await send("/watch invalid-url-not-github");
      let d = await detail();

      expect(d.messages.at(-1)?.content).toBe(
        "Invalid PR URL. Please use an HTTPS github.com/owner/repository/pull/number URL.",
      );

      // Network error during watch creation
      await send("/watch https://github.com/acme/widgets/pull/999");
      d = await detail();

      expect(d.messages.at(-1)?.content).toContain(
        "Cannot watch PR https://github.com/acme/widgets/pull/999: Could not resolve host",
      );

      // Verify no active watches were created
      expect(engine.db.all("SELECT id FROM viber_pr_watches WHERE status='active'").length).toBe(0);
    } finally {
      await rpc.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves stopped turn recovery across watch commands in chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-pr-recovery-"));
    const engine = await createFixtureEngine(join(directory, "data"));
    const rpc = new Rpc(engine);

    try {
      const profileId = testProfileIds.implementer;

      const session = (await rpc.call("viber.session.create", {
        profile_id: profileId,
        request_id: randomUUID(),
        selection: { provider: "codex", model: "next-model", effort: "high" },
      })) as ViberSession;

      // Manually simulate an interrupted provider turn in the database
      const stoppedTurnId = randomUUID();
      const timestamp = new Date().toISOString();

      engine.db.run(
        `INSERT INTO viber_messages(id,session_id,role,content,status,created_at,effects)
         VALUES(?,?,'user','Edit file','interrupted',?,'possible')`,
        stoppedTurnId,
        session.id,
        timestamp,
      );

      // Detail should require recovery
      let detail = (await rpc.call("viber.session.detail", scope(session))) as ViberSessionDetail;
      expect(detail.recovery_required).toBe(true);

      // User sends a watch command from chat
      await rpc.call("viber.session.send", {
        ...scope(session),
        request_id: randomUUID(),
        content: "/watch list",
        history_ids: [],
      });

      // Watch command MUST NOT mask recovery!
      detail = (await rpc.call("viber.session.detail", scope(session))) as ViberSessionDetail;
      expect(detail.recovery_required).toBe(true);
    } finally {
      await rpc.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels active PR watches when a Viber profile is retired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibestar-pr-retire-"));
    const mockGhClient = new GitHubClient(join(directory, "data"));

    mockGhClient.graphql = async () => ({
      data: {
        repository: {
          pullRequest: {
            url: "https://github.com/acme/widgets/pull/505",
            number: 505,
            title: "Feature",
            state: "OPEN",
            isDraft: false,
            updatedAt: "2026-11-24T12:00:00Z",
            headRefName: "main",
            headRefOid: "sha505",
            mergeable: "MERGEABLE",
            reviewDecision: null,
            commits: null,
          },
        },
      },
    });

    const engine = await createFixtureEngine(join(directory, "data"), undefined, mockGhClient);
    const rpc = new Rpc(engine);

    try {
      const profileId = testProfileIds.implementer;

      const session = (await rpc.call("viber.session.create", {
        profile_id: profileId,
        request_id: randomUUID(),
        selection: { provider: "codex", model: "next-model", effort: "high" },
      })) as ViberSession;

      // Create watch
      await rpc.call("viber.session.send", {
        ...scope(session),
        request_id: randomUUID(),
        content: "/watch https://github.com/acme/widgets/pull/505",
        history_ids: [],
      });

      expect(engine.db.all("SELECT id FROM viber_pr_watches WHERE status='active'").length).toBe(1);

      // Retire the profile
      await rpc.call("profile.delete", { profile_id: profileId, confirmed: true });

      // Active watches for this profile must be cancelled!
      expect(engine.db.all("SELECT id FROM viber_pr_watches WHERE status='active'").length).toBe(0);

      expect(engine.db.all("SELECT id FROM viber_pr_watches WHERE status='cancelled'").length).toBe(
        1,
      );
    } finally {
      await rpc.close();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
