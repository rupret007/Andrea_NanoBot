import crypto from 'crypto';

import {
  getProfileFact,
  getProfileFactByKey,
  getProfileSubjectByKey,
  getTasksForGroup,
  listCommunicationThreadsForGroup,
  listLifeThreadsForGroup,
  listOutcomesForGroup,
  listProfileFactsForGroup,
  updateProfileFactState,
  upsertProfileFact,
  upsertProfileSubject,
} from './db.js';
import {
  buildAgiLeapReadinessReport,
  formatAgiLeapReadinessReport,
} from './agi-leap-readiness.js';
import { exportRedactedOnboardingProfilePack } from './onboarding-profile-pack.js';
import type {
  CommunicationThreadRecord,
  LifeThread,
  OutcomeRecord,
  ProfileFact,
  ProfileFactWithSubject,
  ProfileSubject,
  ScheduledTask,
} from './types.js';

export interface MemoryActivationCommandInput {
  groupFolder: string;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  text: string;
  conversationSummary?: string;
  replyText?: string;
  factIdHint?: string;
  now?: Date;
}

export interface MemoryActivationCommandResult {
  handled: boolean;
  responseText?: string;
  referencedFactId?: string;
}

interface LearningCandidate {
  category: ProfileFact['category'];
  factKey: string;
  summary: string;
  value: Record<string, unknown>;
  sourceSummary: string;
  sensitivity: 'normal' | 'sensitive';
}

