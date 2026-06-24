import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listCognitiveReflectionSignals,
  listGoalPlannerRuns,
  listMemoryItems,
  listAttentionFocuses,
  listConfidenceCalibrations,
  listDeliberationRecords,
  listGlobalWorkspaceSnapshots,
  listReasoningModeDecisions,
  listSkillPlaybooks,
  listStrategyLearningSignals,
  listWorkingMemoryFrames,
  upsertAttentionFocus,
  upsertConfidenceCalibration,
  upsertDeliberationRecord,
  upsertGlobalWorkspaceSnapshot,
  upsertMemoryItem,
  upsertReasoningModeDecision,
  upsertStrategyLearningSignal,
  upsertWorkingMemoryFrame,
} from './db.js';
import { buildRealityGroundingReport } from './reality-grounding.js';
import { buildToolReliabilityDoctorReport } from './tool-reliability.js';
import type {
  AttentionFocus,
  CognitiveExecutiveChannel,
  CognitiveExecutiveIntentFamily,
  CognitiveExecutiveToolId,
  CognitiveWorldSnapshot,
  CognitiveWorldSnapshotItem,
  ConfidenceCalibration,
  DeliberationRecord,
  GlobalWorkspaceSnapshot,
  MemoryItem,
  MetacognitionDoctorReport,
  MetacognitiveWarning,
  ReasoningMode,
  ReasoningModeDecision,
  RealityDoctorReport,
  StrategyLearningSignal,
  ToolReliabilityDoctorReport,
  WorkingMemoryFrame,
} from './types.js';

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  rawToolOutputStored: false,
  providerDebatesStored: false,
  secretsRedacted: true,
} as const;

const SECRET_OR_PRIVATE_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought/i;

const MUTATING_ACTION_RE =
  /\b(send|sent|delete|remove|buy|purchase|order|commit|restart|stop service|change service|create event|add (?:that|it|this) to (?:my )?calendar|schedule (?:that|it|this)|cancel|write|post)\b|\b(?:git\s+push|push (?:the )?(?:fix|change|commit|branch|code|patch|release|deploy|deployment|to (?:main|prod|production)))\b/i;

const CALENDAR_WRITE_RE =
  /\b(add|create|schedule|put|move).{0,40}\b(calendar|event|meeting|appointment)\b|\b(add|schedule) (?:that|it|this)\b/i;

