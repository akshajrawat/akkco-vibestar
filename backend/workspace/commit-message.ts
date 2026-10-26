import { z } from "zod";

import { AdeError } from "../domain";
import { gitExecute } from "./git-command";

export const CommitMessageSchema = z
  .string()
  .min(1)
  .refine((message) => !message.includes("\0"), "Git commit messages cannot contain NUL bytes.");

export const createExactCommit = async (
  cwd: string,
  tree: string,
  parent: string,
  message: string,
  signal: AbortSignal,
) => {
  CommitMessageSchema.parse(message);
  if (![tree, parent].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)))
    throw new AdeError("commit", "Invalid commit tree or parent.");
  const identity = `Vibestar <vibestar@localhost> ${Math.floor(Date.now() / 1000)} +0000`;

  const result = await gitExecute({
    program: "git",
    args: ["hash-object", "-t", "commit", "-w", "--stdin"],
    cwd,
    signal,
    rawStdoutForIntegrity: true,
    // Plumbing avoids even Git's automatic final newline. The body is exact UTF-8.
    input: `tree ${tree}\nparent ${parent}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
  });

  if (result.code !== 0)
    throw new AdeError("commit", `Cannot create exact commit: ${result.stderr}`);
  return result.stdout.trim();
};
