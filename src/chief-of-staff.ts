import crypto from 'crypto';

import { TIMEZONE } from './config.js';
import {
  buildCalendarLookupSnapshot,
  lookupCalendarAssistantEvents,
  planCalendarAssistantLookup,
  type CalendarLookupSnapshot,
} from './calendar-assistant.js';
import {
  buildGroundedDaySnapshot,
  type GroundedDaySnapshot,
  type SelectedWorkContext,
  type UpcomingReminderSummary,
} from './daily-command-center.js';
import {
  getProfileFactByKey,
  getProfileSubjectByKey,
  listCommunicationThreadsForGroup,
  listProfileFactsForGroup,
  updateProfileFactState,
  upsertProfileFact,
  upsertProfileSubject,
} from './db.js';
import { searchKnowledgeLibrary } from './knowledge-library.js';
import { buildLifeThreadSnapshot } from './life-threads.js';
import type {
  ChiefOfStaffContext,
  ChiefOfStaffHorizon,
  ChiefOfStaffPreferences,
  ChiefOfStaffSnapshot,
  ChiefOfStaffSignal,
  ChiefOfStaffSignalKind,
  ChiefOfStaffSignalStrength,
  CommunicationThreadRecord,
  LifeThread,
  LifeThreadSnapshot,
  ProfileFact,
  ProfileFactWithSubject,
  ProfileSubject,
  ScheduledTask,
} from './types.js';
import {
  buildSignatureFlowText,
  buildSignatureSignalsWhyLine,
} from './signature-flows.js';
import { buildVoiceReply, normalizeVoicePrompt } from './voice-ready.js';

const CHIEF_OF_STAFF_FACT_KEY = 'chief_of_staff_preferences';

export interface ChiefOfStaffTurnInput {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder: string;
  text: string;
  mode:
    | 'prioritize'
    | 'plan_horizon'
    | 'prepare'
    | 'decision_support'
    | 'explain'
    | 'configure';
  chatJid?: string;
  now?: Date;
  tasks?: ScheduledTask[];
  selectedWork?: SelectedWorkContext | null;
  priorChiefOfStaffContextJson?: string;
  priorCommunicationSubjectIds?: string[];
  priorKnowledgeSourceIds?: string[];
  groundedSnapshot?: GroundedDaySnapshot;
  lifeThreadSnapshot?: LifeThreadSnapshot;
}

