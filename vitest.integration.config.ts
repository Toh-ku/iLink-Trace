import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.integration.test.ts",
      "apps/*/src/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    passWithNoTests: true,
  },
});
