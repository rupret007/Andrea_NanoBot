import crypto from 'crypto';

import {
  getProfileFact,
  getProfileFactByKey,
  getProfileSubjectByKey,
  listProfileFactsForGroup,
  listRecentMessagesForChat,
  updateProfileFactState,
  upsertProfileFact,
  upsertProfileSubject,
} from './db.js';
import { escapeXml } from './router.js';
import {
  type AlexaCompanionGuidanceGoal,
  type AlexaConversationFollowupAction,
  type AlexaConversationSubjectKind,
  type ProfileFact,
  type ProfileFactWithSubject,
  type ProfileSubject,
} from './types.js';

export type AssistantExpressionChannel = 'alexa' | 'telegram';
export type AssistantChannelMode = 'alexa_companion' | 'telegram_default';
export type AssistantInitiativeLevel =
  | 'measured'
  | 'restrained'
  | 'coach_like';

export interface AssistantPromptContextOptions {
  channel: AssistantExpressionChannel;
  groupFolder: string;
  channelMode?: AssistantChannelMode;
  guidanceGoal?: AlexaCompanionGuidanceGoal;
  initiativeLevel?: AssistantInitiativeLevel;
  conversationSummary?: string;
  conversationSubjectKind?: AlexaConversationSubjectKind;
  supportedFollowups?: AlexaConversationFollowupAction[];
}

export interface PersonalizationCommandInput {
  groupFolder: string;
  channel: AssistantExpressionChannel;
  text: string;
  conversationSummary?: string;
  replyText?: string;
  factIdHint?: string;
  now?: Date;
}

export interface PersonalizationCommandResult {
  handled: boolean;
  responseText?: string;
  referencedFactId?: string;
}

export interface ProactiveCandidateInput {
  groupFolder: string;
  chatJid: string;
  channel: AssistantExpressionChannel;
  text: string;
  now?: Date;
}

export interface ProactiveCandidateResult {
  factId: string;
  askText: string;
}

const PROACTIVE_ASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DIRECT_STYLE_FACT_KEY = 'response_style';
const PERSONALIZATION_LEVEL_FACT_KEY = 'personalization_level';
const FAMILY_CONTEXT_FACT_KEY = 'family_context_default';
const INITIATIVE_LEVEL_FACT_KEY = 'initiative_level';
const WORK_CONTEXT_FACT_KEY = 'work_context_default';
const EXPLANATION_DEPTH_FACT_KEY = 'explanation_depth';
const GUIDANCE_FOCUS_FACT_KEY = 'guidance_focus';
const REMINDER_HELPFULNESS_FACT_KEY = 'reminder_helpfulness';

function slugifyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function stableNoteFactKey(summary: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(summary.trim().toLowerCase())
    .digest('hex')
    .slice(0, 12);
  return `note:${digest}`;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function joinNaturalLanguage(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function buildProfileSubjectId(
  groupFolder: string,
  kind: ProfileSubject['kind'],
  canonicalName: string,
): string {
  return `${groupFolder}:${kind}:${canonicalName}`;
}

function ensureProfileSubject(
  groupFolder: string,
  kind: ProfileSubject['kind'],
  displayName: string,
  now = new Date(),
): ProfileSubject {
  const canonicalName =
    kind === 'self'
      ? 'self'
      : kind === 'household'
        ? 'household'
        : slugifyName(displayName);
  const existing = getProfileSubjectByKey(groupFolder, kind, canonicalName);
  if (existing) {
    if (existing.displayName !== displayName) {
      upsertProfileSubject({
        ...existing,
        displayName,
        updatedAt: now.toISOString(),
      });
      return {
        ...existing,
        displayName,
        updatedAt: now.toISOString(),
      };
    }
    return existing;
  }

  const subject: ProfileSubject = {
    id: buildProfileSubjectId(groupFolder, kind, canonicalName),
    groupFolder,
    kind,
    canonicalName,
    displayName,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

function upsertStructuredFact(params: {
  groupFolder: string;
  subject: ProfileSubject;
  category: ProfileFact['category'];
  factKey: string;
  value: unknown;
  state: ProfileFact['state'];
  sourceChannel: string;
  sourceSummary: string;
  now?: Date;
}): ProfileFact {
  const now = params.now ?? new Date();
  const existing = getProfileFactByKey(
    params.groupFolder,
    params.subject.id,
    params.category,
    params.factKey,
  );
  const record: ProfileFact = {
    id: existing?.id || crypto.randomUUID(),
    groupFolder: params.groupFolder,
    subjectId: params.subject.id,
    category: params.category,
    factKey: params.factKey,
    valueJson: JSON.stringify(params.value),
    state: params.state,
    sourceChannel: params.sourceChannel,
    sourceSummary: params.sourceSummary,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    decidedAt:
      params.state === 'accepted' ||
      params.state === 'rejected' ||
      params.state === 'disabled'
        ? now.toISOString()
        : existing?.decidedAt || null,
  };
  upsertProfileFact(record);
  return record;
}

function describeFact(fact: ProfileFactWithSubject): string {
  const value = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});

  if (fact.factKey === DIRECT_STYLE_FACT_KEY) {
    return 'you prefer short, direct answers';
  }
  if (fact.factKey === PERSONALIZATION_LEVEL_FACT_KEY) {
    return 'you want Andrea to be less personal by default';
  }
  if (fact.factKey === FAMILY_CONTEXT_FACT_KEY) {
    const enabled = value.enabled !== false;
    return enabled
      ? 'family context can be used by default when it is relevant'
      : 'family context should be used more sparingly';
  }
  if (fact.factKey === INITIATIVE_LEVEL_FACT_KEY) {
    return 'you want measured guidance on broad questions';
  }
  if (fact.factKey === WORK_CONTEXT_FACT_KEY) {
    const enabled = value.enabled !== false;
    return enabled
      ? 'work context can be foregrounded when it is relevant'
      : 'work context should be kept in the background unless you ask for it';
  }
  if (fact.factKey === EXPLANATION_DEPTH_FACT_KEY) {
    const mode = typeof value.mode === 'string' ? value.mode : 'balanced';
    return mode === 'fuller'
      ? 'you usually want a little more explanation when it helps'
      : 'you usually want very little explanation';
  }
  if (fact.factKey === GUIDANCE_FOCUS_FACT_KEY) {
    return 'you want the main thing first on open-ended guidance questions';
  }
  if (fact.factKey === REMINDER_HELPFULNESS_FACT_KEY) {
    const enabled = value.enabled !== false;
    return enabled
      ? 'helpful reminder nudges are okay when they would clearly help'
      : 'reminder nudges should stay rare unless you ask for them';
  }
  if (fact.category === 'relationships') {
    const relation = typeof value.relation === 'string' ? value.relation : 'family';
    return `${fact.subjectDisplayName} is your ${relation}`;
  }
  if (fact.factKey === 'dietary_preference') {
    const diet = typeof value.diet === 'string' ? value.diet : 'noted';
    return `${fact.subjectDisplayName} is ${diet}`;
  }
  if (fact.factKey.startsWith('note:')) {
    const summary =
      typeof value.summary === 'string' ? value.summary.trim() : fact.sourceSummary;
    return summary || 'a saved personal note';
  }
  return fact.sourceSummary || `${fact.subjectDisplayName}: ${fact.factKey}`;
}

function summarizeFactsForChannel(
  channel: AssistantExpressionChannel,
  facts: ProfileFactWithSubject[],
  subjectLabel: string,
): string {
  if (facts.length === 0) {
    return channel === 'alexa'
      ? `I am not actively using any remembered details about ${subjectLabel} yet.`
      : `I am not actively using any remembered details about ${subjectLabel} yet.`;
  }

  const descriptions = facts.map(describeFact);
  if (channel === 'alexa') {
    if (descriptions.length === 1) {
      return `Right now I remember that ${descriptions[0]}.`;
    }
    return `Right now I remember that ${descriptions[0]}, and ${descriptions[1]}.`;
  }

  return [
    `Remembered details for ${subjectLabel}:`,
    ...descriptions.map((line) => `- ${line}`),
  ].join('\n');
}

function buildAcceptedProfileLines(
  groupFolder: string,
): string[] {
  const facts = listProfileFactsForGroup(groupFolder, ['accepted']);
  const lines: string[] = [];

  for (const fact of facts) {
    const value = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
    if (fact.factKey === DIRECT_STYLE_FACT_KEY) {
      lines.push('Prefer short, direct answers unless extra detail is clearly useful.');
      continue;
    }
    if (fact.factKey === PERSONALIZATION_LEVEL_FACT_KEY) {
      lines.push(
        'Keep the tone helpful and warm, but avoid making the response more personal than needed.',
      );
      continue;
    }
    if (fact.factKey === FAMILY_CONTEXT_FACT_KEY) {
      if (value.enabled !== false) {
        lines.push(
          'When shared plans or household logistics are clearly relevant, it is okay to use family context naturally.',
        );
      } else {
        lines.push(
          'Use family or household context more sparingly unless the user asks for it directly.',
        );
      }
      continue;
    }
    if (fact.factKey === INITIATIVE_LEVEL_FACT_KEY) {
      lines.push(
        'When the user asks a broad daily-life question, offer one measured recommendation instead of only reciting facts.',
      );
      continue;
    }
    if (fact.factKey === WORK_CONTEXT_FACT_KEY) {
      if (value.enabled !== false) {
        lines.push(
          'If work and personal context are tied, it is okay to foreground work context by default unless family impact is clearly more important.',
        );
      }
      continue;
    }
    if (fact.factKey === EXPLANATION_DEPTH_FACT_KEY) {
      const mode = typeof value.mode === 'string' ? value.mode : 'balanced';
      lines.push(
        mode === 'fuller'
          ? 'Give a little more explanation when it helps, while staying concise on Alexa.'
          : 'Keep explanation lean unless extra detail is clearly needed.',
      );
      continue;
    }
    if (fact.factKey === GUIDANCE_FOCUS_FACT_KEY) {
      lines.push(
        'Lead with the single main thing that matters before secondary details.',
      );
      continue;
    }
    if (fact.factKey === REMINDER_HELPFULNESS_FACT_KEY) {
      if (value.enabled !== false) {
        lines.push(
          'If there is a clear reminder-worthy detail, it is okay to mention that briefly.',
        );
      }
      continue;
    }
    if (fact.category === 'relationships') {
      const relation = typeof value.relation === 'string' ? value.relation : 'family';
      lines.push(`${fact.subjectDisplayName} is the user's ${relation}.`);
      continue;
    }
    if (fact.factKey === 'dietary_preference') {
      const diet = typeof value.diet === 'string' ? value.diet : 'noted';
      lines.push(`${fact.subjectDisplayName} has a ${diet} dietary preference.`);
      continue;
    }
    if (fact.factKey.startsWith('note:')) {
      const summary =
        typeof value.summary === 'string' ? value.summary.trim() : '';
      if (summary) {
        lines.push(`Remembered priority: ${summary}.`);
      }
    }
  }

  return [...new Set(lines)].slice(0, 8);
}

function buildChannelExpressionLines(
  channel: AssistantExpressionChannel,
  channelMode?: AssistantChannelMode,
): string[] {
  if (channel === 'alexa') {
    if (channelMode === 'alexa_companion') {
      return [
        'Channel: Alexa Companion Mode.',
        'Sound natural, warm, concise, and lightly personable aloud.',
        'Use one strong lead sentence and at most two short supporting sentences.',
        'Lead with the main thing that matters most, then one or two useful follow-through details.',
        'Avoid sounding like a command menu, an intent router, or a status panel.',
        'Use soft prioritization language like main thing, one thing to keep in mind, or nothing urgent when it fits.',
        'If the day is light, say that plainly instead of stretching for urgency.',
        'Let short follow-ups feel like the same conversation instead of a reset.',
        'A subtle touch of warmth or wit is okay when the moment is low stakes.',
        'Ask only one short clarification when needed.',
      ];
    }
    return [
      'Channel: Alexa.',
      'Sound natural, warm, concise, and lightly personable aloud.',
      'Use one strong lead sentence and at most two short supporting sentences.',
      'Prefer brief transitions over robotic framing.',
      'Avoid sounding like a menu or status panel.',
      'Ask only one short clarification when needed.',
    ];
  }

  return [
    'Channel: Telegram.',
    'Keep the tone human and helpful.',
    'You can be slightly richer and more actionable than Alexa.',
    'Stay concise unless the user clearly wants more detail.',
  ];
}

function buildGuidanceLines(
  options: AssistantPromptContextOptions,
): string[] {
  if (options.channel !== 'alexa') return [];

  const lines: string[] = [];
  if (options.initiativeLevel === 'measured') {
    lines.push(
      'When the user asks an open-ended question, give one measured recommendation and at most two supporting considerations.',
    );
  }

  switch (options.guidanceGoal) {
    case 'daily_brief':
      lines.push(
        'Rank what matters by urgency, obligations to other people, meeting prep, family impact, and breathing room.',
      );
      lines.push(
        'Do not sound like a schedule dump; sound like a real assistant helping someone get their bearings.',
      );
      break;
    case 'upcoming_soon':
      lines.push(
        'Summarize the next few meaningful things and what the user should keep in mind around them.',
      );
      break;
    case 'next_action':
      lines.push(
        'Prioritize the most useful next move, not just the next event on the calendar.',
      );
      break;
    case 'meeting_prep':
      lines.push(
        'Focus on what to handle before the next meeting and any reminder-worthy prep.',
      );
      break;
    case 'tomorrow_brief':
      lines.push(
        'Lead with how busy tomorrow feels, then the main thing to keep in mind.',
      );
      break;
    case 'what_matters_most':
      lines.push(
        'Answer with the single highest-priority thing first, then only the most relevant supporting detail.',
      );
      break;
    case 'anything_important':
    case 'risk_check':
      lines.push(
        'Surface only the main thing to watch for, and if nothing seems urgent, say that clearly without filler.',
      );
      break;
    case 'open_conversation':
      lines.push(
        'Treat this as an in-progress Alexa conversation. Use earlier context when it helps, but answer the actual request in front of you.',
      );
      lines.push(
        'If the user sounds open-ended, be helpful and grounded instead of falling back to menu-like phrasing.',
      );
      break;
    case 'what_am_i_forgetting':
      lines.push(
        'Look for loose ends, prep gaps, carryover reminders, and relationship-sensitive follow-through.',
      );
      break;
    case 'evening_reset':
      lines.push(
        'Focus on what to wrap up today, what to remember tonight, and what to tee up for tomorrow.',
      );
      break;
    case 'family_guidance':
      lines.push(
        'Use family or household context naturally, but only when it is clearly relevant to the question.',
      );
      break;
    case 'shared_plans':
      lines.push(
        'Prioritize shared plans, family logistics, and what the user may need to talk through with the other person.',
      );
      break;
    case 'action_follow_through':
      lines.push(
        'If an obvious reminder, save-for-later, or follow-up draft would help, mention it briefly and practically.',
      );
      break;
    case 'explainability':
      lines.push(
        'Explain the high-level reasons briefly in user language without exposing internal prompt mechanics.',
      );
      break;
    default:
      break;
  }

  return lines;
}

export function buildAssistantPromptWithPersonalization(
  basePrompt: string,
  options: AssistantPromptContextOptions,
): string {
  const acceptedProfileLines = buildAcceptedProfileLines(options.groupFolder);
  const channelLines = buildChannelExpressionLines(
    options.channel,
    options.channelMode,
  );
  const guidanceLines = buildGuidanceLines(options);
  const sections: string[] = [];

  sections.push(
    `<assistant_channel channel="${escapeXml(options.channel)}" mode="${escapeXml(options.channelMode || (options.channel === 'alexa' ? 'alexa_companion' : 'telegram_default'))}">\n${channelLines
      .map((line) => `<rule>${escapeXml(line)}</rule>`)
      .join('\n')}\n</assistant_channel>`,
  );

  if (guidanceLines.length > 0) {
    sections.push(
      `<assistant_guidance goal="${escapeXml(options.guidanceGoal || 'daily_brief')}" initiative_level="${escapeXml(options.initiativeLevel || 'measured')}">\n${guidanceLines
        .map((line) => `<rule>${escapeXml(line)}</rule>`)
        .join('\n')}\n</assistant_guidance>`,
    );
  }

  if (acceptedProfileLines.length > 0) {
    sections.push(
      `<assistant_profile>\n${acceptedProfileLines
        .map((line) => `<fact>${escapeXml(line)}</fact>`)
        .join('\n')}\n</assistant_profile>`,
    );
  }

  if (options.conversationSummary) {
    sections.push(
      `<assistant_conversation subject_kind="${escapeXml(options.conversationSubjectKind || 'general')}">\n<summary>${escapeXml(
        options.conversationSummary,
      )}</summary>\n${
        options.supportedFollowups && options.supportedFollowups.length > 0
          ? `<followups>${escapeXml(options.supportedFollowups.join(', '))}</followups>`
          : ''
      }\n</assistant_conversation>`,
    );
  }

  sections.push(basePrompt);
  return sections.join('\n');
}

function normalizeCommandText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function getAcceptedFactsForSubject(
  groupFolder: string,
  subject: ProfileSubject,
): ProfileFactWithSubject[] {
  return listProfileFactsForGroup(groupFolder, ['accepted']).filter(
    (fact) => fact.subjectId === subject.id,
  );
}

function disableReferencedFact(
  factIdHint: string | undefined,
  nowIso: string,
): boolean {
  if (!factIdHint) return false;
  return updateProfileFactState(factIdHint, 'disabled', nowIso);
}

function listAcceptedPreferenceDescriptions(groupFolder: string): string[] {
  return listProfileFactsForGroup(groupFolder, ['accepted'])
    .filter((fact) =>
      [
        DIRECT_STYLE_FACT_KEY,
        PERSONALIZATION_LEVEL_FACT_KEY,
        FAMILY_CONTEXT_FACT_KEY,
        INITIATIVE_LEVEL_FACT_KEY,
        WORK_CONTEXT_FACT_KEY,
        EXPLANATION_DEPTH_FACT_KEY,
        GUIDANCE_FOCUS_FACT_KEY,
        REMINDER_HELPFULNESS_FACT_KEY,
      ].includes(fact.factKey),
    )
    .map(describeFact)
    .slice(0, 3);
}

function buildPersonalizationExplanation(
  channel: AssistantExpressionChannel,
  groupFolder: string,
  conversationSummary?: string,
): string {
  const descriptions = listAcceptedPreferenceDescriptions(groupFolder);
  const contextLead = conversationSummary?.trim()
    ? 'I was mostly using your current schedule, reminders, and what we were just talking about.'
    : 'I am mostly using your current schedule, reminders, and the request you just asked about.';

  if (channel === 'alexa') {
    if (descriptions.length === 0) {
      return contextLead;
    }
    return `${contextLead} I am also using the preferences you have approved, like ${joinNaturalLanguage(descriptions)}.`;
  }

  const lines = [contextLead];
  if (descriptions.length > 0) {
    lines.push(`Saved personalization in play: ${joinNaturalLanguage(descriptions)}.`);
  } else {
    lines.push('There are no active saved personalization defaults in play right now.');
  }
  return lines.join('\n');
}

export function acceptProposedProfileFact(
  factId: string,
  now = new Date(),
): boolean {
  const fact = getProfileFact(factId);
  if (!fact || fact.state !== 'proposed') return false;
  return updateProfileFactState(factId, 'accepted', now.toISOString());
}

export function rejectProposedProfileFact(
  factId: string,
  now = new Date(),
): boolean {
  const fact = getProfileFact(factId);
  if (!fact || fact.state !== 'proposed') return false;
  return updateProfileFactState(factId, 'rejected', now.toISOString());
}

export function handlePersonalizationCommand(
  input: PersonalizationCommandInput,
): PersonalizationCommandResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const raw = normalizeCommandText(input.text);
  const selfSubject = ensureProfileSubject(input.groupFolder, 'self', 'you', now);

  if (/^(?:be )?(?:a little |a bit )?more direct[.!?]*$/i.test(raw)) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: DIRECT_STYLE_FACT_KEY,
      value: { mode: 'short_direct' },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for more direct answers.',
      now,
    });
    return {
      handled: true,
      responseText:
        'Sure. I can keep my answers shorter and more direct by default.',
      referencedFactId: fact.id,
    };
  }

  if (
    /^(be a little more proactive|be more proactive|give me measured guidance)[.!?]*$/i.test(
      raw,
    )
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: INITIATIVE_LEVEL_FACT_KEY,
      value: { mode: 'measured' },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for measured proactive guidance.',
      now,
    });
    return {
      handled: true,
      responseText:
        'Okay. When you ask broad questions, I will be a little more proactive about the main next thing.',
      referencedFactId: fact.id,
    };
  }

  if (/^be less personal[.!?]*$/i.test(raw)) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: PERSONALIZATION_LEVEL_FACT_KEY,
      value: { mode: 'less_personal' },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for less personal responses.',
      now,
    });
    return {
      handled: true,
      responseText: 'Okay. I will keep the tone a little less personal unless you ask for that context.',
      referencedFactId: fact.id,
    };
  }

  if (
    /^(give me more explanation|explain a little more|give me a little more context)[.!?]*$/i.test(
      raw,
    )
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: EXPLANATION_DEPTH_FACT_KEY,
      value: { mode: 'fuller' },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for a little more explanation.',
      now,
    });
    return {
      handled: true,
      responseText:
        'Okay. I will give a little more explanation when it actually helps.',
      referencedFactId: fact.id,
    };
  }

  if (/^(lead with the main thing|prioritize what matters most)[.!?]*$/i.test(raw)) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'preferences',
      factKey: GUIDANCE_FOCUS_FACT_KEY,
      value: { mode: 'main_thing_first' },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked Andrea to lead with the main thing first.',
      now,
    });
    return {
      handled: true,
      responseText:
        'Okay. I will lead with the main thing first on open-ended guidance questions.',
      referencedFactId: fact.id,
    };
  }

  if (/^use more work context[.!?]*$/i.test(raw)) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'preferences',
      factKey: WORK_CONTEXT_FACT_KEY,
      value: { enabled: true },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for more work context by default.',
      now,
    });
    return {
      handled: true,
      responseText:
        'Okay. I will foreground work context a little more when it is relevant.',
      referencedFactId: fact.id,
    };
  }

  if (/^use less family context[.!?]*$/i.test(raw)) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'household_context',
      factKey: FAMILY_CONTEXT_FACT_KEY,
      value: { enabled: false },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for less family context.',
      now,
    });
    return {
      handled: true,
      responseText: 'Okay. I will use family context more sparingly.',
      referencedFactId: fact.id,
    };
  }

  if (/^(suggest reminders when helpful|nudge me about reminders when helpful)[.!?]*$/i.test(raw)) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'preferences',
      factKey: REMINDER_HELPFULNESS_FACT_KEY,
      value: { enabled: true },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: 'User asked for reminder nudges when helpful.',
      now,
    });
    return {
      handled: true,
      responseText:
        'Okay. If a reminder would clearly help, I can mention it briefly.',
      referencedFactId: fact.id,
    };
  }

  if (
    /^(why did you say that|what are you using to personalize this)[.!?]*$/i.test(
      raw,
    )
  ) {
    return {
      handled: true,
      responseText: buildPersonalizationExplanation(
        input.channel,
        input.groupFolder,
        input.conversationSummary,
      ),
    };
  }

  if (/^reset that preference[.!?]*$/i.test(raw)) {
    if (disableReferencedFact(input.factIdHint, nowIso)) {
      return {
        handled: true,
        responseText: 'Okay. I reset that preference.',
      };
    }
    return {
      handled: true,
      responseText:
        'I can reset a specific preference when we are talking about one. Ask what I am using to personalize this first if you want.',
    };
  }

  if (/^reset my preferences[.!?]*$/i.test(raw)) {
    const facts = listProfileFactsForGroup(input.groupFolder).filter(
      (fact) =>
        fact.subjectId === selfSubject.id &&
        ['conversational_style', 'household_context', 'preferences'].includes(
          fact.category,
        ) &&
        fact.state !== 'disabled',
    );
    for (const fact of facts) {
      updateProfileFactState(fact.id, 'disabled', nowIso);
    }
    return {
      handled: true,
      responseText:
        facts.length > 0
          ? 'Okay. I reset the saved style and preference defaults I was using.'
          : 'There were no saved style defaults to reset yet.',
    };
  }

  if (/^what do you remember about (me|myself)\b/i.test(raw)) {
    const facts = getAcceptedFactsForSubject(input.groupFolder, selfSubject);
    return {
      handled: true,
      responseText: summarizeFactsForChannel(input.channel, facts, 'you'),
    };
  }

  const subjectMatch = raw.match(/^what do you remember about ([a-z][a-z' -]+)\??$/i);
  if (subjectMatch) {
    const subjectName = normalizeCommandText(subjectMatch[1]);
    const subject = ensureProfileSubject(
      input.groupFolder,
      'person',
      subjectName,
      now,
    );
    const facts = getAcceptedFactsForSubject(input.groupFolder, subject);
    return {
      handled: true,
      responseText: summarizeFactsForChannel(
        input.channel,
        facts,
        subject.displayName,
      ),
    };
  }

  const rememberRelation = raw.match(
    /^remember (?:that )?([a-z][a-z' -]+) is my (wife|spouse|husband|partner|son|daughter|child|kid)[.!?]*$/i,
  );
  if (rememberRelation) {
    const subject = ensureProfileSubject(
      input.groupFolder,
      'person',
      normalizeCommandText(rememberRelation[1]),
      now,
    );
    const relation = rememberRelation[2].toLowerCase();
    upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject,
      category: 'relationships',
      factKey: 'relation_to_user',
      value: { relation },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: `${subject.displayName} is the user's ${relation}.`,
      now,
    });
    return {
      handled: true,
      responseText: `Okay. I will remember that ${subject.displayName} is your ${relation}.`,
    };
  }

  const rememberDiet = raw.match(
    /^remember (?:that )?([a-z][a-z' -]+) is (vegetarian|vegan)[.!?]*$/i,
  );
  if (rememberDiet) {
    const subject = ensureProfileSubject(
      input.groupFolder,
      'person',
      normalizeCommandText(rememberDiet[1]),
      now,
    );
    const diet = rememberDiet[2].toLowerCase();
    upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject,
      category: 'preferences',
      factKey: 'dietary_preference',
      value: { diet },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: `${subject.displayName} is ${diet}.`,
      now,
    });
    return {
      handled: true,
      responseText: `Okay. I will remember that ${subject.displayName} is ${diet}.`,
    };
  }

  if (
    /^(forget that|stop using that|don'?t bring that up automatically|stop bringing that up)[.!?]*$/i.test(
      raw,
    )
  ) {
    if (disableReferencedFact(input.factIdHint, nowIso)) {
      return {
        handled: true,
        responseText: 'Okay. I will stop using that remembered detail.',
      };
    }
    return {
      handled: true,
      responseText:
        'I can stop using a specific remembered detail when we are talking about one. If you want, ask what I remember about you or about Candace first.',
    };
  }

  if (/^remember (this|that)[.!?]*$/i.test(raw)) {
    const summary = normalizeCommandText(
      input.conversationSummary || input.replyText || '',
    );
    if (!summary) {
      return {
        handled: true,
        responseText:
          'I can remember it, but I need you to tell me what you want me to keep.',
      };
    }
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'recurring_priorities',
      factKey: stableNoteFactKey(summary),
      value: { summary },
      state: 'accepted',
      sourceChannel: input.channel,
      sourceSummary: summary,
      now,
    });
    return {
      handled: true,
      responseText:
        input.channel === 'alexa'
          ? 'Okay. I will remember that.'
          : `Okay. I will remember: ${summary}`,
      referencedFactId: fact.id,
    };
  }

  return { handled: false };
}

