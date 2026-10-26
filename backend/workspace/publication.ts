import { AdeError } from "../domain";
import { execute, type ProcessRequest } from "../execution/runtime/process";
import { gitCapture, gitExecute } from "./git-command";

interface PublicationRequest {
  cwd: string;
  destination: string;
  branch: string;
  expectedRemote: string;
  localHead: string;
  ancestryBase?: string;
  skipHooks?: boolean;
  hooksPath?: string;
  allowLocalTransport?: boolean;
  signal: AbortSignal;
  onSpawn?: ProcessRequest["onSpawn"];
}

// A lease supplies compare-and-swap, never permission for a non-fast-forward.
// Immutable object IDs and the ancestry proof make every permitted update FF.
// Neither a repository hook nor --no-verify can bypass this host boundary.
export const publishFastForward = async (request: PublicationRequest, executor = execute) => {
  const { cwd, destination, branch, expectedRemote, localHead, signal } = request;
  const ref = `refs/heads/${branch}`;
  const creating = /^0+$/.test(expectedRemote);
  const ancestor = creating ? request.ancestryBase : expectedRemote;
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedRemote) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(localHead) ||
    !ancestor ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ancestor) ||
    (await gitCapture(["check-ref-format", ref], cwd, signal)).code !== 0
  )
    throw new AdeError("publication", "Invalid publication object or branch.");
  if (
    (await gitCapture(["cat-file", "-t", localHead], cwd, signal)).stdout.trim() !== "commit" ||
    (await gitCapture(["merge-base", "--is-ancestor", ancestor, localHead], cwd, signal)).code !== 0
  )
    throw new AdeError(
      "ancestry",
      "Publication must be a fast-forward descendant of the exact expected remote head.",
    );
  return gitExecute(
    {
      program: "git",
      cwd,
      signal,
      allowLocalTransport: request.allowLocalTransport,
      hooksPath: request.hooksPath,
      timeoutMs: 120000,
      onSpawn: request.onSpawn,
      args: [
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--recurse-submodules=no",
        `--force-with-lease=${ref}:${creating ? "" : expectedRemote}`,
        ...(request.skipHooks ? ["--no-verify"] : []),
        "--",
        destination,
        `${localHead}:${ref}`,
      ],
    },
    executor,
  );
};
