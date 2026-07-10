import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    setupFiles: ["./scripts/test-network-guard.mjs"],
    env: {
      ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE: "1",
    },
  },
});
