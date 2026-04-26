import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import {
  createTask,
  getLifeThread,
  getRitualProfileByType,
  getTaskById,
  listRitualProfilesForGroup,
  updateLifeThread,
  updateTask,
  upsertRitualProfile,
} from './db.js';
import { handlePersonalizationCommand } from './assistant-personalization.js';
import { handleLifeThreadCommand } from './life-threads.js';
import type {
  RitualProfile,
  RitualScope,
  RitualSourceInput,
  RitualToneStyle,
  RitualTriggerStyle,
  RitualType,
  ScheduledTask,
} from './types.js';
import { buildVoiceReply } from './voice-ready.js';

const DEFAULT_RITUAL_SOURCE_INPUTS: Record<RitualType, RitualSourceInput[]> = {
  morning_brief: [
    'calendar',
    'reminders',
    'life_threads',
    'current_work',
    'profile_facts',
  ],
  midday_reground: ['calendar', 'reminders', 'life_threads', 'current_work'],
  evening_reset: ['calendar', 'reminders', 'life_threads', 'knowledge_library'],
  open_guidance: [
    'calendar',
    'reminders',
    'life_threads',
    'current_work',
    'knowledge_library',
  ],
  thread_followthrough: ['life_threads', 'reminders', 'knowledge_library'],
  household_checkin: ['life_threads', 'calendar', 'knowledge_library'],
  transition_prompt: ['calendar', 'reminders', 'life_threads', 'current_work'],
};

function ritualId(groupFolder: string, ritualType: RitualType): string {
  return `${groupFolder}:ritual:${ritualType}`;
}

function ritualTaskId(groupFolder: string, ritualType: RitualType): string {
  return `${groupFolder}:ritual-task:${ritualType}`;
}

function ritualLabel(ritualType: RitualType): string {
  switch (ritualType) {
    case 'morning_brief':
      return 'Morning brief';
    case 'midday_reground':
      return 'Midday re-grounding';
    case 'evening_reset':
      return 'Evening reset';
    case 'open_guidance':
      return 'Open guidance';
    case 'thread_followthrough':
      return 'Thread follow-through';
    case 'household_checkin':
      return 'Household check-in';
    case 'transition_prompt':
      return 'Leave-transition prompt';
  }
}

function defaultPromptForRitual(ritualType: RitualType): string | null {
  switch (ritualType) {
    case 'morning_brief':
      return 'Good morning';
    case 'midday_reground':
      return 'Anything I should know?';
    case 'evening_reset':
      return 'What should I remember tonight?';
    case 'thread_followthrough':
      return 'What should I follow up on?';
    case 'household_checkin':
      return "What's still open with Candace?";
    case 'transition_prompt':
      return 'What should I handle before I leave?';
    case 'open_guidance':
      return null;
  }
}

function defaultScheduleForRitual(ritualType: RitualType): {
  scheduleType: ScheduledTask['schedule_type'];
  scheduleValue: string;
  weekdaysOnly: boolean;
} | null {
  switch (ritualType) {
    case 'morning_brief':
      return {
        scheduleType: 'cron',
        scheduleValue: '15 7 * * 1-5',
        weekdaysOnly: true,
      };
    case 'midday_reground':
      return {
        scheduleType: 'cron',
        scheduleValue: '30 12 * * 1-5',
        weekdaysOnly: true,
      };
    case 'evening_reset':
      return {
        scheduleType: 'cron',
        scheduleValue: '30 19 * * *',
        weekdaysOnly: false,
      };
    case 'thread_followthrough':
      return {
        scheduleType: 'cron',
        scheduleValue: '30 18 * * 1-5',
        weekdaysOnly: true,
      };
    case 'household_checkin':
      return {
        scheduleType: 'cron',
        scheduleValue: '0 18 * * *',
        weekdaysOnly: false,
      };
    case 'transition_prompt':
      return {
        scheduleType: 'cron',
        scheduleValue: '30 16 * * 1-5',
        weekdaysOnly: true,
      };
    case 'open_guidance':
      return null;
  }
}

function defaultTimingForRitual(
  ritualType: RitualType,
): RitualProfile['timing'] {
  switch (ritualType) {
    case 'morning_brief':
      return { localTime: '07:15', weekdaysOnly: true, anchor: 'morning' };
    case 'midday_reground':
      return { localTime: '12:30', weekdaysOnly: true, anchor: 'midday' };
    case 'evening_reset':
      return { localTime: '19:30', weekdaysOnly: false, anchor: 'evening' };
    case 'thread_followthrough':
      return { localTime: '18:30', weekdaysOnly: true, anchor: 'evening' };
    case 'household_checkin':
      return { localTime: '18:00', weekdaysOnly: false, anchor: 'evening' };
    case 'transition_prompt':
      return { localTime: '16:30', weekdaysOnly: true, anchor: 'before_leave' };
    case 'open_guidance':
      return { anchor: 'morning' };
  }
}

