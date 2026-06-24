import type { PlatformTaskFamily } from './andrea-platform-bridge.js';
import { z } from 'zod';

import { parseCouncilJsonWithStatus } from './council-json.js';
import { redactCouncilText } from './council-safety.js';

export type CouncilVerdictStatus =
  | 'pass'
  | 'warn'
  | 'clarify'
  | 'block'
  | 'inconclusive';

export type CouncilRecommendedAction =
  | 'answer'
  | 'ask_clarifying_question'
  | 'hold'
  | 'draft_only'
  | 'block';

export type CouncilEvidenceGrade = 'strong' | 'partial' | 'weak' | 'unknown';
export type CouncilApprovalNeed = 'none' | 'conditional' | 'explicit';
export type CouncilSchemaStatus = 'valid' | 'repaired' | 'invalid_fallback';
export type CouncilEvidenceSignal =
  | 'user_direct'
  | 'local_compiled_truth'
  | 'integration_live'
  | 'provider_health'
  | 'public_web'
  | 'policy_contract'
  | 'runtime_metadata'
  | 'weak_semantic';
export type CouncilCreateSafety = 'exists' | 'probable' | 'unknown';
export type CouncilActionDirectiveKind =
  | 'route_override'
  | 'need_evidence'
  | 'ask_clarifying_question'
  | 'require_approval'
  | 'answer_constraint'
  | 'memory_learning_candidate'
  | 'verifier_stop';

export interface CouncilSourceAttribution {
  sourceId: string;
  sourceClass: CouncilEvidenceCard['sourceClass'];
  sourcePriority: number;
  citationLabel: string;
  freshness: CouncilEvidenceCard['freshness'];
  sensitivity: CouncilEvidenceCard['sensitivity'];
}

export interface CouncilEvidenceContract {
  evidence: CouncilEvidenceSignal;
  createSafety: CouncilCreateSafety;
  sourcePriority: number;
  citationLabel: string;
  availableToCouncil: boolean;
  conflictGroup?: string | null;
  conflictsWithEvidenceIds?: string[];
  sourceAttribution: CouncilSourceAttribution;
}

export interface CouncilActionDirective {
  directive: CouncilActionDirectiveKind;
  priority: 'low' | 'medium' | 'high';
  reason: string;
  routeOverride?: string | null;
  requiredEvidence?: CouncilEvidenceGrade | null;
  question?: string | null;
  approvalNeed?: CouncilApprovalNeed | null;
  constraint?: string | null;
  evidenceIds?: string[];
  riskFlags?: string[];
  stopReason?: string | null;
}

export interface CouncilUltrathinkTrace {
  requested: boolean;
  trigger: 'ultrathink' | 'ultracode' | 'deep' | 'none';
  mode: string;
  providerId?: string | null;
  model?: string | null;
  adaptiveThinkingRequested: boolean;
  adaptiveThinkingSupported: boolean;
  effortRequested?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  effortSent?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  display: 'omitted' | 'not_requested' | 'unsupported';
  rawThinkingStored: false;
  hiddenReasoningExposed: false;
}

export interface CouncilTaskQualityGate {
  gateId: string;
  family: string;
  metric: string;
  actual: number;
  floor: number;
  status: 'pass' | 'warn' | 'fail';
  summary: string;
}

export interface CouncilEvidenceFreshnessCoverage {
  total: number;
  fresh: number;
  stale: number;
  unknown: number;
  notApplicable: number;
}

export interface CouncilEvidenceScorecard {
  requiredGrade: CouncilEvidenceGrade;
  availableGrade: CouncilEvidenceGrade;
  freshnessCoverage: CouncilEvidenceFreshnessCoverage;
  sourceCoverage: Partial<Record<CouncilEvidenceCard['sourceClass'], number>>;
  createSafetyCoverage: Partial<Record<CouncilCreateSafety, number>>;
  citationCoverage: {
    total: number;
    cited: number;
    missing: number;
  };
  averageSourcePriority: number;
  privateContentPolicy: CouncilEvidencePack['rawContentPolicy'];
  gapCount: number;
  gapIds: string[];
  sourceClasses: CouncilEvidenceCard['sourceClass'][];
  confidencePenalty: number;
}

