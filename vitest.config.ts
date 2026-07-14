import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    testTimeout: 60_000,
    setupFiles: ['./scripts/test-network-guard.mjs'],
    env: {
      ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE: '1',
      ANDREA_TEST_DISABLE_OWNER_ENV_FILE: '1',
      ANDREA_DETERMINISTIC_STORAGE_MODE: 'memory',
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID: 'bb:iMessage;-;+12025550101',
      BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS:
        'bb:iMessage;-;+12025550101,bb:iMessage;-;owner@example.com',
    },
  },
});
