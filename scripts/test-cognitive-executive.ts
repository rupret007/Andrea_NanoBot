import assert from 'node:assert/strict';

import {
  beginCognitiveExecutiveTurn,
  finalizeCognitiveExecutiveTurn,
  formatCognitiveExecutiveReport,
  buildStoredCognitiveExecutiveReport,
} from '../src/cognitive-executive.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveExecutiveRuns,
  listCognitiveReflectionSignals,
} from '../src/db.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';

_initTestDatabase();

const generatedAt = new Date('2026-06-07T11:00:00.000Z');
const integrationReport: IntegrationDoctorReport = {
  generatedAt: generatedAt.toISOString(),
  summary: {
    total: 3,
    healthy: 1,
    actionNeeded: 1,
    needsProof: 1,
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
      lastHealthyAt: generatedAt.toISOString(),
      lastFailure: '',
      blockerOwner: 'none',
      nextAction: 'Use calendar read windows when needed.',
      repairability: 'status_only',
      safeActions: ['npm run debug:google-calendar'],
      detail: 'Calendar is verified.',
    },
    {
      integrationId: 'bluebubbles',
      label: 'BlueBubbles',
      state: 'needs_proof',
      credentialState: 'configured',
      transportState: 'healthy',
      proofState: 'needs_proof',
      lastHealthyAt: null,
      lastFailure: 'Same-thread proof missing.',
      blockerOwner: 'manual',
      nextAction: 'Complete the same-thread proof.',
      repairability: 'proof_drill',
      safeActions: ['npm run debug:bluebubbles -- --live'],
      detail: 'Transport is ready, proof debt remains.',
    },
    {
      integrationId: 'telegram',
      label: 'Telegram User Session',
      state: 'externally_blocked',
      credentialState: 'missing',
      transportState: 'unknown',
      proofState: 'externally_blocked',
      lastHealthyAt: null,
      lastFailure: 'User session credentials are missing.',
      blockerOwner: 'external',
      nextAction: 'Configure Telegram user-session credentials.',
      repairability: 'manual_external',
      safeActions: ['npm run telegram:user:smoke'],
      detail: 'Bot transport can still work; user smoke proof is blocked.',
    },
  ],
  secretsRedacted: true,
};

const context = beginCognitiveExecutiveTurn({
  rawAsk: 'what am I forgetting?',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  threadId: 'thread:main',
  actorId: 'user:self',
  turnId: 'turn:cognitive-executive-core',
  selectedWork: {
    title: 'Finish Andrea setup',
    statusLabel: 'active',
    reason: 'current operator focus',
  },
  integrationReport,
  now: generatedAt,
});

assert.ok(context, 'executive should handle loose-ends flow');
assert.equal(context?.request.intentFamily, 'loose_ends');
assert.ok(context?.plan.routeKey, 'executive should choose a route');
assert.ok(
  context?.snapshotItems.length,
  'executive should gather bounded context',
);

const finalized = finalizeCognitiveExecutiveTurn({
  context,
  status: 'handled',
  resultSummary: 'Existing loose-ends route handled the turn.',
  nextAction: 'Follow the top next step if it still matters.',
  now: new Date('2026-06-07T11:00:01.000Z'),
});

assert.equal(finalized?.status, 'handled');
const storedRuns = listCognitiveExecutiveRuns({ limit: 5 });
const signals = listCognitiveReflectionSignals({
  runId: context!.run.runId,
  limit: 10,
});
const report = buildStoredCognitiveExecutiveReport();
const formatted = formatCognitiveExecutiveReport(report);

assert.ok(storedRuns.some((run) => run.runId === context?.run.runId));
assert.ok(signals.some((signal) => signal.signalKind === 'answer_sent'));
assert.equal(report.privacy.metadataOnly, true);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.match(formatted, /Cognitive Executive/);

const serialized = JSON.stringify({ storedRuns, signals, report, formatted });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|hidden reasoning text|chain-of-thought/i,
);
assert.doesNotMatch(
  storedRuns[0]?.requestSummary || '',
  /what am I forgetting/i,
  'stored request summary should not persist the raw prompt',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runId: context?.run.runId,
      intent: context?.request.intentFamily,
      route: context?.plan.routeKey,
      snapshotItems: context?.snapshotItems.length,
      signals: signals.length,
      nextAction: finalized?.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
