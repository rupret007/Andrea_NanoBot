import { createHash } from 'node:crypto';

import {
  parseLifeThreadTemporalState,
  shiftLifeThreadLocalDate,
} from './life-thread-temporal.js';
import type {
  LifeThread,
  LifeThreadCommitmentDependency,
  LifeThreadCommitmentEvidence,
  LifeThreadCommitmentEvidenceKind,
  LifeThreadCommitmentImportance,
  LifeThreadCommitmentOperationalState,
  LifeThreadCommitmentOwner,
  LifeThreadCommitmentReadiness,
  LifeThreadCommitmentState,
  LifeThreadCommitmentStrength,
  LifeThreadCommitmentTransitionRecord,
  LifeThreadConfidenceKind,
  LifeThreadFollowthroughMode,
  LifeThreadSourceKind,
  ProfileSubject,
} from './types.js';

const STRENGTHS = new Set<LifeThreadCommitmentStrength>([
  'speculative',
  'tentative',
  'intended',
  'committed',
  'explicitly_requested',
]);
const OPERATIONAL_STATES = new Set<LifeThreadCommitmentOperationalState>([
  'proposed',
  'active',
  'waiting',
  'blocked',
  'delegated',
  'deferred',
  'completed',
  'cancelled',
  'superseded',
]);
const READINESS_STATES = new Set<LifeThreadCommitmentReadiness>([
  'actionable_now',
  'actionable_at_time',
  'waiting_on_person',
  'waiting_on_external_event',
  'blocked_known_dependency',
  'blocked_unresolved_dependency',
  'non_actionable',
]);
const IMPORTANCE_STATES = new Set<LifeThreadCommitmentImportance>([
  'normal',
  'important',
  'critical',
]);
const OWNER_KINDS = new Set(['self', 'subject', 'shared', 'andrea', 'unknown']);
const DEPENDENCY_KINDS = new Set([
  'person_response',
  'person_delivery',
  'approval',
  'document',
  'external_event',
  'unresolved',
]);
const EVIDENCE_KINDS = new Set<LifeThreadCommitmentEvidenceKind>([
  'direct_language',
  'conversation_context',
  'reminder_request',
  'named_owner',
  'dependency',
  'temporal',
  'correction',
  'negation',
  'state_transition',
]);
const SOURCE_KINDS = new Set<LifeThreadSourceKind>([
  'explicit',
  'inferred',
  'reminder',
  'calendar',
  'draft',
  'action_layer',
  'daily_companion',
  'alexa_followup',
]);
const CONFIDENCE_KINDS = new Set<LifeThreadConfidenceKind>([
  'explicit',
  'high',
  'medium',
  'low',
]);

const TERMINAL_STATES = new Set<LifeThreadCommitmentOperationalState>([
  'completed',
  'cancelled',
  'superseded',
]);

const NON_PERSON_WORDS = new Set([
  'Actually',
  'Andrea',
  'August',
  'Friday',
  'Monday',
  'Saturday',
  'Sunday',
  'Thursday',
  'Tuesday',
  'Wednesday',
  'If',
  'I',
  'Once',
  'The',
  'They',
  'This',
  'Tomorrow',
]);

export interface CommitmentInterpretationInput {
  threadId: string;
  title: string;
  text: string;
  now: Date;
  timeZone: string;
  sourceKind: LifeThreadSourceKind;
  sourceRef?: string | null;
  current?: LifeThreadCommitmentState | null;
  knownSubjects?: ProfileSubject[];
  explicitRequest?: boolean;
  allowInitialFallback?: boolean;
  fallbackStrength?: LifeThreadCommitmentStrength;
  eventIdOverride?: string;
}

export interface CommitmentInterpretation {
  kind:
    | 'initial'
    | 'strengthened'
    | 'weakened'
    | 'waiting'
    | 'blocked'
    | 'delegated'
    | 'dependency_updated'
    | 'deferred'
    | 'reactivated'
    | 'completed'
    | 'cancelled'
    | 'superseded';
  eventId: string;
  state: LifeThreadCommitmentState;
  transition: LifeThreadCommitmentTransitionRecord;
  reason: string;
}

export interface CommitmentLegacyProjection {
  status: LifeThread['status'];
  nextAction: string | null;
  nextFollowupAt: string | null;
  snoozedUntil: string | null;
  followthroughMode: LifeThreadFollowthroughMode;
}

function compact(value: string, max = 320): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function normalize(value: string): string {
  return compact(value, 2_000).toLowerCase();
}

function hashId(...parts: Array<string | null | undefined>): string {
  return createHash('sha256')
    .update(
      parts
        .filter((part): part is string => typeof part === 'string')
        .join('\n'),
    )
    .digest('hex');
}

export function buildOpaqueLifeThreadCommitmentSourceRef(
  sourceRef: string,
): string {
  return `commitment-source:${hashId(sourceRef)}`;
}

type ResumableCommitmentState = NonNullable<
  LifeThreadCommitmentState['deferredFrom']
>;

export function resumableLifeThreadCommitmentState(
  state: LifeThreadCommitmentOperationalState | null | undefined,
): ResumableCommitmentState | null {
  return state === 'proposed' ||
    state === 'active' ||
    state === 'waiting' ||
    state === 'blocked' ||
    state === 'delegated'
    ? state
    : null;
}

/**
 * Canonical commitment state is durable derived memory, not a transcript. Keep
 * obvious credentials out even when they occur inside an otherwise useful
 * obligation. The original bounded signal remains governed by the existing
 * channel provenance policy.
 */
export function redactLifeThreadCommitmentText(value: string): string {
  return value
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|secret)\s*[:=]\s*(["'])(?!\[redacted-secret\])[^"']+\2/gi,
      '$1=[redacted-secret]',
    )
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|secret)\s*[:=]\s*(?!\[redacted-secret\])[^\s,;"'<>]+/gi,
      '$1=[redacted-secret]',
    )
    .replace(
      /\bBearer\s+(?!\[redacted-secret\])[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi,
      'Bearer [redacted-secret]',
    )
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[redacted-secret]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[redacted-secret]')
    .replace(/\bBSA-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\[redacted-secret\]/gi, '[redacted-secret]');
}

function redactCommitmentValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactLifeThreadCommitmentText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCommitmentValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactCommitmentValue(item),
      ]),
    ) as T;
  }
  return value;
}

export function buildLifeThreadCommitmentEventId(params: {
  threadId: string;
  text: string;
  sourceRef?: string | null;
}): string {
  return `life-thread-commitment:${hashId(
    params.threadId,
    normalize(params.text),
    params.sourceRef || null,
  )}`;
}

function selfOwner(): LifeThreadCommitmentOwner {
  return { kind: 'self', subjectIds: [], displayNames: ['you'] };
}

function unknownOwner(): LifeThreadCommitmentOwner {
  return { kind: 'unknown', subjectIds: [], displayNames: [] };
}

function andreaOwner(): LifeThreadCommitmentOwner {
  return { kind: 'andrea', subjectIds: [], displayNames: ['Andrea'] };
}

function subjectOwner(
  displayNames: string[],
  knownSubjects: ProfileSubject[] = [],
): LifeThreadCommitmentOwner {
  const uniqueNames = [
    ...new Set(displayNames.map((name) => compact(name, 60))),
  ];
  const ids = knownSubjects
    .filter((subject) =>
      uniqueNames.some(
        (name) => subject.displayName.toLowerCase() === name.toLowerCase(),
      ),
    )
    .map((subject) => subject.id);
  return uniqueNames.length > 0
    ? {
        kind: 'subject',
        subjectIds: [...new Set(ids)],
        displayNames: uniqueNames,
      }
    : unknownOwner();
}

function sharedOwner(
  displayNames: string[],
  knownSubjects: ProfileSubject[] = [],
): LifeThreadCommitmentOwner {
  const owner = subjectOwner(displayNames, knownSubjects);
  return {
    ...owner,
    kind: 'shared',
    displayNames: ['you', ...owner.displayNames],
  };
}