export interface CouncilConfidenceMath {
  base: number;
  degradedParticipationPenalty: number;
  providerFailurePenalty: number;
  evidencePenalty: number;
  verdictPenalty: number;
  schemaPenalty: number;
  final: number;
}

export interface CouncilRunBudget {
  mode: string;
  maxRoles: number;
  roleTimeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  fallbackAllowed: boolean;
  estimatedCostTier: 'low' | 'medium' | 'high' | 'unknown';
  usedRoles: number;
  retryCount: number;
  loopGuardTriggered: boolean;
  status: 'within_budget' | 'degraded' | 'exceeded';
}

export interface CouncilReplayArtifact {
  councilRunId: string;
  mode: string;
  evidenceScorecard: CouncilEvidenceScorecard;
  memberStatuses: Array<{
    memberId: string;
    providerId: string;
    role: string;
    status: CouncilMemberArtifact['status'];
    verdict: CouncilVerdictStatus;
    confidence: number;
    schemaStatus: CouncilSchemaStatus;
    schemaIssues: string[];
    evidenceIds: string[];
    riskFlags: string[];
  }>;
  finalVerdict: {
    status: CouncilVerdictStatus;
    recommendedAction: CouncilRecommendedAction;
    confidence: number;
    evidenceGrade: CouncilEvidenceGrade;
    approvalNeed: CouncilApprovalNeed;
    answerDirection: string;
    blocker?: string | null;
    clarifyingQuestion?: string | null;
    riskFlags: string[];
    actionDirectives: CouncilActionDirective[];
  };
  confidenceMath: CouncilConfidenceMath;
  budget: CouncilRunBudget;
  ultrathinkTrace?: CouncilUltrathinkTrace;
  replaySummary: string;
}

export interface CouncilEvidenceCard {
  evidenceId: string;
  sourceClass:
    | 'user_input'
    | 'local_memory'
    | 'knowledge'
    | 'runtime'
    | 'provider_health'
    | 'public_web'
    | 'policy';
  evidenceGrade: CouncilEvidenceGrade;
  freshness: 'fresh' | 'stale' | 'unknown' | 'not_applicable';
  sensitivity: 'public' | 'normal' | 'private' | 'sensitive';
  summary: string;
  gap?: string | null;
  evidence?: CouncilEvidenceSignal;
  createSafety?: CouncilCreateSafety;
  sourcePriority?: number;
  citationLabel?: string;
  conflictGroup?: string | null;
  conflictsWithEvidenceIds?: string[];
  availableToCouncil?: boolean;
  sourceAttribution?: CouncilSourceAttribution;
}

export interface CouncilEvidenceCardV2 extends CouncilEvidenceCard {
  evidence: CouncilEvidenceSignal;
  createSafety: CouncilCreateSafety;
  sourcePriority: number;
  citationLabel: string;
  availableToCouncil: boolean;
  sourceAttribution: CouncilSourceAttribution;
}

export interface CouncilEvidencePack {
  packId: string;
  taskFamily: PlatformTaskFamily;
  requiredEvidence: CouncilEvidenceGrade;
  overallGrade: CouncilEvidenceGrade;
  rawContentPolicy: 'metadata_only' | 'local_only' | 'sanitized_snippets';
  cards: CouncilEvidenceCard[];
  gaps: string[];
  scorecard: CouncilEvidenceScorecard;
}

export interface CouncilMemberArtifact {
  memberId: string;
  providerId: string;
  role: string;
  status: 'completed' | 'blocked' | 'skipped';
  verdict: CouncilVerdictStatus;
  recommendedAction: CouncilRecommendedAction;
  evidenceGrade: CouncilEvidenceGrade;
  approvalNeed: CouncilApprovalNeed;
  confidence: number;
  answerDirection: string;
  uncertainty: string;
  clarifyingQuestion?: string | null;
  blocker?: string | null;
  riskFlags: string[];
  evidenceIds: string[];
  notes: string;
  schemaStatus: CouncilSchemaStatus;
  schemaIssues: string[];
}

