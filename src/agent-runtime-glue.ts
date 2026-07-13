import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import type {
  AgentRuntimeCheckpoint,
  AgentRuntimeEvent,
  AgentRuntimeEvidencePacket,
  AgentRuntimeGuardrailResult,
  AgentRuntimeSkillManifest,
  AgentRuntimeWrite,
  LogicEvidenceFreshness,
} from './types.js';

export const AGENT_RUNTIME_SOURCE_REFS = [
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:guardrail/toolGuardrail/runLoop/streamReconciliation/tracing',
  'microsoft-agent-governance-toolkit@e0183314fa0fbaa91a92389d97fb45ac99f03be7:adapter-helpers/intervention-shape',
  'langgraphjs@c41878187014ff58a4ee8371fa8361edc97b2e84:checkpoint-sqlite/checkpoints-writes-pattern',
  'gbrain@805814451ec9e962ceed1b931b9b512d80f70024:recency-decay/fact-decay/citation/cross-source/return-policy',
  'openhands@03aab93625079c24d6f43655c9506931cf43bc17:event-content-helpers/skill-precedence-pattern',
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_EVENT_SUMMARY_LENGTH = 1000;

export type RuntimeGuardrailBehavior =
  | { type: 'allow' }
  | { type: 'rejectContent'; message: string }
  | { type: 'throwException' }
  | { type: 'stageApproval'; message: string }
  | { type: 'transform'; message: string };

export type RuntimePolicyDecision = 'allow' | 'deny' | 'suspend' | 'transform';

export interface RuntimeGuardrailInput {
  runtimeRunId: string;
  stepId?: string | null;
  generatedAt: string;
  interventionPoint: AgentRuntimeGuardrailResult['interventionPoint'];
  guardrailName: string;
  behavior: RuntimeGuardrailBehavior;
  decision?: RuntimePolicyDecision;
  reason?: string;
  riskFlags?: string[];
  outputInfo?: Record<string, unknown>;
}

export interface RuntimeCheckpointInput {
  runtimeRunId: string;
  generatedAt: string;
  threadId: string;
  checkpointNs?: string;
  parentCheckpointId?: string | null;
  status?: AgentRuntimeCheckpoint['status'];
  state: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  pendingWriteIds?: string[];
  nextAction: string;
}

export interface RuntimeWriteInput {
  runtimeRunId: string;
  checkpointId: string;
  generatedAt: string;
  taskId: string;
  idx: number;
  channel: string;
  writeType: AgentRuntimeWrite['writeType'];
  status?: AgentRuntimeWrite['status'];
  valueSummary: Record<string, unknown>;
}

export interface RuntimeCitationCoverageInput {
  text: string;
  evidenceIds: string[];
}

export interface RuntimeSkillManifestInput {
  generatedAt: string;
  skillId: string;
  sourceKind: AgentRuntimeSkillManifest['sourceKind'];
  frontmatter?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
  toolRefs?: string[];
  approvalRules?: string[];
  evidenceNeeds?: string[];
  summary: string;
}

export function runtimeHashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export function runtimeSanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9:_-]+/g, '_').slice(0, 220);
}

