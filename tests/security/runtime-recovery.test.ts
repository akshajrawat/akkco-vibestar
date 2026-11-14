import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFixtureEngine } from "../helpers/fixtures";

it("refuses runtime restart during active work and atomically prevents new activity after accepting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-runtime-admission-"));
  const engine = await createFixtureEngine(dir);
  const stop = vi.fn();
  try {
    const release = engine.trackActivity(
      { id: "fixture", kind: "terminal", label: "Running terminal", stoppable: true },
      stop,
    );

    expect(() => engine.prepareRuntimeRestart()).toThrow("running tasks");
    expect(stop).not.toHaveBeenCalled();
    expect(() => engine.assertAvailable()).not.toThrow();
    release();
    engine.prepareRuntimeRestart();

    expect(() =>
      engine.trackActivity(
        { id: "late", kind: "pr_watch", label: "Late request", stoppable: true },
        stop,
      ),
    ).toThrow("maintained");

    expect(stop).not.toHaveBeenCalled();
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
