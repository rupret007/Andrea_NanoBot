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
import {
  buildOpenAiModelCandidates,
  detectOpenAiProviderMode,
  isOpenAiModelRejection,
} from './openai-model-routing.js';
import { recordOpenAiUsageState } from './openai-usage-state.js';
import { syncOutcomeFromReminderTask } from './outcome-reviews.js';
import type {
  AlexaConversationFollowupAction,
  AlexaConversationSubjectKind,
  ChannelInlineAction,
  EverydayListGroup,
  EverydayListGroupKind,
  EverydayListItem,
  EverydayListItemKind,
  EverydayListRecurrenceKind,
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
  sendOptions?: {
    inlineActions?: ChannelInlineAction[];
    inlineActionRows?: ChannelInlineAction[][];
  };
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
  kind:
    | 'all'
    | 'shopping'
    | 'errands'
    | 'bills'
    | 'meals'
    | 'household'
    | 'tonight'
    | 'weekend'
    | 'recurring'
    | 'recently_completed'
    | 'slipping'
    | 'dinner_missing';
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
  recurrence?: EverydayListRecurrence;
}

interface EverydayListRecurrence {
  kind: EverydayListRecurrenceKind;
  interval: number;
  days?: number[];
  dayOfMonth?: number | null;
  anchorAt?: string | null;
  nextDueAt?: string | null;
}

interface EverydayActionToken {
  targetMode: 'read' | 'update' | 'convert';
  action:
    | 'view_all'
    | 'view_group'
    | 'view_recurring'
    | 'done'
    | 'reopen'
    | 'remove'
    | 'defer_week'
    | 'remind'
    | 'move'
    | 'stop_repeat'
    | 'convert_reminder'
    | 'convert_plan'
    | 'convert_thread';
  itemId?: string;
  groupKind?: ReadTarget['kind'];
  moveGroupKind?: EverydayListGroupKind;
  moveGroupTitle?: string;
}

interface EverydayItemDetailMeta {
  deferCount?: number;
  lastDeferredAt?: string | null;
  mealHints?: string[] | null;
}

interface HouseholdSmartViewSection {
  title: string;
  items: EverydayListItem[];
}

interface HouseholdSmartView {
  lead: string | null;
  emptyLine: string;
  items: EverydayListItem[];
  sections: HouseholdSmartViewSection[];
  handoffOffer?: string;
  nextStep?: string;
}

const PROFILE_SETUP_STATE_PREFIX = 'everyday_capture:profile_setup:';
const REMINDER_STATE_PREFIX = 'everyday_capture:pending_reminder:';
const EVERYDAY_ACTION_PREFIX = 'ev:';
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

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function defaultScopeForGroupKind(kind: EverydayListGroupKind): EverydayListScope {
  return kind === 'household' ? 'household' : 'personal';
}

