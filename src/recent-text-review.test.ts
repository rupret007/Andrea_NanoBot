import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRecentTextReviewSeedJson,
  buildReviewDraftPrompt,
  buildRecentTextReviewProviderPrompt,
  formatRecentTextReviewItemWhyReply,
  formatRecentTextReviewReply,
  isRecentTextReviewSeedStale,
  parseRecentTextReviewSeedJson,
  parseRecentTextReviewItemFollowup,
  redactRecentTextReviewText,
  resolveRecentTextReviewFollowupTarget,
  reviewRecentTexts,
  validateRecentTextReviewFollowupFreshness,
} from './recent-text-review.js';
import { interpretLifeThreadCommitment } from './life-thread-commitment.js';
import {
  listCommunicationThreadsForGroup,
  reconcileRecentTextSelfSubjectLinks,
  storeChatMetadata,
  storeMessage,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertProfileFact,
  upsertProfileSubject,
  _initTestDatabase,
} from './db.js';

describe('recent text review', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('ranks latest inbound questions above casual chatter', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'candace-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm if dinner still works tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;-;+15550009999',
      '2026-04-15T16:12:00.000Z',
      'Game Chat',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'game-1',
      chat_jid: 'bb:iMessage;-;+15550009999',
      sender: 'bb:+15550009999',
      sender_name: 'Pat',
      content: 'lol that was fun',
      timestamp: '2026-04-15T16:12:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
    });

    expect(result.needsReply[0]).toMatchObject({
      chatLabel: 'Candace',
      section: 'needs_reply',
    });
    expect(result.providerUsed).toBe('local');
    expect(result.needsReply[0]?.whyText).toContain('asks for an answer');
    expect(result.needsReply[0]?.summaryText).toContain('Current state');
    expect(result.needsReply[0]?.suggestedReplies).toHaveLength(3);
    expect(result.needsReply[0]?.suggestedReplies?.[0]?.label).toBe('warm');
    expect(result.needsReply[0]?.suggestedReply).toBe(
      result.needsReply[0]?.suggestedReplies?.[0]?.text,
    );
    expect(
      formatRecentTextReviewReply({ result, channel: 'bluebubbles' }),
    ).toContain('Suggested replies');
    expect(
      formatRecentTextReviewReply({ result, channel: 'bluebubbles' }),
    ).toContain('warm');
    expect(
      result.noReplyNeeded.some((item) => item.chatLabel === 'Game Chat'),
    ).toBe(true);
  });

  it('keeps human reply needs above automated surveys, promotions, and notices', async () => {
    const storeInbound = (input: {
      suffix: string;
      label: string;
      content: string;
      timestamp: string;
    }) => {
      const chatJid = `bb:iMessage;-;+1555000${input.suffix}`;
      storeChatMetadata(
        chatJid,
        input.timestamp,
        input.label,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `priority-${input.suffix}`,
        chat_jid: chatJid,
        sender: `bb:+1555000${input.suffix}`,
        sender_name: input.label,
        content: input.content,
        timestamp: input.timestamp,
        is_from_me: false,
      });
    };

    storeInbound({
      suffix: '1001',
      label: 'Candace',
      content: 'Do you need me to pick them up?',
      timestamp: '2026-04-15T16:10:00.000Z',
    });
    storeInbound({
      suffix: '1006',
      label: 'Family Committee',
      content: 'Can you tell us about how pickup works tomorrow?',
      timestamp: '2026-04-15T16:00:00.000Z',
    });
    storeInbound({
      suffix: '1002',
      label: 'Auto Survey',
      content:
        'Mercedes-Benz: Please take our survey about your recent experience: https://survey.example.com. Reply STOP to opt out.',
      timestamp: '2026-04-15T16:20:00.000Z',
    });
    storeInbound({
      suffix: '1003',
      label: 'Pizza Club',
      content:
        'Pizza Club: Limited-time deal, 25% off today at https://pizza.example.com. Text STOP to unsubscribe.',
      timestamp: '2026-04-15T16:30:00.000Z',
    });
    storeInbound({
      suffix: '1004',
      label: 'Geek Squad',
      content:
        'Geek Squad: Your service specialist is on the way and expected to arrive by 4:30 PM. Do not reply.',
      timestamp: '2026-04-15T16:40:00.000Z',
    });
    storeInbound({
      suffix: '1005',
      label: 'Dental Center',
      content:
        'Dental Center: Your appointment is scheduled tomorrow. Reply OK to confirm.',
      timestamp: '2026-04-15T16:50:00.000Z',
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const byLabel = new Map(result.items.map((item) => [item.chatLabel, item]));

    expect(result.items.slice(0, 2).map((item) => item.chatLabel)).toEqual(
      expect.arrayContaining(['Candace', 'Family Committee']),
    );
    expect(
      result.items.slice(0, 2).every((item) => item.section === 'needs_reply'),
    ).toBe(true);
    for (const label of ['Auto Survey', 'Pizza Club']) {
      expect(byLabel.get(label)).toMatchObject({
        section: 'no_reply_needed',
        suggestedReply: null,
        suggestedReplies: [],
      });
      expect(byLabel.get(label)?.riskFlags).toContain(
        'automated_marketing_or_survey',
      );
    }
    expect(byLabel.get('Geek Squad')).toMatchObject({
      section: 'no_reply_needed',
      suggestedReplies: [],
    });
    expect(byLabel.get('Dental Center')).toMatchObject({
      section: 'worth_watching',
      suggestedReplies: [],
    });
    expect(byLabel.get('Dental Center')?.riskFlags).toContain(
      'automated_transactional_notice',
    );
    expect(byLabel.get('Family Committee')?.riskFlags).not.toContain(
      'automated_marketing_or_survey',
    );
    expect(byLabel.get('Family Committee')?.section).toBe('needs_reply');

    const generatedDrafts = result.needsReply.flatMap(
      (item) => item.suggestedReplies || [],
    );
    expect(generatedDrafts.length).toBeGreaterThan(0);
    expect(generatedDrafts.map((draft) => draft.text).join(' ')).not.toMatch(
      /\b(?:i am checking|i will confirm|i will get back|i will take a look|will confirm shortly)\b/i,
    );
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toMatch(/\d+\. Candace:/);
  });

  it('filters BlueBubbles assistant wake commands out of recent text recaps', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:20:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'wake-filter-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm if dinner still works tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'wake-filter-2',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'me',
      sender_name: 'Jeff',
      content: '@Andrea summarize this',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.needsReply[0]?.chatLabel).toBe('Candace');
    expect(result.needsReply[0]?.summaryText).toContain('dinner still works');
    expect(result.needsReply[0]?.summaryText).not.toContain('@Andrea');
    expect(result.needsReply[0]?.evidenceSnippets.join(' ')).not.toContain(
      '@Andrea',
    );
  });

  it('raises priority for known people and active life threads', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    upsertProfileSubject({
      id: 'subject-candace',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'candace',
      displayName: 'Candace',
      createdAt: now,
      updatedAt: now,
    });
    upsertLifeThread({
      id: 'life-candace-dinner',
      groupFolder: 'main',
      title: 'Candace dinner planning',
      category: 'family',
      status: 'active',
      scope: 'family',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['dinner'],
      summary: 'Dinner coordination with Candace is an active household loop.',
      nextAction: null,
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      createdAt: now,
      lastUpdatedAt: now,
      lastUsedAt: null,
    });
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'candace-known-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Let me know when you have a minute tonight.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.needsReply[0]?.linkedSubjectIds).toContain('subject-candace');
    expect(result.needsReply[0]?.linkedLifeThreadIds).toContain(
      'life-candace-dinner',
    );
    expect(result.needsReply[0]?.contextLink.reason).toContain(
      'personal context graph',
    );
    expect(result.needsReply[0]?.whyText).toMatch(/known person|linked thread/);
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        followupStates: ['reply_needed'],
      })[0],
    ).toMatchObject({
      channel: 'bluebubbles',
      channelChatJid: 'bb:iMessage;-;+14695550123',
      followupState: 'reply_needed',
    });
  });

  it('never treats the self subject or ordinary "you" language as a relationship link', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    upsertProfileSubject({
      id: 'main:self:self',
      groupFolder: 'main',
      kind: 'self',
      canonicalName: 'self',
      displayName: 'you',
      createdAt: now,
      updatedAt: now,
    });
    upsertLifeThread({
      id: 'life-self-goals',
      groupFolder: 'main',
      title: 'Personal operating system',
      category: 'personal',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['main:self:self'],
      contextTags: ['goals'],
      summary: 'Keep personal goals visible.',
      nextAction: null,
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      createdAt: now,
      lastUpdatedAt: now,
      lastUsedAt: null,
    });
    storeChatMetadata(
      'bb:iMessage;-;+15550001111',
      '2026-04-15T16:10:00.000Z',
      'Unknown contact',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'self-word-1',
      chat_jid: 'bb:iMessage;-;+15550001111',
      sender: 'bb:+15550001111',
      sender_name: 'Unknown contact',
      content: 'Can you send me your availability tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatLabel === 'Unknown contact',
    );
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find(
      (candidate) => candidate.channelChatJid === 'bb:iMessage;-;+15550001111',
    );

    expect(item?.linkedSubjectIds).toEqual([]);
    expect(item?.linkedLifeThreadIds).toEqual([]);
    expect(thread?.linkedSubjectIds).toEqual([]);
    expect(thread?.linkedLifeThreadIds).toEqual([]);
  });

  it('idempotently removes historical self-only links from inferred recent-text rows', () => {
    const originalTimestamp = '2026-04-01T12:00:00.000Z';
    upsertProfileSubject({
      id: 'main:self:self',
      groupFolder: 'main',
      kind: 'self',
      canonicalName: 'self',
      displayName: 'you',
      createdAt: originalTimestamp,
      updatedAt: originalTimestamp,
    });
    upsertLifeThread({
      id: 'life-self-contaminated',
      groupFolder: 'main',
      title: 'My goals',
      category: 'personal',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['main:self:self'],
      contextTags: [],
      summary: 'Personal goal context.',
      nextAction: null,
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      createdAt: originalTimestamp,
      lastUpdatedAt: originalTimestamp,
      lastUsedAt: null,
    });
    upsertCommunicationThread({
      id: 'legacy-bluebubbles-thread-uuid',
      groupFolder: 'main',
      title: 'Messages chat',
      linkedSubjectIds: ['main:self:self'],
      linkedLifeThreadIds: ['life-self-contaminated'],
      channel: 'bluebubbles',
      channelChatJid: 'bb:iMessage;-;+15550002222',
      lastInboundSummary: 'A generic conversation summary.',
      lastOutboundSummary: null,
      followupState: 'reply_needed',
      urgency: 'soon',
      followupDueAt: null,
      suggestedNextAction: 'draft_reply',
      toneStyleHints: [],
      lastContactAt: originalTimestamp,
      lastMessageId: 'legacy-message',
      linkedTaskId: null,
      inferenceState: 'assistant_inferred',
      trackingMode: 'default',
      createdAt: originalTimestamp,
      updatedAt: originalTimestamp,
      disabledAt: null,
    });
    upsertCommunicationThread({
      id: 'user-confirmed-bluebubbles-self-link',
      groupFolder: 'main',
      title: 'Explicit personal thread',
      linkedSubjectIds: ['main:self:self'],
      linkedLifeThreadIds: ['life-self-contaminated'],
      channel: 'bluebubbles',
      channelChatJid: 'bb:iMessage;-;+15550003333',
      lastInboundSummary: 'User-confirmed personal context.',
      lastOutboundSummary: null,
      followupState: 'unknown',
      urgency: 'none',
      followupDueAt: null,
      suggestedNextAction: null,
      toneStyleHints: [],
      lastContactAt: originalTimestamp,
      lastMessageId: 'confirmed-message',
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: originalTimestamp,
      updatedAt: originalTimestamp,
      disabledAt: null,
    });

    expect(reconcileRecentTextSelfSubjectLinks()).toBe(1);
    expect(reconcileRecentTextSelfSubjectLinks()).toBe(0);
    const repaired = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: true,
      limit: 20,
    }).find((thread) => thread.id === 'legacy-bluebubbles-thread-uuid');
    expect(repaired).toMatchObject({
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      createdAt: originalTimestamp,
      updatedAt: originalTimestamp,
    });
    const confirmed = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: true,
      limit: 20,
    }).find((thread) => thread.id === 'user-confirmed-bluebubbles-self-link');
    expect(confirmed).toMatchObject({
      linkedSubjectIds: ['main:self:self'],
      linkedLifeThreadIds: ['life-self-contaminated'],
      inferenceState: 'user_confirmed',
    });
  });

  it('uses existing communication thread state for relationship-aware priority', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    upsertProfileSubject({
      id: 'subject-candace',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'candace',
      displayName: 'Candace',
      createdAt: now,
      updatedAt: now,
    });
    upsertCommunicationThread({
      id: 'comm-candace-active',
      groupFolder: 'main',
      title: 'Candace',
      linkedSubjectIds: ['subject-candace'],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: 'bb:iMessage;-;+14695550123',
      lastInboundSummary: 'Candace is waiting on the full version.',
      lastOutboundSummary: null,
      followupState: 'reply_needed',
      urgency: 'tonight',
      followupDueAt: null,
      suggestedNextAction: 'draft_reply',
      toneStyleHints: ['warm'],
      lastContactAt: now,
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'assistant_inferred',
      trackingMode: 'default',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    });
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'relationship-known-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you send me the full version tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;-;+15550009999',
      '2026-04-15T16:11:00.000Z',
      'Unknown',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'relationship-unknown-1',
      chat_jid: 'bb:iMessage;-;+15550009999',
      sender: 'bb:+15550009999',
      sender_name: 'Unknown',
      content: 'Can you send me the full version tonight?',
      timestamp: '2026-04-15T16:11:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const known = result.items.find((item) => item.chatLabel === 'Candace');
    const unknown = result.items.find((item) => item.chatLabel === 'Unknown');

    expect(known?.communicationThreadId).toBe('comm-candace-active');
    expect(known?.contextLink.confidence).toBe('high');
    expect(known?.linkedSubjectIds).toContain('subject-candace');
    expect(known!.priorityScore).toBeGreaterThan(unknown!.priorityScore);
  });

  it('uses accepted relationship tone memory for safer suggested replies', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    upsertProfileSubject({
      id: 'subject-candace',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'candace',
      displayName: 'Candace',
      createdAt: now,
      updatedAt: now,
    });
    upsertProfileFact({
      id: 'fact-candace-tone',
      groupFolder: 'main',
      subjectId: 'subject-candace',
      category: 'conversational_style',
      factKey: 'learning.candace.reply_tone',
      valueJson: JSON.stringify({
        value: 'Use a warm, thoughtful tone and avoid overcommitting.',
        memoryScope: 'user',
        confidence: 0.84,
        freshness: 'current',
        source: 'daily_learning_review',
      }),
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'Candace replies should be warm and avoid overcommitting.',
      createdAt: now,
      updatedAt: now,
      decidedAt: now,
    });
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'candace-tone-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm what we are doing tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.needsReply[0]?.linkedSubjectIds).toContain('subject-candace');
    expect(result.needsReply[0]?.suggestedReply).toContain(
      'appreciate the heads-up',
    );
    expect(result.needsReply[0]?.suggestedReply).not.toMatch(
      /\b(?:checking|will confirm|will get back)\b/i,
    );
  });

  it('lowers priority when the latest message is self-authored', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:20:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'reply-later-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm dinner tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'reply-later-2',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Yes, dinner still works.',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.needsReply).toHaveLength(0);
    expect(result.noReplyNeeded[0]?.chatLabel).toBe('Candace');
  });

  it('redacts identifiers from provider prompt inputs', () => {
    const prompt = buildRecentTextReviewProviderPrompt({
      windowLabel: 'today',
      items: [
        {
          itemId: 'item-1',
          rank: 1,
          section: 'needs_reply',
          priorityScore: 90,
          chatJid: 'bb:iMessage;-;+14695550123',
          chatLabel: '+14695550123',
          isGroup: false,
          summaryText:
            'bb:iMessage;-;+14695550123 asked for OPENAI_API_KEY=sk-secret and jeff@example.com',
          whyText: 'phone +14695550123 and jid bb:iMessage;-;+14695550123',
          recommendedAction: 'draft later',
          suggestedReply: 'I will call +14695550123.',
          suggestedReplies: [
            {
              label: 'direct',
              text: 'I will email jeff@example.com and call +14695550123.',
            },
            {
              label: 'secret',
              text: 'Use OPENAI_API_KEY=sk-secret before texting back.',
            },
          ],
          evidenceSnippets: ['Them: call me at +14695550123'],
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
          contextLink: {
            participantKind: 'direct',
            confidence: 'low',
            reason: 'test fixture',
            riskFlags: [],
          },
          riskFlags: [],
        },
      ],
    });

    expect(prompt).not.toContain('+14695550123');
    expect(prompt).not.toContain('bb:iMessage');
    expect(prompt).not.toContain('jeff@example.com');
    expect(prompt).not.toContain('sk-secret');
    expect(prompt).toContain('[redacted email]');
    expect(prompt).toContain('OPENAI_API_KEY=***');
    expect(redactRecentTextReviewText('Reach me at +14695550123')).toContain(
      '[redacted number]',
    );
  });

  it('withholds global profile and life-thread memory from cloud review prompts', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const candace = {
      id: 'subject-candace-provider-privacy',
      groupFolder: 'main',
      kind: 'person' as const,
      canonicalName: 'candace',
      displayName: 'Candace',
      createdAt: now,
      updatedAt: now,
    };
    const bob = {
      id: 'subject-bob-provider-privacy',
      groupFolder: 'main',
      kind: 'person' as const,
      canonicalName: 'bob',
      displayName: 'Bob',
      createdAt: now,
      updatedAt: now,
    };
    upsertProfileSubject(candace);
    upsertProfileSubject(bob);
    upsertProfileFact({
      id: 'fact-provider-privacy-canary',
      groupFolder: 'main',
      subjectId: candace.id,
      category: 'preferences',
      factKey: 'provider-privacy-canary',
      valueJson: JSON.stringify({
        value: 'PRIVATE-PROFILE-FACT-CANARY',
      }),
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'PRIVATE-PROFILE-FACT-CANARY',
      createdAt: now,
      updatedAt: now,
      decidedAt: now,
    });

    const seedThread = (params: {
      id: string;
      canary: string;
      relatedSubjectIds?: string[];
      sensitivity?: 'normal' | 'sensitive';
      surfaceMode?: 'default' | 'manual_only';
      followthroughMode?:
        | 'off'
        | 'manual_only'
        | 'important_only'
        | 'scheduled';
      snoozedUntil?: string | null;
      commitment?: Parameters<typeof upsertLifeThread>[0]['commitment'];
    }) => {
      upsertLifeThread({
        id: params.id,
        groupFolder: 'main',
        title: params.canary,
        category: 'relationship',
        status: 'active',
        scope: 'personal',
        relatedSubjectIds: params.relatedSubjectIds || [],
        contextTags: ['provider-privacy'],
        summary: params.canary,
        nextAction: params.canary,
        nextFollowupAt: null,
        sourceKind: 'explicit',
        confidenceKind: 'explicit',
        commitment: params.commitment || null,
        userConfirmed: true,
        sensitivity: params.sensitivity || 'normal',
        surfaceMode: params.surfaceMode || 'default',
        followthroughMode: params.followthroughMode || 'important_only',
        lastSurfacedAt: null,
        snoozedUntil: params.snoozedUntil || null,
        linkedTaskId: null,
        mergedIntoThreadId: null,
        createdAt: now,
        lastUpdatedAt: now,
        lastUsedAt: null,
      });
    };

    const waiting = interpretLifeThreadCommitment({
      threadId: 'thread-provider-waiting',
      title: 'Waiting for Candace',
      text: 'I sent Candace the note and am waiting for her response.',
      now: new Date(now),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'provider-privacy-test',
      knownSubjects: [candace, bob],
    });
    expect(waiting?.state.operationalState).toBe('waiting');

    seedThread({
      id: 'thread-provider-sensitive',
      canary: 'PRIVATE-SENSITIVE-CONTEXT-CANARY',
      relatedSubjectIds: [candace.id],
      sensitivity: 'sensitive',
    });
    seedThread({
      id: 'thread-provider-manual',
      canary: 'PRIVATE-MANUAL-CONTEXT-CANARY',
      relatedSubjectIds: [candace.id],
      surfaceMode: 'manual_only',
      followthroughMode: 'manual_only',
    });
    seedThread({
      id: 'thread-provider-off',
      canary: 'PRIVATE-OFF-CONTEXT-CANARY',
      relatedSubjectIds: [candace.id],
      followthroughMode: 'off',
    });
    seedThread({
      id: 'thread-provider-snoozed',
      canary: 'PRIVATE-SNOOZED-CONTEXT-CANARY',
      relatedSubjectIds: [candace.id],
      snoozedUntil: '2026-04-20T17:00:00.000Z',
    });
    seedThread({
      id: 'thread-provider-waiting',
      canary: 'PRIVATE-WAITING-CONTEXT-CANARY',
      relatedSubjectIds: [candace.id],
      commitment: waiting!.state,
    });
    seedThread({
      id: 'thread-provider-unrelated',
      canary: 'PRIVATE-UNRELATED-CONTEXT-CANARY',
    });
    seedThread({
      id: 'thread-provider-cross-recipient',
      canary: 'PRIVATE-CROSS-RECIPIENT-CANARY',
      relatedSubjectIds: [bob.id],
    });

    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'provider-privacy-message',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm if dinner still works tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let providerBody = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      providerBody = String(init?.body || '');
      return new Response(JSON.stringify({ output_text: '{"items":[]}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'auto',
    });

    expect(result.providerUsed).toBe('openai');
    expect(providerBody).toContain('dinner still works tonight');
    for (const canary of [
      'PRIVATE-PROFILE-FACT-CANARY',
      'PRIVATE-SENSITIVE-CONTEXT-CANARY',
      'PRIVATE-MANUAL-CONTEXT-CANARY',
      'PRIVATE-OFF-CONTEXT-CANARY',
      'PRIVATE-SNOOZED-CONTEXT-CANARY',
      'PRIVATE-WAITING-CONTEXT-CANARY',
      'PRIVATE-UNRELATED-CONTEXT-CANARY',
      'PRIVATE-CROSS-RECIPIENT-CANARY',
    ]) {
      expect(providerBody).not.toContain(canary);
    }
  });

  it('does not let provider refinement promote automation or invent follow-up promises', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+15550004001',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'provider-guard-human',
      chat_jid: 'bb:iMessage;-;+15550004001',
      sender: 'bb:+15550004001',
      sender_name: 'Candace',
      content: 'Can you tell me whether you need me to pick them up?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;-;+15550004002',
      '2026-04-15T16:20:00.000Z',
      'Auto Survey',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'provider-guard-survey',
      chat_jid: 'bb:iMessage;-;+15550004002',
      sender: 'bb:+15550004002',
      sender_name: 'Auto Survey',
      content:
        'Please complete our customer survey at https://survey.example.com. Text STOP to unsubscribe.',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body || '{}')) as {
        input?: string;
      };
      const prompt = String(request.input || '');
      const serializedItems = prompt.slice(
        prompt.lastIndexOf('Review items: ') + 'Review items: '.length,
      );
      const providerItems = JSON.parse(serializedItems) as Array<{
        itemId: string;
        riskFlags: string[];
      }>;
      const automated = providerItems.find((item) =>
        item.riskFlags.includes('automated_marketing_or_survey'),
      )!;
      const human = providerItems.find(
        (item) => !item.riskFlags.includes('automated_marketing_or_survey'),
      )!;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            items: [
              {
                itemId: automated.itemId,
                section: 'needs_reply',
                summaryText: 'Urgent personal reply required.',
                suggestedReplies: [
                  {
                    label: 'unsafe',
                    text: 'I am checking and will confirm shortly.',
                  },
                ],
              },
              {
                itemId: human.itemId,
                suggestedReplies: [
                  {
                    label: 'unsafe',
                    text: 'I am checking and will get back to you shortly.',
                  },
                  {
                    label: 'grounded',
                    text: 'Thanks for asking. I saw your question.',
                  },
                ],
              },
            ],
          }),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'auto',
    });
    const automated = result.items.find(
      (item) => item.chatLabel === 'Auto Survey',
    );
    const human = result.items.find((item) => item.chatLabel === 'Candace');

    expect(result.providerUsed).toBe('openai');
    expect(automated).toMatchObject({
      section: 'no_reply_needed',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(automated?.summaryText).not.toBe('Urgent personal reply required.');
    expect(human?.suggestedReplies?.length).toBeGreaterThan(0);
    expect(
      (human?.suggestedReplies || []).map((reply) => reply.text).join(' '),
    ).not.toMatch(/\b(?:checking|will get back|will confirm)\b/i);
    expect(human?.suggestedReplies).not.toContainEqual({
      label: 'grounded',
      text: 'Thanks for asking. I saw your question.',
    });
  });

  it('stores privacy-safe review seeds that resolve through communication threads', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      '+14695550123',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'private-seed-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: '+14695550123',
      content:
        'Can you send the dinner address to jeff@example.com tonight? My number is +14695550123.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seedJson = buildRecentTextReviewSeedJson(result);

    expect(seedJson).not.toContain('bb:iMessage');
    expect(seedJson).not.toContain('+14695550123');
    expect(seedJson).not.toContain('jeff@example.com');
    expect(seedJson).not.toContain('private-seed-1');

    const seed = parseRecentTextReviewSeedJson(seedJson);
    expect(seed?.items[0]?.communicationThreadId).toBeTruthy();
    expect(seed?.items[0]?.chatJid).toBeUndefined();
    expect(seed?.items[0]?.suggestedReplies?.length).toBeGreaterThanOrEqual(2);
    expect(seed?.items[0]?.suggestedReplies?.[0]?.text).not.toContain(
      '+14695550123',
    );
    expect(seed?.items[0]?.suggestedReplies?.[0]?.text).not.toContain(
      'jeff@example.com',
    );
    expect(seed?.items[0]?.freshnessSnapshot?.snapshotHash).toBeTruthy();
    const target = resolveRecentTextReviewFollowupTarget(seed!.items[0]!);
    expect(target).toMatchObject({
      ok: true,
      chatJid: 'bb:iMessage;-;+14695550123',
    });
  });

  it('blocks selected review items when the underlying thread changed', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'freshness-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm dinner tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seedJson = buildRecentTextReviewSeedJson(result);
    const seed = parseRecentTextReviewSeedJson(seedJson)!;
    const item = seed.items[0]!;

    expect(
      validateRecentTextReviewFollowupFreshness({
        seedJson,
        item,
        now: new Date('2026-04-15T17:05:00.000Z'),
      }),
    ).toMatchObject({ ok: true });

    storeMessage({
      id: 'freshness-2',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Yes, dinner still works.',
      timestamp: '2026-04-15T17:03:00.000Z',
      is_from_me: true,
    });

    expect(
      validateRecentTextReviewFollowupFreshness({
        seedJson,
        item,
        now: new Date('2026-04-15T17:05:00.000Z'),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'newer_thread_activity',
      outcome: 'blocked_stale',
    });
  });

  it('flags group chat review items as draft-only caution work', async () => {
    storeChatMetadata(
      'bb:iMessage;+;band-chat',
      '2026-04-15T16:10:00.000Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'group-question-1',
      chat_jid: 'bb:iMessage;+;band-chat',
      sender: 'bb:+15550009999',
      sender_name: 'Alex',
      content: 'Can you confirm the set list before tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.needsReply[0];

    expect(item).toMatchObject({
      chatLabel: 'Pops of Punk',
      isGroup: true,
    });
    expect(item?.riskFlags).toContain('group_chat_confirm_audience');
    expect(item?.recommendedAction).toContain('group-chat draft');
    expect(item?.suggestedReply).toContain('Thanks for flagging this');
    expect(item?.suggestedReply).not.toMatch(
      /\b(?:checking|will confirm|will send)\b/i,
    );
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('group chat - draft only');
  });

  it('keeps Telegram review numbering compact and preserves visible follow-up targets', async () => {
    for (let index = 1; index <= 6; index += 1) {
      const chatJid = `bb:iMessage;-;+15550005${String(index).padStart(3, '0')}`;
      const timestamp = `2026-04-15T16:${String(index).padStart(2, '0')}:00.000Z`;
      storeChatMetadata(
        chatJid,
        timestamp,
        `Person ${index}`,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `compact-human-${index}`,
        chat_jid: chatJid,
        sender: `bb:+15550005${String(index).padStart(3, '0')}`,
        sender_name: `Person ${index}`,
        content: `Can you answer question ${index} for me?`,
        timestamp,
        is_from_me: false,
      });
    }
    storeChatMetadata(
      'bb:iMessage;-;+15550005999',
      '2026-04-15T16:30:00.000Z',
      'Closed Loop',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'compact-no-reply',
      chat_jid: 'bb:iMessage;-;+15550005999',
      sender: 'bb:+15550005999',
      sender_name: 'Closed Loop',
      content: 'Thanks',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const formatted = formatRecentTextReviewReply({
      result,
      channel: 'telegram',
    });
    const visibleRanks = Array.from(formatted.matchAll(/^(\d+)\. /gm)).map(
      (match) => Number(match[1]),
    );

    expect(result.needsReply).toHaveLength(6);
    expect(visibleRanks).toEqual([1, 2, 3, 4]);
    expect(formatted).toContain(
      'Not expanded below: 2 needing reply, 1 no reply needed.',
    );
    expect(formatted).not.toMatch(/\n\nWorth watching\n/);
    expect(formatted).not.toMatch(/\n\nNo reply needed\n/);
    expect(formatted.length).toBeLessThan(3_500);

    const visibleItem = result.items[0]!;
    const seedJson = buildRecentTextReviewSeedJson(result);
    const parsedSeed = parseRecentTextReviewSeedJson(seedJson);
    const followup = parseRecentTextReviewItemFollowup({
      seedJson,
      userText: `draft #${visibleItem.rank}`,
    });
    expect(parsedSeed?.items[0]).toMatchObject({
      itemId: visibleItem.itemId,
      rank: visibleItem.rank,
      communicationThreadId: visibleItem.communicationThreadId,
    });
    expect(followup?.item).toMatchObject({
      itemId: visibleItem.itemId,
      rank: visibleItem.rank,
      communicationThreadId: visibleItem.communicationThreadId,
    });
  });

  it('reports full review coverage even when the stored item list is capped', async () => {
    for (let index = 1; index <= 15; index += 1) {
      const chatJid = `bb:iMessage;-;coverage-${index}`;
      storeChatMetadata(
        chatJid,
        `2026-04-15T${String(10 + Math.floor(index / 6)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
        `Person ${index}`,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `coverage-${index}`,
        chat_jid: chatJid,
        sender: `person-${index}`,
        sender_name: `Person ${index}`,
        content: `Can you confirm pickup item ${index} tonight?`,
        timestamp: `2026-04-15T${String(10 + Math.floor(index / 6)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
        is_from_me: false,
      });
    }

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const formatted = formatRecentTextReviewReply({
      result,
      channel: 'telegram',
    });

    expect(result.items).toHaveLength(12);
    expect(result.reviewedConversationCount).toBe(15);
    expect(result.sectionTotals.needs_reply).toBe(15);
    expect(formatted).toContain('Showing 4 highest-priority of 15');
    expect(formatted).toContain('11 needing reply');
    expect(formatted).toContain('15 conversations reviewed');
  });

  it('parses numbered follow-ups from a recent text review seed', () => {
    const seedJson = JSON.stringify({
      version: 1,
      items: [
        {
          itemId: 'review-1',
          rank: 1,
          section: 'needs_reply',
          chatJid: 'bb:one',
          chatLabel: 'Candace',
          summaryText: 'Candace asked whether dinner still works tonight.',
          whyText: 'asks for an answer; has timing pressure',
          recommendedAction: 'Draft a reply.',
        },
        {
          itemId: 'review-2',
          rank: 2,
          section: 'needs_reply',
          chatJid: 'bb:two',
          chatLabel: 'Alex',
          summaryText: 'Alex asked for a set list update.',
          whyText: 'latest message from them after your last reply',
          recommendedAction: 'Draft a warmer reply.',
          suggestedReply: 'I saw this and will send it shortly.',
          suggestedReplies: [
            {
              label: 'warm',
              text: 'I saw this and will send it shortly.',
            },
            {
              label: 'direct',
              text: 'I am checking the set list and will send it shortly.',
            },
          ],
        },
        {
          itemId: 'review-3',
          rank: 3,
          section: 'worth_watching',
          chatJid: 'bb:three',
          chatLabel: 'Morgan',
          summaryText: 'Morgan mentioned a loose follow-up for tonight.',
          whyText: 'worth keeping visible',
          recommendedAction: 'Set a reminder if useful.',
        },
      ],
    });

    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'make #2 warmer',
      }),
    ).toMatchObject({
      kind: 'draft',
      style: 'warmer',
      item: { rank: 2, chatLabel: 'Alex' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'remind me about #3 tonight',
      }),
    ).toMatchObject({
      kind: 'remind',
      timingHint: 'tonight',
      item: { rank: 3, chatLabel: 'Morgan' },
    });
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: 'save #2' }),
    ).toMatchObject({
      kind: 'save',
      item: { rank: 2, chatLabel: 'Alex' },
    });
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: 'skip #1' }),
    ).toMatchObject({
      kind: 'skip',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'mark #1 handled',
      }),
    ).toMatchObject({
      kind: 'handled',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      formatRecentTextReviewItemWhyReply(
        parseRecentTextReviewItemFollowup({
          seedJson,
          userText: 'why #1',
        })!.item,
      ),
    ).toContain('asks for an answer');
    expect(
      buildReviewDraftPrompt({ seedJson, userText: 'make #2 warmer' })?.text,
    ).toContain('Make it warmer');
    expect(
      buildReviewDraftPrompt({ seedJson, userText: 'draft #2 option 2' })?.text,
    ).toContain('I am checking the set list');
    expect(
      buildReviewDraftPrompt({
        seedJson,
        userText: 'draft the direct option for #2',
      })?.text,
    ).toContain('I am checking the set list');
    expect(
      buildReviewDraftPrompt({ seedJson, userText: 'save #2' }),
    ).toBeNull();
    expect(
      buildReviewDraftPrompt({
        seedJson,
        userText: 'remind me about #3 tonight',
      }),
    ).toBeNull();
  });

  it('binds pronoun follow-ups to the first actionable recent text review item', () => {
    const seedJson = JSON.stringify({
      version: 1,
      items: [
        {
          itemId: 'review-1',
          rank: 1,
          section: 'needs_reply',
          chatLabel: 'Candace',
          summaryText: 'Candace asked whether dinner still works tonight.',
          whyText: 'asks for an answer; has timing pressure',
          recommendedAction: 'Draft a reply.',
          suggestedReply: 'I saw this and will check before I answer.',
        },
        {
          itemId: 'review-2',
          rank: 2,
          section: 'worth_watching',
          chatLabel: 'Alex',
          summaryText: 'Alex mentioned a loose follow-up.',
          whyText: 'worth keeping visible',
          recommendedAction: 'Set a reminder if useful.',
        },
      ],
    });

    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: 'draft it' }),
    ).toMatchObject({
      kind: 'draft',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'make that warmer',
      }),
    ).toMatchObject({
      kind: 'draft',
      style: 'warmer',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'remind me about that tonight',
      }),
    ).toMatchObject({
      kind: 'remind',
      timingHint: 'tonight',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: 'save that' }),
    ).toMatchObject({
      kind: 'save',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: 'skip it' }),
    ).toMatchObject({
      kind: 'skip',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: 'mark handled' }),
    ).toMatchObject({
      kind: 'handled',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      formatRecentTextReviewItemWhyReply(
        parseRecentTextReviewItemFollowup({
          seedJson,
          userText: 'why that',
        })!.item,
      ),
    ).toContain('asks for an answer');
    expect(
      buildReviewDraftPrompt({ seedJson, userText: 'make it warmer' })?.text,
    ).toContain('Starting suggestion');
  });

  it('detects stale review seeds before selected-item actions', () => {
    const seedJson = JSON.stringify({
      version: 1,
      reviewedAt: '2026-04-13T00:00:00.000Z',
      items: [
        {
          itemId: 'review-1',
          rank: 1,
          section: 'needs_reply',
          communicationThreadId: 'communication_thread:recent_text:abc',
          chatLabel: 'Candace',
          summaryText: 'Candace asked whether dinner still works tonight.',
        },
      ],
    });

    expect(
      isRecentTextReviewSeedStale({
        seedJson,
        now: new Date('2026-04-15T17:00:00.000Z'),
      }),
    ).toBe(true);
  });
});
