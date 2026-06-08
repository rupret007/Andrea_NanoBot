import assert from 'node:assert/strict';

import { beginAgentOSEpisode, buildAgentOSReport } from '../src/agent-os.js';
import { beginLogicKernelRun } from '../src/logic-kernel.js';
import { runTruthEngine } from '../src/truth-engine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listTruthAnswerAudits,
  listTruthClaims,
  listTruthEvidenceSupport,
  listTruthRewriteDirectives,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T22:15:00.000Z';
const suffix = Date.now().toString(36);

const healthyProvider: ProviderHealthSnapshot = {
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
};

const episode = beginAgentOSEpisode({
  turnId: `truth-supported-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Use cited read-only evidence to answer a planning question.',
  requestRoute: 'test:truth:supported',
  selectedSkillId: 'truth.research_support',
  selectedSkillPurpose: 'Exercise answer support claim extraction.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'strong',
  providerHealthSnapshots: [healthyProvider],
});

const logic = beginLogicKernelRun({
  subject: 'truth engine supported research episode',
  agentOSReport: buildAgentOSReport({ episodeId: episode.episode.episodeId }),
  generatedAt: checkedAt,
});

const supportedText = `${logic.report.claims[0].predicate}: ${logic.report.claims[0].objectSummary}.`;
const supported = runTruthEngine({
  text: supportedText,
  turnId: `truth-supported-${suffix}`,
  channel: 'telegram',
  taskFamily: 'research',
  subject: logic.report.subject,
  logicReport: logic.report,
  generatedAt: checkedAt,
});

assert.notEqual(
  supported.calibration.supportGrade,
  'unsupported',
  'supported logic claim should not be marked unsupported',
);
assert.ok(
  supported.evidenceSupports.length >= 1,
  'supported claim should cite evidence IDs',
);

const unsupported = runTruthEngine({
  text: 'All providers definitely participated and Gemini verified the answer.',
  turnId: `truth-unsupported-${suffix}`,
  channel: 'telegram',
  taskFamily: 'research',
  subject: 'truth unsupported provider participation',
  generatedAt: checkedAt,
});

assert.equal(unsupported.calibration.status, 'warn');
assert.ok(
  unsupported.calibration.flags.includes('fake_provider_participation'),
  'fake provider participation should be flagged',
);
assert.match(
  unsupported.rewrittenText,
  /cannot say every provider participated/i,
  'fake all-provider participation should be caveated',
);

const approval = runTruthEngine({
  text: 'Done, I sent it.',
  turnId: `truth-approval-${suffix}`,
  channel: 'bluebubbles',
  taskFamily: 'communication',
  subject: 'truth approval-gate proof',
  logicReport: logic.report,
  generatedAt: checkedAt,
});

assert.equal(approval.calibration.status, 'block');
assert.equal(approval.rewriteDirectives[0]?.directive, 'stage_approval');
assert.ok(
  approval.calibration.flags.includes('approval_action_claim'),
  'approval overreach should be blocked',
);

const calendar = runTruthEngine({
  text: "You're free tomorrow.",
  turnId: `truth-calendar-${suffix}`,
  channel: 'telegram',
  taskFamily: 'calendar',
  subject: 'truth calendar certainty',
  logicReport: logic.report,
  generatedAt: checkedAt,
});

assert.equal(calendar.calibration.status, 'warn');
assert.doesNotMatch(
  calendar.rewrittenText,
  /you're free/i,
  'calendar overcertainty should be narrowed',
);

const storedAudits = listTruthAnswerAudits({ limit: 20 });
const storedClaims = storedAudits.flatMap((audit) =>
  listTruthClaims({ auditId: audit.auditId, limit: 20 }),
);
const storedSupports = storedAudits.flatMap((audit) =>
  listTruthEvidenceSupport({ auditId: audit.auditId, limit: 20 }),
);
const storedDirectives = storedAudits.flatMap((audit) =>
  listTruthRewriteDirectives({ auditId: audit.auditId, limit: 20 }),
);

assert.ok(storedAudits.length >= 4, 'truth audits should be persisted');
assert.ok(storedClaims.length >= 4, 'truth claims should be persisted');
assert.ok(storedSupports.length >= 1, 'truth supports should be persisted');
assert.ok(
  storedDirectives.some((directive) => directive.directive === 'stage_approval'),
  'approval rewrite directive should be persisted',
);

const serialized = JSON.stringify({
  supported,
  unsupported,
  approval,
  calendar,
  storedAudits,
  storedClaims,
  storedSupports,
  storedDirectives,
});
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      audits: storedAudits.length,
      claims: storedClaims.length,
      supports: storedSupports.length,
      directives: storedDirectives.length,
      supportedStatus: supported.calibration.status,
      unsupportedFlags: unsupported.calibration.flags,
      approvalDirective: approval.rewriteDirectives[0]?.directive,
      calendarDirective: calendar.rewriteDirectives[0]?.directive,
      privacy: supported.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
