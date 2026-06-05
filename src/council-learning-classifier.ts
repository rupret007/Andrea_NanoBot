/*
 * Deterministic council-learning classifier.
 *
 * Duplicate/supersede/independent fallback pattern adapted from
 * garrytan/gbrain/src/core/facts/classify.ts (MIT, commit
 * 9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac). Andrea uses sanitized
 * text similarity only; no raw private bodies or LLM classifier output
 * are persisted here.
 */

import { redactCouncilText } from './council-safety.js';

export type CouncilLearningClassification =
  | {
      decision: 'duplicate';
      matchedId: string;
      score: number;
      reason: 'text_fast_path';
    }
  | {
      decision: 'supersede';
      matchedId: string;
      score: number;
      reason: 'correction_signal';
    }
  | {
      decision: 'independent';
      score: number;
      reason: 'no_candidates' | 'text_fallback';
    };

export interface CouncilLearningCandidateForClassification {
  id: string;
  summary: string;
}

export function jaccardTextSimilarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union > 0 ? intersection / union : 0;
}

export function classifyCouncilLearningCandidate(input: {
  summary: string;
  candidates: CouncilLearningCandidateForClassification[];
  duplicateThreshold?: number;
  supersedeThreshold?: number;
}): CouncilLearningClassification {
  const summary = redactCouncilText(input.summary, 700);
  if (input.candidates.length === 0) {
    return { decision: 'independent', score: 0, reason: 'no_candidates' };
  }
  let best: CouncilLearningCandidateForClassification | null = null;
  let bestScore = 0;
  for (const candidate of input.candidates) {
    const score = jaccardTextSimilarity(summary, candidate.summary);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const duplicateThreshold = input.duplicateThreshold ?? 0.78;
  if (best && bestScore >= duplicateThreshold) {
    return {
      decision: 'duplicate',
      matchedId: best.id,
      score: Number(bestScore.toFixed(3)),
      reason: 'text_fast_path',
    };
  }
  const supersedeThreshold = input.supersedeThreshold ?? 0.48;
  if (
    best &&
    bestScore >= supersedeThreshold &&
    /\b(correct|correction|instead|actually|supersede|replace|no longer)\b/i.test(
      summary,
    )
  ) {
    return {
      decision: 'supersede',
      matchedId: best.id,
      score: Number(bestScore.toFixed(3)),
      reason: 'correction_signal',
    };
  }
  return {
    decision: 'independent',
    score: Number(bestScore.toFixed(3)),
    reason: 'text_fallback',
  };
}

function tokenize(value: string): Set<string> {
  return new Set(
    redactCouncilText(value, 1000)
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}