export interface ChiefOfStaffTurnResult {
  replyText: string;
  summaryText: string;
  detailText: string;
  snapshot: ChiefOfStaffSnapshot;
  context: ChiefOfStaffContext;
  followupSuggestions: string[];
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonParse<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ensureSelfSubject(groupFolder: string, now: Date): ProfileSubject {
  const existing = getProfileSubjectByKey(groupFolder, 'self', 'self');
  if (existing) return existing;
  const created: ProfileSubject = {
    id: `${groupFolder}:self:self`,
    groupFolder,
    kind: 'self',
    canonicalName: 'self',
    displayName: 'you',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    disabledAt: null,
  };
  upsertProfileSubject(created);
  return created;
}

function buildDefaultPreferences(
  facts: ProfileFactWithSubject[],
): ChiefOfStaffPreferences {
  let familyAggressiveness: ChiefOfStaffPreferences['familyAggressiveness'] =
    'normal';
  let workSuggestionsEnabled = true;
  let toneStyle: ChiefOfStaffPreferences['toneStyle'] = 'balanced';
  let mainThingFirst = true;

  for (const fact of facts) {
    const parsed = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
    if (fact.factKey === 'family_context_default' && parsed.enabled === false) {
      familyAggressiveness = 'lighter';
    }
    if (fact.factKey === 'work_context_default' && parsed.enabled === false) {
      workSuggestionsEnabled = false;
    }
    if (fact.factKey === 'response_style' && parsed.mode === 'short_direct') {
      toneStyle = 'direct';
    }
    if (fact.factKey === 'guidance_focus' && parsed.mode === 'main_thing_first') {
      mainThingFirst = true;
    }
    if (fact.factKey === 'companion_tone' && parsed.mode === 'plain') {
      toneStyle = toneStyle === 'direct' ? 'direct' : 'calm';
    }
  }

  return {
    familyAggressiveness,
    workSuggestionsEnabled,
    toneStyle,
    mainThingFirst,
  };
}

function resolveChiefOfStaffPreferences(
  groupFolder: string,
  priorContext?: ChiefOfStaffContext,
): ChiefOfStaffPreferences {
  const facts = listProfileFactsForGroup(groupFolder, ['accepted']);
  const defaults = buildDefaultPreferences(facts);
  const selfSubject = getProfileSubjectByKey(groupFolder, 'self', 'self');
  const stored =
    selfSubject &&
    getProfileFactByKey(
      groupFolder,
      selfSubject.id,
      'preferences',
      CHIEF_OF_STAFF_FACT_KEY,
    );
  const storedValue = safeJsonParse<Partial<ChiefOfStaffPreferences>>(
    stored?.valueJson,
    {},
  );
  const merged: ChiefOfStaffPreferences = {
    familyAggressiveness:
      storedValue.familyAggressiveness || defaults.familyAggressiveness,
    workSuggestionsEnabled:
      typeof storedValue.workSuggestionsEnabled === 'boolean'
        ? storedValue.workSuggestionsEnabled
        : defaults.workSuggestionsEnabled,
    toneStyle: storedValue.toneStyle || defaults.toneStyle,
    mainThingFirst:
      typeof storedValue.mainThingFirst === 'boolean'
        ? storedValue.mainThingFirst
        : defaults.mainThingFirst,
  };
  if (priorContext?.sessionOverrides?.suppressWorkSuggestions) {
    return { ...merged, workSuggestionsEnabled: false };
  }
  return merged;
}

function persistChiefOfStaffPreferences(params: {
  groupFolder: string;
  preferences: ChiefOfStaffPreferences;
  sourceChannel: 'alexa' | 'telegram' | 'bluebubbles';
  sourceSummary: string;
  now: Date;
}): void {
  const selfSubject = ensureSelfSubject(params.groupFolder, params.now);
  const existing = getProfileFactByKey(
    params.groupFolder,
    selfSubject.id,
    'preferences',
    CHIEF_OF_STAFF_FACT_KEY,
  );
  const record: ProfileFact = {
    id: existing?.id || crypto.randomUUID(),
    groupFolder: params.groupFolder,
    subjectId: selfSubject.id,
    category: 'preferences',
    factKey: CHIEF_OF_STAFF_FACT_KEY,
    valueJson: JSON.stringify(params.preferences),
    state: 'accepted',
    sourceChannel: params.sourceChannel,
    sourceSummary: params.sourceSummary,
    createdAt: existing?.createdAt || params.now.toISOString(),
    updatedAt: params.now.toISOString(),
    decidedAt: params.now.toISOString(),
  };
  upsertProfileFact(record);
}

function resetChiefOfStaffPreferences(groupFolder: string, now: Date): boolean {
  const selfSubject = getProfileSubjectByKey(groupFolder, 'self', 'self');
  if (!selfSubject) return false;
  const existing = getProfileFactByKey(
    groupFolder,
    selfSubject.id,
    'preferences',
    CHIEF_OF_STAFF_FACT_KEY,
  );
  if (!existing || existing.state === 'disabled') return false;
  return updateProfileFactState(existing.id, 'disabled', now.toISOString());
}

function inferHorizon(
  text: string,
  mode: ChiefOfStaffTurnInput['mode'],
): ChiefOfStaffHorizon {
  const lower = text.toLowerCase();
  if (/\btonight\b/.test(lower)) return 'tonight';
  if (/\btomorrow\b/.test(lower)) return 'tomorrow';
  if (/\bweekend\b/.test(lower)) return 'weekend';
  if (/\bnext few days\b/.test(lower)) return 'next_few_days';
  if (/\bthis week\b/.test(lower)) return 'this_week';
  if (mode === 'plan_horizon') return 'this_week';
  return 'today';
}

function inferFocusTopic(text: string): string | null {
  const normalized = normalizeText(text);
  const patterns = [
    /\bprepare (?:before|for) (.+)$/i,
    /\bprep for (.+)$/i,
    /\bhave ready for (.+)$/i,
    /\btradeoff (?:here|between)? (.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern)?.[1];
    if (match?.trim()) return match.trim();
  }
  return null;
}

function inferScope(
  text: string,
  signals: ChiefOfStaffSignal[],
): import('./types.js').ChiefOfStaffScope {
  const lower = text.toLowerCase();
  if (/\b(family|candace|household|kids?|home)\b/.test(lower)) {
    return /\bfamily\b/.test(lower) ? 'family' : 'household';
  }
  if (/\b(work|meeting|review|client|cursor|codex)\b/.test(lower)) {
    return 'work';
  }
  if (signals.length === 0) return 'mixed';
  const scopes = new Set(signals.map((signal) => signal.scope));
  if (scopes.size === 1) return signals[0]!.scope;
  return 'mixed';
}

function importanceFromScope(
  scope: import('./types.js').ChiefOfStaffScope,
): ChiefOfStaffSignalStrength {
  if (scope === 'family' || scope === 'household') return 'high';
  if (scope === 'work' || scope === 'mixed') return 'medium';
  return 'low';
}

function minutesUntil(iso: string | undefined | null, now: Date): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - now.getTime()) / 60000);
}

