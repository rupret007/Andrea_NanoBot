import { fileURLToPath } from 'node:url';

const TEST_NETWORK_GUARD_PATH = fileURLToPath(
  new URL('../scripts/test-network-guard.mjs', import.meta.url),
);

export function withTestNetworkGuard(nodeOptions = ''): string {
  const preload = `--import=${TEST_NETWORK_GUARD_PATH}`;
  return nodeOptions.includes(preload)
    ? nodeOptions
    : [nodeOptions, preload].filter(Boolean).join(' ');
}

export function buildHermeticTestEnv(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE: '1',
    NODE_OPTIONS: withTestNetworkGuard(environment.NODE_OPTIONS),
  };
}
