import assert from 'node:assert/strict';

import { runAgencyConvergenceLoop } from '../src/agency-convergence-loop.js';
import {
  _closeDatabase,
  _initTestDatabase,
  upsertCognitiveProviderCooldown,
} from '../src/db.js';
import type { CognitiveProviderCooldown } from '../src/types.js';

_initTestDatabase();

const generatedAt = '2026-06-07T01:12:00.000Z';
const cooldown: CognitiveProviderCooldown = {
  providerId: 'anthropic_cloud',
  createdAt: generatedAt,
  updatedAt: generatedAt,
  status: 'active',
  failureClass: 'quota_or_rate_limit',
  source: 'live_probe',
  runId: null,
  cooldownUntil: '2026-06-07T02:12:00.000Z',
  lastFailure: 'quota or rate limit during test probe',
  nextAction: 'Skip Anthropic until cooldown expires or diagnostics recover.',
  metadataJson: JSON.stringify({ redacted: true }),
  privacyJson: JSON.stringify({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  }),
};
upsertCognitiveProviderCooldown(cooldown);

const report = await runAgencyConvergenceLoop({
  generatedAt,
  mode: 'assistive',
  liveProviderProbe: false,
});
const providerPlan = report.providerPlans[0];
const skipped = JSON.parse(providerPlan.skippedProviderIdsJson) as string[];
const cooldowns = JSON.parse(providerPlan.cooldownProviderIdsJson) as string[];

assert.ok(providerPlan, 'provider participation plan should be persisted');
assert.notEqual(providerPlan.status, 'healthy');
assert.ok(skipped.includes('anthropic_cloud'));
assert.ok(cooldowns.includes('anthropic_cloud'));
assert.match(providerPlan.nextAction, /Skip blocked|cooling-down/i);
assert.equal(report.privacy.secretsRedacted, true);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      providerStatus: providerPlan.status,
      skipped,
      cooldowns,
      nextAction: providerPlan.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