function buildEventSignal(params: {
  event:
    | {
        id: string;
        title: string;
        startIso: string;
        allDay: boolean;
      }
    | null
    | undefined;
  now: Date;
  horizon: ChiefOfStaffHorizon;
}): ChiefOfStaffSignal | null {
  const event = params.event;
  if (!event) return null;
  const minutes = minutesUntil(event.startIso, params.now);
  const urgency: ChiefOfStaffSignalStrength =
    params.horizon === 'today' || params.horizon === 'tonight'
      ? minutes != null && minutes <= 180
        ? 'high'
        : 'medium'
      : 'medium';
  const dueLabel =
    params.horizon === 'today' || params.horizon === 'tonight'
      ? event.allDay
        ? 'today'
        : new Date(event.startIso).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          })
      : params.horizon.replace(/_/g, ' ');
  return {
    kind: params.horizon === 'today' ? 'deadline' : 'prep_needed',
    title: event.title,
    summaryText:
      params.horizon === 'today'
        ? `${event.title} is the clearest time anchor in view.`
        : `Prep for ${event.title}.`,
    scope: /\b(family|dinner|school|practice|candace)\b/i.test(event.title)
      ? 'household'
      : /\b(work|review|client|meeting|sync)\b/i.test(event.title)
        ? 'work'
        : 'mixed',
    urgency,
    importance: 'high',
    recommendedAction: 'prepare',
    reasons: ['time anchor', 'prep requirement'],
    dueLabel,
  };
}

function buildReminderSignal(
  reminder: UpcomingReminderSummary | undefined,
  now: Date,
): ChiefOfStaffSignal | null {
  if (!reminder) return null;
  const minutes = minutesUntil(reminder.nextRunIso, now);
  const urgency: ChiefOfStaffSignalStrength =
    minutes != null && minutes <= 180 ? 'high' : 'medium';
  return {
    kind: 'commitment',
    title: reminder.label,
    summaryText: `${reminder.label} is already on deck.`,
    scope: /\b(candace|family|house|dinner|band)\b/i.test(reminder.label)
      ? 'mixed'
      : 'personal',
    urgency,
    importance: 'medium',
    recommendedAction: 'do_now',
    reasons: ['existing reminder', 'time anchor'],
    dueLabel: new Date(reminder.nextRunIso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }),
  };
}

function buildLifeThreadSignal(
  thread: LifeThread | null,
  kind: ChiefOfStaffSignalKind,
): ChiefOfStaffSignal | null {
  if (!thread) return null;
  const scope = thread.scope as import('./types.js').ChiefOfStaffScope;
  return {
    kind,
    title: thread.title,
    summaryText: thread.nextAction || thread.summary || thread.title,
    scope,
    urgency: kind === 'slip_risk' ? 'high' : 'medium',
    importance: importanceFromScope(scope),
    recommendedAction:
      kind === 'prep_needed'
        ? 'prepare'
        : kind === 'slip_risk'
          ? 'follow_up'
          : 'watch',
    reasons:
      kind === 'slip_risk'
        ? ['overdue follow-up', 'ongoing commitment']
        : ['ongoing thread', 'follow-through pressure'],
    dueLabel: thread.nextFollowupAt || null,
    relatedThreadId: thread.id,
  };
}

function buildCommunicationSignal(
  thread: CommunicationThreadRecord | undefined,
): ChiefOfStaffSignal | null {
  if (!thread) return null;
  return {
    kind:
      thread.followupState === 'waiting_on_them' ? 'waiting_on' : 'open_loop',
    title: thread.title,
    summaryText:
      thread.lastInboundSummary ||
      thread.lastOutboundSummary ||
      `${thread.title} still looks open.`,
    scope: thread.linkedLifeThreadIds.length > 0 ? 'mixed' : 'personal',
    urgency:
      thread.urgency === 'overdue' || thread.urgency === 'tonight'
        ? 'high'
        : thread.urgency === 'soon'
          ? 'medium'
          : 'low',
    importance: 'high',
    recommendedAction:
      thread.followupState === 'waiting_on_them' ? 'watch' : 'follow_up',
    reasons:
      thread.followupState === 'waiting_on_them'
        ? ['open conversation', 'waiting on the other person']
        : ['other-people dependency', 'open conversation'],
    dueLabel: thread.followupDueAt || null,
    relatedCommunicationThreadId: thread.id,
  };
}

function buildCurrentWorkSignal(
  work: SelectedWorkContext | null | undefined,
): ChiefOfStaffSignal | null {
  if (!work) return null;
  return {
    kind: 'focus_candidate',
    title: work.title,
    summaryText: work.summary || `${work.title} is the current work focus.`,
    scope: 'work',
    urgency: 'medium',
    importance: 'medium',
    recommendedAction: 'do_now',
    reasons: ['current work pressure', 'already selected as focus'],
  };
}

