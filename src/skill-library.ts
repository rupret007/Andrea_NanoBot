import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import { assessCognitiveSkillPromotion } from './cognitive-kernel.js';
import { reviewAgentAction } from './critic-agent.js';
import {
  getCapabilityAcquisitionByCompiledSkillId,
  isDatabaseInitialized,
  listCognitiveSkillCards,
  listLearningDistillations,
  listSkillPlaybookRuns,
  listSkillPlaybooks,
  listToolReliabilityRollups,
  upsertSkillPlaybook,
  upsertSkillPlaybookRun,
} from './db.js';
import type {
  CognitiveExecutiveChannel,
  CognitiveSkillCardRecord,
  LearningDistillationRecord,
  SkillPlaybookRecord,
  SkillPlaybookRunRecord,
  ToolReliabilityRollup,
} from './types.js';

export interface SkillLibraryReport {
  generatedAt: string;
  playbooks: SkillPlaybookRecord[];
  active: SkillPlaybookRecord[];
  suggested: SkillPlaybookRecord[];
  paused: SkillPlaybookRecord[];
  retired: SkillPlaybookRecord[];
  recentRuns: SkillPlaybookRunRecord[];
  nextAction: string;
  privacy: {
    metadataOnly: true;
    rawTranscriptsStored: false;
    rawPromptsStored: false;
    hiddenReasoningStored: false;
    secretsRedacted: true;
  };
}

export interface SkillPlaybookMatch {
  skill: SkillPlaybookRecord;
  confidence: number;
  reasons: string[];
  requiredContextReady: boolean;
  approvalRequired: boolean;
  toolReliability: ToolReliabilityRollup[];
}

export interface SkillPlaybookRunnerResult {
  matched: SkillPlaybookMatch | null;
  run: SkillPlaybookRunRecord | null;
  action:
    | 'no_match'
    | 'preview_suggested_skill'
    | 'safe_step_ready'
    | 'approval_staged'
    | 'blocked';
  replyText: string;
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
  if (SECRET_RE.test(text)) return '[redacted skill metadata]';
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

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

interface ParsedStringList {
  ok: boolean;
  values: string[];
  reason?: string;
}

function parseJsonStringArray(
  value: string | null | undefined,
  fieldName: string,
): ParsedStringList {
  if (!value) {
    return { ok: false, values: [], reason: `${fieldName} is missing` };
  }
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (item) => typeof item !== 'string' || item.trim().length === 0,
      )
    ) {
      return {
        ok: false,
        values: [],
        reason: `${fieldName} must be a JSON array of strings`,
      };
    }
    return {
      ok: true,
      values: parsed.map((item) => item.trim()),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, values: [], reason: `${fieldName} is malformed JSON` };
  }
}

function parseRequiredContext(
  value: string | null | undefined,
): ParsedStringList {
  if (!value) {
    return {
      ok: false,
      values: [],
      reason: 'required context is missing',
    };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    const requirements = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { required?: unknown }).required)
        ? (parsed as { required: unknown[] }).required
        : null;
    if (
      !requirements ||
      requirements.some(
        (item) => typeof item !== 'string' || item.trim().length === 0,
      )
    ) {
      return {
        ok: false,
        values: [],
        reason:
          'required context must be a string array or an evidence contract with a string-array required field',
      };
    }
    return {
      ok: true,
      values: requirements.map((item) => item.trim()),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      ok: false,
      values: [],
      reason: 'required context is malformed JSON',
    };
  }
}

function isValidJsonObjectOrArray(
  value: string | null | undefined,
  fieldName: string,
): { ok: boolean; value: unknown; reason?: string } {
  if (!value) {
    return { ok: false, value: null, reason: `${fieldName} is missing` };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        value: null,
        reason: `${fieldName} must be a JSON object or array`,
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      ok: false,
      value: null,
      reason: `${fieldName} is malformed JSON`,
    };
  }
}

