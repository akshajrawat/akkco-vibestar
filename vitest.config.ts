import { defineConfig } from "vitest/config";

const testFiles = "**/*.test.{ts,tsx}";
const separateSuites = ["integration", "security"];

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "unit",
          include: [`tests/${testFiles}`],
          exclude: separateSuites.map((suite) => `tests/${suite}/${testFiles}`),
        },
      },
      ...separateSuites.map((suite) => ({
        test: { name: suite, include: [`tests/${suite}/${testFiles}`] },
      })),
    ],
  },
});