function hasRecentProactiveAsk(groupFolder: string, now: Date): boolean {
  const threshold = now.getTime() - PROACTIVE_ASK_COOLDOWN_MS;
  const facts = listProfileFactsForGroup(groupFolder, ['proposed']);
  return facts.some((fact) => Date.parse(fact.updatedAt) >= threshold);
}

function countRecentSignals(
  chatJid: string,
  matcher: RegExp,
): number {
  return listRecentMessagesForChat(chatJid, 12).filter((message) =>
    matcher.test(message.content),
  ).length;
}

export function maybeCreateProactiveProfileCandidate(
  input: ProactiveCandidateInput,
): ProactiveCandidateResult | null {
  const now = input.now ?? new Date();
  if (hasRecentProactiveAsk(input.groupFolder, now)) {
    return null;
  }

  const selfSubject = ensureProfileSubject(input.groupFolder, 'self', 'you', now);
  const raw = normalizeCommandText(input.text);

  const existingDirect = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'conversational_style',
    DIRECT_STYLE_FACT_KEY,
  );
  const directSignals = countRecentSignals(
    input.chatJid,
    /\b(shorter|short direct|be more direct)\b/i,
  );
  if (
    /\b(shorter|be more direct)\b/i.test(raw) &&
    directSignals >= 2 &&
    !existingDirect
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: DIRECT_STYLE_FACT_KEY,
      value: { mode: 'short_direct' },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary: 'Candidate: user prefers short, direct answers.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'You usually want short direct answers. Want me to keep that as your default?',
    };
  }

  const existingExplanation = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'conversational_style',
    EXPLANATION_DEPTH_FACT_KEY,
  );
  const explanationSignals = countRecentSignals(
    input.chatJid,
    /\b(say more|more detail|more explanation|a little more context)\b/i,
  );
  if (
    /\b(say more|more detail|more explanation|a little more context)\b/i.test(
      raw,
    ) &&
    explanationSignals >= 2 &&
    !existingExplanation
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: EXPLANATION_DEPTH_FACT_KEY,
      value: { mode: 'fuller' },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary: 'Candidate: user often wants a little more explanation.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'You sometimes want a little more explanation. Want me to do that by default when it helps?',
    };
  }

  const existingFamily = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'household_context',
    FAMILY_CONTEXT_FACT_KEY,
  );
  const familySignals = countRecentSignals(
    input.chatJid,
    /\b(candace|travis|family)\b/i,
  );
  if (
    /\b(candace|travis|family)\b/i.test(raw) &&
    familySignals >= 2 &&
    !existingFamily
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'household_context',
      factKey: FAMILY_CONTEXT_FACT_KEY,
      value: { enabled: true, focus: 'family_context' },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary:
        'Candidate: user often asks about shared plans or family context.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'You often ask about family or shared plans. Want me to use family context by default when it is relevant?',
    };
  }

  const existingGuidance = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'conversational_style',
    INITIATIVE_LEVEL_FACT_KEY,
  );
  const guidanceSignals = countRecentSignals(
    input.chatJid,
    /\b(what matters most|what should i do next|anything i should know|what am i forgetting)\b/i,
  );
  if (
    /\b(what matters most|what should i do next|anything i should know|what am i forgetting)\b/i.test(
      raw,
    ) &&
    guidanceSignals >= 2 &&
    !existingGuidance
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'conversational_style',
      factKey: INITIATIVE_LEVEL_FACT_KEY,
      value: { mode: 'measured' },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary:
        'Candidate: user values measured prioritization on broad guidance questions.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'You often want the main thing first. Want me to be a little more proactive on broad questions?',
    };
  }

  const existingGuidanceFocus = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'preferences',
    GUIDANCE_FOCUS_FACT_KEY,
  );
  const mainThingSignals = countRecentSignals(
    input.chatJid,
    /\b(main thing|what matters most|prioritize)\b/i,
  );
  if (
    /\b(main thing|what matters most|prioritize)\b/i.test(raw) &&
    mainThingSignals >= 2 &&
    !existingGuidanceFocus
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'preferences',
      factKey: GUIDANCE_FOCUS_FACT_KEY,
      value: { mode: 'main_thing_first' },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary: 'Candidate: user wants the main thing first.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'You often want the main thing first. Want me to lead with that by default on broad questions?',
    };
  }

  const existingWork = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'preferences',
    WORK_CONTEXT_FACT_KEY,
  );
  const workSignals = countRecentSignals(
    input.chatJid,
    /\b(work|meeting|deadline|client|review)\b/i,
  );
  if (
    /\b(work|meeting|deadline|client|review)\b/i.test(raw) &&
    workSignals >= 3 &&
    !existingWork
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'preferences',
      factKey: WORK_CONTEXT_FACT_KEY,
      value: { enabled: true },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary: 'Candidate: user often foregrounds work context.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'Work context comes up a lot. Want me to foreground work context when it is tied with everything else?',
    };
  }

  const existingReminderHelpfulness = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'preferences',
    REMINDER_HELPFULNESS_FACT_KEY,
  );
  const reminderSignals = countRecentSignals(
    input.chatJid,
    /\b(remind me|save that for later|remember that tonight)\b/i,
  );
  if (
    /\b(remind me|save that for later|remember that tonight)\b/i.test(raw) &&
    reminderSignals >= 2 &&
    !existingReminderHelpfulness
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'preferences',
      factKey: REMINDER_HELPFULNESS_FACT_KEY,
      value: { enabled: true },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary: 'Candidate: reminder nudges seem helpful for this user.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'Reminder nudges seem useful for you. Want me to mention them when a reminder would clearly help?',
    };
  }

  return null;
}
