import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listCognitiveReflectionSignals,
  listLearningDistillations,
  listReliabilityObservations,
  listRepairAttempts,
  listWorldFacts,
  upsertLearningDistillation,
  upsertWorldFact,
  upsertWorldFactEvidenceLink,
} from './db.js';
import type {
  CognitiveReflectionSignal,
  LearningDistillationRecord,
  LearningDistillationStatus,
  ReliabilityObservation,
  RepairAttemptRecord,
  WorldFactRecord,
} from './types.js';

export interface LearningDistillationReport {
  generatedAt: string;
  candidates: LearningDistillationRecord[];
  worldFacts: WorldFactRecord[];
  pendingConfirmations: LearningDistillationRecord[];
  rejectedOrPaused: LearningDistillationRecord[];
  repeatedFriction: Array<{
    key: string;
    count: number;
    latestSummary: string;
  }>;
  nextAction: string;
  privacy: {
    metadataOnly: true;
    rawTranscriptsStored: false;
    rawPromptsStored: false;
    hiddenReasoningStored: false;
    secretsRedacted: true;
  };
}

export interface LearningControlResult {
  ok: boolean;
  control: 'confirm' | 'reject' | 'pause' | 'forget' | 'reset';
  targetId: string;
  message: string;
}

const PRIVACY = {
  metadataOnly: true,
  rawTranscriptsStored: false,
  rawPromptsStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
} as const;

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought/i;

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted learning metadata]';
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

function evidenceJson(ids: string[]): string {
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
    ).slice(0, 40),
  );
}

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

function distillationRecord(input: {
  groupFolder?: string | null;
  outputKind: LearningDistillationRecord['outputKind'];
  status: LearningDistillationRecord['status'];
  sensitivity: LearningDistillationRecord['sensitivity'];
  summary: string;
  whySuggested: string;
  evidenceIds: string[];
  targetId?: string | null;
  nextAction: string;
  now: string;
}): LearningDistillationRecord {
  const stable = [
    input.groupFolder || 'global',
    input.outputKind,
    input.summary,
    input.targetId || '',
  ].join('|');
  return {
    distillationId: hashId('learn', stable),
    createdAt: input.now,
    updatedAt: input.now,
    groupFolder: input.groupFolder || null,
    outputKind: input.outputKind,
    status: input.status,
    sensitivity: input.sensitivity,
    summary: safeText(input.summary),
    whySuggested: safeText(input.whySuggested),
    evidenceRefsJson: evidenceJson(input.evidenceIds),
    targetId: input.targetId || null,
    controlStateJson: safeJson({
      inspectable: true,
      editable: true,
      deleteable: true,
      requiresConfirmation: input.status === 'pending_confirmation',
    }),
    nextAction: safeText(input.nextAction),
    privacyJson: privacyJson(),
  };
}

function worldFactRecord(input: {
  groupFolder?: string | null;
  factType: WorldFactRecord['factType'];
  summary: string;
  confidence: number;
  evidenceIds: string[];
  sensitivity: WorldFactRecord['sensitivity'];
  status: WorldFactRecord['status'];
  sourceKind: string;
  nextAction: string;
  now: string;
}): WorldFactRecord {
  const stable = [
    input.groupFolder || 'global',
    input.factType,
    input.summary,
  ].join('|');
  return {
    factId: hashId('worldfact', stable),
    createdAt: input.now,
    updatedAt: input.now,
    groupFolder: input.groupFolder || null,
    factType: input.factType,
    summary: safeText(input.summary),
    confidence: Math.max(0, Math.min(1, input.confidence)),
    evidenceRefsJson: evidenceJson(input.evidenceIds),
    lastSeenAt: input.now,
    lastConfirmedAt: input.status === 'confirmed' ? input.now : null,
    sensitivity: input.sensitivity,
    autoSurfacePolicy:
      input.sensitivity === 'low' ? 'when_relevant' : 'ask_first',
    reviewAfterAt: null,
    expiresAt: null,
    status: input.status,
    sourceKind: safeText(input.sourceKind, 180),
    nextAction: safeText(input.nextAction),
    privacyJson: privacyJson(),
  };
}

function frictionGroups(
  signals: CognitiveReflectionSignal[],
): Map<string, CognitiveReflectionSignal[]> {
  const groups = new Map<string, CognitiveReflectionSignal[]>();
  for (const signal of signals) {
    const key =
      signal.frictionKey ||
      (signal.outcome === 'success'
        ? ''
        : `${signal.routeKey}:${signal.outcome}`);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), signal]);
  }
  return groups;
}

