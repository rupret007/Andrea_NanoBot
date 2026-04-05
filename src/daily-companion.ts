import {
  buildCalendarLookupSnapshot,
  lookupCalendarAssistantEvents,
  planCalendarAssistantLookup,
  type CalendarEvent,
  type CalendarLookupSnapshot,
} from './calendar-assistant.js';
import { TIMEZONE } from './config.js';
import {
  buildGroundedDaySnapshot,
  formatClock,
  formatEventSummary,
  formatWindow,
  type DailyCommandCenterDeps,
  type GroundedDaySnapshot,
  type UpcomingReminderSummary,
} from './daily-command-center.js';
import { listProfileFactsForGroup } from './db.js';
import {
  buildCompanionTextureLine,
  COMPANION_TONE_FACT_KEY,
  resolveCompanionToneProfileFromFacts,
} from './companion-personality.js';
import {
  buildLifeThreadSnapshot,
  findLifeThreadForExplicitLookup,
} from './life-threads.js';
import type {
  AlexaConversationFollowupAction,
  AlexaConversationSubjectKind,
  CompanionToneProfile,
  LifeThread,
  PersonalityCooldownState,
  ProfileFactWithSubject,
} from './types.js';
import { buildVoiceReply, normalizeVoicePrompt } from './voice-ready.js';

export type DailyCompanionMode =
  | 'morning_brief'
  | 'midday_reground'
  | 'evening_reset'
  | 'open_guidance'
  | 'household_guidance';

export type DailyCompanionChannel = 'telegram' | 'alexa' | 'bluebubbles';

export type DailyCompanionRecommendationKind =
  | 'do_now'
  | 'save_for_tomorrow'
  | 'remind_later'
  | 'none';

export interface DailyCompanionContext {
  version: 1;
  mode: DailyCompanionMode;
  channel: DailyCompanionChannel;
  generatedAt: string;
  summaryText: string;
  shortText: string;
  extendedText: string;
  leadReason: string;
  signalsUsed: string[];
  signalsOmitted: string[];
  householdSignals: string[];
  recommendationKind: DailyCompanionRecommendationKind;
  recommendationText: string | null;
  subjectKind: AlexaConversationSubjectKind;
  supportedFollowups: AlexaConversationFollowupAction[];
  subjectData: {
    personName?: string;
    activePeople?: string[];
    householdFocus?: boolean;
  };
  extraDetails: string[];
  memoryLines: string[];
  usedThreadIds: string[];
  usedThreadTitles: string[];
  usedThreadReasons: string[];
  threadSummaryLines: string[];
  comparisonKeys: {
    nextEvent: string | null;
    nextReminder: string | null;
    recommendation: string | null;
    household: string | null;
    focus: string | null;
    thread: string | null;
  };
  toneProfile: CompanionToneProfile;
  personalityCooldown?: PersonalityCooldownState;
}

export interface DailyCompanionResponse {
  reply: string;
  mode: DailyCompanionMode;
  channel: DailyCompanionChannel;
  leadReason: string;
  signalsUsed: string[];
  signalsOmitted: string[];
  householdSignals: string[];
  recommendationKind: DailyCompanionRecommendationKind;
  context: DailyCompanionContext;
  grounded: GroundedDaySnapshot | null;
}

export interface DailyCompanionDeps extends DailyCommandCenterDeps {
  channel: DailyCompanionChannel;
  groupFolder?: string;
  priorContext?: DailyCompanionContext | null;
}

interface CompanionPreferences {
  familyContextEnabled: boolean;
  workContextEnabled: boolean;
  directMode: boolean;
  mainThingFirst: boolean;
  toneProfile: CompanionToneProfile;
}

interface CompanionDraft {
  mode: DailyCompanionMode;
  subjectKind: AlexaConversationSubjectKind;
  subjectData: DailyCompanionContext['subjectData'];
  supportedFollowups: AlexaConversationFollowupAction[];
  lead: string;
  leadReason: string;
  detailLines: string[];
  extraDetails: string[];
  recommendationText: string | null;
  recommendationKind: DailyCompanionRecommendationKind;
  signalsUsed: string[];
  signalsOmitted: string[];
  householdSignals: string[];
  memoryLines: string[];
  usedThreadIds: string[];
  usedThreadTitles: string[];
  usedThreadReasons: string[];
  threadSummaryLines: string[];
  comparisonKeys: DailyCompanionContext['comparisonKeys'];
}

const HOUSEHOLD_KEYWORD_RE = /\b(candace|family|household|travis|kids?|tonight|dinner|school|practice|pickup|dropoff|game)\b/i;

function normalizeMessage(message: string): string {
  return normalizeVoicePrompt(message).toLowerCase().trim();
}

function isMorningPrompt(normalized: string): boolean {
  return (
    /^(good morning)\b/.test(normalized) ||
    normalized === 'what matters today?' ||
    normalized === 'what matters today' ||
    normalized === 'what should i know about today?' ||
    normalized === 'what should i know about today' ||
    normalized === 'give me my morning brief' ||
    normalized === 'what should i know this morning?' ||
    normalized === 'what should i know this morning' ||
    normalized === "what's my day look like?" ||
    normalized === "what's my day look like" ||
    normalized === 'whats my day look like?' ||
    normalized === 'whats my day look like' ||
    normalized === 'give me my day'
  );
}

function isMiddayPrompt(normalized: string): boolean {
  return (
    normalized === 'what do i have coming up soon?' ||
    normalized === 'what do i have coming up soon' ||
    normalized === "what's still open today?" ||
    normalized === "what's still open today" ||
    normalized === 'whats still open today?' ||
    normalized === 'whats still open today' ||
    normalized === "what's next?" ||
    normalized === "what's next" ||
    normalized === 'whats next?' ||
    normalized === 'whats next' ||
    normalized === 'what should i do now?' ||
    normalized === 'what should i do now' ||
    normalized === 'what changed?' ||
    normalized === 'what changed' ||
    normalized === 'what can i still get done today?' ||
    normalized === 'what can i still get done today' ||
    normalized === 'what should i handle before my next meeting?' ||
    normalized === 'what should i handle before my next meeting' ||
    normalized === 'anything i should know?' ||
    normalized === 'anything i should know'
  );
}

function isEveningPrompt(normalized: string): boolean {
  return (
    normalized === 'what should i remember tonight?' ||
    normalized === 'what should i remember tonight' ||
    normalized === "what's left for today?" ||
    normalized === "what's left for today" ||
    normalized === 'whats left for today?' ||
    normalized === 'whats left for today' ||
    normalized === 'what should i follow up on before tomorrow?' ||
    normalized === 'what should i follow up on before tomorrow' ||
    normalized === 'give me an evening reset' ||
    normalized === 'what do i need to carry into tomorrow?' ||
    normalized === 'what do i need to carry into tomorrow'
  );
}

function isOpenGuidancePrompt(normalized: string): boolean {
  return (
    normalized === 'what is on my calendar tomorrow?' ||
    normalized === 'what is on my calendar tomorrow' ||
    normalized === "what's still open?" ||
    normalized === "what's still open" ||
    normalized === 'whats still open?' ||
    normalized === 'whats still open' ||
    normalized === 'what am i forgetting?' ||
    normalized === 'what am i forgetting' ||
    normalized === 'what exactly am i forgetting?' ||
    normalized === 'what exactly am i forgetting' ||
    normalized === 'exactly what am i forgetting?' ||
    normalized === 'exactly what am i forgetting' ||
    normalized === "tell me what i'm forgetting" ||
    normalized === 'tell me what im forgetting' ||
    normalized === 'what should i follow up on?' ||
    normalized === 'what should i follow up on' ||
    normalized === 'what matters most today?' ||
    normalized === 'what matters most today' ||
    normalized === 'what should i do next?' ||
    normalized === 'what should i do next' ||
    normalized === 'what am i juggling right now?' ||
    normalized === 'what am i juggling right now' ||
    normalized === 'anything i should know?' ||
    normalized === 'anything i should know' ||
    normalized === 'what should i handle before i leave?' ||
    normalized === 'what should i handle before i leave' ||
    normalized === 'what should i remember tonight?' ||
    normalized === 'what should i remember tonight'
  );
}

