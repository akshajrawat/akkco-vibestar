import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings } from "../../backend/domain";
import { Database } from "../../backend/storage/database";

it("reads legacy global AI settings without modifying their source and persists notification preferences across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-settings-compatibility-"));
  const path = join(dir, "state.sqlite");
  let db = await Database.open(path);
  try {
    const legacy: Record<string, unknown> = {
      ...defaultSettings,
      utility_ai: {
        provider: "codex",
        model: "old-utility-model",
        effort: "high",
        timeout_secs: 120,
      },
      review_ai: { provider: "codex", model: "old-review-model", effort: "low", timeout_secs: 60 },
    };

    delete legacy.notification_preference;
    const bytes = JSON.stringify(legacy);
    db.run("INSERT INTO settings VALUES('pipeline',?)", bytes);
    expect(db.settings().notification_preference).toBe("necessary");
    expect(db.settings()).not.toHaveProperty("utility_ai");
    expect(db.settings()).not.toHaveProperty("review_ai");

    expect(
      db.all<{ value: string }>("SELECT value FROM settings WHERE key='pipeline'")[0].value,
    ).toBe(bytes);

    db.saveSettings({ ...db.settings(), notification_preference: "all" });
    db.close();
    db = await Database.open(path);
    expect(db.settings()).toMatchObject({ concurrency: 2, notification_preference: "all" });
    expect(db.settings()).not.toHaveProperty("utility_ai");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