const SETUP_AREAS: Array<{
  id: string;
  label: string;
  nextQuestion: string;
}> = [
  {
    id: 'people',
    label: 'people',
    nextQuestion:
      'Who matters most for Andrea to understand first? Names, roles, or groups are enough.',
  },
  {
    id: 'tracking',
    label: 'what to track',
    nextQuestion:
      'What should Andrea keep track of day to day: texts, errands, bills, meals, work, family, health, or loose ends?',
  },
  {
    id: 'rhythm',
    label: 'daily rhythm',
    nextQuestion:
      'What rhythm should Andrea know about: morning checks, evening reset, weekly planning, school or work cadence?',
  },
  {
    id: 'style',
    label: 'communication style',
    nextQuestion:
      'How should Andrea talk to you: short, warm, detailed, blunt, playful, or something else?',
  },
  {
    id: 'integrations',
    label: 'channels and integrations',
    nextQuestion:
      'Which channels and tools matter first: Telegram, texts, calendar, reminders, email, Alexa, or something else?',
  },
  {
    id: 'privacy',
    label: 'privacy comfort',
    nextQuestion:
      'What should Andrea be careful about learning, surfacing, or sharing back to you?',
  },
  {
    id: 'outcomes',
    label: 'first outcomes',
    nextQuestion:
      'What are the first three outcomes you want Andrea to help with?',
  },
];

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function clip(value: string | null | undefined, max = 220): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function redactMemoryActivationText(value: string, max = 320): string {
  return clip(value, max)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
    .replace(/\bbb:[^\s"']+/gi, '[chat]')
    .replace(/\b(?:iMessage|SMS);[^\s"']+/gi, '[chat]')
    .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]');
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hashKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function ensureSelfSubject(
  groupFolder: string,
  nowIso: string,
): ProfileSubject {
  const existing = getProfileSubjectByKey(groupFolder, 'self', 'self');
  if (existing) return existing;
  const subject: ProfileSubject = {
    id: `profile:subject:${hashKey(`${groupFolder}:self`)}`,
    groupFolder,
    kind: 'self',
    canonicalName: 'self',
    displayName: 'You',
    createdAt: nowIso,
    updatedAt: nowIso,
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

function isSensitive(value: string): boolean {
  return /\b(health|medical|medicine|diagnosis|legal|private|sensitive|relationship|conflict|money|salary|password|secret)\b/i.test(
    value,
  );
}

function memoryValue(params: {
  value: unknown;
  confidence: number;
  freshness: 'candidate' | 'current';
  source: string;
  sensitivity?: 'normal' | 'sensitive';
  learnedAt: string;
}): Record<string, unknown> {
  return {
    value: params.value,
    memoryScope: 'user',
    confidence: params.confidence,
    freshness: params.freshness,
    source: params.source,
    sensitivity: params.sensitivity || 'normal',
    learnedAt: params.learnedAt,
  };
}

function describeFactValue(fact: ProfileFact | ProfileFactWithSubject): string {
  const parsed = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
  const value =
    parsed && typeof parsed === 'object' && 'value' in parsed
      ? (parsed as { value?: unknown }).value
      : parsed;
  if (typeof value === 'string') return redactMemoryActivationText(value);
  if (
    value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'followthrough_outcome_pattern'
  ) {
    const pattern = value as {
      handledCount?: unknown;
      deferredCount?: unknown;
      examples?: unknown;
    };
    const handled =
      typeof pattern.handledCount === 'number' ? pattern.handledCount : 0;
    const deferred =
      typeof pattern.deferredCount === 'number' ? pattern.deferredCount : 0;
    const examples = Array.isArray(pattern.examples)
      ? pattern.examples
          .filter((example): example is string => typeof example === 'string')
          .slice(0, 2)
      : [];
    return redactMemoryActivationText(
      [
        `Follow-through outcomes: ${handled} handled, ${deferred} deferred.`,
        examples.length ? `Examples: ${examples.join('; ')}` : null,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
  return redactMemoryActivationText(JSON.stringify(value));
}

function factMetadata(fact: ProfileFact | ProfileFactWithSubject): {
  confidence?: number;
  freshness?: string;
  source?: string;
  sensitivity?: string;
} {
  const parsed = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
  return {
    confidence:
      typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
    freshness:
      typeof parsed.freshness === 'string' ? parsed.freshness : undefined,
    source: typeof parsed.source === 'string' ? parsed.source : undefined,
    sensitivity:
      typeof parsed.sensitivity === 'string' ? parsed.sensitivity : undefined,
  };
}

function memorySourceLabel(
  source: string | undefined,
  factKey: string,
): string {
  const normalized = `${source || ''} ${factKey}`.toLowerCase();
  if (/guided_profile_setup|setup\./.test(normalized)) {
    return 'guided setup';
  }
  if (/follow[-_ ]?through|outcome/.test(normalized)) {
    return 'follow-through outcome review';
  }
  if (/daily_learning_review_edit/.test(normalized)) {
    return 'edited daily learning review';
  }
  if (/daily_learning_review|learning\./.test(normalized)) {
    return 'daily learning review';
  }
  if (
    /profile_pack|redacted onboarding profile pack|imported/.test(normalized)
  ) {
    return 'redacted profile pack import';
  }
  return 'saved memory';
}

function sortedLearningFacts(
  groupFolder: string,
  states: ProfileFact['state'][],
): ProfileFactWithSubject[] {
  return listProfileFactsForGroup(groupFolder, states)
    .filter(
      (fact) =>
        fact.factKey.startsWith('learning.') ||
        fact.factKey.startsWith('setup.'),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function pickFactForExplanation(input: MemoryActivationCommandInput) {
  if (input.factIdHint) {
    const hinted = getProfileFact(input.factIdHint);
    if (hinted && hinted.groupFolder === input.groupFolder) return hinted;
  }
  const query = normalizeText(input.text)
    .replace(/^why (?:do|did) you know (?:that|this)\??$/i, '')
    .replace(/^why do you know /i, '')
    .replace(/^what are you using to personalize this\??$/i, '')
    .trim()
    .toLowerCase();
  const accepted = listProfileFactsForGroup(input.groupFolder, ['accepted']);
  if (query) {
    const match = accepted.find((fact) =>
      [
        fact.factKey,
        fact.sourceSummary,
        fact.subjectDisplayName,
        describeFactValue(fact),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
    if (match) return match;
  }
  return accepted[0] || null;
}

export function formatSetupCompletenessStatus(params: {
  groupFolder: string;
  now?: Date;
}): string {
  const report = buildAgiLeapReadinessReport({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const answered =
    report.profilePack.setupCompleteness.answeredSetupAreas.join(', ') ||
    'none yet';
  const answeredSet = new Set(
    report.profilePack.setupCompleteness.answeredSetupAreas,
  );
  const missing = SETUP_AREAS.filter((area) => !answeredSet.has(area.id));
  const nextArea = missing[0] || null;
  const memory = report.profilePack.memoryQuality;
  return [
    formatAgiLeapReadinessReport(report),
    `Answered setup areas: ${answered}.`,
    missing.length
      ? `Missing setup areas: ${missing.map((area) => area.label).join(', ')}.`
      : 'Missing setup areas: none.',
    nextArea ? `Next setup question: ${nextArea.nextQuestion}` : null,
    nextArea
      ? 'Continue command: say `finish my Andrea setup`, then answer that question.'
      : 'Continue command: ask `what did you learn about me?` to review proposed memory updates.',
    `Memory quality: ${memory.acceptedFacts} accepted, ${memory.factsWithConfidence} with confidence, ${memory.factsWithFreshness} with freshness, ${memory.factsWithSource} with source.`,
    `Context graph: ${report.contextGraph.coverage.people} people, ${report.contextGraph.coverage.lifeThreads} life threads, ${report.contextGraph.coverage.communicationThreads} communication threads.`,
    `One best next step: ${report.topNextImprovement}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatRedactedProfilePackExport(params: {
  groupFolder: string;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  now?: Date;
}): string {
  const pack = exportRedactedOnboardingProfilePack({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const json = JSON.stringify(pack, null, 2);
  if (params.channel === 'alexa') {
    return `I prepared a redacted profile pack with ${pack.facts.length} memory summaries and ${pack.lifeThreads.length} life-thread summaries. Use Telegram to inspect the full JSON.`;
  }
  if (params.channel === 'bluebubbles') {
    return `Redacted profile pack: ${pack.facts.length} facts, ${pack.lifeThreads.length} life threads, identifiers removed.`;
  }
  return [
    'Here is the redacted Andrea profile pack. It contains summaries, not raw transcripts or identifiers.',
    '```json',
    json,
    '```',
  ].join('\n');
}

export function explainMemoryUse(input: MemoryActivationCommandInput): string {
  const fact = pickFactForExplanation(input);
  if (!fact) {
    return 'I do not have an accepted memory fact to point to yet. Once setup or learning review items are accepted, I can explain the source, freshness, and confidence for each one.';
  }
  const metadata = factMetadata(fact);
  const source = metadata.source || fact.sourceChannel || 'saved memory';
  const sourceLabel = memorySourceLabel(metadata.source, fact.factKey);
  const confidence =
    typeof metadata.confidence === 'number'
      ? `${Math.round(metadata.confidence * 100)}%`
      : 'not scored';
  const freshness = metadata.freshness || 'not labeled';
  return [
    `I know that from ${sourceLabel}.`,
    `Source detail: ${source}.`,
    `Saved detail: ${describeFactValue(fact)}`,
    `Source note: ${redactMemoryActivationText(fact.sourceSummary || fact.factKey)}`,
    `Freshness: ${freshness}. Confidence: ${confidence}.`,
  ].join('\n');
}

function candidateFromCommunication(
  thread: CommunicationThreadRecord,
): LearningCandidate | null {
  if (
    thread.followupState !== 'reply_needed' &&
    thread.followupState !== 'scheduled'
  ) {
    return null;
  }
  const summary = redactMemoryActivationText(
    thread.lastInboundSummary ||
      thread.suggestedNextAction ||
      `${thread.title} has an unresolved communication loop.`,
  );
  return {
    category: 'recurring_priorities',
    factKey: `learning.communication.${hashKey(thread.id)}`,
    summary: `${thread.title}: ${summary}`,
    value: {
      kind: 'communication_followup_pattern',
      threadTitle: redactMemoryActivationText(thread.title, 90),
      followupState: thread.followupState,
      urgency: thread.urgency,
      summary,
    },
    sourceSummary: summary,
    sensitivity: isSensitive(summary) ? 'sensitive' : 'normal',
  };
}

function candidateFromLifeThread(thread: LifeThread): LearningCandidate | null {
  if (thread.status !== 'active') return null;
  const summary = redactMemoryActivationText(
    thread.nextAction || thread.summary || thread.title,
  );
  return {
    category: 'recurring_priorities',
    factKey: `learning.life_thread.${hashKey(thread.id)}`,
    summary: `${thread.title}: ${summary}`,
    value: {
      kind: 'life_thread_priority',
      title: redactMemoryActivationText(thread.title, 90),
      category: thread.category,
      scope: thread.scope,
      summary,
    },
    sourceSummary: summary,
    sensitivity:
      thread.sensitivity === 'sensitive' || isSensitive(summary)
        ? 'sensitive'
        : 'normal',
  };
}

function candidateFromTask(task: ScheduledTask): LearningCandidate | null {
  if (task.status !== 'active') return null;
  const summary = redactMemoryActivationText(task.prompt);
  if (!summary) return null;
  return {
    category: 'routines',
    factKey: `learning.reminder.${hashKey(task.id)}`,
    summary,
    value: {
      kind: 'reminder_pattern',
      prompt: summary,
      scheduleType: task.schedule_type,
      hasNextRun: Boolean(task.next_run),
    },
    sourceSummary: summary,
    sensitivity: isSensitive(summary) ? 'sensitive' : 'normal',
  };
}

function candidateFromFollowThroughOutcomes(
  outcomes: OutcomeRecord[],
): LearningCandidate | null {
  const useful = outcomes
    .filter((outcome) => outcome.sourceType === 'followthrough_candidate')
    .filter(
      (outcome) =>
        outcome.status === 'completed' || outcome.status === 'deferred',
    );
  if (useful.length < 2) return null;
  const handled = useful.filter((outcome) => outcome.status === 'completed');
  const deferred = useful.filter((outcome) => outcome.status === 'deferred');
  const examples = useful
    .slice(0, 3)
    .map((outcome) =>
      redactMemoryActivationText(
        outcome.completionSummary ||
          outcome.nextFollowupText ||
          outcome.sourceKey,
        120,
      ),
    )
    .filter(Boolean);
  const summary = redactMemoryActivationText(
    `Follow-through outcomes show ${handled.length} handled and ${deferred.length} deferred tracking decision${useful.length === 1 ? '' : 's'}.`,
  );
  const sensitive = examples.some(isSensitive) || isSensitive(summary);
  return {
    category: 'recurring_priorities',
    factKey: `learning.outcome.followthrough.${hashKey(
      `${handled.length}:${deferred.length}:${examples.join('|')}`,
    )}`,
    summary,
    value: {
      kind: 'followthrough_outcome_pattern',
      handledCount: handled.length,
      deferredCount: deferred.length,
      examples,
    },
    sourceSummary: `${summary} ${examples.join(' ')}`.trim(),
    sensitivity: sensitive ? 'sensitive' : 'normal',
  };
}

function proposedLearningFacts(groupFolder: string): ProfileFactWithSubject[] {
  return sortedLearningFacts(groupFolder, ['proposed']).filter((fact) =>
    fact.factKey.startsWith('learning.'),
  );
}

function learningSourceGroup(fact: ProfileFactWithSubject): string {
  if (/communication/.test(fact.factKey)) return 'text review';
  if (/life_thread/.test(fact.factKey)) return 'life threads';
  if (/reminder|task/.test(fact.factKey)) return 'tasks and reminders';
  if (/outcome/.test(fact.factKey)) return 'outcomes';
  return memorySourceLabel(factMetadata(fact).source, fact.factKey);
}

function upsertLearningCandidate(params: {
  groupFolder: string;
  self: ProfileSubject;
  candidate: LearningCandidate;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  nowIso: string;
}): ProfileFact {
  const existing = getProfileFactByKey(
    params.groupFolder,
    params.self.id,
    params.candidate.category,
    params.candidate.factKey,
  );
  if (existing?.state === 'accepted' || existing?.state === 'rejected') {
    return existing;
  }
  const state: ProfileFact['state'] =
    existing?.state === 'disabled' ? 'disabled' : 'proposed';
  const record: ProfileFact = {
    id: existing?.id || crypto.randomUUID(),
    groupFolder: params.groupFolder,
    subjectId: params.self.id,
    category: params.candidate.category,
    factKey: params.candidate.factKey,
    valueJson: JSON.stringify(
      memoryValue({
        value: params.candidate.value,
        confidence: 0.68,
        freshness: 'candidate',
        source: 'daily_learning_review',
        sensitivity: params.candidate.sensitivity,
        learnedAt: params.nowIso,
      }),
    ),
    state,
    sourceChannel: params.channel,
    sourceSummary: params.candidate.sourceSummary,
    createdAt: existing?.createdAt || params.nowIso,
    updatedAt: params.nowIso,
    decidedAt: null,
  };
  upsertProfileFact(record);
  return record;
}

function refreshLearningCandidates(input: MemoryActivationCommandInput): void {
  const nowIso = (input.now || new Date()).toISOString();
  const self = ensureSelfSubject(input.groupFolder, nowIso);
  const communication = listCommunicationThreadsForGroup({
    groupFolder: input.groupFolder,
    includeDisabled: false,
    limit: 30,
  })
    .map(candidateFromCommunication)
    .filter(Boolean) as LearningCandidate[];
  const lifeThreads = listLifeThreadsForGroup(input.groupFolder, [
    'active',
    'paused',
  ])
    .map(candidateFromLifeThread)
    .filter(Boolean) as LearningCandidate[];
  const tasks = getTasksForGroup(input.groupFolder)
    .map(candidateFromTask)
    .filter(Boolean) as LearningCandidate[];
  const followThroughOutcome = candidateFromFollowThroughOutcomes(
    listOutcomesForGroup({
      groupFolder: input.groupFolder,
      sourceTypes: ['followthrough_candidate'],
      statuses: ['completed', 'deferred'],
      includeSuppressed: true,
      limit: 30,
      now: nowIso,
    }),
  );
  const candidates = [
    ...communication,
    ...lifeThreads,
    ...(followThroughOutcome ? [followThroughOutcome] : []),
    ...tasks,
  ];
  for (const candidate of candidates.slice(0, 8)) {
    upsertLearningCandidate({
      groupFolder: input.groupFolder,
      self,
      candidate,
      channel: input.channel,
      nowIso,
    });
  }
}

function formatLearningReview(input: MemoryActivationCommandInput): string {
  refreshLearningCandidates(input);
  const proposed = proposedLearningFacts(input.groupFolder).slice(0, 8);
  const accepted = sortedLearningFacts(input.groupFolder, ['accepted']).filter(
    (fact) => fact.factKey.startsWith('learning.'),
  );
  if (proposed.length === 0) {
    return [
      accepted.length
        ? `I have ${accepted.length} accepted learning item${accepted.length === 1 ? '' : 's'} and no new proposed updates right now.`
        : 'I do not have proposed learning updates yet.',
      'When text reviews, reminders, life threads, or outcomes create a clear pattern, I will keep it proposed until you accept it.',
    ].join('\n');
  }
  const lines: string[] = [];
  const groups = new Map<string, ProfileFactWithSubject[]>();
  for (const fact of proposed) {
    const label = learningSourceGroup(fact);
    groups.set(label, [...(groups.get(label) || []), fact]);
  }
  for (const [label, facts] of groups) {
    lines.push(`${label}:`);
    for (const fact of facts) {
      const index = proposed.indexOf(fact);
      const metadata = factMetadata(fact);
      const sensitive =
        metadata.sensitivity === 'sensitive' ? ' Sensitive: review first.' : '';
      lines.push(`${index + 1}. ${describeFactValue(fact)}${sensitive}`);
    }
  }
  return [
    `I found ${proposed.length} proposed learning update${proposed.length === 1 ? '' : 's'}. I will not treat these as durable until you accept them.`,
    ...lines,
    'Say `accept learning #1`, `reject learning #1`, or `edit learning #1: ...`.',
  ].join('\n');
}

function parseLearningIndex(text: string): number | null {
  const match = text.match(/(?:#|number\s*)?(\d+)/i)?.[1];
  if (!match) return null;
  const index = Number.parseInt(match, 10);
  return Number.isFinite(index) && index > 0 ? index - 1 : null;
}

function handleLearningDecision(
  input: MemoryActivationCommandInput,
  action: 'accept' | 'reject' | 'edit',
): MemoryActivationCommandResult {
  const index = parseLearningIndex(input.text);
  const proposed = proposedLearningFacts(input.groupFolder);
  if (index === null || !proposed[index]) {
    return {
      handled: true,
      responseText:
        'I could not match that learning item. Ask `what did you learn about me?` to see the current numbered list.',
    };
  }
  const fact = proposed[index]!;
  const nowIso = (input.now || new Date()).toISOString();
  if (action === 'reject') {
    updateProfileFactState(fact.id, 'rejected', nowIso);
    return {
      handled: true,
      responseText: `Okay. I rejected learning #${index + 1}.`,
      referencedFactId: fact.id,
    };
  }
  if (action === 'edit') {
    const replacement = normalizeText(
      input.text.split(/:\s*/).slice(1).join(': '),
    );
    if (!replacement) {
      return {
        handled: true,
        responseText:
          'Tell me the edited wording after a colon, like `edit learning #1: prefer shorter replies for logistics`.',
        referencedFactId: fact.id,
      };
    }
    const metadata = factMetadata(fact);
    upsertProfileFact({
      ...fact,
      valueJson: JSON.stringify(
        memoryValue({
          value: replacement,
          confidence: metadata.confidence || 0.72,
          freshness: 'candidate',
          source: 'daily_learning_review_edit',
          sensitivity: isSensitive(replacement) ? 'sensitive' : 'normal',
          learnedAt: nowIso,
        }),
      ),
      sourceSummary: redactMemoryActivationText(replacement),
      updatedAt: nowIso,
      decidedAt: null,
      state: 'proposed',
    });
    return {
      handled: true,
      responseText: `Updated learning #${index + 1}. It is still proposed until you accept it.`,
      referencedFactId: fact.id,
    };
  }
  const parsed = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
  upsertProfileFact({
    ...fact,
    valueJson: JSON.stringify({
      ...parsed,
      freshness: 'current',
      acceptedAt: nowIso,
    }),
    state: 'accepted',
    updatedAt: nowIso,
    decidedAt: nowIso,
  });
  return {
    handled: true,
    responseText: `Accepted learning #${index + 1}. I can now explain why I know it and where it came from.`,
    referencedFactId: fact.id,
  };
}

export function handleMemoryActivationCommand(
  input: MemoryActivationCommandInput,
): MemoryActivationCommandResult {
  const normalized = normalizeText(input.text);
  const lower = normalized.toLowerCase();
  if (/^show my setup completeness\b/.test(lower)) {
    return {
      handled: true,
      responseText: formatSetupCompletenessStatus({
        groupFolder: input.groupFolder,
        now: input.now,
      }),
    };
  }
  if (/^export my profile pack\b/.test(lower)) {
    return {
      handled: true,
      responseText: formatRedactedProfilePackExport({
        groupFolder: input.groupFolder,
        channel: input.channel,
        now: input.now,
      }),
    };
  }
  if (
    /^what did you learn about me\b/.test(lower) ||
    /^what did you learn\b/.test(lower) ||
    /^what have you learned about me\b/.test(lower) ||
    /^daily learning review\b/.test(lower) ||
    /^review what you learned\b/.test(lower)
  ) {
    return {
      handled: true,
      responseText: formatLearningReview(input),
    };
  }
  if (/^accept learning\b/.test(lower)) {
    return handleLearningDecision(input, 'accept');
  }
  if (/^reject learning\b/.test(lower)) {
    return handleLearningDecision(input, 'reject');
  }
  if (/^edit learning\b/.test(lower)) {
    return handleLearningDecision(input, 'edit');
  }
  if (
    /^why (?:do|did) you know (?:that|this)\b/.test(lower) ||
    /^why do you know\b/.test(lower)
  ) {
    return {
      handled: true,
      responseText: explainMemoryUse(input),
      referencedFactId: pickFactForExplanation(input)?.id,
    };
  }
  return { handled: false };
}
