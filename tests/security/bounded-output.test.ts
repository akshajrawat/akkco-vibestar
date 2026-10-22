import { expect, it, vi } from "vitest";
import {
  BoundedWriter,
  OutputBudget,
} from "../../backend/execution/bounded-output";

it("limits both bytes and entries queued behind a slow log sink", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sink = vi.fn(async () => gate);
  const writer = new BoundedWriter(vi.fn());
  writer.write("a".repeat(3 * 1024 * 1024), sink);
  expect(() => writer.write("b".repeat(3 * 1024 * 1024), sink)).toThrow(
    "faster than",
  );
  release();
  await writer.drain();
  expect(sink).toHaveBeenCalledTimes(1);
  const small = new BoundedWriter(vi.fn());
  for (let i = 0; i < 4096; i++) small.write("", sink);
  expect(() => small.write("", sink)).toThrow("faster than");
  await small.drain();
});

it("reports a failed sink once, rejects drain and does not continue writing", async () => {
  const failure = vi.fn();
  const writer = new BoundedWriter(failure);
  const sink = vi.fn(async () => {
    throw new Error("fixture disk full");
  });
  writer.write("first", sink);
  writer.write("second", sink);
  await expect(writer.drain()).rejects.toThrow("fixture disk full");
  expect(sink).toHaveBeenCalledTimes(1);
  expect(failure).toHaveBeenCalledTimes(1);
  expect(() => writer.write("later", sink)).toThrow("fixture disk full");
});

it("counts raw UTF-8 bytes even when stream redaction emits nothing", () => {
  const budget = new OutputBudget(8);
  budget.consume("😀");
  budget.consume("😀");
  expect(() => budget.consume("x")).toThrow("capture limit");
});
