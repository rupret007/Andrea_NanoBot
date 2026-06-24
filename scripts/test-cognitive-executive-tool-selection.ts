import assert from 'node:assert/strict';

import { beginCognitiveExecutiveTurn } from '../src/cognitive-executive.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';

_initTestDatabase();

const now = new Date('2026-06-07T11:30:00.000Z');
const blockedResearchReport: IntegrationDoctorReport = {
  generatedAt: now.toISOString(),
  summary: {
    total: 1,
    healthy: 0,
    actionNeeded: 1,
    needsProof: 0,
    manualOrExternal: 0,
  },
  statuses: [
    {
      integrationId: 'research',
      label: 'Research',
      state: 'externally_blocked',
      credentialState: 'configured',
      transportState: 'failing',
      proofState: 'externally_blocked',
      lastHealthyAt: null,
      lastFailure: 'Search quota blocked.',
      blockerOwner: 'external',
      nextAction: 'Use local knowledge first, retry search later.',
      repairability: 'manual_external',
      safeActions: [],
      detail: 'Blocked for test.',
    },
  ],
  secretsRedacted: true,
};

const researchContext = beginCognitiveExecutiveTurn({
  rawAsk: 'what should I do next?',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  turnId: 'tool:research-blocked',
  capabilityMatchOverride: {
    capabilityId: 'research.topic',
    normalizedText: 'what should I do next?',
    canonicalText: 'research current next step',
    reason: 'test override for research tool selection',
  },
  integrationReport: blockedResearchReport,
  now,
});

const selectedResearchTool = researchContext?.toolChoices.find(
  (choice) => choice.selected,
);
assert.equal(researchContext?.plan.selectedRoute, 'research');
assert.equal(selectedResearchTool?.toolId, 'research');
assert.equal(selectedResearchTool?.status, 'blocked');
assert.equal(selectedResearchTool?.fallbackToolId, 'clarifying_question');

const approvalContext = beginCognitiveExecutiveTurn({
  rawAsk: 'what should I say back and send it',
  channel: 'bluebubbles',
  groupFolder: 'main',
  chatJid: 'bb:iMessage;-;+14695405551',
  turnId: 'tool:approval',
  capabilityMatchOverride: {
    capabilityId: 'communication.draft_reply',
    normalizedText: 'what should I say back and send it',
    canonicalText: 'what should I say back',
    reason: 'test override for approval boundary',
  },
  now,
});
const selectedApprovalTool = approvalContext?.toolChoices.find(
  (choice) => choice.selected,
);
assert.equal(approvalContext?.plan.selectedRoute, 'communication_companion');
assert.equal(approvalContext?.plan.approvalRequired, true);
assert.equal(selectedApprovalTool?.status, 'approval_required');
assert.match(selectedApprovalTool?.riskFlagsJson || '', /approval_required/);

const missionBlockerContext = beginCognitiveExecutiveTurn({
  rawAsk: "what's blocking this",
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  turnId: 'tool:mission-blocker-continuation',
  priorSubjectData: {
    activeCapabilityId: 'missions.propose',
    missionId: 'mission-1',
    missionSummary: 'Plan Friday dinner with Candace.',
  },
  now,
});
const selectedMissionBlockerTool = missionBlockerContext?.toolChoices.find(
  (choice) => choice.selected,
);
assert.equal(missionBlockerContext?.capabilityMatch?.capabilityId, 'missions.explain');
assert.equal(missionBlockerContext?.plan.selectedRoute, 'missions');
assert.equal(selectedMissionBlockerTool?.toolId, 'missions');
assert.equal(missionBlockerContext?.plan.approvalRequired, false);

const missionHandleContext = beginCognitiveExecutiveTurn({
  rawAsk: 'handle this for me',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  turnId: 'tool:mission-handle-continuation',
  priorSubjectData: {
    activeCapabilityId: 'missions.propose',
    missionId: 'mission-1',
    missionSummary: 'Plan Friday dinner with Candace.',
  },
  now,
});
const selectedMissionHandleTool = missionHandleContext?.toolChoices.find(
  (choice) => choice.selected,
);
assert.equal(missionHandleContext?.capabilityMatch?.capabilityId, 'missions.execute');
assert.equal(missionHandleContext?.plan.selectedRoute, 'missions');
assert.equal(selectedMissionHandleTool?.toolId, 'missions');
assert.equal(missionHandleContext?.plan.approvalRequired, true);
assert.equal(selectedMissionHandleTool?.status, 'approval_required');

console.log(
  JSON.stringify(
    {
      status: 'pass',
      researchTool: selectedResearchTool,
      approvalTool: selectedApprovalTool,
      missionBlockerTool: selectedMissionBlockerTool,
      missionHandleTool: selectedMissionHandleTool,
    },
    null,
    2,
  ),
);

_closeDatabase();
