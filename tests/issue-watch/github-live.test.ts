import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFixtureEngine } from "../fixtures";
import { GitHubClient } from "../../backend/github/client";
import { IssueWatchService } from "../../backend/issue-watch/service";
import { WatchLimitsSchema } from "../../backend/issue-watch/contracts";
import { previewRules } from "../../backend/issue-watch/rules";
import { IssueWatchFixtureProvider } from "./provider";

const execute = promisify(execFile);
const repository = "akshajrawat/akkco-vibestar-test";

// Explicitly authorized disposable GitHub repository only. Subscription execution
// remains a Node fixture through the production AgentRunner and sandbox.
it.skipIf(process.env.VIBESTAR_GITHUB_WATCH_TEST !== "1")(
  "checks actual GitHub identities, policy, claims, tracker edits and baseline safety",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-watch-github-"));
    const marker = randomUUID().slice(0, 8);
    let sequence = 0;
    const api = async (endpoint: string, method = "GET", body?: unknown) => {
      const args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        method,
        endpoint,
      ];
      if (body !== undefined) {
        const file = join(dir, `request-${sequence++}.json`);
        await writeFile(file, JSON.stringify(body));
        args.push("--input", file);
      }
      const result = await execute("gh", args, { maxBuffer: 2 * 1024 * 1024 });
      return result.stdout ? JSON.parse(result.stdout) : null;
    };
    const provider = new IssueWatchFixtureProvider();
    const engine = await createFixtureEngine(join(dir, "data"), () => provider);
    const service = new IssueWatchService(engine, new GitHubClient(dir));
    const created: { number: number; node_id: string; html_url: string }[] = [];
    const report: unknown[] = [];
    let policyCreated = false;
    let policySha = "";
    let labelCreated = false;
    const cleanupErrors: string[] = [];
    const label = `vibestar-fixture-triage-${marker}`;
    const record = async (name: string, operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(`${name}: ${String(error)}`);
      }
    };
    const createIssue = async (name: string, body: string) => {
      const issue = await api(`repos/${repository}/issues`, "POST", {
        title: `[Vibestar workflow fixture ${marker}] ${name}`,
        body: `Automated Issue Watch integration fixture. No real work or assignment request.\n\n${body}`,
      });
      created.push(issue);
      return issue as (typeof created)[number];
    };
    const scan = async (watchId: string) => {
      const launched = service.launch({
        watch_id: watchId,
        expected_revision: 1,
        request_id: randomUUID(),
      });
      await expect
        .poll(() => service.store.scan(watchId, launched.scan_id).status, {
          timeout: 45000,
          interval: 100,
        })
        .not.toBe("running");
      const result = service.store.scan(watchId, launched.scan_id);
      report.push({
        scan: result,
        candidates: service.store.candidates(watchId, result.id),
        sources: service.store.sources(watchId, result.id),
      });
      return result;
    };
    try {
      const repo = await api(`repos/${repository}`);
      expect(repo.full_name.toLowerCase()).toBe(repository);
      const profile = await api(`repos/${repository}/community/profile`);
      // Refuse to replace a future real policy in this test repository.
      expect(profile.files.contributing).toBeNull();
      const candidate = await createIssue(
        "Candidate",
        "Extract repeated test selectors into the existing helper and run its focused tests.",
      );
      const listed = await createIssue(
        "Tracker member",
        "Add a focused test for the existing parser helper.",
      );
      const claimed = await createIssue(
        "Claim evidence",
        "Improve the current test failure diagnostics.",
      );
      await api(
        `repos/${repository}/issues/${claimed.number}/comments`,
        "POST",
        {
          body: "[Automated claim-evidence fixture; no actual request] Can I work on this issue?",
        },
      );
      const tracker = await createIssue(
        "Dynamic excluded tracker",
        `## Reserved fixture scope\n\n- #${listed.number}\n- ${listed.html_url}\n\n\`#${candidate.number}\` is only a code example.`,
      );
      await api(`repos/${repository}/labels`, "POST", {
        name: label,
        color: "d4c5f9",
        description: "Temporary Vibestar Issue Watch integration fixture",
      });
      labelCreated = true;
      const preview = previewRules({
        repository,
        prompt: "Open issues. Prefer focused testing changes.",
        controls: {
          excluded_labels: [label],
          trackers: [{ url: tracker.html_url, comments: "none" }],
        },
      });
      const saved = (await service.save({
        request_id: randomUUID(),
        name: `GitHub fixture ${marker}`,
        repository,
        configuration: {
          prompt: "Open issues. Prefer focused testing changes.",
          rules: preview.rules,
          preview_digest: preview.digest,
          ambiguity_decisions: [],
          model: {
            provider: "codex",
            model: "fixture-model",
            effort: "medium",
            timeout_secs: 120,
          },
          limits: WatchLimitsSchema.parse({}),
        },
      })) as Awaited<ReturnType<typeof service.store.saveRevision>>;
      expect(provider.calls).toBe(0);
      expect(engine.db.tasks()).toEqual([]);
      // Search indexing is eventually consistent. Preparation polls only reads;
      // each actual workflow attempt below is explicit and separately recorded.
      await expect
        .poll(
          async () => {
            const search = await api(
              `search/issues?q=${encodeURIComponent(`repo:${repository} is:issue is:open`)}&per_page=100`,
            );
            return created.every((issue) =>
              search.items.some(
                (item: { node_id: string }) => item.node_id === issue.node_id,
              ),
            );
          },
          { timeout: 90000, interval: 2000 },
        )
        .toBe(true);
      const missingPolicy = await scan(saved.watch.id);
      expect(missingPolicy).toMatchObject({
        status: "partial",
        coverage: { exclusions_complete: true, evidence_complete: false },
      });
      expect(
        service.store.get(saved.watch.id).last_complete_scan_id,
      ).toBeNull();
      expect(
        service.store.candidate(
          saved.watch.id,
          missingPolicy.id,
          listed.node_id,
        ).eligible,
      ).toBe(false);
      expect(
        service.store.candidate(
          saved.watch.id,
          missingPolicy.id,
          candidate.node_id,
        ).claim_state,
      ).toBe("eligibility_uncertain");
      expect(provider.calls).toBe(1);
      const policy = await api(
        `repos/${repository}/contents/CONTRIBUTING.md`,
        "PUT",
        {
          message: `Add temporary Issue Watch policy fixture ${marker}`,
          content: Buffer.from(
            `# Temporary Vibestar integration policy\n\nThis is a workflow test repository. Keep changes focused and include tests.\nFixture marker: ${marker}\n`,
          ).toString("base64"),
        },
      );
      policySha = policy.content.sha;
      policyCreated = true;
      await expect
        .poll(
          async () =>
            (await api(`repos/${repository}/community/profile`)).files
              .contributing?.url || "",
          { timeout: 90000, interval: 2000 },
        )
        .toContain("CONTRIBUTING.md");
      const complete = await scan(saved.watch.id);
      expect(complete.status).toBe("completed");
      expect(provider.calls).toBe(2);
      expect(
        service.store.candidate(saved.watch.id, complete.id, candidate.node_id),
      ).toMatchObject({
        eligible: true,
        claim_state: "candidate_for_claim_request",
        classification: "initial_discovery",
      });
      expect(
        service.store.candidate(saved.watch.id, complete.id, claimed.node_id)
          .claim_state,
      ).toBe("possibly_claimed");
      expect(
        service.store
          .sources(saved.watch.id, complete.id)
          .some(
            (source) =>
              source.kind === "policy" && source.text.includes(marker),
          ),
      ).toBe(true);
      await api(`repos/${repository}/issues/${tracker.number}`, "PATCH", {
        body: `Automated updated tracker fixture ${marker}.\n\n#${candidate.number} is now reserved. The former member is released.`,
      });
      await api(
        `repos/${repository}/issues/${candidate.number}/labels`,
        "POST",
        { labels: [label] },
      );
      const changed = await scan(saved.watch.id);
      expect(changed.status).toBe("completed");
      expect(provider.calls).toBe(3);
      expect(
        service.store.candidate(saved.watch.id, changed.id, candidate.node_id),
      ).toMatchObject({
        eligible: false,
        classification: "no_longer_eligible",
      });
      expect(
        service.store.candidate(saved.watch.id, changed.id, listed.node_id),
      ).toMatchObject({ eligible: true, classification: "newly_matching" });
      const calls = provider.calls;
      await service.call("detail", { watch_id: saved.watch.id });
      await service.call("scanDetail", {
        watch_id: saved.watch.id,
        scan_id: complete.id,
      });
      expect(provider.calls).toBe(calls);
      expect(engine.db.repositories()).toEqual([]);
      expect(engine.db.tasks()).toEqual([]);
      console.info(
        `Real GitHub Issue Watch fixtures: ${created.map((issue) => issue.html_url).join(", ")}`,
      );
    } finally {
      await service.close();
      const usage = engine.db.all("SELECT * FROM ai_usage");
      await engine.close();
      for (const issue of created)
        await record(`close #${issue.number}`, () =>
          api(`repos/${repository}/issues/${issue.number}`, "PATCH", {
            state: "closed",
            state_reason: "completed",
          }),
        );
      if (labelCreated)
        await record("remove fixture label", () =>
          api(
            `repos/${repository}/labels/${encodeURIComponent(label)}`,
            "DELETE",
          ),
        );
      if (policyCreated)
        await record("remove fixture policy", async () => {
          const file = await api(
            `repos/${repository}/contents/CONTRIBUTING.md`,
          );
          expect(file.sha).toBe(policySha);
          expect(Buffer.from(file.content, "base64").toString()).toContain(
            marker,
          );
          return api(`repos/${repository}/contents/CONTRIBUTING.md`, "DELETE", {
            message: `Remove temporary Issue Watch policy fixture ${marker}`,
            sha: file.sha,
          });
        });
      if (process.env.VIBESTAR_KEEP_EVIDENCE === "1") {
        await writeFile(
          join(dir, "results.json"),
          JSON.stringify(
            {
              repository,
              marker,
              issues: created,
              attempts: report,
              usage,
              cleanupErrors,
              realInference: false,
            },
            null,
            2,
          ),
        );
        console.info(`Real GitHub Issue Watch evidence: ${dir}`);
      } else await rm(dir, { recursive: true, force: true });
      expect(cleanupErrors).toEqual([]);
    }
  },
  300000,
);