function normalizeRequirement(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function requirementIsAvailable(
  requirement: string,
  availableContext: Set<string>,
): boolean {
  const normalized = normalizeRequirement(requirement);
  if (!normalized) return false;
  return availableContext.has(normalized);
}

function rollupMatchesTool(
  rollup: ToolReliabilityRollup,
  expectedTool: string,
): boolean {
  const subject = normalizeRequirement(rollup.subjectId);
  const expected = normalizeRequirement(expectedTool);
  if (!subject || !expected) return false;
  return (
    subject === expected ||
    subject.endsWith(` ${expected}`) ||
    subject.split(' ').includes(expected)
  );
}

function rollupIsAvailable(rollup: ToolReliabilityRollup, now: Date): boolean {
  if (
    rollup.currentHealth === 'blocked' ||
    rollup.currentHealth === 'unknown'
  ) {
    return false;
  }
  if (!rollup.cooldownUntil) return true;
  const cooldownUntil = Date.parse(rollup.cooldownUntil);
  return Number.isFinite(cooldownUntil) && cooldownUntil <= now.getTime();
}

function playbookFromDistillation(
  item: LearningDistillationRecord,
  now: string,
): SkillPlaybookRecord | null {
  if (item.outputKind !== 'skill') return null;
  const skillId = item.targetId?.startsWith('skill:')
    ? item.targetId
    : hashId('skill', item.summary);
  return {
    skillId,
    createdAt: item.createdAt,
    updatedAt: now,
    groupFolder: item.groupFolder || null,
    title: safeText(item.summary.replace(/^Suggested skill:\s*/i, ''), 160),
    triggerPattern: safeText(item.whySuggested, 520),
    taskFamily: /reply|message|bluebubbles/i.test(item.summary)
      ? 'communication'
      : /calendar|dinner|weekend|plan/i.test(item.summary)
        ? 'planning'
        : /save|later|reminder/i.test(item.summary)
          ? 'capture'
          : 'general',
    requiredContextJson: safeJson([
      'current request',
      'recent outcome evidence',
    ]),
    allowedActionsJson: safeJson([
      'read metadata',
      'draft response',
      'suggest reminder',
      'stage approval',
    ]),
    disallowedActionsJson: safeJson([
      'send without approval',
      'calendar write without confirmation',
      'delete or purchase',
      'commit or push',
      'restart services',
    ]),
    approvalRequirementsJson: safeJson({
      sideEffects: 'explicit approval required',
      sensitiveFacts: 'ask before durable confirmation',
    }),
    expectedToolsJson: safeJson(['cognitive_executive', 'tool_reliability']),
    fallbackPlan:
      'Ask one clarifying question or use the default existing handler.',
    successCriteriaJson: safeJson([
      'route matches user intent',
      'no side effect without approval',
      'outcome recorded',
    ]),
    evalScenariosJson: safeJson([
      'learning candidate replay',
      'approval boundary',
    ]),
    usageCount: 0,
    lastOutcome: null,
    reliabilityScore: item.status === 'confirmed' ? 0.7 : 0.45,
    status: item.status === 'confirmed' ? 'active' : 'suggested',
    sourceDistillationId: item.distillationId,
    nextAction:
      item.status === 'confirmed'
        ? 'Use this active skill when the trigger matches.'
        : 'Review this suggested skill before activation.',
    privacyJson: privacyJson(),
  };
}

function playbookFromCognitiveCard(
  card: CognitiveSkillCardRecord,
  now: string,
): SkillPlaybookRecord {
  const trustedPromotion =
    card.promotionState === 'promoted' &&
    assessCognitiveSkillPromotion(card, now).eligible;
  const status: SkillPlaybookRecord['status'] =
    card.promotionState === 'quarantined'
      ? 'paused'
      : card.promotionState === 'retired'
        ? 'retired'
        : trustedPromotion
          ? 'active'
          : 'suggested';
  return {
    skillId: `playbook:${card.skillId}`.replace(/[^A-Za-z0-9:_.-]/g, '_'),
    createdAt: card.createdAt,
    updatedAt: now,
    groupFolder: card.groupFolder || null,
    title: safeText(card.skillSummary, 180),
    triggerPattern: safeText(card.triggerSummary, 520),
    taskFamily: card.taskFamily,
    requiredContextJson: card.evidenceNeedsJson,
    allowedActionsJson: safeJson(['read metadata', 'draft', 'stage approval']),
    disallowedActionsJson: safeJson([
      'send without approval',
      'write calendar without confirmation',
      'operator mutation',
    ]),
    approvalRequirementsJson: card.approvalRulesJson,
    expectedToolsJson: card.requiredToolsJson,
    fallbackPlan: 'Fall back to the existing route if skill confidence is low.',
    successCriteriaJson: card.verificationChecklistJson,
    evalScenariosJson: safeJson(['cognitive skill replay']),
    usageCount: 0,
    lastOutcome: null,
    reliabilityScore: card.latestOutcomeScore,
    status,
    sourceDistillationId: null,
    nextAction:
      status === 'paused'
        ? 'Cognitive skill is quarantined after independent negative outcomes; review before reuse.'
        : status === 'retired'
          ? 'Cognitive skill is retired and cannot run.'
          : trustedPromotion
            ? 'Skill is active after reviewed outcomes and fresh deterministic replay passed.'
            : card.promotionState === 'promoted'
              ? 'Legacy promotion is preserved but inactive until reviewed outcomes and fresh replay pass.'
              : 'Keep reviewing before active use.',
    privacyJson: privacyJson(),
  };
}

export function syncSkillPlaybooksFromLearning(
  params: {
    groupFolder?: string | null;
    now?: Date;
  } = {},
): SkillPlaybookRecord[] {
  const now = nowIso(params.now);
  if (!isDatabaseInitialized()) return [];
  const records: SkillPlaybookRecord[] = [];
  for (const item of listLearningDistillations({
    groupFolder: params.groupFolder,
    outputKinds: ['skill'],
    limit: 100,
  })) {
    const playbook = playbookFromDistillation(item, now);
    if (playbook) {
      upsertSkillPlaybook(playbook);
      records.push(playbook);
    }
  }
  for (const card of listCognitiveSkillCards({
    groupFolder: params.groupFolder,
    limit: 100,
  })) {
    const playbook = playbookFromCognitiveCard(card, now);
    upsertSkillPlaybook(playbook);
    records.push(playbook);
  }
  return records;
}

export function buildSkillLibraryReport(
  params: {
    groupFolder?: string | null;
    now?: Date;
    refresh?: boolean;
  } = {},
): SkillLibraryReport {
  const generatedAt = nowIso(params.now);
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      playbooks: [],
      active: [],
      suggested: [],
      paused: [],
      retired: [],
      recentRuns: [],
      nextAction: 'Initialize the database before reading skill state.',
      privacy: PRIVACY,
    };
  }
  if (params.refresh !== false) {
    syncSkillPlaybooksFromLearning(params);
  }
  const playbooks = listSkillPlaybooks({
    groupFolder: params.groupFolder,
    limit: 100,
  });
  const recentRuns = listSkillPlaybookRuns({
    groupFolder: params.groupFolder,
    limit: 40,
  });
  return {
    generatedAt,
    playbooks,
    active: playbooks.filter((item) => item.status === 'active'),
    suggested: playbooks.filter((item) => item.status === 'suggested'),
    paused: playbooks.filter((item) => item.status === 'paused'),
    retired: playbooks.filter((item) => item.status === 'retired'),
    recentRuns,
    nextAction:
      playbooks.find((item) => item.status === 'suggested')?.nextAction ||
      'Keep using Andrea; new skills appear here after repeated successful patterns.',
    privacy: PRIVACY,
  };
}

