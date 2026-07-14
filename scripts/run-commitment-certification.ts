import { buildHermeticTestEnv } from '../src/hermetic-test-env.js';

const environment = buildHermeticTestEnv(process.env, {
  // The certification owns a unique disposable on-disk SQLite database so it
  // can exercise real close/reopen behavior. It never uses production paths.
  isolateStorage: false,
});

for (const key of Object.keys(process.env)) {
  if (!(key in environment)) delete process.env[key];
}
Object.assign(process.env, environment, {
  ANDREA_COMMITMENT_CERT_HERMETIC_PARENT: '1',
});

// No provider-bearing production module is loaded until the process has been
// sanitized and the non-loopback guard is active. In the deterministic sweep,
// the same preload is already present and ESM caching keeps this exactly once.
const networkGuardUrl = new URL('./test-network-guard.mjs', import.meta.url);
await import(networkGuardUrl.href);
await import('./certify-commitment-intelligence.js');