export interface CouncilVerdict {
  status: CouncilVerdictStatus;
  recommendedAction: CouncilRecommendedAction;
  confidence: number;
  answerDirection: string;
  uncertainty: string;
  clarifyingQuestion?: string | null;
  blocker?: string | null;
  approvalNeed: CouncilApprovalNeed;
  evidenceGrade: CouncilEvidenceGrade;
  riskFlags: string[];
  evidenceIds: string[];
  sourceMemberIds: string[];
  usableMemberCount: number;
  blockedMemberCount: number;
  confidenceMath: CouncilConfidenceMath;
  schemaStatusSummary: Record<CouncilSchemaStatus, number>;
  actionDirectives: CouncilActionDirective[];
  ultrathinkTrace?: CouncilUltrathinkTrace;
  replayArtifact?: CouncilReplayArtifact;
}

export interface BuildCouncilVerdictInput {
  mode: string;
  artifacts: CouncilMemberArtifact[];
  evidencePack: CouncilEvidencePack;
  providerFailures: string[];
  allowedSideEffects?: 'none' | 'read_only' | 'approval_required';
  runBudget?: CouncilRunBudget;
  councilRunId?: string;
  ultrathinkTrace?: CouncilUltrathinkTrace;
}

const councilMemberJsonSchema = z.object({
  verdict: z.enum(['pass', 'warn', 'clarify', 'block', 'inconclusive']),
  confidence: z.coerce.number().min(0).max(1),
  evidence_grade: z.enum(['strong', 'partial', 'weak', 'unknown']),
  recommended_action: z.enum([
    'answer',
    'ask_clarifying_question',
    'hold',
    'draft_only',
    'block',
  ]),
  answer_direction: z.string().min(1),
  uncertainty: z.string().min(1),
  risk_flags: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
  approval_need: z.enum(['none', 'conditional', 'explicit']),
  blocker: z.string().nullish().optional(),
  clarifying_question: z.string().nullish().optional(),
});

