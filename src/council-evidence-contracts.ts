/*
 * Council evidence contract helpers.
 *
 * Evidence/create-safety and source-priority patterns adapted from
 * garrytan/gbrain (MIT, commit 9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac),
 * especially docs/guides/source-attribution.md and src/core/search/evidence.ts.
 * Andrea keeps this native to its SQLite/privacy model.
 */

import type {
  CouncilCreateSafety,
  CouncilEvidenceCard,
  CouncilEvidenceContract,
  CouncilEvidenceSignal,
  CouncilSourceAttribution,
} from './council-contracts.js';
import { redactCouncilText } from './council-safety.js';

const SOURCE_PRIORITY: Record<CouncilEvidenceCard['sourceClass'], number> = {
  user_input: 100,
  local_memory: 90,
  knowledge: 78,
  runtime: 72,
  public_web: 62,
  provider_health: 50,
  policy: 45,
};

export function classifyCouncilEvidenceSignal(
  card: CouncilEvidenceCard,
): CouncilEvidenceSignal {
  if (card.sourceClass === 'user_input') return 'user_direct';
  if (card.sourceClass === 'local_memory') return 'local_compiled_truth';
  if (card.sourceClass === 'knowledge') return 'local_compiled_truth';
  if (card.sourceClass === 'public_web') return 'public_web';
  if (card.sourceClass === 'provider_health') return 'provider_health';
  if (card.sourceClass === 'policy') return 'policy_contract';
  if (card.sourceClass === 'runtime') return 'integration_live';
  return 'weak_semantic';
}

export function createSafetyForCouncilEvidence(
  card: CouncilEvidenceCard,
  evidence = classifyCouncilEvidenceSignal(card),
): CouncilCreateSafety {
  if (card.gap) return 'unknown';
  if (card.evidenceGrade === 'strong') return 'exists';
  if (
    evidence === 'user_direct' ||
    evidence === 'local_compiled_truth' ||
    evidence === 'integration_live' ||
    evidence === 'policy_contract'
  ) {
    return card.evidenceGrade === 'weak' ? 'probable' : 'exists';
  }
  if (evidence === 'public_web' || evidence === 'provider_health') {
    return card.evidenceGrade === 'weak' ? 'unknown' : 'probable';
  }
  return 'unknown';
}

export function sourcePriorityForCouncilEvidence(
  card: CouncilEvidenceCard,
): number {
  const base = SOURCE_PRIORITY[card.sourceClass] ?? 20;
  const gradeBoost =
    card.evidenceGrade === 'strong'
      ? 10
      : card.evidenceGrade === 'partial'
        ? 4
        : card.evidenceGrade === 'weak'
          ? -8
          : -12;
  const freshnessBoost =
    card.freshness === 'fresh'
      ? 6
      : card.freshness === 'stale'
        ? -8
        : card.freshness === 'not_applicable'
          ? 0
          : -3;
  const gapPenalty = card.gap ? -20 : 0;
  return Math.max(
    0,
    Math.min(120, base + gradeBoost + freshnessBoost + gapPenalty),
  );
}

export function buildCouncilCitationLabel(card: CouncilEvidenceCard): string {
  const sourceId = redactCouncilText(card.evidenceId, 120);
  const context = card.sourceClass.replace(/_/g, ' ');
  const freshness =
    card.freshness === 'not_applicable' ? 'not time-bound' : card.freshness;
  return redactCouncilText(
    `[Source: ${context}, ${sourceId}, ${freshness}]`,
    180,
  );
}

export function buildCouncilSourceAttribution(
  card: CouncilEvidenceCard,
): CouncilSourceAttribution {
  return {
    sourceId: redactCouncilText(card.evidenceId, 160),
    sourceClass: card.sourceClass,
    sourcePriority: sourcePriorityForCouncilEvidence(card),
    citationLabel: buildCouncilCitationLabel(card),
    freshness: card.freshness,
    sensitivity: card.sensitivity,
  };
}

export function buildCouncilEvidenceContract(
  card: CouncilEvidenceCard,
): CouncilEvidenceContract {
  const evidence = classifyCouncilEvidenceSignal(card);
  const sourceAttribution = buildCouncilSourceAttribution(card);
  return {
    evidence,
    createSafety: createSafetyForCouncilEvidence(card, evidence),
    sourcePriority: sourceAttribution.sourcePriority,
    citationLabel: sourceAttribution.citationLabel,
    availableToCouncil:
      card.availableToCouncil ?? card.sensitivity !== 'sensitive',
    conflictGroup: card.conflictGroup || null,
    conflictsWithEvidenceIds: card.conflictsWithEvidenceIds || [],
    sourceAttribution,
  };
}

export function attachCouncilEvidenceContract<T extends CouncilEvidenceCard>(
  card: T,
): T & CouncilEvidenceContract {
  const contract = buildCouncilEvidenceContract(card);
  return {
    ...card,
    evidence: contract.evidence,
    createSafety: contract.createSafety,
    sourcePriority: contract.sourcePriority,
    citationLabel: contract.citationLabel,
    availableToCouncil: contract.availableToCouncil,
    conflictGroup: contract.conflictGroup,
    conflictsWithEvidenceIds: contract.conflictsWithEvidenceIds,
    sourceAttribution: contract.sourceAttribution,
  };
}

export function attachCouncilEvidenceContracts(
  cards: CouncilEvidenceCard[],
): CouncilEvidenceCard[] {
  const enriched = cards.map((card) => attachCouncilEvidenceContract(card));
  const byConflict = new Map<string, CouncilEvidenceCard[]>();
  for (const card of enriched) {
    const key = deriveConflictGroup(card);
    if (!key) continue;
    const bucket = byConflict.get(key) || [];
    bucket.push(card);
    byConflict.set(key, bucket);
  }
  for (const [group, bucket] of byConflict) {
    const hasDifferentSummaries =
      new Set(bucket.map((card) => card.summary.toLowerCase().slice(0, 80)))
        .size > 1;
    if (!hasDifferentSummaries || bucket.length < 2) continue;
    for (const card of bucket) {
      card.conflictGroup = group;
      card.conflictsWithEvidenceIds = bucket
        .map((other) => other.evidenceId)
        .filter((id) => id !== card.evidenceId);
    }
  }
  return enriched.map((card) => attachCouncilEvidenceContract(card));
}

function deriveConflictGroup(card: CouncilEvidenceCard): string | null {
  if (card.sourceClass !== 'local_memory' && card.sourceClass !== 'knowledge') {
    return null;
  }
  const [prefix, id] = card.evidenceId.split(':');
  if (!prefix || !id) return null;
  return `${prefix}:${id}`;
}