function defaultTriggerStyle(ritualType: RitualType): RitualTriggerStyle {
  switch (ritualType) {
    case 'open_guidance':
      return 'on_request';
    case 'morning_brief':
    case 'evening_reset':
      return 'suggested';
    case 'midday_reground':
    case 'thread_followthrough':
    case 'household_checkin':
    case 'transition_prompt':
      return 'suggested';
  }
}

function defaultScope(ritualType: RitualType): RitualScope {
  switch (ritualType) {
    case 'household_checkin':
      return 'household';
    case 'thread_followthrough':
      return 'mixed';
    case 'transition_prompt':
      return 'work';
    default:
      return 'personal';
  }
}

function defaultToneStyle(ritualType: RitualType): RitualToneStyle {
  switch (ritualType) {
    case 'transition_prompt':
      return 'brief';
    case 'household_checkin':
      return 'supportive';
    default:
      return 'balanced';
  }
}

export function buildDefaultRitualProfile(
  groupFolder: string,
  ritualType: RitualType,
  now = new Date(),
): RitualProfile {
  return {
    id: ritualId(groupFolder, ritualType),
    groupFolder,
    ritualType,
    enabled: ritualType === 'open_guidance',
    triggerStyle: defaultTriggerStyle(ritualType),
    scope: defaultScope(ritualType),
    timing: defaultTimingForRitual(ritualType),
    toneStyle: defaultToneStyle(ritualType),
    sourceInputs: DEFAULT_RITUAL_SOURCE_INPUTS[ritualType],
    lastRunAt: null,
    nextDueAt: null,
    optInState: ritualType === 'open_guidance' ? 'opted_in' : 'not_set',
    linkedTaskId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

const DEFAULT_RITUAL_ORDER: RitualType[] = [
  'morning_brief',
  'midday_reground',
  'evening_reset',
  'open_guidance',
  'thread_followthrough',
  'household_checkin',
  'transition_prompt',
];

export function listResolvedRitualProfiles(
  groupFolder: string,
  now = new Date(),
): RitualProfile[] {
  const stored = listRitualProfilesForGroup(groupFolder);
  const byType = new Map(
    stored.map((profile) => [profile.ritualType, profile]),
  );
  return DEFAULT_RITUAL_ORDER.map(
    (ritualType) =>
      byType.get(ritualType) ||
      buildDefaultRitualProfile(groupFolder, ritualType, now),
  );
}

export function getResolvedRitualProfile(
  groupFolder: string,
  ritualType: RitualType,
  now = new Date(),
): RitualProfile {
  return (
    getRitualProfileByType(groupFolder, ritualType) ||
    buildDefaultRitualProfile(groupFolder, ritualType, now)
  );
}

function computeNextRunFromCron(
  value: string,
  now = new Date(),
): string | null {
  try {
    return CronExpressionParser.parse(value, {
      currentDate: now,
      tz: TIMEZONE,
    })
      .next()
      .toISOString();
  } catch {
    return null;
  }
}

function syncScheduledTaskForProfile(
  profile: RitualProfile,
  chatJid: string,
  now = new Date(),
): RitualProfile {
  const schedule = defaultScheduleForRitual(profile.ritualType);
  const prompt = defaultPromptForRitual(profile.ritualType);
  if (!schedule || !prompt) {
    return profile;
  }
  const taskId =
    profile.linkedTaskId ||
    ritualTaskId(profile.groupFolder, profile.ritualType);
  const nextRun = computeNextRunFromCron(schedule.scheduleValue, now);
  const existing = getTaskById(taskId);
  if (existing) {
    updateTask(taskId, {
      prompt,
      schedule_type: schedule.scheduleType,
      schedule_value: schedule.scheduleValue,
      next_run: nextRun,
      status:
        profile.enabled && profile.triggerStyle === 'scheduled'
          ? 'active'
          : 'paused',
    });
  } else {
    createTask({
      id: taskId,
      group_folder: profile.groupFolder,
      chat_jid: chatJid,
      prompt,
      script: null,
      schedule_type: schedule.scheduleType,
      schedule_value: schedule.scheduleValue,
      context_mode: 'group',
      next_run: nextRun,
      status:
        profile.enabled && profile.triggerStyle === 'scheduled'
          ? 'active'
          : 'paused',
      created_at: now.toISOString(),
    });
  }
  const synced = {
    ...profile,
    linkedTaskId: taskId,
    nextDueAt: nextRun,
    updatedAt: now.toISOString(),
  };
  upsertRitualProfile(synced);
  return synced;
}

function pauseScheduledTaskIfNeeded(profile: RitualProfile): RitualProfile {
  if (profile.linkedTaskId && getTaskById(profile.linkedTaskId)) {
    updateTask(profile.linkedTaskId, {
      status: 'paused',
    });
  }
  const paused = {
    ...profile,
    nextDueAt: null,
  };
  upsertRitualProfile(paused);
  return paused;
}

function ritualTypeFromPriorMode(
  priorMode: string | null | undefined,
): RitualType | null {
  switch (priorMode) {
    case 'morning_brief':
      return 'morning_brief';
    case 'midday_reground':
      return 'midday_reground';
    case 'evening_reset':
      return 'evening_reset';
    case 'household_guidance':
      return 'household_checkin';
    case 'open_guidance':
      return 'thread_followthrough';
    default:
      return null;
  }
}

function buildStatusReply(
  channel: 'telegram' | 'alexa' | 'bluebubbles',
  profiles: RitualProfile[],
): string {
  const enabled = profiles.filter(
    (profile) => profile.enabled || profile.triggerStyle === 'on_request',
  );
  if (channel === 'alexa') {
    const first = enabled[0];
    return buildVoiceReply({
      summary: first
        ? `You currently have ${enabled.length} ritual patterns available.`
        : 'You do not have any scheduled ritual patterns enabled right now.',
      details: first
        ? [
            `${ritualLabel(first.ritualType)} is ${first.triggerStyle.replace('_', ' ')}.`,
          ]
        : [
            'Morning and evening rituals are still on request unless you opt in.',
          ],
      maxDetails: 1,
    });
  }
  const lines = enabled.length
    ? enabled.map((profile) => {
        const nextDue =
          profile.triggerStyle === 'scheduled' && profile.nextDueAt
            ? ` next ${new Date(profile.nextDueAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}`
            : '';
        return `- ${ritualLabel(profile.ritualType)}: ${profile.triggerStyle.replace('_', ' ')}${nextDue}`;
      })
    : [
        '- None active yet. Morning and evening rituals are still on request unless you opt in.',
      ];
  return ['Rituals right now:', ...lines].join('\n');
}

function inferTonightAnchor(now: Date): string {
  const target = new Date(now);
  target.setHours(19, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.toISOString();
}

function inferTomorrowAnchor(now: Date): string {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target.toISOString();
}

function pinCurrentContextToEveningReset(input: RitualCommandInput): string {
  const now = input.now || new Date();
  const referencedThreadId = input.priorContext?.usedThreadIds?.[0] || null;
  if (referencedThreadId) {
    const thread = getLifeThread(referencedThreadId);
    if (thread) {
      updateLifeThread(thread.id, {
        followthroughMode: 'important_only',
        nextFollowupAt: inferTonightAnchor(now),
        snoozedUntil: null,
        lastUpdatedAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
      });
      return `Okay. I will keep ${thread.title} in your evening reset until it clears.`;
    }
  }

  const saved = handleLifeThreadCommand({
    groupFolder: input.groupFolder,
    channel: input.channel,
    chatJid: input.chatJid,
    text: 'save this for later',
    replyText: input.replyText,
    conversationSummary: input.conversationSummary,
    priorContext: input.priorContext,
    now,
  });
  if (saved.handled && saved.referencedThread) {
    updateLifeThread(saved.referencedThread.id, {
      followthroughMode: 'important_only',
      nextFollowupAt: inferTonightAnchor(now),
      snoozedUntil: null,
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return `Okay. I will keep ${saved.referencedThread.title} in your evening reset until it clears.`;
  }
  return 'Tell me what you want carried into the evening reset first.';
}

export interface RitualCommandInput {
  groupFolder: string;
  channel: 'telegram' | 'alexa' | 'bluebubbles';
  text: string;
  chatJid?: string;
  replyText?: string;
  conversationSummary?: string;
  priorCompanionMode?: string | null;
  priorContext?: {
    usedThreadIds?: string[];
  } | null;
  now?: Date;
}

export interface RitualCommandResult {
  handled: boolean;
  responseText?: string;
  updatedProfile?: RitualProfile | null;
}

export function handleRitualCommand(
  input: RitualCommandInput,
): RitualCommandResult {
  const now = input.now || new Date();
  const raw = input.text.trim();
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return { handled: false };
  }

  if (/^what rituals do i have enabled\??$/i.test(raw)) {
    return {
      handled: true,
      responseText: buildStatusReply(
        input.channel,
        listResolvedRitualProfiles(input.groupFolder, now),
      ),
    };
  }

  if (/^make this part of my evening reset\??$/i.test(raw)) {
    return {
      handled: true,
      responseText: pinCurrentContextToEveningReset(input),
    };
  }

  if (/^make (?:the )?morning brief shorter[.!?]*$/i.test(raw)) {
    const existing = getResolvedRitualProfile(
      input.groupFolder,
      'morning_brief',
      now,
    );
    const updated = {
      ...existing,
      toneStyle: 'brief' as RitualToneStyle,
      enabled: true,
      optInState: 'opted_in' as RitualProfile['optInState'],
      updatedAt: now.toISOString(),
    };
    upsertRitualProfile(updated);
    return {
      handled: true,
      responseText:
        'Okay. I will keep the morning brief tighter and lead with the main thing.',
      updatedProfile: updated,
    };
  }

  if (/^stop surfacing family context automatically[.!?]*$/i.test(raw)) {
    const personalization = handlePersonalizationCommand({
      groupFolder: input.groupFolder,
      channel: input.channel,
      text: 'use less family context',
      replyText: input.replyText,
      conversationSummary: input.conversationSummary,
      now,
    });
    const existing = getResolvedRitualProfile(
      input.groupFolder,
      'household_checkin',
      now,
    );
    const updated = {
      ...existing,
      enabled: false,
      triggerStyle: 'on_request' as RitualTriggerStyle,
      optInState: 'opted_out' as RitualProfile['optInState'],
      updatedAt: now.toISOString(),
      nextDueAt: null,
    };
    pauseScheduledTaskIfNeeded(updated);
    return {
      handled: true,
      responseText:
        personalization.responseText ||
        'Okay. I will stop surfacing family context automatically.',
      updatedProfile: updated,
    };
  }

  if (/^reset my routine preferences[.!?]*$/i.test(raw)) {
    for (const profile of listResolvedRitualProfiles(input.groupFolder, now)) {
      const reset = {
        ...buildDefaultRitualProfile(
          input.groupFolder,
          profile.ritualType,
          now,
        ),
        updatedAt: now.toISOString(),
      };
      upsertRitualProfile(reset);
      pauseScheduledTaskIfNeeded(reset);
    }
    return {
      handled: true,
      responseText:
        'Okay. I reset your ritual timing and follow-through defaults. Daily guidance is still available when you ask for it.',
    };
  }

  const enableMatch = raw.match(
    /^(?:enable|turn on|start) (?:the )?(morning brief|midday re-grounding|midday reground|evening reset|follow-through prompts|household check-ins|leave prompt)\b/i,
  );
  if (enableMatch) {
    const ritualType = (
      {
        'morning brief': 'morning_brief',
        'midday re-grounding': 'midday_reground',
        'midday reground': 'midday_reground',
        'evening reset': 'evening_reset',
        'follow-through prompts': 'thread_followthrough',
        'household check-ins': 'household_checkin',
        'leave prompt': 'transition_prompt',
      } as Record<string, RitualType>
    )[enableMatch[1]!.toLowerCase()];
    const existing = getResolvedRitualProfile(
      input.groupFolder,
      ritualType,
      now,
    );
    let updated: RitualProfile = {
      ...existing,
      enabled: true,
      triggerStyle: 'scheduled',
      optInState: 'opted_in',
      updatedAt: now.toISOString(),
    };
    if (input.channel === 'telegram' && input.chatJid) {
      updated = syncScheduledTaskForProfile(updated, input.chatJid, now);
      return {
        handled: true,
        responseText: `Okay. I turned on the ${ritualLabel(ritualType).toLowerCase()} for Telegram.`,
        updatedProfile: updated,
      };
    }
    upsertRitualProfile({
      ...updated,
      triggerStyle: 'on_request',
      nextDueAt: null,
    });
    return {
      handled: true,
      responseText:
        'Okay. I saved that preference, but scheduled ritual delivery itself stays on Telegram. On Alexa, you can still ask for it on demand.',
      updatedProfile: updated,
    };
  }

  if (/^(stop doing that|don'?t remind me like that)[.!?]*$/i.test(raw)) {
    const ritualType = ritualTypeFromPriorMode(input.priorCompanionMode);
    if (!ritualType) {
      return {
        handled: true,
        responseText:
          'Tell me which ritual or reminder style you want me to quiet down, and I will narrow it.',
      };
    }
    const existing = getResolvedRitualProfile(
      input.groupFolder,
      ritualType,
      now,
    );
    const updated = {
      ...existing,
      enabled: false,
      triggerStyle: 'on_request' as RitualTriggerStyle,
      optInState: 'opted_out' as RitualProfile['optInState'],
      nextDueAt: null,
      updatedAt: now.toISOString(),
    };
    pauseScheduledTaskIfNeeded(updated);
    return {
      handled: true,
      responseText: `Okay. I will stop surfacing the ${ritualLabel(ritualType).toLowerCase()} automatically. You can still ask for it whenever you want.`,
      updatedProfile: updated,
    };
  }

  return { handled: false };
}
