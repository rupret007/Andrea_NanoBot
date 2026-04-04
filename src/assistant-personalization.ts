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
  type AlexaConversationFollowupAction,
  type AlexaConversationSubjectKind,
  type ProfileFact,
  type ProfileFactWithSubject,
  type ProfileSubject,
} from './types.js';

export type AssistantExpressionChannel = 'alexa' | 'telegram';

export interface AssistantPromptContextOptions {
  channel: AssistantExpressionChannel;
  groupFolder: string;
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
): string[] {
  if (channel === 'alexa') {
    return [
      'Channel: Alexa.',
      'Sound natural, warm, and concise aloud.',
      'Use one strong lead sentence and at most two short supporting sentences.',
      'Prefer brief transitions over robotic framing.',
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

export function buildAssistantPromptWithPersonalization(
  basePrompt: string,
  options: AssistantPromptContextOptions,
): string {
  const acceptedProfileLines = buildAcceptedProfileLines(options.groupFolder);
  const channelLines = buildChannelExpressionLines(options.channel);
  const sections: string[] = [];

  sections.push(
    `<assistant_channel channel="${escapeXml(options.channel)}">\n${channelLines
      .map((line) => `<rule>${escapeXml(line)}</rule>`)
      .join('\n')}\n</assistant_channel>`,
  );

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
  const lowered = raw.toLowerCase();
  const selfSubject = ensureProfileSubject(input.groupFolder, 'self', 'you', now);

  if (/^be more direct[.!?]*$/i.test(raw)) {
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
      responseText: 'Okay. I will keep my answers shorter and more direct by default.',
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

  if (/^(forget that|stop using that)[.!?]*$/i.test(raw)) {
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

  const existingFamily = getProfileFactByKey(
    input.groupFolder,
    selfSubject.id,
    'household_context',
    FAMILY_CONTEXT_FACT_KEY,
  );
  const candaceSignals = countRecentSignals(input.chatJid, /\bcandace\b/i);
  if (
    /\bcandace\b/i.test(raw) &&
    candaceSignals >= 2 &&
    !existingFamily
  ) {
    const fact = upsertStructuredFact({
      groupFolder: input.groupFolder,
      subject: selfSubject,
      category: 'household_context',
      factKey: FAMILY_CONTEXT_FACT_KEY,
      value: { enabled: true, focus: 'candace_family_context' },
      state: 'proposed',
      sourceChannel: input.channel,
      sourceSummary:
        'Candidate: user often asks about shared plans with Candace.',
      now,
    });
    return {
      factId: fact.id,
      askText:
        'You often ask about shared plans with Candace. Want me to use family context by default when it is relevant?',
    };
  }

  return null;
}