function isHouseholdPrompt(normalized: string): boolean {
  return (
    /candace and i/.test(normalized) ||
    /^what('?s| is)? still open with [a-z][a-z' -]+\??$/.test(normalized) ||
    /^what still open with [a-z][a-z' -]+\??$/.test(normalized) ||
    /^what about [a-z][a-z' -]+$/.test(normalized) ||
    /^what should i talk to [a-z][a-z' -]+ about\??$/.test(normalized) ||
    /^anything .*family.*forgetting\??$/.test(normalized) ||
    /^what do i need to follow up on at home\??$/.test(normalized) ||
    /^what do i need to follow up on with [a-z][a-z' -]+\??$/.test(normalized) ||
    /\bfamily\b/.test(normalized) ||
    /\bhousehold\b/.test(normalized)
  );
}

function isLooseEndsPrompt(normalized: string): boolean {
  return (
    normalized === "what's still open?" ||
    normalized === "what's still open" ||
    normalized === 'whats still open?' ||
    normalized === 'whats still open' ||
    normalized === 'what am i forgetting?' ||
    normalized === 'what am i forgetting' ||
    normalized === 'what exactly am i forgetting?' ||
    normalized === 'what exactly am i forgetting' ||
    normalized === 'exactly what am i forgetting?' ||
    normalized === 'exactly what am i forgetting' ||
    normalized === "tell me what i'm forgetting" ||
    normalized === 'tell me what im forgetting' ||
    normalized === 'what should i follow up on?' ||
    normalized === 'what should i follow up on'
  );
}

function extractExplicitHouseholdPerson(normalized: string): string | undefined {
  const stillOpenMatch = normalized.match(
    /^what('?s| is)? still open with ([a-z][a-z' -]+)\??$/,
  );
  if (stillOpenMatch?.[2]) {
    return stillOpenMatch[2].trim();
  }
  const whatAboutMatch = normalized.match(/^what about ([a-z][a-z' -]+)$/);
  if (whatAboutMatch?.[1]) {
    return whatAboutMatch[1].trim();
  }
  const talkToMatch = normalized.match(
    /^what should i talk to ([a-z][a-z' -]+) about\??$/,
  );
  if (talkToMatch?.[1]) {
    return talkToMatch[1].trim();
  }
  const followUpMatch = normalized.match(
    /^what do i need to follow up on with ([a-z][a-z' -]+)\??$/,
  );
  if (followUpMatch?.[1]) {
    return followUpMatch[1].trim();
  }
  const sharedMatch = normalized.match(
    /^what (?:do|does|should) ([a-z][a-z' -]+?) and i\b/,
  );
  if (sharedMatch?.[1]) {
    return sharedMatch[1].trim();
  }
  const directMatch = normalized.match(/\b(candace|travis)\b/i);
  return directMatch?.[1]?.trim();
}

function formatPersonDisplayName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function isPotentialDailyCompanionPrompt(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  return (
    isMorningPrompt(normalized) ||
    isMiddayPrompt(normalized) ||
    isEveningPrompt(normalized) ||
    isOpenGuidancePrompt(normalized) ||
    isHouseholdPrompt(normalized)
  );
}

function isAnythingElsePrompt(normalized: string): boolean {
  return /^(anything else|anything more|what else)\b/.test(normalized);
}

function isSayMorePrompt(normalized: string): boolean {
  return /^(say more|tell me more|give me a little more detail)\b/.test(
    normalized,
  );
}

function isShorterPrompt(normalized: string): boolean {
  return /^(shorter|make that shorter|say that shorter|be (?:a little |a bit )?more direct|more direct|keep it more direct)\b/.test(
    normalized,
  );
}

function isExplainabilityPrompt(normalized: string): boolean {
  return (
    /^why[!?]*$/.test(normalized) ||
    /^(what are you using to answer this|what are you using to answer that)\b/.test(
      normalized,
    ) ||
    /^(why did you say that)\b/.test(normalized)
  );
}

function isMemoryAffectingPrompt(normalized: string): boolean {
  return /^(what do you remember that affects this|what do you remember that affects that)\b/.test(
    normalized,
  );
}

function isWhatChangedPrompt(normalized: string): boolean {
  return /^(what changed|what has changed)\b/.test(normalized);
}

function isActionGuidancePrompt(normalized: string): boolean {
  return /^(what should i do about that|what should i handle about that)\b/.test(
    normalized,
  );
}

function isRiskPrompt(normalized: string): boolean {
  return /^(should i be worried about anything|is there anything i should worry about)\b/.test(
    normalized,
  );
}

function formatReminderSummary(
  reminder: UpcomingReminderSummary,
  timeZone: string,
): string {
  return `${formatClock(new Date(reminder.nextRunIso), timeZone)} ${reminder.label}`;
}

function summarizeEvent(event: CalendarEvent | null, timeZone: string): string | null {
  if (!event) return null;
  return formatEventSummary(event, timeZone);
}

function summarizeWindow(
  snapshot: GroundedDaySnapshot,
): { label: string; minutes: number } | null {
  const nextWindow = snapshot.meaningfulOpenWindows[0];
  if (!nextWindow) return null;
  const minutes = Math.max(
    0,
    Math.round((nextWindow.end.getTime() - nextWindow.start.getTime()) / 60000),
  );
  return {
    label: formatWindow(nextWindow, snapshot.timeZone),
    minutes,
  };
}

function summarizeThread(thread: LifeThread | null): string | null {
  if (!thread) return null;
  const detail = thread.nextAction || thread.summary;
  return `${thread.title}: ${detail}`;
}

function summarizeThreadDetail(thread: LifeThread | null): string | null {
  if (!thread) return null;
  return thread.nextAction || thread.summary || null;
}

function humanizePersonThreadDetail(
  detail: string | null,
  personDisplayName: string | undefined,
): string | null {
  if (!detail) return null;
  if (!personDisplayName) return detail;

  const escapedName = personDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return detail
    .replace(new RegExp(`^talk to ${escapedName} about\\s+`, 'i'), '')
    .replace(new RegExp(`^talk with ${escapedName} about\\s+`, 'i'), '')
    .replace(new RegExp(`^follow up with ${escapedName} about\\s+`, 'i'), '')
    .trim();
}

function trimTerminalPunctuation(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[.!?]+$/, '').trim();
}

function normalizeHouseholdDetail(value: string | null): string | null {
  const trimmed = trimTerminalPunctuation(value);
  if (!trimmed) return null;
  if (
    /^[A-Z][a-z]/.test(trimmed) &&
    /\b(still need|still needs|needs|need|is|are|has|have|waiting on|owed)\b/i.test(
      trimmed,
    )
  ) {
    return `${trimmed[0]!.toLowerCase()}${trimmed.slice(1)}`;
  }
  return trimmed;
}

function buildPersonRecommendationPhrase(detail: string | null): string | null {
  const normalized = normalizeHouseholdDetail(detail);
  if (!normalized) return null;
  const unresolvedMatch = normalized.match(
    /^(.+?)\s+(still need|still needs|needs|need)\b/i,
  );
  if (unresolvedMatch) {
    return `about ${unresolvedMatch[1]!.trim()}`;
  }
  if (
    /^(confirm|check|ask|review|send|decide|follow up on|talk through)\b/i.test(
      normalized,
    )
  ) {
    return `to ${normalized}`;
  }
  return `about ${normalized}`;
}

function findBestMatchingThread(
  threads: LifeThread[],
  query: string,
): LifeThread | null {
  const normalizedQuery = query.toLowerCase().trim();
  return (
    threads.find((thread) => thread.title.toLowerCase().includes(normalizedQuery)) ||
    threads.find((thread) =>
      thread.contextTags.some((tag) => tag.toLowerCase().includes(normalizedQuery)),
    ) ||
    null
  );
}

function buildThreadContextDetails(params: {
  dueThread: LifeThread | null;
  householdThread: LifeThread | null;
  recommendedThread: LifeThread | null;
}): Pick<
  CompanionDraft,
  'usedThreadIds' | 'usedThreadTitles' | 'usedThreadReasons' | 'threadSummaryLines'
> {
  const seen = new Set<string>();
  const usedThreadIds: string[] = [];
  const usedThreadTitles: string[] = [];
  const usedThreadReasons: string[] = [];
  const threadSummaryLines: string[] = [];

  const push = (thread: LifeThread | null, reason: string) => {
    if (!thread || seen.has(thread.id)) return;
    seen.add(thread.id);
    usedThreadIds.push(thread.id);
    usedThreadTitles.push(thread.title);
    usedThreadReasons.push(reason);
    threadSummaryLines.push(summarizeThread(thread) || thread.title);
  };

  push(params.dueThread, 'it still has an active follow-up');
  push(params.householdThread, 'it is the main household carryover');
  push(params.recommendedThread, 'it best fits the next open block');

  return {
    usedThreadIds,
    usedThreadTitles,
    usedThreadReasons,
    threadSummaryLines,
  };
}

function buildKnownHouseholdTerms(facts: ProfileFactWithSubject[]): string[] {
  const terms = new Set<string>(['candace', 'family', 'household', 'travis']);
  for (const fact of facts) {
    if (fact.subjectKind === 'person') {
      terms.add(fact.subjectDisplayName.toLowerCase());
    }
  }
  return [...terms];
}

function parsePreferences(facts: ProfileFactWithSubject[]): CompanionPreferences {
  let familyContextEnabled = true;
  let workContextEnabled = true;
  let directMode = false;
  let mainThingFirst = false;
  const toneProfile = resolveCompanionToneProfileFromFacts(facts);

  for (const fact of facts) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(fact.valueJson) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (fact.factKey === 'family_context_default') {
      familyContextEnabled = parsed.enabled !== false;
    }
    if (fact.factKey === 'work_context_default') {
      workContextEnabled = parsed.enabled !== false;
    }
    if (fact.factKey === 'response_style') {
      directMode = parsed.mode === 'short_direct';
    }
    if (fact.factKey === 'guidance_focus') {
      mainThingFirst = parsed.mode === 'main_thing_first';
    }
  }

  return {
    familyContextEnabled,
    workContextEnabled,
    directMode,
    mainThingFirst,
    toneProfile,
  };
}

function describeMemoryFact(fact: ProfileFactWithSubject): string | null {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fact.valueJson) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  switch (fact.factKey) {
    case 'family_context_default':
      return parsed.enabled === false
        ? 'family context should stay lighter unless you ask for it'
        : 'family context is okay when it is clearly relevant';
    case 'work_context_default':
      return parsed.enabled === false
        ? 'work context should stay in the background unless you ask for it'
        : 'work context can be foregrounded when it is relevant';
    case 'guidance_focus':
      return 'you want the main thing first on broad guidance questions';
    case 'response_style':
      return parsed.mode === 'short_direct'
        ? 'you prefer shorter, more direct answers'
        : null;
    case COMPANION_TONE_FACT_KEY:
      return parsed.mode === 'plain'
        ? 'you want Andrea to keep the tone plain and low-flourish'
        : parsed.mode === 'warmer'
          ? 'you are okay with a little extra warmth when it fits'
          : 'you prefer a balanced tone';
    default:
      break;
  }

  if (fact.category === 'relationships') {
    const relation =
      typeof parsed.relation === 'string' ? parsed.relation : 'family';
    return `${fact.subjectDisplayName} is your ${relation}`;
  }

  if (fact.factKey.startsWith('note:')) {
    const summary =
      typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    return summary || null;
  }

  return null;
}

function collectMemoryLines(
  groupFolder: string | undefined,
  householdExplicit: boolean,
): string[] {
  if (!groupFolder) return [];
  const facts = listProfileFactsForGroup(groupFolder, ['accepted']);
  return facts
    .map(describeMemoryFact)
    .filter((line): line is string => Boolean(line))
    .filter((line, index, items) => items.indexOf(line) === index)
    .slice(0, householdExplicit ? 4 : 3);
}

async function loadScopedSnapshot(
  query: string,
  deps: DailyCompanionDeps,
): Promise<CalendarLookupSnapshot | null> {
  const now = deps.now || new Date();
  const timeZone = deps.timeZone || TIMEZONE;
  const plan = planCalendarAssistantLookup(
    query,
    now,
    timeZone,
    deps.activeEventContext || null,
  );
  if (!plan || plan.clarificationQuestion) {
    return null;
  }

  const result = await lookupCalendarAssistantEvents(plan, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    platform: deps.platform,
    runAppleCalendarScript: deps.runAppleCalendarScript,
    activeEventContext: deps.activeEventContext || null,
  });
  return buildCalendarLookupSnapshot(result);
}

function selectHouseholdLines(params: {
  snapshot: GroundedDaySnapshot;
  scopedSnapshot: CalendarLookupSnapshot | null;
  facts: ProfileFactWithSubject[];
  householdExplicit: boolean;
}): string[] {
  const knownTerms = buildKnownHouseholdTerms(params.facts);
  const householdEvents = (
    params.scopedSnapshot?.timedEvents.length
      ? params.scopedSnapshot.timedEvents
      : params.snapshot.calendar.timedEvents
  )
    .filter((event) => {
      const haystack = `${event.title} ${event.calendarName || ''}`.toLowerCase();
      if (params.householdExplicit) {
        return knownTerms.some((term) => haystack.includes(term));
      }
      return HOUSEHOLD_KEYWORD_RE.test(haystack);
    })
    .slice(0, 2)
    .map((event) => summarizeEvent(event, params.snapshot.timeZone))
    .filter((line): line is string => Boolean(line));

  const householdReminders = params.snapshot.todayReminders
    .filter((reminder) => {
      const haystack = reminder.label.toLowerCase();
      if (params.householdExplicit) {
        return knownTerms.some((term) => haystack.includes(term));
      }
      return HOUSEHOLD_KEYWORD_RE.test(haystack);
    })
    .slice(0, 1)
    .map((reminder) => formatReminderSummary(reminder, params.snapshot.timeZone));

  return [...householdEvents, ...householdReminders].slice(0, 2);
}

function chooseRecommendation(
  snapshot: GroundedDaySnapshot,
  prefs: CompanionPreferences,
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>,
): {
  text: string | null;
  kind: DailyCompanionRecommendationKind;
  focusKey: string | null;
} {
  const work = snapshot.selectedWork;
  const nextEvent = snapshot.calendar.nextTimedEvent;
  const nextReminder = snapshot.todayReminders[0];
  const nextWindow = summarizeWindow(snapshot);
  const dueThread = threadSnapshot.dueFollowups[0] || null;
  const recommendedThread = threadSnapshot.recommendedNextThread;

  if (
    prefs.workContextEnabled &&
    work &&
    nextWindow &&
    nextWindow.minutes >= 20 &&
    snapshot.currentFocus.reason === 'selected_work'
  ) {
    return {
      text: `Use the next open block to move ${work.title} forward.`,
      kind: 'do_now',
      focusKey: `work:${work.title}`,
    };
  }

  if (dueThread && nextWindow && nextWindow.minutes >= 15) {
    return {
      text: `Use the next open block to move ${dueThread.title} forward by ${dueThread.nextAction || dueThread.summary}.`,
      kind: 'do_now',
      focusKey: `thread:${dueThread.id}`,
    };
  }

  if (nextReminder) {
    return {
      text: `Stay ahead of ${nextReminder.label} before it turns into a scramble.`,
      kind: 'do_now',
      focusKey: `reminder:${nextReminder.id}`,
    };
  }

  if (nextEvent) {
    return {
      text: `Get yourself ready for ${nextEvent.title} before ${formatClock(
        new Date(nextEvent.startIso),
        snapshot.timeZone,
      )}.`,
      kind: 'do_now',
      focusKey: `event:${nextEvent.id}`,
    };
  }

  if (work && prefs.workContextEnabled) {
    return {
      text: `Keep ${work.title} as the main thread when you get your next clean block.`,
      kind: 'save_for_tomorrow',
      focusKey: `work:${work.title}`,
    };
  }

  if (recommendedThread) {
    return {
      text: `Keep ${recommendedThread.title} on deck so it does not slip past today.`,
      kind: recommendedThread.nextFollowupAt ? 'do_now' : 'save_for_tomorrow',
      focusKey: `thread:${recommendedThread.id}`,
    };
  }

  return {
    text: null,
    kind: 'none',
    focusKey: null,
  };
}

function formatTextReply(
  lead: string,
  lines: string[],
  personalityLine?: string | null,
): string {
  return [lead, personalityLine, ...lines.filter(Boolean).map((line) => `- ${line}`)]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function humanizeAlexaDetailLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return trimmed;

  const replacements: Array<[RegExp, (value: string) => string]> = [
    [/^Next:\s+/i, (value) => `Next up is ${value}`],
    [/^Reminder:\s+/i, (value) => `You have ${value}`],
    [/^Open (?:window|block):\s+/i, (value) => `You also have an open stretch ${value}`],
    [/^Thread(?: carryover| follow-up)?:\s+/i, (value) => `One loose end is ${value}`],
    [/^Household(?: thread)?:\s+/i, (value) => `At home, ${value}`],
    [/^Shared plan:\s+/i, (value) => `The shared plan is ${value}`],
    [/^Also:\s+/i, (value) => `Also, ${value}`],
    [/^Current work:\s+/i, (value) => `Workwise, ${value}`],
    [/^Tomorrow pressure:\s+/i, (value) => `Tomorrow's pressure point is ${value}`],
    [/^Tomorrow:\s+/i, (value) => `Tomorrow, ${value}`],
    [/^Also tomorrow:\s+/i, (value) => `Also tomorrow, ${value}`],
    [/^Tonight:\s+/i, (value) => `Tonight, ${value}`],
    [/^Keep on deck:\s+/i, (value) => `Also keep in mind ${value}`],
  ];

  for (const [pattern, formatter] of replacements) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const value = trimmed.replace(pattern, '').trim();
    return ensureSentence(formatter(value));
  }

  return ensureSentence(trimmed);
}

function formatAlexaReply(
  lead: string,
  lines: string[],
  recommendation: string | null,
  directMode = false,
  personalityLine?: string | null,
): string {
  return buildVoiceReply({
    summary: ensureSentence(lead),
    details: [personalityLine, ...lines.slice(0, directMode ? 1 : 2), recommendation]
      .filter((line): line is string => Boolean(line))
      .map((line) => humanizeAlexaDetailLine(line)),
    maxDetails: directMode ? 1 : 2,
  });
}

function isLowStakesLeadReason(leadReason: string): boolean {
  return [
    'nothing_urgent',
    'weak_signal',
    'selected_work',
    'selected_work_open_block',
    'household_scope',
    'tomorrow_overview',
    'tomorrow_clear',
    'slipping_thread',
    'current_work',
  ].includes(leadReason);
}

function resolveTextureContext(
  mode: DailyCompanionMode,
): 'daily' | 'household' | 'evening' {
  if (mode === 'household_guidance') {
    return 'household';
  }
  if (mode === 'evening_reset') {
    return 'evening';
  }
  return 'daily';
}

function finalizeDraft(
  draft: CompanionDraft,
  channel: DailyCompanionChannel,
  now: Date,
  grounded: GroundedDaySnapshot | null,
  prefs: CompanionPreferences,
): DailyCompanionResponse {
  const personalityLine = buildCompanionTextureLine({
    channel,
    context: resolveTextureContext(draft.mode),
    toneProfile: prefs.toneProfile,
    directMode: prefs.directMode,
    lowStakes: isLowStakesLeadReason(draft.leadReason),
    leadReason: draft.leadReason,
  });
  const reply =
    channel === 'alexa'
      ? formatAlexaReply(
          draft.lead,
          draft.detailLines,
          draft.recommendationText,
          prefs.directMode,
          personalityLine,
        )
      : formatTextReply(draft.lead, [
          ...draft.detailLines,
          draft.recommendationText
            ? `Suggestion: ${draft.recommendationText}`
            : null,
        ].filter(Boolean) as string[], personalityLine);

  const shortText =
    channel === 'alexa'
      ? buildVoiceReply({
          summary: ensureSentence(draft.recommendationText || draft.lead),
          maxDetails: 0,
        })
      : draft.lead;
  const extendedText =
    channel === 'alexa'
      ? formatTextReply(draft.lead, [
          ...draft.detailLines,
          draft.recommendationText
            ? `Suggestion: ${draft.recommendationText}`
            : null,
        ].filter(Boolean) as string[], personalityLine)
      : reply;

  const context: DailyCompanionContext = {
    version: 1,
    mode: draft.mode,
    channel,
    generatedAt: now.toISOString(),
    summaryText: draft.lead,
    shortText,
    extendedText,
    leadReason: draft.leadReason,
    signalsUsed: draft.signalsUsed,
    signalsOmitted: draft.signalsOmitted,
    householdSignals: draft.householdSignals,
    recommendationKind: draft.recommendationKind,
    recommendationText: draft.recommendationText,
    subjectKind: draft.subjectKind,
    supportedFollowups: draft.supportedFollowups,
    subjectData: draft.subjectData,
    extraDetails: draft.extraDetails,
    memoryLines: draft.memoryLines,
    usedThreadIds: draft.usedThreadIds,
    usedThreadTitles: draft.usedThreadTitles,
    usedThreadReasons: draft.usedThreadReasons,
    threadSummaryLines: draft.threadSummaryLines,
    comparisonKeys: draft.comparisonKeys,
    toneProfile: prefs.toneProfile,
    personalityCooldown: personalityLine
      ? {
          lastTextureKind:
            draft.mode === 'household_guidance'
              ? 'transition'
              : draft.mode === 'evening_reset'
                ? 'closer'
                : 'transition',
          lastTexturedAt: now.toISOString(),
          cooldownTurnsRemaining: 2,
        }
      : {
          lastTextureKind: null,
          lastTexturedAt: null,
          cooldownTurnsRemaining: 0,
        },
  };

  return {
    reply,
    mode: draft.mode,
    channel,
    leadReason: draft.leadReason,
    signalsUsed: draft.signalsUsed,
    signalsOmitted: draft.signalsOmitted,
    householdSignals: draft.householdSignals,
    recommendationKind: draft.recommendationKind,
    context,
    grounded,
  };
}

function buildMorningDraft(params: {
  snapshot: GroundedDaySnapshot;
  householdLines: string[];
  prefs: CompanionPreferences;
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
}): CompanionDraft {
  const { snapshot } = params;
  const nextEvent = snapshot.calendar.nextTimedEvent;
  const nextReminder = snapshot.todayReminders[0] || null;
  const window = summarizeWindow(snapshot);
  const dueThread = params.threadSnapshot.dueFollowups[0] || null;
  const householdThread =
    params.threadSnapshot.householdCarryover &&
    !params.householdLines.some((line) =>
      line.includes(params.threadSnapshot.householdCarryover?.title || ''),
    )
      ? params.threadSnapshot.householdCarryover
      : null;
  const recommendation = chooseRecommendation(
    snapshot,
    params.prefs,
    params.threadSnapshot,
  );
  const threadContext = buildThreadContextDetails({
    dueThread,
    householdThread,
    recommendedThread: params.threadSnapshot.recommendedNextThread,
  });

  let lead = 'Today looks fairly open right now, so you can start from a clean read of it.';
  let leadReason = 'nothing_urgent';
  if (nextReminder) {
    lead = `The first thing I would keep in mind is ${nextReminder.label} at ${formatClock(
      new Date(nextReminder.nextRunIso),
      snapshot.timeZone,
    )}.`;
    leadReason = 'due_soon_reminder';
  } else if (nextEvent) {
    lead = `The first fixed point in your day is ${nextEvent.title} at ${formatClock(
      new Date(nextEvent.startIso),
      snapshot.timeZone,
    )}.`;
    leadReason = 'next_timed_event';
  } else if (snapshot.selectedWork && window && params.prefs.workContextEnabled) {
    lead = `You have open room to make progress on ${snapshot.selectedWork.title}.`;
    leadReason = 'selected_work_open_block';
  } else if (dueThread) {
    lead = `One carryover to keep in sight is ${dueThread.title}.`;
    leadReason = 'thread_carryover';
  } else if (params.householdLines[0]) {
    lead = `One family thing worth keeping in mind is ${params.householdLines[0]}.`;
    leadReason = 'household_signal';
  }

  const detailLines = [
    nextEvent ? `Next: ${summarizeEvent(nextEvent, snapshot.timeZone)}` : null,
    nextReminder ? `Reminder: ${formatReminderSummary(nextReminder, snapshot.timeZone)}` : null,
    window ? `Open window: ${window.label}` : null,
    dueThread ? `Thread carryover: ${summarizeThread(dueThread)}` : null,
    params.householdLines[0] ? `Household: ${params.householdLines[0]}` : null,
    householdThread ? `Household thread: ${summarizeThread(householdThread)}` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    mode: 'morning_brief',
    subjectKind: params.householdLines.length > 0 ? 'household' : 'day_brief',
    subjectData:
      params.householdLines.length > 0
        ? { householdFocus: true, activePeople: ['Candace'] }
        : {},
    supportedFollowups: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'risk_check',
      'memory_control',
    ],
    lead,
    leadReason,
    detailLines,
    extraDetails: detailLines.slice(1),
    recommendationText: recommendation.text,
    recommendationKind: recommendation.kind,
    signalsUsed: [
      'calendar',
      nextReminder ? 'reminders' : null,
      snapshot.selectedWork && params.prefs.workContextEnabled ? 'current_work' : null,
      dueThread || householdThread ? 'life_threads' : null,
      params.householdLines.length > 0 ? 'household_context' : null,
    ].filter((line): line is string => Boolean(line)),
    signalsOmitted: [
      !params.prefs.familyContextEnabled && params.householdLines.length === 0
        ? 'family_context_suppressed'
        : null,
    ].filter((line): line is string => Boolean(line)),
    householdSignals: params.householdLines,
    memoryLines: params.memoryLines,
    usedThreadIds: threadContext.usedThreadIds,
    usedThreadTitles: threadContext.usedThreadTitles,
    usedThreadReasons: threadContext.usedThreadReasons,
    threadSummaryLines: threadContext.threadSummaryLines,
    comparisonKeys: {
      nextEvent: nextEvent ? `${nextEvent.id}:${nextEvent.startIso}` : null,
      nextReminder: nextReminder ? `${nextReminder.id}:${nextReminder.nextRunIso}` : null,
      recommendation: recommendation.text,
      household: params.householdLines[0] || null,
      focus: recommendation.focusKey,
      thread: threadContext.threadSummaryLines[0] || null,
    },
  };
}

function buildMiddayDraft(params: {
  snapshot: GroundedDaySnapshot;
  householdLines: string[];
  prefs: CompanionPreferences;
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
}): CompanionDraft {
  const { snapshot } = params;
  const nextEvent = snapshot.calendar.nextTimedEvent;
  const nextReminder = snapshot.todayReminders[0] || null;
  const window = summarizeWindow(snapshot);
  const dueThread = params.threadSnapshot.dueFollowups[0] || null;
  const recommendation = chooseRecommendation(
    snapshot,
    params.prefs,
    params.threadSnapshot,
  );
  const threadContext = buildThreadContextDetails({
    dueThread,
    householdThread: params.threadSnapshot.householdCarryover,
    recommendedThread: params.threadSnapshot.recommendedNextThread,
  });

  let lead = 'The clearest next anchor is your schedule right now.';
  let leadReason = 'schedule_only';
  if (snapshot.selectedWork && recommendation.focusKey?.startsWith('work:')) {
    lead = `The best next move is still ${snapshot.selectedWork.title}.`;
    leadReason = 'selected_work';
  } else if (dueThread) {
    lead = `The main loose end right now is ${dueThread.title}.`;
    leadReason = 'thread_followup';
  } else if (nextEvent) {
    lead = `The next fixed point is ${nextEvent.title} at ${formatClock(
      new Date(nextEvent.startIso),
      snapshot.timeZone,
    )}.`;
    leadReason = 'next_event';
  } else if (nextReminder) {
    lead = `The next thing that can sneak up on you is ${nextReminder.label}.`;
    leadReason = 'next_reminder';
  }

  const detailLines = [
    snapshot.selectedWork && params.prefs.workContextEnabled
      ? `Current work: ${snapshot.selectedWork.title} (${snapshot.selectedWork.statusLabel})`
      : null,
    nextEvent ? `Next: ${summarizeEvent(nextEvent, snapshot.timeZone)}` : null,
    nextReminder ? `Reminder: ${formatReminderSummary(nextReminder, snapshot.timeZone)}` : null,
    window ? `Open block: ${window.label}` : null,
    dueThread ? `Thread follow-up: ${summarizeThread(dueThread)}` : null,
    params.householdLines[0] ? `Household: ${params.householdLines[0]}` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    mode: 'midday_reground',
    subjectKind: params.householdLines.length > 0 ? 'household' : 'day_brief',
    subjectData:
      params.householdLines.length > 0 ? { householdFocus: true } : {},
    supportedFollowups: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'risk_check',
      'memory_control',
    ],
    lead,
    leadReason,
    detailLines,
    extraDetails: detailLines.slice(1),
    recommendationText: recommendation.text,
    recommendationKind: recommendation.kind,
    signalsUsed: [
      'calendar',
      nextReminder ? 'reminders' : null,
      snapshot.selectedWork && params.prefs.workContextEnabled ? 'current_work' : null,
      threadContext.threadSummaryLines[0] ? 'life_threads' : null,
      params.householdLines.length > 0 ? 'household_context' : null,
    ].filter((line): line is string => Boolean(line)),
    signalsOmitted: [],
    householdSignals: params.householdLines,
    memoryLines: params.memoryLines,
    usedThreadIds: threadContext.usedThreadIds,
    usedThreadTitles: threadContext.usedThreadTitles,
    usedThreadReasons: threadContext.usedThreadReasons,
    threadSummaryLines: threadContext.threadSummaryLines,
    comparisonKeys: {
      nextEvent: nextEvent ? `${nextEvent.id}:${nextEvent.startIso}` : null,
      nextReminder: nextReminder ? `${nextReminder.id}:${nextReminder.nextRunIso}` : null,
      recommendation: recommendation.text,
      household: params.householdLines[0] || null,
      focus: recommendation.focusKey,
      thread: threadContext.threadSummaryLines[0] || null,
    },
  };
}

function buildEveningDraft(params: {
  snapshot: GroundedDaySnapshot;
  tomorrowSnapshot: CalendarLookupSnapshot | null;
  householdLines: string[];
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
}): CompanionDraft {
  const tonightReminder = params.snapshot.todayReminders[0] || null;
  const tomorrowPressure = params.tomorrowSnapshot?.nextTimedEvent || null;
  const dueThread = params.threadSnapshot.dueFollowups[0] || null;
  const householdThread =
    params.threadSnapshot.householdCarryover &&
    !params.householdLines.some((line) =>
      line.includes(params.threadSnapshot.householdCarryover?.title || ''),
    )
      ? params.threadSnapshot.householdCarryover
      : null;
  const threadContext = buildThreadContextDetails({
    dueThread,
    householdThread,
    recommendedThread: params.threadSnapshot.recommendedNextThread,
  });
  const recommendationKind =
    tonightReminder || dueThread || params.householdLines[0] || householdThread
      ? 'do_now'
      : tomorrowPressure
        ? 'save_for_tomorrow'
        : 'remind_later';
  const recommendationText = tonightReminder
    ? `Handle ${tonightReminder.label} tonight so it is not hanging over tomorrow.`
    : dueThread
      ? `Close the loop on ${dueThread.title} tonight by ${dueThread.nextAction || dueThread.summary}.`
    : params.householdLines[0]
      ? `Close the loop on ${params.householdLines[0]} before the evening gets away from you.`
      : householdThread
        ? `Close the loop on ${householdThread.title} before the night gets away from you.`
      : tomorrowPressure
        ? `Set yourself up for ${tomorrowPressure.title} before tomorrow starts.`
        : 'If nothing else moves tonight, leave yourself one clean reminder for tomorrow.';

  const lead = tonightReminder
    ? `Tonight's loose end is ${tonightReminder.label}.`
    : dueThread
      ? `The open thread to close tonight is ${dueThread.title}.`
    : tomorrowPressure
      ? `Tomorrow's first pressure point is ${tomorrowPressure.title} at ${formatClock(
          new Date(tomorrowPressure.startIso),
          params.snapshot.timeZone,
        )}.`
    : 'Tonight looks fairly calm, so this is mostly about closing the right loop.';

  const detailLines = [
    tonightReminder
      ? `Tonight: ${formatReminderSummary(tonightReminder, params.snapshot.timeZone)}`
      : null,
    dueThread ? `Thread: ${summarizeThread(dueThread)}` : null,
    tomorrowPressure
      ? `Tomorrow: ${summarizeEvent(tomorrowPressure, params.snapshot.timeZone)}`
      : null,
    params.householdLines[0] ? `Household: ${params.householdLines[0]}` : null,
    householdThread ? `Household thread: ${summarizeThread(householdThread)}` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    mode: 'evening_reset',
    subjectKind: params.householdLines.length > 0 ? 'household' : 'day_brief',
    subjectData:
      params.householdLines.length > 0 ? { householdFocus: true } : {},
    supportedFollowups: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'risk_check',
      'memory_control',
    ],
    lead,
    leadReason: tonightReminder ? 'unfinished_today' : 'tomorrow_pressure',
    detailLines,
    extraDetails: detailLines.slice(1),
    recommendationText,
    recommendationKind,
    signalsUsed: [
      'calendar',
      tonightReminder ? 'reminders' : null,
      threadContext.threadSummaryLines[0] ? 'life_threads' : null,
      params.householdLines.length > 0 ? 'household_context' : null,
    ].filter((line): line is string => Boolean(line)),
    signalsOmitted: [],
    householdSignals: params.householdLines,
    memoryLines: params.memoryLines,
    usedThreadIds: threadContext.usedThreadIds,
    usedThreadTitles: threadContext.usedThreadTitles,
    usedThreadReasons: threadContext.usedThreadReasons,
    threadSummaryLines: threadContext.threadSummaryLines,
    comparisonKeys: {
      nextEvent: tomorrowPressure
        ? `${tomorrowPressure.id}:${tomorrowPressure.startIso}`
        : null,
      nextReminder: tonightReminder
        ? `${tonightReminder.id}:${tonightReminder.nextRunIso}`
        : null,
      recommendation: recommendationText,
      household: params.householdLines[0] || null,
      focus: recommendationKind,
      thread: threadContext.threadSummaryLines[0] || null,
    },
  };
}

function detectHouseholdAskStyle(
  normalized: string,
): 'talk_about' | 'family_forgetting' | 'home_followup' | 'still_open' | 'shared_plans' {
  if (/^what should i talk to [a-z][a-z' -]+ about\??$/.test(normalized)) {
    return 'talk_about';
  }
  if (/^anything .*family.*forgetting\??$/.test(normalized)) {
    return 'family_forgetting';
  }
  if (
    /^what do i need to follow up on at home\??$/.test(normalized) ||
    /^what do i need to follow up on with [a-z][a-z' -]+\??$/.test(normalized)
  ) {
    return 'home_followup';
  }
  if (
    /^what('?s| is)? still open with [a-z][a-z' -]+\??$/.test(normalized) ||
    /^what still open with [a-z][a-z' -]+\??$/.test(normalized)
  ) {
    return 'still_open';
  }
  return 'shared_plans';
}

function buildHouseholdDraft(params: {
  snapshot: GroundedDaySnapshot;
  scopedSnapshot: CalendarLookupSnapshot | null;
  rawMessage: string;
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
  explicitThread?: LifeThread | null;
}): CompanionDraft {
  const events = (
    params.scopedSnapshot?.timedEvents.length
      ? params.scopedSnapshot.timedEvents
      : params.snapshot.calendar.timedEvents
  ).slice(0, 2);
  const allDay = (
    params.scopedSnapshot?.allDayEvents.length
      ? params.scopedSnapshot.allDayEvents
      : params.snapshot.calendar.allDayEvents
  ).slice(0, 1);
  const householdLines = [...events, ...allDay]
    .map((event) => summarizeEvent(event, params.snapshot.timeZone))
    .filter((line): line is string => Boolean(line));
  const personName = extractExplicitHouseholdPerson(params.rawMessage);
  const personDisplayName = formatPersonDisplayName(personName);
  const relatedThread =
    params.explicitThread ||
    (personName
      ? findBestMatchingThread(params.threadSnapshot.activeThreads, personName)
      : params.threadSnapshot.householdCarryover);
  const threadContext = buildThreadContextDetails({
    dueThread: relatedThread,
    householdThread: relatedThread,
    recommendedThread: relatedThread,
  });
  const askStyle = detectHouseholdAskStyle(params.rawMessage);
  const threadDetail = summarizeThreadDetail(relatedThread);
  const humanizedThreadDetail = humanizePersonThreadDetail(
    threadDetail,
    personDisplayName,
  );
  const personLeadDetail = normalizeHouseholdDetail(
    humanizedThreadDetail || relatedThread?.summary || relatedThread?.title || null,
  );
  const lead = personName
    ? askStyle === 'talk_about'
      ? personLeadDetail
        ? `A good thing to talk to ${personDisplayName} about is ${personLeadDetail}.`
        : householdLines[0]
          ? `A good thing to talk to ${personDisplayName} about is ${householdLines[0]}.`
          : `I do not see one strong thing to bring up with ${personDisplayName} right now.`
      : askStyle === 'still_open' || askStyle === 'home_followup'
        ? personLeadDetail
          ? `With ${personDisplayName}, the main loose end is ${personLeadDetail}.`
          : householdLines[0]
            ? `With ${personDisplayName}, the main thing on deck is ${householdLines[0]}.`
            : `I do not see a strong shared signal with ${personDisplayName} right now.`
        : personLeadDetail
          ? `The main thing still open with ${personDisplayName} is ${personLeadDetail}.`
          : householdLines[0]
            ? `The main shared thing with ${personDisplayName} is ${householdLines[0]}.`
            : `I do not see a strong shared signal with ${personDisplayName} right now.`
    : askStyle === 'family_forgetting'
      ? summarizeThread(relatedThread)
        ? `The main family thing to keep in mind is ${summarizeThread(relatedThread)}.`
        : householdLines[0]
          ? `The main family thing to keep in mind is ${householdLines[0]}.`
          : 'I do not see one strong family loose end right now.'
      : askStyle === 'home_followup'
        ? summarizeThread(relatedThread)
          ? `At home, the main loose end is ${summarizeThread(relatedThread)}.`
          : householdLines[0]
            ? `At home, the main thing on deck is ${householdLines[0]}.`
            : 'I do not see one strong home follow-up right now.'
        : summarizeThread(relatedThread)
          ? `The main family thing coming up is ${summarizeThread(relatedThread)}.`
          : householdLines[0]
            ? `The main shared family thing coming up is ${householdLines[0]}.`
            : 'I do not see a strong shared-family signal in the calendars I could read right now.';
  const recommendationText = relatedThread
    ? personName
      ? buildPersonRecommendationPhrase(personLeadDetail)
        ? `A quick check-in with ${personDisplayName} ${buildPersonRecommendationPhrase(personLeadDetail)} would close that loop.`
        : `A quick check-in with ${personDisplayName} would close that loop.`
      : `Bring up ${relatedThread.title} before it turns into a last-minute logistics problem.`
    : householdLines[0]
      ? 'Bring that up before it becomes a last-minute logistics problem.'
      : null;

  return {
    mode: 'household_guidance',
    subjectKind: personName ? 'person' : 'household',
    subjectData: {
      personName: personDisplayName,
      activePeople: personDisplayName ? [personDisplayName] : ['Candace'],
      householdFocus: true,
    },
    supportedFollowups: [
      'anything_else',
      'shorter',
      'say_more',
      'switch_person',
      'action_guidance',
      'memory_control',
    ],
    lead,
    leadReason: 'household_scope',
    detailLines: [
      personName ? null : relatedThread ? `Thread: ${summarizeThread(relatedThread)}` : null,
      ...householdLines.slice(0, 2).map((line, index) =>
        index === 0 ? `Shared plan: ${line}` : `Also: ${line}`,
      ),
    ].filter((line): line is string => Boolean(line)),
    extraDetails: householdLines.slice(1),
    recommendationText,
    recommendationKind: recommendationText ? 'do_now' : 'none',
    signalsUsed: ['calendar', 'household_context', relatedThread ? 'life_threads' : null].filter(
      (line): line is string => Boolean(line),
    ),
    signalsOmitted: [],
    householdSignals: householdLines,
    memoryLines: params.memoryLines,
    usedThreadIds: threadContext.usedThreadIds,
    usedThreadTitles: threadContext.usedThreadTitles,
    usedThreadReasons: threadContext.usedThreadReasons,
    threadSummaryLines: threadContext.threadSummaryLines,
    comparisonKeys: {
      nextEvent: events[0] ? `${events[0].id}:${events[0].startIso}` : null,
      nextReminder: null,
      recommendation: recommendationText,
      household: householdLines[0] || null,
      focus: personDisplayName || 'household',
      thread: threadContext.threadSummaryLines[0] || null,
    },
  };
}

function buildLooseEndsDraft(params: {
  snapshot: GroundedDaySnapshot;
  tomorrowSnapshot: CalendarLookupSnapshot | null;
  householdLines: string[];
  prefs: CompanionPreferences;
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
}): CompanionDraft {
  const dueReminder = params.snapshot.todayReminders[0] || null;
  const dueThread = params.threadSnapshot.dueFollowups[0] || null;
  const tomorrowPressure =
    params.tomorrowSnapshot?.nextTimedEvent ||
    params.tomorrowSnapshot?.timedEvents[0] ||
    params.tomorrowSnapshot?.allDayEvents[0] ||
    null;
  const slippingThread =
    params.threadSnapshot.recommendedNextThread &&
    params.threadSnapshot.recommendedNextThread.id !== dueThread?.id
      ? params.threadSnapshot.recommendedNextThread
      : null;
  const currentWork =
    params.snapshot.selectedWork && params.prefs.workContextEnabled
      ? params.snapshot.selectedWork
      : null;
  const threadContext = buildThreadContextDetails({
    dueThread,
    householdThread: params.threadSnapshot.householdCarryover,
    recommendedThread: slippingThread,
  });

  let lead =
    'Nothing is flashing red right now. If something still feels fuzzy, the safest move is to pin it down before it disappears again.';
  let leadReason = 'weak_signal';
  if (dueReminder) {
    lead = `The easiest thing to forget right now is ${dueReminder.label}.`;
    leadReason = 'due_reminder';
  } else if (dueThread) {
    lead = `The thread most likely to slip is ${dueThread.title}.`;
    leadReason = 'thread_followup';
  } else if (tomorrowPressure) {
    lead = `The next thing worth remembering is ${tomorrowPressure.title}${
      tomorrowPressure.allDay
        ? ' tomorrow.'
        : ` tomorrow at ${formatClock(new Date(tomorrowPressure.startIso), params.snapshot.timeZone)}.`
    }`;
    leadReason = 'tomorrow_pressure';
  } else if (slippingThread) {
    lead = `The thread most likely to drift is ${slippingThread.title}.`;
    leadReason = 'slipping_thread';
  } else if (currentWork) {
    lead = `The thing most likely to drift is ${currentWork.title} if you do not touch it again today.`;
    leadReason = 'current_work';
  }

  const recommendationText = dueReminder
    ? `Handle ${dueReminder.label} before the day gets away from you.`
    : dueThread
      ? `Close the loop on ${dueThread.title} by ${dueThread.nextAction || dueThread.summary}.`
      : tomorrowPressure
        ? `Set yourself up for ${tomorrowPressure.title} before tomorrow starts.`
        : slippingThread
          ? `Touch ${slippingThread.title} once tonight so it does not drift.`
          : currentWork
            ? `Either move ${currentWork.title} forward or save it as a reminder so it does not disappear.`
          : 'If something is still nagging at you, save one reminder before you leave it behind.';
  const recommendationKind: DailyCompanionRecommendationKind =
    dueReminder || dueThread
      ? 'do_now'
      : tomorrowPressure || slippingThread || currentWork
        ? 'save_for_tomorrow'
        : 'remind_later';
  const detailLines = [
    dueReminder
      ? `Reminder: ${formatReminderSummary(dueReminder, params.snapshot.timeZone)}`
      : null,
    dueThread ? `Thread follow-up: ${summarizeThread(dueThread)}` : null,
    tomorrowPressure
      ? `Tomorrow pressure: ${summarizeEvent(tomorrowPressure, params.snapshot.timeZone)}`
      : null,
    slippingThread ? `Keep on deck: ${summarizeThread(slippingThread)}` : null,
    currentWork ? `Current work: ${currentWork.title} (${currentWork.statusLabel})` : null,
    params.householdLines[0] ? `Household: ${params.householdLines[0]}` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    mode: 'open_guidance',
    subjectKind: params.householdLines.length > 0 ? 'household' : 'day_brief',
    subjectData:
      params.householdLines.length > 0 ? { householdFocus: true } : {},
    supportedFollowups: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'risk_check',
      'memory_control',
    ],
    lead,
    leadReason,
    detailLines,
    extraDetails: detailLines.slice(1),
    recommendationText,
    recommendationKind,
    signalsUsed: [
      'calendar',
      dueReminder ? 'reminders' : null,
      threadContext.threadSummaryLines[0] ? 'life_threads' : null,
      currentWork ? 'current_work' : null,
      params.householdLines[0] ? 'household_context' : null,
    ].filter((line): line is string => Boolean(line)),
    signalsOmitted: [],
    householdSignals: params.householdLines,
    memoryLines: params.memoryLines,
    usedThreadIds: threadContext.usedThreadIds,
    usedThreadTitles: threadContext.usedThreadTitles,
    usedThreadReasons: threadContext.usedThreadReasons,
    threadSummaryLines: threadContext.threadSummaryLines,
    comparisonKeys: {
      nextEvent: tomorrowPressure
        ? `${tomorrowPressure.id}:${tomorrowPressure.startIso}`
        : null,
      nextReminder: dueReminder ? `${dueReminder.id}:${dueReminder.nextRunIso}` : null,
      recommendation: recommendationText,
      household: params.householdLines[0] || null,
      focus: leadReason,
      thread: threadContext.threadSummaryLines[0] || null,
    },
  };
}

function buildOpenGuidanceDraft(params: {
  snapshot: GroundedDaySnapshot;
  normalized: string;
  householdLines: string[];
  prefs: CompanionPreferences;
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
  tomorrowSnapshot: CalendarLookupSnapshot | null;
}): CompanionDraft {
  if (params.normalized.includes('remember tonight')) {
    return buildEveningDraft({
      snapshot: params.snapshot,
      tomorrowSnapshot: params.tomorrowSnapshot,
      householdLines: params.householdLines,
      memoryLines: params.memoryLines,
      threadSnapshot: params.threadSnapshot,
    });
  }
  if (isLooseEndsPrompt(params.normalized)) {
    return buildLooseEndsDraft({
      snapshot: params.snapshot,
      tomorrowSnapshot: params.tomorrowSnapshot,
      householdLines: params.householdLines,
      prefs: params.prefs,
      memoryLines: params.memoryLines,
      threadSnapshot: params.threadSnapshot,
    });
  }
  return buildMiddayDraft({
    snapshot: params.snapshot,
    householdLines: params.householdLines,
    prefs: params.prefs,
    memoryLines: params.memoryLines,
    threadSnapshot: params.threadSnapshot,
  });
}

function buildTomorrowDraft(params: {
  snapshot: GroundedDaySnapshot;
  tomorrowSnapshot: CalendarLookupSnapshot | null;
  householdLines: string[];
  memoryLines: string[];
  threadSnapshot: ReturnType<typeof buildLifeThreadSnapshot>;
}): CompanionDraft {
  const tomorrowTimed = params.tomorrowSnapshot?.timedEvents.slice(0, 2) || [];
  const tomorrowAllDay = params.tomorrowSnapshot?.allDayEvents.slice(0, 1) || [];
  const firstEvent = tomorrowTimed[0] || tomorrowAllDay[0] || null;
  const detailLines = [...tomorrowTimed, ...tomorrowAllDay]
    .slice(0, 3)
    .map((event) => summarizeEvent(event, params.snapshot.timeZone))
    .filter((line): line is string => Boolean(line));
  const householdLine = params.householdLines[0] || null;
  const threadContext = buildThreadContextDetails({
    dueThread: params.threadSnapshot.dueFollowups[0] || null,
    householdThread: params.threadSnapshot.householdCarryover,
    recommendedThread: params.threadSnapshot.recommendedNextThread,
  });

  const lead = firstEvent
    ? `Tomorrow starts with ${firstEvent.title}${
        firstEvent.allDay
          ? '.'
          : ` at ${formatClock(new Date(firstEvent.startIso), params.snapshot.timeZone)}.`
      }`
    : 'I do not see a strong calendar anchor for tomorrow yet.';

  const recommendationText = firstEvent
    ? `Set yourself up for ${firstEvent.title} tonight so tomorrow starts cleaner.`
    : null;

  return {
    mode: 'open_guidance',
    subjectKind: householdLine ? 'household' : 'day_brief',
    subjectData: householdLine ? { householdFocus: true } : {},
    supportedFollowups: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    lead,
    leadReason: firstEvent ? 'tomorrow_overview' : 'tomorrow_clear',
    detailLines: [
      ...detailLines.map((line, index) =>
        index === 0 ? `Tomorrow: ${line}` : `Also tomorrow: ${line}`,
      ),
      householdLine ? `Household: ${householdLine}` : null,
    ].filter((line): line is string => Boolean(line)),
    extraDetails: detailLines.slice(1),
    recommendationText,
    recommendationKind: recommendationText ? 'save_for_tomorrow' : 'none',
    signalsUsed: [
      'calendar',
      threadContext.threadSummaryLines[0] ? 'life_threads' : null,
      householdLine ? 'household_context' : null,
    ].filter((line): line is string => Boolean(line)),
    signalsOmitted: [],
    householdSignals: householdLine ? [householdLine] : [],
    memoryLines: params.memoryLines,
    usedThreadIds: threadContext.usedThreadIds,
    usedThreadTitles: threadContext.usedThreadTitles,
    usedThreadReasons: threadContext.usedThreadReasons,
    threadSummaryLines: threadContext.threadSummaryLines,
    comparisonKeys: {
      nextEvent: firstEvent
        ? `${firstEvent.id}:${firstEvent.allDay ? firstEvent.startIso : firstEvent.startIso}`
        : null,
      nextReminder: null,
      recommendation: recommendationText,
      household: householdLine,
      focus: firstEvent ? `tomorrow:${firstEvent.title}` : null,
      thread: threadContext.threadSummaryLines[0] || null,
    },
  };
}

function buildExplainabilityReply(
  channel: DailyCompanionChannel,
  context: DailyCompanionContext,
): string {
  const signalText =
    context.signalsUsed.length > 0
      ? context.signalsUsed.join(', ')
      : 'your current schedule and reminders';
  if (channel === 'alexa') {
    const memoryLead =
      context.memoryLines[0] != null
        ? `I was also keeping in mind that ${context.memoryLines[0]}.`
        : '';
    const threadLead =
      context.usedThreadTitles[0] != null
        ? `I was also leaning on ${context.usedThreadTitles[0]}.`
        : '';
    return buildVoiceReply({
      summary: `I brought that up because I was weighing ${signalText}.`,
      details: [threadLead || memoryLead],
      maxDetails: 1,
    });
  }

  const lines = [`I answered from ${signalText}.`];
  if (context.usedThreadTitles.length > 0) {
    lines.push(`Thread context in play: ${context.usedThreadTitles.join('; ')}.`);
  }
  if (context.memoryLines.length > 0) {
    lines.push(`Remembered context in play: ${context.memoryLines.join('; ')}.`);
  }
  return lines.join('\n');
}

function buildMemoryReply(
  channel: DailyCompanionChannel,
  context: DailyCompanionContext,
): string {
  if (context.memoryLines.length === 0 && context.threadSummaryLines.length === 0) {
    return channel === 'alexa'
      ? 'I am not leaning on any strong remembered preferences for this one yet.'
      : 'I am not leaning on any strong remembered preferences for this one yet.';
  }
  const threadLead =
    context.threadSummaryLines.length > 0
      ? `Active thread context in play: ${context.threadSummaryLines.join('; ')}.`
      : null;
  if (context.memoryLines.length === 0) {
    return channel === 'alexa'
      ? threadLead || 'I was mostly leaning on the current thread of the conversation.'
      : threadLead || 'I was mostly leaning on current thread context.';
  }
  return channel === 'alexa'
    ? `What I was keeping in mind is ${context.memoryLines.slice(0, 2).join(
        ', ',
      )}.`
    : [
        'Remembered context affecting this:',
        ...context.memoryLines.map((line) => `- ${line}`),
        threadLead ? `- ${threadLead}` : null,
      ]
        .filter(Boolean)
        .join('\n');
}

function buildChangedReply(
  channel: DailyCompanionChannel,
  previous: DailyCompanionContext,
  current: DailyCompanionContext,
): string {
  const changes: string[] = [];
  if (previous.comparisonKeys.nextEvent !== current.comparisonKeys.nextEvent) {
    changes.push('the next calendar anchor shifted');
  }
  if (
    previous.comparisonKeys.nextReminder !== current.comparisonKeys.nextReminder
  ) {
    changes.push('the reminder pressure changed');
  }
  if (
    previous.comparisonKeys.recommendation !== current.comparisonKeys.recommendation
  ) {
    changes.push('my recommended next move changed');
  }
  if (previous.comparisonKeys.household !== current.comparisonKeys.household) {
    changes.push('the family or household signal changed');
  }
  if (previous.comparisonKeys.thread !== current.comparisonKeys.thread) {
    changes.push('the thread carryover changed');
  }

  if (changes.length === 0) {
    return channel === 'alexa'
      ? `Nothing major shifted since the last read. ${current.summaryText}`
      : `Nothing major shifted since the last read.\n${current.extendedText}`;
  }

  return channel === 'alexa'
    ? `The main change is ${changes[0]}. ${current.summaryText}`
    : `What changed: ${changes.join('; ')}.\n${current.extendedText}`;
}

function isSameLocalDay(leftIso: string, right: Date): boolean {
  const left = new Date(leftIso);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export async function buildDailyCompanionResponse(
  message: string,
  deps: DailyCompanionDeps,
): Promise<DailyCompanionResponse | null> {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  const now = deps.now || new Date();
  const groupFacts = deps.groupFolder
    ? listProfileFactsForGroup(deps.groupFolder, ['accepted'])
    : [];
  const prefs = parsePreferences(groupFacts);
  const householdExplicit = isHouseholdPrompt(normalized);
  const memoryLines = collectMemoryLines(deps.groupFolder, householdExplicit);

  if (deps.priorContext) {
    if (isExplainabilityPrompt(normalized)) {
      const reply = buildExplainabilityReply(deps.channel, deps.priorContext);
      return {
        reply,
        mode: deps.priorContext.mode,
        channel: deps.channel,
        leadReason: 'explainability',
        signalsUsed: deps.priorContext.signalsUsed,
        signalsOmitted: deps.priorContext.signalsOmitted,
        householdSignals: deps.priorContext.householdSignals,
        recommendationKind: 'none',
        context: {
          ...deps.priorContext,
          channel: deps.channel,
        },
        grounded: null,
      };
    }
    if (isMemoryAffectingPrompt(normalized)) {
      const reply = buildMemoryReply(deps.channel, deps.priorContext);
      return {
        reply,
        mode: deps.priorContext.mode,
        channel: deps.channel,
        leadReason: 'memory_affecting',
        signalsUsed: deps.priorContext.signalsUsed,
        signalsOmitted: deps.priorContext.signalsOmitted,
        householdSignals: deps.priorContext.householdSignals,
        recommendationKind: 'none',
        context: { ...deps.priorContext, channel: deps.channel },
        grounded: null,
      };
    }
    if (isShorterPrompt(normalized)) {
      return {
        reply: deps.priorContext.shortText,
        mode: deps.priorContext.mode,
        channel: deps.channel,
        leadReason: 'shorter',
        signalsUsed: deps.priorContext.signalsUsed,
        signalsOmitted: deps.priorContext.signalsOmitted,
        householdSignals: deps.priorContext.householdSignals,
        recommendationKind: deps.priorContext.recommendationKind,
        context: { ...deps.priorContext, channel: deps.channel },
        grounded: null,
      };
    }
    if (isAnythingElsePrompt(normalized) || isSayMorePrompt(normalized)) {
      const extra =
        deps.priorContext.extraDetails.length > 0
          ? deps.priorContext.extraDetails
          : deps.priorContext.recommendationText
            ? [deps.priorContext.recommendationText]
            : ['Nothing else feels especially pressing beyond the main read.'];
      const reply =
        deps.channel === 'alexa'
          ? buildVoiceReply({
              summary: extra[0]!,
              details: [extra[1] || null],
              maxDetails: 1,
            })
          : [deps.priorContext.summaryText, ...extra.map((line) => `- ${line}`)].join(
              '\n',
            );
      return {
        reply,
        mode: deps.priorContext.mode,
        channel: deps.channel,
        leadReason: 'followup_more',
        signalsUsed: deps.priorContext.signalsUsed,
        signalsOmitted: deps.priorContext.signalsOmitted,
        householdSignals: deps.priorContext.householdSignals,
        recommendationKind: deps.priorContext.recommendationKind,
        context: { ...deps.priorContext, channel: deps.channel },
        grounded: null,
      };
    }
    if (isActionGuidancePrompt(normalized) && deps.priorContext.recommendationText) {
      return {
        reply: deps.priorContext.recommendationText,
        mode: deps.priorContext.mode,
        channel: deps.channel,
        leadReason: 'action_guidance',
        signalsUsed: deps.priorContext.signalsUsed,
        signalsOmitted: deps.priorContext.signalsOmitted,
        householdSignals: deps.priorContext.householdSignals,
        recommendationKind: deps.priorContext.recommendationKind,
        context: { ...deps.priorContext, channel: deps.channel },
        grounded: null,
      };
    }
    if (isRiskPrompt(normalized)) {
      const riskReply =
        deps.priorContext.householdSignals[0] ||
        deps.priorContext.recommendationText ||
        deps.priorContext.summaryText;
      return {
        reply:
          deps.channel === 'alexa'
            ? `The main thing I would watch is ${riskReply}.`
            : `The main thing I would watch is ${riskReply}.`,
        mode: deps.priorContext.mode,
        channel: deps.channel,
        leadReason: 'risk_check',
        signalsUsed: deps.priorContext.signalsUsed,
        signalsOmitted: deps.priorContext.signalsOmitted,
        householdSignals: deps.priorContext.householdSignals,
        recommendationKind: deps.priorContext.recommendationKind,
        context: { ...deps.priorContext, channel: deps.channel },
        grounded: null,
      };
    }
  }

  const snapshot = await buildGroundedDaySnapshot({
    ...deps,
    now,
    timeZone: deps.timeZone || TIMEZONE,
  });
  const explicitHouseholdPerson =
    householdExplicit && deps.groupFolder
      ? extractExplicitHouseholdPerson(normalized)
      : undefined;
  const explicitHouseholdThread =
    explicitHouseholdPerson && deps.groupFolder
      ? findLifeThreadForExplicitLookup({
          groupFolder: deps.groupFolder,
          query: explicitHouseholdPerson,
        })
      : null;
  const scopedSnapshot =
    householdExplicit || /before my next meeting|tomorrow/.test(normalized)
      ? await loadScopedSnapshot(message, deps)
      : null;
  const needsTomorrowSnapshot =
    isEveningPrompt(normalized) ||
    normalized.includes('calendar tomorrow') ||
    isLooseEndsPrompt(normalized) ||
    normalized.includes('remember tonight');
  const tomorrowSnapshot = needsTomorrowSnapshot
    ? await loadScopedSnapshot('what is on my calendar tomorrow', deps)
    : null;
  const threadSnapshot = deps.groupFolder
    ? buildLifeThreadSnapshot({
        groupFolder: deps.groupFolder,
        now,
        selectedWorkTitle: snapshot.selectedWork?.title || null,
      })
    : {
        activeThreads: [],
        dueFollowups: [],
        householdCarryover: null,
        recommendedNextThread: null,
      };
  const householdLines =
    prefs.familyContextEnabled || householdExplicit
      ? selectHouseholdLines({
          snapshot,
          scopedSnapshot,
          facts: groupFacts,
          householdExplicit,
        })
      : [];

  let draft: CompanionDraft | null = null;
  if (isMorningPrompt(normalized)) {
    draft = buildMorningDraft({
      snapshot,
      householdLines,
      prefs,
      memoryLines,
      threadSnapshot,
    });
  } else if (isEveningPrompt(normalized)) {
    draft = buildEveningDraft({
      snapshot,
      tomorrowSnapshot,
      householdLines,
      memoryLines,
      threadSnapshot,
    });
  } else if (householdExplicit) {
    draft = buildHouseholdDraft({
      snapshot,
      scopedSnapshot,
      rawMessage: normalized,
      memoryLines,
      threadSnapshot,
      explicitThread: explicitHouseholdThread,
    });
  } else if (deps.priorContext && isWhatChangedPrompt(normalized)) {
    draft = buildMiddayDraft({
      snapshot,
      householdLines,
      prefs,
      memoryLines,
      threadSnapshot,
    });
    const current = finalizeDraft(
      draft,
      deps.channel,
      now,
      snapshot,
      prefs,
    );
    if (isSameLocalDay(deps.priorContext.generatedAt, now)) {
      return {
        ...current,
        reply: buildChangedReply(deps.channel, deps.priorContext, current.context),
      };
    }
    return current;
  } else if (isMiddayPrompt(normalized)) {
    draft = buildMiddayDraft({
      snapshot,
      householdLines,
      prefs,
      memoryLines,
      threadSnapshot,
    });
  } else if (isOpenGuidancePrompt(normalized)) {
    if (normalized.includes('calendar tomorrow')) {
      draft = buildTomorrowDraft({
        snapshot,
        tomorrowSnapshot,
        householdLines,
        memoryLines,
        threadSnapshot,
      });
    } else {
      draft = buildOpenGuidanceDraft({
        snapshot,
        normalized,
        householdLines,
        prefs,
        memoryLines,
        threadSnapshot,
        tomorrowSnapshot,
      });
    }
  } else {
    return null;
  }

  return finalizeDraft(draft, deps.channel, now, snapshot, prefs);
}