export function runtimeSafeJson(value: unknown, limit = 12000): string {
  try {
    const json = JSON.stringify(value ?? null);
    return redactCouncilText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            summary: json.slice(0, Math.max(0, limit - 80)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

export function runtimeParseJsonArray(
  value: string | null | undefined,
): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export function runtimePrivacyJson(): string {
  return runtimeSafeJson({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    rawToolOutputStored: false,
    secretsRedacted: true,
  });
}

export function runtimePrivacyReport(): {
  metadataOnly: true;
  rawPromptsStored: false;
  rawPrivateBodiesStored: false;
  hiddenReasoningStored: false;
  secretsRedacted: true;
} {
  return {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  };
}

export const RuntimeToolGuardrailOutputFactory = {
  allow(outputInfo?: Record<string, unknown>): RuntimeGuardrailBehavior {
    void outputInfo;
    return { type: 'allow' };
  },
  rejectContent(message: string): RuntimeGuardrailBehavior {
    return { type: 'rejectContent', message };
  },
  throwException(): RuntimeGuardrailBehavior {
    return { type: 'throwException' };
  },
  stageApproval(message: string): RuntimeGuardrailBehavior {
    return { type: 'stageApproval', message };
  },
  transform(message: string): RuntimeGuardrailBehavior {
    return { type: 'transform', message };
  },
};

export function appliesRuntimeTransform(
  decision: RuntimePolicyDecision,
): boolean {
  return decision === 'transform';
}

export function transformedRuntimeValueOr<T>(
  decision: RuntimePolicyDecision,
  transformed: T | undefined,
  fallback: T,
): T {
  return appliesRuntimeTransform(decision) && transformed !== undefined
    ? transformed
    : fallback;
}

export function makeRuntimeGuardrailResult(
  input: RuntimeGuardrailInput,
): AgentRuntimeGuardrailResult {
  const decision = input.decision || decisionForBehavior(input.behavior);
  const status = statusForBehavior(input.behavior);
  const message =
    input.behavior.type === 'rejectContent' ||
    input.behavior.type === 'stageApproval' ||
    input.behavior.type === 'transform'
      ? input.behavior.message
      : input.reason || 'Guardrail passed.';
  return {
    guardrailResultId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:guardrail',
        [
          input.runtimeRunId,
          input.stepId || '',
          input.interventionPoint,
          input.guardrailName,
          input.behavior.type,
          input.reason || '',
        ].join('|'),
      ),
    ),
    runtimeRunId: input.runtimeRunId,
    stepId: input.stepId || null,
    createdAt: input.generatedAt,
    interventionPoint: input.interventionPoint,
    behavior:
      input.behavior.type === 'rejectContent'
        ? 'reject_content'
        : input.behavior.type === 'throwException'
          ? 'throw_exception'
          : input.behavior.type === 'stageApproval'
            ? 'stage_approval'
            : input.behavior.type === 'transform'
              ? 'transform'
              : 'allow',
    status,
    decision,
    allowed: status === 'pass' || status === 'transformed',
    transformed: decision === 'transform',
    reason: redactCouncilText(input.reason || message, 900),
    message: redactCouncilText(message, 900),
    riskFlagsJson: runtimeSafeJson(input.riskFlags || [], 2400),
    outputInfoJson: runtimeSafeJson(
      {
        ...(input.outputInfo || {}),
        sourceRefs: [
          'openai-agents-js/toolGuardrail.ts:behavior-shape',
          'microsoft-agt/adapter-helpers.ts:transform-only-mutation',
        ],
      },
      3200,
    ),
    nextAction:
      status === 'approval_required'
        ? 'Stage an approval packet and wait for explicit resume.'
        : status === 'block'
          ? 'Fail closed and report the policy blocker.'
          : 'Continue to the next checkpointed runtime step.',
    privacyJson: runtimePrivacyJson(),
  };
}

function decisionForBehavior(
  behavior: RuntimeGuardrailBehavior,
): RuntimePolicyDecision {
  if (behavior.type === 'rejectContent' || behavior.type === 'throwException') {
    return 'deny';
  }
  if (behavior.type === 'stageApproval') return 'suspend';
  if (behavior.type === 'transform') return 'transform';
  return 'allow';
}

function statusForBehavior(
  behavior: RuntimeGuardrailBehavior,
): AgentRuntimeGuardrailResult['status'] {
  if (behavior.type === 'rejectContent' || behavior.type === 'throwException') {
    return 'block';
  }
  if (behavior.type === 'stageApproval') return 'approval_required';
  if (behavior.type === 'transform') return 'transformed';
  return 'pass';
}

export function makeRuntimeCheckpoint(
  input: RuntimeCheckpointInput,
): AgentRuntimeCheckpoint {
  return {
    checkpointId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:checkpoint',
        [
          input.runtimeRunId,
          input.threadId,
          input.checkpointNs || '',
          input.parentCheckpointId || '',
          JSON.stringify(input.metadata || {}),
        ].join('|'),
      ),
    ),
    runtimeRunId: input.runtimeRunId,
    threadId: redactCouncilText(input.threadId, 320),
    checkpointNs: redactCouncilText(input.checkpointNs || '', 160),
    parentCheckpointId: input.parentCheckpointId || null,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    status: input.status || 'open',
    checkpointJson: runtimeSafeJson(
      {
        version: 1,
        state: input.state,
        source: 'langgraphjs/checkpoint-sqlite-shape',
      },
      6400,
    ),
    metadataJson: runtimeSafeJson(
      {
        ...(input.metadata || {}),
        sourcePattern:
          'thread_id + checkpoint_ns + checkpoint_id + pending_writes',
      },
      3200,
    ),
    pendingWriteIdsJson: runtimeSafeJson(input.pendingWriteIds || [], 2400),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

export function makeRuntimeWrite(input: RuntimeWriteInput): AgentRuntimeWrite {
  return {
    writeId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:write',
        [
          input.runtimeRunId,
          input.checkpointId,
          input.taskId,
          String(input.idx),
          input.channel,
          input.writeType,
        ].join('|'),
      ),
    ),
    checkpointId: input.checkpointId,
    runtimeRunId: input.runtimeRunId,
    taskId: redactCouncilText(input.taskId, 320),
    idx: input.idx,
    channel: redactCouncilText(input.channel, 160),
    writeType: input.writeType,
    status: input.status || 'pending',
    valueSummaryJson: runtimeSafeJson(
      {
        ...input.valueSummary,
        sourcePattern: 'langgraphjs/pending-writes',
      },
      3200,
    ),
    createdAt: input.generatedAt,
    appliedAt: input.status === 'applied' ? input.generatedAt : null,
    privacyJson: runtimePrivacyJson(),
  };
}

