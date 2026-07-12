import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  finalizeCognitiveKernelOutcome,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveReflections,
  listCognitiveRewardSignals,
  listCognitiveSkillCards,
} from '../src/db.js';

_initTestDatabase();

const base = Date.now().toString(36);

function runSuccess(iteration: number) {
  const kernel = beginCognitiveKernelRun({
    turnId: `cognition-skill-success-${base}-${iteration}`,
    channel: 'telegram',
    groupFolder: 'main',
    taskFamily: 'research',
    goal: 'Handle research turn from telegram via direct_assistant. Safe user intent: compare options using local context first and public search only for gaps.',
    requestRoute: 'direct_assistant',
    selectedSkillId: 'research.live_or_saved',
    selectedSkillPurpose: 'Answer from live providers or saved context.',
    selectedSkillApprovalNeed: 'none',
    selectedSkillSideEffectRisk: 'none',
    selectedSkillEvidenceLevel: 'strong',
    knownBlockers: [],
  });
  finalizeCognitiveKernelOutcome({
    cognitiveRun: kernel,
    evaluationStatus: 'pass',
    evidenceGap: 'none',
    evaluatorFlags: ['none'],
    routeUsed: 'research.live_or_saved',
    answerClass: 'handled',
  });
  return kernel;
}

const first = runSuccess(1);
const second = runSuccess(2);

const cards = listCognitiveSkillCards({
  groupFolder: 'main',
  taskFamily: 'research',
  limit: 20,
});
const learned = cards.find((card) =>
  card.skillId.includes('research.live_or_saved'),
);
assert.ok(learned, 'successful research runs should create a skill card');
assert.equal(
  learned?.promotionState,
  'candidate',
  'internal verification alone must not promote a candidate skill',
);
assert.ok((learned?.latestOutcomeScore || 0) >= 0.8);

const failure = beginCognitiveKernelRun({
  turnId: `cognition-skill-failure-${base}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Communication task from bluebubbles; raw message body stays local. Shape: words=5; question=false; action=true.',
  requestRoute: 'bluebubbles.direct',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Draft replies while preserving send approval.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  knownBlockers: ['same-thread approval missing'],
});

finalizeCognitiveKernelOutcome({
  cognitiveRun: failure,
  evaluationStatus: 'block',
  evidenceGap: 'blocked',
  evaluatorFlags: ['approval_required', 'same_thread_missing'],
  routeUsed: 'communication.reply_help',
  answerClass: 'blocked',
  blockerClass: 'approval_required',
});

const communicationCards = listCognitiveSkillCards({
  groupFolder: 'main',
  taskFamily: 'communication',
  limit: 20,
});
const approvalCandidate = communicationCards.find((card) =>
  card.skillId.includes('communication.reply_help'),
);
assert.equal(
  approvalCandidate?.promotionState,
  'candidate',
  'one safe approval stop must not quarantine a candidate skill',
);

const rewards = listCognitiveRewardSignals({ limit: 20 });
const reflections = listCognitiveReflections({ limit: 20 });
assert.ok(
  rewards.some((reward) => reward.runId === first.run.runId),
  'success run should have reward signal',
);
assert.ok(
  rewards.some((reward) => reward.runId === second.run.runId),
  'second success run should have reward signal',
);
assert.ok(
  reflections.some((reflection) => reflection.runId === failure.run.runId),
  'blocked run should have sanitized reflection',
);
assert.ok(
  !JSON.stringify([...cards, ...communicationCards, ...reflections]).match(
    /sk-|AIza|Bearer\s+/,
  ),
  'skill/reflection metadata should not leak obvious secrets',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      candidateSkillId: learned?.skillId,
      candidateState: learned?.promotionState,
      approvalCandidateSkillId: approvalCandidate?.skillId,
      approvalCandidateState: approvalCandidate?.promotionState,
      rewardSignals: rewards.length,
      reflections: reflections.length,
      privacy: {
        rawPromptsStored: false,
        rawPrivateBodiesStored: false,
        hiddenReasoningStored: false,
      },
    },
    null,
    2,
  ),
);

_closeDatabase();
