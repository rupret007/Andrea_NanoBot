import {
  listLifeThreadsForGroup,
  listPersonalMemoryPolicies,
  listProfileFactsForGroup,
} from './db.js';
import { buildIntegrationDoctorReport } from './integration-doctor.js';
import { resolveLifeThreadTimeZone } from './life-threads.js';
import {
  describeLifeThreadCommitment,
  getLifeThreadCommitment,
  shouldProactivelySurfaceCommitment,
} from './life-thread-commitment.js';
import { searchKnowledgeLibrary } from './knowledge-library.js';
import type {
  CouncilEvidenceCard,
  CouncilEvidenceGrade,
  CouncilEvidencePack,
  CouncilEvidenceScorecard,
} from './council-contracts.js';
import type { LifeThreadSourceKind, PersonalMemorySource } from './types.js';
import { redactCouncilText } from './council-safety.js';
import type { PlatformTaskFamily } from './andrea-platform-bridge.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import { attachCouncilEvidenceContracts } from './council-evidence-contracts.js';

export interface BuildCouncilEvidencePackInput {
  goal: string;
  taskFamily: PlatformTaskFamily;
  groupFolder?: string | null;
  requiredEvidence?: CouncilEvidenceGrade;
  rawContentPolicy?: 'metadata_only' | 'local_only' | 'sanitized_snippets';
  metadata?: Record<string, string>;
  correlationId?: string | null;
  providerHealthSnapshots?: ProviderHealthSnapshot[];
  /**
   * Source classes the owner explicitly approved for provider-visible council
   * snippets in this request. Local memory opt-in is necessary but is not, by
   * itself, provider-egress consent.
   */
  providerConsentedSources?: PersonalMemorySource[];
  now?: Date;
}

function lifeThreadPersonalMemorySource(
  sourceKind: LifeThreadSourceKind,
): PersonalMemorySource | null {
  // Calendar is the only life-thread origin currently preserved with enough
  // precision to bind it to a memory-source policy. `explicit`, `reminder`,
  // `draft`, and derived sources may originate on several channels, so they
  // fail closed until durable per-thread source provenance exists.
  return sourceKind === 'calendar' ? 'calendar' : null;
}

function hasProviderVisibleLifeThreadConsent(input: {
  source: PersonalMemorySource | null;
  providerConsentedSources: PersonalMemorySource[];
  policies: ReturnType<typeof listPersonalMemoryPolicies>;
}): boolean {
  if (!input.source || !input.providerConsentedSources.includes(input.source)) {
    return false;
  }
  const policy = input.policies.find(
    (candidate) => candidate.source === input.source,
  );
  return Boolean(
    policy?.enabled &&
    policy.allowDerivedFacts &&
    policy.consentedAt &&
    !policy.revokedAt,
  );
}