function buildOpportunitySignal(
  grounded: GroundedDaySnapshot,
  selectedWork: SelectedWorkContext | null | undefined,
): ChiefOfStaffSignal | null {
  const openWindow = grounded.meaningfulOpenWindows[0];
  if (!openWindow) return null;
  const minutes = Math.max(
    0,
    Math.round((openWindow.end.getTime() - openWindow.start.getTime()) / 60000),
  );
  if (minutes < 20) return null;
  const summaryText = selectedWork
    ? minutes >= 180
      ? `You have a decent stretch of usable room that could move ${selectedWork.title}.`
      : `You have about ${minutes} minutes of usable room that could move ${selectedWork.title}.`
    : minutes >= 180
      ? 'You have a decent amount of breathing room right now.'
      : `You have about ${minutes} minutes of usable breathing room.`;
  return {
    kind: 'opportunity',
    title: selectedWork?.title || 'Open window',
    summaryText,
    scope: selectedWork ? 'work' : 'personal',
    urgency: 'low',
    importance: selectedWork ? 'medium' : 'low',
    recommendedAction: selectedWork ? 'do_now' : 'watch',
    reasons: ['available time window'],
  };
}

function compareSignalStrength(
  left: ChiefOfStaffSignal,
  right: ChiefOfStaffSignal,
): number {
  const level = (value: ChiefOfStaffSignalStrength): number =>
    value === 'high' ? 0 : value === 'medium' ? 1 : 2;
  const kindPriority = (kind: ChiefOfStaffSignalKind): number => {
    switch (kind) {
      case 'deadline':
      case 'prep_needed':
        return 0;
      case 'commitment':
        return 1;
      case 'slip_risk':
        return 2;
      case 'open_loop':
      case 'waiting_on':
        return 3;
      case 'pressure_point':
      case 'focus_candidate':
        return 4;
      case 'opportunity':
        return 5;
      default:
        return 6;
    }
  };
  const urgencyDiff = level(left.urgency) - level(right.urgency);
  if (urgencyDiff !== 0) return urgencyDiff;
  const importanceDiff = level(left.importance) - level(right.importance);
  if (importanceDiff !== 0) return importanceDiff;
  return kindPriority(left.kind) - kindPriority(right.kind);
}

function buildBestNextAction(signal: ChiefOfStaffSignal | null): string | null {
  if (!signal) return null;
  switch (signal.recommendedAction) {
    case 'prepare':
      return `Prep ${signal.title} before it turns into a scramble.`;
    case 'follow_up':
      return `Move ${signal.title} forward with one concrete follow-up.`;
    case 'remind':
      return `Turn ${signal.title} into a reminder if you are not doing it now.`;
    case 'delay':
      return `Push ${signal.title} to a calmer window on purpose instead of carrying it loosely.`;
    case 'drop':
      return `Let ${signal.title} stop taking up attention if it is no longer real.`;
    case 'watch':
      return `Keep ${signal.title} in view, but it does not need force right now.`;
    default:
      return `Handle ${signal.title} next.`;
  }
}

async function loadHorizonCalendarSnapshot(
  horizon: ChiefOfStaffHorizon,
  now: Date,
): Promise<CalendarLookupSnapshot | null> {
  const query =
    horizon === 'tonight'
      ? 'what is on my calendar tonight'
      : horizon === 'tomorrow'
        ? 'what is on my calendar tomorrow'
        : horizon === 'this_week'
          ? 'what is on my calendar this week'
          : horizon === 'weekend'
            ? 'what is on my calendar this weekend'
            : horizon === 'next_few_days'
              ? 'what is on my calendar this week'
              : 'what should I know about today';
  const plan = planCalendarAssistantLookup(query, now, TIMEZONE, null);
  if (!plan || plan.clarificationQuestion) return null;
  const result = await lookupCalendarAssistantEvents(plan);
  return buildCalendarLookupSnapshot(result);
}

function buildPrepChecklist(params: {
  eventSignal: ChiefOfStaffSignal | null;
  reminderSignal: ChiefOfStaffSignal | null;
  communicationSignal: ChiefOfStaffSignal | null;
  knowledgeItems: string[];
  focusTopic: string | null;
}): string[] {
  const checklist = new Set<string>();
  if (params.eventSignal) {
    checklist.add(`Look at the details for ${params.eventSignal.title}.`);
  }
  if (params.communicationSignal?.title) {
    checklist.add(`Be ready to address ${params.communicationSignal.title}.`);
  }
  if (params.reminderSignal?.title) {
    checklist.add(
      `Decide whether ${params.reminderSignal.title} needs to happen now or be rescheduled.`,
    );
  }
  for (const item of params.knowledgeItems.slice(0, 2)) {
    checklist.add(item);
  }
  if (params.focusTopic) {
    checklist.add(`Make sure you have what you need for ${params.focusTopic}.`);
  }
  return [...checklist].slice(0, 4);
}

