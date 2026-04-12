import crypto from 'crypto';

import {
  createTask,
  deleteRouterState,
  findEverydayListGroupByKind,
  findEverydayListGroupByTitle,
  getActiveOperatingProfile,
  getEverydayListGroup,
  getEverydayListItem,
  getRouterState,
  listEverydayListGroups,
  listEverydayListItems,
  listOperatingProfileSuggestions,
  listOperatingProfilesForGroup,
  setRouterState,
  supersedeActiveOperatingProfiles,
  updateEverydayListItem,
  updateOperatingProfileSuggestionState,
  upsertEverydayListGroup,
  upsertEverydayListItem,
  upsertOperatingProfile,
  upsertOperatingProfileSuggestion,
  deleteEverydayListItem,
} from './db.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { planContextualReminder } from './local-reminder.js';
import { buildMissionTurn } from './missions.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import { syncOutcomeFromReminderTask } from './outcome-reviews.js';
import type {
  AlexaConversationFollowupAction,
  AlexaConversationSubjectKind,
  EverydayListGroup,
  EverydayListGroupKind,
  EverydayListItem,
  EverydayListItemKind,
  EverydayListItemState,
  EverydayListScope,
  OperatingProfile,
  OperatingProfileIntake,
  OperatingProfileLearningMode,
  OperatingProfilePlan,
  OperatingProfilePlanGroup,
  OperatingProfilePlanIntegration,
  OperatingProfileSuggestion,
} from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export type EverydayCaptureMode =
  | 'profile_setup'
  | 'profile_review'
  | 'add_item'
  | 'read_items'
  | 'update_item'
  | 'convert_item';

export interface EverydayCapturePriorContext {
  activeTaskKind?:
    | 'calendar_read'
    | 'calendar_write'
    | 'calendar_move'
    | 'calendar_cancel'
    | 'reminder_write'
    | 'communication_draft'
    | 'planning_guidance'
    | 'list_capture'
    | 'list_read'
    | 'list_update'
    | 'profile_setup';
  activeListGroupId?: string;
  activeListItemIds?: string[];
  activeListScope?: EverydayListScope;
  activeOperatingProfileId?: string;
  conversationFocus?: string;
  lastAnswerSummary?: string;
  threadId?: string;
  threadTitle?: string;
}

export interface EverydayCaptureConversationData {
  activeTaskKind?: 'list_capture' | 'list_read' | 'list_update' | 'profile_setup';
  activeListGroupId?: string;
  activeListItemIds?: string[];
  activeListScope?: EverydayListScope;
  activeOperatingProfileId?: string;
}

export interface EverydayCaptureCommandInput {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder: string;
  chatJid?: string;
  text: string;
  replyText?: string;
  conversationSummary?: string;
  priorContext?: EverydayCapturePriorContext | null;
  now?: Date;
}

export interface EverydayCaptureCommandResult {
  handled: boolean;
  mode?: EverydayCaptureMode;
  replyText?: string;
  summaryText?: string;
  subjectKind?: AlexaConversationSubjectKind;
  conversationData?: EverydayCaptureConversationData;
  supportedFollowups?: AlexaConversationFollowupAction[];
  listGroup?: EverydayListGroup | null;
  listItems?: EverydayListItem[];
  operatingProfile?: OperatingProfile | null;
  handoffOffer?: string;
}

interface ProfileSetupState {
  version: 1;
  createdAt: string;
  draftProfileId?: string;
  notes: string[];
}

interface PendingReminderState {
  version: 1;
  itemId: string;
  title: string;
  createdAt: string;
}

interface ReadTarget {
  kind: 'all' | 'shopping' | 'errands' | 'bills' | 'meals' | 'tonight';
  summary: string;
}

interface CaptureTarget {
  title: string;
  groupKind: EverydayListGroupKind;
  itemKind: EverydayListItemKind;
  groupTitle?: string;
  scope?: EverydayListScope;
  dueAt?: string | null;
  scheduledFor?: string | null;
  detail?: Record<string, unknown>;
}

const PROFILE_SETUP_STATE_PREFIX = 'everyday_capture:profile_setup:';
const REMINDER_STATE_PREFIX = 'everyday_capture:pending_reminder:';
const DEFAULT_LEARNING_POLICY: OperatingProfileLearningMode =
  'suggest_then_confirm';
const DEFAULT_GROUP_TEMPLATES: Record<
  EverydayListGroupKind,
  { title: string; purpose: string }
> = {
  shopping: {
    title: 'Groceries',
    purpose: 'Things to buy or pick up soon.',
  },
  errands: {
    title: 'Errands',
    purpose: 'Short out-of-home tasks and pickups.',
  },
  bills: {
    title: 'Bills',
    purpose: 'Bills or money follow-through that should not slip.',
  },
  meals: {
    title: 'Meals',
    purpose: 'Meal ideas and meal plans worth keeping in view.',
  },
  household: {
    title: 'Household',
    purpose: 'Shared household tasks and supplies.',
  },
  checklist: {
    title: 'Tonight',
    purpose: 'The small things to close or remember tonight.',
  },
  general: {
    title: 'General',
    purpose: 'Everyday capture that does not fit somewhere tighter yet.',
  },
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value: string, max = 140): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function joinNaturalLanguage(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractResponseOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as {
    output_text?: string;
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }
  return (
    record.output
      ?.flatMap((item) => item.content || [])
      .map((content) =>
        content.type === 'output_text' ? content.text || '' : '',
      )
      .join('\n')
      .trim() || ''
  );
}

function stripJsonFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function profileSetupKey(chatJid: string): string {
  return `${PROFILE_SETUP_STATE_PREFIX}${chatJid}`;
}

function reminderStateKey(chatJid: string): string {
  return `${REMINDER_STATE_PREFIX}${chatJid}`;
}

function readProfileSetupState(chatJid: string): ProfileSetupState | null {
  const raw = getRouterState(profileSetupKey(chatJid));
  const parsed = safeJsonParse<ProfileSetupState | null>(raw, null);
  return parsed?.version === 1 ? parsed : null;
}

function writeProfileSetupState(
  chatJid: string,
  state: ProfileSetupState | null,
): void {
  if (!state) {
    deleteRouterState(profileSetupKey(chatJid));
    return;
  }
  setRouterState(profileSetupKey(chatJid), JSON.stringify(state));
}

function readPendingReminderState(chatJid: string): PendingReminderState | null {
  const raw = getRouterState(reminderStateKey(chatJid));
  const parsed = safeJsonParse<PendingReminderState | null>(raw, null);
  return parsed?.version === 1 ? parsed : null;
}

