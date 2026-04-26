import { describe, expect, it } from 'vitest';

import {
  buildMemoryConsolidationReport,
  buildMemoryIntelligenceReport,
  buildMemoryReadPlan,
  classifyMemoryCandidate,
  decideMemoryPromotion,
} from './assistant-memory-intelligence.js';

describe('assistant memory intelligence', () => {
  it('builds task-family memory read plans', () => {
    expect(buildMemoryReadPlan({ taskFamily: 'assistant' })).toMatchObject({
      taskFamily: 'assistant',
      readTiers: ['working', 'semantic', 'procedural'],
      hotPath: true,
    });

    expect(
      buildMemoryReadPlan({ taskFamily: 'repo_operator', asksForMemory: false }),
    ).toMatchObject({
      taskFamily: 'repo_operator',
      readTiers: ['working', 'procedural'],
    });
  });

  it('classifies grounded fact candidates conservatively', () => {
    const candidate = classifyMemoryCandidate({
      taskFamily: 'research',
      summary: 'User prefers Dallas weather summaries before 8am.',
      evidenceMode: 'grounded_source',
      grounded: true,
    });

    expect(candidate.writeClass).toBe('fact_candidate');
    expect(candidate.targetTier).toBe('semantic');
    expect(decideMemoryPromotion(candidate)).toMatchObject({
      decision: 'queue_background',
      targetTier: 'semantic',
    });
  });

  it('promotes repeated-success behavior toward procedural review', () => {
    const candidate = classifyMemoryCandidate({
      taskFamily: 'repo_operator',
      summary: 'Use codex_local first for repo repair loops.',
      evidenceMode: 'repeated_success',
      repeatedSuccessCount: 3,
    });

    expect(candidate.writeClass).toBe('procedure_candidate');
    expect(decideMemoryPromotion(candidate)).toMatchObject({
      decision: 'queue_background',
      targetTier: 'procedural',
    });
  });

  it('blocks high-conflict promotions from auto-writing', () => {
    const candidate = classifyMemoryCandidate({
      taskFamily: 'communication',
      summary: 'User wants very blunt replies in every context.',
      evidenceMode: 'session_observation',
      explicitUserConfirmation: false,
      conflictRisk: 'high',
    });

    expect(decideMemoryPromotion(candidate).decision).toBe('reject_conflict');
  });

  it('reports empty-group consolidation and intelligence metadata safely', () => {
    expect(buildMemoryConsolidationReport([])).toMatchObject({
      episodesReviewed: 0,
      promotionStatus: 'idle',
    });

    expect(buildMemoryIntelligenceReport([])).toMatchObject({
      arbitrationMode: 'task_family_scoped',
      semanticPromotionPolicy: 'grounded_or_confirmed_only',
      proceduralPromotionPolicy: 'repeated_success_or_outcome_review',
    });
  });
});