export function buildCouncilEvidencePack(
  input: BuildCouncilEvidencePackInput,
): CouncilEvidencePack {
  const groupFolder = input.groupFolder || 'main';
  const now = input.now || new Date();
  const rawContentPolicy = input.rawContentPolicy || 'sanitized_snippets';
  const metadataIntent = `Intent metadata: task_family=${input.taskFamily}, characters=${input.goal.length}, correlation=${input.correlationId || 'local'}.`;
  const includePersonalContext = [
    'assistant',
    'calendar',
    'communication',
  ].includes(input.taskFamily);
  const includeIntegrationStatus =
    input.taskFamily === 'operator' ||
    input.taskFamily === 'code' ||
    /\b(integration|service|runtime|gateway|bridge|bluebubbles|telegram|alexa|openclaw)\b/i.test(
      input.goal,
    );
  const cards: CouncilEvidenceCard[] = [
    {
      evidenceId: `intent:${input.correlationId || 'local'}`,
      sourceClass: 'user_input',
      evidenceGrade: 'partial',
      freshness: 'fresh',
      sensitivity: 'private',
      summary:
        rawContentPolicy === 'sanitized_snippets'
          ? `Sanitized user goal: ${redactCouncilText(input.goal, 320)}`
          : metadataIntent,
      availableToCouncil: rawContentPolicy !== 'local_only',
    },
    {
      evidenceId: `policy:${input.rawContentPolicy || 'sanitized_snippets'}`,
      sourceClass: 'policy',
      evidenceGrade: 'partial',
      freshness: 'not_applicable',
      sensitivity: 'normal',
      summary: `Raw content policy is ${input.rawContentPolicy || 'sanitized_snippets'}; council may use sanitized summaries and IDs, not raw private bodies.`,
    },
  ];
  const gaps: string[] = [];

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    const metadataEntries = Object.entries(input.metadata).slice(0, 8);
    cards.push({
      evidenceId: `metadata:${input.correlationId || 'local'}`,
      sourceClass: 'runtime',
      evidenceGrade: 'partial',
      freshness: 'fresh',
      sensitivity: 'normal',
      summary:
        rawContentPolicy === 'sanitized_snippets'
          ? redactCouncilText(
              metadataEntries
                .map(([key, value]) => `${key}=${value}`)
                .join(', '),
              360,
            )
          : `Runtime metadata keys: ${
              metadataEntries
                .map(([key]) =>
                  key.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 48),
                )
                .filter(Boolean)
                .join(', ') || 'none'
            }. Values withheld by policy.`,
      availableToCouncil: rawContentPolicy !== 'local_only',
    });
  }

  if (includePersonalContext) {
    try {
      const profileFacts = listProfileFactsForGroup(groupFolder, ['accepted'])
        .slice(0, 3)
        .map((fact) => ({
          evidenceId: `profile_fact:${fact.id}`,
          sourceClass: 'local_memory' as const,
          evidenceGrade: 'partial' as const,
          freshness: 'unknown' as const,
          sensitivity: 'private' as const,
          // Profile facts do not yet carry a per-record sensitivity/consent
          // classification. Keep their values local and expose only bounded
          // metadata until that contract exists; regex redaction is not a
          // semantic privacy boundary.
          summary: `Accepted profile-fact metadata: id=${fact.id}, category=${fact.category}, updated=${fact.updatedAt}.`,
          availableToCouncil: rawContentPolicy !== 'local_only',
        }));
      cards.push(...profileFacts);
      if (profileFacts.length === 0) gaps.push('no_profile_facts');
    } catch {
      gaps.push('profile_facts_unavailable');
    }

    try {
      const memoryPolicies = listPersonalMemoryPolicies(groupFolder);
      const providerConsentedSources = Array.from(
        new Set(input.providerConsentedSources || []),
      );
      const lifeThreads = listLifeThreadsForGroup(groupFolder, ['active'])
        .slice(0, 3)
        .map((thread) => {
          const commitment = getLifeThreadCommitment(thread);
          const source = lifeThreadPersonalMemorySource(thread.sourceKind);
          const sourceConsented = hasProviderVisibleLifeThreadConsent({
            source,
            providerConsentedSources,
            policies: memoryPolicies,
          });
          const stateRequiresMetadataOnly = [
            'waiting',
            'blocked',
            'delegated',
            'deferred',
          ].includes(commitment.operationalState);
          const metadataOnly =
            rawContentPolicy !== 'sanitized_snippets' ||
            thread.sensitivity === 'sensitive' ||
            !sourceConsented ||
            stateRequiresMetadataOnly ||
            !shouldProactivelySurfaceCommitment(thread, now);
          return {
            evidenceId: `life_thread:${thread.id}`,
            sourceClass: 'local_memory' as const,
            evidenceGrade: 'partial' as const,
            freshness: thread.lastUpdatedAt
              ? ('fresh' as const)
              : ('unknown' as const),
            sensitivity:
              thread.sensitivity === 'sensitive'
                ? ('sensitive' as const)
                : ('private' as const),
            summary: metadataOnly
              ? `Life-thread metadata: id=${thread.id}, state=${commitment.operationalState}, owner=${commitment.owner.kind}, strength=${commitment.strength}, updated=${thread.lastUpdatedAt}.`
              : redactCouncilText(
                  `${thread.title}: ${describeLifeThreadCommitment(
                    thread,
                    now,
                    resolveLifeThreadTimeZone(thread.groupFolder),
                  )}`,
                  320,
                ),
            availableToCouncil: rawContentPolicy !== 'local_only',
          };
        });
      cards.push(...lifeThreads);
      if (lifeThreads.length === 0) gaps.push('no_active_life_threads');
    } catch {
      gaps.push('life_threads_unavailable');
    }
  }

  try {
    const knowledge = searchKnowledgeLibrary({
      groupFolder,
      query: input.goal,
      limit: 3,
    });
    const knowledgeCards = knowledge.hits.slice(0, 3).map((hit) => {
      const metadataOnly =
        rawContentPolicy !== 'sanitized_snippets' ||
        hit.sensitivity === 'sensitive';
      return {
        evidenceId: `knowledge:${hit.sourceId}:${hit.chunkId}`,
        sourceClass: 'knowledge' as const,
        evidenceGrade:
          hit.retrievalScore >= 0.5 ? ('partial' as const) : ('weak' as const),
        freshness: 'unknown' as const,
        sensitivity:
          hit.sensitivity === 'sensitive'
            ? ('sensitive' as const)
            : hit.sensitivity === 'private'
              ? ('private' as const)
              : ('normal' as const),
        summary: metadataOnly
          ? `Knowledge-hit metadata: source=${hit.sourceId}, chunk=${hit.chunkId}, sensitivity=${hit.sensitivity}, score_band=${hit.retrievalScore >= 0.5 ? 'relevant' : 'weak'}.`
          : redactCouncilText(
              `${hit.sourceTitle}: ${hit.excerpt} (${hit.matchReason})`,
              360,
            ),
        availableToCouncil: rawContentPolicy !== 'local_only',
      };
    });
    cards.push(...knowledgeCards);
    if (knowledgeCards.length === 0) gaps.push('no_saved_knowledge_hits');
  } catch {
    gaps.push('knowledge_search_unavailable');
  }

  try {
    const providers =
      input.providerHealthSnapshots || collectProviderHealthSnapshots();
    const providerCards = providers.slice(0, 8).map((provider) => ({
      evidenceId: `provider_health:${provider.providerId}`,
      sourceClass: 'provider_health' as const,
      evidenceGrade:
        provider.state === 'healthy' ? ('partial' as const) : ('weak' as const),
      freshness: 'fresh' as const,
      sensitivity: 'normal' as const,
      summary: redactCouncilText(
        `${provider.providerId}: state=${provider.state}, credential=${provider.credentialState}, quota=${provider.quotaState}, failure=${provider.failureClass}, next=${provider.nextAction || 'none'}`,
        360,
      ),
      gap:
        provider.state === 'healthy'
          ? null
          : `provider_${provider.providerId}_${provider.state}`,
    }));
    cards.push(...providerCards);
    providerCards
      .filter((card) => card.gap)
      .forEach((card) => gaps.push(card.gap!));
  } catch {
    gaps.push('provider_health_unavailable');
  }

  if (includeIntegrationStatus) {
    try {
      const report = buildIntegrationDoctorReport();
      const troubled = report.statuses.filter(
        (status) => status.state !== 'healthy',
      );
      cards.push({
        evidenceId: `integration_status:${input.correlationId || 'local'}`,
        sourceClass: 'runtime',
        evidenceGrade: troubled.length === 0 ? 'partial' : 'weak',
        freshness: 'fresh',
        sensitivity: 'normal',
        summary: redactCouncilText(
          `Integration summary: healthy=${report.summary.healthy}/${report.summary.total}, action_needed=${report.summary.actionNeeded}, needs_proof=${report.summary.needsProof}, external=${report.summary.manualOrExternal}. Troubled: ${
            troubled
              .slice(0, 5)
              .map((status) => `${status.integrationId}:${status.state}`)
              .join(', ') || 'none'
          }`,
          420,
        ),
        gap: troubled.length > 0 ? 'integration_status_not_all_healthy' : null,
      });
      if (troubled.length > 0) {
        gaps.push(
          ...troubled
            .slice(0, 5)
            .map(
              (status) => `integration_${status.integrationId}_${status.state}`,
            ),
        );
      }
    } catch {
      gaps.push('integration_status_unavailable');
    }
  }

  const requiredEvidence = input.requiredEvidence || 'unknown';
  const enrichedCards = attachCouncilEvidenceContracts(cards);
  const overallGrade = deriveOverallGrade(enrichedCards);
  const pack: CouncilEvidencePack = {
    packId: `council-evidence:${input.correlationId || Date.now().toString(36)}`,
    taskFamily: input.taskFamily,
    requiredEvidence,
    overallGrade,
    rawContentPolicy: input.rawContentPolicy || 'sanitized_snippets',
    cards: enrichedCards,
    gaps: Array.from(new Set(gaps)),
    scorecard: buildCouncilEvidenceScorecard({
      cards: enrichedCards,
      gaps: Array.from(new Set(gaps)),
      requiredEvidence,
      rawContentPolicy: input.rawContentPolicy || 'sanitized_snippets',
      overallGrade,
    }),
  };
  return pack;
}

