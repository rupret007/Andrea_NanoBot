import { beforeEach, describe, expect, it } from 'vitest';

import {
  executeAssistantCapability,
  type AssistantCapabilityContext,
} from './assistant-capabilities.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  _initTestDatabase,
  getCommunicationThread,
  getOutcomeBySource,
  listCommunicationThreadsForGroup,
  upsertCommunicationThread,
  upsertProfileSubject,
} from './db.js';
import type { CommunicationThreadRecord } from './types.js';
import { seedOutcomeRecordsForGroup } from './outcome-reviews.js';
import { manageCommunicationTracking } from './communication-companion.js';

const now = new Date('2026-09-06T05:00:00.000Z');
const command = 'forget this conversation thread completely';
const owner: AssistantCapabilityContext = {
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'tg:12345',
  ownerReviewAllowed: true,
  now,
};

function seed(
  id = 'comm-avery',
  groupFolder = 'main',
): CommunicationThreadRecord {
  const record: CommunicationThreadRecord = {
    id,
    groupFolder,
    title: 'Avery Example',
    linkedSubjectIds: [],
    linkedLifeThreadIds: [],
    channel: 'bluebubbles',
    channelChatJid: 'bb:iMessage;-;+12025550123',
    lastInboundSummary: 'Avery asked for the rehearsal address.',
    lastOutboundSummary: null,
    followupState: 'reply_needed',
    urgency: 'soon',
    followupDueAt: null,
    suggestedNextAction: 'draft_reply',
    toneStyleHints: [],
    lastContactAt: now.toISOString(),
    lastMessageId: null,
    linkedTaskId: null,
    inferenceState: 'assistant_inferred',
    trackingMode: 'default',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    disabledAt: null,
  };
  upsertCommunicationThread(record);
  return getCommunicationThread(id)!;
}

async function review() {
  const result = await executeAssistantCapability({
    capabilityId: 'communication.open_loops',
    context: owner,
    input: { text: 'what do I owe people' },
  });
  expect(result.replyText).toContain('Avery');
  return result.conversationSeed?.subjectData;
}

function forget(
  priorSubjectData: AssistantCapabilityContext['priorSubjectData'],
  overrides: Partial<AssistantCapabilityContext> = {},
  text = command,
) {
  return executeAssistantCapability({
    capabilityId: 'communication.manage_tracking',
    context: { ...owner, priorSubjectData, ...overrides },
    input: { text },
  });
}