const SPECIFIC_TIME_RE =
  /\b(\d{1,2}(:\d{2})?\s?(am|pm)|noon|midnight|tomorrow|today|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

function nowIso(now?: Date | string): string {
  if (typeof now === 'string') return new Date(now).toISOString();
  return (now || new Date()).toISOString();
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/(^|[\s([{-])@andrea\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeText(value: string | null | undefined, limit = 900): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (SECRET_OR_PRIVATE_RE.test(normalized)) {
    return '[redacted metacognitive metadata]';
  }
  return redactCouncilText(normalized, limit);
}

function json(value: unknown, limit = 5000): string {
  try {
    const text = JSON.stringify(value ?? null);
    if (text.length <= limit) return safeText(text, limit);
    return safeText(
      JSON.stringify({ truncated: true, preview: text.slice(0, limit - 80) }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function idJson(values: Array<string | null | undefined>): string {
  return JSON.stringify(
    Array.from(
      new Set(
        values
          .map((value) =>
            String(value || '')
              .replace(/[^A-Za-z0-9:_-]+/g, '_')
              .slice(0, 220),
          )
          .filter(Boolean),
      ),
    ),
  );
}

function parseIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function privacyJson(): string {
  return json(PRIVACY, 1200);
}

function isQuickControl(text: string): boolean {
  return /\b(quick answer|fast answer|keep it simple|short answer|don'?t overthink|dont overthink|use only what you know for sure)\b/i.test(
    text,
  );
}

function isDeepControl(text: string): boolean {
  return /\b(think harder|think deeply|think this through|use all models|max[- ]?iq|ultrathink|deep dive|be really smart|reason this through)\b/i.test(
    text,
  );
}

function isUncertaintyCheck(text: string): boolean {
  return /\b(are you sure|how sure|how certain|what could be wrong|what would make you more confident|what are you unsure about)\b/i.test(
    text,
  );
}

function isPreparationPlanningAsk(text: string): boolean {
  return /\b(help me get ready|help me prepare|get ready|prepare|prep)\b.{0,120}\b(weekend|show|family visiting|family|practice|trip|event|rollout)\b|\b(weekend|show|family visiting|family|practice|trip|event|rollout)\b.{0,120}\b(get ready|prepare|prep|plan)\b/i.test(
    text,
  );
}

function isExplicitTradeoffAsk(text: string): boolean {
  return /\b(compare|trade[- ]?off|pros and cons|options)\b|\bshould (?:we|i) .{0,100}\b(?:or|vs\.?|versus)\b|\b(?:vs\.?|versus)\b/i.test(
    text,
  );
}

function isReadOnlyCalendarAsk(text: string): boolean {
  if (CALENDAR_WRITE_RE.test(text) || MUTATING_ACTION_RE.test(text)) {
    return false;
  }
  return (
    /\b(calendar|agenda|schedule|appointments?|events?|meetings?)\b/i.test(
      text,
    ) &&
    /\b(what|when|where|who|do i have|am i|free|busy|today|tomorrow|this week|next week|on my|what'?s|whats)\b/i.test(
      text,
    )
  );
}

function isStatusVerificationAsk(text: string): boolean {
  return /text messaging|bluebubbles|provider|working|true right now|broken|\bstatus\b|\bproof\b|\bready\b/i.test(
    text,
  );
}

function hasAmbiguousReference(text: string): boolean {
  return /\b(that|this|it|there|here|the thing|that one)\b/i.test(text);
}

function itemKindFromSnapshot(
  item: CognitiveWorldSnapshotItem,
): MemoryItem['itemKind'] {
  if (item.itemKind === 'integration') return 'tool_state';
  if (item.itemKind === 'message_action') return 'message_context';
  if (item.itemKind === 'mission') return 'goal';
  if (item.itemKind === 'action_bundle') return 'plan';
  if (item.itemKind === 'outcome') return 'outcome';
  if (item.itemKind === 'learning_candidate') return 'correction';
  return 'fact';
}

function priorityToRelevance(item: CognitiveWorldSnapshotItem): number {
  if (!Number.isFinite(item.priority)) return clamp01(item.confidence);
  return clamp01(item.priority > 1 ? item.priority / 100 : item.priority);
}

export interface BuildMetacognitiveInput {
  rawAsk: string;
  channel: CognitiveExecutiveChannel | 'operator' | 'internal';
  groupFolder?: string | null;
  chatJid?: string | null;
  threadId?: string | null;
  intentFamily?: CognitiveExecutiveIntentFamily | 'status' | 'other';
  routeKey?: string | null;
  selectedToolId?: CognitiveExecutiveToolId | string | null;
  approvalRequired?: boolean;
  activeContextSummary?: string | null;
  selectedWorkSummary?: string | null;
  snapshot?: CognitiveWorldSnapshot | null;
  snapshotItems?: CognitiveWorldSnapshotItem[];
  realityReport?: RealityDoctorReport | null;
  reliabilityReport?: ToolReliabilityDoctorReport | null;
  now?: Date | string;
  persist?: boolean;
}

export interface MetacognitiveTurnAnalysis {
  frame: WorkingMemoryFrame;
  items: MemoryItem[];
  focus: AttentionFocus;
  workspace: GlobalWorkspaceSnapshot;
  decision: ReasoningModeDecision;
  calibration: ConfidenceCalibration;
  deliberation: DeliberationRecord;
  strategySignal: StrategyLearningSignal;
  warnings: MetacognitiveWarning[];
  mode: ReasoningMode;
  confidenceLabel: ConfidenceCalibration['label'];
  conciseSummary: string;
}

type ReasoningModeSpec = Pick<
  ReasoningModeDecision,
  | 'modeReason'
  | 'requiredContextJson'
  | 'allowedToolsJson'
  | 'approvalRequirement'
  | 'outputShape'
  | 'failureMode'
>;

function buildMemoryItems(input: {
  frameId: string;
  now: string;
  text: string;
  snapshotItems: CognitiveWorldSnapshotItem[];
  reality: RealityDoctorReport;
  reliability: ToolReliabilityDoctorReport;
  activeContextSummary?: string | null;
  selectedWorkSummary?: string | null;
  groupFolder?: string | null;
}): MemoryItem[] {
  const out: MemoryItem[] = [];
  const push = (
    partial: Omit<MemoryItem, 'createdAt' | 'frameId' | 'privacyJson'>,
  ) => {
    const relevance =
      typeof partial.relevance === 'number' &&
      Number.isFinite(partial.relevance)
        ? partial.relevance
        : 0.5;
    const confidence =
      typeof partial.confidence === 'number' &&
      Number.isFinite(partial.confidence)
        ? partial.confidence
        : 0.5;
    out.push({
      ...partial,
      relevance: clamp01(relevance),
      confidence: clamp01(confidence),
      freshness: partial.freshness || 'unknown',
      sensitivity: partial.sensitivity || 'low',
      frameId: input.frameId,
      createdAt: input.now,
      privacyJson: privacyJson(),
    });
  };
  push({
    itemId: hashId('memory:item', `${input.frameId}|ask`),
    itemKind: 'user_ask',
    summary: safeText(input.text, 700),
    relevance: 1,
    freshness: 'fresh',
    confidence: 0.96,
    source: 'current_turn',
    sourceId: input.frameId,
    sensitivity: 'low',
    includeInUserAnswer: false,
    evidenceRefsJson: idJson([input.frameId]),
  });
  if (input.activeContextSummary) {
    push({
      itemId: hashId('memory:item', `${input.frameId}|active_context`),
      itemKind: 'message_context',
      summary: safeText(input.activeContextSummary, 700),
      relevance: 0.74,
      freshness: 'fresh',
      confidence: 0.72,
      source: 'active_context',
      sourceId: input.frameId,
      sensitivity: 'personal',
      includeInUserAnswer: true,
      evidenceRefsJson: idJson([input.frameId]),
    });
  }
  if (input.selectedWorkSummary) {
    push({
      itemId: hashId('memory:item', `${input.frameId}|selected_work`),
      itemKind: 'goal',
      summary: safeText(input.selectedWorkSummary, 700),
      relevance: 0.72,
      freshness: 'fresh',
      confidence: 0.76,
      source: 'selected_work',
      sourceId: input.frameId,
      sensitivity: 'low',
      includeInUserAnswer: true,
      evidenceRefsJson: idJson([input.frameId]),
    });
  }
  for (const item of input.snapshotItems.slice(0, 12)) {
    push({
      itemId: hashId('memory:item', `${input.frameId}|snapshot|${item.itemId}`),
      itemKind: itemKindFromSnapshot(item),
      summary: item.summary,
      relevance: priorityToRelevance(item),
      freshness: item.freshness,
      confidence: item.confidence,
      source: `executive_snapshot:${item.itemKind}`,
      sourceId: item.sourceId,
      sensitivity:
        item.itemKind === 'communication_thread' ? 'personal' : 'low',
      includeInUserAnswer: item.confidence >= 0.45 && !item.reasonOmitted,
      evidenceRefsJson: idJson([
        item.itemId,
        item.sourceId,
        ...parseIds(item.sourceIdsJson),
      ]),
    });
  }
  push({
    itemId: hashId('memory:item', `${input.frameId}|reality`),
    itemKind: 'proof',
    summary: `${input.reality.snapshot.status}; ${input.reality.snapshot.confidenceSummary}`,
    relevance: 0.92,
    freshness: 'fresh',
    confidence: input.reality.snapshot.confidence,
    source: 'reality_grounding',
    sourceId: input.reality.snapshot.snapshotId,
    sensitivity: 'low',
    includeInUserAnswer: true,
    evidenceRefsJson: idJson([
      input.reality.snapshot.snapshotId,
      ...input.reality.verificationNeeds.slice(0, 8).map((need) => need.needId),
      ...input.reality.contradictions
        .slice(0, 5)
        .map((item) => item.contradictionId),
    ]),
  });
  for (const need of input.reality.verificationNeeds.slice(0, 4)) {
    push({
      itemId: hashId('memory:item', `${input.frameId}|need|${need.needId}`),
      itemKind: 'uncertainty',
      summary: `${need.question} Next: ${need.nextAction}`,
      relevance: 0.86,
      freshness: 'fresh',
      confidence:
        need.riskIfSkipped === 'critical'
          ? 0.92
          : need.riskIfSkipped === 'high'
            ? 0.84
            : need.riskIfSkipped === 'medium'
              ? 0.7
              : 0.56,
      source: 'verification_need',
      sourceId: need.needId,
      sensitivity: 'low',
      includeInUserAnswer: true,
      evidenceRefsJson: idJson([
        need.needId,
        ...parseIds(need.evidenceIdsJson),
      ]),
    });
  }
  for (const contradiction of input.reality.contradictions.slice(0, 4)) {
    push({
      itemId: hashId(
        'memory:item',
        `${input.frameId}|contradiction|${contradiction.contradictionId}`,
      ),
      itemKind: 'uncertainty',
      summary: contradiction.summary,
      relevance: 0.88,
      freshness: 'fresh',
      confidence: 0.82,
      source: 'reality_contradiction',
      sourceId: contradiction.contradictionId,
      sensitivity: 'low',
      includeInUserAnswer: true,
      evidenceRefsJson: idJson([
        contradiction.contradictionId,
        ...parseIds(contradiction.observationIdsJson),
        ...parseIds(contradiction.beliefIdsJson),
      ]),
    });
  }
  for (const rollup of input.reliability.topDegraded.slice(0, 5)) {
    push({
      itemId: hashId(
        'memory:item',
        `${input.frameId}|tool|${rollup.subjectId}`,
      ),
      itemKind: 'tool_state',
      summary: `${rollup.subjectId} is ${rollup.currentHealth}; ${rollup.nextAction}`,
      relevance: 0.8,
      freshness: 'fresh',
      confidence: rollup.confidenceCap,
      source: 'tool_reliability',
      sourceId: rollup.subjectId,
      sensitivity: 'low',
      includeInUserAnswer: rollup.currentHealth !== 'healthy',
      evidenceRefsJson: idJson([rollup.subjectId]),
    });
  }
  if (isDatabaseInitialized()) {
    const recentCorrections = listCognitiveReflectionSignals({
      limit: 20,
    }).filter(
      (signal) =>
        signal.userResponse === 'corrected' ||
        signal.outcome === 'fail' ||
        signal.frictionKey,
    );
    for (const signal of recentCorrections.slice(0, 4)) {
      push({
        itemId: hashId(
          'memory:item',
          `${input.frameId}|signal|${signal.signalId}`,
        ),
        itemKind:
          signal.userResponse === 'corrected' ? 'correction' : 'outcome',
        summary: signal.summary,
        relevance: 0.54,
        freshness: 'recent',
        confidence: 0.62,
        source: 'executive_reflection',
        sourceId: signal.signalId,
        sensitivity: 'low',
        includeInUserAnswer: false,
        evidenceRefsJson: idJson([signal.signalId]),
      });
    }
    const goalRuns = listGoalPlannerRuns({
      groupFolder: input.groupFolder,
      limit: 3,
    });
    for (const run of goalRuns) {
      push({
        itemId: hashId('memory:item', `${input.frameId}|goal_run|${run.runId}`),
        itemKind: 'goal',
        summary: `${run.intent}: ${run.summary}`,
        relevance: 0.58,
        freshness: 'recent',
        confidence: run.confidence,
        source: 'goal_planner',
        sourceId: run.runId,
        sensitivity: 'low',
        includeInUserAnswer: false,
        evidenceRefsJson: idJson([
          run.runId,
          run.selectedGoalId,
          run.selectedComparisonId,
          run.selectedOpportunityId,
          ...parseIds(run.verificationNeedIdsJson),
        ]),
      });
    }
    const skills = listSkillPlaybooks({
      groupFolder: input.groupFolder,
      statuses: ['active', 'suggested'],
      limit: 4,
    });
    for (const skill of skills) {
      push({
        itemId: hashId(
          'memory:item',
          `${input.frameId}|skill|${skill.skillId}`,
        ),
        itemKind: 'plan',
        summary: `${skill.status} skill: ${skill.title}; ${skill.nextAction}`,
        relevance: skill.status === 'active' ? 0.56 : 0.42,
        freshness: 'recent',
        confidence: skill.reliabilityScore,
        source: 'skill_library',
        sourceId: skill.skillId,
        sensitivity: 'personal',
        includeInUserAnswer: false,
        evidenceRefsJson: idJson([skill.skillId, skill.sourceDistillationId]),
      });
    }
  }
  return out
    .sort(
      (left, right) =>
        right.relevance - left.relevance || right.confidence - left.confidence,
    )
    .slice(0, 24);
}

function buildWarnings(input: {
  text: string;
  reality: RealityDoctorReport;
  reliability: ToolReliabilityDoctorReport;
  items: MemoryItem[];
  approvalRequired: boolean;
}): MetacognitiveWarning[] {
  const warnings: MetacognitiveWarning[] = [];
  const add = (
    warningKind: MetacognitiveWarning['warningKind'],
    severity: MetacognitiveWarning['severity'],
    summary: string,
    nextAction: string,
  ) => warnings.push({ warningKind, severity, summary, nextAction });
  if (input.reality.contradictions.length) {
    add(
      'conflicting_context',
      'high',
      `${input.reality.contradictions.length} reality contradiction(s) are open.`,
      'Name the uncertainty or verify before making strong claims.',
    );
  }
  if (input.reality.proofDebt.total > 0) {
    add(
      'stale_context',
      input.reality.proofDebt.repoWorkRequired > 0 ? 'high' : 'medium',
      `${input.reality.proofDebt.total} proof item(s) are still open.`,
      input.reality.nextAction,
    );
  }
  if (
    input.reliability.topDegraded.some(
      (rollup) => rollup.currentHealth === 'blocked',
    )
  ) {
    add(
      'tool_unavailable',
      'medium',
      'At least one relevant tool/provider is blocked or unproven.',
      'Prefer local/healthy fallback and reduce confidence.',
    );
  }
  if (
    hasAmbiguousReference(input.text) &&
    !input.items.some((item) => item.itemKind === 'message_context')
  ) {
    add(
      'ambiguous_reference',
      'medium',
      'The ask refers to this/that/it without a strong active object.',
      'Ask one clarifying question before acting.',
    );
  }
  if (MUTATING_ACTION_RE.test(input.text) || input.approvalRequired) {
    add(
      'high_risk_action',
      'high',
      'The request may involve a send, write, operator action, or other side effect.',
      'Keep approval gates in force and stage rather than execute.',
    );
  }
  if (isUncertaintyCheck(input.text)) {
    add(
      'user_uncertainty_check',
      'low',
      'The user is asking for confidence or support.',
      'Answer with evidence, uncertainty, and a verification path.',
    );
  }
  const recentFallbacks = isDatabaseInitialized()
    ? listCognitiveReflectionSignals({ limit: 12 }).filter(
        (signal) => signal.fallbackUsed || signal.outcome === 'fail',
      ).length
    : 0;
  if (recentFallbacks >= 3) {
    add(
      'repeated_fallback',
      'medium',
      'Recent executive turns include repeated fallback or failure signals.',
      'Prefer verify/clarify over confident automation.',
    );
  }
  return warnings;
}

function selectMode(input: {
  text: string;
  intentFamily: BuildMetacognitiveInput['intentFamily'];
  channel: BuildMetacognitiveInput['channel'];
  reality: RealityDoctorReport;
  warnings: MetacognitiveWarning[];
  approvalRequired: boolean;
}): ReasoningMode {
  const text = input.text;
  const hasHighRisk = input.warnings.some(
    (warning) =>
      warning.warningKind === 'high_risk_action' ||
      warning.warningKind === 'conflicting_context',
  );
  const missingCalendarTime =
    CALENDAR_WRITE_RE.test(text) && !SPECIFIC_TIME_RE.test(text);
  if (isQuickControl(text) && !hasHighRisk && !missingCalendarTime) {
    return 'fast_direct';
  }
  if (isDeepControl(text)) return 'deliberate_with_critic';
  if (missingCalendarTime) return 'clarify_first';
  if (MUTATING_ACTION_RE.test(text) || input.approvalRequired)
    return 'verify_then_act';
  if (isUncertaintyCheck(text)) return 'retrieve_grounded';
  if (isExplicitTradeoffAsk(text)) return 'compare_counterfactuals';
  if (
    /what if|what would happen|what should i do next|safest next|blocking|blocked/i.test(
      text,
    )
  ) {
    return 'compare_counterfactuals';
  }
  if (isPreparationPlanningAsk(text)) return 'plan_stepwise';
  if (
    input.intentFamily === 'plan_tonight' ||
    input.intentFamily === 'next_action' ||
    input.intentFamily === 'open_loops' ||
    /\b(plan|prepare|goal|next step)\b/i.test(text)
  ) {
    return input.reality.contradictions.length
      ? 'compare_counterfactuals'
      : 'plan_stepwise';
  }
  if (isReadOnlyCalendarAsk(text)) {
    return input.channel === 'alexa' ? 'fast_direct' : 'retrieve_grounded';
  }
  if (isStatusVerificationAsk(text)) return 'verify_then_act';
  if (input.channel === 'alexa' && hasHighRisk) return 'defer_or_handoff';
  if (
    input.reality.proofDebt.total > 0 &&
    /status|proof|working|ready/i.test(text)
  ) {
    return 'retrieve_grounded';
  }
  return 'fast_direct';
}

function calibrationFrom(input: {
  frameId: string;
  now: string;
  mode: ReasoningMode;
  reality: RealityDoctorReport;
  reliability: ToolReliabilityDoctorReport;
  warnings: MetacognitiveWarning[];
  items: MemoryItem[];
}): ConfidenceCalibration {
  const proofFreshnessScore = clamp01(1 - input.reality.proofDebt.total * 0.12);
  const blockedRollups = input.reliability.topDegraded.filter(
    (rollup) => rollup.currentHealth === 'blocked',
  ).length;
  const toolReliabilityScore = clamp01(
    input.reliability.rollups.length
      ? input.reliability.rollups.reduce(
          (sum, rollup) => sum + rollup.reliabilityScore,
          0,
        ) / input.reliability.rollups.length
      : 0.62 - blockedRollups * 0.08,
  );
  const realityConfidenceScore = clamp01(input.reality.snapshot.confidence);
  const missingInfoPenalty = input.warnings.some(
    (warning) =>
      warning.warningKind === 'ambiguous_reference' ||
      warning.warningKind === 'insufficient_evidence',
  )
    ? 0.14
    : 0;
  const contradictionPenalty = Math.min(
    0.28,
    input.reality.contradictions.length * 0.07,
  );
  const recentSignals = isDatabaseInitialized()
    ? listCognitiveReflectionSignals({ limit: 20 })
    : [];
  const successes = recentSignals.filter(
    (signal) => signal.outcome === 'success',
  ).length;
  const failures = recentSignals.filter(
    (signal) =>
      signal.outcome === 'fail' || signal.userResponse === 'corrected',
  ).length;
  const routeHistoryScore = clamp01(0.58 + successes * 0.025 - failures * 0.05);
  const skills = isDatabaseInitialized()
    ? listSkillPlaybooks({ statuses: ['active'], limit: 8 })
    : [];
  const skillReliabilityScore = clamp01(
    skills.length
      ? skills.reduce((sum, skill) => sum + skill.reliabilityScore, 0) /
          skills.length
      : 0.62,
  );
  const correctionPenalty = Math.min(0.18, failures * 0.035);
  const score = clamp01(
    proofFreshnessScore * 0.18 +
      toolReliabilityScore * 0.18 +
      realityConfidenceScore * 0.24 +
      routeHistoryScore * 0.16 +
      skillReliabilityScore * 0.12 +
      Math.min(1, input.items.length / 8) * 0.12 -
      missingInfoPenalty -
      contradictionPenalty -
      correctionPenalty,
  );
  const label: ConfidenceCalibration['label'] =
    score >= 0.72
      ? 'high'
      : score >= 0.48
        ? 'medium'
        : score >= 0.25
          ? 'low'
          : 'blocked';
  const actionAllowed: ConfidenceCalibration['actionAllowed'] =
    label === 'blocked'
      ? 'blocked'
      : input.mode === 'clarify_first'
        ? 'clarify'
        : input.warnings.some(
              (warning) => warning.warningKind === 'high_risk_action',
            )
          ? 'approval_only'
          : input.mode === 'verify_then_act'
            ? 'verify_first'
            : 'answer';
  return {
    calibrationId: hashId('confidence', input.frameId),
    frameId: input.frameId,
    createdAt: input.now,
    label,
    score,
    proofFreshnessScore,
    toolReliabilityScore,
    realityConfidenceScore,
    missingInfoPenalty,
    contradictionPenalty,
    routeHistoryScore,
    skillReliabilityScore,
    correctionPenalty,
    reason: `Confidence is ${label} because reality=${realityConfidenceScore.toFixed(2)}, tools=${toolReliabilityScore.toFixed(2)}, proof=${proofFreshnessScore.toFixed(2)}, contradictions=${input.reality.contradictions.length}.`,
    whatWouldIncreaseConfidence:
      input.reality.verificationNeeds[0]?.nextAction ||
      'Collect one fresh status/proof observation for the selected route.',
    actionAllowed,
    privacyJson: privacyJson(),
  };
}

function modeSpec(mode: ReasoningMode): ReasoningModeSpec {
  const specs: Record<ReasoningMode, ReasoningModeSpec> = {
    fast_direct: {
      modeReason:
        'Low-risk request with enough local context; keep the answer short.',
      requiredContextJson: json(['current ask', 'basic active context']),
      allowedToolsJson: json(['local_direct_answer']),
      approvalRequirement: 'read_only',
      outputShape: 'direct',
      failureMode:
        'If ambiguity or risk appears, switch to clarify_first or verify_then_act.',
    },
    clarify_first: {
      modeReason: 'A missing detail blocks a safe useful action.',
      requiredContextJson: json(['current ask', 'missing premise']),
      allowedToolsJson: json(['clarifying_question']),
      approvalRequirement: 'read_only',
      outputShape: 'one_question',
      failureMode: 'Do not act until the missing detail is supplied.',
    },
    retrieve_grounded: {
      modeReason:
        'The user is asking about truth, status, support, or remembered evidence.',
      requiredContextJson: json(['evidence IDs', 'proof state', 'tool status']),
      allowedToolsJson: json([
        'local memory',
        'status reads',
        'knowledge library',
      ]),
      approvalRequirement: 'read_only',
      outputShape: 'verified_answer',
      failureMode: 'Caveat uncertainty when evidence is stale or missing.',
    },
    plan_stepwise: {
      modeReason: 'The ask benefits from a compact practical plan.',
      requiredContextJson: json([
        'active goal',
        'open loops',
        'safe next step',
      ]),
      allowedToolsJson: json([
        'goal planner',
        'missions',
        'reminders',
        'action bundles',
      ]),
      approvalRequirement: 'read_only',
      outputShape: 'short_plan',
      failureMode:
        'Keep to one primary move when the user asks for next action.',
    },
    compare_counterfactuals: {
      modeReason: 'Multiple plausible actions or tradeoffs need comparison.',
      requiredContextJson: json([
        'candidate actions',
        'risks',
        'proof freshness',
      ]),
      allowedToolsJson: json([
        'goal planner',
        'reality grounding',
        'tool reliability',
      ]),
      approvalRequirement: 'read_only',
      outputShape: 'short_plan',
      failureMode: 'Ask or verify if no option has enough evidence.',
    },
    verify_then_act: {
      modeReason:
        'A durable or external action needs proof, policy, or approval first.',
      requiredContextJson: json([
        'proof state',
        'approval boundary',
        'target object',
      ]),
      allowedToolsJson: json(['status reads', 'draft/stage only']),
      approvalRequirement: 'approval_required',
      outputShape: 'verified_answer',
      failureMode:
        'Stage drafts or reminders; never claim the action completed without proof.',
    },
    deliberate_with_critic: {
      modeReason:
        'The request is high-risk, explicitly deep, or likely to fail if rushed.',
      requiredContextJson: json([
        'candidate routes',
        'critic objections',
        'fallback',
      ]),
      allowedToolsJson: json(['council/critic when available', 'status reads']),
      approvalRequirement: 'approval_required',
      outputShape: 'short_plan',
      failureMode: 'Expose only the decision summary, not hidden reasoning.',
    },
    defer_or_handoff: {
      modeReason:
        'The current channel or tool state is not suitable for the work.',
      requiredContextJson: json([
        'handoff target',
        'blocked tool',
        'next safe step',
      ]),
      allowedToolsJson: json(['telegram_handoff', 'manual proof instruction']),
      approvalRequirement: 'manual_external',
      outputShape: 'handoff',
      failureMode: 'Give the exact manual next step and stop.',
    },
  };
  return specs[mode];
}

export function analyzeMetacognitiveTurn(
  input: BuildMetacognitiveInput,
): MetacognitiveTurnAnalysis {
  const now = nowIso(input.now);
  const persist = input.persist !== false;
  const text = safeText(input.rawAsk, 900);
  const reality =
    input.realityReport ||
    buildRealityGroundingReport({
      requestText: text,
      channel: input.channel,
      persist: false,
    });
  const reliability =
    input.reliabilityReport || buildToolReliabilityDoctorReport();
  const frameId = hashId(
    'wm:frame',
    `${now}|${input.channel}|${input.groupFolder || ''}|${input.chatJid || ''}|${input.threadId || ''}|${text}`,
  );
  const items = buildMemoryItems({
    frameId,
    now,
    text,
    snapshotItems: input.snapshotItems || [],
    reality,
    reliability,
    activeContextSummary: input.activeContextSummary,
    selectedWorkSummary: input.selectedWorkSummary,
    groupFolder: input.groupFolder,
  });
  const warnings = buildWarnings({
    text,
    reality,
    reliability,
    items,
    approvalRequired: Boolean(input.approvalRequired),
  });
  const mode = selectMode({
    text,
    intentFamily: input.intentFamily,
    channel: input.channel,
    reality,
    warnings,
    approvalRequired: Boolean(input.approvalRequired),
  });
  const selectedItems = items.filter(
    (item) => item.includeInUserAnswer || item.relevance >= 0.78,
  );
  const ignoredItems = items.filter((item) => !selectedItems.includes(item));
  const calibration = calibrationFrom({
    frameId,
    now,
    mode,
    reality,
    reliability,
    warnings,
    items,
  });
  const activeGoalId =
    input.snapshotItems?.find((item) => item.itemKind === 'mission')
      ?.sourceId ||
    listGoalPlannerRuns({ groupFolder: input.groupFolder, limit: 1 })[0]
      ?.selectedGoalId ||
    null;
  const frame: WorkingMemoryFrame = {
    frameId,
    createdAt: now,
    updatedAt: now,
    channel: input.channel,
    groupFolder: input.groupFolder || null,
    chatJid: input.chatJid || null,
    threadId: input.threadId || null,
    requestSummary: text,
    currentAskSummary: text,
    activeGoalId,
    activeObjectSummary:
      input.selectedWorkSummary ||
      input.activeContextSummary ||
      input.snapshot?.currentFocus ||
      'No single active object dominates this turn.',
    itemIdsJson: idJson(items.map((item) => item.itemId)),
    selectedItemIdsJson: idJson(selectedItems.map((item) => item.itemId)),
    ignoredItemIdsJson: idJson(ignoredItems.map((item) => item.itemId)),
    recommendedReasoningMode: mode,
    confidence: calibration.score,
    expiresAt: addHours(now, 24),
    staleAfter: addHours(now, 2),
    privacyJson: privacyJson(),
  };
  const focus: AttentionFocus = {
    focusId: hashId('attention', frameId),
    frameId,
    createdAt: now,
    primaryFocus: frame.activeObjectSummary,
    secondaryFocus:
      selectedItems.find((item) => item.itemKind === 'uncertainty')?.summary ||
      null,
    ignoredContextJson: json(
      ignoredItems.slice(0, 8).map((item) => ({
        id: item.itemId,
        reason:
          item.relevance < 0.5 ? 'low relevance' : 'not needed for answer',
      })),
    ),
    reason:
      selectedItems[0]?.summary ||
      'Focus follows the current ask and highest-confidence proof/status item.',
    expectedNextStep: calibration.whatWouldIncreaseConfidence,
    privacyJson: privacyJson(),
  };
  const routeCandidates = [
    input.routeKey || null,
    ...(mode === 'compare_counterfactuals'
      ? ['goal_planner', 'reality_grounding']
      : []),
    ...(mode === 'plan_stepwise' ? ['goal_planner', 'action_bundles'] : []),
    ...(mode === 'retrieve_grounded' ? ['memory_recall', 'status_reads'] : []),
    ...(mode === 'verify_then_act' ? ['verify_status', 'stage_approval'] : []),
    ...(mode === 'fast_direct' ? ['direct_answer'] : []),
  ].filter(Boolean);
  const workspace: GlobalWorkspaceSnapshot = {
    workspaceId: hashId('global_workspace', frameId),
    frameId,
    createdAt: now,
    requestSummary: text,
    activeGoalId,
    selectedItemIdsJson: frame.selectedItemIdsJson,
    routeCandidatesJson: json(routeCandidates),
    uncertaintyJson: json(
      warnings.map((warning) => ({
        kind: warning.warningKind,
        severity: warning.severity,
        summary: warning.summary,
      })),
    ),
    proofStateJson: json({
      status: reality.snapshot.status,
      confidence: reality.snapshot.confidence,
      proofDebt: reality.proofDebt,
    }),
    toolAvailabilityJson: json(
      reliability.topDegraded.slice(0, 8).map((rollup) => ({
        subjectId: rollup.subjectId,
        health: rollup.currentHealth,
        confidenceCap: rollup.confidenceCap,
      })),
    ),
    safetyConcernsJson: json(
      warnings.filter((warning) => warning.severity !== 'low'),
    ),
    selectedReasoningMode: mode,
    recommendedNextAction:
      mode === 'clarify_first'
        ? 'Ask one missing-detail question.'
        : mode === 'verify_then_act'
          ? 'Verify proof/approval before acting.'
          : reality.nextAction,
    evidenceRefsJson: idJson([
      reality.snapshot.snapshotId,
      input.snapshot?.snapshotId,
      ...selectedItems.flatMap((item) => parseIds(item.evidenceRefsJson)),
    ]),
    privacyJson: privacyJson(),
  };
  const spec = modeSpec(mode);
  const decision: ReasoningModeDecision = {
    decisionId: hashId('reasoning_mode', frameId),
    frameId,
    createdAt: now,
    mode,
    confidence: calibration.score,
    warningsJson: json(warnings),
    privacyJson: privacyJson(),
    ...spec,
  };
  const needsDeliberation =
    mode === 'deliberate_with_critic' ||
    mode === 'compare_counterfactuals' ||
    warnings.some((warning) => warning.severity === 'high');
  const deliberation: DeliberationRecord = {
    deliberationId: hashId('deliberation', frameId),
    frameId,
    createdAt: now,
    status: needsDeliberation ? 'completed' : 'not_needed',
    trigger: needsDeliberation
      ? `mode=${mode}; warnings=${warnings.map((warning) => warning.warningKind).join(',') || 'none'}`
      : 'Fast or grounded route did not require structured deliberation.',
    candidateRoutesJson: json(routeCandidates),
    criticObjectionsJson: json(
      warnings.map((warning) => ({
        objection: warning.summary,
        nextAction: warning.nextAction,
      })),
    ),
    finalRecommendation: workspace.recommendedNextAction,
    fallback:
      calibration.actionAllowed === 'blocked'
        ? 'Stop and ask for proof/config recovery.'
        : 'Clarify or use safe local fallback if the selected route fails.',
    approvalRequired:
      calibration.actionAllowed === 'approval_only' ||
      decision.approvalRequirement !== 'read_only',
    hiddenReasoningStored: false,
    privacyJson: privacyJson(),
  };
  const strategySignal: StrategyLearningSignal = {
    signalId: hashId('strategy_signal', `${frameId}|${mode}`),
    frameId,
    createdAt: now,
    requestFamily: input.intentFamily || 'other',
    selectedMode: mode,
    routeKey: input.routeKey || null,
    toolId: input.selectedToolId || null,
    confidence: calibration.score,
    warningKindsJson: json(warnings.map((warning) => warning.warningKind)),
    userResponse: isDeepControl(text)
      ? 'asked_for_more_reasoning'
      : isQuickControl(text)
        ? 'asked_for_less_detail'
        : 'unknown',
    outcome: 'unknown',
    fallbackUsed: false,
    strategyAdjustment: warnings.length
      ? 'Reduce confidence or verify before acting when these warnings repeat.'
      : 'No adjustment needed from this turn yet.',
    improvementHint: warnings.some(
      (warning) => warning.warningKind === 'overconfidence',
    )
      ? 'Consider a confidence-calibration improvement hypothesis.'
      : warnings.some(
            (warning) => warning.warningKind === 'ambiguous_reference',
          )
        ? 'Consider a working-memory focus improvement if ambiguity repeats.'
        : 'Use this as route/mode evidence for future turns.',
    privacyJson: privacyJson(),
  };
  if (persist && isDatabaseInitialized()) {
    upsertWorkingMemoryFrame(frame);
    for (const item of items) upsertMemoryItem(item);
    upsertAttentionFocus(focus);
    upsertGlobalWorkspaceSnapshot(workspace);
    upsertReasoningModeDecision(decision);
    upsertConfidenceCalibration(calibration);
    upsertDeliberationRecord(deliberation);
    upsertStrategyLearningSignal(strategySignal);
  }
  return {
    frame,
    items,
    focus,
    workspace,
    decision,
    calibration,
    deliberation,
    strategySignal,
    warnings,
    mode,
    confidenceLabel: calibration.label,
    conciseSummary: `${mode} / ${calibration.label} confidence. ${decision.modeReason}`,
  };
}

export function buildMetacognitionDoctorReport(
  params: { requestText?: string; persist?: boolean; now?: Date | string } = {},
): MetacognitionDoctorReport {
  const generatedAt = nowIso(params.now);
  if (params.requestText) {
    const analysis = analyzeMetacognitiveTurn({
      rawAsk: params.requestText,
      channel: 'operator',
      groupFolder: null,
      now: generatedAt,
      persist: params.persist !== false,
    });
    return {
      generatedAt,
      ok: true,
      latestFrame: analysis.frame,
      focus: analysis.focus,
      workspace: analysis.workspace,
      decision: analysis.decision,
      calibration: analysis.calibration,
      deliberation: analysis.deliberation,
      strategySignals: [analysis.strategySignal],
      warnings: analysis.warnings,
      nextAction: analysis.workspace.recommendedNextAction,
      privacy: PRIVACY,
    };
  }
  const latestFrame = listWorkingMemoryFrames({ limit: 1 })[0] || null;
  const frameId = latestFrame?.frameId;
  const decision = frameId
    ? listReasoningModeDecisions({ frameId, limit: 1 })[0] || null
    : null;
  const calibration = frameId
    ? listConfidenceCalibrations({ frameId, limit: 1 })[0] || null
    : null;
  const deliberation = frameId
    ? listDeliberationRecords({ frameId, limit: 1 })[0] || null
    : null;
  const workspace = frameId
    ? listGlobalWorkspaceSnapshots({ frameId, limit: 1 })[0] || null
    : null;
  const focus = frameId
    ? listAttentionFocuses({ frameId, limit: 1 })[0] || null
    : null;
  const warnings = decision ? parseWarnings(decision.warningsJson) : [];
  return {
    generatedAt,
    ok: Boolean(latestFrame),
    latestFrame,
    focus,
    workspace,
    decision,
    calibration,
    deliberation,
    strategySignals: frameId
      ? listStrategyLearningSignals({ frameId, limit: 8 })
      : listStrategyLearningSignals({ limit: 8 }),
    warnings,
    nextAction:
      workspace?.recommendedNextAction ||
      calibration?.whatWouldIncreaseConfidence ||
      'Run one metacognitive executive turn to populate working memory.',
    privacy: PRIVACY,
  };
}

function parseWarnings(value: string): MetacognitiveWarning[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as MetacognitiveWarning[]) : [];
  } catch {
    return [];
  }
}

function formatList(lines: string[], fallback = '- none'): string[] {
  return lines.length ? lines : [fallback];
}

export function formatWorkingMemoryReport(
  report: MetacognitionDoctorReport = buildMetacognitionDoctorReport(),
): string {
  const frame = report.latestFrame;
  if (!frame) {
    return [
      '*Working Memory*',
      'No working-memory frame has been recorded yet.',
      `Next: ${report.nextAction}`,
      'Privacy: metadata-only.',
    ].join('\n');
  }
  const items = listMemoryItems({ frameId: frame.frameId, limit: 12 });
  return [
    '*Working Memory*',
    `Frame: ${frame.frameId}`,
    `Channel: ${frame.channel}`,
    `Mode: ${frame.recommendedReasoningMode}`,
    `Confidence: ${frame.confidence.toFixed(2)}`,
    `Focus: ${report.focus?.primaryFocus || frame.activeObjectSummary}`,
    `Stale after: ${frame.staleAfter}`,
    '',
    '*Selected Context*',
    ...formatList(
      items
        .filter((item) => item.includeInUserAnswer || item.relevance >= 0.78)
        .slice(0, 8)
        .map(
          (item) =>
            `- ${item.itemKind} (${item.relevance.toFixed(2)}/${item.confidence.toFixed(2)}): ${item.summary}`,
        ),
    ),
    '',
    '*Ignored Context*',
    report.focus?.ignoredContextJson || '[]',
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, provider debates, raw tool output, or secrets.',
  ].join('\n');
}

export function formatMetacognitionReport(
  report: MetacognitionDoctorReport = buildMetacognitionDoctorReport(),
): string {
  const decision = report.decision;
  const calibration = report.calibration;
  return [
    '*Metacognition*',
    `Generated: ${report.generatedAt}`,
    decision
      ? `Mode: ${decision.mode} (${decision.confidence.toFixed(2)})`
      : 'Mode: none',
    decision ? `Why: ${decision.modeReason}` : '',
    calibration
      ? `Confidence: ${calibration.label} (${calibration.score.toFixed(2)})`
      : 'Confidence: unknown',
    calibration ? `Calibration: ${calibration.reason}` : '',
    '',
    '*Warnings*',
    ...formatList(
      report.warnings.map(
        (warning) =>
          `- ${warning.severity}/${warning.warningKind}: ${warning.summary} -> ${warning.nextAction}`,
      ),
    ),
    '',
    '*Strategy Signals*',
    ...formatList(
      report.strategySignals
        .slice(0, 6)
        .map(
          (signal) =>
            `- ${signal.selectedMode}/${signal.outcome}: confidence=${signal.confidence.toFixed(2)} ${signal.strategyAdjustment}`,
        ),
    ),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: concise summaries only; hidden reasoning is not stored or shown.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatDeliberationReport(
  report: MetacognitionDoctorReport = buildMetacognitionDoctorReport(),
): string {
  const deliberation = report.deliberation;
  if (!deliberation) {
    return [
      '*Deliberation*',
      'No deliberation record has been recorded yet.',
      `Next: ${report.nextAction}`,
    ].join('\n');
  }
  return [
    '*Deliberation*',
    `Status: ${deliberation.status}`,
    `Trigger: ${deliberation.trigger}`,
    `Approval: ${deliberation.approvalRequired ? 'required' : 'not required'}`,
    `Hidden reasoning stored: ${deliberation.hiddenReasoningStored ? 'yes' : 'no'}`,
    '',
    '*Candidate Routes*',
    deliberation.candidateRoutesJson,
    '',
    '*Critic Objections*',
    deliberation.criticObjectionsJson,
    '',
    `Recommendation: ${deliberation.finalRecommendation}`,
    `Fallback: ${deliberation.fallback}`,
    'Privacy: decision summary only; no raw chain-of-thought.',
  ].join('\n');
}

export function isMetacognitionNaturalRequest(text: string): boolean {
  const lower = normalizeText(text)
    .toLowerCase()
    .replace(/[?.!]+$/u, '');
  return (
    lower === 'why did you pick that' ||
    lower === 'what are you basing that on' ||
    lower === 'are you sure' ||
    lower === 'what are you unsure about' ||
    lower === 'what would make you more confident' ||
    lower === 'what context are you using' ||
    lower === 'reset current focus' ||
    /\b(why are you thinking about that|what are you basing that on|are you sure|what are you unsure|what would make you more confident|what context are you using|ignore that context|reset current focus)\b/i.test(
      lower,
    )
  );
}

export function formatMetacognitionNaturalResponse(text: string): string {
  const lower = normalizeText(text).toLowerCase();
  if (/reset current focus/.test(lower)) {
    return 'I reset the current focus for this chat. I will use the next clear ask as the new anchor.';
  }
  const report = buildMetacognitionDoctorReport();
  if (!report.latestFrame) {
    return 'I do not have a recent reasoning route to explain yet.';
  }
  if (/context/.test(lower)) {
    return formatWorkingMemoryReport(report);
  }
  if (/sure|confident|wrong|unsure/.test(lower)) {
    const calibration = report.calibration;
    return [
      calibration
        ? `I am ${calibration.label}-confidence (${calibration.score.toFixed(2)}).`
        : 'I do not have a confidence score recorded yet.',
      calibration?.reason,
      calibration
        ? `More confidence would come from: ${calibration.whatWouldIncreaseConfidence}`
        : null,
      report.warnings.length
        ? `Main caveat: ${report.warnings[0].summary}`
        : 'No major caveat is recorded for the last route.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    report.decision
      ? `I picked ${report.decision.mode} because ${report.decision.modeReason}`
      : 'I do not have a recorded reasoning mode yet.',
    report.focus ? `I focused on: ${report.focus.primaryFocus}` : null,
    report.warnings.length
      ? `I was watching: ${report.warnings.map((warning) => warning.warningKind).join(', ')}`
      : null,
    `Next: ${report.nextAction}`,
  ]
    .filter(Boolean)
    .join('\n');
}
