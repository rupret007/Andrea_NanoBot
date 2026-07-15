import { buildHermeticTestEnv } from '../src/hermetic-test-env.js';

const environment = buildHermeticTestEnv(process.env, {
  // The fixture lab owns unique disposable on-disk paths so restart and
  // cleanup behavior can be proven without touching production storage.
  isolateStorage: false,
});

for (const key of Object.keys(process.env)) {
  if (!(key in environment)) delete process.env[key];
}
Object.assign(process.env, environment, {
  ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT: '1',
});

const networkGuardUrl = new URL('./test-network-guard.mjs', import.meta.url);
await import(networkGuardUrl.href);
await import('./certify-novel-capability-mastery.js');