describe('reviewed complete-forget product flow', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('removes the one reviewed local thread across owner and target surfaces, without retaining continuation', async () => {
    seed();
    const result = await forget(await review());
    expect(getCommunicationThread('comm-avery')).toBeUndefined();
    expect(result.replyText).toContain('Original messages');
    expect(result.conversationSeed).toBeUndefined();
    expect(result.continuationCandidate).toBeUndefined();
    expect(result.followupActions).toEqual([]);
  });

  it('issues a usable review after an explicit message summary, not just an open-loop list', async () => {
    const result = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: owner,
      input: {
        text: 'Summarize this message: Avery Example: Can you send the rehearsal address?',
      },
    });
    const id = result.conversationSeed?.subjectData?.communicationThreadId;
    expect(id).toBeTruthy();
    expect(
      result.conversationSeed?.subjectData?.communicationForgetReviewJson,
    ).toBeTruthy();
    await forget(result.conversationSeed?.subjectData);
    expect(getCommunicationThread(id!)).toBeUndefined();
  });

  it('does not offer a destructive review from asynchronous draft output', async () => {
    seed();
    const reviewed = await review();
    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: { ...owner, priorSubjectData: reviewed },
      input: { text: 'Give me a short reply.' },
    });
    expect(
      result.conversationSeed?.subjectData?.communicationForgetReviewJson,
    ).toBeUndefined();
  });

  it('does not allow a rewritten or canonical command to authorize a different raw message', async () => {
    const original = seed();
    for (const rawText of [
      `do not ${command}`,
      `"${command}"`,
      'stop tracking that',
      '',
    ]) {
      const result = await executeAssistantCapability({
        capabilityId: 'communication.manage_tracking',
        context: { ...owner, priorSubjectData: await review() },
        input: { rawText, text: command, canonicalText: command },
      });
      expect(getCommunicationThread(original.id)).toEqual(original);
      expect(result.conversationSeed).toBeUndefined();
      expect(result.replyText).toContain('Nothing was changed');
    }
  });

  it('does not recreate a deleted derived outcome during the next daily-review seed pass', async () => {
    const original = seed();
    seedOutcomeRecordsForGroup('main', now);
    expect(
      getOutcomeBySource('main', 'communication_thread', original.id),
    ).toBeDefined();
    const reviewed = await review();
    await forget(reviewed);
    seedOutcomeRecordsForGroup('main', now);
    expect(
      getOutcomeBySource('main', 'communication_thread', original.id),
    ).toBeUndefined();
    const replay = await forget(reviewed);
    expect(replay.replyText).toContain('Nothing was deleted');
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: true,
      }),
    ).toEqual([]);
  });

  it('keeps ordinary stop-tracking as retained, disabled local tracking', async () => {
    upsertProfileSubject({
      id: 'subject-avery',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'avery',
      displayName: 'Avery',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const analysis = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: owner,
      input: {
        text: 'Summarize this message: Avery: Can you send the rehearsal address?',
      },
    });
    const prior = analysis.conversationSeed?.subjectData;
    const result = manageCommunicationTracking({
      ...owner,
      groupFolder: 'main',
      text: 'stop tracking that',
      priorContext: prior,
    });
    expect(result.ok, result.replyText).toBe(true);
    expect(
      getCommunicationThread(prior!.communicationThreadId!)?.trackingMode,
    ).toBe('disabled');
  });

  it.each(['', '{bad', 'null', '[]', '{}', 'x'.repeat(4097)])(
    'fails closed on malformed review: %s',
    async (reviewJson) => {
      const original = seed();
      const reviewed = await review();
      await forget({ ...reviewed, communicationForgetReviewJson: reviewJson });
      expect(getCommunicationThread(original.id)).toEqual(original);
    },
  );

  it.each([
    { targetChatJid: 'bb:other' },
    { targetChannel: 'telegram' },
    { threadId: 'missing' },
    { groupFolder: 'other' },
    { purpose: 'other' },
    { version: 2 },
    { threadFingerprint: '0'.repeat(64) },
    { reviewedAt: 'invalid' },
  ])('rejects changed receipt fields: %j', async (changes) => {
    const original = seed();
    const reviewed = await review();
    const changed = {
      ...JSON.parse(reviewed!.communicationForgetReviewJson!),
      ...changes,
    };
    await forget({
      ...reviewed,
      communicationForgetReviewJson: JSON.stringify(changed),
    });
    expect(getCommunicationThread(original.id)).toEqual(original);
  });

  it('refuses direct calls with no review without analyzing or creating a thread', () => {
    const result = manageCommunicationTracking({
      ...owner,
      groupFolder: 'main',
      text: command,
      priorContext: {
        personName: 'Avery Example',
        lastCommunicationSummary: 'Please send the address.',
      },
    });
    expect(result.ok).toBe(false);
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: true,
      }),
    ).toEqual([]);
  });

  it.each([
    ['untrusted owner', { ownerReviewAllowed: false }],
    ['other group', { groupFolder: 'other' }],
    ['other control chat', { chatJid: 'tg:54321' }],
    ['other control channel', { channel: 'bluebubbles' }],
    ['missing control chat', { chatJid: undefined }],
    ['expired review', { now: new Date(now.getTime() + 600_001) }],
    ['future review', { now: new Date(now.getTime() - 1) }],
  ] as const)('does not mutate on %s', async (_label, overrides) => {
    const original = seed();
    const result = await forget(await review(), overrides);
    expect(getCommunicationThread(original.id)).toEqual(original);
    expect(result.conversationSeed).toBeUndefined();
    expect(result.followupActions).toEqual([]);
  });

  it('rejects a changed reviewed record even when its timestamp is unchanged', async () => {
    const original = seed();
    const reviewed = await review();
    upsertCommunicationThread({
      ...original,
      lastInboundSummary: 'The address request was cancelled.',
    });
    const changed = getCommunicationThread('comm-avery');
    expect(changed?.updatedAt).toBe(original.updatedAt);
    await forget(reviewed);
    expect(getCommunicationThread('comm-avery')).toEqual(changed);
  });

  it('does not pick the first conversation from an ambiguous list', async () => {
    seed();
    seed('comm-second');
    const original = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: true,
    });
    await forget(await review());
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: true,
      }),
    ).toEqual(original);
  });

  it('does not fall back or create a thread without a review', async () => {
    const original = seed();
    await forget({
      communicationThreadId: original.id,
      personName: 'Avery Example',
    });
    expect(getCommunicationThread(original.id)).toEqual(original);
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: true,
      }),
    ).toHaveLength(1);
  });

  it.each([
    `do not ${command}`,
    `"${command}"`,
    `${command} and remind me later`,
    `save this conversation under ${command} thread`,
    `${command}?`,
  ])('refuses ambiguous text without mutation: %s', async (text) => {
    const original = seed();
    const result = await forget(await review(), {}, text);
    expect(getCommunicationThread(original.id)).toEqual(original);
    expect(result.conversationSeed).toBeUndefined();
  });

  it('routes complete-forget language to its fail-closed handler, preserving the raw command', () => {
    for (const text of [
      command,
      `do not ${command}`,
      `"${command}"`,
      `${command} and remind me later`,
    ]) {
      const result = matchAssistantCapabilityRequest(text);
      expect(result?.capabilityId).toBe('communication.manage_tracking');
      expect(result?.canonicalText).toBe(text);
    }
  });
});