function buildExplainabilityLines(params: {
  mainSignal: ChiefOfStaffSignal | null;
  supportingSignals: ChiefOfStaffSignal[];
  signalsUsed: string[];
  preferences: ChiefOfStaffPreferences;
}): string[] {
  const lines: string[] = [];
  if (params.mainSignal) {
    lines.push(
      `I put ${params.mainSignal.title} first because of ${params.mainSignal.reasons.join(', ')}.`,
    );
  }
  if (params.supportingSignals[0]) {
    lines.push(`I also kept ${params.supportingSignals[0].title} in view.`);
  }
  if (params.preferences.familyAggressiveness === 'lighter') {
    lines.push('I am using a lighter family-context setting right now.');
  }
  if (!params.preferences.workSuggestionsEnabled) {
    lines.push('I kept work suggestions in the background for this read.');
  }
  if (params.signalsUsed.length > 0) {
    lines.push(`Signals in play: ${params.signalsUsed.join(', ')}.`);
  }
  return lines;
}

function buildLowConfidenceSummary(
  horizon: ChiefOfStaffHorizon,
  scope: import('./types.js').ChiefOfStaffScope,
): string {
  if (horizon === 'this_week' || horizon === 'weekend') {
    return `I can give you a light ${scope === 'mixed' ? '' : `${scope} `}read for ${horizon.replace(/_/g, ' ')}, but I am not confident enough to rank it much harder than that yet.`;
  }
  return 'I can give you a measured read, but I am not confident enough to prioritize this much more strongly right now.';
}

function resolveCommunicationCandidate(
  threads: CommunicationThreadRecord[],
  priorSubjectIds: string[] | undefined,
): CommunicationThreadRecord | undefined {
  if (priorSubjectIds?.length) {
    return threads.find((thread) =>
      priorSubjectIds.some((subjectId) => thread.linkedSubjectIds.includes(subjectId)),
    );
  }
  return threads[0];
}

function buildDetailText(snapshot: ChiefOfStaffSnapshot): string {
  const whyLine =
    snapshot.explainabilityLines[0] &&
    snapshot.explainabilityLines[0] !== snapshot.summaryText
      ? snapshot.explainabilityLines[0]
      : buildSignatureSignalsWhyLine(snapshot.signalsUsed);

  return buildSignatureFlowText({
    lead: snapshot.summaryText,
    detailLines: [
      ...snapshot.supportingSignals
        .slice(0, 2)
        .map((signal) => `${signal.title}: ${signal.summaryText}`),
      ...snapshot.prepChecklist.map((item) => `Prep: ${item}`),
      snapshot.confidence === 'low'
        ? "Confidence: I'm not confident enough to rank this much harder than that."
        : null,
    ],
    nextAction: snapshot.bestNextAction,
    whyLine,
  });
}

function formatChiefOfStaffReply(
  channel: ChiefOfStaffTurnInput['channel'],
  snapshot: ChiefOfStaffSnapshot,
  mode: ChiefOfStaffTurnInput['mode'],
): string {
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: snapshot.summaryText,
      details: [
        snapshot.supportingSignals[0]?.summaryText || null,
        snapshot.bestNextAction || null,
      ],
      maxDetails: mode === 'explain' ? 2 : 2,
    });
  }

  if (channel === 'bluebubbles') {
    return buildSignatureFlowText({
      lead: snapshot.summaryText,
      detailLines: snapshot.supportingSignals[0]
        ? [snapshot.supportingSignals[0].summaryText]
        : [],
      nextAction: snapshot.bestNextAction,
      whyLine:
        mode === 'explain'
          ? snapshot.explainabilityLines[0] ||
            buildSignatureSignalsWhyLine(snapshot.signalsUsed)
          : undefined,
    });
  }

  return buildDetailText(snapshot);
}

function buildFollowupSuggestions(mode: ChiefOfStaffTurnInput['mode']): string[] {
  switch (mode) {
    case 'prepare':
      return [
        'save that for later',
        'turn that into a reminder',
        'send the details to Telegram',
      ];
    case 'decision_support':
      return ['say more', 'send the details to Telegram', 'save that for later'];
    case 'plan_horizon':
      return [
        'what should I do next',
        'what am I forgetting',
        'send the details to Telegram',
      ];
    default:
      return [
        'why are you bringing that up',
        'send the details to Telegram',
        'save that for later',
      ];
  }
}

