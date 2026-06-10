import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  upsertActivePerceptionPlan,
  upsertActivePerceptionProbe,
  upsertProofClosureStep,
  upsertRealityBelief,
  upsertRealityContradiction,
  upsertRealityObservation,
  upsertRealitySnapshot,
  upsertRealityVerificationNeed,
} from './db.js';
import {
  buildAutonomousImprovementLabReport,
  type AutonomousImprovementLabReport,
} from './autonomous-improvement-lab.js';
import {
  buildLiveProofGauntletReport,
  formatLiveProofGauntletReport,
} from './live-proof-gauntlet.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import { buildToolReliabilityDoctorReport } from './tool-reliability.js';
import {
  buildWorldModelReport,
  type BuildWorldModelInput,
} from './world-model.js';
import type {
  ActivePerceptionPlan,
  ActivePerceptionProbe,
  CognitiveExecutiveChannel,
  LiveProofGauntletEntry,
  LiveProofGauntletReport,
  ProofClosureStep,
  RealityBelief,
  RealityContradiction,
  RealityDoctorReport,
  RealityObservation,
  RealitySnapshot,
  RealityVerificationNeed,
  ToolReliabilityDoctorReport,
  ToolReliabilityRollup,
  WorldModelDoctorReport,
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

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|provider debate|raw tool output/i;

export interface BuildRealityGroundingInput {
  generatedAt?: string;
  requestText?: string | null;
  channel?: CognitiveExecutiveChannel | 'operator' | 'internal';
  persist?: boolean;
  proofReport?: LiveProofGauntletReport;
  worldReport?: WorldModelDoctorReport;
  reliabilityReport?: ToolReliabilityDoctorReport;
  providerHealthSnapshots?: ProviderHealthSnapshot[];
  improvementReport?: AutonomousImprovementLabReport;
}

export interface GoalDirectedRealityCheck {
  actionKind:
    | 'calendar_write'
    | 'message_action'
    | 'reminder_save'
    | 'repair'
    | 'work_action';
  allowed: boolean;
  decision:
    | 'proceed_read_only'
    | 'ask_clarification'
    | 'stage_approval'
    | 'offer_safe_alternative'
    | 'block_until_verified';
  confidence: number;
  reason: string;
  nextAction: string;
  evidenceIdsJson: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted reality metadata]';
  return redactCouncilText(text, limit);
}

