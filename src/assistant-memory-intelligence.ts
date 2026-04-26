import {
  getTasksForGroup,
  listKnowledgeSourcesForGroup,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  listRitualProfilesForGroup,
} from './db.js';

export type AndreaMemoryTierId = 'working' | 'semantic' | 'procedural';
export type AndreaMemoryTaskFamily =
  | 'assistant'
  | 'communication'
  | 'calendar'
  | 'repo_operator'
  | 'research'
  | 'capture'
  | 'unknown';
export type AndreaMemoryWriteClass =
  | 'fact_candidate'
  | 'preference_candidate'
  | 'procedure_candidate'
  | 'episode_record'
  | 'outcome_learning';
export type AndreaMemoryEvidenceMode =
  | 'grounded_source'
  | 'explicit_confirmation'
  | 'repeated_success'
  | 'outcome_review'
  | 'session_observation';

export interface MemoryReadPlan {
  taskFamily: AndreaMemoryTaskFamily;
  readTiers: AndreaMemoryTierId[];
  hotPath: boolean;
  safeWriteClasses: AndreaMemoryWriteClass[];
  reason: string;
  sources: string[];
}

export interface MemoryCandidate {
  candidateId: string;
  writeClass: AndreaMemoryWriteClass;
  targetTier: AndreaMemoryTierId;
  taskFamily: AndreaMemoryTaskFamily;
  evidenceMode: AndreaMemoryEvidenceMode;
  summary: string;
  hotPath: boolean;
  repeatedSuccessCount: number;
  grounded: boolean;
  explicitUserConfirmation: boolean;
  conflictRisk: 'low' | 'medium' | 'high';
}

export interface MemoryPromotionDecision {
  candidateId: string;
  decision:
    | 'accept_hot_path'
    | 'queue_background'
    | 'require_confirmation'
    | 'reject_conflict'
    | 'reject_insufficient_grounding';
  targetTier: AndreaMemoryTierId;
  reason: string;
}

export interface MemoryConsolidationReport {
  episodesReviewed: number;
  semanticCandidates: number;
  proceduralCandidates: number;
  staleWorkingContextsExpired: number;
  conflictsDetected: number;
  promotionStatus: 'idle' | 'candidate_ready' | 'review_required';
  latestTouchedAt: string;
}

interface BuildMemoryReadPlanInput {
  taskFamily: AndreaMemoryTaskFamily;
  asksForMemory?: boolean;
  stateChanging?: boolean;
}

interface ClassifyMemoryCandidateInput {
  taskFamily: AndreaMemoryTaskFamily;
  summary: string;
  evidenceMode: AndreaMemoryEvidenceMode;
  repeatedSuccessCount?: number;
  explicitUserConfirmation?: boolean;
  grounded?: boolean;
  conflictRisk?: 'low' | 'medium' | 'high';
}

function safeList<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function latestIso(current: string, candidate?: string | null): string {
  if (!candidate) return current;
  if (!current || current === 'not_yet_indexed') return candidate;
  return candidate > current ? candidate : current;
}

export function buildMemoryReadPlan(
  input: BuildMemoryReadPlanInput,
): MemoryReadPlan {
  const asksForMemory = input.asksForMemory === true;
  const stateChanging = input.stateChanging === true;

  switch (input.taskFamily) {
    case 'assistant':
      return {
        taskFamily: input.taskFamily,
        readTiers: ['working', 'semantic', 'procedural'],
        hotPath: true,
        safeWriteClasses: ['episode_record', 'outcome_learning'],
        reason:
          'Chief-of-staff and planning work need continuity, personal context, and procedural guidance together.',
        sources: ['active life threads', 'accepted profile facts', 'ritual profiles'],
      };
    case 'communication':
      return {
        taskFamily: input.taskFamily,
        readTiers: ['working', 'semantic', 'procedural'],
        hotPath: true,
        safeWriteClasses: ['episode_record', 'preference_candidate'],
        reason:
          'Reply help needs recent continuity plus stable people/preferences context, but durable writes stay conservative.',
        sources: ['thread continuity', 'people facts', 'communication preferences'],
      };
    case 'calendar':
      return {
        taskFamily: input.taskFamily,
        readTiers: asksForMemory ? ['working', 'semantic'] : ['working'],
        hotPath: true,
        safeWriteClasses: ['episode_record'],
        reason:
          'Calendar tasks mostly need active continuity; semantic memory helps only when titles/people context matters.',
        sources: ['active open loops', 'calendar-linked people/project facts'],
      };
    case 'repo_operator':
      return {
        taskFamily: input.taskFamily,
        readTiers: ['working', 'procedural'],
        hotPath: true,
        safeWriteClasses: ['episode_record', 'outcome_learning'],
        reason:
          'Repo and operator work should prefer current runtime context plus proven operating rules, not broad personal memory.',
        sources: ['current work state', 'procedural guardrails'],
      };
    case 'research':
      return {
        taskFamily: input.taskFamily,
        readTiers: asksForMemory ? ['working', 'semantic'] : ['working'],
        hotPath: true,
        safeWriteClasses: ['episode_record', 'fact_candidate'],
        reason:
          'Research needs saved context when it exists, but factual promotion still requires grounded evidence.',
        sources: ['saved sources', 'recent watchlist context'],
      };
    case 'capture':
      return {
        taskFamily: input.taskFamily,
        readTiers: ['working', 'semantic'],
        hotPath: stateChanging,
        safeWriteClasses: [
          'episode_record',
          'fact_candidate',
          'preference_candidate',
          'procedure_candidate',
        ],
        reason:
          'Capture flows read enough context to avoid duplication, then stage structured candidates instead of writing blind.',
        sources: ['saved knowledge sources', 'accepted facts', 'current continuity'],
      };
    case 'unknown':
    default:
      return {
        taskFamily: 'unknown',
        readTiers: ['working'],
        hotPath: true,
        safeWriteClasses: ['episode_record'],
        reason:
          'Unknown tasks should stay conservative: use recent continuity first and avoid durable writes until the task is understood.',
        sources: ['recent continuity only'],
      };
  }
}