function writePendingReminderState(
  chatJid: string,
  state: PendingReminderState | null,
): void {
  if (!state) {
    deleteRouterState(reminderStateKey(chatJid));
    return;
  }
  setRouterState(reminderStateKey(chatJid), JSON.stringify(state));
}

function inferScope(text: string): EverydayListScope {
  const lower = text.toLowerCase();
  if (/\bhousehold|home|grocer(?:y|ies) for us|for the house\b/.test(lower)) {
    return 'household';
  }
  if (/\bfamily|kids|everyone\b/.test(lower)) {
    return 'family';
  }
  if (/\bshared|together|both of us\b/.test(lower)) {
    return 'mixed';
  }
  return 'personal';
}

function buildPlanGroupsFromTrackedAreas(
  trackedAreas: string[],
  scope: EverydayListScope,
): OperatingProfilePlanGroup[] {
  const groups = new Map<string, OperatingProfilePlanGroup>();
  const add = (kind: EverydayListGroupKind) => {
    const template = DEFAULT_GROUP_TEMPLATES[kind];
    groups.set(kind, {
      title: template.title,
      kind,
      scope,
      purpose: template.purpose,
    });
  };

  add('general');
  for (const area of trackedAreas) {
    if (area === 'shopping') add('shopping');
    if (area === 'errands') add('errands');
    if (area === 'bills') add('bills');
    if (area === 'meals') add('meals');
    if (area === 'meds' || area === 'tonight') add('checklist');
    if (area === 'household') add('household');
  }
  return [...groups.values()];
}

function extractIntake(rawText: string): OperatingProfileIntake {
  const normalized = normalizeText(rawText);
  const lower = normalized.toLowerCase();
  const routines: string[] = [];
  const trackingPriorities: string[] = [];
  const defaultGroups: string[] = [];
  const integrationsWanted: string[] = [];
  const notes: string[] = [];
  const addUnique = (bucket: string[], value: string): void => {
    if (value && !bucket.includes(value)) bucket.push(value);
  };

  if (/\bshopping|grocery|grocer(?:y|ies)|buy\b/.test(lower)) {
    addUnique(trackingPriorities, 'shopping');
    addUnique(defaultGroups, 'Groceries');
  }
  if (/\berrand|pickup|pick up|drop off|return\b/.test(lower)) {
    addUnique(trackingPriorities, 'errands');
    addUnique(defaultGroups, 'Errands');
  }
  if (/\bbill|bills|rent|mortgage|utility|water bill|electric|pay\b/.test(lower)) {
    addUnique(trackingPriorities, 'bills');
    addUnique(defaultGroups, 'Bills');
  }
  if (/\bmeal|dinner|lunch|breakfast|meal prep|meal plan\b/.test(lower)) {
    addUnique(trackingPriorities, 'meals');
    addUnique(defaultGroups, 'Meals');
  }
  if (/\bpills?|meds?|medication|medicine|supplements?\b/.test(lower)) {
    addUnique(trackingPriorities, 'meds');
    addUnique(defaultGroups, 'Tonight');
  }
  if (/\bhousehold|home|family|kids|shared\b/.test(lower)) {
    addUnique(trackingPriorities, 'household');
    addUnique(defaultGroups, 'Household');
  }
  if (/\btonight|evening reset|night\b/.test(lower)) {
    addUnique(routines, 'evening reset');
  }
  if (/\bmorning|start of day|first thing\b/.test(lower)) {
    addUnique(routines, 'morning check-in');
  }
  if (/\bweekly|weekend|sunday\b/.test(lower)) {
    addUnique(routines, 'weekly planning');
  }
  if (/\btelegram\b/.test(lower)) addUnique(integrationsWanted, 'Telegram');
  if (/\balexa\b/.test(lower)) addUnique(integrationsWanted, 'Alexa');
  if (/\bcalendar\b/.test(lower)) addUnique(integrationsWanted, 'Google Calendar');
  if (/\bbluebubbles|messages|imessage\b/.test(lower)) {
    addUnique(integrationsWanted, 'BlueBubbles');
  }
  if (trackingPriorities.length === 0) {
    addUnique(trackingPriorities, 'shopping');
    addUnique(trackingPriorities, 'bills');
    addUnique(trackingPriorities, 'errands');
  }

  if (/telegram/.test(lower)) {
    notes.push('Telegram is preferred for richer editing and review.');
  }

  return {
    rawText: normalized,
    routines,
    trackingPriorities,
    defaultGroups,
    integrationsWanted,
    richerSurface: /alexa/.test(lower)
      ? 'alexa'
      : /bluebubbles|messages/.test(lower)
        ? 'bluebubbles'
        : 'telegram',
    scope: inferScope(lower),
    notes,
  };
}

function buildDeterministicPlan(
  intake: OperatingProfileIntake,
): OperatingProfilePlan {
  const trackedAreas = [...new Set(intake.trackingPriorities)];
  return {
    summary:
      trackedAreas.length > 0
        ? `Andrea should keep ${joinNaturalLanguage(
            trackedAreas.map((area) =>
              area === 'meds' ? 'meds and nightly follow-through' : area,
            ),
          )} in view for you.`
        : 'Andrea should keep your everyday follow-through in view for you.',
    trackedAreas,
    defaultGroups: buildPlanGroupsFromTrackedAreas(trackedAreas, intake.scope),
    routines: intake.routines,
    reminderSuggestions: [
      trackedAreas.includes('bills')
        ? 'Surface open bills during weekly planning.'
        : '',
      trackedAreas.includes('meds')
        ? 'Offer to convert meds items into reminders when timing matters.'
        : '',
      trackedAreas.includes('shopping')
        ? 'Surface groceries in tonight planning when errands are active.'
        : '',
    ].filter(Boolean),
    richerSurface: intake.richerSurface,
    desiredIntegrations: ['Telegram', 'Alexa', 'BlueBubbles', 'Google Calendar'].map(
      (name): OperatingProfilePlanIntegration => ({
        name,
        readiness: intake.integrationsWanted.includes(name)
          ? name === 'Google Calendar' || name === 'Telegram' || name === 'Alexa'
            ? 'connected'
            : 'missing_manual'
          : 'not_requested',
        note:
          intake.integrationsWanted.includes(name) && name === 'BlueBubbles'
            ? 'Still needs the normal surface proof and setup path.'
            : null,
      }),
    ),
    learningPolicy: DEFAULT_LEARNING_POLICY,
  };
}