export function freshnessFromAge(
  iso: string | null | undefined,
  nowIso: string,
): LogicEvidenceFreshness {
  if (!iso) return 'unknown';
  const thenMs = Date.parse(iso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return 'unknown';
  const ageDays = Math.max(0, (nowMs - thenMs) / MS_PER_DAY);
  if (ageDays <= 1) return 'fresh';
  if (ageDays <= 7) return 'recent';
  if (ageDays <= 30) return 'stale';
  return 'expired';
}

export function recencyDecayScore(input: {
  sourceKey: string;
  createdAt?: string | null;
  now: string;
}): number {
  const sourceKey = input.sourceKey.toLowerCase();
  const cfg =
    sourceKey.includes('calendar') || sourceKey.includes('bluebubbles')
      ? { halflifeDays: 7, coefficient: 1.25 }
      : sourceKey.includes('provider') || sourceKey.includes('integration')
        ? { halflifeDays: 2, coefficient: 1.5 }
        : sourceKey.includes('skill')
          ? { halflifeDays: 90, coefficient: 0.4 }
          : { halflifeDays: 30, coefficient: 0.7 };
  if (!input.createdAt || cfg.halflifeDays <= 0) return 1;
  const ageDays = Math.max(
    0,
    (Date.parse(input.now) - Date.parse(input.createdAt)) / MS_PER_DAY,
  );
  if (!Number.isFinite(ageDays)) return 0.5;
  return clamp01(
    cfg.coefficient * (cfg.halflifeDays / (cfg.halflifeDays + ageDays)),
  );
}

export function effectiveRuntimeConfidence(input: {
  confidence: number;
  kind: 'event' | 'commitment' | 'preference' | 'belief' | 'fact' | 'proof';
  validFrom?: string | null;
  validUntil?: string | null;
  now: string;
}): number {
  if (
    input.validUntil &&
    Date.parse(input.validUntil) <= Date.parse(input.now)
  ) {
    return 0;
  }
  const halflifeDays: Record<
    'event' | 'commitment' | 'preference' | 'belief' | 'fact' | 'proof',
    number
  > = {
    event: 7,
    commitment: 90,
    preference: 90,
    belief: 365,
    fact: 365,
    proof: 14,
  };
  const validFromMs = input.validFrom
    ? Date.parse(input.validFrom)
    : Date.parse(input.now);
  const ageDays = Math.max(
    0,
    (Date.parse(input.now) - validFromMs) / MS_PER_DAY,
  );
  if (!Number.isFinite(ageDays)) return clamp01(input.confidence);
  return clamp01(
    input.confidence * Math.exp(-ageDays / halflifeDays[input.kind]),
  );
}

export function citationCoverageFor(
  input: RuntimeCitationCoverageInput,
): number {
  const paragraphs = input.text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => looksFactual(paragraph));
  if (paragraphs.length === 0) return input.evidenceIds.length > 0 ? 1 : 0;
  const citationRe =
    /\[Source:\s*\S[^\]]*\]|\]\(\s*https?:\/\/[^)]+\)|\b(?:world|logic|truth|agentos|runtime|council|evidence):[A-Za-z0-9:_-]+/i;
  const cited = paragraphs.filter(
    (paragraph) =>
      citationRe.test(paragraph) ||
      input.evidenceIds.some((id) => paragraph.includes(id)),
  ).length;
  return clamp01(cited / paragraphs.length);
}