export function classifyMemoryCandidate(
  input: ClassifyMemoryCandidateInput,
): MemoryCandidate {
  const repeatedSuccessCount = input.repeatedSuccessCount ?? 0;
  const explicitUserConfirmation = input.explicitUserConfirmation === true;
  const grounded = input.grounded === true;
  const conflictRisk = input.conflictRisk ?? 'low';

  let writeClass: AndreaMemoryWriteClass = 'episode_record';
  let targetTier: AndreaMemoryTierId = 'working';
  let hotPath = true;

  if (input.evidenceMode === 'outcome_review') {
    writeClass = 'outcome_learning';
    targetTier = 'procedural';
    hotPath = false;
  } else if (
    input.evidenceMode === 'repeated_success' ||
    repeatedSuccessCount >= 2
  ) {
    writeClass = 'procedure_candidate';
    targetTier = 'procedural';
    hotPath = false;
  } else if (grounded || explicitUserConfirmation) {
    writeClass =
      input.taskFamily === 'communication' ? 'preference_candidate' : 'fact_candidate';
    targetTier = 'semantic';
    hotPath = false;
  }

  return {
    candidateId: `${input.taskFamily}:${writeClass}:${input.summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)}`,
    writeClass,
    targetTier,
    taskFamily: input.taskFamily,
    evidenceMode: input.evidenceMode,
    summary: input.summary,
    hotPath,
    repeatedSuccessCount,
    grounded,
    explicitUserConfirmation,
    conflictRisk,
  };
}

export function decideMemoryPromotion(
  candidate: MemoryCandidate,
): MemoryPromotionDecision {
  if (candidate.conflictRisk === 'high') {
    return {
      candidateId: candidate.candidateId,
      decision: 'reject_conflict',
      targetTier: candidate.targetTier,
      reason:
        'Candidate conflicts with existing memory strongly enough that Andrea should not auto-promote it.',
    };
  }

  if (candidate.writeClass === 'episode_record') {
    return {
      candidateId: candidate.candidateId,
      decision: 'accept_hot_path',
      targetTier: 'working',
      reason:
        'Working memory updates are safe on the hot path and do not imply durable promotion.',
    };
  }

  if (candidate.writeClass === 'fact_candidate') {
    return candidate.grounded || candidate.explicitUserConfirmation
      ? {
          candidateId: candidate.candidateId,
          decision: 'queue_background',
          targetTier: 'semantic',
          reason:
            'Semantic facts should only promote after grounded evidence or explicit user confirmation.',
        }
      : {
          candidateId: candidate.candidateId,
          decision: 'require_confirmation',
          targetTier: 'semantic',
          reason:
            'Potential fact is useful, but Andrea should ask or wait for evidence before treating it as durable memory.',
        };
  }

  if (candidate.writeClass === 'preference_candidate') {
    return candidate.explicitUserConfirmation
      ? {
          candidateId: candidate.candidateId,
          decision: 'queue_background',
          targetTier: 'semantic',
          reason:
            'Preference candidates can promote once the user has clearly expressed or confirmed them.',
        }
      : {
          candidateId: candidate.candidateId,
          decision: 'require_confirmation',
          targetTier: 'semantic',
          reason:
            'Preference candidates should stay provisional until the user confirms the pattern.',
        };
  }

  if (candidate.writeClass === 'procedure_candidate') {
    return candidate.repeatedSuccessCount >= 2
      ? {
          candidateId: candidate.candidateId,
          decision: 'queue_background',
          targetTier: 'procedural',
          reason:
            'Repeatedly successful behavior can be proposed for procedural promotion in background review.',
        }
      : {
          candidateId: candidate.candidateId,
          decision: 'reject_insufficient_grounding',
          targetTier: 'procedural',
          reason:
            'Procedural promotion requires repeated success or review, not a one-off observation.',
        };
  }

  return {
    candidateId: candidate.candidateId,
    decision: 'queue_background',
    targetTier: 'procedural',
    reason:
      'Outcome learnings belong in background review so Andrea can improve without mutating live personal memory carelessly.',
  };
}