function namedPeople(
  text: string,
  knownSubjects: ProfileSubject[] = [],
): string[] {
  const known = knownSubjects
    .filter((subject) => subject.kind === 'person')
    .filter((subject) =>
      new RegExp(`\\b${escapeRegExp(subject.displayName)}\\b`, 'i').test(text),
    )
    .map((subject) => subject.displayName);
  const capitalized = [...text.matchAll(/\b([A-Z][a-z]{2,})(?:'s)?\b/g)]
    .map((match) => match[1])
    .filter((name) => !NON_PERSON_WORDS.has(name));
  return [...new Set([...known, ...capitalized])];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function confidenceForLanguage(params: {
  explicit: boolean;
  namedOwner?: boolean;
  ambiguous?: boolean;
}): LifeThreadConfidenceKind {
  if (params.explicit) return 'explicit';
  if (params.ambiguous) return 'low';
  return params.namedOwner ? 'high' : 'medium';
}

function explicitImportance(value: string): LifeThreadCommitmentImportance {
  if (
    /\b(?:critical|urgent|highest priority|top priority|mission[- ]critical)\b/i.test(
      value,
    )
  ) {
    return 'critical';
  }
  if (
    /\b(?:important|high priority|prioritize (?:this|that|it))\b/i.test(value)
  ) {
    return 'important';
  }
  return 'normal';
}

function evidence(
  input: CommitmentInterpretationInput,
  eventId: string,
  kind: LifeThreadCommitmentEvidenceKind,
  confidenceKind: LifeThreadConfidenceKind,
  summary?: string,
  reasonKinds: LifeThreadCommitmentEvidenceKind[] = [kind],
): LifeThreadCommitmentEvidence {
  return {
    eventId,
    kind,
    reasonKinds: [...new Set(reasonKinds)],
    summary: compact(
      summary || 'A commitment transition was derived from bounded user input.',
      280,
    ),
    sourceKind: input.sourceKind,
    confidenceKind,
    observedAt: input.now.toISOString(),
    sourceRef: buildOpaqueLifeThreadCommitmentSourceRef(
      input.sourceRef || eventId,
    ),
  };
}

function retainEvidence(
  current: LifeThreadCommitmentState | null | undefined,
  next: LifeThreadCommitmentEvidence[],
): LifeThreadCommitmentEvidence[] {
  const byEventAndKind = new Map<string, LifeThreadCommitmentEvidence>();
  for (const item of [...(current?.evidence || []), ...next]) {
    byEventAndKind.set(`${item.eventId}:${item.kind}`, item);
  }
  return [...byEventAndKind.values()]
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .slice(-12);
}

function transitionFor(params: {
  input: CommitmentInterpretationInput;
  eventId: string;
  state: LifeThreadCommitmentState;
  reason: string;
}): LifeThreadCommitmentTransitionRecord {
  const current = params.input.current;
  return {
    version: 1,
    eventId: params.eventId,
    disposition: 'applied',
    fromRevision: current?.revision || 0,
    toRevision: params.state.revision,
    fromState: current?.operationalState || 'proposed',
    toState: params.state.operationalState,
    fromStrength: current?.strength || 'speculative',
    toStrength: params.state.strength,
    observedAt: params.input.now.toISOString(),
    reason: compact(params.reason, 240),
    beforeState: current || null,
    afterState: params.state,
  };
}

function parseTemporal(
  input: CommitmentInterpretationInput,
  currentAt?: string | null,
) {
  return parseLifeThreadTemporalState({
    text: input.text,
    now: input.now,
    timeZone: input.timeZone,
    currentTemporalAt: currentAt,
  });
}

function businessDayFollowUp(
  text: string,
  now: Date,
  timeZone: string,
): string | null {
  const match = text.match(
    /\b(?:in|within)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+business days?\b/i,
  );
  if (!match) return null;
  let remaining = parseDayCount(match[1]);
  let days = 0;
  while (remaining > 0) {
    days += 1;
    const probeIso = shiftLifeThreadLocalDate({
      now,
      timeZone,
      days,
      hour: 12,
      minute: 0,
    });
    if (!probeIso) return null;
    const probe = new Date(probeIso);
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
    }).format(probe);
    if (weekday !== 'Sat' && weekday !== 'Sun') remaining -= 1;
  }
  return shiftLifeThreadLocalDate({ now, timeZone, days, hour: 9, minute: 0 });
}

function parseDayCount(value: string | undefined): number {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const parsed = Number(value);
  return Math.max(
    1,
    Math.min(
      30,
      Number.isFinite(parsed) ? parsed : words[value?.toLowerCase() || ''] || 1,
    ),
  );
}

function followUpFromText(
  input: CommitmentInterpretationInput,
): LifeThreadCommitmentState['followUp'] {
  const normalized = normalize(input.text);
  const expectedWindow = normalized.match(
    /\b(?:in|within)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(business\s+)?days?\b/,
  );
  if (
    !/\b(?:follow up|check back|ping me|remind me)\b/.test(normalized) &&
    !expectedWindow
  ) {
    return null;
  }
  // Parse the follow-up clause rather than an earlier completed-action date
  // (for example, "emailed today; if no reply by Friday...").
  const followUpClause =
    input.text.match(/\bif\s+.+$/i)?.[0] ||
    input.text.match(
      /\b(?:follow up|check back|ping me|remind me)\b.+$/i,
    )?.[0] ||
    input.text;
  const temporal = parseLifeThreadTemporalState({
    text: followUpClause,
    now: input.now,
    timeZone: input.timeZone,
  });
  const businessDue = businessDayFollowUp(
    input.text,
    input.now,
    input.timeZone,
  );
  const calendarDue =
    expectedWindow && !expectedWindow[2]
      ? shiftLifeThreadLocalDate({
          now: input.now,
          timeZone: input.timeZone,
          days: parseDayCount(expectedWindow[1]),
          hour: 9,
          minute: 0,
        })
      : null;
  const dueAt = businessDue || calendarDue || temporal?.activeAt || null;
  const conditionMatch = input.text.match(
    /\bif\s+(.+?)(?:,|\bthen\b)\s*(?:i\s+)?(?:need to|should|please)?\s*(?:follow up|check back|ping me)/i,
  );
  return {
    action: compact(
      /ping me/i.test(input.text)
        ? `Follow up on ${input.title}`
        : `Follow up on ${input.title}`,
      240,
    ),
    condition: compact(
      conditionMatch?.[1] || 'the awaited event has not happened',
      240,
    ),
    dependencyIds: [],
    dueAt,
  };
}

function parseDeferralAt(input: CommitmentInterpretationInput): string | null {
  const temporal = parseTemporal(input, input.current?.reactivateAt || null);
  if (temporal?.activeAt) return temporal.activeAt;
  const normalized = normalize(input.text);
  if (/\bnext month\b/.test(normalized)) {
    return shiftLifeThreadLocalDate({
      now: input.now,
      timeZone: input.timeZone,
      months: 1,
      day: 1,
      hour: 9,
      minute: 0,
    });
  }
  if (/\bnext quarter\b/.test(normalized)) {
    return shiftLifeThreadLocalDate({
      now: input.now,
      timeZone: input.timeZone,
      quarters: 1,
      day: 1,
      hour: 9,
      minute: 0,
    });
  }
  const month = input.text.match(
    /\b(?:in|until)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  );
  if (month) {
    return shiftLifeThreadLocalDate({
      now: input.now,
      timeZone: input.timeZone,
      targetMonthName: month[1],
      day: 1,
      hour: 9,
      minute: 0,
    });
  }
  return null;
}

function actionBeforeDependency(text: string): string | null {
  const match = text.match(
    /\b(?:i|we)\s+(?:can'?t|cannot|couldn'?t)\s+(.+?)\s+until\b/i,
  );
  if (match) return compact(match[1], 240);
  const once = text.match(
    /\bonce\s+.+?,\s*(?:i|we)\s+(?:need to|will|can)\s+(.+)$/i,
  );
  if (once) return compact(once[1], 240);
  const before = text.match(
    /\b(?:i|we)\s+need\s+.+?\s+before\s+(?:i|we)\s+can\s+(.+?)(?:[.!?]|$)/i,
  );
  return before ? compact(before[1], 240) : null;
}

function downstreamActionAfterWait(text: string): string | null {
  const match = text.match(
    /\b(?:once|when|after)\s+.+?,\s*(?:then\s+)?(?:i|we)\s+(?:need to|will|'ll|can|am going to)\s+(.+?)(?:[.!?]|$)/i,
  );
  if (!match?.[1]) return null;
  const action = compact(match[1], 240).replace(/[.!?]+$/, '');
  return action ? `${action[0]!.toUpperCase()}${action.slice(1)}` : null;
}

function normalizeSelfCommitmentAction(text: string): string {
  const action = compact(text, 360)
    .replace(
      /^\s*(?:actually,?\s*)?(?:remember\s+(?:that\s+)?)?(?:i|we)\s+(?:might|may|probably|hope to|was going to|am planning to|are planning to|plan to|intend to|need to|will|'ll|am going to|are going to)\s+/i,
      '',
    )
    .replace(/[.!?]+$/, '');
  return action
    ? `${action[0]!.toUpperCase()}${action.slice(1)}`
    : compact(text, 360);
}

function dependencyClause(text: string): string | null {
  const match =
    text.match(/\buntil\s+(.+?)(?:[.!?]|$)/i) ||
    text.match(/\b(?:waiting (?:on|for)|awaiting)\s+(.+?)(?:[.!?]|$)/i) ||
    text.match(/\bblocked (?:on|by)\s+(.+?)(?:[.!?]|$)/i) ||
    text.match(/\bneed\s+(.+?)\s+before\s+(?:i|we)\s+can\b/i) ||
    text.match(/\bonce\s+(.+?),\s*(?:i|we)\b/i);
  return match ? compact(match[1], 240) : null;
}

function dependencyKind(
  clause: string,
  people: string[],
): LifeThreadCommitmentDependency['kind'] {
  if (
    people.length > 0 &&
    /\b(?:send|reply|respond|call|provide)\b/i.test(clause)
  ) {
    return /\b(?:reply|respond|call)\b/i.test(clause)
      ? 'person_response'
      : 'person_delivery';
  }
  if (/\bapproval|approve|sign-?off\b/i.test(clause)) return 'approval';
  if (/\breport|file|document|results?|numbers?|vin\b/i.test(clause)) {
    return 'document';
  }
  return clause ? 'external_event' : 'unresolved';
}

function buildDependencies(params: {
  input: CommitmentInterpretationInput;
  clause: string | null;
  people: string[];
}): LifeThreadCommitmentDependency[] {
  if (!params.clause) return [];
  const names = params.people.length > 0 ? params.people : ['dependency'];
  return names.map((name, index) => ({
    id: `dependency:${hashId(params.input.threadId, params.clause, name, String(index))}`,
    kind: dependencyKind(params.clause!, params.people),
    description: params.clause!,
    owner:
      params.people.length > 0
        ? subjectOwner([name], params.input.knownSubjects)
        : unknownOwner(),
    resolutionCondition: compact(`Evidence that ${params.clause}`, 240),
    satisfied: false,
    satisfiedAt: null,
  }));
}

function currentOrDefault(
  input: CommitmentInterpretationInput,
  eventId: string,
): LifeThreadCommitmentState {
  if (input.current) return input.current;
  const confidenceKind = confidenceForLanguage({ explicit: false });
  return {
    version: 1,
    revision: 0,
    strength: 'speculative',
    operationalState: 'proposed',
    owner: unknownOwner(),
    readiness: 'non_actionable',
    importance: explicitImportance(input.text),
    objective: compact(input.text || input.title, 360),
    currentAction: null,
    downstreamAction: null,
    dueAt: null,
    reactivateAt: null,
    reactivateCondition: null,
    deferredFrom: null,
    dependencies: [],
    dependencyResolution: null,
    followUp: null,
    confidenceKind,
    evidence: [],
    lastTransitionId: eventId,
    updatedAt: input.now.toISOString(),
  };
}

function withTransition(params: {
  input: CommitmentInterpretationInput;
  eventId: string;
  kind: CommitmentInterpretation['kind'];
  reason: string;
  patch: Partial<LifeThreadCommitmentState>;
  evidenceKinds: LifeThreadCommitmentEvidenceKind[];
  confidenceKind: LifeThreadConfidenceKind;
}): CommitmentInterpretation {
  const reason = redactLifeThreadCommitmentText(params.reason);
  const input: CommitmentInterpretationInput = {
    ...params.input,
    current: params.input.current
      ? redactCommitmentValue(params.input.current)
      : params.input.current,
  };
  const current = currentOrDefault(input, params.eventId);
  const state = redactCommitmentValue<LifeThreadCommitmentState>({
    ...current,
    ...params.patch,
    version: 1,
    revision: current.revision + 1,
    confidenceKind: params.confidenceKind,
    evidence: retainEvidence(current, [
      evidence(
        input,
        params.eventId,
        // One derived record per source event avoids duplicating raw user text
        // for every classifier feature while preserving transition provenance.
        'state_transition',
        params.confidenceKind,
        reason,
        params.evidenceKinds,
      ),
    ]),
    lastTransitionId: params.eventId,
    updatedAt: input.now.toISOString(),
  });
  return {
    kind: params.kind,
    eventId: params.eventId,
    state,
    transition: transitionFor({
      input,
      eventId: params.eventId,
      state,
      reason,
    }),
    reason,
  };
}

export function buildStructuredLifeThreadCommitmentTransition(params: {
  thread: LifeThread;
  text: string;
  now: Date;
  timeZone: string;
  sourceKind: LifeThreadSourceKind;
  sourceRef?: string | null;
  eventId?: string;
  kind: CommitmentInterpretation['kind'];
  reason: string;
  patch: Partial<LifeThreadCommitmentState>;
  evidenceKinds?: LifeThreadCommitmentEvidenceKind[];
  confidenceKind?: LifeThreadConfidenceKind;
}): CommitmentInterpretation {
  const current = getLifeThreadCommitment(params.thread);
  const input: CommitmentInterpretationInput = {
    threadId: params.thread.id,
    title: params.thread.title,
    text: params.text,
    now: params.now,
    timeZone: params.timeZone,
    sourceKind: params.sourceKind,
    sourceRef: params.sourceRef,
    eventIdOverride: params.eventId,
    current,
  };
  const eventId =
    params.eventId ||
    buildLifeThreadCommitmentEventId({
      threadId: params.thread.id,
      text: params.text,
      sourceRef: params.sourceRef,
    });
  return withTransition({
    input,
    eventId,
    kind: params.kind,
    reason: params.reason,
    patch: params.patch,
    evidenceKinds: params.evidenceKinds || [
      'direct_language',
      'state_transition',
    ],
    confidenceKind: params.confidenceKind || 'explicit',
  });
}

function isWaitingLanguage(value: string): boolean {
  return (
    /\b(?:waiting (?:on|for)|awaiting|the ball is in (?:their|his|her) court)\b/i.test(
      value,
    ) ||
    /\b(?:sent|emailed|submitted|shared|gave)\b.+\b(?:waiting|hear back|reply|response)\b/i.test(
      value,
    ) ||
    /\b(?:said|told me) (?:they|he|she) would (?:call|reply|respond|send)\b/i.test(
      value,
    ) ||
    /\b(?:sent|emailed|submitted|shared|gave)\b.+\b(?:follow up|check back|ping me)\b/i.test(
      value,
    )
  );
}

function isBlockedLanguage(value: string): boolean {
  return (
    /\b(?:can'?t|cannot|unable to)\b.+\buntil\b/i.test(value) ||
    /\bblocked (?:on|by)\b/i.test(value) ||
    /\bneed\b.+\bbefore (?:i|we) can\b/i.test(value) ||
    /\bonce\b.+?,\s*(?:i|we)\s+(?:need to|will|can)\b/i.test(value)
  );
}

function isDelegationLanguage(value: string): boolean {
  return (
    /\b(?:is|are) (?:handling|taking care of|covering|booking|doing)\b/i.test(
      value,
    ) ||
    /\b(?:i|we) (?:asked|told)\s+[a-z][a-z'-]+\s+to\b/i.test(value) ||
    /\b(?:handing|delegating|assigned)\b.+\bto\s+[a-z][a-z'-]+\b/i.test(
      value,
    ) ||
    /\b[a-z][a-z'-]+ has this one\b/i.test(value)
  );
}

function delegatedOwnerNames(
  value: string,
  knownSubjects: ProfileSubject[] = [],
): string[] {
  const patterns = [
    /\b([a-z][a-z'-]+)\s+(?:is|are)\s+(?:handling|taking care of|covering|booking|doing)\b/i,
    /\b(?:i|we)\s+(?:asked|told)\s+([a-z][a-z'-]+)\s+to\b/i,
    /\b(?:handing|delegating|assigned)\b.+\bto\s+([a-z][a-z'-]+)\b/i,
    /\b([a-z][a-z'-]+)\s+has this one\b/i,
  ];
  const captured = patterns
    .map((pattern) => value.match(pattern)?.[1] || null)
    .filter((name): name is string => Boolean(name));
  const canonical = captured.map((name) => {
    const known = knownSubjects.find(
      (subject) =>
        subject.kind === 'person' &&
        subject.displayName.toLowerCase() === name.toLowerCase(),
    );
    return known?.displayName || `${name[0]!.toUpperCase()}${name.slice(1)}`;
  });
  return canonical.filter(
    (name, index) =>
      canonical.findIndex(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      ) === index,
  );
}

function delegatedWorkAction(text: string): string | null {
  const direct = text.match(
    /\b[a-z][a-z'-]+\s+(?:is|are)\s+(handling|taking care of|covering|booking|doing)\s+(.+?)(?:[.!?]|$)/i,
  );
  if (direct?.[1] && direct[2]) {
    const verb =
      direct[1].toLowerCase() === 'taking care of'
        ? 'Take care of'
        : direct[1].toLowerCase() === 'covering'
          ? 'Cover'
          : direct[1].toLowerCase() === 'booking'
            ? 'Book'
            : direct[1].toLowerCase() === 'doing'
              ? 'Do'
              : 'Handle';
    return compact(`${verb} ${direct[2]}`, 240).replace(/[.!?]+$/, '');
  }
  const requested = text.match(
    /\b(?:i|we)\s+(?:asked|told)\s+[a-z][a-z'-]+\s+to\s+(.+?)(?:[.!?]|$)/i,
  );
  if (!requested?.[1]) return null;
  const action = compact(requested[1], 240).replace(/[.!?]+$/, '');
  return action ? `${action[0]!.toUpperCase()}${action.slice(1)}` : null;
}

function isDeferralLanguage(value: string): boolean {
  return (
    /\b(?:revisit|put (?:this|that|it) off|defer|shelve|not now|maybe later)\b/i.test(
      value,
    ) ||
    /\b(?:deal with|come back to) (?:this|that|it)\b.+\b(?:later|next|after|in)\b/i.test(
      value,
    )
  );
}

function isCompletionLanguage(value: string): boolean {
  if (
    /\b(?:not|isn'?t|wasn'?t|aren'?t|weren'?t)\s+(?:done|finished|completed|resolved)\b/i.test(
      value,
    )
  ) {
    return false;
  }
  return (
    /\b(?:done|finished|completed|resolved|taken care of)\b/i.test(value) ||
    /\b(?:i|we) (?:submitted|sent|paid|bought|booked|handled)\b/i.test(value)
  );
}

function isCancellationLanguage(value: string): boolean {
  const imperative =
    /(?:^|[.!;]\s*)(?:please\s+)?(?:cancel|drop|stop)\s+(?:it|this|that|the (?:task|thread|obligation))\b/i.test(
      value,
    );
  const negatedImperative =
    /\b(?:don'?t|do not|never)\s+(?:cancel|drop|stop)\s+(?:it|this|that|the (?:task|thread|obligation))\b/i.test(
      value,
    );
  return (
    /\b(?:cancelled|canceled|called off|never mind|nevermind)\b/i.test(value) ||
    /\b(?:not doing|not going ahead with|no longer doing)\b/i.test(value) ||
    (imperative && !negatedImperative)
  );
}

function isResolutionLanguage(value: string): boolean {
  if (
    /\bif\b[^.!?]*\b(?:replied|responded|arrived|approved|received|sent|got|have)\b/i.test(
      value,
    ) ||
    /\b(?:haven'?t|hasn'?t|hadn'?t|not|never)\s+(?:replied|responded|arrived|been approved|received|sent|got)\b/i.test(
      value,
    )
  ) {
    return false;
  }
  return (
    /\b(?:replied|responded|arrived|was approved|got approved|came in|received|sent (?:it|the|their|his|her)|got the|have the)\b/i.test(
      value,
    ) ||
    /\b(?:i|we)(?:'ll| will) (?:handle|take|do) it (?:myself|ourselves)\b/i.test(
      value,
    ) ||
    /\b(?:take|taking) it back over\b/i.test(value)
  );
}

function initialStrength(value: string, explicitRequest: boolean) {
  if (
    explicitRequest ||
    /\b(?:remind me|don'?t let me forget)\b/i.test(value)
  ) {
    return 'explicitly_requested' as const;
  }
  if (
    /\b(?:might|may|maybe|considering|thinking about|could possibly|may get around to)\b/i.test(
      value,
    )
  ) {
    return 'speculative' as const;
  }
  if (
    /\b(?:probably|hope to|was going to|planning to|would like to|tentatively)\b/i.test(
      value,
    )
  ) {
    return 'tentative' as const;
  }
  if (
    /\b(?:i intend to|i need to|i plan to|we need to|we plan to)\b/i.test(value)
  ) {
    return 'intended' as const;
  }
  if (
    /\b(?:i(?:'ll| will)|we(?:'ll| will)|i(?:'m| am) definitely|i committed to|i told .+ i would|i(?:'m| am) going to)\b/i.test(
      value,
    )
  ) {
    return 'committed' as const;
  }
  return null;
}

function weakeningStrength(value: string): LifeThreadCommitmentStrength | null {
  if (
    /\b(?:only an idea|only something i was thinking about|not committing|don'?t treat (?:that|this|it) as a task)\b/i.test(
      value,
    )
  ) {
    return 'speculative';
  }
  if (/\b(?:maybe later|not definite|just tentative)\b/i.test(value)) {
    return 'tentative';
  }
  return null;
}

function strengtheningStrength(
  value: string,
): LifeThreadCommitmentStrength | null {
  if (
    /\b(?:make (?:that|this|it) definite|i committed to|definitely doing|actually,? yes|i(?:'m| am) going to do it)\b/i.test(
      value,
    )
  ) {
    return 'committed';
  }
  return null;
}

function isExplicitReactivationLanguage(value: string): boolean {
  return /\b(?:resume|reactivate|restart|do it now|(?:i(?:'m| am)\s+)?going to do it(?: now)?|deal with it now|take it back up)\b/i.test(
    value,
  );
}

export function buildLifeThreadCommitmentReactivationPatch(
  state: LifeThreadCommitmentState,
): Partial<LifeThreadCommitmentState> {
  const prior = state.deferredFrom;
  const base = {
    reactivateAt: null,
    reactivateCondition: null,
    deferredFrom: null,
  };
  if (prior === 'waiting') {
    return {
      ...base,
      operationalState: 'waiting',
      readiness:
        state.owner.kind === 'subject'
          ? 'waiting_on_person'
          : 'waiting_on_external_event',
      currentAction: null,
    };
  }
  if (prior === 'blocked') {
    return {
      ...base,
      operationalState: 'blocked',
      readiness:
        state.dependencies.length > 0
          ? 'blocked_known_dependency'
          : 'blocked_unresolved_dependency',
      currentAction: null,
    };
  }
  if (prior === 'delegated') {
    return {
      ...base,
      operationalState: 'delegated',
      readiness: 'waiting_on_person',
      currentAction: null,
    };
  }
  if (prior === 'proposed' || (!prior && !state.downstreamAction)) {
    return {
      ...base,
      operationalState: 'proposed',
      readiness: 'non_actionable',
      currentAction: null,
    };
  }
  if (state.dependencies.some((dependency) => !dependency.satisfied)) {
    return {
      ...base,
      operationalState: 'blocked',
      readiness: 'blocked_known_dependency',
      currentAction: null,
    };
  }
  return {
    ...base,
    operationalState: 'active',
    owner: state.owner.kind === 'unknown' ? selfOwner() : state.owner,
    readiness: 'actionable_now',
    currentAction: state.downstreamAction || state.objective,
    downstreamAction: null,
    followUp: null,
  };
}

export function isLifeThreadCommitmentLanguage(value: string): boolean {
  const normalized = compact(value, 2_000);
  return Boolean(
    initialStrength(normalized, false) ||
    weakeningStrength(normalized) ||
    strengtheningStrength(normalized) ||
    isWaitingLanguage(normalized) ||
    isBlockedLanguage(normalized) ||
    isDelegationLanguage(normalized) ||
    isDeferralLanguage(normalized) ||
    isExplicitReactivationLanguage(normalized) ||
    /\bif\b.+\b(?:follow up|check back|ping me|remind me)\b/i.test(
      normalized,
    ) ||
    isResolutionLanguage(normalized) ||
    isCompletionLanguage(normalized) ||
    isCancellationLanguage(normalized),
  );
}

export function interpretLifeThreadCommitment(
  rawInput: CommitmentInterpretationInput,
): CommitmentInterpretation | null {
  const sourceText = compact(rawInput.text, 2_000);
  if (!sourceText) return null;
  const eventId =
    rawInput.eventIdOverride ||
    buildLifeThreadCommitmentEventId({
      threadId: rawInput.threadId,
      text: sourceText,
      sourceRef: rawInput.sourceRef,
    });
  const text = redactLifeThreadCommitmentText(sourceText);
  const input: CommitmentInterpretationInput = {
    ...rawInput,
    text,
  };
  const current = input.current || null;
  const people = namedPeople(text, input.knownSubjects);
  const namedOwner = people.length > 0;

  // Explicit cancellation wins over weaker wait, defer, or tentative cues in
  // the same utterance. Terminal truth must not depend on phrase order.
  if (isCancellationLanguage(text)) {
    const confidenceKind = confidenceForLanguage({ explicit: true });
    return withTransition({
      input,
      eventId,
      kind: 'cancelled',
      reason: 'The user explicitly cancelled the obligation.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'negation', 'state_transition'],
      patch: {
        operationalState: 'cancelled',
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
  }

  // Conditional follow-up language updates an existing wait; it is not
  // evidence that the awaited event already happened.
  const conditionalFollowUp = current ? followUpFromText(input) : null;
  if (
    current &&
    ['waiting', 'blocked', 'delegated'].includes(current.operationalState) &&
    conditionalFollowUp &&
    /\bif\b/i.test(text)
  ) {
    conditionalFollowUp.dependencyIds = current.dependencies.map(
      (dependency) => dependency.id,
    );
    return withTransition({
      input,
      eventId,
      kind: 'dependency_updated',
      reason:
        'The user added a conditional follow-up without resolving the current wait.',
      confidenceKind: 'explicit',
      evidenceKinds: ['direct_language', 'temporal', 'state_transition'],
      patch: { followUp: conditionalFollowUp },
    });
  }

  // Mixed completion + waiting is one waiting transition: the completed user
  // action becomes provenance and must not remain the active next action.
  if (isWaitingLanguage(text)) {
    const followUp = followUpFromText(input);
    const owner = namedOwner
      ? subjectOwner(people, input.knownSubjects)
      : unknownOwner();
    const dependencyText =
      dependencyClause(text) ||
      compact(
        namedOwner
          ? `${people.join(' and ')} responds`
          : 'the awaited response or event occurs',
        240,
      );
    const dependencies = buildDependencies({
      input,
      clause: dependencyText,
      people,
    });
    const confidenceKind = confidenceForLanguage({
      explicit: true,
      namedOwner,
    });
    if (followUp) {
      followUp.dependencyIds = dependencies.map((dependency) => dependency.id);
    }
    const explicitDownstreamAction = downstreamActionAfterWait(text);
    return withTransition({
      input,
      eventId,
      kind: 'waiting',
      reason:
        'The user reported a completed outgoing action and an awaited response or event.',
      confidenceKind,
      evidenceKinds: [
        'direct_language',
        'state_transition',
        'dependency',
        ...(namedOwner ? (['named_owner'] as const) : []),
      ],
      patch: {
        strength:
          current?.strength === 'explicitly_requested'
            ? current.strength
            : 'committed',
        operationalState: 'waiting',
        owner,
        readiness: namedOwner
          ? 'waiting_on_person'
          : 'waiting_on_external_event',
        objective: current?.objective || compact(text, 360),
        currentAction: null,
        downstreamAction:
          explicitDownstreamAction ||
          (current?.operationalState === 'waiting'
            ? current.downstreamAction || null
            : null),
        dependencies,
        dependencyResolution: /\b(?:either|any (?:one|response))\b/i.test(text)
          ? 'any'
          : dependencies.length > 1
            ? 'all'
            : dependencies.length === 1
              ? 'all'
              : null,
        followUp: followUp || current?.followUp || null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: dependencyText,
        deferredFrom: null,
      },
    });
  }

  if (isBlockedLanguage(text)) {
    const clause = dependencyClause(text);
    const dependencies = buildDependencies({ input, clause, people });
    const knownDependency = Boolean(clause);
    const confidenceKind = confidenceForLanguage({
      explicit: true,
      namedOwner,
      ambiguous: !knownDependency,
    });
    return withTransition({
      input,
      eventId,
      kind: 'blocked',
      reason:
        'The next user action is impossible until a stated dependency is satisfied.',
      confidenceKind,
      evidenceKinds: [
        'direct_language',
        'state_transition',
        'dependency',
        ...(namedOwner ? (['named_owner'] as const) : []),
      ],
      patch: {
        strength: current?.strength || 'committed',
        operationalState: 'blocked',
        owner: namedOwner
          ? subjectOwner(people, input.knownSubjects)
          : unknownOwner(),
        readiness: knownDependency
          ? 'blocked_known_dependency'
          : 'blocked_unresolved_dependency',
        objective: current?.objective || compact(text, 360),
        currentAction: null,
        downstreamAction:
          actionBeforeDependency(text) ||
          current?.downstreamAction ||
          current?.currentAction ||
          null,
        dependencies,
        dependencyResolution: /\b(?:either|any (?:one|response))\b/i.test(text)
          ? 'any'
          : dependencies.length > 0
            ? 'all'
            : null,
        reactivateAt: null,
        reactivateCondition: clause,
        deferredFrom: null,
      },
    });
  }

  if (isDelegationLanguage(text)) {
    const delegatedPeople = delegatedOwnerNames(text, input.knownSubjects);
    if (delegatedPeople.length === 0) return null;
    const delegatedAction =
      delegatedWorkAction(text) ||
      current?.downstreamAction ||
      current?.currentAction ||
      null;
    if (!delegatedAction) return null;
    const confidenceKind = confidenceForLanguage({
      explicit: true,
      namedOwner: true,
    });
    return withTransition({
      input,
      eventId,
      kind: 'delegated',
      reason:
        'The user explicitly transferred the current next action to another person.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'state_transition', 'named_owner'],
      patch: {
        strength: current?.strength || 'committed',
        operationalState: 'delegated',
        owner: subjectOwner(delegatedPeople, input.knownSubjects),
        readiness: 'waiting_on_person',
        objective: current?.objective || compact(text, 360),
        currentAction: null,
        downstreamAction: delegatedAction,
        reactivateCondition: `${delegatedPeople.join(' and ')} completes or returns the work`,
        deferredFrom: null,
      },
    });
  }

  const weakened = weakeningStrength(text);
  if (current && weakened) {
    const confidenceKind = confidenceForLanguage({ explicit: true });
    return withTransition({
      input,
      eventId,
      kind: 'weakened',
      reason: 'The user explicitly reduced the commitment strength.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'negation', 'state_transition'],
      patch: {
        strength: weakened,
        operationalState: 'proposed',
        owner: current.owner,
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction:
          current.downstreamAction || current.currentAction || null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
  }

  if (isDeferralLanguage(text)) {
    const reactivateAt = parseDeferralAt(input);
    const condition =
      text.match(/\b(?:until|after)\s+(.+?)(?:[.!?]|$)/i)?.[1] ||
      (reactivateAt ? 'the deferral time arrives' : 'the user reactivates it');
    const confidenceKind = confidenceForLanguage({ explicit: true });
    return withTransition({
      input,
      eventId,
      kind: 'deferred',
      reason:
        'The user preserved the obligation but explicitly removed it from current action.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'state_transition', 'temporal'],
      patch: {
        strength: current?.strength || 'intended',
        operationalState: 'deferred',
        owner: current?.owner || selfOwner(),
        readiness: reactivateAt ? 'actionable_at_time' : 'non_actionable',
        objective: current?.objective || compact(text, 360),
        currentAction: null,
        downstreamAction:
          current?.downstreamAction || current?.currentAction || null,
        reactivateAt,
        reactivateCondition: compact(condition, 240),
        deferredFrom:
          current?.operationalState === 'deferred'
            ? current.deferredFrom || null
            : resumableLifeThreadCommitmentState(current?.operationalState) ||
              'active',
      },
    });
  }

  if (
    current?.operationalState === 'deferred' &&
    isExplicitReactivationLanguage(text)
  ) {
    return withTransition({
      input,
      eventId,
      kind: 'reactivated',
      reason: 'The user explicitly resumed the deferred commitment.',
      confidenceKind: 'explicit',
      evidenceKinds: ['direct_language', 'correction', 'state_transition'],
      patch: buildLifeThreadCommitmentReactivationPatch(current),
    });
  }

  if (
    current &&
    ['waiting', 'blocked', 'delegated'].includes(current.operationalState) &&
    isResolutionLanguage(text)
  ) {
    const confidenceKind = confidenceForLanguage({ explicit: true });
    const takeback =
      /\b(?:i|we)(?:'ll| will) (?:handle|take|do) it (?:myself|ourselves)|(?:take|taking) it back over\b/i.test(
        text,
      );
    const resolutionPeople = namedPeople(text, input.knownSubjects).map(
      (name) => name.toLowerCase(),
    );
    const normalizedResolution = normalize(text);
    const matchedIds = new Set(
      current.dependencies
        .filter((dependency) => {
          const ownerMatched = dependency.owner.displayNames.some((name) =>
            resolutionPeople.includes(name.toLowerCase()),
          );
          const meaningfulTokens = dependency.description
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length >= 3)
            .filter(
              (token) =>
                !['the', 'and', 'that', 'from', 'with', 'responds'].includes(
                  token,
                ),
            );
          const dependencyMatched =
            dependency.owner.displayNames.length === 0 &&
            meaningfulTokens.some((token) =>
              normalizedResolution.includes(token),
            );
          return ownerMatched || dependencyMatched;
        })
        .map((dependency) => dependency.id),
    );
    const scopedPronounResolution =
      current.dependencies.length === 1 &&
      /^\s*(?:they|he|she|it)\s+(?:replied|responded|arrived|was approved|sent it|came in)\s*[.!?]*\s*$/i.test(
        text,
      );
    if (!takeback && matchedIds.size === 0 && scopedPronounResolution) {
      matchedIds.add(current.dependencies[0]!.id);
    }
    if (!takeback && matchedIds.size === 0) return null;
    const dependencies = current.dependencies.map((dependency) =>
      matchedIds.has(dependency.id)
        ? {
            ...dependency,
            satisfied: true,
            satisfiedAt: input.now.toISOString(),
          }
        : dependency,
    );
    const resolutionSatisfied =
      takeback ||
      (dependencies.length > 0 &&
        (current.dependencyResolution === 'any'
          ? dependencies.some((dependency) => dependency.satisfied)
          : dependencies.every((dependency) => dependency.satisfied)));
    if (!resolutionSatisfied) {
      return withTransition({
        input,
        eventId,
        kind: 'dependency_updated',
        reason:
          'Explicit evidence satisfied one dependency, but another required dependency remains open.',
        confidenceKind,
        evidenceKinds: ['direct_language', 'state_transition', 'dependency'],
        patch: {
          dependencies,
        },
      });
    }
    const completesResolvedWait =
      current.operationalState === 'waiting' && !current.downstreamAction;
    return withTransition({
      input,
      eventId,
      kind: completesResolvedWait ? 'completed' : 'reactivated',
      reason: completesResolvedWait
        ? 'The awaited event occurred and no distinct downstream user action remains.'
        : 'New explicit evidence satisfied the wait, blocker, delegation, or deferral condition.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'state_transition', 'correction'],
      patch: {
        operationalState: completesResolvedWait ? 'completed' : 'active',
        owner: selfOwner(),
        readiness: completesResolvedWait ? 'non_actionable' : 'actionable_now',
        currentAction: completesResolvedWait
          ? null
          : current.downstreamAction ||
            current.currentAction ||
            current.objective,
        downstreamAction: null,
        dependencies: [],
        dependencyResolution: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        followUp: null,
      },
    });
  }

  const strengthened = strengtheningStrength(text);
  if (current && strengthened) {
    const temporal = parseTemporal(input, current.dueAt);
    const confidenceKind = confidenceForLanguage({ explicit: true });
    return withTransition({
      input,
      eventId,
      kind: 'strengthened',
      reason:
        'The user explicitly promoted a tentative or speculative item into a firm commitment.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'correction', 'state_transition'],
      patch: {
        strength: strengthened,
        operationalState:
          current.operationalState === 'proposed'
            ? 'active'
            : current.operationalState,
        owner: current.owner.kind === 'unknown' ? selfOwner() : current.owner,
        readiness:
          current.operationalState === 'proposed'
            ? temporal?.kind === 'scheduled'
              ? 'actionable_at_time'
              : 'actionable_now'
            : current.readiness,
        currentAction:
          current.operationalState === 'proposed'
            ? normalizeSelfCommitmentAction(
                current.downstreamAction || current.objective,
              )
            : current.currentAction,
        downstreamAction:
          current.operationalState === 'proposed'
            ? null
            : current.downstreamAction,
        dueAt: temporal?.activeAt || current.dueAt || null,
        deferredFrom: null,
      },
    });
  }

  if (isCompletionLanguage(text)) {
    const confidenceKind = confidenceForLanguage({ explicit: true });
    return withTransition({
      input,
      eventId,
      kind: 'completed',
      reason: 'The user explicitly reported the obligation complete.',
      confidenceKind,
      evidenceKinds: ['direct_language', 'state_transition'],
      patch: {
        operationalState: 'completed',
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
  }

  const strength = initialStrength(text, Boolean(input.explicitRequest));
  if (!strength && !input.fallbackStrength && !input.allowInitialFallback) {
    return null;
  }
  const resolvedStrength = strength || input.fallbackStrength || 'speculative';
  const temporal = parseTemporal(input);
  const isNonActionable =
    resolvedStrength === 'speculative' || resolvedStrength === 'tentative';
  const explicit = resolvedStrength === 'explicitly_requested';
  const confidenceKind = confidenceForLanguage({
    explicit,
    namedOwner: Boolean(input.fallbackStrength),
  });
  const readiness: LifeThreadCommitmentReadiness = isNonActionable
    ? 'non_actionable'
    : temporal?.kind === 'scheduled' && !/\b(?:by|due|deadline)\b/i.test(text)
      ? 'actionable_at_time'
      : 'actionable_now';
  const owner = explicit
    ? andreaOwner()
    : /\b(?:we|our)\b/i.test(text)
      ? sharedOwner([], input.knownSubjects)
      : selfOwner();
  const explicitAction = explicit
    ? (() => {
        const reminderAction =
          text.match(
            /^\s*(?:please\s+)?remind me\s+to\s+(.+?)(?:[.!?]|$)/i,
          )?.[1] ||
          text.match(
            /^\s*(?:please\s+)?remind me\s+.+?\s+to\s+(.+?)(?:[.!?]|$)/i,
          )?.[1] ||
          text.match(
            /^\s*(?:please\s+)?don'?t let me forget\s+to\s+(.+?)(?:[.!?]|$)/i,
          )?.[1] ||
          text.match(
            /^\s*(?:please\s+)?don'?t let me forget\s+.+?\s+to\s+(.+?)(?:[.!?]|$)/i,
          )?.[1] ||
          text;
        const normalized = compact(reminderAction, 360).replace(/[.!?]+$/, '');
        return normalized
          ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
          : null;
      })()
    : null;
  const selfAction = normalizeSelfCommitmentAction(text);
  const currentAction = isNonActionable
    ? null
    : explicit
      ? `Remind the user about ${input.title}`
      : selfAction;
  return withTransition({
    input,
    eventId,
    kind: 'initial',
    reason: `Direct language classified the item as ${resolvedStrength}.`,
    confidenceKind,
    evidenceKinds: [
      explicit ? 'reminder_request' : 'direct_language',
      'state_transition',
      ...(temporal ? (['temporal'] as const) : []),
    ],
    patch: {
      strength: resolvedStrength,
      operationalState: isNonActionable ? 'proposed' : 'active',
      owner,
      readiness,
      importance: explicitImportance(text),
      objective: compact(text, 360),
      currentAction,
      downstreamAction: isNonActionable
        ? compact(text, 360)
        : explicit
          ? explicitAction
          : null,
      dueAt: temporal?.activeAt || null,
      reactivateAt: null,
      reactivateCondition: null,
      deferredFrom: null,
      dependencies: [],
      dependencyResolution: null,
      followUp: null,
    },
  });
}

export function buildLegacyLifeThreadCommitment(
  thread: Pick<
    LifeThread,
    | 'id'
    | 'title'
    | 'summary'
    | 'status'
    | 'nextAction'
    | 'nextFollowupAt'
    | 'sourceKind'
    | 'confidenceKind'
    | 'userConfirmed'
    | 'createdAt'
    | 'lastUpdatedAt'
  >,
): LifeThreadCommitmentState {
  const terminal = thread.status === 'closed' || thread.status === 'archived';
  const deferred = thread.status === 'paused';
  const explicit =
    thread.userConfirmed ||
    thread.sourceKind === 'explicit' ||
    thread.sourceKind === 'reminder';
  const eventId = `life-thread-commitment:legacy:${thread.id}`;
  const confidenceKind =
    thread.confidenceKind || (explicit ? 'explicit' : 'medium');
  const hasAction = Boolean(thread.nextAction?.trim());
  const reminder = thread.sourceKind === 'reminder';
  return redactCommitmentValue<LifeThreadCommitmentState>({
    version: 1,
    revision: 0,
    strength:
      thread.sourceKind === 'reminder'
        ? 'explicitly_requested'
        : explicit
          ? 'committed'
          : 'intended',
    operationalState: terminal
      ? thread.status === 'archived'
        ? 'superseded'
        : 'completed'
      : deferred
        ? 'deferred'
        : hasAction
          ? 'active'
          : 'proposed',
    owner: reminder ? andreaOwner() : selfOwner(),
    readiness: terminal
      ? 'non_actionable'
      : deferred
        ? thread.nextFollowupAt
          ? 'actionable_at_time'
          : 'non_actionable'
        : hasAction
          ? thread.nextFollowupAt
            ? 'actionable_at_time'
            : 'actionable_now'
          : 'non_actionable',
    importance: 'normal',
    objective: compact(thread.summary || thread.title, 360),
    currentAction:
      terminal || deferred || !hasAction
        ? null
        : reminder
          ? `Remind the user about ${thread.title}`
          : thread.nextAction || null,
    downstreamAction:
      !terminal && (deferred || reminder) ? thread.nextAction || null : null,
    dueAt: deferred ? null : thread.nextFollowupAt || null,
    reactivateAt: deferred ? thread.nextFollowupAt || null : null,
    reactivateCondition: deferred ? 'legacy paused thread is resumed' : null,
    deferredFrom: deferred ? (hasAction ? 'active' : 'proposed') : null,
    dependencies: [],
    dependencyResolution: null,
    followUp: null,
    confidenceKind,
    evidence: [
      {
        eventId,
        kind: 'state_transition',
        summary:
          'Backward-compatible projection from the released life-thread record.',
        sourceKind: thread.sourceKind,
        confidenceKind,
        observedAt: thread.lastUpdatedAt || thread.createdAt,
        sourceRef: null,
      },
    ],
    lastTransitionId: eventId,
    updatedAt: thread.lastUpdatedAt || thread.createdAt,
  });
}

export function isLifeThreadCommitmentState(
  value: unknown,
): value is LifeThreadCommitmentState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<LifeThreadCommitmentState>;
  const boundedOptional = (candidate: unknown, max: number) =>
    candidate === undefined ||
    candidate === null ||
    (typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= max);
  const validDateOptional = (candidate: unknown) =>
    candidate === undefined ||
    candidate === null ||
    (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate)));
  const validOwner = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const owner = candidate as Partial<LifeThreadCommitmentOwner>;
    return (
      OWNER_KINDS.has(owner.kind || '') &&
      Array.isArray(owner.subjectIds) &&
      owner.subjectIds.length <= 12 &&
      owner.subjectIds.every(
        (item) =>
          typeof item === 'string' && item.length > 0 && item.length <= 160,
      ) &&
      new Set(owner.subjectIds).size === owner.subjectIds.length &&
      Array.isArray(owner.displayNames) &&
      owner.displayNames.length <= 12 &&
      owner.displayNames.every(
        (item) =>
          typeof item === 'string' && item.length > 0 && item.length <= 60,
      )
    );
  };
  if (
    !(
      state.version === 1 &&
      Number.isInteger(state.revision) &&
      (state.revision || 0) >= 0 &&
      STRENGTHS.has(state.strength as LifeThreadCommitmentStrength) &&
      OPERATIONAL_STATES.has(
        state.operationalState as LifeThreadCommitmentOperationalState,
      ) &&
      READINESS_STATES.has(state.readiness as LifeThreadCommitmentReadiness) &&
      IMPORTANCE_STATES.has(
        state.importance as LifeThreadCommitmentImportance,
      ) &&
      validOwner(state.owner) &&
      typeof state.objective === 'string' &&
      state.objective.length > 0 &&
      state.objective.length <= 360 &&
      boundedOptional(state.currentAction, 360) &&
      boundedOptional(state.downstreamAction, 360) &&
      validDateOptional(state.dueAt) &&
      validDateOptional(state.reactivateAt) &&
      boundedOptional(state.reactivateCondition, 240) &&
      (state.deferredFrom === undefined ||
        state.deferredFrom === null ||
        resumableLifeThreadCommitmentState(state.deferredFrom) ===
          state.deferredFrom) &&
      Array.isArray(state.dependencies) &&
      state.dependencies.length <= 12 &&
      state.dependencies.every(
        (dependency) =>
          dependency &&
          typeof dependency.id === 'string' &&
          dependency.id.length > 0 &&
          dependency.id.length <= 160 &&
          DEPENDENCY_KINDS.has(dependency.kind) &&
          typeof dependency.description === 'string' &&
          dependency.description.length > 0 &&
          dependency.description.length <= 240 &&
          typeof dependency.resolutionCondition === 'string' &&
          dependency.resolutionCondition.length > 0 &&
          dependency.resolutionCondition.length <= 240 &&
          typeof dependency.satisfied === 'boolean' &&
          validOwner(dependency.owner) &&
          validDateOptional(dependency.satisfiedAt) &&
          (dependency.satisfied
            ? typeof dependency.satisfiedAt === 'string'
            : dependency.satisfiedAt === undefined ||
              dependency.satisfiedAt === null),
      ) &&
      new Set(state.dependencies.map((dependency) => dependency.id)).size ===
        state.dependencies.length &&
      (state.dependencyResolution === null ||
        state.dependencyResolution === 'all' ||
        state.dependencyResolution === 'any') &&
      (state.dependencies.length > 0
        ? state.dependencyResolution !== null
        : state.dependencyResolution === null) &&
      (state.followUp === undefined ||
        state.followUp === null ||
        (typeof state.followUp.action === 'string' &&
          state.followUp.action.length > 0 &&
          state.followUp.action.length <= 240 &&
          typeof state.followUp.condition === 'string' &&
          state.followUp.condition.length > 0 &&
          state.followUp.condition.length <= 240 &&
          Array.isArray(state.followUp.dependencyIds) &&
          state.followUp.dependencyIds.length <= 12 &&
          state.followUp.dependencyIds.every(
            (id) =>
              typeof id === 'string' &&
              state.dependencies?.some((dependency) => dependency.id === id),
          ) &&
          new Set(state.followUp.dependencyIds).size ===
            state.followUp.dependencyIds.length &&
          validDateOptional(state.followUp.dueAt))) &&
      Array.isArray(state.evidence) &&
      state.evidence.length <= 12 &&
      state.evidence.every(
        (item) =>
          item &&
          typeof item.eventId === 'string' &&
          item.eventId.length > 0 &&
          item.eventId.length <= 160 &&
          EVIDENCE_KINDS.has(item.kind) &&
          (item.reasonKinds === undefined ||
            (Array.isArray(item.reasonKinds) &&
              item.reasonKinds.length > 0 &&
              item.reasonKinds.length <= EVIDENCE_KINDS.size &&
              item.reasonKinds.every((kind) => EVIDENCE_KINDS.has(kind)) &&
              new Set(item.reasonKinds).size === item.reasonKinds.length)) &&
          typeof item.summary === 'string' &&
          item.summary.length > 0 &&
          item.summary.length <= 280 &&
          SOURCE_KINDS.has(item.sourceKind) &&
          CONFIDENCE_KINDS.has(item.confidenceKind) &&
          Number.isFinite(Date.parse(item.observedAt)) &&
          boundedOptional(item.sourceRef, 160),
      ) &&
      CONFIDENCE_KINDS.has(state.confidenceKind as LifeThreadConfidenceKind) &&
      typeof state.lastTransitionId === 'string' &&
      typeof state.updatedAt === 'string' &&
      Number.isFinite(Date.parse(state.updatedAt))
    )
  ) {
    return false;
  }

  const currentAction = state.currentAction || null;
  const downstreamAction = state.downstreamAction || null;
  const terminal = TERMINAL_STATES.has(state.operationalState!);
  if (
    terminal &&
    (state.readiness !== 'non_actionable' ||
      currentAction ||
      downstreamAction ||
      state.dueAt ||
      state.reactivateAt ||
      state.reactivateCondition ||
      state.deferredFrom ||
      state.dependencies.length > 0 ||
      state.followUp)
  ) {
    return false;
  }
  if (
    state.operationalState === 'proposed' &&
    (state.readiness !== 'non_actionable' ||
      currentAction ||
      state.deferredFrom)
  ) {
    return false;
  }
  if (
    state.operationalState === 'active' &&
    (!currentAction ||
      !['actionable_now', 'actionable_at_time'].includes(state.readiness!) ||
      state.deferredFrom)
  ) {
    return false;
  }
  if (
    state.operationalState === 'waiting' &&
    (currentAction ||
      !['waiting_on_person', 'waiting_on_external_event'].includes(
        state.readiness!,
      ) ||
      state.deferredFrom)
  ) {
    return false;
  }
  if (
    state.operationalState === 'blocked' &&
    (currentAction ||
      !['blocked_known_dependency', 'blocked_unresolved_dependency'].includes(
        state.readiness!,
      ) ||
      state.deferredFrom)
  ) {
    return false;
  }
  if (
    state.operationalState === 'delegated' &&
    (currentAction ||
      state.readiness !== 'waiting_on_person' ||
      state.owner?.kind !== 'subject' ||
      state.deferredFrom)
  ) {
    return false;
  }
  if (
    state.operationalState === 'deferred' &&
    (currentAction ||
      !state.deferredFrom ||
      !['actionable_at_time', 'non_actionable'].includes(state.readiness!))
  ) {
    return false;
  }
  if (state.operationalState !== 'deferred' && state.deferredFrom) return false;
  return true;
}

export function isLifeThreadCommitmentTransitionRecord(
  value: unknown,
): value is LifeThreadCommitmentTransitionRecord {
  if (!value || typeof value !== 'object') return false;
  const transition = value as Partial<LifeThreadCommitmentTransitionRecord>;
  const before = transition.beforeState;
  const after = transition.afterState;
  if (
    transition.version !== 1 ||
    typeof transition.eventId !== 'string' ||
    transition.eventId.length === 0 ||
    transition.eventId.length > 160 ||
    !['applied', 'duplicate', 'stale', 'ambiguous'].includes(
      transition.disposition || '',
    ) ||
    !Number.isInteger(transition.fromRevision) ||
    !Number.isInteger(transition.toRevision) ||
    (transition.fromRevision ?? -1) < 0 ||
    transition.toRevision !== (transition.fromRevision ?? -1) + 1 ||
    !OPERATIONAL_STATES.has(
      transition.fromState as LifeThreadCommitmentOperationalState,
    ) ||
    !OPERATIONAL_STATES.has(
      transition.toState as LifeThreadCommitmentOperationalState,
    ) ||
    !STRENGTHS.has(transition.fromStrength as LifeThreadCommitmentStrength) ||
    !STRENGTHS.has(transition.toStrength as LifeThreadCommitmentStrength) ||
    typeof transition.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(transition.observedAt)) ||
    typeof transition.reason !== 'string' ||
    transition.reason.length === 0 ||
    transition.reason.length > 240 ||
    !after ||
    !isLifeThreadCommitmentState(after) ||
    after.revision !== transition.toRevision ||
    after.operationalState !== transition.toState ||
    after.strength !== transition.toStrength ||
    after.lastTransitionId !== transition.eventId ||
    after.updatedAt !== transition.observedAt
  ) {
    return false;
  }
  if (before === null || before === undefined) {
    return transition.fromRevision === 0 && transition.toRevision === 1;
  }
  return (
    isLifeThreadCommitmentState(before) &&
    before.revision === transition.fromRevision &&
    before.operationalState === transition.fromState &&
    before.strength === transition.fromStrength
  );
}

export function parseLifeThreadCommitmentJson(params: {
  value: string | null | undefined;
  fallback: Parameters<typeof buildLegacyLifeThreadCommitment>[0];
}): LifeThreadCommitmentState {
  const raw = params.value;
  if (raw !== null && raw !== undefined && raw.trim() !== '{}') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isLifeThreadCommitmentState(parsed)) return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error('Invalid canonical commitment state.');
  }
  return buildLegacyLifeThreadCommitment(params.fallback);
}

export function getLifeThreadCommitment(
  thread: LifeThread,
): LifeThreadCommitmentState {
  if (!thread.commitment) return buildLegacyLifeThreadCommitment(thread);
  if (isLifeThreadCommitmentState(thread.commitment)) return thread.commitment;
  throw new Error('Invalid canonical commitment state.');
}

export function effectiveLifeThreadCommitment(
  state: LifeThreadCommitmentState,
  now: Date,
): LifeThreadCommitmentState {
  const nowMs = now.getTime();
  const followUpAt = state.followUp?.dueAt
    ? Date.parse(state.followUp.dueAt)
    : Number.NaN;
  if (
    ['waiting', 'delegated', 'blocked'].includes(state.operationalState) &&
    state.followUp &&
    Number.isFinite(followUpAt) &&
    followUpAt <= nowMs
  ) {
    return {
      ...state,
      owner: selfOwner(),
      readiness: 'actionable_now',
      currentAction: state.followUp.action,
    };
  }
  const dueAt = state.dueAt ? Date.parse(state.dueAt) : Number.NaN;
  if (
    state.owner.kind === 'andrea' &&
    state.strength === 'explicitly_requested' &&
    Number.isFinite(dueAt) &&
    dueAt <= nowMs
  ) {
    return {
      ...state,
      owner: selfOwner(),
      readiness: 'actionable_now',
      currentAction:
        state.downstreamAction || state.currentAction || state.objective,
    };
  }
  if (
    state.readiness === 'actionable_at_time' &&
    Number.isFinite(dueAt) &&
    dueAt <= nowMs
  ) {
    return { ...state, readiness: 'actionable_now' };
  }
  return state;
}

export function projectLifeThreadCommitment(
  state: LifeThreadCommitmentState,
  now: Date,
): CommitmentLegacyProjection {
  const effective = effectiveLifeThreadCommitment(state, now);
  if (TERMINAL_STATES.has(effective.operationalState)) {
    return {
      status:
        effective.operationalState === 'superseded' ? 'archived' : 'closed',
      nextAction: null,
      nextFollowupAt: null,
      snoozedUntil: null,
      followthroughMode: 'off',
    };
  }
  if (effective.operationalState === 'deferred') {
    return {
      status: 'paused',
      nextAction: null,
      nextFollowupAt: effective.reactivateAt || null,
      snoozedUntil: effective.reactivateAt || null,
      followthroughMode: effective.reactivateAt
        ? 'scheduled'
        : 'important_only',
    };
  }
  const followUpAt = effective.followUp?.dueAt || null;
  const nextFollowupAt =
    followUpAt || effective.dueAt || effective.reactivateAt || null;
  const futureAndreaRequest =
    effective.owner.kind === 'andrea' &&
    effective.strength === 'explicitly_requested' &&
    effective.readiness === 'actionable_at_time' &&
    Boolean(effective.dueAt) &&
    Date.parse(effective.dueAt!) > now.getTime();
  return {
    status: 'active',
    nextAction: futureAndreaRequest
      ? null
      : effective.owner.kind === 'andrea' &&
          effective.strength === 'explicitly_requested'
        ? effective.downstreamAction || null
        : effective.currentAction || null,
    nextFollowupAt,
    snoozedUntil: null,
    followthroughMode:
      effective.strength === 'explicitly_requested' || followUpAt
        ? 'scheduled'
        : 'important_only',
  };
}

/** Bounded compatibility view for consumers that have not adopted rich state. */
export function projectEffectiveLifeThread(
  thread: LifeThread,
  now = new Date(),
): LifeThread {
  const commitment = effectiveLifeThreadCommitment(
    getLifeThreadCommitment(thread),
    now,
  );
  const projection = projectLifeThreadCommitment(commitment, now);
  const futureAndreaRequest =
    commitment.owner.kind === 'andrea' &&
    commitment.strength === 'explicitly_requested' &&
    commitment.readiness === 'actionable_at_time';
  return {
    ...thread,
    status: projection.status,
    nextAction: futureAndreaRequest ? null : projection.nextAction,
    nextFollowupAt: projection.nextFollowupAt,
    snoozedUntil: thread.snoozedUntil || projection.snoozedUntil,
    followthroughMode:
      thread.surfaceMode === 'manual_only' ||
      thread.followthroughMode === 'manual_only'
        ? 'manual_only'
        : thread.followthroughMode === 'off'
          ? 'off'
          : projection.followthroughMode,
    commitment,
  };
}

function confidenceRank(value: LifeThreadConfidenceKind): number {
  return value === 'explicit'
    ? 4
    : value === 'high'
      ? 3
      : value === 'medium'
        ? 2
        : 1;
}

function strengthRank(value: LifeThreadCommitmentStrength): number {
  return value === 'explicitly_requested'
    ? 5
    : value === 'committed'
      ? 4
      : value === 'intended'
        ? 3
        : value === 'tentative'
          ? 2
          : 1;
}

function importanceRank(value: LifeThreadCommitmentImportance): number {
  return value === 'critical' ? 3 : value === 'important' ? 2 : 1;
}

function urgencyBand(state: LifeThreadCommitmentState, now: Date): number {
  const when = state.followUp?.dueAt || state.dueAt || state.reactivateAt;
  if (!when) return 0;
  const delta = Date.parse(when) - now.getTime();
  if (!Number.isFinite(delta)) return 0;
  if (delta < 0) return 4;
  if (delta <= 24 * 60 * 60 * 1000) return 3;
  if (delta <= 7 * 24 * 60 * 60 * 1000) return 2;
  return 1;
}

function actionabilityBand(
  state: LifeThreadCommitmentState,
  now: Date,
): number {
  const effective = effectiveLifeThreadCommitment(state, now);
  if (effective.readiness === 'actionable_now') {
    return effective.strength === 'explicitly_requested' ? 6 : 5;
  }
  if (effective.readiness === 'actionable_at_time') return 4;
  if (
    effective.operationalState === 'waiting' ||
    effective.operationalState === 'delegated'
  ) {
    return 2;
  }
  if (effective.operationalState === 'blocked') return 1;
  return 0;
}

/** Deterministic coarse ordering; ties end in stable thread identity. */
export function compareLifeThreadCommitmentPriority(
  left: LifeThread,
  right: LifeThread,
  now: Date,
): number {
  const leftState = getLifeThreadCommitment(left);
  const rightState = getLifeThreadCommitment(right);
  const leftTuple = [
    actionabilityBand(leftState, now),
    importanceRank(leftState.importance),
    urgencyBand(leftState, now),
    strengthRank(leftState.strength),
    confidenceRank(leftState.confidenceKind),
  ];
  const rightTuple = [
    actionabilityBand(rightState, now),
    importanceRank(rightState.importance),
    urgencyBand(rightState, now),
    strengthRank(rightState.strength),
    confidenceRank(rightState.confidenceKind),
  ];
  for (let index = 0; index < leftTuple.length; index += 1) {
    if (leftTuple[index] !== rightTuple[index]) {
      return rightTuple[index]! - leftTuple[index]!;
    }
  }
  const updated = right.lastUpdatedAt.localeCompare(left.lastUpdatedAt);
  return updated || left.id.localeCompare(right.id);
}

export function shouldProactivelySurfaceCommitment(
  thread: LifeThread,
  now: Date,
): boolean {
  if (
    thread.surfaceMode === 'manual_only' ||
    thread.followthroughMode === 'off' ||
    thread.followthroughMode === 'manual_only'
  ) {
    return false;
  }
  if (thread.snoozedUntil) {
    const snoozeMs = Date.parse(thread.snoozedUntil);
    if (Number.isFinite(snoozeMs) && snoozeMs > now.getTime()) return false;
  }
  const state = effectiveLifeThreadCommitment(
    getLifeThreadCommitment(thread),
    now,
  );
  if (
    state.owner.kind === 'andrea' &&
    state.strength === 'explicitly_requested' &&
    state.readiness === 'actionable_at_time' &&
    state.dueAt &&
    Date.parse(state.dueAt) > now.getTime()
  ) {
    return false;
  }
  if (TERMINAL_STATES.has(state.operationalState)) return false;
  if (state.strength === 'speculative' || state.strength === 'tentative') {
    return false;
  }
  if (state.operationalState === 'deferred') return false;
  if (state.readiness === 'actionable_at_time') {
    const when = state.dueAt || state.reactivateAt;
    if (when && Date.parse(when) > now.getTime() + 24 * 60 * 60 * 1000) {
      return false;
    }
  }
  if (
    ['waiting', 'blocked', 'delegated'].includes(state.operationalState) &&
    state.readiness !== 'actionable_now'
  ) {
    return false;
  }
  if (
    state.confidenceKind === 'low' &&
    state.strength !== 'explicitly_requested'
  ) {
    return false;
  }
  return Boolean(state.currentAction);
}

export function buildMatureDeferredCommitment(params: {
  thread: LifeThread;
  now: Date;
  sourceKind?: LifeThreadSourceKind;
}): CommitmentInterpretation | null {
  const current = getLifeThreadCommitment(params.thread);
  if (
    current.operationalState !== 'deferred' ||
    !current.reactivateAt ||
    !Number.isFinite(Date.parse(current.reactivateAt)) ||
    Date.parse(current.reactivateAt) > params.now.getTime()
  ) {
    return null;
  }
  const text = `reactivate deferred commitment at ${current.reactivateAt}`;
  const input: CommitmentInterpretationInput = {
    threadId: params.thread.id,
    title: params.thread.title,
    text,
    now: params.now,
    timeZone: 'UTC',
    sourceKind: params.sourceKind || 'daily_companion',
    sourceRef: `reactivate:${current.reactivateAt}`,
    current,
  };
  const eventId = buildLifeThreadCommitmentEventId({
    threadId: params.thread.id,
    text,
    sourceRef: input.sourceRef,
  });
  return withTransition({
    input,
    eventId,
    kind: 'reactivated',
    reason: 'The explicit deferral horizon elapsed.',
    confidenceKind: current.confidenceKind,
    evidenceKinds: ['temporal', 'state_transition'],
    patch: buildLifeThreadCommitmentReactivationPatch(current),
  });
}

export function describeLifeThreadCommitment(
  thread: LifeThread,
  now = new Date(),
  timeZone = 'UTC',
): string {
  const state = effectiveLifeThreadCommitment(
    getLifeThreadCommitment(thread),
    now,
  );
  const topic = compact(state.objective || thread.title, 180).replace(
    /[.!?]+$/,
    '',
  );
  const ownerNames = state.owner.displayNames.filter((name) => name !== 'you');
  const owner =
    state.owner.kind === 'self'
      ? 'you'
      : state.owner.kind === 'andrea'
        ? 'Andrea'
        : state.owner.kind === 'shared'
          ? ['you', ...ownerNames].join(' and ')
          : state.owner.kind === 'unknown'
            ? 'an unresolved owner'
            : ownerNames.join(' and ') || 'an unresolved owner';
  const formatTime = (value: string): string => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return 'the saved time';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(parsed);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(parsed);
    }
  };
  if (state.operationalState === 'waiting') {
    const awaited =
      state.owner.kind === 'unknown' ? 'the expected response or event' : owner;
    return state.followUp?.dueAt
      ? `For ${topic}, you are waiting on ${awaited}. There is nothing to resend right now; ${state.followUp.action.toLowerCase()} if ${state.followUp.condition} by ${formatTime(state.followUp.dueAt)}.`
      : `For ${topic}, you are waiting on ${awaited}; there is no user action to repeat right now.`;
  }
  if (state.operationalState === 'blocked') {
    const dependency =
      state.dependencies[0]?.description || state.reactivateCondition;
    return `${topic} is blocked${dependency ? ` until ${dependency}` : ''}; the downstream action is not currently possible.`;
  }
  if (state.operationalState === 'delegated') {
    return `${owner} owns the next action for ${topic}. It remains open, but you should not be told to do the delegated work.`;
  }
  if (state.operationalState === 'deferred') {
    return state.reactivateAt
      ? `${topic} is deferred until ${formatTime(state.reactivateAt)}.`
      : `${topic} is deferred until ${state.reactivateCondition || 'you revisit it'}.`;
  }
  if (state.operationalState === 'proposed') {
    return state.strength === 'speculative'
      ? `${topic} is only a possibility, not a firm obligation.`
      : `${topic} is tentative and will not be treated as a firm overdue obligation.`;
  }
  if (state.operationalState === 'completed') return `${topic} is complete.`;
  if (state.operationalState === 'cancelled') return `${topic} is cancelled.`;
  if (state.operationalState === 'superseded')
    return `${topic} was superseded.`;
  return state.currentAction
    ? `${owner === 'you' ? 'You own' : `${owner} owns`} the next action for ${topic}: ${state.currentAction}`
    : `${owner === 'you' ? 'You own' : `${owner} owns`} the next action for ${topic}.`;
}