function formatSchemaIssues(err: z.ZodError): string[] {
  return err.issues
    .slice(0, 6)
    .map((issue) =>
      redactCouncilText(
        `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
        160,
      ),
    );
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(/[,;]\s*/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return Number.NaN;
}

function normalizeVerdict(value: string): CouncilVerdictStatus {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'block' || normalized === 'blocked') return 'block';
  if (normalized === 'clarify' || normalized === 'needs_clarification') {
    return 'clarify';
  }
  if (normalized === 'pass' || normalized === 'proceed') return 'pass';
  if (normalized === 'inconclusive' || normalized === 'degraded') {
    return 'inconclusive';
  }
  return 'warn';
}

function normalizeAction(value: string): CouncilRecommendedAction {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('clarif')) return 'ask_clarifying_question';
  if (normalized.includes('draft')) return 'draft_only';
  if (normalized.includes('block')) return 'block';
  if (normalized.includes('hold')) return 'hold';
  return 'answer';
}

function normalizeEvidenceGrade(value: string): CouncilEvidenceGrade {
  const normalized = value.toLowerCase();
  if (normalized.includes('strong')) return 'strong';
  if (normalized.includes('partial')) return 'partial';
  if (normalized.includes('weak')) return 'weak';
  return 'unknown';
}

function normalizeApprovalNeed(value: string): CouncilApprovalNeed {
  const normalized = value.toLowerCase();
  if (normalized.includes('explicit')) return 'explicit';
  if (normalized.includes('conditional') || normalized.includes('approval')) {
    return 'conditional';
  }
  return 'none';
}

function inferVerdictFromText(text: string): CouncilVerdictStatus {
  const lower = text.toLowerCase();
  if (
    /\b(block|blocked|cannot proceed|do not proceed|unsafe|not safe|hold)\b/.test(
      lower,
    ) &&
    !/\b(not blocked|not unsafe)\b/.test(lower)
  ) {
    return 'block';
  }
  if (
    /\b(clarify|ask one|need one detail|missing information|ambiguous)\b/.test(
      lower,
    )
  ) {
    return 'clarify';
  }
  if (
    /\b(warn|caution|uncertain|missing evidence|weak evidence|degraded|risk)\b/.test(
      lower,
    )
  ) {
    return 'warn';
  }
  return text.trim() ? 'pass' : 'inconclusive';
}

function inferEvidenceGradeFromText(text: string): CouncilEvidenceGrade {
  const lower = text.toLowerCase();
  if (/\b(strong|verified|cited|grounded)\b/.test(lower)) return 'strong';
  if (/\b(partial|some evidence|limited evidence)\b/.test(lower)) {
    return 'partial';
  }
  if (/\b(weak|missing evidence|no live evidence|unverified)\b/.test(lower)) {
    return 'weak';
  }
  return 'unknown';
}

export function parseCouncilMemberArtifact(input: {
  memberId: string;
  providerId: string;
  role: string;
  text: string;
  status: 'completed' | 'blocked' | 'skipped';
  defaultConfidence: number;
  defaultRiskFlags?: string[];
  evidenceIds?: string[];
}): CouncilMemberArtifact {
  const sanitizedText = redactCouncilText(input.text, 1800);
  let parsed: Record<string, unknown> | null = null;
  let validated: z.infer<typeof councilMemberJsonSchema> | null = null;
  let schemaStatus: CouncilSchemaStatus =
    input.status === 'completed' ? 'invalid_fallback' : 'valid';
  let schemaIssues: string[] = [];
  let repairedFromUnstructured = false;
  try {
    const raw = parseCouncilJsonWithStatus(sanitizedText);
    parsed =
      raw.data && typeof raw.data === 'object'
        ? (raw.data as Record<string, unknown>)
        : null;
    if (parsed) {
      const validation = councilMemberJsonSchema.safeParse(parsed);
      if (validation.success) {
        validated = validation.data;
        schemaStatus = raw.status;
      } else {
        schemaIssues = formatSchemaIssues(validation.error);
        if (input.status === 'completed' && sanitizedText.trim()) {
          schemaStatus = 'repaired';
          repairedFromUnstructured = true;
        }
      }
    } else {
      schemaIssues = ['parsed JSON was not an object'];
      if (input.status === 'completed' && sanitizedText.trim()) {
        schemaStatus = 'repaired';
        repairedFromUnstructured = true;
      }
    }
  } catch (err) {
    parsed = null;
    schemaIssues = [
      redactCouncilText(
        err instanceof Error ? err.message : 'no parseable JSON artifact',
        160,
      ),
    ];
    if (input.status === 'completed' && sanitizedText.trim()) {
      schemaStatus = 'repaired';
      repairedFromUnstructured = true;
    }
  }
  if (repairedFromUnstructured) {
    schemaIssues = Array.from(
      new Set(['schema_repaired_from_visible_member_notes', ...schemaIssues]),
    ).slice(0, 6);
  } else if (input.status !== 'completed' && schemaIssues.length > 0) {
    schemaIssues = Array.from(
      new Set([
        'schema_not_required_for_non_completed_member',
        ...schemaIssues,
      ]),
    ).slice(0, 6);
  }
  const source = (validated || parsed) as Record<string, unknown> | null;

  const verdict = source
    ? normalizeVerdict(
        pickString(source, ['verdict', 'status', 'final_verdict']),
      )
    : inferVerdictFromText(sanitizedText);
  const answerDirection =
    (source &&
      pickString(source, [
        'answer_direction',
        'answerDirection',
        'direction',
        'suggested_answer_direction',
        'summary',
      ])) ||
    firstSentence(sanitizedText) ||
    'Use the best available answer with visible uncertainty.';
  const uncertainty =
    (source &&
      pickString(source, ['uncertainty', 'missing_facts', 'missingFacts'])) ||
    (verdict === 'pass'
      ? 'No major uncertainty recorded by this member.'
      : 'This member found uncertainty, a blocker, or an evidence gap.');
  const blocker =
    source && pickString(source, ['blocker', 'blocker_reason', 'reason']);
  const clarifyingQuestion =
    source &&
    pickString(source, [
      'clarifying_question',
      'clarifyingQuestion',
      'question',
    ]);
  const riskFlags = [
    ...(input.defaultRiskFlags || []),
    ...(source ? pickArray(source, ['risk_flags', 'riskFlags']) : []),
    ...(schemaStatus === 'invalid_fallback' && input.status === 'completed'
      ? [`schema_invalid:${input.memberId}`]
      : []),
  ].map((flag) => redactCouncilText(flag, 80));
  const evidenceIds = [
    ...(input.evidenceIds || []),
    ...(source ? pickArray(source, ['evidence_ids', 'evidenceIds']) : []),
  ];
  const parsedConfidence = source
    ? pickNumber(source, ['confidence', 'confidence_score'])
    : Number.NaN;
  const fallbackConfidence =
    schemaStatus === 'invalid_fallback' && input.status === 'completed'
      ? Math.max(0.05, input.defaultConfidence - 0.18)
      : repairedFromUnstructured
        ? Math.max(0.05, input.defaultConfidence - 0.06)
        : input.defaultConfidence;

  return {
    memberId: input.memberId,
    providerId: input.providerId,
    role: input.role,
    status: input.status,
    verdict: input.status === 'completed' ? verdict : 'inconclusive',
    recommendedAction: source
      ? normalizeAction(
          pickString(source, ['recommended_action', 'recommendedAction']),
        )
      : verdict === 'clarify'
        ? 'ask_clarifying_question'
        : verdict === 'block'
          ? 'block'
          : 'answer',
    evidenceGrade: source
      ? normalizeEvidenceGrade(
          pickString(source, ['evidence_grade', 'evidenceGrade']),
        )
      : inferEvidenceGradeFromText(sanitizedText),
    approvalNeed: source
      ? normalizeApprovalNeed(
          pickString(source, ['approval_need', 'approvalNeed']),
        )
      : 'none',
    confidence: Number.isFinite(parsedConfidence)
      ? schemaStatus === 'invalid_fallback' && input.status === 'completed'
        ? Math.max(0.05, parsedConfidence - 0.18)
        : repairedFromUnstructured
          ? Math.max(0.05, parsedConfidence - 0.06)
          : parsedConfidence
      : fallbackConfidence,
    answerDirection: redactCouncilText(answerDirection, 420),
    uncertainty: redactCouncilText(uncertainty, 360),
    clarifyingQuestion: clarifyingQuestion
      ? redactCouncilText(clarifyingQuestion, 240)
      : null,
    blocker: blocker ? redactCouncilText(blocker, 280) : null,
    riskFlags: Array.from(new Set(riskFlags)),
    evidenceIds: Array.from(new Set(evidenceIds)),
    notes: sanitizedText,
    schemaStatus,
    schemaIssues: schemaIssues.map((issue) => redactCouncilText(issue, 160)),
  };
}

export function buildCouncilVerdict(
  input: BuildCouncilVerdictInput,
): CouncilVerdict {
  const completed = input.artifacts.filter(
    (artifact) => artifact.status === 'completed',
  );
  const verifier = completed.find((artifact) => artifact.role === 'verifier');
  const blockers = completed.filter((artifact) => artifact.verdict === 'block');
  const hardBlockers = blockers.filter(
    (artifact) =>
      artifact.role === 'verifier' ||
      artifact.role === 'synthesizer' ||
      artifact.approvalNeed === 'explicit' ||
      input.allowedSideEffects === 'approval_required',
  );
  const clarifiers = completed.filter(
    (artifact) => artifact.verdict === 'clarify',
  );
  const materialEvidenceGaps =
    input.evidencePack.requiredEvidence === 'strong' ||
    input.evidencePack.requiredEvidence === 'partial'
      ? input.evidencePack.gaps
      : [];
  const riskFlags = Array.from(
    new Set([
      ...materialEvidenceGaps.map((gap) => `evidence_gap:${gap}`),
      ...input.providerFailures,
      ...input.artifacts.flatMap((artifact) => artifact.riskFlags),
    ]),
  ).map((flag) => redactCouncilText(flag, 100));
  const requiresStrongEvidence =
    input.evidencePack.requiredEvidence === 'strong';
  const evidenceWeakForRequirement =
    requiresStrongEvidence && input.evidencePack.overallGrade !== 'strong';
  const minimumUsable = input.mode === 'single_model' ? 1 : 2;
  const degradedParticipation = completed.length < minimumUsable;
  const explicitApproval =
    input.allowedSideEffects === 'approval_required' ||
    completed.some((artifact) => artifact.approvalNeed === 'explicit');
  const schemaInvalidCount = completed.filter(
    (artifact) => artifact.schemaStatus === 'invalid_fallback',
  ).length;

  let status: CouncilVerdictStatus = 'pass';
  if (verifier?.verdict === 'block' || hardBlockers.length > 0) {
    status = 'block';
  } else if (verifier?.verdict === 'clarify' || clarifiers.length > 0) {
    status = 'clarify';
  } else if (
    degradedParticipation ||
    input.providerFailures.length > 0 ||
    evidenceWeakForRequirement ||
    schemaInvalidCount > 0 ||
    blockers.length > 0 ||
    completed.some((artifact) =>
      ['warn', 'inconclusive'].includes(artifact.verdict),
    )
  ) {
    status = 'warn';
  }

  const source =
    verifier ||
    completed.find((artifact) => artifact.role === 'synthesizer') ||
    completed.find((artifact) => artifact.role === 'planner') ||
    completed[0];
  const confidenceBase =
    completed.length > 0
      ? completed.reduce((sum, artifact) => sum + artifact.confidence, 0) /
        completed.length
      : 0.2;
  const degradedParticipationPenalty = degradedParticipation ? 0.2 : 0;
  const providerFailurePenalty = input.providerFailures.length > 0 ? 0.12 : 0;
  const evidencePenalty =
    input.evidencePack.scorecard?.confidencePenalty ??
    (evidenceWeakForRequirement ? 0.18 : 0);
  const verdictPenalty =
    status === 'block' ? 0.22 : status === 'clarify' ? 0.12 : 0;
  const schemaPenalty = Math.min(0.16, schemaInvalidCount * 0.04);
  const confidencePenalty =
    degradedParticipationPenalty +
    providerFailurePenalty +
    evidencePenalty +
    verdictPenalty +
    schemaPenalty;
  const confidence = Math.max(
    0.05,
    Math.min(0.95, Number((confidenceBase - confidencePenalty).toFixed(2))),
  );
  const evidenceIds = Array.from(
    new Set([
      ...input.evidencePack.cards.map((card) => card.evidenceId),
      ...completed.flatMap((artifact) => artifact.evidenceIds),
    ]),
  );
  const blocker =
    hardBlockers[0]?.blocker ||
    (status === 'block'
      ? source?.blocker ||
        input.providerFailures[0] ||
        'Review blocked the answer until evidence, safety, or approval requirements are resolved.'
      : null);
  const uncertainty =
    input.providerFailures.length > 0
      ? `Degraded provider participation: ${input.providerFailures
          .slice(0, 3)
          .join(', ')}.`
      : evidenceWeakForRequirement
        ? 'Required strong evidence was not available in the council evidence pack.'
        : source?.uncertainty || 'No major council uncertainty recorded.';
  const actionDirectives = buildCouncilActionDirectives({
    status,
    recommendedAction:
      status === 'block'
        ? 'block'
        : status === 'clarify'
          ? 'ask_clarifying_question'
          : explicitApproval
            ? 'draft_only'
            : 'answer',
    approvalNeed: explicitApproval ? 'explicit' : 'none',
    clarifyingQuestion:
      status === 'clarify'
        ? clarifiers[0]?.clarifyingQuestion ||
          source?.clarifyingQuestion ||
          'What is the one missing detail I should use before I answer?'
        : null,
    blocker,
    evidencePack: input.evidencePack,
    riskFlags,
  });

  const verdictOutput: CouncilVerdict = {
    status,
    recommendedAction:
      status === 'block'
        ? 'block'
        : status === 'clarify'
          ? 'ask_clarifying_question'
          : explicitApproval
            ? 'draft_only'
            : 'answer',
    confidence,
    answerDirection:
      source?.answerDirection ||
      'Use the best available answer and be explicit about uncertainty.',
    uncertainty: redactCouncilText(uncertainty, 360),
    clarifyingQuestion:
      status === 'clarify'
        ? clarifiers[0]?.clarifyingQuestion ||
          source?.clarifyingQuestion ||
          'What is the one missing detail I should use before I answer?'
        : null,
    blocker: blocker ? redactCouncilText(blocker, 280) : null,
    approvalNeed: explicitApproval ? 'explicit' : 'none',
    evidenceGrade: input.evidencePack.overallGrade,
    riskFlags,
    evidenceIds,
    sourceMemberIds: completed.map((artifact) => artifact.memberId),
    usableMemberCount: completed.length,
    blockedMemberCount: input.artifacts.filter(
      (artifact) => artifact.status === 'blocked',
    ).length,
    confidenceMath: {
      base: Number(confidenceBase.toFixed(2)),
      degradedParticipationPenalty,
      providerFailurePenalty,
      evidencePenalty,
      verdictPenalty,
      schemaPenalty,
      final: confidence,
    },
    schemaStatusSummary: buildSchemaStatusSummary(input.artifacts),
    actionDirectives,
    ultrathinkTrace: input.ultrathinkTrace,
  };
  if (input.runBudget && input.councilRunId) {
    verdictOutput.replayArtifact = buildCouncilReplayArtifact({
      councilRunId: input.councilRunId,
      mode: input.mode,
      evidencePack: input.evidencePack,
      artifacts: input.artifacts,
      verdict: verdictOutput,
      budget: input.runBudget,
      ultrathinkTrace: input.ultrathinkTrace,
    });
  }
  return verdictOutput;
}

function buildCouncilActionDirectives(input: {
  status: CouncilVerdictStatus;
  recommendedAction: CouncilRecommendedAction;
  approvalNeed: CouncilApprovalNeed;
  clarifyingQuestion?: string | null;
  blocker?: string | null;
  evidencePack: CouncilEvidencePack;
  riskFlags: string[];
}): CouncilActionDirective[] {
  const directives: CouncilActionDirective[] = [];
  const evidenceIds = input.evidencePack.cards
    .slice(0, 8)
    .map((card) => card.evidenceId);
  if (input.evidencePack.scorecard.gapCount > 0) {
    directives.push({
      directive: 'need_evidence',
      priority:
        input.evidencePack.requiredEvidence === 'strong' ? 'high' : 'medium',
      reason: redactCouncilText(
        `Council evidence has ${input.evidencePack.scorecard.gapCount} gap(s): ${input.evidencePack.scorecard.gapIds
          .slice(0, 4)
          .join(', ')}`,
        320,
      ),
      requiredEvidence: input.evidencePack.requiredEvidence,
      evidenceIds,
      riskFlags: input.riskFlags.filter((flag) =>
        flag.startsWith('evidence_gap:'),
      ),
    });
  }
  if (input.status === 'clarify') {
    directives.push({
      directive: 'ask_clarifying_question',
      priority: 'high',
      reason: 'Council requested clarification before acting.',
      question:
        input.clarifyingQuestion ||
        'What is the one missing detail I should use before I answer?',
      evidenceIds,
    });
  }
  if (input.approvalNeed === 'explicit') {
    directives.push({
      directive: 'require_approval',
      priority: 'high',
      reason:
        'Council detected an approval-first action surface; drafting may continue, but sending or mutation requires explicit approval.',
      approvalNeed: 'explicit',
      constraint:
        'Do not claim a send, deploy, delete, or mutation happened unless the approved action actually completed.',
      evidenceIds,
    });
  }
  if (input.status === 'block') {
    directives.push({
      directive: 'verifier_stop',
      priority: 'high',
      reason: redactCouncilText(
        input.blocker ||
          'Review blocked this answer until evidence, safety, or approval requirements are resolved.',
        320,
      ),
      stopReason: input.blocker || 'council_block',
      evidenceIds,
      riskFlags: input.riskFlags,
    });
  }
  if (input.status === 'warn' || input.status === 'pass') {
    directives.push({
      directive: 'answer_constraint',
      priority: input.status === 'warn' ? 'medium' : 'low',
      reason:
        input.status === 'warn'
          ? 'Council allowed an answer, but uncertainty or degraded participation must stay visible.'
          : 'Council allowed a concise answer using cited evidence.',
      constraint:
        input.status === 'warn'
          ? 'Name material uncertainty and avoid overclaiming.'
          : 'Answer directly and keep the council verdict concise.',
      evidenceIds,
    });
  }
  directives.push({
    directive: 'memory_learning_candidate',
    priority: 'low',
    reason:
      'Store only sanitized outcome lessons from this council run if the turn outcome confirms they were useful.',
    evidenceIds,
  });
  return directives.map((directive) => ({
    ...directive,
    reason: redactCouncilText(directive.reason, 360),
    constraint: directive.constraint
      ? redactCouncilText(directive.constraint, 360)
      : directive.constraint,
    question: directive.question
      ? redactCouncilText(directive.question, 240)
      : directive.question,
    riskFlags: directive.riskFlags?.map((flag) => redactCouncilText(flag, 100)),
  }));
}

function firstSentence(value: string, limit = 220): string {
  const sentence = value.match(/^(.+?[.!?])(?:\s|$)/)?.[1] || value;
  return redactCouncilText(sentence, limit);
}

function buildSchemaStatusSummary(
  artifacts: CouncilMemberArtifact[],
): Record<CouncilSchemaStatus, number> {
  return artifacts.reduce<Record<CouncilSchemaStatus, number>>(
    (summary, artifact) => {
      summary[artifact.schemaStatus] += 1;
      return summary;
    },
    { valid: 0, repaired: 0, invalid_fallback: 0 },
  );
}

export function buildCouncilReplayArtifact(input: {
  councilRunId: string;
  mode: string;
  evidencePack: CouncilEvidencePack;
  artifacts: CouncilMemberArtifact[];
  verdict: CouncilVerdict;
  budget: CouncilRunBudget;
  ultrathinkTrace?: CouncilUltrathinkTrace;
}): CouncilReplayArtifact {
  const memberStatuses = input.artifacts.map((artifact) => ({
    memberId: artifact.memberId,
    providerId: artifact.providerId,
    role: artifact.role,
    status: artifact.status,
    verdict: artifact.verdict,
    confidence: artifact.confidence,
    schemaStatus: artifact.schemaStatus,
    schemaIssues: artifact.schemaIssues.map((issue) =>
      redactCouncilText(issue, 160),
    ),
    evidenceIds: artifact.evidenceIds.map((id) => redactCouncilText(id, 160)),
    riskFlags: artifact.riskFlags.map((flag) => redactCouncilText(flag, 100)),
  }));
  const riskFlags = input.verdict.riskFlags.map((flag) =>
    redactCouncilText(flag, 100),
  );
  const replaySummary = redactCouncilText(
    [
      `Council ${input.councilRunId} used ${memberStatuses.length}/${input.budget.maxRoles} role(s) in ${input.mode}.`,
      `Verdict=${input.verdict.status}, action=${input.verdict.recommendedAction}, confidence=${input.verdict.confidence.toFixed(2)}.`,
      `Evidence=${input.evidencePack.scorecard.availableGrade}/${input.evidencePack.scorecard.requiredGrade}, gaps=${input.evidencePack.scorecard.gapCount}, schema_invalid=${input.verdict.schemaStatusSummary.invalid_fallback}.`,
      input.budget.loopGuardTriggered
        ? 'Loop/failure guard triggered during this run.'
        : 'Loop/failure guard did not trigger.',
    ].join(' '),
    720,
  );

  return {
    councilRunId: redactCouncilText(input.councilRunId, 160),
    mode: redactCouncilText(input.mode, 80),
    evidenceScorecard: input.evidencePack.scorecard,
    memberStatuses,
    finalVerdict: {
      status: input.verdict.status,
      recommendedAction: input.verdict.recommendedAction,
      confidence: input.verdict.confidence,
      evidenceGrade: input.verdict.evidenceGrade,
      approvalNeed: input.verdict.approvalNeed,
      answerDirection: redactCouncilText(input.verdict.answerDirection, 420),
      blocker: input.verdict.blocker
        ? redactCouncilText(input.verdict.blocker, 280)
        : null,
      clarifyingQuestion: input.verdict.clarifyingQuestion
        ? redactCouncilText(input.verdict.clarifyingQuestion, 240)
        : null,
      riskFlags,
      actionDirectives: input.verdict.actionDirectives.map((directive) => ({
        ...directive,
        reason: redactCouncilText(directive.reason, 360),
        constraint: directive.constraint
          ? redactCouncilText(directive.constraint, 360)
          : directive.constraint,
        question: directive.question
          ? redactCouncilText(directive.question, 240)
          : directive.question,
      })),
    },
    confidenceMath: input.verdict.confidenceMath,
    budget: input.budget,
    ultrathinkTrace: input.ultrathinkTrace,
    replaySummary,
  };
}