function looksFactual(paragraph: string): boolean {
  const stripped = paragraph
    .replace(/`[^`\n]*`/g, ' ')
    .replace(new RegExp('<!--[\\s\\S]*?-->', 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return false;
  if (/^#{1,6}\s/.test(stripped) || /^>/.test(stripped)) return false;
  if (/^\s*\|.+\|\s*$/.test(stripped)) return false;
  if (
    stripped.length < 40 &&
    !/\b(is|was|were|has|have|will|needs|blocked|working|requires)\b/i.test(
      stripped,
    )
  ) {
    return false;
  }
  return true;
}

export function contradictionTierForSources(
  sourceIds: string[],
): AgentRuntimeEvidencePacket['contradictionTier'] {
  const tiers = sourceIds.map(classifyRuntimeSourceTier);
  const has = (tier: 'curated' | 'bulk' | 'other') => tiers.includes(tier);
  if (tiers.filter((tier) => tier === 'curated').length >= 2) {
    return 'curated_vs_curated';
  }
  if (has('curated') && has('bulk')) return 'curated_vs_bulk';
  if (tiers.filter((tier) => tier === 'bulk').length >= 2)
    return 'bulk_vs_bulk';
  return 'other';
}

function classifyRuntimeSourceTier(
  sourceId: string,
): 'curated' | 'bulk' | 'other' {
  const lower = sourceId.toLowerCase();
  if (/world|logic|truth|agentos|cognition|profile|skill/.test(lower)) {
    return 'curated';
  }
  if (/message|bluebubbles|telegram|bulk|debug|log/.test(lower)) return 'bulk';
  return 'other';
}

export function adaptiveReturnDecision(input: {
  intent: 'entity' | 'temporal' | 'event' | 'general';
  total: number;
  enabled?: boolean;
}): {
  applied: boolean;
  intent: string;
  cap: number;
  kept: number;
  total: number;
} {
  const enabled = input.enabled !== false;
  if (!enabled || input.total <= 0) {
    return {
      applied: false,
      intent: input.intent,
      cap: input.total,
      kept: input.total,
      total: input.total,
    };
  }
  const cap = input.intent === 'entity' ? 2 : 6;
  const kept = Math.max(1, Math.min(cap, input.total));
  return { applied: true, intent: input.intent, cap, kept, total: input.total };
}

export function summarizeRuntimeEvent(input: {
  runtimeRunId: string;
  generatedAt: string;
  eventKind: AgentRuntimeEvent['eventKind'];
  severity?: AgentRuntimeEvent['severity'];
  label: string;
  detail?: string | null;
  refs?: string[];
}): AgentRuntimeEvent {
  const raw = [input.label, input.detail || ''].filter(Boolean).join('\n');
  const redacted = redactCouncilText(raw, MAX_EVENT_SUMMARY_LENGTH);
  const truncated =
    raw.length > redacted.length || raw.length > MAX_EVENT_SUMMARY_LENGTH;
  return {
    eventId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:event',
        [
          input.runtimeRunId,
          input.generatedAt,
          input.eventKind,
          input.label,
          (input.refs || []).join(','),
        ].join('|'),
      ),
    ),
    runtimeRunId: input.runtimeRunId,
    createdAt: input.generatedAt,
    eventKind: input.eventKind,
    severity: input.severity || 'info',
    summary: truncated
      ? `${redacted.slice(0, MAX_EVENT_SUMMARY_LENGTH - 15)}...(truncated)`
      : redacted,
    truncated,
    refsJson: runtimeSafeJson(input.refs || [], 2400),
    privacyJson: runtimePrivacyJson(),
  };
}

export function makeRuntimeEvidencePacket(input: {
  runtimeRunId: string;
  generatedAt: string;
  sourceLayer: AgentRuntimeEvidencePacket['sourceLayer'];
  sourceId: string;
  evidenceIds: string[];
  summary: string;
  createdAt?: string | null;
  confidence?: number;
  textForCitation?: string;
  intent?: 'entity' | 'temporal' | 'event' | 'general';
}): AgentRuntimeEvidencePacket {
  const freshness = freshnessFromAge(
    input.createdAt || input.generatedAt,
    input.generatedAt,
  );
  const recency = recencyDecayScore({
    sourceKey: input.sourceLayer,
    createdAt: input.createdAt || input.generatedAt,
    now: input.generatedAt,
  });
  const confidence = effectiveRuntimeConfidence({
    confidence: input.confidence ?? 0.72,
    kind: input.sourceLayer === 'world_model' ? 'proof' : 'fact',
    validFrom: input.createdAt || input.generatedAt,
    now: input.generatedAt,
  });
  const citationCoverage = citationCoverageFor({
    text: input.textForCitation || input.summary,
    evidenceIds: input.evidenceIds,
  });
  const supportGrade: AgentRuntimeEvidencePacket['supportGrade'] =
    citationCoverage >= 0.75 && input.evidenceIds.length > 0
      ? 'strong'
      : input.evidenceIds.length > 0
        ? 'partial'
        : 'weak';
  return {
    evidencePacketId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:evidence',
        [
          input.runtimeRunId,
          input.sourceLayer,
          input.sourceId,
          input.evidenceIds.join(','),
        ].join('|'),
      ),
    ),
    runtimeRunId: input.runtimeRunId,
    createdAt: input.generatedAt,
    sourceLayer: input.sourceLayer,
    sourceId: redactCouncilText(input.sourceId, 320),
    evidenceIdsJson: runtimeSafeJson(input.evidenceIds, 3200),
    supportGrade,
    freshness,
    confidence: Number(
      clamp01(confidence * (0.75 + recency * 0.25)).toFixed(3),
    ),
    citationCoverage: Number(citationCoverage.toFixed(3)),
    contradictionTier: contradictionTierForSources(input.evidenceIds),
    returnPolicyJson: runtimeSafeJson(
      adaptiveReturnDecision({
        intent: input.intent || 'general',
        total: input.evidenceIds.length,
      }),
      1200,
    ),
    summary: redactCouncilText(input.summary, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

export function makeRuntimeSkillManifest(
  input: RuntimeSkillManifestInput,
): AgentRuntimeSkillManifest {
  const precedence =
    input.sourceKind === 'user'
      ? 100
      : input.sourceKind === 'project'
        ? 80
        : 50;
  return {
    manifestId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:skill',
        [input.skillId, input.sourceKind, precedence].join('|'),
      ),
    ),
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    skillId: redactCouncilText(input.skillId, 320),
    sourceKind: input.sourceKind,
    precedence,
    status: 'candidate',
    frontmatterJson: runtimeSafeJson(
      {
        ...(input.frontmatter || {}),
        precedence,
        sourcePattern: 'openhands/microagent-frontmatter-precedence',
      },
      3200,
    ),
    triggerJson: runtimeSafeJson(input.trigger || {}, 2400),
    toolRefsJson: runtimeSafeJson(input.toolRefs || [], 2400),
    approvalRulesJson: runtimeSafeJson(input.approvalRules || [], 2400),
    evidenceNeedsJson: runtimeSafeJson(input.evidenceNeeds || [], 2400),
    summary: redactCouncilText(input.summary, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