export async function buildChiefOfStaffSnapshot(
  input: ChiefOfStaffTurnInput,
): Promise<{
  snapshot: ChiefOfStaffSnapshot;
  context: ChiefOfStaffContext;
  preferences: ChiefOfStaffPreferences;
}> {
  const now = input.now || new Date();
  const priorContext = safeJsonParse<ChiefOfStaffContext | null>(
    input.priorChiefOfStaffContextJson,
    null,
  );
  const preferences = resolveChiefOfStaffPreferences(
    input.groupFolder,
    priorContext || undefined,
  );
  const horizon = inferHorizon(input.text, input.mode);
  const grounded =
    input.groundedSnapshot ||
    (await buildGroundedDaySnapshot({
      now,
      tasks: input.tasks,
      selectedWork: input.selectedWork || null,
    }));
  const selectedWork = input.selectedWork || grounded.selectedWork;
  const lifeThreadSnapshot =
    input.lifeThreadSnapshot ||
    buildLifeThreadSnapshot({
      groupFolder: input.groupFolder,
      now,
      selectedWorkTitle: selectedWork?.title || null,
    });
  const communicationThreads = listCommunicationThreadsForGroup({
    groupFolder: input.groupFolder,
    includeDisabled: false,
    followupStates: ['reply_needed', 'scheduled', 'waiting_on_them'],
    limit: 6,
  });
  const communicationCandidate = resolveCommunicationCandidate(
    communicationThreads,
    input.priorCommunicationSubjectIds,
  );
  const horizonCalendar =
    horizon === 'today'
      ? grounded.calendar
      : await loadHorizonCalendarSnapshot(horizon, now);
  const primaryEvent =
    horizonCalendar?.nextTimedEvent ||
    horizonCalendar?.activeAllDayEvents?.[0] ||
    horizonCalendar?.allDayEvents?.[0] ||
    grounded.calendar.nextTimedEvent ||
    grounded.calendar.activeAllDayEvents?.[0] ||
    null;
  const eventSignal = buildEventSignal({
    event: primaryEvent,
    now,
    horizon,
  });
  const reminderSignal = buildReminderSignal(
    grounded.todayReminders[0] || grounded.reminders[0],
    now,
  );
  const dueThreadSignal = buildLifeThreadSignal(
    lifeThreadSnapshot.dueFollowups[0] || null,
    'pressure_point',
  );
  const slippingSignal = buildLifeThreadSignal(
    lifeThreadSnapshot.slippingThreads[0] || null,
    'slip_risk',
  );
  const carryoverSignal = buildLifeThreadSignal(
    lifeThreadSnapshot.recommendedNextThread ||
      lifeThreadSnapshot.householdCarryover ||
      null,
    'open_loop',
  );
  const communicationSignal = buildCommunicationSignal(communicationCandidate);
  const workSignal = preferences.workSuggestionsEnabled
    ? buildCurrentWorkSignal(selectedWork)
    : null;
  const opportunitySignal = preferences.workSuggestionsEnabled
    ? buildOpportunitySignal(grounded, selectedWork)
    : null;
  const focusTopic = inferFocusTopic(input.text);
  const shouldUseKnowledge =
    input.mode === 'prepare' ||
    Boolean(focusTopic) ||
    Boolean(input.priorKnowledgeSourceIds?.length);
  const knowledgeItems = shouldUseKnowledge
    ? searchKnowledgeLibrary({
        groupFolder: input.groupFolder,
        query: focusTopic || input.text,
        requestedSourceIds: input.priorKnowledgeSourceIds,
        limit: 3,
      }).sources
        .slice(0, 2)
        .map((source) => `Check ${source.title} if you need the saved details.`)
    : [];

  const rawSignals = [
    eventSignal,
    reminderSignal,
    slippingSignal,
    dueThreadSignal,
    carryoverSignal,
    communicationSignal,
    workSignal,
    opportunitySignal,
  ].filter((signal): signal is ChiefOfStaffSignal => Boolean(signal));

  const signals = rawSignals
    .filter((signal) => {
      if (
        preferences.familyAggressiveness === 'lighter' &&
        (signal.scope === 'family' || signal.scope === 'household') &&
        signal.urgency === 'low'
      ) {
        return false;
      }
      if (!preferences.workSuggestionsEnabled && signal.scope === 'work') {
        return false;
      }
      return true;
    })
    .sort(compareSignalStrength);
  const omittedSignals = rawSignals
    .filter((signal) => !signals.includes(signal))
    .map((signal) => signal.title);

  const mainSignal = signals[0] || null;
  const supportingSignals = signals.slice(1, 3);
  const scope = inferScope(input.text, signals);
  const confidence =
    signals.length >= 3 && mainSignal?.urgency === 'high'
      ? 'high'
      : signals.length >= 2
        ? 'medium'
        : 'low';
  const signalsUsed = [
    eventSignal ? 'calendar' : null,
    reminderSignal ? 'reminders' : null,
    dueThreadSignal || slippingSignal || carryoverSignal ? 'life_threads' : null,
    communicationSignal ? 'communication_threads' : null,
    workSignal ? 'current_work' : null,
    knowledgeItems.length > 0 ? 'knowledge_library' : null,
  ].filter((value): value is string => Boolean(value));
  const prepChecklist = buildPrepChecklist({
    eventSignal,
    reminderSignal,
    communicationSignal,
    knowledgeItems,
    focusTopic,
  });
  const bestNextAction = buildBestNextAction(mainSignal);
  const pressurePoints = [
    slippingSignal?.title || null,
    dueThreadSignal?.title || null,
    communicationSignal?.title || null,
  ].filter((value): value is string => Boolean(value));
  const opportunities = [
    opportunitySignal?.summaryText || null,
    workSignal && opportunitySignal ? `Use an open window to move ${workSignal.title}.` : null,
  ].filter((value): value is string => Boolean(value));
  const explainabilityLines = buildExplainabilityLines({
    mainSignal,
    supportingSignals,
    signalsUsed,
    preferences,
  });

  let summaryText =
    mainSignal?.summaryText ||
    buildLowConfidenceSummary(horizon, scope);
  if (input.mode === 'prepare' && prepChecklist.length > 0) {
    summaryText = `The main prep move is to get ${prepChecklist[0]!.replace(/\.$/, '')} ready.`;
  } else if (input.mode === 'plan_horizon' && mainSignal) {
    summaryText = `For ${horizon.replace(/_/g, ' ')}, ${mainSignal.summaryText}`;
  } else if (input.mode === 'prioritize' && mainSignal) {
    summaryText = `${mainSignal.title} matters most because ${mainSignal.reasons[0]}.`;
  }
  if (confidence === 'low') {
    summaryText = buildLowConfidenceSummary(horizon, scope);
  }

  const snapshot: ChiefOfStaffSnapshot = {
    horizon,
    scope,
    summaryText,
    mainSignal,
    supportingSignals,
    bestNextAction,
    prepChecklist,
    pressurePoints,
    opportunities,
    confidence,
    explainabilityLines,
    signalsUsed,
    omittedSignals,
  };
  const context: ChiefOfStaffContext = {
    version: 1,
    mode: input.mode,
    snapshot,
    preferences,
    sessionOverrides: priorContext?.sessionOverrides,
    focusTopic,
    generatedAt: now.toISOString(),
  };
  return { snapshot, context, preferences };
}

