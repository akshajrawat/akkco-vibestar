// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { Rpc } from "../../apps/core/rpc";
import { Database } from "../../apps/core/storage/database";
import { migrations } from "../../apps/core/storage/migrations";
import { viberSnapshotVersion } from "../../apps/core/storage/viber-snapshots";
import { ViberMemory } from "../../apps/core/vibers/memory";
import type { ViberMemoryFact } from "../../apps/core/vibers/memory-contracts";
import { ViberMemoryControl } from "../../apps/desktop/features/vibers/ViberMemory";
import { mockDialog } from "../helpers/dialog";
import { createFixtureEngine } from "../helpers/fixtures";
import { testProfileIds, viberProfile } from "../helpers/viber-fixtures";

const first = { profile_id: testProfileIds.implementer };
const second = { profile_id: testProfileIds.reviewer };
const missing = { profile_id: randomUUID() };
let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let rpc: Rpc;

const start = async () => {
  engine = await createFixtureEngine(dir);
  rpc = new Rpc(engine);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-memory-"));
  await start();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rpc.close();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

it("persists profile-owned facts across restart and supports scoped corrections and forgetting", async () => {
  const fact = (await rpc.call("viber.memory.create", {
    ...first,
    text: "  The fixture pinboard is blue.  ",
  })) as ViberMemoryFact;

  expect(fact.text).toBe("The fixture pinboard is blue.");
  expect(await rpc.call("viber.session.list", first)).toEqual([]);
  expect(await rpc.call("viber.memory.list", second)).toEqual([]);

  await expect(
    rpc.call("viber.memory.update", { ...second, id: fact.id, text: "Other" }),
  ).rejects.toMatchObject({ kind: "not_found" });

  await expect(rpc.call("viber.memory.forget", { ...second, id: fact.id })).rejects.toMatchObject({
    kind: "not_found",
  });

  expect(await rpc.call("viber.memory.list", first)).toEqual([fact]);

  await rpc.close();
  await engine.close();
  await start();
  expect(await rpc.call("viber.memory.list", first)).toEqual([fact]);

  const text = "The fixture pinboard is green.";

  expect(await rpc.call("viber.memory.update", { ...first, id: fact.id, text })).toEqual({
    id: fact.id,
    text,
  });

  expect(await rpc.call("viber.memory.list", first)).toEqual([{ id: fact.id, text }]);
  expect(await rpc.call("viber.memory.forget", { ...first, id: fact.id })).toBeNull();

  await rpc.close();
  await engine.close();
  await start();
  expect(await rpc.call("viber.memory.list", first)).toEqual([]);
});

it("rejects invalid inputs and unavailable profiles for each memory operation", async () => {
  for (const input of [
    { ...first, text: "   " },
    { ...first, text: "x".repeat(2001) },
    { ...first, text: "Sample", session_id: randomUUID() },
    { text: "Sample" },
  ]) {
    await expect(rpc.call("viber.memory.create", input)).rejects.toMatchObject({
      kind: "invalid_input",
    });
  }

  const fact = (await rpc.call("viber.memory.create", {
    ...first,
    text: "Sample",
  })) as ViberMemoryFact;

  await expect(
    rpc.call("viber.memory.update", { ...first, id: fact.id, text: "" }),
  ).rejects.toMatchObject({ kind: "invalid_input" });

  await expect(rpc.call("viber.memory.forget", { ...first, id: "invalid" })).rejects.toMatchObject({
    kind: "invalid_input",
  });

  engine.db.run("INSERT INTO retired_viber_profiles(profile_id) VALUES(?)", first.profile_id);
  for (const scope of [first, missing]) {
    for (const [method, input] of [
      ["viber.memory.list", scope],
      ["viber.memory.create", { ...scope, text: "Sample" }],
      ["viber.memory.update", { ...scope, id: fact.id, text: "Sample" }],
      ["viber.memory.forget", { ...scope, id: fact.id }],
    ] as const) {
      await expect(rpc.call(method, input)).rejects.toMatchObject({ kind: "not_found" });
    }
  }
});

it.each([0, viberSnapshotVersion])(
  "adds private memory to a version-%i database with an existing Viber",
  async (version) => {
    const path = join(dir, "before-memory.sqlite");
    const old = new BetterSqlite3(path);
    const timestamp = "2026-01-01T00:00:00.000Z";
    try {
      old.transaction(() => {
        for (const migration of migrations.filter((migration) => migration.version <= version)) {
          old.exec(migration.sql);

          old
            .prepare("INSERT INTO schema_migrations VALUES(?,?)")
            .run(migration.version, timestamp);
        }

        old
          .prepare("INSERT INTO agent_profiles VALUES(?,1,?,?)")
          .run(viberProfile.id, timestamp, timestamp);

        old
          .prepare("INSERT INTO agent_profile_revisions VALUES(?,1,?,?)")
          .run(viberProfile.id, JSON.stringify(viberProfile), timestamp);
      })();
    } finally {
      old.close();
    }

    const upgraded = await Database.open(path);
    try {
      const memory = new ViberMemory(upgraded);
      const scope = { profile_id: viberProfile.id };
      expect(memory.list(scope)).toEqual([]);
      const saved = memory.create({ ...scope, text: "Fixture fact for an existing Viber" });
      expect(memory.list(scope)).toEqual([saved]);
      expect(upgraded.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  },
);

const openMemory = () => fireEvent.click(screen.getByRole("button", { name: "Private memory" }));

it("round-trips through the memory UI and RPC, retaining the draft on an error", async () => {
  mockDialog();
  let fail = true;

  vi.stubGlobal("vibestar", {
    rpc: async (method: string, input: unknown) => {
      if (method === "viber.memory.create" && fail) {
        fail = false;
        throw new Error("Local storage unavailable");
      }

      return rpc.call(method, input);
    },
  });

  render(<ViberMemoryControl profileId={first.profile_id} name="Fixture" />);
  openMemory();
  const dialog = within(screen.getByRole("dialog", { name: "Private memory for Fixture" }));
  await dialog.findByText("No saved facts.");
  const field = dialog.getByRole<HTMLTextAreaElement>("textbox", { name: "New fact" });
  const original = "The fixture notebook is blue.";
  const corrected = "The fixture notebook is green.";
  fireEvent.change(field, { target: { value: original } });
  fireEvent.click(dialog.getByRole("button", { name: "Save fact" }));
  expect((await dialog.findByRole("alert")).textContent).toBe("Local storage unavailable");
  expect(field.value).toBe(original);
  fireEvent.click(dialog.getByRole("button", { name: "Save fact" }));
  await dialog.findByText(original);

  fireEvent.click(dialog.getByRole("button", { name: "Correct" }));

  fireEvent.change(dialog.getByRole("textbox", { name: "Correct fact" }), {
    target: { value: corrected },
  });

  fireEvent.click(dialog.getByRole("button", { name: "Save correction" }));
  await dialog.findByText(corrected);
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  openMemory();
  await screen.findByText(corrected);
  expect(screen.queryByText(original)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Forget" }));

  expect(await rpc.call("viber.memory.list", first)).toEqual([
    { id: expect.any(String), text: corrected },
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Confirm forget" }));
  await screen.findByText("No saved facts.");
  expect(await rpc.call("viber.memory.list", first)).toEqual([]);
});

it("discards the previous Viber’s pending list response on a profile switch", async () => {
  mockDialog();
  const previousText = "First fixture fact";
  const currentText = "Second fixture fact";
  await rpc.call("viber.memory.create", { ...first, text: previousText });
  await rpc.call("viber.memory.create", { ...second, text: currentText });
  let resolvePrevious!: () => void;

  const pending = new Promise<void>((resolve) => {
    resolvePrevious = resolve;
  });

  const call = vi.fn(async (method: string, input: { profile_id: string }) => {
    const result = await rpc.call(method, input);
    if (input.profile_id === first.profile_id) {
      await pending;
    }

    return result;
  });

  vi.stubGlobal("vibestar", { rpc: call });

  const { rerender } = render(
    <ViberMemoryControl key={first.profile_id} profileId={first.profile_id} name="First" />,
  );

  openMemory();
  expect(screen.getByRole("status").textContent).toBe("Loading facts…");
  expect(call).toHaveBeenCalledWith("viber.memory.list", first);

  rerender(
    <ViberMemoryControl key={second.profile_id} profileId={second.profile_id} name="Second" />,
  );

  expect(screen.queryByRole("dialog")).toBeNull();
  openMemory();
  await screen.findByText(currentText);
  await act(async () => resolvePrevious());
  expect(screen.queryByText(previousText)).toBeNull();
});