function maybeSaveLaterSkill(
  signals: CognitiveReflectionSignal[],
  groupFolder: string | null | undefined,
  now: string,
): LearningDistillationRecord | null {
  const saveSignals = signals.filter((signal) =>
    /save_for_later|save.*later|reminder/i.test(
      `${signal.routeKey} ${signal.summary} ${signal.nextAction}`,
    ),
  );
  if (saveSignals.length < 2) return null;
  return distillationRecord({
    groupFolder,
    outputKind: 'skill',
    status: 'suggested',
    sensitivity: 'low',
    summary:
      'Suggested skill: when the user says save that for later, preserve the item and offer a default follow-up time instead of re-asking every detail.',
    whySuggested: `${saveSignals.length} recent executive outcomes involved save-for-later or reminder follow-up patterns.`,
    evidenceIds: saveSignals.map((signal) => signal.signalId),
    targetId: 'skill:save_for_later.default_followup',
    nextAction: 'Review the suggested save-for-later skill before activation.',
    now,
  });
}

function frictionDistillations(
  signals: CognitiveReflectionSignal[],
  groupFolder: string | null | undefined,
  now: string,
): LearningDistillationRecord[] {
  const records: LearningDistillationRecord[] = [];
  for (const [key, items] of frictionGroups(signals)) {
    if (items.length < 2) continue;
    records.push(
      distillationRecord({
        groupFolder,
        outputKind: 'friction_issue',
        status: 'suggested',
        sensitivity: 'low',
        summary: `Repeated friction: ${key}.`,
        whySuggested: `${items.length} executive reflection signals share the same friction pattern.`,
        evidenceIds: items.map((item) => item.signalId),
        targetId: `friction:${key}`,
        nextAction:
          'Review this repeated friction pattern in debug:learning or outcome review.',
        now,
      }),
    );
  }
  return records;
}

function toolHealthFacts(
  observations: ReliabilityObservation[],
  repairs: RepairAttemptRecord[],
  groupFolder: string | null | undefined,
  now: string,
): WorldFactRecord[] {
  const blocked = observations.filter((item) =>
    ['blocked', 'degraded'].includes(item.outcome),
  );
  const records = blocked.slice(0, 6).map((item) =>
    worldFactRecord({
      groupFolder,
      factType: 'tool_health',
      summary: `${item.subjectId} is ${item.outcome}: ${item.failureClass}.`,
      confidence: item.outcome === 'blocked' ? 0.9 : 0.72,
      evidenceIds: [item.observationId],
      sensitivity: 'low',
      status: 'suggested',
      sourceKind: item.sourceKind,
      nextAction:
        item.nextAction || 'Use a fallback route until this tool recovers.',
      now,
    }),
  );
  for (const attempt of repairs.slice(0, 4)) {
    if (attempt.status === 'succeeded') continue;
    records.push(
      worldFactRecord({
        groupFolder,
        factType: 'friction_pattern',
        summary: `${attempt.integrationId} repair playbook ${attempt.playbookId} ended ${attempt.status}.`,
        confidence: 0.76,
        evidenceIds: [attempt.attemptId],
        sensitivity: 'low',
        status: 'suggested',
        sourceKind: 'repair_attempt',
        nextAction: attempt.nextAction,
        now,
      }),
    );
  }
  return records;
}

export function buildLearningDistillationReport(
  params: {
    groupFolder?: string | null;
    now?: Date;
    persist?: boolean;
  } = {},
): LearningDistillationReport {
  const generatedAt = nowIso(params.now);
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      candidates: [],
      worldFacts: [],
      pendingConfirmations: [],
      rejectedOrPaused: [],
      repeatedFriction: [],
      nextAction: 'Initialize the database before reading learning state.',
      privacy: PRIVACY,
    };
  }

  const signals = listCognitiveReflectionSignals({ limit: 250 });
  const observations = listReliabilityObservations({ limit: 250 });
  const repairs = listRepairAttempts({ limit: 80 });
  const candidates: LearningDistillationRecord[] = [
    ...frictionDistillations(signals, params.groupFolder, generatedAt),
  ];
  const saveLater = maybeSaveLaterSkill(
    signals,
    params.groupFolder,
    generatedAt,
  );
  if (saveLater) candidates.push(saveLater);

  for (const attempt of repairs.filter((item) => item.status !== 'succeeded')) {
    candidates.push(
      distillationRecord({
        groupFolder: params.groupFolder,
        outputKind: 'rule_adjustment',
        status: 'suggested',
        sensitivity: 'low',
        summary: `Repair learning candidate for ${attempt.integrationId} reported ${attempt.failureClass}.`,
        whySuggested:
          'A repair attempt produced a bounded outcome that can improve future recovery guidance.',
        evidenceIds: [attempt.attemptId],
        targetId: `repair:${attempt.integrationId}:${attempt.playbookId}`,
        nextAction: attempt.nextAction,
        now: generatedAt,
      }),
    );
  }

  const facts = toolHealthFacts(
    observations,
    repairs,
    params.groupFolder,
    generatedAt,
  );

  if (params.persist !== false) {
    for (const candidate of candidates) upsertLearningDistillation(candidate);
    for (const fact of facts) {
      upsertWorldFact(fact);
      for (const evidenceId of JSON.parse(fact.evidenceRefsJson) as string[]) {
        upsertWorldFactEvidenceLink({
          linkId: hashId('worldfact:evidence', `${fact.factId}|${evidenceId}`),
          factId: fact.factId,
          createdAt: generatedAt,
          evidenceSourceKind: fact.sourceKind,
          evidenceSourceId: evidenceId,
          confidenceDelta: 0.1,
          summary: `Evidence for ${fact.factType}: ${fact.summary}`,
          privacyJson: privacyJson(),
        });
      }
    }
  }

  const stored = listLearningDistillations({
    groupFolder: params.groupFolder,
    limit: 80,
  });
  const worldFacts = listWorldFacts({
    groupFolder: params.groupFolder,
    limit: 80,
  });
  const repeatedFriction = Array.from(frictionGroups(signals).entries())
    .filter(([, items]) => items.length >= 2)
    .map(([key, items]) => ({
      key,
      count: items.length,
      latestSummary: safeText(items[0]?.summary || ''),
    }));
  return {
    generatedAt,
    candidates: stored.filter((item) =>
      ['suggested', 'pending_confirmation', 'confirmed'].includes(item.status),
    ),
    worldFacts,
    pendingConfirmations: stored.filter(
      (item) => item.status === 'pending_confirmation',
    ),
    rejectedOrPaused: stored.filter((item) =>
      ['rejected', 'paused', 'forgotten'].includes(item.status),
    ),
    repeatedFriction,
    nextAction:
      stored.find((item) => item.status === 'pending_confirmation')
        ?.nextAction ||
      stored.find((item) => item.status === 'suggested')?.nextAction ||
      'Keep dogfooding; Andrea will suggest learned facts and skills after repeated metadata evidence.',
    privacy: PRIVACY,
  };
}