export function refreshCouncilEvidencePackScorecard(
  pack: CouncilEvidencePack,
): CouncilEvidencePack {
  pack.cards = attachCouncilEvidenceContracts(pack.cards);
  pack.overallGrade = deriveOverallGrade(pack.cards);
  pack.gaps = Array.from(new Set(pack.gaps));
  pack.scorecard = buildCouncilEvidenceScorecard({
    cards: pack.cards,
    gaps: pack.gaps,
    requiredEvidence: pack.requiredEvidence,
    rawContentPolicy: pack.rawContentPolicy,
    overallGrade: pack.overallGrade,
  });
  return {
    ...pack,
  };
}

export function summarizeCouncilEvidencePack(
  pack: CouncilEvidencePack,
): string {
  const availableCards = pack.cards.filter(
    (card) => card.availableToCouncil !== false,
  );
  const mandatoryCards = availableCards.filter(
    (card) =>
      card.sourceClass === 'user_input' || card.sourceClass === 'policy',
  );
  const rankedCards = availableCards
    .filter((card) => !mandatoryCards.includes(card))
    .sort((a, b) => (b.sourcePriority || 0) - (a.sourcePriority || 0));
  const lines = [
    `Evidence pack ${pack.packId}: overall=${pack.overallGrade}, required=${pack.requiredEvidence}, policy=${pack.rawContentPolicy}.`,
    ...[...mandatoryCards, ...rankedCards]
      .slice(0, 8)
      .map(
        (card) =>
          `${card.evidenceId} [${card.sourceClass}/${card.evidenceGrade}/${card.sensitivity}/${card.evidence || 'unknown'}/${card.createSafety || 'unknown'}]: ${card.summary} ${card.citationLabel || ''}`,
      ),
  ];
  if (pack.gaps.length > 0) {
    lines.push(`Gaps: ${pack.gaps.join(', ')}`);
  }
  return redactCouncilText(lines.join('\n'), 2400);
}

