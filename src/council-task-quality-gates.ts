/*
 * Council task quality gates.
 *
 * Family-level scoring pattern adapted from GBrain's retrieval-quality
 * harness (MIT, commit 9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac).
 */

import type { CouncilTaskQualityGate } from './council-contracts.js';
import { redactCouncilText } from './council-safety.js';

export interface CouncilTaskQualityQuestion {
  gateId: string;
  family:
    | 'route_choice'
    | 'evidence_contract'
    | 'schema_validity'
    | 'verifier_participation'
    | 'outcome_signal'
    | 'privacy_redaction'
    | 'repair_next_action'
    | 'source_pattern';
  metric: string;
  actual: number;
  floor: number;
  warnFloor?: number;
  summary: string;
}

export interface CouncilTaskQualityReport {
  total: number;
  pass: boolean;
  score: number;
  gates: CouncilTaskQualityGate[];
}

export function scoreCouncilTaskQualityQuestion(
  question: CouncilTaskQualityQuestion,
): CouncilTaskQualityGate {
  const warnFloor = question.warnFloor ?? question.floor * 0.75;
  const actual = Number(Math.max(0, question.actual).toFixed(3));
  const floor = Number(Math.max(0, question.floor).toFixed(3));
  const status =
    actual >= floor ? 'pass' : actual >= warnFloor ? 'warn' : 'fail';
  return {
    gateId: redactCouncilText(question.gateId, 120),
    family: question.family,
    metric: redactCouncilText(question.metric, 80),
    actual,
    floor,
    status,
    summary: redactCouncilText(question.summary, 260),
  };
}

export function evaluateCouncilTaskQualityGates(
  questions: CouncilTaskQualityQuestion[],
): CouncilTaskQualityReport {
  const gates = questions.map(scoreCouncilTaskQualityQuestion);
  const score =
    gates.length > 0
      ? Number(
          (
            gates.reduce(
              (sum, gate) =>
                sum +
                (gate.status === 'pass' ? 1 : gate.status === 'warn' ? 0.5 : 0),
              0,
            ) / gates.length
          ).toFixed(3),
        )
      : 0;
  return {
    total: gates.length,
    pass: gates.every((gate) => gate.status !== 'fail'),
    score,
    gates,
  };
}