export function applyLearningControl(params: {
  targetId: string;
  control: LearningControlResult['control'];
  groupFolder?: string | null;
  now?: Date;
}): LearningControlResult {
  const now = nowIso(params.now);
  const all = listLearningDistillations({
    groupFolder: params.groupFolder,
    limit: 200,
  });
  const item =
    all.find((candidate) => candidate.distillationId === params.targetId) ||
    all.find((candidate) => candidate.targetId === params.targetId);
  if (!item) {
    return {
      ok: false,
      control: params.control,
      targetId: params.targetId,
      message: 'No matching learned candidate was found.',
    };
  }
  const statusByControl: Record<
    LearningControlResult['control'],
    LearningDistillationStatus
  > = {
    confirm: 'confirmed',
    reject: 'rejected',
    pause: 'paused',
    forget: 'forgotten',
    reset: 'suggested',
  };
  const updated: LearningDistillationRecord = {
    ...item,
    updatedAt: now,
    status: statusByControl[params.control],
    controlStateJson: safeJson({
      ...JSON.parse(item.controlStateJson || '{}'),
      lastControl: params.control,
      controlledAt: now,
    }),
    nextAction:
      params.control === 'confirm'
        ? 'Confirmed. Andrea can use this learning when relevant.'
        : params.control === 'forget'
          ? 'Forgotten. Andrea will not use this learning.'
          : params.control === 'pause'
            ? 'Paused. Andrea will not actively use this until resumed.'
            : params.control === 'reject'
              ? 'Rejected. Andrea will stop suggesting this pattern.'
              : 'Reset to suggested for review.',
  };
  upsertLearningDistillation(updated);
  return {
    ok: true,
    control: params.control,
    targetId: item.distillationId,
    message: updated.nextAction,
  };
}

export function formatLearningDistillationReport(
  report: LearningDistillationReport = buildLearningDistillationReport({
    persist: false,
  }),
): string {
  const confirmedFacts = report.worldFacts.filter(
    (fact) => fact.status === 'confirmed',
  );
  const suggestedFacts = report.worldFacts.filter((fact) =>
    ['suggested', 'pending_confirmation'].includes(fact.status),
  );
  return [
    '*Learning And Memory*',
    `Candidates: ${report.candidates.length}`,
    `Pending confirmations: ${report.pendingConfirmations.length}`,
    `Confirmed facts: ${confirmedFacts.length}`,
    `Suggested facts: ${suggestedFacts.length}`,
    '',
    '*Recent candidates*',
    ...(report.candidates.length
      ? report.candidates
          .slice(0, 6)
          .map(
            (item) =>
              `- ${item.outputKind}/${item.status}: ${item.summary} Next: ${item.nextAction}`,
          )
      : ['- none yet']),
    '',
    '*Repeated friction*',
    ...(report.repeatedFriction.length
      ? report.repeatedFriction
          .slice(0, 5)
          .map((item) => `- ${item.key}: ${item.count}x; ${item.latestSummary}`)
      : ['- none detected yet']),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; no raw transcripts, private bodies, hidden reasoning, raw tool output, or secrets are stored.',
  ].join('\n');
}
