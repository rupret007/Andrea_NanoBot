import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import { assessCognitiveSkillPromotion } from './cognitive-kernel.js';
import { reviewAgentAction } from './critic-agent.js';
import {
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

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
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
}): SkillPlaybookMatch | null {
  if (!isDatabaseInitialized()) return null;
  const text = params.text.toLowerCase();
  const playbooks = listSkillPlaybooks({
    groupFolder: params.groupFolder,
    statuses: params.includeSuggested ? ['active', 'suggested'] : ['active'],
    taskFamily: params.taskFamily,
    limit: 100,
  });
  const rollups = listToolReliabilityRollups({ limit: 100 });
  let best: SkillPlaybookMatch | null = null;
  for (const skill of playbooks) {
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
    const expectedTools = parseJsonStringArray(skill.expectedToolsJson);
    const toolReliability = rollups.filter((rollup) =>
      expectedTools.some((tool) => rollup.subjectId.includes(tool)),
    );
    const approvalRequired =
      /approval|required|send|calendar write|delete|commit|push/i.test(
        skill.approvalRequirementsJson + skill.allowedActionsJson,
      );
    const candidate: SkillPlaybookMatch = {
      skill,
      confidence,
      reasons: [
        hits ? `${hits} trigger tokens matched` : 'semantic trigger matched',
        skill.status === 'suggested'
          ? 'suggested skill preview'
          : 'active skill',
      ],
      requiredContextReady: true,
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
  now?: Date;
  persist?: boolean;
}): SkillPlaybookRunnerResult {
  const now = nowIso(params.now);
  const matched = matchSkillPlaybook({
    text: params.text,
    groupFolder: params.groupFolder,
    taskFamily: params.taskFamily,
    includeSuggested: true,
  });
  if (!matched) {
    return {
      matched: null,
      run: null,
      action: 'no_match',
      replyText: 'No learned skill matched this request yet.',
    };
  }
  const critic = reviewAgentAction({
    actor: 'skill_playbook_runner',
    action: `${matched.skill.title}; allowed=${matched.skill.allowedActionsJson}`,
    channel: params.channel,
    evidenceIds: [matched.skill.skillId],
    allowReadOnly: true,
    persist: params.persist,
    now: params.now,
  });
  const outcome: SkillPlaybookRunRecord['outcome'] =
    critic.decision === 'block'
      ? 'blocked'
      : critic.approvalRequired
        ? 'approval_staged'
        : matched.skill.status === 'suggested'
          ? 'proposed'
          : 'executed_safe_step';
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
    approvalRequired: critic.approvalRequired,
    outcome,
    summary: safeText(
      outcome === 'proposed'
        ? `Previewed suggested skill ${matched.skill.title}.`
        : `Matched skill ${matched.skill.title}; critic=${critic.decision}.`,
    ),
    nextAction:
      outcome === 'approval_staged'
        ? 'Ask for explicit approval before any side effect.'
        : matched.skill.nextAction,
    privacyJson: privacyJson(),
  };
  if (params.persist !== false && isDatabaseInitialized()) {
    upsertSkillPlaybookRun(run);
    upsertSkillPlaybook({
      ...matched.skill,
      updatedAt: now,
      usageCount: matched.skill.usageCount + 1,
      lastOutcome: outcome,
      reliabilityScore:
        outcome === 'blocked'
          ? Math.max(0.1, matched.skill.reliabilityScore - 0.1)
          : Math.min(0.99, matched.skill.reliabilityScore + 0.03),
    });
  }
  const action: SkillPlaybookRunnerResult['action'] =
    outcome === 'blocked'
      ? 'blocked'
      : outcome === 'approval_staged'
        ? 'approval_staged'
        : outcome === 'proposed'
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
            ? `I matched ${matched.skill.title}, but the critic blocked it: ${critic.nextAction}`
            : `I matched ${matched.skill.title} and can use its safe read-only steps.`,
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
