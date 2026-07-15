import { buildHermeticTestEnv } from '../src/hermetic-test-env.js';

const environment = buildHermeticTestEnv(process.env);
for (const key of Object.keys(process.env)) {
  if (!(key in environment)) delete process.env[key];
}
Object.assign(process.env, environment, {
  ANDREA_PRODUCTION_APPRENTICESHIP_CERT_HERMETIC_PARENT: '1',
});

// Sanitize provider-bearing environment before loading any production adapter,
// and install the process-level non-loopback guard first.
const networkGuardUrl = new URL('./test-network-guard.mjs', import.meta.url);
await import(networkGuardUrl.href);
await import('./certify-production-capability-apprenticeship.js');
