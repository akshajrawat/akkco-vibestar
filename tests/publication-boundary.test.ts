import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked, execute } from "../backend/execution/process";
import { publishFastForward } from "../backend/workspace/publication";

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vibestar-publication-boundary-"));
  const cwd = join(root, "worktree");
  const destination = join(root, "remote.git");
  await mkdir(cwd);
  await checked("git", ["init", "-b", "contribution"], cwd);
  await checked("git", ["config", "user.name", "Fixture"], cwd);
  await checked(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    cwd,
  );
  const commit = async (text: string) => {
    await writeFile(join(cwd, "source.txt"), text);
    await checked("git", ["add", "--", "source.txt"], cwd);
    await checked("git", ["commit", "-m", text], cwd);
    return checked("git", ["rev-parse", "HEAD"], cwd);
  };
  const expectedRemote = await commit("base");
  await checked("git", ["clone", "--bare", cwd, destination], root);
  const intermediate = await commit("intermediate");
  const localHead = await commit("reviewed contribution");
  return {
    root,
    intermediate,
    request: {
      cwd,
      destination,
      branch: "contribution",
      expectedRemote,
      localHead,
      signal: new AbortController().signal,
      allowLocalTransport: true,
    },
  };
};

it.each([false, true])(
  "rejects a still-fast-forward remote race independently of hooks (skip %s)",
  async (skipHooks) => {
    const { root, intermediate, request } = await fixture();
    try {
      const result = await publishFastForward(
        { ...request, skipHooks },
        async (command) => {
          // Advance after all host checks but before the Git advertisement.
          await checked(
            "git",
            ["fetch", request.cwd, "HEAD"],
            request.destination,
          );
          await checked(
            "git",
            ["update-ref", "refs/heads/contribution", intermediate],
            request.destination,
          );
          return execute(command);
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("stale info");
      expect(
        await checked(
          "git",
          ["rev-parse", "contribution"],
          request.destination,
        ),
      ).toBe(intermediate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("skips a private hook without skipping the independent ancestry or exact ref guard", async () => {
  const { root, request } = await fixture();
  try {
    const hooksPath = join(root, "hooks");
    await mkdir(hooksPath);
    await writeFile(join(hooksPath, "pre-push"), "#!/bin/sh\nexit 19\n", {
      mode: 0o700,
    });
    expect((await publishFastForward({ ...request, hooksPath })).code).not.toBe(
      0,
    );
    await expect(
      publishFastForward({
        ...request,
        hooksPath,
        skipHooks: true,
        expectedRemote: request.localHead,
        localHead: request.expectedRemote,
      }),
    ).rejects.toThrow("fast-forward");
    await expect(
      publishFastForward({ ...request, skipHooks: true, branch: "../other" }),
    ).rejects.toThrow("Invalid");
    expect(
      (await publishFastForward({ ...request, hooksPath, skipHooks: true }))
        .code,
    ).toBe(0);
    expect(
      await checked("git", ["rev-parse", "contribution"], request.destination),
    ).toBe(request.localHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
