import { describe, expect, it } from 'vitest';

import {
  buildGroundedDeliberationPacket,
  decomposeGroundedIntents,
  evaluateGroundedResponse,
  formatGroundedDeliberationGuidance,
  repairGroundedResponse,
  resolveGroundedAdvisoryMode,
} from './grounded-response-intelligence.js';
import type { GroundedContextBundle } from './grounded-memory.js';
import {
  beginTurnAgentHarness,
  evaluateTurnReply,
} from './turn-agent-harness.js';

const NOW = '2026-07-21T12:00:00.000Z';

function packet(
  text: string,
  options?: Parameters<typeof buildGroundedDeliberationPacket>[0],
) {
  return buildGroundedDeliberationPacket({
    turnId: 'turn-test',
    text,
    now: NOW,
    mode: 'shadow',
    ...options,
  });
}

describe('grounded response intelligence', () => {
  it('defaults invalid configuration to shadow', () => {
    expect(resolveGroundedAdvisoryMode(undefined)).toBe('shadow');
    expect(resolveGroundedAdvisoryMode('assistive')).toBe('assistive');
    expect(resolveGroundedAdvisoryMode('unsafe')).toBe('shadow');
  });

  it('preserves independent clauses and targets', () => {
    const intents = decomposeGroundedIntents(
      'Check my calendar tomorrow, then research the latest train schedule; also remind me to call Sam.',
    );
    expect(intents).toHaveLength(3);
    expect(intents.map((intent) => intent.actionClass)).toEqual([
      'calendar_read',
      'research',
      'reminder_write',
    ]);
    expect(intents.every((intent) => intent.originalClause.length > 0)).toBe(
      true,
    );
    expect(intents[2]?.target).toContain('call Sam');
  });

  it('does not split conjunctions inside quotes or ordinary titles', () => {
    expect(
      decomposeGroundedIntents(
        'Summarize “War and Peace” and explain its ending.',
      ),
    ).toHaveLength(2);
    expect(
      decomposeGroundedIntents(
        'Find the event called Research and Development',
      ),
    ).toHaveLength(1);
  });

  it('distinguishes an action request from a historical mutation reference', () => {
    expect(decomposeGroundedIntents('Send Sam the report.')[0]).toMatchObject({
      actionClass: 'communication_write',
      approvalRequired: true,
    });
    expect(
      decomposeGroundedIntents('Was the message actually delivered?')[0],
    ).toMatchObject({
      actionClass: 'communication_read',
      approvalRequired: false,
    });
    expect(
      decomposeGroundedIntents('Continue the active goal after restart.')[0],
    ).toMatchObject({ approvalRequired: false });
  });

  it('keeps execution authority structurally false and context bounded', () => {
    const result = packet('Research this and send a message to Sam.');
    expect(result.executionAuthority).toBe(false);
    expect(result.responseContract.maxRepairAttempts).toBe(1);
    expect(result.budgets.contextChars).toBeLessThanOrEqual(
      result.budgets.contextLimit,
    );
    expect(
      formatGroundedDeliberationGuidance(result).length,
    ).toBeLessThanOrEqual(4_000);
  });

  it('excludes unsafe memory and exposes contradiction metadata from the bundle', () => {
    const bundle: GroundedContextBundle = {
      bundleId: 'bundle-1',
      generatedAt: NOW,
      topics: ['travel'],
      items: [
        {
          recordId: 'memory-1',
          kind: 'preference',
          subjectKey: 'travel:seat',
          statement: 'User prefers aisle seats.',
          value: 'aisle',
          confidence: 0.9,
          sourceType: 'user_statement',
          observedAt: NOW,
          relevance: 0.9,
          inclusionReason: 'current direct preference',
          provenanceRefs: ['turn-old'],
        },
      ],
      goals: [],
      contradictions: [
        {
          subjectKey: 'travel:seat',
          recordIds: ['memory-1', 'memory-2'],
          note: 'Seat preference changed and is unresolved.',
        },
      ],
      uncertainties: ['Current seat preference is uncertain.'],
      excluded: [{ recordId: 'secret-1', reason: 'sensitivity' }],
      budget: {
        maxItems: 8,
        maxChars: 4_000,
        usedChars: 40,
        truncated: false,
      },
      retrievalReasoning: [],
    };
    const result = packet('What seat should I select?', {
      turnId: 'turn-test',
      text: 'What seat should I select?',
      memoryBundle: bundle,
    });
    expect(result.contradictions).toContain(
      'Seat preference changed and is unresolved.',
    );
    expect(result.excludedEvidence).toEqual([
      { ref: 'secret-1', reason: 'sensitivity' },
    ]);
    expect(
      result.selectedEvidence.some((item) => item.ref === 'secret-1'),
    ).toBe(false);
  });

  it('detects missing intents, targets, and unsupported completion', () => {
    const result = packet(
      'Research the train schedule, then send the itinerary to Sam.',
    );
    const evaluation = evaluateGroundedResponse(
      result,
      'I sent it. The train information is ready.',
    );
    expect(evaluation.status).toBe('block');
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      'unsupported_completion',
    );
    expect(evaluation.invariantResults.noExecutionAuthority).toBe(true);
    expect(evaluation.invariantResults.noUnsupportedCompletion).toBe(false);
  });

  it('allows one bounded text-only repair and re-evaluates it', () => {
    const result = packet('Research the train schedule, then message Sam.', {
      turnId: 'turn-test',
      text: 'Research the train schedule, then message Sam.',
      blockers: ['Messaging provider is unavailable.'],
    });
    const initial = evaluateGroundedResponse(result, 'I sent it.');
    const repaired = repairGroundedResponse(result, 'I sent it.', initial);
    expect(repaired.attempts).toBe(1);
    expect(repaired.applied).toBe(true);
    expect(repaired.text).toMatch(/not yet|cannot safely/i);
    expect(repaired.text).not.toMatch(/^I sent it\.$/i);
  });

  it('blocks secret-shaped output with a safe fallback', () => {
    const result = packet('Explain the configuration.');
    const repaired = repairGroundedResponse(
      result,
      'The API key: abc123 should work.',
    );
    expect(repaired.reason).toBe('privacy_safe_fallback');
    expect(repaired.text).not.toContain('abc123');
  });

  it('passes a complete, calibrated multi-intent reply', () => {
    const result = packet(
      'Explain photosynthesis, then compare it with cellular respiration.',
    );
    const evaluation = evaluateGroundedResponse(
      result,
      'Photosynthesis stores energy by making sugars from light. Cellular respiration releases energy from sugars; the comparison is that the products of one process feed the other.',
    );
    expect(evaluation.status).toBe('pass');
    expect(evaluation.metrics.intentCoverage).toBe(1);
    expect(evaluation.metrics.targetPreservation).toBe(1);
  });

  it('records shadow evaluation without changing the reply', async () => {
    const prior = process.env.GROUNDED_ADVISORY_MODE;
    process.env.GROUNDED_ADVISORY_MODE = 'shadow';
    try {
      const context = await beginTurnAgentHarness({
        turnId: 'shadow-turn',
        channel: 'telegram',
        text: 'Explain photosynthesis, then compare it with respiration.',
        runOrigin: 'replay',
      });
      expect(context?.groundedDeliberation?.mode).toBe('shadow');
      const evaluation = evaluateTurnReply({
        context,
        text: 'Photosynthesis uses light to store energy.',
        responseSource: 'container_agent',
      });
      expect(evaluation.rewrittenText).toBe(
        'Photosynthesis uses light to store energy.',
      );
      expect(evaluation.groundedResponseEvaluation?.status).toBe('repair');
      expect(
        context?.contextCompile.metadata.grounded_advisory_repair_attempts,
      ).toBe('0');
    } finally {
      if (prior === undefined) delete process.env.GROUNDED_ADVISORY_MODE;
      else process.env.GROUNDED_ADVISORY_MODE = prior;
    }
  });

  it('uses one text-only repair in assistive mode', async () => {
    const prior = process.env.GROUNDED_ADVISORY_MODE;
    process.env.GROUNDED_ADVISORY_MODE = 'assistive';
    try {
      const context = await beginTurnAgentHarness({
        turnId: 'assistive-turn',
        channel: 'telegram',
        text: 'Explain photosynthesis, then compare it with respiration.',
        runOrigin: 'replay',
      });
      const evaluation = evaluateTurnReply({
        context,
        text: 'Photosynthesis uses light to store energy.',
        responseSource: 'container_agent',
      });
      expect(evaluation.safeRewriteApplied).toBe(true);
      expect(evaluation.evaluatorFlags).toContain('grounded_advisory_repair');
      expect(evaluation.rewrittenText).toMatch(/respiration/i);
      expect(
        context?.contextCompile.metadata.grounded_advisory_repair_attempts,
      ).toBe('1');
    } finally {
      if (prior === undefined) delete process.env.GROUNDED_ADVISORY_MODE;
      else process.env.GROUNDED_ADVISORY_MODE = prior;
    }
  });
});