async function synthesizePlanWithOpenAi(
  intake: OperatingProfileIntake,
): Promise<OperatingProfilePlan | null> {
  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) return null;
  const prompt = [
    'You are Andrea, a calm practical personal assistant.',
    'Create a compact personal operating plan from this intake.',
    'Return JSON only with keys: summary, trackedAreas, defaultGroups, routines, reminderSuggestions, richerSurface, desiredIntegrations, learningPolicy.',
    'defaultGroups must be an array of objects with keys: title, kind, scope, purpose.',
    'desiredIntegrations must be an array of objects with keys: name, readiness, note.',
    'learningPolicy must be suggest_then_confirm.',
    `User intake JSON: ${JSON.stringify(intake)}`,
  ].join('\n');

  try {
    const response = await fetch(`${openAi.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAi.apiKey}`,
      },
      body: JSON.stringify({
        model: openAi.researchModel,
        input: prompt,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      describeOpenAiProviderFailure(response.status, text, 'research');
      return null;
    }
    const payload = (await response.json()) as unknown;
    const output = stripJsonFences(extractResponseOutputText(payload));
    if (!output) return null;
    const parsed = safeJsonParse<Partial<OperatingProfilePlan>>(output, {});
    if (!parsed.summary || !Array.isArray(parsed.defaultGroups)) {
      return null;
    }
    return {
      summary: clip(parsed.summary, 220),
      trackedAreas: Array.isArray(parsed.trackedAreas)
        ? parsed.trackedAreas.map((item) => String(item))
        : intake.trackingPriorities,
      defaultGroups: parsed.defaultGroups as OperatingProfilePlanGroup[],
      routines: Array.isArray(parsed.routines)
        ? parsed.routines.map((item) => String(item))
        : intake.routines,
      reminderSuggestions: Array.isArray(parsed.reminderSuggestions)
        ? parsed.reminderSuggestions.map((item) => String(item))
        : [],
      richerSurface:
        parsed.richerSurface === 'alexa' ||
        parsed.richerSurface === 'bluebubbles'
          ? parsed.richerSurface
          : 'telegram',
      desiredIntegrations: Array.isArray(parsed.desiredIntegrations)
        ? (parsed.desiredIntegrations as OperatingProfilePlanIntegration[])
        : [],
      learningPolicy: DEFAULT_LEARNING_POLICY,
    };
  } catch {
    return null;
  }
}

