import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    testTimeout: 60_000,
    setupFiles: ['./scripts/test-network-guard.mjs'],
    env: {
      ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE: '1',
    },
  },
});