function buildDecisionSupportSummary(params: {
  text: string;
  snapshot: ChiefOfStaffSnapshot;
}): string {
  const lower = params.text.toLowerCase();
  const mainSignal = params.snapshot.mainSignal;
  if (/tonight or tomorrow/.test(lower)) {
    if (mainSignal?.urgency === 'high') {
      return `Tonight is the safer move because ${mainSignal.title} already has real time pressure on it.`;
    }
    return 'Tomorrow looks like the calmer choice unless the timing changes tonight.';
  }
  if (/\bbest order\b|\border to do these\b/.test(lower)) {
    const ordered = [mainSignal, ...params.snapshot.supportingSignals]
      .filter(Boolean)
      .slice(0, 3)
      .map((signal) => signal!.title);
    if (ordered.length > 1) {
      return `The cleanest order looks like ${ordered.join(', then ')}.`;
    }
  }
  if (/\bpush off\b|\bdelay\b/.test(lower)) {
    const candidate = params.snapshot.supportingSignals.find(
      (signal) => signal.urgency === 'low',
    );
    if (candidate) {
      return `${candidate.title} is the easiest thing to push without much damage.`;
    }
  }
  if (/\bstop worrying about\b|\bdrop\b/.test(lower)) {
    const candidate = params.snapshot.supportingSignals.find(
      (signal) =>
        signal.recommendedAction === 'watch' || signal.kind === 'opportunity',
    );
    if (candidate) {
      return `You can probably stop giving ${candidate.title} so much weight right now.`;
    }
  }
  if (mainSignal) {
    return `The best next move is to center ${mainSignal.title} and keep the rest lighter around it.`;
  }
  return 'I can give you a measured read, but I am not confident enough to push this much harder without more context.';
}

