import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listGroundedBeliefJournal,
  listGroundedCalibrationSamples,
  listGroundedDecisionJournal,
} from './db.js';
import {
  compileTurnContext,
  reconcileTurnRuntimeEvidence,
  reflectTurnAgentOutcome,
  verifyTurnAgentAdaptiveCompletion,
  type PreSendEvaluation,
  type TurnAgentHarnessContext,
} from './turn-agent-harness.js';
import {
  beginGroundedExecutive,
  decideGroundedNextStep,
  groundedBeliefTier,
  groundedEvidence,
} from './grounded-cognitive-executive.js';
import { adaptiveEvidence } from './adaptive-cognition-engine.js';

const NOW = '2026-07-20T12:00:00.000Z';

function buildContext(): TurnAgentHarnessContext {
  const contextCompile = compileTurnContext({
    taskFamily: 'diagnostics',
    channel: 'telegram',
    text: 'Why did the backup fail last night?',
    stateChanging: false,
  });
  let grounded = beginGroundedExecutive({
    objective: 'Diagnose why the nightly backup failed.',
    taskFamily: 'diagnostics',
    channel: 'telegram',
    turnRef: 'turn-grounded-1',
    evidence: [
      groundedEvidence({
        evidenceClass: 'user_attested',
        origin: 'live',
        source: 'channel:telegram',
        claim: 'The user reports the nightly backup failed.',
        subject: 'turn:turn-grounded-1',
        predicate: 'objective',
        value: 'diagnostics',
        confidence: 0.9,
        createdAt: NOW,
      }),
    ],
    now: NOW,
  });
  grounded = decideGroundedNextStep(grounded, { now: NOW }).state;
  return {
    turnId: 'turn-grounded-1',
    channel: 'telegram',
    taskFamily: 'diagnostics',
    meaningful: true,
    selectedSkill: contextCompile.selectedSkill,
    contextCompile,
    groundedExecutive: grounded,
  };
}

function passEvaluation(): PreSendEvaluation {
  return {
    status: 'pass',
    evidenceLevel: 'partial',
    evidenceGap: 'none',
    evaluatorFlags: [],
    safeRewriteApplied: false,
    rewrittenText: 'The backup failed because the disk was full.',
    approvalCorrectness: 'correct',
    memoryEffect: 'neutral',
    summary: 'Verified diagnostics answer.',
  };
}

describe('turn-agent-harness grounded hooks (observe-only)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('reconcileTurnRuntimeEvidence folds runtime outcomes into shadow beliefs without changing its result', () => {
    const context = buildContext();
    const result = reconcileTurnRuntimeEvidence({
      context,
      evaluation: null,
      runtimeStatus: 'error',
      routeUsed: 'container_agent',
      blockerClass: 'container_timeout',
    });
    // No deep-work packet existed, so the function's contract result is
    // unchanged by the shadow hook.
    expect(result).toBeNull();
    const belief = context.groundedExecutive!.beliefs.find(
      (item) => item.subject === 'route:container_agent',
    );
    expect(belief).toBeDefined();
    expect(belief!.value).toBe('error');
    expect(
      groundedBeliefTier(
        belief!,
        context.groundedExecutive!.evidenceRecords.map(
          (record) => record.evidence,
        ),
      ),
    ).not.toBe('unknown');
    expect(context.contextCompile.metadata.grounded_runtime_evidence).toBe(
      'error',
    );
  });

  it('verifyTurnAgentAdaptiveCompletion result is identical with and without the shadow state', async () => {
    const context = buildContext();
    const withoutShadow: TurnAgentHarnessContext = {
      ...buildContext(),
      groundedExecutive: null,
    };
    const evidence = [
      adaptiveEvidence({
        evidenceClass: 'observed',
        origin: 'live',
        source: 'runtime',
        claim: 'The diagnostics completed.',
        confidence: 0.9,
        createdAt: NOW,
      }),
    ];
    // Neither context carries a cognitive kernel run, so the existing gate
    // returns false in both cases; the hook must not change that.
    const gateWithShadow = await verifyTurnAgentAdaptiveCompletion({
      context,
      completionEvidence: evidence,
      now: NOW,
    });
    const gateWithoutShadow = await verifyTurnAgentAdaptiveCompletion({
      context: withoutShadow,
      completionEvidence: evidence,
      now: NOW,
    });
    expect(gateWithShadow).toBe(gateWithoutShadow);
    expect(gateWithShadow).toBe(false);
  });

  it('reflectTurnAgentOutcome journals the shadow state and a calibration sample', async () => {
    const context = buildContext();
    const reflection = await reflectTurnAgentOutcome({
      context,
      evaluation: passEvaluation(),
      routeUsed: 'local_companion',
      answerClass: 'answer',
    });
    expect(reflection.routeUsed).toBe('local_companion');
    expect(context.contextCompile.metadata.grounded_journal_persisted).toBe(
      'true',
    );
    const decisions = listGroundedDecisionJournal({
      turnId: 'turn-grounded-1',
    });
    expect(decisions.length).toBeGreaterThan(0);
    const beliefs = listGroundedBeliefJournal({ turnId: 'turn-grounded-1' });
    expect(beliefs.length).toBeGreaterThan(0);
    const samples = listGroundedCalibrationSamples({ limit: 10 });
    expect(samples.length).toBe(1);
    expect(samples[0]!.outcome).toBe(1);
  });

  it('all hooks are no-ops when no shadow state exists', async () => {
    const context: TurnAgentHarnessContext = {
      ...buildContext(),
      groundedExecutive: null,
    };
    reconcileTurnRuntimeEvidence({
      context,
      evaluation: null,
      runtimeStatus: 'success',
      routeUsed: 'local_companion',
    });
    await reflectTurnAgentOutcome({
      context,
      evaluation: passEvaluation(),
      routeUsed: 'local_companion',
      answerClass: 'answer',
    });
    expect(
      context.contextCompile.metadata.grounded_runtime_evidence,
    ).toBeUndefined();
    expect(
      context.contextCompile.metadata.grounded_journal_persisted,
    ).toBeUndefined();
    expect(listGroundedDecisionJournal({ limit: 10 }).length).toBe(0);
  });
});
