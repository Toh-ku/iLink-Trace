import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@ilink-trace/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@ilink-trace/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@ilink-trace/storage": fileURLToPath(
        new URL("./packages/storage/src/index.ts", import.meta.url),
      ),
    },
  },
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