export async function buildChiefOfStaffTurn(
  input: ChiefOfStaffTurnInput,
): Promise<ChiefOfStaffTurnResult> {
  const now = input.now || new Date();
  const priorContext = safeJsonParse<ChiefOfStaffContext | null>(
    input.priorChiefOfStaffContextJson,
    null,
  );

  if (input.mode === 'configure') {
    const normalized = normalizeText(input.text).toLowerCase();
    const currentPreferences = resolveChiefOfStaffPreferences(
      input.groupFolder,
      priorContext || undefined,
    );
    const updatedPreferences: ChiefOfStaffPreferences = {
      ...currentPreferences,
    };
    const sessionOverrides = { ...(priorContext?.sessionOverrides || {}) };
    let summaryText = 'Your planning defaults are staying as they are.';

    if (/reset/.test(normalized)) {
      resetChiefOfStaffPreferences(input.groupFolder, now);
      delete sessionOverrides.suppressWorkSuggestions;
      summaryText = 'I reset your planning preferences back to the default read.';
    } else if (/less aggressive.*family|stop surfacing family/.test(normalized)) {
      updatedPreferences.familyAggressiveness = 'lighter';
      persistChiefOfStaffPreferences({
        groupFolder: input.groupFolder,
        preferences: updatedPreferences,
        sourceChannel: input.channel,
        sourceSummary: input.text,
        now,
      });
      summaryText = 'I will keep family context lighter unless it looks more important.';
    } else if (/be more direct/.test(normalized)) {
      updatedPreferences.toneStyle = 'direct';
      persistChiefOfStaffPreferences({
        groupFolder: input.groupFolder,
        preferences: updatedPreferences,
        sourceChannel: input.channel,
        sourceSummary: input.text,
        now,
      });
      summaryText = 'I will make the planning read more direct.';
    } else if (/be calmer/.test(normalized)) {
      updatedPreferences.toneStyle = 'calm';
      persistChiefOfStaffPreferences({
        groupFolder: input.groupFolder,
        preferences: updatedPreferences,
        sourceChannel: input.channel,
        sourceSummary: input.text,
        now,
      });
      summaryText = 'I will keep the planning read calmer.';
    } else if (/don'?t suggest work right now/.test(normalized)) {
      sessionOverrides.suppressWorkSuggestions = true;
      summaryText = 'Okay. I will keep work suggestions out of this read for now.';
    }

    const { snapshot } = await buildChiefOfStaffSnapshot({
      ...input,
      mode: 'prioritize',
      priorChiefOfStaffContextJson: JSON.stringify({
        ...(priorContext || {
          version: 1,
          mode: 'prioritize',
          snapshot: {
            horizon: 'today',
            scope: 'mixed',
            summaryText: '',
            mainSignal: null,
            supportingSignals: [],
            bestNextAction: null,
            prepChecklist: [],
            pressurePoints: [],
            opportunities: [],
            confidence: 'low',
            explainabilityLines: [],
            signalsUsed: [],
            omittedSignals: [],
          },
          preferences: currentPreferences,
          generatedAt: now.toISOString(),
        }),
        sessionOverrides,
      } satisfies ChiefOfStaffContext),
    });
    const context: ChiefOfStaffContext = {
      version: 1,
      mode: 'configure',
      snapshot,
      preferences: resolveChiefOfStaffPreferences(input.groupFolder, {
        ...(priorContext || contextlessChiefOfStaffContext(currentPreferences)),
        sessionOverrides,
      }),
      sessionOverrides,
      generatedAt: now.toISOString(),
    };
    const configuredSnapshot: ChiefOfStaffSnapshot = {
      ...snapshot,
      summaryText,
      explainabilityLines: [
        summaryText,
        ...snapshot.explainabilityLines.slice(0, 2),
      ],
    };
    return {
      replyText:
        input.channel === 'alexa'
          ? buildVoiceReply({ summary: summaryText, details: [], offerMore: false })
          : summaryText,
      summaryText,
      detailText: buildDetailText(configuredSnapshot),
      snapshot: configuredSnapshot,
      context: { ...context, snapshot: configuredSnapshot },
      followupSuggestions: ['what matters today', 'what should I do next'],
    };
  }

  const built =
    input.mode === 'explain' && priorContext
      ? {
          snapshot: {
            ...priorContext.snapshot,
            summaryText:
              priorContext.snapshot.explainabilityLines[0] ||
              priorContext.snapshot.summaryText,
          },
          context: priorContext,
          preferences: resolveChiefOfStaffPreferences(
            input.groupFolder,
            priorContext,
          ),
        }
      : await buildChiefOfStaffSnapshot(input);

  let snapshot = built.snapshot;
  if (input.mode === 'decision_support') {
    snapshot = {
      ...snapshot,
      summaryText: buildDecisionSupportSummary({
        text: input.text,
        snapshot,
      }),
    };
  } else if (input.mode === 'explain') {
    snapshot = {
      ...snapshot,
      summaryText:
        snapshot.explainabilityLines[0] ||
        'I am weighting the calendar, reminders, open loops, and current pressure together.',
    };
  }

  const context: ChiefOfStaffContext = {
    ...built.context,
    mode: input.mode,
    snapshot,
  };
  return {
    replyText: formatChiefOfStaffReply(input.channel, snapshot, input.mode),
    summaryText: snapshot.summaryText,
    detailText: buildDetailText(snapshot),
    snapshot,
    context,
    followupSuggestions: buildFollowupSuggestions(input.mode),
  };
}

function contextlessChiefOfStaffContext(
  preferences: ChiefOfStaffPreferences,
): ChiefOfStaffContext {
  return {
    version: 1,
    mode: 'prioritize',
    snapshot: {
      horizon: 'today',
      scope: 'mixed',
      summaryText: '',
      mainSignal: null,
      supportingSignals: [],
      bestNextAction: null,
      prepChecklist: [],
      pressurePoints: [],
      opportunities: [],
      confidence: 'low',
      explainabilityLines: [],
      signalsUsed: [],
      omittedSignals: [],
    },
    preferences,
    generatedAt: new Date().toISOString(),
  };
}