function deriveOverallGrade(
  cards: CouncilEvidenceCard[],
): CouncilEvidenceGrade {
  if (cards.some((card) => card.evidenceGrade === 'strong')) return 'strong';
  if (cards.some((card) => card.evidenceGrade === 'partial')) return 'partial';
  if (cards.some((card) => card.evidenceGrade === 'weak')) return 'weak';
  return 'unknown';
}

export function buildCouncilEvidenceScorecard(input: {
  cards: CouncilEvidenceCard[];
  gaps: string[];
  requiredEvidence: CouncilEvidenceGrade;
  rawContentPolicy: CouncilEvidencePack['rawContentPolicy'];
  overallGrade: CouncilEvidenceGrade;
}): CouncilEvidenceScorecard {
  const sourceCoverage: CouncilEvidenceScorecard['sourceCoverage'] = {};
  const createSafetyCoverage: CouncilEvidenceScorecard['createSafetyCoverage'] =
    {};
  const freshnessCoverage = {
    total: input.cards.length,
    fresh: 0,
    stale: 0,
    unknown: 0,
    notApplicable: 0,
  };
  let sourcePriorityTotal = 0;
  let cited = 0;
  for (const card of input.cards) {
    sourceCoverage[card.sourceClass] =
      (sourceCoverage[card.sourceClass] || 0) + 1;
    const createSafety = card.createSafety || 'unknown';
    createSafetyCoverage[createSafety] =
      (createSafetyCoverage[createSafety] || 0) + 1;
    sourcePriorityTotal += card.sourcePriority || 0;
    if (card.citationLabel) cited += 1;
    if (card.freshness === 'fresh') freshnessCoverage.fresh += 1;
    else if (card.freshness === 'stale') freshnessCoverage.stale += 1;
    else if (card.freshness === 'not_applicable') {
      freshnessCoverage.notApplicable += 1;
    } else {
      freshnessCoverage.unknown += 1;
    }
  }
  const sourceClasses = Array.from(
    new Set(input.cards.map((card) => card.sourceClass)),
  );
  const gradePenalty = gradeMeetsRequirement(
    input.overallGrade,
    input.requiredEvidence,
  )
    ? 0
    : input.requiredEvidence === 'strong'
      ? 0.18
      : input.requiredEvidence === 'partial'
        ? 0.1
        : 0;
  const gapPenalty =
    input.requiredEvidence === 'strong'
      ? Math.min(0.18, input.gaps.length * 0.02)
      : input.requiredEvidence === 'partial'
        ? Math.min(0.1, input.gaps.length * 0.01)
        : 0;
  const stalePenalty =
    input.requiredEvidence === 'strong' && freshnessCoverage.fresh === 0
      ? 0.05
      : 0;
  const citationPenalty =
    input.requiredEvidence !== 'unknown' &&
    input.cards.length > 0 &&
    cited < input.cards.length
      ? 0.04
      : 0;
  const safetyPenalty =
    input.requiredEvidence === 'strong' &&
    (createSafetyCoverage.exists || 0) === 0
      ? 0.05
      : 0;
  return {
    requiredGrade: input.requiredEvidence,
    availableGrade: input.overallGrade,
    freshnessCoverage,
    sourceCoverage,
    createSafetyCoverage,
    citationCoverage: {
      total: input.cards.length,
      cited,
      missing: Math.max(0, input.cards.length - cited),
    },
    averageSourcePriority:
      input.cards.length > 0
        ? Number((sourcePriorityTotal / input.cards.length).toFixed(1))
        : 0,
    privateContentPolicy: input.rawContentPolicy,
    gapCount: input.gaps.length,
    gapIds: input.gaps.map((gap) => redactCouncilText(gap, 120)),
    sourceClasses,
    confidencePenalty: Number(
      Math.min(
        0.34,
        gradePenalty +
          gapPenalty +
          stalePenalty +
          citationPenalty +
          safetyPenalty,
      ).toFixed(2),
    ),
  };
}

function gradeMeetsRequirement(
  actual: CouncilEvidenceGrade,
  required: CouncilEvidenceGrade,
): boolean {
  if (required === 'unknown' || required === 'weak') return true;
  const rank: Record<CouncilEvidenceGrade, number> = {
    unknown: 0,
    weak: 1,
    partial: 2,
    strong: 3,
  };
  return rank[actual] >= rank[required];
}