function formatPlanForChannel(
  channel: EverydayCaptureCommandInput['channel'],
  plan: OperatingProfilePlan,
): string {
  const groups = plan.defaultGroups.map((group) => group.title);
  const integrations = plan.desiredIntegrations
    .filter((item) => item.readiness !== 'not_requested')
    .map((item) => `${item.name} (${item.readiness === 'connected' ? 'connected' : 'manual'})`);
  if (channel === 'alexa') {
    return [
      plan.summary,
      groups.length
        ? `I would start with ${joinNaturalLanguage(groups.slice(0, 3))}.`
        : '',
      'Say approve that if you want me to use it.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    '*Proposed Andrea setup*',
    '',
    `- Summary: ${plan.summary}`,
    plan.trackedAreas.length
      ? `- Track first: ${joinNaturalLanguage(plan.trackedAreas)}`
      : '',
    groups.length ? `- Default lists: ${joinNaturalLanguage(groups)}` : '',
    plan.routines.length
      ? `- Routines to keep in view: ${joinNaturalLanguage(plan.routines)}`
      : '',
    plan.reminderSuggestions.length
      ? `- Reminder behavior: ${joinNaturalLanguage(plan.reminderSuggestions)}`
      : '',
    integrations.length
      ? `- Integrations: ${joinNaturalLanguage(integrations)}`
      : '',
    '',
    'Say `approve that` to use it, or tell me what you want changed.',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatCurrentSetup(
  channel: EverydayCaptureCommandInput['channel'],
  profile: OperatingProfile | null,
): string {
  if (!profile) {
    return channel === 'alexa'
      ? 'I do not have your setup yet. Say help me set this up and I can walk you through it.'
      : 'I do not have an active setup yet. Say `help me set this up` and I will build one with you.';
  }
  const plan = safeJsonParse<OperatingProfilePlan>(profile.planJson, {
    summary: 'Andrea is tracking your everyday follow-through.',
    trackedAreas: [],
    defaultGroups: [],
    routines: [],
    reminderSuggestions: [],
    richerSurface: 'telegram',
    desiredIntegrations: [],
    learningPolicy: DEFAULT_LEARNING_POLICY,
  });
  if (channel === 'alexa') {
    return [
      plan.summary,
      plan.defaultGroups.length
        ? `Right now I am using ${joinNaturalLanguage(
            plan.defaultGroups.slice(0, 3).map((group) => group.title),
          )}.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    '*Current Andrea setup*',
    '',
    `- Summary: ${plan.summary}`,
    plan.trackedAreas.length
      ? `- Track first: ${joinNaturalLanguage(plan.trackedAreas)}`
      : '',
    plan.defaultGroups.length
      ? `- Lists: ${joinNaturalLanguage(
          plan.defaultGroups.map((group) => group.title),
        )}`
      : '',
    plan.routines.length
      ? `- Routines: ${joinNaturalLanguage(plan.routines)}`
      : '',
    `- Learning mode: ${plan.learningPolicy.replace(/_/g, ' ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function seedGroupsFromPlan(
  groupFolder: string,
  profileId: string,
  plan: OperatingProfilePlan,
  nowIso: string,
): EverydayListGroup[] {
  return plan.defaultGroups.map((group) => {
    const existing =
      findEverydayListGroupByTitle(groupFolder, group.title) ||
      findEverydayListGroupByKind(groupFolder, group.kind, group.scope);
    const record: EverydayListGroup = existing
      ? {
          ...existing,
          operatingProfileId: profileId,
          sourceSummary: group.purpose,
          updatedAt: nowIso,
        }
      : {
          groupId: crypto.randomUUID(),
          groupFolder,
          operatingProfileId: profileId,
          title: group.title,
          kind: group.kind,
          scope: group.scope,
          sourceSummary: group.purpose,
          createdAt: nowIso,
          updatedAt: nowIso,
          archivedAt: null,
        };
    upsertEverydayListGroup(record);
    return record;
  });
}

function proposeStarterSuggestion(
  groupFolder: string,
  profileId: string | null,
  channel: EverydayCaptureCommandInput['channel'],
  title: string,
  summary: string,
  suggestion: Record<string, unknown>,
  nowIso: string,
): void {
  const existing = listOperatingProfileSuggestions(groupFolder, ['proposed']).find(
    (item) => item.title.toLowerCase() === title.toLowerCase(),
  );
  if (existing) return;
  upsertOperatingProfileSuggestion({
    suggestionId: crypto.randomUUID(),
    groupFolder,
    profileId,
    title,
    summary,
    suggestionJson: JSON.stringify(suggestion),
    state: 'proposed',
    sourceChannel: channel,
    createdAt: nowIso,
    updatedAt: nowIso,
    decidedAt: null,
  });
}

function resolveReferenceText(
  input: EverydayCaptureCommandInput,
  explicit?: string | null,
): string {
  return (
    explicit?.trim() ||
    input.replyText?.trim() ||
    input.priorContext?.conversationFocus?.trim() ||
    input.conversationSummary?.trim() ||
    ''
  );
}

function upcomingWeekEnd(now: Date): Date {
  const end = new Date(now);
  end.setDate(end.getDate() + (7 - end.getDay() || 7));
  end.setHours(23, 59, 59, 999);
  return end;
}

function startOfNextWeek(now: Date): Date {
  const target = new Date(now);
  const daysUntilMonday = ((8 - target.getDay()) % 7) || 7;
  target.setDate(target.getDate() + daysUntilMonday);
  target.setHours(9, 0, 0, 0);
  return target;
}

function tomorrowAtHour(now: Date, hour: number): Date {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(hour, 0, 0, 0);
  return target;
}

function upcomingFridayOrNull(now: Date, raw: string): string | null {
  if (!/\bfriday\b/i.test(raw)) return null;
  const target = new Date(now);
  const offset = (5 - target.getDay() + 7) % 7 || 7;
  target.setDate(target.getDate() + offset);
  target.setHours(18, 0, 0, 0);
  return target.toISOString();
}

function ensureListGroup(params: {
  groupFolder: string;
  operatingProfileId?: string | null;
  title?: string;
  kind: EverydayListGroupKind;
  scope: EverydayListScope;
  sourceSummary: string;
  nowIso: string;
}): EverydayListGroup {
  const title =
    params.title?.trim() || DEFAULT_GROUP_TEMPLATES[params.kind].title;
  const existing =
    findEverydayListGroupByTitle(params.groupFolder, title) ||
    findEverydayListGroupByKind(params.groupFolder, params.kind, params.scope);
  const record: EverydayListGroup = existing
    ? {
        ...existing,
        operatingProfileId: params.operatingProfileId || existing.operatingProfileId,
        scope: params.scope,
        sourceSummary: params.sourceSummary,
        updatedAt: params.nowIso,
      }
    : {
        groupId: crypto.randomUUID(),
        groupFolder: params.groupFolder,
        operatingProfileId: params.operatingProfileId || null,
        title,
        kind: params.kind,
        scope: params.scope,
        sourceSummary: params.sourceSummary,
        createdAt: params.nowIso,
        updatedAt: params.nowIso,
        archivedAt: null,
      };
  upsertEverydayListGroup(record);
  return record;
}

function formatGroupLabel(group: EverydayListGroup): string {
  return group.title.toLowerCase();
}

function formatItemLine(item: EverydayListItem): string {
  return item.title.replace(/[.!?]+$/g, '');
}

function createListItem(params: {
  groupFolder: string;
  channel: EverydayCaptureCommandInput['channel'];
  operatingProfileId?: string | null;
  group: EverydayListGroup;
  title: string;
  itemKind: EverydayListItemKind;
  scope: EverydayListScope;
  sourceSummary: string;
  detail?: Record<string, unknown>;
  dueAt?: string | null;
  scheduledFor?: string | null;
  nowIso: string;
}): EverydayListItem {
  const item: EverydayListItem = {
    itemId: crypto.randomUUID(),
    groupFolder: params.groupFolder,
    groupId: params.group.groupId,
    operatingProfileId: params.operatingProfileId || null,
    title: clip(params.title, 120),
    itemKind: params.itemKind,
    state: 'open',
    scope: params.scope,
    sourceChannel: params.channel,
    sourceSummary: params.sourceSummary,
    detailJson: params.detail ? JSON.stringify(params.detail) : null,
    linkageJson: null,
    dueAt: params.dueAt || null,
    scheduledFor: params.scheduledFor || null,
    deferUntil: null,
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
    completedAt: null,
  };
  upsertEverydayListItem(item);
  return item;
}

function parseCaptureTarget(
  text: string,
  input: EverydayCaptureCommandInput,
): CaptureTarget | null {
  const raw = normalizeText(text);
  const lower = raw.toLowerCase();
  const scope = inferScope(raw);
  const now = input.now || new Date();

  const shoppingMatch =
    raw.match(/^(?:add|put)\s+(.+?)\s+to\s+(?:my\s+)?shopping list$/i) ||
    raw.match(/^(?:add|put)\s+(.+?)\s+on\s+(?:my\s+)?list$/i);
  if (shoppingMatch?.[1]) {
    return {
      title: clip(shoppingMatch[1]),
      groupKind: 'shopping',
      itemKind: 'shopping_item',
      scope,
    };
  }

  const errandMatch = raw.match(/^save (?:this|that|(.+?)) as an errand$/i);
  if (errandMatch) {
    return {
      title: clip(resolveReferenceText(input, errandMatch[1] || null)),
      groupKind: 'errands',
      itemKind: 'errand',
      scope,
    };
  }

  const billMatch =
    raw.match(/^add (.+?) to (?:my\s+)?list$/i) &&
    /\bbill|pay\b/i.test(raw)
      ? raw.match(/^add (.+?) to (?:my\s+)?list$/i)
      : raw.match(/^add (.+?) to bills$/i);
  if (billMatch?.[1]) {
    return {
      title: clip(billMatch[1]),
      groupKind: 'bills',
      itemKind: 'bill',
      scope,
      dueAt: /\bthis week\b/i.test(raw) ? upcomingWeekEnd(now).toISOString() : null,
    };
  }

  const mealMatch =
    raw.match(/^add (.+?) for friday$/i) ||
    raw.match(/^add (.+?) to meals$/i) ||
    raw.match(/^add dinner idea for friday$/i);
  if (mealMatch) {
    const title =
      /^add dinner idea for friday$/i.test(raw)
        ? 'Dinner idea'
        : clip(mealMatch[1] || 'Meal');
    return {
      title,
      groupKind: 'meals',
      itemKind: 'meal_entry',
      scope,
      scheduledFor: upcomingFridayOrNull(now, raw),
    };
  }

  const tonightMatch =
    raw.match(/^add (.+?) to tonight$/i) ||
    raw.match(/^put (.+?) in tonight'?s plan$/i) ||
    raw.match(/^add my pills to tonight$/i);
  if (tonightMatch) {
    const title =
      /^add my pills to tonight$/i.test(raw)
        ? 'Take pills'
        : clip(tonightMatch[1] || resolveReferenceText(input));
    return {
      title,
      groupKind: 'checklist',
      itemKind: /\bpills?|meds?|medication\b/i.test(title)
        ? 'checklist_item'
        : 'general_item',
      groupTitle: 'Tonight',
      scope,
      scheduledFor: tomorrowAtHour(now, 19).toISOString(),
    };
  }

  if (
    /^save that under the household thread$/i.test(raw) ||
    /^save this under the household thread$/i.test(raw)
  ) {
    return null;
  }

  const saveUnderMatch = raw.match(
    /^(?:save|track) (?:this|that|(.+?)) under ([a-z][a-z0-9' -]+)$/i,
  );
  if (saveUnderMatch) {
    return {
      title: clip(resolveReferenceText(input, saveUnderMatch[1] || null)),
      groupKind:
        /grocery|grocer|shopping/i.test(saveUnderMatch[2])
          ? 'shopping'
          : /weekend/i.test(saveUnderMatch[2])
            ? 'checklist'
            : /household|home/i.test(saveUnderMatch[2])
              ? 'household'
              : 'general',
      itemKind: 'general_item',
      groupTitle: toTitleCase(saveUnderMatch[2]),
      scope,
    };
  }

  if (/^track that for the household$/i.test(raw)) {
    return {
      title: clip(resolveReferenceText(input)),
      groupKind: 'household',
      itemKind: 'general_item',
      scope: 'household',
    };
  }

  if (/^remember this$/i.test(raw) || /^save this as a list item$/i.test(raw)) {
    const title = clip(resolveReferenceText(input));
    if (!title) return null;
    return {
      title,
      groupKind: 'general',
      itemKind: 'general_item',
      scope,
    };
  }

  if (/^put batteries on my list$/i.test(raw)) {
    return {
      title: 'Batteries',
      groupKind: 'shopping',
      itemKind: 'shopping_item',
      scope,
    };
  }

  if (/^add milk to my shopping list$/i.test(raw)) {
    return {
      title: 'Milk',
      groupKind: 'shopping',
      itemKind: 'shopping_item',
      scope,
    };
  }

  if (lower.startsWith('add ') || lower.startsWith('put ')) {
    return null;
  }

  return null;
}

function parseReadTarget(text: string): ReadTarget | null {
  const normalized = normalizeText(text).toLowerCase();
  if (/^what('?s| is) on my list\b/.test(normalized)) {
    return { kind: 'all', summary: 'your list' };
  }
  if (/^what do i still need to buy\b/.test(normalized)) {
    return { kind: 'shopping', summary: 'groceries' };
  }
  if (/^what errands do i have\b/.test(normalized)) {
    return { kind: 'errands', summary: 'errands' };
  }
  if (/^what bills do i need to pay(?: this week| soon)?\b/.test(normalized)) {
    return { kind: 'bills', summary: 'bills' };
  }
  if (/^what meals have i planned(?: this week)?\b/.test(normalized)) {
    return { kind: 'meals', summary: 'meals' };
  }
  if (/^what should i remember to get tonight\b/.test(normalized)) {
    return { kind: 'tonight', summary: 'tonight' };
  }
  if (/^what('?s| is) still open\b/.test(normalized)) {
    return { kind: 'all', summary: 'still open' };
  }
  return null;
}

function parseMarkDoneRequest(text: string): boolean {
  return /^(mark that done|check that off|mark this done|check this off)$/i.test(
    normalizeText(text),
  );
}

function parseRemoveRequest(text: string): boolean {
  return /^(remove that|remove this|delete that|delete this)$/i.test(
    normalizeText(text),
  );
}

function parseMoveToNextWeekRequest(text: string): boolean {
  return /^(move that to next week|move this to next week)$/i.test(
    normalizeText(text),
  );
}

function parseRemindLaterRequest(text: string): boolean {
  return /^(remind me about that tomorrow|remind me about this tomorrow)$/i.test(
    normalizeText(text),
  );
}

function parseConvertReminderRequest(text: string): boolean {
  return /^(turn that into a reminder|turn this into a reminder)$/i.test(
    normalizeText(text),
  );
}

function parseConvertMissionRequest(text: string): boolean {
  return /^(make this part of my plan|make that part of my plan)$/i.test(
    normalizeText(text),
  );
}

function parseSaveUnderThreadRequest(text: string): boolean {
  return /^(save that under the household thread|save this under the household thread)$/i.test(
    normalizeText(text),
  );
}

function resolveActiveItem(
  input: EverydayCaptureCommandInput,
): EverydayListItem | null {
  const candidateIds = input.priorContext?.activeListItemIds || [];
  for (const itemId of candidateIds) {
    const item = getEverydayListItem(itemId);
    if (item && item.groupFolder === input.groupFolder) {
      return item;
    }
  }
  const fallback = listEverydayListItems(input.groupFolder, {
    includeDone: false,
    limit: 1,
  })[0];
  return fallback || null;
}

function formatReadout(params: {
  channel: EverydayCaptureCommandInput['channel'];
  target: ReadTarget;
  items: EverydayListItem[];
  groups: EverydayListGroup[];
}): { replyText: string; handoffOffer?: string } {
  if (params.items.length === 0) {
    const emptyLine =
      params.target.kind === 'shopping'
        ? 'You do not have anything left to buy right now.'
        : params.target.kind === 'errands'
          ? 'You do not have any open errands right now.'
          : params.target.kind === 'bills'
            ? 'I do not see any open bills in view right now.'
            : params.target.kind === 'meals'
              ? 'You do not have meal plans in view right now.'
              : 'Your list looks clear right now.';
    return { replyText: emptyLine };
  }

  if (params.channel === 'alexa') {
    const slice = params.items.slice(0, 3).map(formatItemLine);
    const summary =
      params.target.kind === 'shopping'
        ? `You still need ${joinNaturalLanguage(slice)}.`
        : params.target.kind === 'bills'
          ? `The biggest thing still open is ${slice[0]}.`
          : params.target.kind === 'errands'
            ? `You have ${params.items.length} errands left. ${joinNaturalLanguage(slice)}.`
            : `You still have ${joinNaturalLanguage(slice)}.`;
    return {
      replyText:
        params.items.length > 3
          ? `${summary} Want the fuller list in Telegram?`
          : summary,
      handoffOffer:
        params.items.length > 3 ? 'I can send the fuller list to Telegram.' : undefined,
    };
  }

  const grouped = new Map<string, string[]>();
  for (const item of params.items) {
    const group = params.groups.find((candidate) => candidate.groupId === item.groupId);
    const label = group?.title || 'General';
    const bucket = grouped.get(label) || [];
    bucket.push(`- ${formatItemLine(item)}`);
    grouped.set(label, bucket);
  }
  const lines: string[] = [];
  for (const [group, bucket] of grouped.entries()) {
    lines.push(`*${group}*`);
    lines.push(...bucket);
    lines.push('');
  }
  return {
    replyText: lines.join('\n').trim(),
  };
}

function buildResult(
  result: Omit<EverydayCaptureCommandResult, 'handled'> & { handled?: boolean },
): EverydayCaptureCommandResult {
  return {
    handled: result.handled ?? true,
    ...result,
  };
}

async function handleProfileSetup(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const lower = normalizeText(input.text).toLowerCase();
  const activeProfile = getActiveOperatingProfile(input.groupFolder) || null;
  const state = input.chatJid ? readProfileSetupState(input.chatJid) : null;

  if (/^show me my current setup$/i.test(lower)) {
    return buildResult({
      mode: 'profile_review',
      replyText: formatCurrentSetup(input.channel, activeProfile),
      summaryText: activeProfile
        ? 'current Andrea setup'
        : 'Andrea setup not created yet',
      subjectKind: 'general',
      conversationData: {
        activeTaskKind: 'profile_setup',
        activeOperatingProfileId: activeProfile?.profileId,
      },
      supportedFollowups: ['say_more'],
    });
  }

  if (!state && input.chatJid) {
    writeProfileSetupState(input.chatJid, {
      version: 1,
      createdAt: nowIso,
      notes: [],
    });
    return buildResult({
      mode: 'profile_setup',
      replyText:
        input.channel === 'alexa'
          ? 'Tell me the routines, lists, and follow-through you want me to track for you. Mention things like meals, pills, bills, errands, household stuff, and which surface should be richer.'
          : 'Tell me what you want Andrea to track for you. Good things to mention are routines, groceries, errands, bills, meal plans, meds, household follow-through, and which surface should be richer.',
      summaryText: 'starting Andrea setup',
      subjectKind: 'general',
      conversationData: {
        activeTaskKind: 'profile_setup',
        activeOperatingProfileId: activeProfile?.profileId,
      },
      supportedFollowups: ['say_more'],
    });
  }

  if (state?.draftProfileId && /^(approve that|approve|yes|use that)\b/i.test(lower)) {
    const draft = listOperatingProfilesForGroup(input.groupFolder, ['draft']).find(
      (candidate) => candidate.profileId === state.draftProfileId,
    );
    if (!draft) {
      return buildResult({
        mode: 'profile_setup',
        replyText: 'I lost the draft setup, so let’s do that one more time.',
        summaryText: 'setup draft missing',
        subjectKind: 'general',
      });
    }
    supersedeActiveOperatingProfiles(input.groupFolder, nowIso, draft.profileId);
    upsertOperatingProfile({
      ...draft,
      status: 'active',
      approvedAt: nowIso,
      updatedAt: nowIso,
    });
    const active = getActiveOperatingProfile(input.groupFolder)!;
    const plan = safeJsonParse<OperatingProfilePlan>(active.planJson, {
      summary: 'Andrea is tracking your everyday follow-through.',
      trackedAreas: [],
      defaultGroups: [],
      routines: [],
      reminderSuggestions: [],
      richerSurface: 'telegram',
      desiredIntegrations: [],
      learningPolicy: DEFAULT_LEARNING_POLICY,
    });
    seedGroupsFromPlan(input.groupFolder, active.profileId, plan, nowIso);
    if (input.chatJid) writeProfileSetupState(input.chatJid, null);
    return buildResult({
      mode: 'profile_setup',
      replyText:
        input.channel === 'alexa'
          ? 'Okay. I saved that setup and I can start using it now.'
          : 'Okay. I saved that setup and seeded the starter lists for it.',
      summaryText: 'Andrea setup approved',
      subjectKind: 'general',
      conversationData: {
        activeTaskKind: 'profile_setup',
        activeOperatingProfileId: active.profileId,
      },
      supportedFollowups: ['anything_else'],
      operatingProfile: active,
    });
  }

  const intake = extractIntake(input.text);
  const plan =
    (await synthesizePlanWithOpenAi(intake)) || buildDeterministicPlan(intake);
  const existingProfiles = listOperatingProfilesForGroup(input.groupFolder);
  const draft: OperatingProfile = {
    profileId: crypto.randomUUID(),
    groupFolder: input.groupFolder,
    status: 'draft',
    version: (existingProfiles[0]?.version || 0) + 1,
    basedOnProfileId: activeProfile?.profileId || null,
    intakeJson: JSON.stringify(intake),
    planJson: JSON.stringify(plan),
    sourceChannel: input.channel,
    createdAt: nowIso,
    updatedAt: nowIso,
    approvedAt: null,
    supersededAt: null,
  };
  upsertOperatingProfile(draft);
  if (input.chatJid) {
    writeProfileSetupState(input.chatJid, {
      version: 1,
      createdAt: state?.createdAt || nowIso,
      draftProfileId: draft.profileId,
      notes: [...(state?.notes || []), intake.rawText].slice(-6),
    });
  }
  return buildResult({
    mode: 'profile_setup',
    replyText: formatPlanForChannel(input.channel, plan),
    summaryText: plan.summary,
    subjectKind: 'general',
    conversationData: {
      activeTaskKind: 'profile_setup',
      activeOperatingProfileId: draft.profileId,
    },
    supportedFollowups: ['say_more'],
    operatingProfile: draft,
  });
}

function maybeCreateSuggestionForItem(
  input: EverydayCaptureCommandInput,
  item: EverydayListItem,
  group: EverydayListGroup,
  profileId: string | null,
  nowIso: string,
): void {
  if (group.kind === 'bills') {
    proposeStarterSuggestion(
      input.groupFolder,
      profileId,
      input.channel,
      'Bills group',
      'Bills keep coming up. Want Andrea to keep a Bills group visible during weekly planning?',
      { kind: 'surface_bills_during_weekly_planning' },
      nowIso,
    );
  }
  if (
    /pills?|meds?|medication/i.test(item.title) ||
    (group.kind === 'checklist' && group.title.toLowerCase() === 'tonight')
  ) {
    proposeStarterSuggestion(
      input.groupFolder,
      profileId,
      input.channel,
      'Tonight meds',
      'Nightly meds keep coming up. Want Andrea to keep a Tonight group visible and offer reminder conversion for meds?',
      { kind: 'surface_tonight_meds' },
      nowIso,
    );
  }
}

async function handleAddItem(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const target = parseCaptureTarget(input.text, input);
  if (!target) return { handled: false };
  const nowIso = (input.now || new Date()).toISOString();
  const activeProfile = getActiveOperatingProfile(input.groupFolder);
  const group = ensureListGroup({
    groupFolder: input.groupFolder,
    operatingProfileId: activeProfile?.profileId,
    title: target.groupTitle,
    kind: target.groupKind,
    scope: target.scope || inferScope(input.text),
    sourceSummary: `Created from ${input.channel} everyday capture`,
    nowIso,
  });
  const item = createListItem({
    groupFolder: input.groupFolder,
    channel: input.channel,
    operatingProfileId: activeProfile?.profileId,
    group,
    title: target.title,
    itemKind: target.itemKind,
    scope: target.scope || group.scope,
    sourceSummary: normalizeText(input.text),
    detail: target.detail,
    dueAt: target.dueAt,
    scheduledFor: target.scheduledFor,
    nowIso,
  });
  maybeCreateSuggestionForItem(
    input,
    item,
    group,
    activeProfile?.profileId || null,
    nowIso,
  );
  return buildResult({
    mode: 'add_item',
    replyText: `I added that to ${formatGroupLabel(group)}.`,
    summaryText: item.title,
    subjectKind: 'saved_item',
    conversationData: {
      activeTaskKind: 'list_capture',
      activeListGroupId: group.groupId,
      activeListItemIds: [item.itemId],
      activeListScope: item.scope,
      activeOperatingProfileId: activeProfile?.profileId,
    },
    supportedFollowups: ['anything_else', 'create_reminder', 'save_for_later'],
    listGroup: group,
    listItems: [item],
  });
}

function filterReadItemsForTarget(
  input: EverydayCaptureCommandInput,
  target: ReadTarget,
): EverydayListItem[] {
  const now = input.now || new Date();
  if (target.kind === 'shopping') {
    return listEverydayListItems(input.groupFolder, { groupKind: 'shopping' });
  }
  if (target.kind === 'errands') {
    return listEverydayListItems(input.groupFolder, { groupKind: 'errands' });
  }
  if (target.kind === 'bills') {
    return listEverydayListItems(input.groupFolder, { groupKind: 'bills' }).filter(
      (item) => {
        if (!item.dueAt) return true;
        return Date.parse(item.dueAt) <= upcomingWeekEnd(now).getTime();
      },
    );
  }
  if (target.kind === 'meals') {
    return listEverydayListItems(input.groupFolder, { groupKind: 'meals' }).filter(
      (item) => {
        if (!item.scheduledFor) return true;
        return Date.parse(item.scheduledFor) <= upcomingWeekEnd(now).getTime();
      },
    );
  }
  if (target.kind === 'tonight') {
    return listEverydayListItems(input.groupFolder, {
      groupKind: 'shopping',
      includeDone: false,
      limit: 5,
    });
  }
  return listEverydayListItems(input.groupFolder, { includeDone: false, limit: 12 });
}

async function handleReadItems(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const target = parseReadTarget(input.text);
  if (!target) return { handled: false };
  const items = filterReadItemsForTarget(input, target);
  const groups = listEverydayListGroups(input.groupFolder);
  const formatted = formatReadout({
    channel: input.channel,
    target,
    items,
    groups,
  });
  return buildResult({
    mode: 'read_items',
    replyText: formatted.replyText,
    handoffOffer: formatted.handoffOffer,
    summaryText: target.summary,
    subjectKind: 'saved_item',
    conversationData: {
      activeTaskKind: 'list_read',
      activeListGroupId: items[0]?.groupId,
      activeListItemIds: items.slice(0, 5).map((item) => item.itemId),
      activeListScope: items[0]?.scope,
      activeOperatingProfileId: getActiveOperatingProfile(input.groupFolder)?.profileId,
    },
    supportedFollowups: ['anything_else', 'create_reminder', 'send_details'],
    listGroup: items[0] ? getEverydayListGroup(items[0].groupId) || null : null,
    listItems: items,
  });
}

async function handleUpdateItem(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const item = resolveActiveItem(input);
  if (!item) {
    return buildResult({
      mode: 'update_item',
      replyText: 'I need the item first before I can change it.',
      summaryText: 'no active list item',
      subjectKind: 'saved_item',
    });
  }
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  if (parseMarkDoneRequest(input.text)) {
    updateEverydayListItem(item.itemId, {
      state: 'done',
      completedAt: nowIso,
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. I marked ${item.title} done.`,
      summaryText: item.title,
      subjectKind: 'saved_item',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: item.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: item.scope,
      },
      supportedFollowups: ['anything_else'],
    });
  }
  if (parseRemoveRequest(input.text)) {
    deleteEverydayListItem(item.itemId);
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. I removed ${item.title}.`,
      summaryText: item.title,
      subjectKind: 'saved_item',
      supportedFollowups: ['anything_else'],
    });
  }
  if (parseMoveToNextWeekRequest(input.text)) {
    updateEverydayListItem(item.itemId, {
      state: 'deferred',
      deferUntil: startOfNextWeek(now).toISOString(),
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. I moved ${item.title} to next week.`,
      summaryText: item.title,
      subjectKind: 'saved_item',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: item.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: item.scope,
      },
      supportedFollowups: ['anything_else', 'create_reminder'],
    });
  }
  if (parseRemindLaterRequest(input.text)) {
    updateEverydayListItem(item.itemId, {
      state: 'snoozed',
      deferUntil: tomorrowAtHour(now, 9).toISOString(),
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. I will bring ${item.title} back tomorrow.`,
      summaryText: item.title,
      subjectKind: 'saved_item',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: item.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: item.scope,
      },
      supportedFollowups: ['anything_else', 'create_reminder'],
    });
  }
  return { handled: false };
}

async function handleConvertItem(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const item = resolveActiveItem(input);
  if (!item) {
    return buildResult({
      mode: 'convert_item',
      replyText: 'I need the item first before I can convert it.',
      summaryText: 'no active list item',
      subjectKind: 'saved_item',
    });
  }
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  if (parseConvertReminderRequest(input.text)) {
    if (!input.chatJid) {
      return buildResult({
        mode: 'convert_item',
        replyText: 'Tell me when, like tomorrow at 3, and I can turn that into a reminder.',
        summaryText: item.title,
        subjectKind: 'saved_item',
      });
    }
    writePendingReminderState(input.chatJid, {
      version: 1,
      itemId: item.itemId,
      title: item.title,
      createdAt: nowIso,
    });
    return buildResult({
      mode: 'convert_item',
      replyText: 'Sure. Tell me when you want the reminder.',
      summaryText: item.title,
      subjectKind: 'saved_item',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: item.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: item.scope,
      },
    });
  }
  if (parseConvertMissionRequest(input.text)) {
    const mission = await buildMissionTurn({
      channel: input.channel,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      text: `help me plan ${item.title}`,
      mode: 'propose',
      conversationSummary: input.conversationSummary,
      replyText: item.title,
      selectedWork: null,
      priorContext: input.priorContext || undefined,
      now,
    });
    updateEverydayListItem(item.itemId, {
      state: 'converted_to_mission',
      linkageJson: JSON.stringify({
        missionId: mission.mission.missionId,
      }),
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'convert_item',
      replyText:
        input.channel === 'alexa'
          ? `Okay. I turned ${item.title} into a plan.`
          : mission.replyText,
      summaryText: mission.summaryText,
      subjectKind: 'mission',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: item.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: item.scope,
      },
      supportedFollowups: ['anything_else', 'say_more', 'send_details'],
    });
  }
  if (parseSaveUnderThreadRequest(input.text)) {
    const threadResult = handleLifeThreadCommand({
      groupFolder: input.groupFolder,
      channel: input.channel,
      text: 'save this under household thread',
      chatJid: input.chatJid,
      replyText: item.title,
      conversationSummary: item.title,
      now,
    });
    if (threadResult.handled && threadResult.referencedThread) {
      updateEverydayListItem(item.itemId, {
        linkageJson: JSON.stringify({
          threadId: threadResult.referencedThread.id,
        }),
        updatedAt: nowIso,
      });
      return buildResult({
        mode: 'convert_item',
        replyText: `Okay. I saved ${item.title} under the household thread.`,
        summaryText: item.title,
        subjectKind: 'life_thread',
        conversationData: {
          activeTaskKind: 'list_update',
          activeListGroupId: item.groupId,
          activeListItemIds: [item.itemId],
          activeListScope: item.scope,
        },
        supportedFollowups: ['anything_else'],
      });
    }
  }
  return { handled: false };
}

export function getEverydayCaptureSignal(params: {
  groupFolder?: string;
  focus?: 'general' | 'tonight' | 'weekly';
  limit?: number;
  now?: Date;
}): string[] {
  if (!params.groupFolder) return [];
  const focus = params.focus || 'general';
  const limit = params.limit || 2;
  const now = params.now || new Date();
  const items = listEverydayListItems(params.groupFolder, {
    includeDone: false,
    limit: 12,
  }).filter((item) => {
    if (focus === 'weekly') {
      return (
        item.itemKind === 'bill' ||
        item.groupId ===
          findEverydayListGroupByKind(params.groupFolder!, 'bills')?.groupId
      );
    }
    if (focus === 'tonight') {
      return (
        item.groupId ===
          findEverydayListGroupByTitle(params.groupFolder!, 'Tonight')?.groupId ||
        /pills?|meds?|trash|batteries|groceries/i.test(item.title)
      );
    }
    return true;
  });
  return items.slice(0, limit).map((item) => {
    if (item.itemKind === 'bill') return `Bill: ${item.title}`;
    if (item.itemKind === 'meal_entry') return `Meal: ${item.title}`;
    if (/pills?|meds?|medication/i.test(item.title)) return `Tonight: ${item.title}`;
    return item.title;
  });
}

export async function handleEverydayCaptureCommand(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const normalized = normalizeText(input.text).toLowerCase();
  const pendingReminder =
    input.chatJid ? readPendingReminderState(input.chatJid) : null;
  const profileSetupState =
    input.chatJid ? readProfileSetupState(input.chatJid) : null;
  if (pendingReminder && input.chatJid) {
    const item = getEverydayListItem(pendingReminder.itemId);
    if (item) {
      const planned = planContextualReminder(
        input.text,
        item.title,
        input.groupFolder,
        input.chatJid,
        input.now || new Date(),
      );
      if (planned) {
        createTask(planned.task);
        syncOutcomeFromReminderTask(planned.task, {
          linkedRefs: {
            reminderTaskId: planned.task.id,
          },
          summaryText: planned.confirmation,
          now: input.now || new Date(),
        });
        updateEverydayListItem(item.itemId, {
          state: 'converted_to_reminder',
          linkageJson: JSON.stringify({
            reminderTaskId: planned.task.id,
          }),
          updatedAt: (input.now || new Date()).toISOString(),
        });
        writePendingReminderState(input.chatJid, null);
        return buildResult({
          mode: 'convert_item',
          replyText: planned.confirmation,
          summaryText: item.title,
          subjectKind: 'saved_item',
          conversationData: {
            activeTaskKind: 'list_update',
            activeListGroupId: item.groupId,
            activeListItemIds: [item.itemId],
            activeListScope: item.scope,
          },
          supportedFollowups: ['anything_else'],
        });
      }
    }
  }

  if (
    /^(help me set this up|walk me through what you should track for me|update my setup|change what you track|show me my current setup)\b/i.test(
      normalized,
    ) ||
    profileSetupState
  ) {
    const profileResult = await handleProfileSetup(input);
    if (profileResult.handled) return profileResult;
  }

  const captureResult = await handleAddItem(input);
  if (captureResult.handled) return captureResult;
  const readResult = await handleReadItems(input);
  if (readResult.handled) return readResult;
  const updateResult = await handleUpdateItem(input);
  if (updateResult.handled) return updateResult;
  const convertResult = await handleConvertItem(input);
  if (convertResult.handled) return convertResult;

  if (/^(dismiss that suggestion|reject that suggestion)\b/i.test(normalized)) {
    const suggestion = listOperatingProfileSuggestions(input.groupFolder, ['proposed'])[0];
    if (suggestion) {
      updateOperatingProfileSuggestionState(suggestion.suggestionId, 'dismissed', new Date().toISOString());
      return buildResult({
        mode: 'profile_review',
        replyText: 'Okay. I will leave that suggestion alone.',
        summaryText: suggestion.title,
        subjectKind: 'general',
      });
    }
  }

  return { handled: false };
}
