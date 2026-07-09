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
import {
  listCommunicationThreadsForGroup,
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
    ).toContain('direct');
    expect(
      result.noReplyNeeded.some((item) => item.chatLabel === 'Game Chat'),
    ).toBe(true);
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
    expect(result.needsReply[0]?.suggestedReply).toContain('thoughtful');
    expect(result.needsReply[0]?.suggestedReply).toContain(
      'checking the details',
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
      learnedContext: ['Call +14695550123 about dinner'],
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
    expect(item?.suggestedReply).toContain('answer the group');
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('group chat - draft only');
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