export function matchSkillPlaybook(params: {
  text: string;
  groupFolder?: string | null;
  taskFamily?: string;
  includeSuggested?: boolean;
  availableContext?: string[];
  now?: Date;
}): SkillPlaybookMatch | null {
  if (!isDatabaseInitialized()) return null;
  const text = params.text.toLowerCase();
  const now = params.now || new Date();
  const playbooks = listSkillPlaybooks({
    groupFolder: params.groupFolder,
    statuses: params.includeSuggested ? ['active', 'suggested'] : ['active'],
    taskFamily: params.taskFamily,
    limit: 100,
  });
  const rollups = listToolReliabilityRollups({ limit: 100 });
  const reviewedDistillationIds = new Set(
    listLearningDistillations({
      groupFolder: params.groupFolder,
      statuses: ['confirmed'],
      outputKinds: ['skill'],
      limit: 100,
    })
      .filter((item) => {
        const evidence = parseJsonStringArray(
          item.evidenceRefsJson,
          'distillation evidence references',
        );
        return evidence.ok && evidence.values.length > 0;
      })
      .map((item) => item.distillationId),
  );
  let best: SkillPlaybookMatch | null = null;
  for (const skill of playbooks) {
    const acquisition = getCapabilityAcquisitionByCompiledSkillId(
      skill.skillId,
    );
    if (
      acquisition &&
      acquisition.state !== 'active' &&
      acquisition.state !== 'monitoring'
    ) {
      continue;
    }
    const triggerWords = [skill.title, skill.triggerPattern, skill.taskFamily]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
    const hits = triggerWords.filter((word) => text.includes(word)).length;
    const saveLaterHit =
      /save|later|remember|remind/.test(text) &&
      /save|later|reminder|capture/.test(
        `${skill.title} ${skill.triggerPattern} ${skill.taskFamily}`.toLowerCase(),
      );
    const replyHit =
      /say back|reply|respond|message/.test(text) &&
      /reply|message|communication/.test(
        `${skill.title} ${skill.triggerPattern} ${skill.taskFamily}`.toLowerCase(),
      );
    const confidence = Math.min(
      0.98,
      skill.reliabilityScore * 0.55 +
        Math.min(0.35, hits * 0.05) +
        (saveLaterHit || replyHit ? 0.28 : 0),
    );
    if (confidence < 0.35) continue;
    const requiredContext = parseRequiredContext(skill.requiredContextJson);
    const expectedTools = parseJsonStringArray(
      skill.expectedToolsJson,
      'expected tools',
    );
    const allowedActions = parseJsonStringArray(
      skill.allowedActionsJson,
      'allowed actions',
    );
    const disallowedActions = parseJsonStringArray(
      skill.disallowedActionsJson,
      'disallowed actions',
    );
    const approvalRequirements = isValidJsonObjectOrArray(
      skill.approvalRequirementsJson,
      'approval requirements',
    );
    const successCriteria = parseJsonStringArray(
      skill.successCriteriaJson,
      'success criteria',
    );
    const evalScenarios = parseJsonStringArray(
      skill.evalScenariosJson,
      'evaluation scenarios',
    );
    const availableContext = new Set(
      [
        ...(params.availableContext || []),
        params.text.trim() ? 'current request' : '',
        params.taskFamily ? 'task family' : '',
        skill.sourceDistillationId &&
        reviewedDistillationIds.has(skill.sourceDistillationId)
          ? 'recent outcome evidence'
          : '',
      ]
        .filter(Boolean)
        .map(normalizeRequirement),
    );
    const missingContext = requiredContext.ok
      ? requiredContext.values.filter(
          (requirement) =>
            !requirementIsAvailable(requirement, availableContext),
        )
      : [];
    const toolReliability = rollups.filter((rollup) =>
      expectedTools.values.some((tool) => rollupMatchesTool(rollup, tool)),
    );
    const unavailableTools = expectedTools.ok
      ? expectedTools.values.filter((tool) => {
          const matchingRollups = rollups.filter((rollup) =>
            rollupMatchesTool(rollup, tool),
          );
          return (
            matchingRollups.length === 0 ||
            !matchingRollups.some((rollup) => rollupIsAvailable(rollup, now))
          );
        })
      : [];
    const malformedReasons = [
      requiredContext.reason,
      expectedTools.reason,
      allowedActions.reason,
      disallowedActions.reason,
      approvalRequirements.reason,
      successCriteria.reason,
      evalScenarios.reason,
    ].filter((reason): reason is string => Boolean(reason));
    const metadataReady = malformedReasons.length === 0;
    const requiredContextReady =
      metadataReady &&
      missingContext.length === 0 &&
      unavailableTools.length === 0;
    const approvalRequired =
      !metadataReady ||
      /approval|required|send|calendar write|delete|commit|push/i.test(
        JSON.stringify(approvalRequirements.value) +
          JSON.stringify(allowedActions.values),
      );
    const candidate: SkillPlaybookMatch = {
      skill,
      confidence,
      reasons: [
        hits ? `${hits} trigger tokens matched` : 'semantic trigger matched',
        skill.status === 'suggested'
          ? 'suggested skill preview'
          : 'active skill',
        ...malformedReasons.map((reason) => `blocked: ${reason}`),
        ...missingContext.map(
          (requirement) => `blocked: missing context ${requirement}`,
        ),
        ...unavailableTools.map(
          (tool) => `blocked: required tool ${tool} is unavailable`,
        ),
        ...(toolReliability.some(
          (rollup) => rollup.currentHealth === 'degraded',
        )
          ? ['required tool health is degraded']
          : []),
      ],
      requiredContextReady,
      approvalRequired,
      toolReliability,
    };
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}

export function runSkillPlaybook(params: {
  text: string;
  channel: CognitiveExecutiveChannel;
  groupFolder?: string | null;
  taskFamily?: string;
  availableContext?: string[];
  now?: Date;
  persist?: boolean;
}): SkillPlaybookRunnerResult {
  const now = nowIso(params.now);
  const matched = matchSkillPlaybook({
    text: params.text,
    groupFolder: params.groupFolder,
    taskFamily: params.taskFamily,
    includeSuggested: true,
    availableContext: params.availableContext,
    now: params.now,
  });
  if (!matched) {
    return {
      matched: null,
      run: null,
      action: 'no_match',
      replyText: 'No learned skill matched this request yet.',
    };
  }
  const critic = matched.requiredContextReady
    ? reviewAgentAction({
        actor: 'skill_playbook_runner',
        action: `${matched.skill.title}; allowed=${matched.skill.allowedActionsJson}`,
        channel: params.channel,
        evidenceIds: [matched.skill.skillId],
        allowReadOnly: true,
        persist: params.persist,
        now: params.now,
      })
    : null;
  const outcome: SkillPlaybookRunRecord['outcome'] =
    !matched.requiredContextReady || critic?.decision === 'block'
      ? 'blocked'
      : critic?.approvalRequired
        ? 'approval_staged'
        : 'proposed';
  const run: SkillPlaybookRunRecord = {
    runId: hashId(
      'skillrun',
      `${matched.skill.skillId}|${params.channel}|${params.text}|${now}`,
    ),
    skillId: matched.skill.skillId,
    createdAt: now,
    groupFolder: params.groupFolder || null,
    requestSummary: safeText(params.text, 640),
    matched: true,
    contextReady: matched.requiredContextReady,
    toolReliabilityJson: safeJson(
      matched.toolReliability.map((item) => ({
        subjectId: item.subjectId,
        health: item.currentHealth,
        score: item.reliabilityScore,
      })),
    ),
    approvalRequired:
      matched.approvalRequired || Boolean(critic?.approvalRequired),
    outcome,
    summary: safeText(
      outcome === 'proposed'
        ? `Previewed matching skill ${matched.skill.title}; no step was executed.`
        : outcome === 'blocked' && !matched.requiredContextReady
          ? `Matched skill ${matched.skill.title}, but required context, metadata, or tool health is unavailable.`
          : `Matched skill ${matched.skill.title}; critic=${critic?.decision || 'not_run'}.`,
    ),
    nextAction:
      outcome === 'approval_staged'
        ? 'Ask for explicit approval before any side effect.'
        : outcome === 'blocked' && !matched.requiredContextReady
          ? matched.reasons.find((reason) => reason.startsWith('blocked:')) ||
            'Repair required context and tool health before reuse.'
          : matched.skill.nextAction,
    privacyJson: privacyJson(),
  };
  if (params.persist !== false && isDatabaseInitialized()) {
    upsertSkillPlaybookRun(run);
  }
  const action: SkillPlaybookRunnerResult['action'] =
    outcome === 'blocked'
      ? 'blocked'
      : outcome === 'approval_staged'
        ? 'approval_staged'
        : outcome === 'proposed' && matched.skill.status === 'suggested'
          ? 'preview_suggested_skill'
          : 'safe_step_ready';
  return {
    matched,
    run,
    action,
    replyText:
      action === 'preview_suggested_skill'
        ? `I found a suggested skill for this: ${matched.skill.title}. It needs review before I use it automatically.`
        : action === 'approval_staged'
          ? `I can use ${matched.skill.title}, but anything with side effects needs explicit approval first.`
          : action === 'blocked'
            ? `I matched ${matched.skill.title}, but it is not ready: ${
                !matched.requiredContextReady
                  ? matched.reasons.find((reason) =>
                      reason.startsWith('blocked:'),
                    ) || 'required evidence is unavailable'
                  : critic?.nextAction || 'the critic blocked this preview'
              }`
            : `I matched ${matched.skill.title}. Its safe read-only path is ready for a separately validated execution; this preview did not execute it.`,
  };
}

export function applySkillControl(params: {
  skillId: string;
  control: 'activate' | 'pause' | 'retire' | 'reset';
  groupFolder?: string | null;
  now?: Date;
}): { ok: boolean; message: string; skill?: SkillPlaybookRecord } {
  const skills = listSkillPlaybooks({
    groupFolder: params.groupFolder,
    limit: 200,
  });
  const skill = skills.find((item) => item.skillId === params.skillId);
  if (!skill) return { ok: false, message: 'No matching skill was found.' };
  const acquisition = getCapabilityAcquisitionByCompiledSkillId(skill.skillId);
  if (acquisition && params.control !== 'activate') {
    return {
      ok: false,
      message:
        'This skill is a projection of a canonical capability acquisition. Pause, retire, and reset controls are blocked here so the projection cannot diverge from canonical state.',
      skill,
    };
  }
  if (params.control === 'activate') {
    const canonicalActive =
      acquisition &&
      (acquisition.state === 'active' || acquisition.state === 'monitoring') &&
      (acquisition.groupFolder || null) === (skill.groupFolder || null);
    if (!canonicalActive) {
      return {
        ok: false,
        message:
          'Activation is blocked until the canonical acquisition has a verified live canary, exact owner review, and active or monitoring state.',
        skill,
      };
    }
  }
  const statusByControl: Record<
    typeof params.control,
    SkillPlaybookRecord['status']
  > = {
    activate: 'active',
    pause: 'paused',
    retire: 'retired',
    reset: 'suggested',
  };
  const updated: SkillPlaybookRecord = {
    ...skill,
    updatedAt: nowIso(params.now),
    status: statusByControl[params.control],
    nextAction:
      params.control === 'activate'
        ? 'Skill is active and will be considered when relevant.'
        : params.control === 'pause'
          ? 'Skill is paused and will not be used automatically.'
          : params.control === 'retire'
            ? 'Skill is retired.'
            : 'Skill is back in suggested review state.',
  };
  upsertSkillPlaybook(updated);
  return { ok: true, message: updated.nextAction, skill: updated };
}

export function formatSkillLibraryReport(
  report: SkillLibraryReport = buildSkillLibraryReport({ refresh: false }),
): string {
  return [
    '*Skill Library*',
    `Active: ${report.active.length}`,
    `Suggested: ${report.suggested.length}`,
    `Paused: ${report.paused.length}`,
    `Retired: ${report.retired.length}`,
    '',
    '*Review queue*',
    ...(report.suggested.length
      ? report.suggested
          .slice(0, 6)
          .map(
            (skill) =>
              `- ${skill.title} (${skill.taskFamily}, ${skill.reliabilityScore.toFixed(2)}): ${skill.nextAction}`,
          )
      : ['- none']),
    '',
    '*Recent runs*',
    ...(report.recentRuns.length
      ? report.recentRuns
          .slice(0, 5)
          .map((run) => `- ${run.skillId}: ${run.outcome}; ${run.nextAction}`)
      : ['- none']),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; skills are playbooks, not autonomous write permission.',
  ].join('\n');
}