function safeJson(value: unknown, limit = 3200): string {
  try {
    const json = JSON.stringify(value ?? null);
    return safeText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            preview: json.slice(0, Math.max(32, limit - 120)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function idJson(ids: string[], limit = 80): string {
  return JSON.stringify(
    Array.from(
      new Set(
        ids
          .map((id) =>
            String(id || '')
              .replace(/[^A-Za-z0-9:_-]+/g, '_')
              .slice(0, 220),
          )
          .filter(Boolean),
      ),
    ).slice(0, limit),
  );
}

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

function redactLines(lines: string[], limit = 9000): string {
  const output: string[] = [];
  let used = 0;
  for (const line of lines) {
    for (const segment of line.split(/\r?\n/)) {
      const redacted = redactCouncilText(segment, 1200);
      used += redacted.length + 1;
      if (used > limit) {
        output.push('[truncated]');
        return output.join('\n');
      }
      output.push(redacted);
    }
  }
  return output.join('\n');
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function proofConfidence(entry: LiveProofGauntletEntry): number {
  switch (entry.status) {
    case 'live_proven':
      return 0.95;
    case 'near_live_only':
      return 0.58;
    case 'stale':
      return 0.42;
    case 'missing_config':
      return 0.2;
    case 'externally_blocked':
      return 0.24;
    case 'failed':
      return 0.12;
  }
}

function beliefStatusForProof(
  entry: LiveProofGauntletEntry,
): RealityBelief['status'] {
  switch (entry.status) {
    case 'live_proven':
      return 'confirmed';
    case 'near_live_only':
      return 'likely';
    case 'stale':
      return 'stale';
    case 'missing_config':
    case 'externally_blocked':
      return 'externally_blocked';
    case 'failed':
      return 'uncertain';
  }
}

function closureStatusForProof(
  entry: LiveProofGauntletEntry,
): ProofClosureStep['status'] {
  if (entry.status === 'live_proven') return 'complete';
  if (entry.status === 'missing_config') return 'missing_config';
  if (entry.status === 'externally_blocked') return 'externally_blocked';
  if (entry.status === 'stale') return 'stale_proof';
  if (entry.repoWorkRequired) return 'repo_bug';
  return 'manual_action';
}

function rollupObservationStatus(
  rollup: ToolReliabilityRollup,
): RealityBelief['status'] {
  if (rollup.currentHealth === 'healthy') return 'confirmed';
  if (rollup.currentHealth === 'degraded') return 'likely';
  if (rollup.currentHealth === 'blocked') return 'externally_blocked';
  return 'unknown';
}

function rollupConfidence(rollup: ToolReliabilityRollup): number {
  return clamp01(Math.max(rollup.confidenceCap, rollup.reliabilityScore));
}

function providerHealthForRollup(
  rollup: ToolReliabilityRollup,
  providers: ProviderHealthSnapshot[],
): ProviderHealthSnapshot | undefined {
  if (!rollup.subjectId.startsWith('provider:')) return undefined;
  const providerId = rollup.subjectId.replace(/^provider:/, '');
  return providers.find((provider) => provider.providerId === providerId);
}

function providerHealthAsRollupHealth(
  provider: ProviderHealthSnapshot,
): ToolReliabilityRollup['currentHealth'] {
  if (provider.state === 'healthy') return 'healthy';
  if (provider.state === 'degraded') return 'degraded';
  if (
    provider.state === 'externally_blocked' ||
    provider.state === 'not_configured'
  ) {
    return 'blocked';
  }
  return 'unknown';
}

function confidenceForEffectiveHealth(
  health: ToolReliabilityRollup['currentHealth'],
): number {
  if (health === 'healthy') return 0.95;
  if (health === 'degraded') return 0.58;
  if (health === 'blocked') return 0.22;
  return 0.5;
}

function effectiveRollupView(
  rollup: ToolReliabilityRollup,
  providers: ProviderHealthSnapshot[],
): {
  currentHealth: ToolReliabilityRollup['currentHealth'];
  reliabilityScore: number;
  confidenceCap: number;
  confidence: number;
  nextAction: string;
  sourceDetail: string;
} {
  const provider = providerHealthForRollup(rollup, providers);
  if (!provider) {
    return {
      currentHealth: rollup.currentHealth,
      reliabilityScore: rollup.reliabilityScore,
      confidenceCap: rollup.confidenceCap,
      confidence: rollupConfidence(rollup),
      nextAction: rollup.nextAction,
      sourceDetail: 'rollup',
    };
  }
  const health = providerHealthAsRollupHealth(provider);
  const cap = confidenceForEffectiveHealth(health);
  return {
    currentHealth: health,
    reliabilityScore:
      health === 'healthy'
        ? Math.max(rollup.reliabilityScore, 0.9)
        : Math.min(rollup.reliabilityScore, cap),
    confidenceCap:
      health === 'healthy' ? Math.max(rollup.confidenceCap, cap) : cap,
    confidence: cap,
    nextAction: provider.nextAction || provider.blocker || rollup.nextAction,
    sourceDetail: 'provider_health',
  };
}

function observation(input: {
  snapshotId: string;
  now: string;
  source: string;
  sourceType: RealityObservation['sourceType'];
  subject: string;
  thing: string;
  value: string;
  confidence: number;
  evidenceRef: string;
  freshnessWindowHours?: number;
}): RealityObservation {
  return {
    observationId: hashId(
      'reality:observation',
      `${input.snapshotId}|${input.sourceType}|${input.subject}|${input.thing}|${input.value}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    source: safeText(input.source, 240),
    sourceType: input.sourceType,
    subject: safeText(input.subject, 240),
    observedThing: safeText(input.thing, 240),
    observedValue: safeText(input.value, 1000),
    observedAt: input.now,
    freshnessWindowHours: input.freshnessWindowHours || 24,
    confidence: clamp01(input.confidence),
    sensitivity: 'low',
    evidenceRef: safeText(input.evidenceRef, 240),
    rawContentAllowed: false,
    privacyJson: privacyJson(),
  };
}

function makeBelief(input: {
  snapshotId: string;
  now: string;
  subject: string;
  summary: string;
  type: RealityBelief['beliefType'];
  status: RealityBelief['status'];
  confidence: number;
  supporting: string[];
  contradicting?: string[];
  staleHours?: number;
  nextAction: string;
}): RealityBelief {
  return {
    beliefId: hashId(
      'reality:belief',
      `${input.snapshotId}|${input.subject}|${input.type}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    updatedAt: input.now,
    subject: safeText(input.subject, 240),
    beliefSummary: safeText(input.summary, 1000),
    beliefType: input.type,
    confidence: clamp01(input.confidence),
    supportingObservationIdsJson: idJson(input.supporting),
    contradictingObservationIdsJson: idJson(input.contradicting || []),
    lastVerifiedAt: input.status === 'confirmed' ? input.now : null,
    staleAfterAt: input.staleHours
      ? addHours(input.now, input.staleHours)
      : null,
    status: input.status,
    nextAction: safeText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function makeNeed(input: {
  snapshotId: string;
  now: string;
  subject: string;
  question: string;
  reason: string;
  neededBeforeAction: boolean;
  tool: string;
  risk: RealityVerificationNeed['riskIfSkipped'];
  urgency?: RealityVerificationNeed['urgency'];
  status: RealityVerificationNeed['status'];
  evidence: string[];
  nextAction: string;
}): RealityVerificationNeed {
  return {
    needId: hashId(
      'reality:need',
      `${input.snapshotId}|${input.subject}|${input.question}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    updatedAt: input.now,
    question: safeText(input.question, 700),
    reason: safeText(input.reason, 900),
    neededBeforeAction: input.neededBeforeAction,
    possibleSourceTool: safeText(input.tool, 240),
    riskIfSkipped: input.risk,
    urgency: input.urgency || 'normal',
    status: input.status,
    evidenceIdsJson: idJson(input.evidence),
    nextAction: safeText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function makeContradiction(input: {
  snapshotId: string;
  now: string;
  subject: string;
  kind: RealityContradiction['contradictionKind'];
  severity: RealityContradiction['severity'];
  observations: string[];
  beliefs: string[];
  summary: string;
  nextAction: string;
}): RealityContradiction {
  return {
    contradictionId: hashId(
      'reality:contradiction',
      `${input.snapshotId}|${input.subject}|${input.kind}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    subject: safeText(input.subject, 240),
    contradictionKind: input.kind,
    severity: input.severity,
    status: 'open',
    observationIdsJson: idJson(input.observations),
    beliefIdsJson: idJson(input.beliefs),
    summary: safeText(input.summary, 1000),
    nextAction: safeText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function buildProofRecords(input: {
  snapshotId: string;
  now: string;
  proofReport: LiveProofGauntletReport;
}): {
  observations: RealityObservation[];
  beliefs: RealityBelief[];
  needs: RealityVerificationNeed[];
  contradictions: RealityContradiction[];
} {
  const observations: RealityObservation[] = [];
  const beliefs: RealityBelief[] = [];
  const needs: RealityVerificationNeed[] = [];
  const contradictions: RealityContradiction[] = [];
  for (const entry of input.proofReport.entries) {
    const obs = observation({
      snapshotId: input.snapshotId,
      now: input.now,
      source: 'live-proof-gauntlet',
      sourceType: 'proof_gauntlet',
      subject: entry.proofName,
      thing: 'proof_status',
      value: `${entry.status}; repo_work=${entry.repoWorkRequired ? 'yes' : 'no'}; next=${entry.nextStep}`,
      confidence: proofConfidence(entry),
      evidenceRef: entry.proofId,
      freshnessWindowHours: entry.status === 'live_proven' ? 24 : 6,
    });
    observations.push(obs);
    const belief = makeBelief({
      snapshotId: input.snapshotId,
      now: input.now,
      subject: entry.proofName,
      summary:
        entry.status === 'live_proven'
          ? `${entry.proofName} is currently live-proven.`
          : `${entry.proofName} is ${entry.status}; do not overclaim it as fully proven.`,
      type: 'proof_state',
      status: beliefStatusForProof(entry),
      confidence: proofConfidence(entry),
      supporting: [obs.observationId],
      staleHours: entry.status === 'live_proven' ? 24 : 6,
      nextAction: entry.nextStep,
    });
    beliefs.push(belief);
    if (entry.status !== 'live_proven') {
      needs.push(
        makeNeed({
          snapshotId: input.snapshotId,
          now: input.now,
          subject: entry.proofName,
          question: `What proof is needed for ${entry.proofName}?`,
          reason: `${entry.proofName} is ${entry.status}.`,
          neededBeforeAction:
            /message|telegram|alexa|calendar/i.test(entry.proofName) &&
            entry.status !== 'near_live_only',
          tool:
            entry.status === 'missing_config'
              ? 'environment configuration'
              : entry.repoWorkRequired
                ? 'repo repair'
                : 'manual proof',
          risk: /message|calendar|alexa/i.test(entry.proofName)
            ? 'high'
            : 'medium',
          status:
            entry.status === 'missing_config'
              ? 'manual_proof'
              : entry.repoWorkRequired
                ? 'runnable_read_only'
                : 'manual_proof',
          evidence: [entry.proofId, obs.observationId],
          nextAction: entry.nextStep,
        }),
      );
    }
    if (
      /bluebubbles/i.test(entry.proofName) &&
      entry.status !== 'live_proven' &&
      /transport|bridge|traffic|ready|available/i.test(entry.detail)
    ) {
      contradictions.push(
        makeContradiction({
          snapshotId: input.snapshotId,
          now: input.now,
          subject: entry.proofName,
          kind: 'transport_vs_proof',
          severity: 'medium',
          observations: [obs.observationId],
          beliefs: [belief.beliefId],
          summary:
            'BlueBubbles transport appears available, but same-thread message-action proof is not fresh.',
          nextAction:
            'Say the same-thread proof prompt, then defer with send it later tonight before calling Messages fully proven.',
        }),
      );
    }
  }
  return { observations, beliefs, needs, contradictions };
}

function buildReliabilityRecords(input: {
  snapshotId: string;
  now: string;
  reliabilityReport: ToolReliabilityDoctorReport;
  providerHealthSnapshots: ProviderHealthSnapshot[];
}): {
  observations: RealityObservation[];
  beliefs: RealityBelief[];
  needs: RealityVerificationNeed[];
  contradictions: RealityContradiction[];
} {
  const observations: RealityObservation[] = [];
  const beliefs: RealityBelief[] = [];
  const needs: RealityVerificationNeed[] = [];
  const contradictions: RealityContradiction[] = [];
  for (const rollup of input.reliabilityReport.rollups.slice(0, 30)) {
    const effective = effectiveRollupView(
      rollup,
      input.providerHealthSnapshots,
    );
    const obs = observation({
      snapshotId: input.snapshotId,
      now: input.now,
      source: 'tool-reliability',
      sourceType: 'tool_reliability',
      subject: rollup.subjectId,
      thing: 'tool_health',
      value: `${effective.currentHealth}; score=${effective.reliabilityScore.toFixed(2)}; cap=${effective.confidenceCap.toFixed(2)}; source=${effective.sourceDetail}; next=${effective.nextAction}`,
      confidence: effective.confidence,
      evidenceRef: `rollup:${rollup.subjectId}`,
      freshnessWindowHours: 24,
    });
    observations.push(obs);
    const status = rollupObservationStatus({
      ...rollup,
      currentHealth: effective.currentHealth,
    });
    const belief = makeBelief({
      snapshotId: input.snapshotId,
      now: input.now,
      subject: rollup.subjectId,
      summary: `${rollup.subjectId} reliability is ${effective.currentHealth}; route confidence cap is ${effective.confidenceCap.toFixed(2)}.`,
      type: rollup.subjectId.startsWith('provider:')
        ? 'tool_health'
        : 'route_confidence',
      status,
      confidence: effective.confidence,
      supporting: [obs.observationId],
      staleHours: 24,
      nextAction: effective.nextAction,
    });
    beliefs.push(belief);
    if (
      effective.currentHealth === 'blocked' ||
      effective.currentHealth === 'unknown'
    ) {
      needs.push(
        makeNeed({
          snapshotId: input.snapshotId,
          now: input.now,
          subject: rollup.subjectId,
          question: `Can ${rollup.subjectId} be trusted for routing right now?`,
          reason: `${rollup.subjectId} reliability is ${effective.currentHealth}.`,
          neededBeforeAction: /calendar|message|work_cockpit/.test(
            rollup.subjectId,
          ),
          tool: 'tool reliability read',
          risk: rollup.subjectId.includes('message') ? 'high' : 'medium',
          status: 'runnable_read_only',
          evidence: [obs.observationId],
          nextAction: effective.nextAction,
        }),
      );
    }
    if (
      rollup.subjectId.includes('brave') &&
      effective.currentHealth === 'blocked'
    ) {
      contradictions.push(
        makeContradiction({
          snapshotId: input.snapshotId,
          now: input.now,
          subject: rollup.subjectId,
          kind: 'provider_vs_route',
          severity: 'medium',
          observations: [obs.observationId],
          beliefs: [belief.beliefId],
          summary:
            'Research routes must not claim Brave participation while Brave Search is blocked.',
          nextAction:
            'Use local knowledge or healthy providers until Brave quota recovers.',
        }),
      );
    }
  }
  return { observations, beliefs, needs, contradictions };
}

function buildWorldRecords(input: {
  snapshotId: string;
  now: string;
  worldReport: WorldModelDoctorReport;
}): {
  observations: RealityObservation[];
  beliefs: RealityBelief[];
  needs: RealityVerificationNeed[];
} {
  const observations: RealityObservation[] = [];
  const beliefs: RealityBelief[] = [];
  const needs: RealityVerificationNeed[] = [];
  for (const fact of input.worldReport.learnedFacts.slice(0, 20)) {
    const obs = observation({
      snapshotId: input.snapshotId,
      now: input.now,
      source: 'world-facts',
      sourceType: 'world_fact',
      subject: fact.factType,
      thing: 'learned_fact_status',
      value: `${fact.status}; confidence=${fact.confidence.toFixed(2)}; ${fact.summary}`,
      confidence: fact.confidence,
      evidenceRef: fact.factId,
      freshnessWindowHours: 168,
    });
    observations.push(obs);
    if (fact.status === 'stale' || fact.status === 'pending_confirmation') {
      needs.push(
        makeNeed({
          snapshotId: input.snapshotId,
          now: input.now,
          subject: fact.factType,
          question: `Is this learned fact still current: ${fact.factType}?`,
          reason: `World fact is ${fact.status}.`,
          neededBeforeAction: fact.sensitivity !== 'low',
          tool: 'user confirmation',
          risk: fact.sensitivity === 'low' ? 'medium' : 'high',
          status:
            fact.status === 'stale' ? 'manual_proof' : 'approval_required',
          evidence: [obs.observationId, fact.factId],
          nextAction:
            fact.status === 'stale'
              ? 'Ask the user whether this is still current.'
              : 'Keep the inferred fact pending until the user confirms it.',
        }),
      );
    }
  }
  for (const claim of input.worldReport.claims.slice(0, 20)) {
    const obs = observation({
      snapshotId: input.snapshotId,
      now: input.now,
      source: 'world-model',
      sourceType: 'world_model',
      subject: claim.subject,
      thing: claim.claimKind,
      value: `${claim.status}; confidence=${claim.confidence.toFixed(2)}; ${claim.summary}`,
      confidence: claim.confidence,
      evidenceRef: claim.claimId,
      freshnessWindowHours: 24,
    });
    observations.push(obs);
    beliefs.push(
      makeBelief({
        snapshotId: input.snapshotId,
        now: input.now,
        subject: claim.subject,
        summary: claim.summary,
        type: 'status_truth',
        status:
          claim.status === 'current'
            ? 'confirmed'
            : claim.status === 'stale'
              ? 'stale'
              : claim.status === 'conflicted'
                ? 'contradicted'
                : claim.status === 'blocked'
                  ? 'externally_blocked'
                  : 'uncertain',
        confidence: claim.confidence,
        supporting: [obs.observationId],
        staleHours: 24,
        nextAction: claim.nextAction,
      }),
    );
  }
  return { observations, beliefs, needs };
}

function buildPerceptionPlan(input: {
  snapshotId: string;
  now: string;
  requestText?: string | null;
  channel: CognitiveExecutiveChannel | 'operator' | 'internal';
  needs: RealityVerificationNeed[];
  proofReport: LiveProofGauntletReport;
}): {
  plan: ActivePerceptionPlan;
  probes: ActivePerceptionProbe[];
  closureSteps: ProofClosureStep[];
} {
  const probes: ActivePerceptionProbe[] = [];
  const closureSteps: ProofClosureStep[] = [];
  const requestSummary = input.requestText
    ? `Request shape: ${safeText(input.requestText, 220)}`
    : 'Operator reality snapshot request.';
  for (const need of input.needs.slice(0, 12)) {
    const safeToRun =
      need.status === 'runnable_read_only' &&
      /debug|status|reliability|proof|world|truth|logic|bluebubbles/i.test(
        `${need.possibleSourceTool} ${need.nextAction}`,
      );
    probes.push({
      probeId: hashId('perception:probe', `${input.snapshotId}|${need.needId}`),
      planId: hashId(
        'perception:plan',
        `${input.snapshotId}|${requestSummary}`,
      ),
      createdAt: input.now,
      probeKind: /bluebubbles/i.test(need.question)
        ? 'bluebubbles_health_read'
        : /telegram/i.test(need.question)
          ? 'telegram_health_read'
          : /calendar/i.test(need.question)
            ? 'calendar_readiness_read'
            : /repair/i.test(need.question)
              ? 'repair_state_read'
              : /reliability|tool/i.test(need.possibleSourceTool)
                ? 'tool_reliability_read'
                : 'proof_status_read',
      target: need.question,
      safeToRunAutomatically: safeToRun,
      status: safeToRun
        ? 'planned'
        : need.status === 'manual_proof'
          ? 'manual_required'
          : 'skipped',
      command: safeToRun ? commandForNeed(need) : '',
      reason: need.reason,
      cooldownUntil: null,
      evidenceIdsJson: need.evidenceIdsJson,
      resultSummary: 'Not run by planner; this is a request-coupled plan.',
      nextAction: need.nextAction,
      privacyJson: privacyJson(),
    });
  }
  for (const entry of input.proofReport.entries) {
    if (entry.status === 'live_proven') continue;
    closureSteps.push({
      stepId: hashId('proof:closure', `${input.snapshotId}|${entry.proofId}`),
      planId: hashId(
        'perception:plan',
        `${input.snapshotId}|${requestSummary}`,
      ),
      proofId: entry.proofId,
      createdAt: input.now,
      proofName: entry.proofName,
      status: closureStatusForProof(entry),
      blockerClass: entry.status,
      exactNextStep: entry.nextStep,
      requestedAt: input.now,
      evidenceIdsJson: entry.evidenceIdsJson,
      privacyJson: privacyJson(),
    });
  }
  const planId = hashId(
    'perception:plan',
    `${input.snapshotId}|${requestSummary}`,
  );
  const manual = closureSteps.filter((step) => step.status !== 'complete');
  const plan: ActivePerceptionPlan = {
    planId,
    snapshotId: input.snapshotId,
    createdAt: input.now,
    requestSummary: safeText(requestSummary, 900),
    channel: input.channel,
    status:
      manual.length > 0
        ? 'manual_proof_required'
        : probes.some((probe) => probe.status === 'planned')
          ? 'planned'
          : 'not_needed',
    riskSummary:
      manual.length > 0
        ? 'Some reality gaps require manual proof or config before high-confidence claims.'
        : 'Only read-only verification is needed.',
    probeIdsJson: idJson(probes.map((probe) => probe.probeId)),
    skippedProbeIdsJson: idJson(
      probes
        .filter((probe) => probe.status === 'skipped')
        .map((probe) => probe.probeId),
    ),
    manualStepIdsJson: idJson(manual.map((step) => step.stepId)),
    nextAction:
      manual[0]?.exactNextStep ||
      probes[0]?.nextAction ||
      'No reality probe needed.',
    privacyJson: privacyJson(),
  };
  return { plan, probes, closureSteps };
}

function commandForNeed(need: RealityVerificationNeed): string {
  const text = `${need.question} ${need.nextAction}`.toLowerCase();
  if (text.includes('bluebubbles'))
    return 'npm run debug:bluebubbles -- --live';
  if (text.includes('telegram')) return 'npm run telegram:user:smoke';
  if (text.includes('calendar')) return 'npm run debug:google-calendar';
  if (text.includes('truth')) return 'npm run debug:truth -- --json';
  if (text.includes('logic'))
    return 'npm run debug:logic -- --reconcile --json';
  if (text.includes('integration'))
    return 'npm run integrations:status -- --json';
  return 'npm run debug:proof-gauntlet';
}

function persistReport(report: RealityDoctorReport): void {
  if (!isDatabaseInitialized()) return;
  upsertRealitySnapshot(report.snapshot);
  for (const observation of report.observations) {
    upsertRealityObservation(observation);
  }
  for (const belief of report.beliefs) {
    upsertRealityBelief(belief);
  }
  for (const need of report.verificationNeeds) {
    upsertRealityVerificationNeed(need);
  }
  for (const contradiction of report.contradictions) {
    upsertRealityContradiction(contradiction);
  }
  upsertActivePerceptionPlan(report.perceptionPlan);
  for (const probe of report.perceptionProbes) {
    upsertActivePerceptionProbe(probe);
  }
  for (const step of report.proofClosureSteps) {
    upsertProofClosureStep(step);
  }
}

export function buildRealityGroundingReport(
  input: BuildRealityGroundingInput = {},
): RealityDoctorReport {
  const generatedAt = input.generatedAt || nowIso();
  const proofReport = input.proofReport || buildLiveProofGauntletReport();
  const reliabilityReport =
    input.reliabilityReport || buildToolReliabilityDoctorReport();
  const providerHealthSnapshots =
    input.providerHealthSnapshots ||
    collectProviderHealthSnapshots(generatedAt);
  const worldInput: BuildWorldModelInput = {
    generatedAt,
    persist: false,
  };
  const worldReport = input.worldReport || buildWorldModelReport(worldInput);
  const improvementReport =
    input.improvementReport ||
    buildAutonomousImprovementLabReport({ persist: false });
  const snapshotId = hashId(
    'reality:snapshot',
    `${generatedAt}|${proofReport.liveProvenCount}|${proofReport.proofDebtCount}|${reliabilityReport.topDegraded.length}`,
  );
  const proofRecords = buildProofRecords({
    snapshotId,
    now: generatedAt,
    proofReport,
  });
  const reliabilityRecords = buildReliabilityRecords({
    snapshotId,
    now: generatedAt,
    reliabilityReport,
    providerHealthSnapshots,
  });
  const worldRecords = buildWorldRecords({
    snapshotId,
    now: generatedAt,
    worldReport,
  });
  const improvementObs = improvementReport.externalBlockers
    .slice(0, 12)
    .map((hypothesis) =>
      observation({
        snapshotId,
        now: generatedAt,
        source: 'improvement-lab',
        sourceType: 'improvement_lab',
        subject: hypothesis.affectedCapability,
        thing: 'external_blocker',
        value: `${hypothesis.fixClass}; ${hypothesis.nextAction}`,
        confidence: hypothesis.confidence,
        evidenceRef: hypothesis.hypothesisId,
        freshnessWindowHours: 24,
      }),
    );
  const observations = [
    ...proofRecords.observations,
    ...reliabilityRecords.observations,
    ...worldRecords.observations,
    ...improvementObs,
  ];
  const beliefs = [
    ...proofRecords.beliefs,
    ...reliabilityRecords.beliefs,
    ...worldRecords.beliefs,
  ];
  const verificationNeeds = [
    ...proofRecords.needs,
    ...reliabilityRecords.needs,
    ...worldRecords.needs,
  ];
  const contradictions = [
    ...proofRecords.contradictions,
    ...reliabilityRecords.contradictions,
  ];
  const { plan, probes, closureSteps } = buildPerceptionPlan({
    snapshotId,
    now: generatedAt,
    requestText: input.requestText,
    channel: input.channel || 'operator',
    needs: verificationNeeds,
    proofReport,
  });
  const confirmed = beliefs.filter((belief) => belief.status === 'confirmed');
  const blocked = beliefs.filter(
    (belief) => belief.status === 'externally_blocked',
  );
  const stale = beliefs.filter((belief) => belief.status === 'stale');
  const confidence =
    beliefs.length === 0
      ? 0
      : clamp01(
          beliefs.reduce((sum, belief) => sum + belief.confidence, 0) /
            beliefs.length -
            contradictions.length * 0.08 -
            blocked.length * 0.03,
        );
  const snapshot: RealitySnapshot = {
    snapshotId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status:
      contradictions.length > 0
        ? 'conflicted'
        : blocked.length > 0
          ? 'externally_blocked'
          : verificationNeeds.length > 0
            ? 'needs_verification'
            : 'grounded',
    confidence,
    observationIdsJson: idJson(observations.map((item) => item.observationId)),
    beliefIdsJson: idJson(beliefs.map((item) => item.beliefId)),
    contradictionIdsJson: idJson(
      contradictions.map((item) => item.contradictionId),
    ),
    verificationNeedIdsJson: idJson(
      verificationNeeds.map((item) => item.needId),
    ),
    recommendedProbeIdsJson: idJson(probes.map((item) => item.probeId)),
    trueNowSummary: confirmed.length
      ? confirmed
          .slice(0, 5)
          .map((belief) => belief.beliefSummary)
          .join(' ')
      : 'No high-confidence current beliefs are recorded yet.',
    staleSummary: stale.length
      ? stale
          .slice(0, 5)
          .map((belief) => belief.beliefSummary)
          .join(' ')
      : 'No stale beliefs are currently dominant.',
    contradictionSummary: contradictions.length
      ? contradictions
          .slice(0, 5)
          .map((item) => item.summary)
          .join(' ')
      : 'No open contradictions detected.',
    missingProofSummary: proofReport.proofDebtCount
      ? `${proofReport.proofDebtCount} proof item(s) need closure; repo work required=${proofReport.repoWorkRequiredCount}.`
      : 'All tracked proof surfaces are live-proven.',
    degradedToolsSummary: reliabilityRecords.beliefs.filter(
      (belief) =>
        (belief.beliefType === 'tool_health' ||
          belief.beliefType === 'route_confidence') &&
        belief.status !== 'confirmed',
    ).length
      ? reliabilityRecords.beliefs
          .filter(
            (belief) =>
              (belief.beliefType === 'tool_health' ||
                belief.beliefType === 'route_confidence') &&
              belief.status !== 'confirmed',
          )
          .slice(0, 5)
          .map((belief) => `${belief.subject}:${belief.status}`)
          .join(', ')
      : 'No degraded tools reported.',
    confidenceSummary: `Reality confidence ${confidence.toFixed(2)} from ${observations.length} observation(s), ${beliefs.length} belief(s), ${verificationNeeds.length} verification need(s), and ${contradictions.length} contradiction(s).`,
    nextAction: plan.nextAction,
    privacyJson: privacyJson(),
  };
  const report: RealityDoctorReport = {
    generatedAt,
    ok: true,
    snapshot,
    observations,
    beliefs,
    contradictions,
    verificationNeeds,
    perceptionPlan: plan,
    perceptionProbes: probes,
    proofClosureSteps: closureSteps,
    proofDebt: {
      total: proofReport.proofDebtCount,
      missingConfig: proofReport.entries.filter(
        (entry) => entry.status === 'missing_config',
      ).length,
      manualProof: proofReport.entries.filter(
        (entry) =>
          entry.status === 'near_live_only' || entry.status === 'stale',
      ).length,
      externallyBlocked: proofReport.entries.filter(
        (entry) => entry.status === 'externally_blocked',
      ).length,
      repoWorkRequired: proofReport.repoWorkRequiredCount,
    },
    nextAction: plan.nextAction,
    privacy: PRIVACY,
  };
  if (input.persist !== false) persistReport(report);
  return report;
}

export function formatRealityGroundingReport(
  report: RealityDoctorReport,
): string {
  const topBeliefs = report.beliefs
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
  const needs = report.verificationNeeds.slice(0, 8);
  const lines = [
    '*Reality Grounding*',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.snapshot.status}`,
    `Confidence: ${report.snapshot.confidence.toFixed(2)}`,
    `Observations: ${report.observations.length}`,
    `Beliefs: ${report.beliefs.length}`,
    `Contradictions: ${report.contradictions.length}`,
    `Verification needs: ${report.verificationNeeds.length}`,
    `Proof debt: total=${report.proofDebt.total}, missing_config=${report.proofDebt.missingConfig}, manual=${report.proofDebt.manualProof}, external=${report.proofDebt.externallyBlocked}, repo_work=${report.proofDebt.repoWorkRequired}`,
    '',
    '*True Right Now*',
    report.snapshot.trueNowSummary,
    '',
    '*Stale / Missing / Blocked*',
    report.snapshot.missingProofSummary,
    report.snapshot.degradedToolsSummary,
    '',
    '*Top Beliefs*',
    ...(topBeliefs.length
      ? topBeliefs.map(
          (belief) =>
            `- ${belief.subject}: ${belief.status} (${belief.confidence.toFixed(2)}) ${belief.beliefSummary}`,
        )
      : ['- none']),
    '',
    '*Contradictions*',
    ...(report.contradictions.length
      ? report.contradictions
          .slice(0, 5)
          .map((item) => `- ${item.severity}: ${item.summary}`)
      : ['- none']),
    '',
    '*Verification Needs*',
    ...(needs.length
      ? needs.map(
          (need) => `- ${need.status}: ${need.question} -> ${need.nextAction}`,
        )
      : ['- none']),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; no raw private bodies, prompts, hidden reasoning, raw tool output, provider debates, or secrets.',
  ];
  return redactLines(lines, 9000);
}

export function formatActivePerceptionReport(
  report: RealityDoctorReport,
): string {
  return redactLines(
    [
      '*Active Perception*',
      `Plan: ${report.perceptionPlan.status}`,
      `Risk: ${report.perceptionPlan.riskSummary}`,
      '',
      '*Planned Probes*',
      ...(report.perceptionProbes.length
        ? report.perceptionProbes.map(
            (probe) =>
              `- ${probe.probeKind}: ${probe.status}; safe=${probe.safeToRunAutomatically ? 'yes' : 'no'}; ${probe.nextAction}`,
          )
        : ['- none']),
      '',
      '*Manual Proof Steps*',
      ...(report.proofClosureSteps.length
        ? report.proofClosureSteps.map(
            (step) =>
              `- ${step.proofName}: ${step.status}; ${step.exactNextStep}`,
          )
        : ['- none']),
      '',
      `Next: ${report.perceptionPlan.nextAction}`,
      'Privacy: request-coupled only; no uncontrolled polling.',
    ],
    7000,
  );
}

export function formatProofGuidedReport(report: RealityDoctorReport): string {
  const proofReport = buildLiveProofGauntletReport();
  return redactLines(
    [
      formatLiveProofGauntletReport(proofReport),
      '',
      '*Guided Proof Closure*',
      ...(report.proofClosureSteps.length
        ? report.proofClosureSteps.map(
            (step, index) =>
              `${index + 1}. ${step.proofName}: ${step.status}\n   Next: ${step.exactNextStep}`,
          )
        : ['All tracked proof surfaces are currently closed.']),
      '',
      'Do not paste secrets into logs. Set missing config through the local .env/keychain path and rerun the named proof command.',
    ],
    9000,
  );
}

export function buildRealityStatusText(): string {
  return formatRealityGroundingReport(buildRealityGroundingReport());
}

export function isRealityNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "what's true right now?" ||
    normalized === "what's true right now" ||
    normalized === 'what is true right now?' ||
    normalized === 'what is true right now' ||
    normalized === "what's broken right now?" ||
    normalized === "what's broken right now" ||
    normalized === 'what is broken right now?' ||
    normalized === 'what is broken right now' ||
    normalized === 'is text messaging working?' ||
    normalized === 'is text messaging working' ||
    normalized === 'what should you verify next?' ||
    normalized === 'what should you verify next'
  );
}

export function formatRealityNaturalResponse(text: string): string {
  const report = buildRealityGroundingReport({
    requestText: text,
    channel: 'telegram',
  });
  const normalized = text.trim().toLowerCase();
  if (/text messaging|messages|bluebubbles/.test(normalized)) {
    const blue = report.beliefs.find((belief) =>
      /bluebubbles/i.test(belief.subject),
    );
    const contradiction = report.contradictions.find((item) =>
      /bluebubbles/i.test(item.subject),
    );
    if (blue) {
      return redactLines(
        [
          `Messages are ${blue.status === 'confirmed' ? 'live-proven' : 'partly ready, not fully proven'}.`,
          blue.beliefSummary,
          contradiction
            ? `Caution: ${contradiction.summary}`
            : 'No Messages contradiction is currently visible.',
          `Next: ${blue.nextAction}`,
        ],
        2000,
      );
    }
  }
  return redactLines(
    [
      `Right now: ${report.snapshot.trueNowSummary}`,
      `Still uncertain: ${report.snapshot.missingProofSummary}`,
      report.contradictions.length
        ? `Caution: ${report.contradictions[0].summary}`
        : 'No open contradiction is currently dominant.',
      `Next: ${report.nextAction}`,
    ],
    2200,
  );
}

export function evaluateGoalDirectedRealityCheck(input: {
  actionKind: GoalDirectedRealityCheck['actionKind'];
  requestText: string;
  report?: RealityDoctorReport;
}): GoalDirectedRealityCheck {
  const report =
    input.report ||
    buildRealityGroundingReport({
      requestText: input.requestText,
      persist: false,
    });
  const text = input.requestText.toLowerCase();
  const evidenceIds = report.verificationNeeds.map((need) => need.needId);
  if (input.actionKind === 'calendar_write') {
    const missingTime = !/\b(\d{1,2}(:\d{2})?\s?(am|pm)|noon|midnight)\b/i.test(
      input.requestText,
    );
    const calendar = report.beliefs.find((belief) =>
      /calendar/i.test(belief.subject),
    );
    if (missingTime) {
      return {
        actionKind: input.actionKind,
        allowed: false,
        decision: 'ask_clarification',
        confidence: 0.86,
        reason:
          'Calendar write is possible only after the event time is clear.',
        nextAction: 'Ask for the start time before creating the event.',
        evidenceIdsJson: idJson(evidenceIds),
      };
    }
    if (calendar && calendar.status !== 'confirmed') {
      return {
        actionKind: input.actionKind,
        allowed: false,
        decision: 'block_until_verified',
        confidence: calendar.confidence,
        reason: 'Calendar proof is not strong enough for a durable write.',
        nextAction: calendar.nextAction,
        evidenceIdsJson: idJson(evidenceIds),
      };
    }
  }
  if (input.actionKind === 'message_action') {
    const blue = report.beliefs.find((belief) =>
      /bluebubbles/i.test(belief.subject),
    );
    const approved = /\b(send it|yes send|approved|send it later)\b/i.test(
      text,
    );
    if (!blue || blue.status !== 'confirmed') {
      return {
        actionKind: input.actionKind,
        allowed: false,
        decision: 'offer_safe_alternative',
        confidence: blue?.confidence || 0.42,
        reason:
          'Message bridge proof is not strong enough to trust an external send.',
        nextAction:
          'Draft, save, or remind instead; complete same-thread proof before trusting sends.',
        evidenceIdsJson: idJson(evidenceIds),
      };
    }
    if (!approved) {
      return {
        actionKind: input.actionKind,
        allowed: false,
        decision: 'stage_approval',
        confidence: 0.9,
        reason: 'External sends require explicit same-thread approval.',
        nextAction: 'Ask for approval before sending.',
        evidenceIdsJson: idJson(evidenceIds),
      };
    }
  }
  if (input.actionKind === 'repair') {
    const failureVisible = /\b(failed|broken|unreachable|blocked|down)\b/i.test(
      text,
    );
    if (!failureVisible) {
      return {
        actionKind: input.actionKind,
        allowed: false,
        decision: 'block_until_verified',
        confidence: 0.78,
        reason: 'No observed failure is present, so repair should not run.',
        nextAction: 'Run a read-only status check first.',
        evidenceIdsJson: idJson(evidenceIds),
      };
    }
  }
  return {
    actionKind: input.actionKind,
    allowed: true,
    decision: 'proceed_read_only',
    confidence: report.snapshot.confidence,
    reason: 'Reality check found no blocking uncertainty for the safe path.',
    nextAction: report.nextAction,
    evidenceIdsJson: idJson(evidenceIds),
  };
}

export function evaluateUserCorrectionAgainstReality(input: {
  subject: string;
  previousSummary: string;
  correctionText: string;
}): {
  subject: string;
  status: 'contradicted';
  confidence: number;
  summary: string;
  nextAction: string;
} {
  return {
    subject: safeText(input.subject, 240),
    status: 'contradicted',
    confidence: 0.9,
    summary: safeText(
      `User correction conflicts with prior belief "${input.previousSummary}". New correction shape: ${input.correctionText}.`,
      700,
    ),
    nextAction:
      'Downgrade the old belief, keep it historical, and ask before promoting a new durable preference.',
  };
}