export function buildMemoryConsolidationReport(
  groupFolders: readonly string[],
): MemoryConsolidationReport {
  let episodesReviewed = 0;
  let semanticCandidates = 0;
  let proceduralCandidates = 0;
  let staleWorkingContextsExpired = 0;
  let conflictsDetected = 0;
  let latestTouchedAt = 'not_yet_indexed';

  for (const groupFolder of groupFolders) {
    const tasks = safeList(() => getTasksForGroup(groupFolder));
    const activeThreads = safeList(() => listLifeThreadsForGroup(groupFolder, ['active']));
    const facts = safeList(() => listProfileFactsForGroup(groupFolder)).filter(
      (fact) => fact.state === 'accepted',
    );
    const sources = safeList(() => listKnowledgeSourcesForGroup(groupFolder)).filter(
      (source) => !source.deletedAt && !source.disabledAt,
    );
    const rituals = safeList(() => listRitualProfilesForGroup(groupFolder)).filter(
      (ritual) => ritual.enabled,
    );

    const openTasks = tasks.filter((task) => task.status === 'active');
    const archivalCandidates = tasks.filter((task) => task.status !== 'active');

    episodesReviewed += openTasks.length + activeThreads.length;
    semanticCandidates += Math.min(activeThreads.length + sources.length, facts.length + sources.length);
    proceduralCandidates += Math.min(rituals.length + Math.floor(openTasks.length / 2), activeThreads.length + openTasks.length);
    staleWorkingContextsExpired += archivalCandidates.length;

    const seenFactKeys = new Set<string>();
    for (const fact of facts) {
      if (seenFactKeys.has(fact.factKey)) conflictsDetected += 1;
      seenFactKeys.add(fact.factKey);
      latestTouchedAt = latestIso(latestTouchedAt, fact.updatedAt);
    }

    for (const task of tasks) {
      latestTouchedAt = latestIso(latestTouchedAt, task.created_at);
    }
    for (const thread of activeThreads) {
      latestTouchedAt = latestIso(latestTouchedAt, thread.lastUpdatedAt);
    }
    for (const source of sources) {
      latestTouchedAt = latestIso(latestTouchedAt, source.updatedAt);
    }
    for (const ritual of rituals) {
      latestTouchedAt = latestIso(latestTouchedAt, ritual.updatedAt);
    }
  }

  return {
    episodesReviewed,
    semanticCandidates,
    proceduralCandidates,
    staleWorkingContextsExpired,
    conflictsDetected,
    promotionStatus:
      conflictsDetected > 0
        ? 'review_required'
        : semanticCandidates > 0 || proceduralCandidates > 0
        ? 'candidate_ready'
        : 'idle',
    latestTouchedAt,
  };
}

export function buildMemoryIntelligenceReport(
  groupFolders: readonly string[],
): Record<string, string> {
  const consolidation = buildMemoryConsolidationReport(groupFolders);
  return {
    arbitrationMode: 'task_family_scoped',
    readPolicy: 'working_every_turn_semantic_when_grounded_procedural_when_relevant',
    writePolicy:
      'working_hot_path_semantic_grounded_or_confirmed_procedural_repeated_success_or_review',
    plannerPosture: 'low_risk_auto',
    semanticPromotionPolicy: 'grounded_or_confirmed_only',
    proceduralPromotionPolicy: 'repeated_success_or_outcome_review',
    episodesReviewed: String(consolidation.episodesReviewed),
    semanticCandidates: String(consolidation.semanticCandidates),
    proceduralCandidates: String(consolidation.proceduralCandidates),
    staleWorkingContextsExpired: String(consolidation.staleWorkingContextsExpired),
    conflictsDetected: String(consolidation.conflictsDetected),
    promotionStatus: consolidation.promotionStatus,
    latestTouchedAt: consolidation.latestTouchedAt,
  };
}