function buildDefaultListGroups(
  groupFolder: string,
  nowIso: string,
  operatingProfileId?: string | null,
): EverydayListGroup[] {
  const defaultKinds: EverydayListGroupKind[] = [
    'shopping',
    'errands',
    'bills',
    'meals',
    'household',
    'checklist',
    'general',
  ];
  return defaultKinds.map((kind) => {
    const template = DEFAULT_GROUP_TEMPLATES[kind];
    return {
      groupId: crypto.randomUUID(),
      groupFolder,
      operatingProfileId: operatingProfileId || null,
      title: template.title,
      kind,
      scope: defaultScopeForGroupKind(kind),
      sourceSummary: template.purpose,
      createdAt: nowIso,
      updatedAt: nowIso,
      archivedAt: null,
    };
  });
}

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
  const providerMode = detectOpenAiProviderMode(openAi.baseUrl);
  const modelCandidates = buildOpenAiModelCandidates('standard', {
    simpleModel: openAi.simpleModel,
    standardModel: openAi.standardModel,
    complexModel: openAi.complexModel,
    fallbackModel: openAi.researchModel,
  });

  try {
    for (const candidate of modelCandidates) {
      const response = await fetch(`${openAi.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAi.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          input: prompt,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        if (isOpenAiModelRejection(response.status, text)) {
          continue;
        }
        recordOpenAiUsageState({
          at: new Date().toISOString(),
          surface: 'everyday_capture',
          selectedModelTier: candidate.tier,
          selectedModel: candidate.model,
          providerMode,
          outcome: /quota|billing|rejected the configured api key|denied by the provider/i.test(
            text,
          )
            ? 'blocked'
            : 'failed',
          detail: describeOpenAiProviderFailure(response.status, text, 'research'),
        });
        return null;
      }
      const payload = (await response.json()) as unknown;
      const output = stripJsonFences(extractResponseOutputText(payload));
      if (!output) {
        continue;
      }
      const parsed = safeJsonParse<Partial<OperatingProfilePlan>>(output, {});
      if (!parsed.summary || !Array.isArray(parsed.defaultGroups)) {
        continue;
      }
      recordOpenAiUsageState({
        at: new Date().toISOString(),
        surface: 'everyday_capture',
        selectedModelTier: candidate.tier,
        selectedModel: candidate.model,
        providerMode,
        outcome: 'success',
        detail: 'operating_profile_plan',
      });
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
    }
  } catch {
    return null;
  }
  return null;
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

function ensureBaselineListGroups(params: {
  groupFolder: string;
  nowIso: string;
  activeProfile?: OperatingProfile | null;
}): EverydayListGroup[] {
  const existing = listEverydayListGroups(params.groupFolder);
  if (existing.length > 0) return existing;

  if (params.activeProfile?.planJson) {
    const plan = safeJsonParse<OperatingProfilePlan | null>(
      params.activeProfile.planJson,
      null,
    );
    if (plan?.defaultGroups?.length) {
      return seedGroupsFromPlan(
        params.groupFolder,
        params.activeProfile.profileId,
        plan,
        params.nowIso,
      );
    }
  }

  const groups = buildDefaultListGroups(
    params.groupFolder,
    params.nowIso,
    params.activeProfile?.profileId,
  );
  for (const group of groups) {
    upsertEverydayListGroup(group);
  }
  return groups;
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

function nextWeekdayAt(reference: Date, weekday: number, hour = 9): Date {
  const target = new Date(reference);
  const offset = (weekday - target.getDay() + 7) % 7 || 7;
  target.setDate(target.getDate() + offset);
  target.setHours(hour, 0, 0, 0);
  return target;
}

function addDays(reference: Date, days: number): Date {
  const target = new Date(reference);
  target.setDate(target.getDate() + days);
  return target;
}

function addMonths(reference: Date, months: number, dayOfMonth?: number | null): Date {
  const target = new Date(reference);
  const preferredDay = dayOfMonth || target.getDate();
  target.setMonth(target.getMonth() + months, 1);
  const lastDay = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  target.setDate(Math.min(preferredDay, lastDay));
  return target;
}

function parseItemDetailMeta(item: Pick<EverydayListItem, 'detailJson'>): EverydayItemDetailMeta {
  return safeJsonParse<EverydayItemDetailMeta>(item.detailJson, {});
}

function buildDeferDetailPatch(item: Pick<EverydayListItem, 'detailJson'>, nowIso: string) {
  const detail = parseItemDetailMeta(item);
  return {
    deferCount: (detail.deferCount || 0) + 1,
    lastDeferredAt: nowIso,
  };
}

function resetDeferDetailPatch(item: Pick<EverydayListItem, 'detailJson'>) {
  const detail = parseItemDetailMeta(item);
  if (!detail.deferCount && !detail.lastDeferredAt) return item.detailJson || null;
  return mergeDetailJson(item.detailJson, {
    deferCount: 0,
    lastDeferredAt: null,
  });
}

function isActionableItem(item: EverydayListItem): boolean {
  return item.state === 'open' || item.state === 'snoozed' || item.state === 'deferred';
}

function parseIsoOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfDay(reference: Date): Date {
  const target = new Date(reference);
  target.setHours(0, 0, 0, 0);
  return target;
}

function endOfDay(reference: Date): Date {
  const target = new Date(reference);
  target.setHours(23, 59, 59, 999);
  return target;
}

function getItemTargetMoment(item: EverydayListItem): number | null {
  return (
    parseIsoOrNull(item.dueAt) ||
    parseIsoOrNull(item.scheduledFor) ||
    parseIsoOrNull(item.deferUntil) ||
    parseIsoOrNull(item.recurrenceNextDueAt)
  );
}

function isOverdue(item: EverydayListItem, now: Date): boolean {
  const target = parseIsoOrNull(item.dueAt) || parseIsoOrNull(item.recurrenceNextDueAt);
  return target !== null && target < now.getTime();
}

function isDueWithinDays(
  item: EverydayListItem,
  now: Date,
  days: number,
  includeOverdue = true,
): boolean {
  const target = getItemTargetMoment(item);
  if (target === null) return false;
  const upper = endOfDay(addDays(now, days)).getTime();
  if (includeOverdue) return target <= upper;
  return target >= now.getTime() && target <= upper;
}

function isWithinRecentDays(
  value: string | null | undefined,
  now: Date,
  days: number,
): boolean {
  const parsed = parseIsoOrNull(value);
  if (parsed === null) return false;
  return parsed >= startOfDay(addDays(now, -days)).getTime();
}

function itemTokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length > 2 &&
          !['for', 'the', 'and', 'with', 'from', 'that', 'this', 'idea', 'meal', 'dinner'].includes(token),
      ),
  );
}

function buildGroupMap(groups: EverydayListGroup[]): Map<string, EverydayListGroup> {
  return new Map(groups.map((group) => [group.groupId, group]));
}

function isGroupTitle(group: EverydayListGroup | undefined, title: string): boolean {
  return (group?.title || '').toLowerCase() === title.toLowerCase();
}

function isWeekendItem(
  item: EverydayListItem,
  groupsById: Map<string, EverydayListGroup>,
  now: Date,
): boolean {
  const group = groupsById.get(item.groupId);
  if (isGroupTitle(group, 'Weekend')) return true;
  const target = getItemTargetMoment(item);
  return target !== null && target <= upcomingWeekEnd(now).getTime();
}

function isTonightItem(
  item: EverydayListItem,
  groupsById: Map<string, EverydayListGroup>,
  now: Date,
): boolean {
  const group = groupsById.get(item.groupId);
  if (isGroupTitle(group, 'Tonight')) return true;
  const target = parseIsoOrNull(item.scheduledFor) || parseIsoOrNull(item.dueAt);
  return target !== null && target <= endOfDay(now).getTime();
}

function sortItemsByUrgency(items: EverydayListItem[], now: Date): EverydayListItem[] {
  return [...items].sort((left, right) => {
    const leftOverdue = isOverdue(left, now) ? 0 : 1;
    const rightOverdue = isOverdue(right, now) ? 0 : 1;
    if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue;
    const leftTime = getItemTargetMoment(left) ?? Number.MAX_SAFE_INTEGER;
    const rightTime = getItemTargetMoment(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function summarizeSlice(items: EverydayListItem[], count = 3): string {
  return joinNaturalLanguage(
    items.slice(0, count).map((item) => item.title.replace(/[.!?]+$/g, '')),
  );
}

function resolveRecurrenceBaseDate(
  now: Date,
  item: Pick<
    EverydayListItem,
    'dueAt' | 'scheduledFor' | 'deferUntil' | 'recurrenceAnchorAt' | 'createdAt'
  >,
): Date {
  const candidate =
    item.recurrenceAnchorAt ||
    item.dueAt ||
    item.scheduledFor ||
    item.deferUntil ||
    item.createdAt;
  const parsed = candidate ? Date.parse(candidate) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(now);
}

function buildRecurrenceDetail(recurrence: EverydayListRecurrence): Record<string, unknown> {
  return {
    recurrenceKind: recurrence.kind,
    recurrenceInterval: recurrence.interval,
    recurrenceDays: recurrence.days || [],
    recurrenceDayOfMonth: recurrence.dayOfMonth || null,
    recurrenceAnchorAt: recurrence.anchorAt || null,
    recurrenceNextDueAt: recurrence.nextDueAt || null,
  };
}

function mergeDetailJson(
  existing: string | null | undefined,
  patch: Record<string, unknown>,
): string {
  const base = safeJsonParse<Record<string, unknown>>(existing, {});
  return JSON.stringify({
    ...base,
    ...patch,
  });
}

function extractRecurrence(text: string, now: Date): EverydayListRecurrence | null {
  const normalized = normalizeText(text).toLowerCase();
  if (/\b(?:every day|daily)\b/.test(normalized)) {
    return {
      kind: 'daily',
      interval: 1,
      anchorAt: now.toISOString(),
      nextDueAt: addDays(now, 1).toISOString(),
    };
  }
  const weekdayMatch = normalized.match(
    /\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  );
  if (weekdayMatch?.[1]) {
    const weekday = WEEKDAY_INDEX[weekdayMatch[1]];
    return {
      kind: 'weekly',
      interval: 1,
      days: [weekday],
      anchorAt: now.toISOString(),
      nextDueAt: nextWeekdayAt(now, weekday).toISOString(),
    };
  }
  if (/\b(?:every week|weekly)\b/.test(normalized)) {
    return {
      kind: 'weekly',
      interval: 1,
      anchorAt: now.toISOString(),
      nextDueAt: addDays(now, 7).toISOString(),
    };
  }
  if (/\b(?:every month|monthly)\b/.test(normalized)) {
    return {
      kind: 'monthly',
      interval: 1,
      dayOfMonth: now.getDate(),
      anchorAt: now.toISOString(),
      nextDueAt: addMonths(now, 1, now.getDate()).toISOString(),
    };
  }
  return null;
}

function computeNextRecurrenceDueAt(
  item: Pick<
    EverydayListItem,
    | 'dueAt'
    | 'scheduledFor'
    | 'deferUntil'
    | 'recurrenceKind'
    | 'recurrenceInterval'
    | 'recurrenceDaysJson'
    | 'recurrenceDayOfMonth'
    | 'recurrenceAnchorAt'
    | 'createdAt'
  >,
  completedAt: Date,
): string | null {
  const recurrenceKind = item.recurrenceKind || 'none';
  const recurrenceInterval = Math.max(1, item.recurrenceInterval || 1);
  if (recurrenceKind === 'none') return null;

  const base = resolveRecurrenceBaseDate(completedAt, item);
  if (recurrenceKind === 'daily') {
    return addDays(base, recurrenceInterval).toISOString();
  }
  if (recurrenceKind === 'weekly') {
    const days = safeJsonParse<number[]>(item.recurrenceDaysJson, []).filter(
      (day) => Number.isInteger(day) && day >= 0 && day <= 6,
    );
    if (days.length > 0) {
      return nextWeekdayAt(completedAt, days[0]!, base.getHours() || 9).toISOString();
    }
    return addDays(base, 7 * recurrenceInterval).toISOString();
  }
  if (recurrenceKind === 'monthly') {
    return addMonths(base, recurrenceInterval, item.recurrenceDayOfMonth).toISOString();
  }
  return null;
}

function refreshRecurringItems(groupFolder: string, now: Date): void {
  const items = listEverydayListItems(groupFolder, {
    includeDone: true,
    limit: 500,
  });
  const nowMs = now.getTime();
  for (const item of items) {
    if ((item.recurrenceKind || 'none') === 'none') continue;
    if (!item.recurrenceNextDueAt) continue;
    if (Date.parse(item.recurrenceNextDueAt) > nowMs) continue;
    if (item.state === 'open') continue;
    updateEverydayListItem(item.itemId, {
      state: 'open',
      dueAt: item.recurrenceNextDueAt,
      deferUntil: null,
      detailJson: resetDeferDetailPatch(item),
      completedAt: null,
      updatedAt: now.toISOString(),
    });
  }
}

function parseEverydayActionToken(text: string): EverydayActionToken | null {
  const normalized = normalizeText(text);
  if (!normalized.startsWith(EVERYDAY_ACTION_PREFIX)) return null;

  const parts = normalized.split(':');
  if (parts.length < 2) return null;
  const codeToGroup = (
    code: string,
  ): { kind: ReadTarget['kind']; title?: string } | null => {
    switch (code) {
      case 'a':
        return { kind: 'all' };
      case 's':
        return { kind: 'shopping', title: 'Groceries' };
      case 'e':
        return { kind: 'errands', title: 'Errands' };
      case 'b':
        return { kind: 'bills', title: 'Bills' };
      case 'm':
        return { kind: 'meals', title: 'Meals' };
      case 'h':
        return { kind: 'household', title: 'Household' };
      case 't':
        return { kind: 'tonight', title: 'Tonight' };
      case 'w':
      case 'wk':
        return { kind: 'weekend', title: 'Weekend' };
      case 'r':
        return { kind: 'recurring' };
      case 'rc':
        return { kind: 'recently_completed', title: 'Recently completed' };
      case 'sl':
        return { kind: 'slipping', title: 'Slipping' };
      case 'dn':
        return { kind: 'dinner_missing', title: 'Dinner' };
      default:
        return null;
    }
  };

  if (parts[1] === 'v') {
    const group = codeToGroup(parts[2] || '');
    if (!group) return null;
    if (group.kind === 'recurring') {
      return { targetMode: 'read', action: 'view_recurring', groupKind: 'recurring' };
    }
    return { targetMode: 'read', action: 'view_group', groupKind: group.kind };
  }

  if (parts[1] === 'd' || parts[1] === 'o' || parts[1] === 'x') {
    return {
      targetMode: 'update',
      action:
        parts[1] === 'd' ? 'done' : parts[1] === 'o' ? 'reopen' : 'remove',
      itemId: parts[2],
    };
  }

  if (parts[1] === 'w' || parts[1] === 'n' || parts[1] === 'q') {
    return {
      targetMode: 'update',
      action:
        parts[1] === 'w'
          ? 'defer_week'
          : parts[1] === 'n'
            ? 'remind'
            : 'stop_repeat',
      itemId: parts[2],
    };
  }

  if (parts[1] === 'g') {
    const code = parts[2] || '';
    const group = codeToGroup(code);
    if (!group) return null;
    return {
      targetMode: 'update',
      action: 'move',
      moveGroupKind:
        code === 'w'
          ? 'checklist'
          : group.kind === 'tonight'
            ? 'checklist'
            : (group.kind as EverydayListGroupKind),
      moveGroupTitle: group.title,
      itemId: parts[3],
    };
  }

  if (parts[1] === 'c') {
    return {
      targetMode: 'convert',
      action:
        parts[2] === 'r'
          ? 'convert_reminder'
          : parts[2] === 'p'
            ? 'convert_plan'
            : 'convert_thread',
      itemId: parts[3],
    };
  }
  return null;
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
  const shouldPreferExplicitTitle =
    Boolean(params.title?.trim()) &&
    title.toLowerCase() !== DEFAULT_GROUP_TEMPLATES[params.kind].title.toLowerCase();
  const existing = shouldPreferExplicitTitle
    ? findEverydayListGroupByTitle(params.groupFolder, title)
    : findEverydayListGroupByTitle(params.groupFolder, title) ||
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

function formatItemLine(item: EverydayListItem, now: Date): string {
  const base = item.title.replace(/[.!?]+$/g, '');
  const labels: string[] = [];
  if (item.state === 'done' && isWithinRecentDays(item.completedAt, now, 3)) {
    labels.push('done');
  } else if (isOverdue(item, now)) {
    labels.push('overdue');
  } else if (item.itemKind === 'bill' && isDueWithinDays(item, now, 7, false)) {
    labels.push('due this week');
  } else if (item.state === 'snoozed' && item.deferUntil) {
    labels.push('tomorrow');
  } else if (item.state === 'deferred' && item.deferUntil) {
    labels.push('next horizon');
  }
  if (item.recurrenceKind && item.recurrenceKind !== 'none') {
    labels.push(item.recurrenceKind);
  }
  return labels.length > 0 ? `${base} (${labels.join(', ')})` : base;
}

function buildEverydayActionId(
  action:
    | 'done'
    | 'reopen'
    | 'remove'
    | 'defer_week'
    | 'remind'
    | 'stop_repeat'
    | 'convert_reminder'
    | 'convert_plan'
    | 'convert_thread',
  itemId: string,
): string {
  const code =
    action === 'done'
      ? 'd'
      : action === 'reopen'
        ? 'o'
        : action === 'remove'
          ? 'x'
          : action === 'defer_week'
            ? 'w'
            : action === 'remind'
              ? 'n'
              : action === 'stop_repeat'
                ? 'q'
                : action === 'convert_reminder'
                  ? 'c:r'
                  : action === 'convert_plan'
                    ? 'c:p'
                    : 'c:t';
  return `${EVERYDAY_ACTION_PREFIX}${code}:${itemId}`;
}

function buildEverydayMoveActionId(
  groupKind: EverydayListGroupKind,
  itemId: string,
): string {
  const code =
    groupKind === 'shopping'
      ? 's'
      : groupKind === 'errands'
        ? 'e'
        : groupKind === 'bills'
          ? 'b'
          : groupKind === 'meals'
            ? 'm'
            : groupKind === 'household'
              ? 'h'
              : 't';
  return `${EVERYDAY_ACTION_PREFIX}g:${code}:${itemId}`;
}

function buildViewActionId(target: ReadTarget['kind'] | 'all'): string {
  const code =
    target === 'all'
      ? 'a'
      : target === 'shopping'
        ? 's'
        : target === 'errands'
          ? 'e'
          : target === 'bills'
            ? 'b'
            : target === 'meals'
              ? 'm'
              : target === 'household'
                ? 'h'
                : target === 'tonight'
                  ? 't'
                  : target === 'weekend'
                    ? 'wk'
                    : target === 'recently_completed'
                      ? 'rc'
                      : target === 'slipping'
                        ? 'sl'
                        : target === 'dinner_missing'
                          ? 'dn'
                          : 'r';
  return `${EVERYDAY_ACTION_PREFIX}v:${code}`;
}

function buildTelegramEverydayInlineActionRows(params: {
  target: ReadTarget;
  items: EverydayListItem[];
}): ChannelInlineAction[][] {
  const rows: ChannelInlineAction[][] = [];
  const primary = params.items[0];
  if (params.target.kind === 'all') {
    rows.push([
      { label: 'Groceries', actionId: buildViewActionId('shopping') },
      { label: 'Errands', actionId: buildViewActionId('errands') },
      { label: 'Bills', actionId: buildViewActionId('bills') },
    ]);
    rows.push([
      { label: 'Tonight', actionId: buildViewActionId('tonight') },
      { label: 'Weekend', actionId: buildViewActionId('weekend') },
      { label: 'Household', actionId: buildViewActionId('household') },
    ]);
    rows.push([
      { label: 'Meals', actionId: buildViewActionId('meals') },
      { label: 'Recurring', actionId: buildViewActionId('recurring') },
      { label: 'Recent', actionId: buildViewActionId('recently_completed') },
    ]);
  } else {
    rows.push([
      { label: 'All', actionId: buildViewActionId('all') },
      { label: 'Tonight', actionId: buildViewActionId('tonight') },
      { label: 'Weekend', actionId: buildViewActionId('weekend') },
    ]);
    rows.push([
      { label: 'Groceries', actionId: buildViewActionId('shopping') },
      { label: 'Bills', actionId: buildViewActionId('bills') },
      { label: 'Recurring', actionId: buildViewActionId('recurring') },
    ]);
    rows.push([
      { label: 'Household', actionId: buildViewActionId('household') },
      { label: 'Meals', actionId: buildViewActionId('meals') },
      { label: 'Recent', actionId: buildViewActionId('recently_completed') },
    ]);
  }

  if (!primary) return rows;

  rows.push([
    primary.state === 'done'
      ? { label: 'Reopen', actionId: buildEverydayActionId('reopen', primary.itemId) }
      : { label: 'Done', actionId: buildEverydayActionId('done', primary.itemId) },
    { label: 'Defer', actionId: buildEverydayActionId('defer_week', primary.itemId) },
    { label: 'Remind', actionId: buildEverydayActionId('convert_reminder', primary.itemId) },
  ]);
  rows.push([
    { label: 'Groceries', actionId: buildEverydayMoveActionId('shopping', primary.itemId) },
    { label: 'Tonight', actionId: buildEverydayMoveActionId('checklist', primary.itemId) },
    { label: 'Weekend', actionId: `${EVERYDAY_ACTION_PREFIX}g:w:${primary.itemId}` },
  ]);
  rows.push([
    { label: 'Plan', actionId: buildEverydayActionId('convert_plan', primary.itemId) },
    { label: 'Thread', actionId: buildEverydayActionId('convert_thread', primary.itemId) },
    ...(primary.recurrenceKind && primary.recurrenceKind !== 'none'
      ? [{ label: 'Stop repeat', actionId: buildEverydayActionId('stop_repeat', primary.itemId) }]
      : []),
  ]);
  return rows.filter((row) => row.length > 0);
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
  recurrence?: EverydayListRecurrence | null;
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
    detailJson:
      params.detail || params.recurrence
        ? JSON.stringify({
            ...(params.detail || {}),
            ...(params.recurrence
              ? buildRecurrenceDetail(params.recurrence)
              : {}),
          })
        : null,
    linkageJson: null,
    dueAt: params.dueAt || null,
    scheduledFor: params.scheduledFor || null,
    deferUntil: null,
    recurrenceKind: params.recurrence?.kind || 'none',
    recurrenceInterval: params.recurrence?.interval || 1,
    recurrenceDaysJson: params.recurrence?.days
      ? JSON.stringify(params.recurrence.days)
      : null,
    recurrenceDayOfMonth: params.recurrence?.dayOfMonth || null,
    recurrenceAnchorAt: params.recurrence?.anchorAt || null,
    recurrenceNextDueAt: params.recurrence?.nextDueAt || null,
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
  const now = input.now || new Date();
  const recurrence = extractRecurrence(raw, now);

  const stripRecurrenceLanguage = (value: string): string =>
    clip(
      value
        .replace(/\b(?:every day|daily|every week|weekly|every month|monthly)\b/gi, '')
        .replace(
          /\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
          '',
        )
        .replace(/\s+/g, ' ')
        .trim(),
      );

  const rawWithoutRecurrence = stripRecurrenceLanguage(raw);
  const lower = rawWithoutRecurrence.toLowerCase();
  const scope = inferScope(rawWithoutRecurrence || raw);

  const shoppingMatch =
    rawWithoutRecurrence.match(
      /^(?:add|put)\s+(.+?)\s+to\s+(?:my\s+)?(?:shopping|grocery) list$/i,
    ) ||
    rawWithoutRecurrence.match(/^(?:add|put)\s+(.+?)\s+on\s+(?:my\s+)?list$/i) ||
    rawWithoutRecurrence.match(/^(?:add|put)\s+(.+?)\s+to groceries$/i);
  if (shoppingMatch?.[1]) {
    return {
      title: stripRecurrenceLanguage(shoppingMatch[1]),
      groupKind: 'shopping',
      itemKind: 'shopping_item',
      scope,
      recurrence: recurrence || undefined,
    };
  }

  const errandMatch =
    rawWithoutRecurrence.match(/^save (?:this|that|(.+?)) as an errand$/i) ||
    rawWithoutRecurrence.match(/^save (?:this|that|(.+?)) as errands?$/i);
  if (errandMatch) {
    return {
      title: stripRecurrenceLanguage(
        resolveReferenceText(input, errandMatch[1] || null),
      ),
      groupKind: 'errands',
      itemKind: 'errand',
      scope,
      recurrence: recurrence || undefined,
    };
  }

  const billMatch =
      rawWithoutRecurrence.match(/^add (.+?) to (?:my\s+)?list$/i) &&
      /\bbill|pay\b/i.test(rawWithoutRecurrence)
        ? rawWithoutRecurrence.match(/^add (.+?) to (?:my\s+)?list$/i)
        : rawWithoutRecurrence.match(/^add (.+?) to bills$/i) ||
          raw.match(/^make (?:this|that) a monthly bill$/i);
  if (billMatch?.[1]) {
    const title = stripRecurrenceLanguage(billMatch[1]);
    return {
      title,
      groupKind: 'bills',
      itemKind: 'bill',
      scope,
        dueAt: /\bthis week\b/i.test(rawWithoutRecurrence)
          ? upcomingWeekEnd(now).toISOString()
          : null,
      recurrence:
        recurrence || /\bmonthly bill\b/i.test(raw)
          ? recurrence || {
              kind: 'monthly',
              interval: 1,
              dayOfMonth: now.getDate(),
              anchorAt: now.toISOString(),
              nextDueAt: addMonths(now, 1, now.getDate()).toISOString(),
            }
          : undefined,
    };
  }

  const mealMatch =
      rawWithoutRecurrence.match(/^add (.+?) for friday$/i) ||
      rawWithoutRecurrence.match(/^add (.+?) to meals$/i) ||
      rawWithoutRecurrence.match(/^add (.+?) for this week$/i) ||
      rawWithoutRecurrence.match(/^add dinner idea for friday$/i);
  if (mealMatch) {
    const title =
        /^add dinner idea for friday$/i.test(rawWithoutRecurrence)
          ? 'Dinner idea'
          : stripRecurrenceLanguage(mealMatch[1] || 'Meal');
    return {
      title,
      groupKind: 'meals',
      itemKind: 'meal_entry',
      scope,
      scheduledFor:
          /\bfriday\b/i.test(rawWithoutRecurrence) ||
          /^add dinner idea for friday$/i.test(rawWithoutRecurrence)
            ? upcomingFridayOrNull(now, rawWithoutRecurrence)
            : /\bthis week\b/i.test(rawWithoutRecurrence)
              ? upcomingWeekEnd(now).toISOString()
              : null,
      recurrence: recurrence || undefined,
    };
  }

  const tonightMatch =
      rawWithoutRecurrence.match(/^add (.+?) to tonight$/i) ||
      rawWithoutRecurrence.match(/^put (.+?) in tonight'?s plan$/i) ||
      rawWithoutRecurrence.match(/^add my pills to tonight$/i);
  if (tonightMatch) {
    const title =
        /^add my pills to tonight$/i.test(rawWithoutRecurrence)
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
      recurrence: recurrence || undefined,
    };
  }

  const weekendMatch =
      rawWithoutRecurrence.match(/^put (?:this|that|(.+?)) on the weekend list$/i) ||
      rawWithoutRecurrence.match(/^make (?:this|that|(.+?)) part of my weekend list$/i);
  if (weekendMatch) {
    const title = stripRecurrenceLanguage(
      resolveReferenceText(input, weekendMatch[1] || null),
    );
    if (!title) return null;
    return {
      title,
      groupKind: 'checklist',
      itemKind: 'general_item',
      groupTitle: 'Weekend',
      scope,
      scheduledFor: startOfNextWeek(now).toISOString(),
      recurrence: recurrence || undefined,
    };
  }

  if (
      /^save that under the household thread$/i.test(rawWithoutRecurrence) ||
      /^save this under the household thread$/i.test(rawWithoutRecurrence)
  ) {
    return null;
  }

    const saveUnderMatch = rawWithoutRecurrence.match(
      /^(?:save|track) (?:this|that|(.+?)) under ([a-z][a-z0-9' -]+)$/i,
    );
  if (saveUnderMatch) {
    return {
      title: stripRecurrenceLanguage(
        resolveReferenceText(input, saveUnderMatch[1] || null),
      ),
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
      recurrence: recurrence || undefined,
    };
  }

  if (/^track that for the household$/i.test(rawWithoutRecurrence)) {
    return {
      title: stripRecurrenceLanguage(resolveReferenceText(input)),
      groupKind: 'household',
      itemKind: 'general_item',
      scope: 'household',
      recurrence: recurrence || undefined,
    };
  }

  if (
    /^remember this$/i.test(rawWithoutRecurrence) ||
    /^save this as a list item$/i.test(rawWithoutRecurrence)
  ) {
    const title = stripRecurrenceLanguage(resolveReferenceText(input));
    if (!title) return null;
    return {
      title,
      groupKind: 'general',
      itemKind: 'general_item',
      scope,
      recurrence: recurrence || undefined,
    };
  }

  if (/^put batteries on my list$/i.test(rawWithoutRecurrence)) {
    return {
      title: 'Batteries',
      groupKind: 'shopping',
      itemKind: 'shopping_item',
      scope,
    };
  }

  if (/^add milk to my shopping list$/i.test(rawWithoutRecurrence)) {
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
  const actionToken = parseEverydayActionToken(text);
  if (actionToken?.targetMode === 'read') {
    if (actionToken.groupKind && actionToken.groupKind !== 'all') {
      return {
        kind: actionToken.groupKind,
        summary:
          actionToken.groupKind === 'shopping'
            ? 'groceries'
            : actionToken.groupKind === 'bills'
              ? 'bills this week'
              : actionToken.groupKind === 'meals'
                ? 'meals this week'
            : actionToken.groupKind === 'household'
              ? 'household'
              : actionToken.groupKind === 'weekend'
                ? 'this weekend'
                : actionToken.groupKind === 'recently_completed'
                  ? 'recently completed'
                  : actionToken.groupKind === 'dinner_missing'
                    ? 'dinner'
              : actionToken.groupKind,
      };
    }
    return { kind: 'all', summary: 'your list' };
  }

  const normalized = normalizeText(text).toLowerCase();
  if (/^what('?s| is) on my list\b/.test(normalized)) {
    return { kind: 'all', summary: 'your list' };
  }
  if (
    /^(show me|what('?s| is) on) my (grocery|shopping) list\b/.test(normalized)
  ) {
    return { kind: 'shopping', summary: 'groceries' };
  }
  if (
    /^(what('?s| is) on groceries|what do (?:we|i) need from the store(?: again)?)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'shopping', summary: 'groceries' };
  }
  if (/^what do i still need to buy\b/.test(normalized)) {
    return { kind: 'shopping', summary: 'groceries' };
  }
  if (/^what errands do i have\b/.test(normalized)) {
    return { kind: 'errands', summary: 'errands' };
  }
  if (
    /^(what bills do i need to pay(?: this week| soon)?|what bills are due this week)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'bills', summary: 'bills this week' };
  }
  if (
    /^(what meals have i planned(?: this week)?|what meal ideas do i have this week|what meal do i have planned)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'meals', summary: 'meals this week' };
  }
  if (
    /^what household (?:items|things|stuff) (?:are )?(?:still open|do i have)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'household', summary: 'household' };
  }
  if (/^what should i remember to get tonight\b/.test(normalized)) {
    return { kind: 'tonight', summary: 'tonight' };
  }
  if (/^what('?s| is) left for tonight\b/.test(normalized)) {
    return { kind: 'tonight', summary: 'tonight' };
  }
  if (/^what should i handle this weekend\b/.test(normalized)) {
    return { kind: 'weekend', summary: 'this weekend' };
  }
  if (/^what('?s| is) missing for dinner\b/.test(normalized)) {
    return { kind: 'dinner_missing', summary: 'dinner' };
  }
  if (/^what recurring (?:things|items) (?:are )?(?:coming back|coming up)(?: soon)?\b/.test(normalized)) {
    return { kind: 'recurring', summary: 'recurring items' };
  }
  if (/^what did i (?:finish|get done) lately\b/.test(normalized)) {
    return { kind: 'recently_completed', summary: 'recently completed' };
  }
  if (/^what('?s| is) slipping\b/.test(normalized)) {
    return { kind: 'slipping', summary: 'slipping items' };
  }
  if (/^what('?s| is) still open\b/.test(normalized)) {
    return { kind: 'all', summary: 'still open' };
  }
  return null;
}

function parseMarkDoneRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (actionToken?.targetMode === 'update' && actionToken.action === 'done') {
    return true;
  }
  return /^(mark that done|check that off|mark this done|check this off)$/i.test(
    normalizeText(text),
  );
}

function parseReopenRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (actionToken?.targetMode === 'update' && actionToken.action === 'reopen') {
    return true;
  }
  return /^(reopen that|reopen this)$/i.test(normalizeText(text));
}

function parseRemoveRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (actionToken?.targetMode === 'update' && actionToken.action === 'remove') {
    return true;
  }
  return /^(remove that|remove this|delete that|delete this)$/i.test(
    normalizeText(text),
  );
}

function parseMoveToNextWeekRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (
    actionToken?.targetMode === 'update' &&
    actionToken.action === 'defer_week'
  ) {
    return true;
  }
  return /^(move that to next week|move this to next week)$/i.test(
    normalizeText(text),
  );
}

function parseRemindLaterRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (actionToken?.targetMode === 'update' && actionToken.action === 'remind') {
    return true;
  }
  return /^(remind me about that tomorrow|remind me about this tomorrow)$/i.test(
    normalizeText(text),
  );
}

function parseMoveGroupRequest(
  text: string,
): { groupKind: EverydayListGroupKind; groupTitle?: string } | null {
  const actionToken = parseEverydayActionToken(text);
  if (
    actionToken?.targetMode === 'update' &&
    actionToken.action === 'move' &&
    actionToken.moveGroupKind
  ) {
    return {
      groupKind: actionToken.moveGroupKind,
      groupTitle: actionToken.moveGroupTitle,
    };
  }

  const normalized = normalizeText(text);
  if (/^save (?:that|this) under the household thread$/i.test(normalized)) {
    return null;
  }
  const moveMatch =
    normalized.match(/^(?:move|save|add) (?:that|this) to ([a-z][a-z0-9' -]+)$/i) ||
    normalized.match(/^(?:save) (?:that|this) under ([a-z][a-z0-9' -]+)$/i) ||
    normalized.match(/^make (?:that|this) part of my ([a-z][a-z0-9' -]+) list$/i) ||
    normalized.match(/^put (?:that|this) in tonight'?s plan$/i);

  if (!moveMatch) return null;
  const rawTarget =
    /^put (?:that|this) in tonight'?s plan$/i.test(normalized)
      ? 'Tonight'
      : moveMatch[1];
  const lower = rawTarget.toLowerCase();
  if (/grocery|grocer|shopping/.test(lower)) {
    return { groupKind: 'shopping', groupTitle: 'Groceries' };
  }
  if (/weekend/.test(lower)) {
    return { groupKind: 'checklist', groupTitle: 'Weekend' };
  }
  if (/tonight/.test(lower)) {
    return { groupKind: 'checklist', groupTitle: 'Tonight' };
  }
  if (/household|home/.test(lower)) {
    return { groupKind: 'household', groupTitle: 'Household' };
  }
  if (/bill/.test(lower)) {
    return { groupKind: 'bills', groupTitle: 'Bills' };
  }
  if (/meal/.test(lower)) {
    return { groupKind: 'meals', groupTitle: 'Meals' };
  }
  if (/errand/.test(lower)) {
    return { groupKind: 'errands', groupTitle: 'Errands' };
  }
  return { groupKind: 'general', groupTitle: toTitleCase(rawTarget) };
}

function parseStopRepeatingRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (
    actionToken?.targetMode === 'update' &&
    actionToken.action === 'stop_repeat'
  ) {
    return true;
  }
  return /^(stop repeating that|stop repeating this)$/i.test(normalizeText(text));
}

function parseRecurringUpdate(
  text: string,
  now: Date,
): EverydayListRecurrence | null {
  const normalized = normalizeText(text);
  if (/^make (?:this|that) a monthly bill$/i.test(normalized)) {
    return {
      kind: 'monthly',
      interval: 1,
      dayOfMonth: now.getDate(),
      anchorAt: now.toISOString(),
      nextDueAt: addMonths(now, 1, now.getDate()).toISOString(),
    };
  }
  if (/^repeat (?:this|that) /i.test(normalized)) {
    return extractRecurrence(normalized, now);
  }
  return null;
}

function parseConvertReminderRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (
    actionToken?.targetMode === 'convert' &&
    actionToken.action === 'convert_reminder'
  ) {
    return true;
  }
  return /^(turn that into a reminder|turn this into a reminder)$/i.test(
    normalizeText(text),
  );
}

function parseConvertMissionRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (
    actionToken?.targetMode === 'convert' &&
    actionToken.action === 'convert_plan'
  ) {
    return true;
  }
  return /^(make this part of my plan|make that part of my plan)$/i.test(
    normalizeText(text),
  );
}

function parseSaveUnderThreadRequest(text: string): boolean {
  const actionToken = parseEverydayActionToken(text);
  if (
    actionToken?.targetMode === 'convert' &&
    actionToken.action === 'convert_thread'
  ) {
    return true;
  }
  return /^(save that under the household thread|save this under the household thread)$/i.test(
    normalizeText(text),
  );
}

function resolveActiveItem(
  input: EverydayCaptureCommandInput,
): EverydayListItem | null {
  const actionToken = parseEverydayActionToken(input.text);
  if (actionToken?.itemId) {
    const directItem = getEverydayListItem(actionToken.itemId);
    if (directItem && directItem.groupFolder === input.groupFolder) {
      return directItem;
    }
  }
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

function buildSection(title: string, items: EverydayListItem[]): HouseholdSmartViewSection | null {
  return items.length > 0 ? { title, items } : null;
}

function flattenSectionItems(
  sections: HouseholdSmartViewSection[],
  limit = 5,
): EverydayListItem[] {
  return sections.flatMap((section) => section.items).slice(0, limit);
}

function buildHouseholdSmartView(params: {
  groupFolder: string;
  target: ReadTarget;
  groups: EverydayListGroup[];
  now: Date;
}): HouseholdSmartView {
  const { groupFolder, target, groups, now } = params;
  const groupsById = buildGroupMap(groups);
  const allItems = listEverydayListItems(groupFolder, {
    includeDone: true,
    limit: 300,
  });
  const actionableItems = allItems.filter(isActionableItem);
  const recentlyCompleted = sortItemsByUrgency(
    allItems.filter(
      (item) => item.state === 'done' && isWithinRecentDays(item.completedAt, now, 3),
    ),
    now,
  );
  const groceries = [...actionableItems]
    .filter((item) => {
      const group = groupsById.get(item.groupId);
      return group?.kind === 'shopping' || item.itemKind === 'shopping_item';
    })
    .sort((left, right) => {
      const leftPriority = left.scope === 'household' ? 0 : 1;
      const rightPriority = right.scope === 'household' ? 0 : 1;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  const errands = sortItemsByUrgency(
    actionableItems.filter((item) => {
      const group = groupsById.get(item.groupId);
      return group?.kind === 'errands' || item.itemKind === 'errand';
    }),
    now,
  );
  const bills = [...actionableItems]
    .filter((item) => {
      const group = groupsById.get(item.groupId);
      return group?.kind === 'bills' || item.itemKind === 'bill';
    })
    .filter((item) => !item.dueAt || isDueWithinDays(item, now, 7))
    .sort((left, right) => {
      const leftBucket = isOverdue(left, now)
        ? 0
        : isDueWithinDays(left, now, 7, false)
          ? 1
          : 2;
      const rightBucket = isOverdue(right, now)
        ? 0
        : isDueWithinDays(right, now, 7, false)
          ? 1
          : 2;
      if (leftBucket !== rightBucket) return leftBucket - rightBucket;
      return sortItemsByUrgency([left, right], now)[0] === left ? -1 : 1;
    });
  const meals = [...actionableItems]
    .filter((item) => {
      const group = groupsById.get(item.groupId);
      return group?.kind === 'meals' || item.itemKind === 'meal_entry';
    })
    .filter((item) => !item.scheduledFor || isDueWithinDays(item, now, 7))
    .sort((left, right) => {
      const leftTime = parseIsoOrNull(left.scheduledFor) ?? Number.MAX_SAFE_INTEGER;
      const rightTime = parseIsoOrNull(right.scheduledFor) ?? Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  const household = sortItemsByUrgency(
    actionableItems.filter((item) => {
      const group = groupsById.get(item.groupId);
      return item.scope === 'household' || group?.kind === 'household';
    }),
    now,
  );
  const tonight = sortItemsByUrgency(
    actionableItems.filter((item) => {
      if (isTonightItem(item, groupsById, now)) return true;
      if (item.itemKind === 'bill' && isDueWithinDays(item, now, 2)) return true;
      return false;
    }),
    now,
  );
  const weekend = sortItemsByUrgency(
    actionableItems.filter((item) => isWeekendItem(item, groupsById, now)),
    now,
  );
  const recurringSoon = sortItemsByUrgency(
    actionableItems.filter(
      (item) =>
        (item.recurrenceKind || 'none') !== 'none' &&
        (!item.recurrenceNextDueAt || isDueWithinDays(item, now, 7)),
    ),
    now,
  );
  const slipping = sortItemsByUrgency(
    actionableItems.filter((item) => {
      const detail = parseItemDetailMeta(item);
      const deferCount = detail.deferCount || 0;
      const targetTime = getItemTargetMoment(item);
      return (
        deferCount >= 2 ||
        (targetTime !== null && targetTime < startOfDay(addDays(now, -2)).getTime())
      );
    }),
    now,
  );

  const tonightMeal =
    meals.find((item) => isTonightItem(item, groupsById, now)) ||
    meals.find((item) => isDueWithinDays(item, now, 3)) ||
    meals[0];
  const dinnerMissing = tonightMeal
    ? groceries.filter((item) => {
        const mealHints = parseItemDetailMeta(tonightMeal).mealHints || [];
        const itemTitle = normalizeText(item.title).toLowerCase();
        const mealTitle = normalizeText(tonightMeal.title).toLowerCase();
        if (mealHints.some((hint) => itemTitle.includes(hint.toLowerCase()))) return true;
        if (mealTitle.includes(itemTitle)) return true;
        const groceryTokens = itemTokenSet(item.title);
        const mealTokens = itemTokenSet(tonightMeal.title);
        return [...groceryTokens].some((token) => mealTokens.has(token));
      })
    : [];

  const allSections = [
    buildSection('Tonight', tonight.slice(0, 3)),
    buildSection('Bills This Week', bills.slice(0, 3)),
    buildSection('Groceries', groceries.slice(0, 4)),
    buildSection('Errands', errands.slice(0, 3)),
    buildSection('Meals This Week', meals.slice(0, 3)),
    buildSection('Household Open', household.slice(0, 3)),
    buildSection('Recurring Soon', recurringSoon.slice(0, 3)),
  ].filter((section): section is HouseholdSmartViewSection => Boolean(section));

  switch (target.kind) {
    case 'shopping':
      return {
        lead:
          groceries.length > 0
            ? `From the store, you still need ${summarizeSlice(groceries)}.`
            : null,
        emptyLine: 'You do not have anything left to buy right now.',
        items: groceries,
        sections: [buildSection('Groceries', groceries)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
        handoffOffer:
          groceries.length > 4 ? 'If you want, I can send the fuller store list to Telegram.' : undefined,
        nextStep:
          tonight.length > 0 ? 'I can tell you what matters most for tonight too.' : undefined,
      };
    case 'errands':
      return {
        lead:
          errands.length > 0
            ? `You still have ${errands.length} errand${errands.length === 1 ? '' : 's'} left. ${summarizeSlice(errands)}.`
            : null,
        emptyLine: 'You do not have any open errands right now.',
        items: errands,
        sections: [buildSection('Errands', errands)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
        handoffOffer:
          errands.length > 4 ? 'If you want, I can send the fuller errand list to Telegram.' : undefined,
      };
    case 'bills':
      return {
        lead:
          bills.length > 0
            ? isOverdue(bills[0]!, now)
              ? `The biggest household thing still open this week is ${bills[0]!.title}.`
              : `The biggest bill in view this week is ${bills[0]!.title}.`
            : null,
        emptyLine: 'I do not see any open bills in view right now.',
        items: bills,
        sections: [buildSection('Bills This Week', bills)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
        handoffOffer:
          bills.length > 3 ? 'If you want, I can send the fuller bills view to Telegram.' : undefined,
      };
    case 'meals':
      return {
        lead:
          meals.length > 0
            ? `This week's meal plan starts with ${summarizeSlice(meals)}.`
            : null,
        emptyLine: 'You do not have meal plans in view right now.',
        items: meals,
        sections: [buildSection('Meals This Week', meals)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
        handoffOffer:
          meals.length > 3 ? 'If you want, I can send the fuller meal view to Telegram.' : undefined,
        nextStep:
          groceries.length > 0 ? "I can check what's missing for dinner too." : undefined,
      };
    case 'household':
      return {
        lead:
          household.length > 0
            ? `Around the house, the main things still open are ${summarizeSlice(household, 2)}.`
            : null,
        emptyLine: 'Your household list looks clear right now.',
        items: household,
        sections: [buildSection('Household Open', household)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
        handoffOffer:
          household.length > 4 ? 'If you want, I can send the fuller household view to Telegram.' : undefined,
      };
    case 'tonight':
      {
        const tonightCarryover = [
          ...tonight,
          ...bills.slice(0, 2),
          ...groceries.slice(0, 3),
        ].filter(
          (item, index, all) => all.findIndex((candidate) => candidate.itemId === item.itemId) === index,
        );
        return {
          lead:
            tonight.length > 0
              ? `For tonight, ${summarizeSlice(tonight, 2)} are the main loose ends.`
              : groceries.length > 0
                ? 'For tonight, the store run is the main loose end.'
                : bills.length > 0
                  ? `For tonight, the biggest thing still hanging over the week is ${bills[0]!.title}.`
            : null,
        emptyLine: 'Tonight looks fairly clear right now.',
        items: tonightCarryover,
        sections: [
          buildSection('Tonight', tonight.filter((item) => isTonightItem(item, groupsById, now)).slice(0, 4)),
          buildSection('Bills This Week', bills.slice(0, 2)),
          buildSection('Groceries', groceries.slice(0, 3)),
        ].filter((section): section is HouseholdSmartViewSection => Boolean(section)),
        handoffOffer:
          tonightCarryover.length > 3 ? 'If you want, I can send the fuller tonight view to Telegram.' : undefined,
      };
      }
    case 'weekend':
      return {
        lead:
          weekend.length > 0
            ? `For the weekend, ${summarizeSlice(weekend, 2)} are the main things to handle.`
            : null,
        emptyLine: 'This weekend looks fairly clear right now.',
        items: weekend,
        sections: [
          buildSection('Weekend', weekend.filter((item) => isGroupTitle(groupsById.get(item.groupId), 'Weekend')).slice(0, 4)),
          buildSection('Errands', errands.filter((item) => isWeekendItem(item, groupsById, now)).slice(0, 3)),
          buildSection('Household Open', household.filter((item) => isWeekendItem(item, groupsById, now)).slice(0, 3)),
        ].filter((section): section is HouseholdSmartViewSection => Boolean(section)),
        handoffOffer:
          weekend.length > 4 ? 'If you want, I can send the fuller weekend view to Telegram.' : undefined,
      };
    case 'recurring':
      return {
        lead:
          recurringSoon.length > 0
            ? `Coming up soon, ${summarizeSlice(recurringSoon, 2)} are coming back into view.`
            : null,
        emptyLine: 'Nothing recurring is coming back into view right now.',
        items: recurringSoon,
        sections: [buildSection('Recurring Soon', recurringSoon)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
      };
    case 'recently_completed':
      return {
        lead:
          recentlyCompleted.length > 0
            ? `Recently finished, you closed ${summarizeSlice(recentlyCompleted, 2)}.`
            : null,
        emptyLine: 'Nothing was completed recently enough to call out right now.',
        items: recentlyCompleted,
        sections: [buildSection('Recently Completed', recentlyCompleted)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
      };
    case 'slipping':
      return {
        lead:
          slipping.length > 0
            ? `The things most likely to slip are ${summarizeSlice(slipping, 2)}.`
            : null,
        emptyLine: 'Nothing looks like it is slipping badly right now.',
        items: slipping,
        sections: [buildSection('Slipping', slipping)].filter(
          (section): section is HouseholdSmartViewSection => Boolean(section),
        ),
      };
    case 'dinner_missing':
      if (!tonightMeal) {
        return {
          lead: 'I do not see a dinner plan locked in for tonight yet.',
          emptyLine: 'I do not see a dinner plan locked in for tonight yet.',
          items: meals.slice(0, 2),
          sections: [buildSection('Meals This Week', meals.slice(0, 3))].filter(
            (section): section is HouseholdSmartViewSection => Boolean(section),
          ),
          nextStep:
            meals.length > 0 ? 'I can show the meal ideas you do have this week.' : undefined,
        };
      }
      if (dinnerMissing.length === 0) {
        return {
          lead: 'Dinner looks planned, and nothing specific is flagged as missing.',
          emptyLine: 'Dinner looks planned, and nothing specific is flagged as missing.',
          items: [tonightMeal],
          sections: [buildSection('Dinner Tonight', [tonightMeal])].filter(
            (section): section is HouseholdSmartViewSection => Boolean(section),
          ),
          nextStep:
            groceries.length > 0 ? 'I can still show the store list if you want.' : undefined,
        };
      }
      return {
        lead: `Dinner looks planned, but you're still missing ${summarizeSlice(dinnerMissing, 3)}.`,
        emptyLine: 'Dinner looks planned, and nothing specific is flagged as missing.',
        items: dinnerMissing,
        sections: [
          buildSection('Dinner Tonight', [tonightMeal]),
          buildSection('Still Missing', dinnerMissing),
        ].filter((section): section is HouseholdSmartViewSection => Boolean(section)),
        handoffOffer:
          dinnerMissing.length > 3 ? 'If you want, I can send the fuller dinner breakdown to Telegram.' : undefined,
      };
    case 'all':
    default:
      return {
        lead:
          allSections[0]?.title === 'Tonight'
            ? `For tonight, ${summarizeSlice(allSections[0].items, 2)} are the main loose ends.`
            : bills[0]
              ? `The main household loose end this week is ${bills[0].title}.`
              : groceries[0]
                ? `From the store, you still need ${summarizeSlice(groceries, 3)}.`
                : null,
        emptyLine: 'Your list looks clear right now.',
        items: flattenSectionItems(allSections),
        sections: allSections,
        handoffOffer:
          flattenSectionItems(allSections, 20).length > 6
            ? 'If you want, I can send the fuller household review to Telegram.'
            : undefined,
        nextStep:
          tonight.length > 0 ? "I can tell you what's left for tonight next." : undefined,
      };
  }
}

function formatReadout(params: {
  channel: EverydayCaptureCommandInput['channel'];
  target: ReadTarget;
  view: HouseholdSmartView;
  now: Date;
}): {
  replyText: string;
  handoffOffer?: string;
  sendOptions?: EverydayCaptureCommandResult['sendOptions'];
} {
  if (params.view.sections.length === 0 && params.view.items.length === 0) {
    return {
      replyText:
        params.channel === 'telegram'
          ? `${params.view.emptyLine}\n\nYou can add groceries, errands, bills, meal ideas, or something for tonight.`
          : params.view.emptyLine,
      sendOptions:
        params.channel === 'telegram'
          ? {
              inlineActionRows: [
                [
                  { label: 'Groceries', actionId: buildViewActionId('shopping') },
                  { label: 'Bills', actionId: buildViewActionId('bills') },
                  { label: 'Tonight', actionId: buildViewActionId('tonight') },
                ],
              ],
            }
          : undefined,
    };
  }

  if (params.channel === 'alexa') {
    const slice = params.view.items
      .slice(0, 3)
      .map((item) => item.title.replace(/[.!?]+$/g, ''));
    const summary =
      params.view.lead ||
      (params.target.kind === 'shopping'
        ? `You still need ${joinNaturalLanguage(slice)}.`
        : params.target.kind === 'bills'
          ? `The biggest thing still open is ${slice[0]}.`
          : params.target.kind === 'errands'
            ? `You have ${params.view.items.length} errands left. ${joinNaturalLanguage(slice)}.`
            : params.target.kind === 'recurring'
              ? `Coming back soon, you have ${joinNaturalLanguage(slice)}.`
              : `You still have ${joinNaturalLanguage(slice)}.`);
    return {
      replyText:
        params.view.items.length > 3 || Boolean(params.view.handoffOffer)
          ? `${summary} ${params.view.handoffOffer || 'If you want, I can send the fuller list to Telegram.'}`
          : summary,
      handoffOffer: params.view.handoffOffer || (params.view.items.length > 3
        ? 'If you want, I can send the fuller list to Telegram.'
        : undefined),
    };
  }

  const lines: string[] = [];
  if (params.view.lead) {
    lines.push(params.view.lead);
    lines.push('');
  }
  for (const section of params.view.sections) {
    lines.push(`*${section.title}*`);
    lines.push(...section.items.map((item) => `- ${formatItemLine(item, params.now)}`));
    lines.push('');
  }
  if (params.view.nextStep) lines.push(params.view.nextStep);
  return {
    replyText: lines.join('\n').trim(),
    handoffOffer: params.view.handoffOffer,
    sendOptions:
      params.channel === 'telegram'
        ? {
            inlineActionRows: buildTelegramEverydayInlineActionRows({
              target: params.target,
              items: params.view.items,
            }),
          }
        : undefined,
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
  ensureBaselineListGroups({
    groupFolder: input.groupFolder,
    nowIso,
    activeProfile,
  });
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
    recurrence: target.recurrence,
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
    sendOptions:
      input.channel === 'telegram'
        ? {
            inlineActionRows: buildTelegramEverydayInlineActionRows({
              target: { kind: 'all', summary: 'your list' },
              items: [item],
            }),
          }
        : undefined,
    listGroup: group,
    listItems: [item],
  });
}

async function handleReadItems(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const target = parseReadTarget(input.text);
  if (!target) return { handled: false };
  const now = input.now || new Date();
  const activeProfile = getActiveOperatingProfile(input.groupFolder);
  ensureBaselineListGroups({
    groupFolder: input.groupFolder,
    nowIso: now.toISOString(),
    activeProfile,
  });
  refreshRecurringItems(input.groupFolder, now);
  const groups = listEverydayListGroups(input.groupFolder);
  const view = buildHouseholdSmartView({
    groupFolder: input.groupFolder,
    target,
    groups,
    now,
  });
  const formatted = formatReadout({
    channel: input.channel,
    target,
    view,
    now,
  });
  return buildResult({
    mode: 'read_items',
    replyText: formatted.replyText,
    handoffOffer: formatted.handoffOffer,
    summaryText: target.summary,
    subjectKind: 'saved_item',
    sendOptions: formatted.sendOptions,
    conversationData: {
      activeTaskKind: 'list_read',
      activeListGroupId: view.items[0]?.groupId,
      activeListItemIds: view.items.slice(0, 5).map((item) => item.itemId),
      activeListScope: view.items[0]?.scope,
      activeOperatingProfileId: activeProfile?.profileId,
    },
    supportedFollowups: ['anything_else', 'create_reminder', 'send_details'],
    listGroup: view.items[0] ? getEverydayListGroup(view.items[0].groupId) || null : null,
    listItems: view.items,
  });
}

async function handleUpdateItem(
  input: EverydayCaptureCommandInput,
): Promise<EverydayCaptureCommandResult> {
  const readTarget = parseReadTarget(input.text);
  if (readTarget) {
    return handleReadItems(input);
  }
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
    const recurrenceNextDueAt = computeNextRecurrenceDueAt(item, now);
    updateEverydayListItem(item.itemId, {
      state: 'done',
      detailJson: resetDeferDetailPatch(item),
      recurrenceNextDueAt,
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
  if (parseReopenRequest(input.text)) {
    updateEverydayListItem(item.itemId, {
      state: 'open',
      deferUntil: null,
      completedAt: null,
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. I reopened ${item.title}.`,
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
      detailJson: mergeDetailJson(item.detailJson, buildDeferDetailPatch(item, nowIso)),
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
  const moveGroup = parseMoveGroupRequest(input.text);
  if (moveGroup) {
    const targetGroup = ensureListGroup({
      groupFolder: input.groupFolder,
      operatingProfileId: item.operatingProfileId,
      title: moveGroup.groupTitle,
      kind: moveGroup.groupKind,
      scope:
        moveGroup.groupKind === 'household' ? 'household' : item.scope,
      sourceSummary: `Organized from ${input.channel} everyday capture`,
      nowIso,
    });
    updateEverydayListItem(item.itemId, {
      groupId: targetGroup.groupId,
      state: 'open',
      scope: targetGroup.scope,
      itemKind:
        targetGroup.kind === 'shopping'
          ? 'shopping_item'
          : targetGroup.kind === 'errands'
            ? 'errand'
            : targetGroup.kind === 'bills'
              ? 'bill'
              : targetGroup.kind === 'meals'
                ? 'meal_entry'
                : item.itemKind,
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. I moved ${item.title} to ${formatGroupLabel(targetGroup)}.`,
      summaryText: item.title,
      subjectKind: 'saved_item',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: targetGroup.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: targetGroup.scope,
      },
      supportedFollowups: ['anything_else', 'create_reminder'],
    });
  }
  const recurrence = parseRecurringUpdate(input.text, now);
  if (recurrence) {
    const targetGroup =
      /^make (?:this|that) a monthly bill$/i.test(normalizeText(input.text))
        ? ensureListGroup({
            groupFolder: input.groupFolder,
            operatingProfileId: item.operatingProfileId,
            title: 'Bills',
            kind: 'bills',
            scope: item.scope,
            sourceSummary: 'Recurring bills',
            nowIso,
          })
        : null;
    updateEverydayListItem(item.itemId, {
      groupId: targetGroup?.groupId || item.groupId,
      itemKind: targetGroup ? 'bill' : item.itemKind,
      state: 'open',
      detailJson: mergeDetailJson(item.detailJson, buildRecurrenceDetail(recurrence)),
      recurrenceKind: recurrence.kind,
      recurrenceInterval: recurrence.interval,
      recurrenceDaysJson: recurrence.days
        ? JSON.stringify(recurrence.days)
        : null,
      recurrenceDayOfMonth: recurrence.dayOfMonth || null,
      recurrenceAnchorAt: recurrence.anchorAt || nowIso,
      recurrenceNextDueAt: recurrence.nextDueAt || null,
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText:
        recurrence.kind === 'monthly'
          ? `Okay. I will keep ${item.title} as a monthly bill.`
          : `Okay. I will repeat ${item.title} ${
              recurrence.kind === 'weekly'
                ? recurrence.days?.length
                  ? `every ${
                      Object.entries(WEEKDAY_INDEX).find(
                        ([, value]) => value === recurrence.days?.[0],
                      )?.[0] || 'week'
                    }`
                  : 'every week'
                : 'daily'
            }.`,
      summaryText: item.title,
      subjectKind: 'saved_item',
      conversationData: {
        activeTaskKind: 'list_update',
        activeListGroupId: targetGroup?.groupId || item.groupId,
        activeListItemIds: [item.itemId],
        activeListScope: item.scope,
      },
      supportedFollowups: ['anything_else', 'create_reminder'],
    });
  }
  if (parseStopRepeatingRequest(input.text)) {
    updateEverydayListItem(item.itemId, {
      recurrenceKind: 'none',
      recurrenceInterval: 1,
      recurrenceDaysJson: null,
      recurrenceDayOfMonth: null,
      recurrenceAnchorAt: null,
      recurrenceNextDueAt: null,
      detailJson: mergeDetailJson(item.detailJson, {
        recurrenceKind: 'none',
        recurrenceInterval: 1,
        recurrenceDays: [],
        recurrenceDayOfMonth: null,
        recurrenceAnchorAt: null,
        recurrenceNextDueAt: null,
      }),
      updatedAt: nowIso,
    });
    return buildResult({
      mode: 'update_item',
      replyText: `Okay. ${item.title} will stop repeating.`,
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
  if (parseRemindLaterRequest(input.text)) {
    updateEverydayListItem(item.itemId, {
      state: 'snoozed',
      deferUntil: tomorrowAtHour(now, 9).toISOString(),
      detailJson: mergeDetailJson(item.detailJson, buildDeferDetailPatch(item, nowIso)),
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
  ensureBaselineListGroups({
    groupFolder: params.groupFolder,
    nowIso: now.toISOString(),
    activeProfile: getActiveOperatingProfile(params.groupFolder),
  });
  refreshRecurringItems(params.groupFolder, now);
  const groups = listEverydayListGroups(params.groupFolder);
  const targets =
    focus === 'weekly'
      ? ([
          { kind: 'bills', summary: 'bills this week' },
          { kind: 'weekend', summary: 'this weekend' },
          { kind: 'recurring', summary: 'recurring items' },
        ] as ReadTarget[])
      : focus === 'tonight'
        ? ([
            { kind: 'tonight', summary: 'tonight' },
            { kind: 'shopping', summary: 'groceries' },
          ] as ReadTarget[])
        : ([{ kind: 'all', summary: 'your list' }] as ReadTarget[]);
  const items = targets.flatMap((target) =>
    buildHouseholdSmartView({
      groupFolder: params.groupFolder!,
      target,
      groups,
      now,
    }).items,
  );
  const unique = [...new Map(items.map((item) => [item.itemId, item])).values()];
  return unique.slice(0, limit).map((item) => {
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
