import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestar-test-home-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);

  return async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  };
});
