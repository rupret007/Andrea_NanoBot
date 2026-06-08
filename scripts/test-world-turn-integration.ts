import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  buildWorldModelReport,
  buildWorldModelStatusText,
  formatWorldModelReport,
  isWorldModelNaturalRequest,
} from '../src/world-model.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T23:30:00.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i;
const providers: ProviderHealthSnapshot[] = [
  {
    providerId: 'openai_cloud',
    kind: 'llm',
    state: 'healthy',
    lastHealthyAt: checkedAt,
    lastCheckedAt: checkedAt,
    failureClass: 'none',
    quotaState: 'ok',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {},
  },
];
const integrationReport: IntegrationDoctorReport = {
  generatedAt: checkedAt,
  summary: {
    total: 1,
    healthy: 1,
    actionNeeded: 0,
    needsProof: 0,
    manualOrExternal: 0,
  },
  statuses: [
    {
      integrationId: 'google_calendar',
      label: 'Google Calendar',
      state: 'healthy',
      credentialState: 'healthy',
      transportState: 'healthy',
      proofState: 'healthy',
      lastHealthyAt: checkedAt,
      lastFailure: '',
      blockerOwner: 'none',
      nextAction: 'Use fresh calendar read windows before high-certainty answers.',
      repairability: 'status_only',
      safeActions: ['npm run debug:google-calendar'],
      detail: 'Validated calendar read proof.',
    },
  ],
  secretsRedacted: true,
};

const report = buildWorldModelReport({
  generatedAt: checkedAt,
  providers,
  integrationReport,
});
const formatted = formatWorldModelReport(report);
const statusText = buildWorldModelStatusText();

assert.equal(isWorldModelNaturalRequest('what changed?'), true);
assert.equal(isWorldModelNaturalRequest('what is stale?'), true);
assert.equal(isWorldModelNaturalRequest('what do you know for sure?'), true);
assert.equal(isWorldModelNaturalRequest('what should you verify next?'), true);
assert.equal(isWorldModelNaturalRequest('what is most useful now?'), true);
assert.equal(isWorldModelNaturalRequest('hello there'), false);
assert.match(formatted, /World Model/);
assert.match(formatted, /Proof debt/);
assert.match(statusText, /World Model/);
assert.equal(report.privacy.rawPromptsStored, false);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);

const serialized = JSON.stringify({ report, formatted, statusText });
assert.doesNotMatch(
  serialized,
  SECRET_RE,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      naturalControls: 5,
      snapshotStatus: report.snapshot.status,
      confidence: report.snapshot.confidence,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
