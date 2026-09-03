import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRecentTextReviewSeedJson,
  buildReviewDraftPrompt,
  buildRecentTextReviewProviderPrompt,
  describeMessageForSummary,
  formatRecentTextReviewItemWhyReply,
  formatRecentTextReviewLocalTimestamp,
  formatRecentTextReviewReply,
  isRecentTextReviewSeedStale,
  parseRecentTextReviewSeedJson,
  parseRecentTextReviewItemFollowup,
  isBoundRecentTextReviewItemFollowup,
  redactRecentTextReviewText,
  recordRecentTextReviewOutcome,
  resolveRecentTextReviewFollowupTarget,
  resolveRecentTextReviewWindow,
  reviewRecentTexts,
  validateRecentTextReviewFollowupFreshness,
  validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh,
} from './recent-text-review.js';
import { interpretLifeThreadCommitment } from './life-thread-commitment.js';
import {
  listCommunicationSignalsForThread,
  listCommunicationThreadsForGroup,
  reconcileRecentTextSelfSubjectLinks,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertProfileFact,
  upsertProfileSubject,
  _initTestDatabase,
} from './db.js';

describe('recent text review windows', () => {
  it('includes owner-timezone today messages after UTC midnight', () => {
    const window = resolveRecentTextReviewWindow({
      now: new Date('2026-04-15T19:00:00-05:00'),
      kind: 'today',
      timeZone: 'America/Chicago',
    });

    expect(window.label).toBe('today');
    expect(window.startTimestamp).toBe('2026-04-15T05:00:00.000Z');
    expect('2026-04-15T16:46:28.314Z' >= window.startTimestamp).toBe(true);
  });
});

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
    expect(result.needsReply[0]?.whyText).toContain(
      'latest message from them is awaiting your reply',
    );
    expect(result.needsReply[0]?.whyText).not.toContain(
      'after your last reply',
    );
    expect(result.needsReply[0]?.summaryText).toContain('Current state');
    expect(result.needsReply[0]?.riskFlags).toContain('needs_owner_answer');
    expect(result.needsReply[0]?.suggestedReplies).toEqual([]);
    expect(result.needsReply[0]?.suggestedReply).toBeNull();
    expect(
      formatRecentTextReviewReply({ result, channel: 'bluebubbles' }),
    ).not.toContain('Suggested replies');
    expect(
      formatRecentTextReviewReply({ result, channel: 'bluebubbles' }),
    ).toContain('Tell me the answer you want to send for #1');
    expect(
      formatRecentTextReviewReply({ result, channel: 'bluebubbles' }),
    ).toContain('Synthesis: Local-only');
    expect(
      result.noReplyNeeded.some((item) => item.chatLabel === 'Game Chat'),
    ).toBe(true);
  });

  it('surfaces an explicit grounded commitment with its stated deadline', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+15550002021',
      '2026-04-15T16:10:00.000Z',
      'Avery',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'recent-explicit-commitment',
      chat_jid: 'bb:iMessage;-;+15550002021',
      sender: 'bb:+15550002021',
      sender_name: 'Avery',
      content: "I'll bring the folding chairs by Friday.",
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatLabel === 'Avery',
    );

    expect(item?.summaryText).toContain(
      'Grounded plan: Committed — Avery: bring the folding chairs. Deadline: by Friday.',
    );
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('Deadline: by Friday.');
  });

  it('surfaces concise imperative requests as unresolved owner action items without drafts or automatic actions', async () => {
    const examples = [
      {
        suffix: '2011',
        label: 'Dana',
        content: 'Call me',
        timestamp: '2026-04-15T16:10:00.000Z',
      },
      {
        suffix: '2012',
        label: 'Morgan',
        content: 'Bring milk',
        timestamp: '2026-04-15T16:11:00.000Z',
      },
      {
        suffix: '2013',
        label: 'Riley',
        content: 'Send the venue address',
        timestamp: '2026-04-15T16:12:00.000Z',
      },
    ] as const;
    for (const example of examples) {
      const chatJid = `bb:iMessage;-;+1555000${example.suffix}`;
      storeChatMetadata(
        chatJid,
        example.timestamp,
        example.label,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `imperative-${example.suffix}`,
        chat_jid: chatJid,
        sender: `bb:+1555000${example.suffix}`,
        sender_name: example.label,
        content: example.content,
        timestamp: example.timestamp,
        is_from_me: false,
      });
    }

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const threads = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    });

    for (const example of examples) {
      const item = result.items.find(
        (candidate) => candidate.chatLabel === example.label,
      );
      const thread = threads.find(
        (candidate) => candidate.channelChatJid === item?.chatJid,
      );
      expect(item).toMatchObject({
        section: 'needs_reply',
        suggestedReply: null,
        suggestedReplies: [],
      });
      expect(item?.riskFlags).toEqual(
        expect.arrayContaining(['needs_owner_answer', 'needs_owner_action']),
      );
      expect(item?.whyText).toContain('asks you to take an action');
      expect(item?.summaryText).toContain(example.content);
      expect(item?.recommendedAction).toContain('No automatic action');
      expect(item?.recommendedAction).toContain('conversational reply draft');
      expect(thread).toMatchObject({
        followupState: 'reply_needed',
        suggestedNextAction: null,
      });
    }
    const formatted = formatRecentTextReviewReply({
      result,
      channel: 'telegram',
    });
    expect(formatted).toContain('asks you to take an action');
    expect(formatted).toContain('I will not perform it');
    expect(formatted).not.toContain('Draft option:');
  });

  it('does not misclassify narrative, quoted, negated, or credential text as owner action items', async () => {
    const examples = [
      ['2021', 'Dana', 'I wrote "Call me" in the notes app.'],
      ['2022', 'Morgan', 'The grocery list says bring milk.'],
      ['2023', 'Riley', 'Send notifications are disabled in settings.'],
      ['2024', 'Casey', 'I know what you mean.'],
      ['2025', 'Jordan', 'She said, "Can you send the file?"'],
      ['2026', 'Taylor', "Don't send me the address."],
      ['2027', 'Security question', 'What was the verification code?'],
    ] as const;
    for (const [suffix, label, content] of examples) {
      const chatJid = `bb:iMessage;-;+1555000${suffix}`;
      storeChatMetadata(
        chatJid,
        '2026-04-15T16:10:00.000Z',
        label,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `narrative-${suffix}`,
        chat_jid: chatJid,
        sender: `bb:+1555000${suffix}`,
        sender_name: label,
        content,
        timestamp: '2026-04-15T16:10:00.000Z',
        is_from_me: false,
      });
    }

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.needsReply).toEqual([]);
    for (const [, label] of examples) {
      const item = result.items.find(
        (candidate) => candidate.chatLabel === label,
      );
      expect(item?.riskFlags).not.toContain('needs_owner_action');
      expect(item?.riskFlags).not.toContain('needs_owner_answer');
      expect(item?.riskFlags).not.toContain('automated_transactional_notice');
    }
    const securityQuestion = result.items.find(
      (item) => item.chatLabel === 'Security question',
    );
    expect(securityQuestion).toMatchObject({ section: 'no_reply_needed' });
    expect(securityQuestion?.riskFlags).toContain(
      'security_credential_question',
    );
    expect(securityQuestion?.recommendedAction).toContain('Do not share');
  });

  it('preserves closure and owner-resolution behavior for imperative requests', async () => {
    const closedJid = 'bb:iMessage;-;+15550002031';
    storeChatMetadata(
      closedJid,
      '2026-04-15T16:11:00.000Z',
      'Closed request',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'closed-imperative-request',
      chat_jid: closedJid,
      sender: 'bb:+15550002031',
      sender_name: 'Closed request',
      content: 'Bring milk',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'closed-imperative-closure',
      chat_jid: closedJid,
      sender: 'bb:+15550002031',
      sender_name: 'Closed request',
      content: 'Never mind, I handled it.',
      timestamp: '2026-04-15T16:11:00.000Z',
      is_from_me: false,
    });

    const answeredJid = 'bb:iMessage;-;+15550002032';
    storeChatMetadata(
      answeredJid,
      '2026-04-15T16:13:00.000Z',
      'Answered request',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'answered-imperative-request',
      chat_jid: answeredJid,
      sender: 'bb:+15550002032',
      sender_name: 'Answered request',
      content: 'Send the venue address',
      timestamp: '2026-04-15T16:12:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'answered-imperative-owner-turn',
      chat_jid: answeredJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Sent the venue address.',
      timestamp: '2026-04-15T16:13:00.000Z',
      is_from_me: true,
    });

    const replacementJid = 'bb:iMessage;-;+15550002033';
    storeChatMetadata(
      replacementJid,
      '2026-04-15T16:14:00.000Z',
      'Replacement request',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'replacement-imperative-request',
      chat_jid: replacementJid,
      sender: 'bb:+15550002033',
      sender_name: 'Replacement request',
      content: 'No need to bring chairs; bring milk instead.',
      timestamp: '2026-04-15T16:14:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const byLabel = new Map(result.items.map((item) => [item.chatLabel, item]));

    expect(byLabel.get('Closed request')?.section).toBe('no_reply_needed');
    expect(byLabel.get('Answered request')?.section).toBe('no_reply_needed');
    expect(byLabel.get('Replacement request')).toMatchObject({
      section: 'needs_reply',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(byLabel.get('Replacement request')?.riskFlags).toContain(
      'needs_owner_action',
    );
  });

  it('keeps an inbound request open when a later inbound addendum is not an answer', async () => {
    const chatJid = 'bb:iMessage;-;+14695550124';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:12:00.000Z',
      'Riley',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'riley-prior-owner-turn',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'I am heading over after work.',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: true,
    });
    storeMessage({
      id: 'riley-open-request',
      chat_jid: chatJid,
      sender: 'bb:+14695550124',
      sender_name: 'Riley',
      content: 'Please send the venue address.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'riley-request-addendum',
      chat_jid: chatJid,
      sender: 'bb:+14695550124',
      sender_name: 'Riley',
      content: 'The doors open at six.',
      timestamp: '2026-04-15T16:12:00.000Z',
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
      chatLabel: 'Riley',
      section: 'needs_reply',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(item?.riskFlags).toContain('needs_owner_answer');
    expect(item?.whyText).toContain('asks for an answer');
    expect(item?.whyText).toContain('after your last reply');
    expect(item?.summaryText).toContain(
      'their earlier ask "Please send the venue address." is still open',
    );
    expect(item?.summaryText).toContain(
      'their latest message adds "The doors open at six."',
    );
    expect(item?.recommendedAction).toContain('No draft suggested');
  });

  it('surfaces a confused reply after an outbound message without inventing a cleanup draft', async () => {
    const chatJid = 'bb:iMessage;-;+15550001999';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:12:00.000Z',
      'Pool chat',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'confusion-prior-outbound',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content:
        'Andrea: Pool invite sounded nice. Want me to draft an on-my-way reply?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: true,
    });
    storeMessage({
      id: 'confusion-inbound',
      chat_jid: chatJid,
      sender: 'bb:+15550001999',
      sender_name: 'Pool chat',
      content: 'Huh',
      timestamp: '2026-04-15T16:12:00.000Z',
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
      chatLabel: 'Pool chat',
      section: 'needs_reply',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(item?.riskFlags).toContain('needs_owner_context');
    expect(item?.whyText).toContain('signals confusion');
    expect(item?.summaryText).toContain('Huh');
    expect(item?.recommendedAction).toContain(
      'No automatic draft or send is appropriate',
    );
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('I will not guess or send a clarification automatically');
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
    storeInbound({
      suffix: '1007',
      label: 'ABC Home',
      content:
        'Thank you for choosing ABC Home. The work is completed. Please find the attached invoice for your review. To pay your invoice or view details: https://billing.example.com/invoice/123.',
      timestamp: '2026-04-15T16:45:00.000Z',
    });
    storeInbound({
      suffix: '1008',
      label: 'TXHEALTH',
      content:
        'TXHEALTH: Action Needed. You have a statement balance that is not on your payment plan. Pay, apply for financial assistance, or view details: https://billing.example.com. Reply STOP to opt out.',
      timestamp: '2026-04-15T16:48:00.000Z',
    });
    storeInbound({
      suffix: '1009',
      label: 'City Water',
      content:
        'CITY WATER: Your bill is past due. Pay online now at https://billing.example.com/water.',
      timestamp: '2026-04-15T16:47:00.000Z',
    });
    storeInbound({
      suffix: '1010',
      label: 'Morgan',
      content:
        'Can you pay the electric bill today? Here is the utility page: https://utility.example.com.',
      timestamp: '2026-04-15T16:46:00.000Z',
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const byLabel = new Map(result.items.map((item) => [item.chatLabel, item]));

    expect(result.items.slice(0, 3).map((item) => item.chatLabel)).toEqual(
      expect.arrayContaining(['Candace', 'Family Committee', 'Morgan']),
    );
    expect(
      result.items.slice(0, 3).every((item) => item.section === 'needs_reply'),
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
    for (const label of ['ABC Home', 'TXHEALTH', 'City Water']) {
      expect(byLabel.get(label)).toMatchObject({
        section: 'worth_watching',
        suggestedReply: null,
        suggestedReplies: [],
      });
      expect(byLabel.get(label)?.riskFlags).toContain(
        'automated_transactional_notice',
      );
      expect(byLabel.get(label)?.riskFlags).not.toContain('needs_owner_answer');
      expect(byLabel.get(label)?.recommendedAction).toContain(
        'no conversational reply is needed',
      );
    }
    expect(byLabel.get('Morgan')).toMatchObject({
      section: 'needs_reply',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(byLabel.get('Morgan')?.riskFlags).toContain('needs_owner_answer');
    expect(byLabel.get('Morgan')?.riskFlags).not.toContain(
      'automated_transactional_notice',
    );
    expect(byLabel.get('Family Committee')?.riskFlags).not.toContain(
      'automated_marketing_or_survey',
    );
    expect(byLabel.get('Family Committee')?.section).toBe('needs_reply');

    const generatedDrafts = result.needsReply.flatMap(
      (item) => item.suggestedReplies || [],
    );
    expect(generatedDrafts).toEqual([]);
    expect(
      result.needsReply.every((item) =>
        item.riskFlags.includes('needs_owner_answer'),
      ),
    ).toBe(true);
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).not.toContain('Draft option:');
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toMatch(/\d+\. Candace:/);
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('not device unread/read status');
  });

  it('keeps an ordinary human survey request conversational instead of labeling it automation', async () => {
    const chatJid = 'bb:iMessage;-;human-reunion-survey';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Family organizer',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'human-reunion-survey-request',
      chat_jid: chatJid,
      sender: 'family-organizer',
      sender_name: 'Family organizer',
      content:
        'Can you fill out the reunion survey for Aunt May? The family needs a head count.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );

    expect(item).toMatchObject({ section: 'needs_reply' });
    expect(item?.riskFlags).toContain('needs_owner_answer');
    expect(item?.riskFlags).not.toContain('automated_marketing_or_survey');
    expect(item?.riskFlags).not.toContain('automated_transactional_notice');
  });

  it('keeps ordinary-contact @Andrea text in recent text recaps', async () => {
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

    const candace = result.items.find((item) => item.chatLabel === 'Candace');
    expect(candace?.summaryText).toContain('dinner still works');
    expect(candace?.summaryText).toContain('@Andrea summarize this');
    expect(candace?.evidenceSnippets.join(' ')).toContain(
      '@Andrea summarize this',
    );
  });

  it('carries attachment presence into summaries and treats tapbacks as no-reply activity', async () => {
    expect(
      describeMessageForSummary({
        id: 'reaction-with-target',
        chat_jid: 'bb:iMessage;-;reaction-unit-fixture',
        sender: 'reaction-contact',
        sender_name: 'Reaction contact',
        content: '[BlueBubbles reaction: like]',
        timestamp: '2026-04-15T16:15:00.000Z',
        is_from_me: false,
        reply_to: {
          message_id: 'target-message',
          content: 'Dinner moved to seven tonight.',
        },
      }),
    ).toBe('[Reacted with like] to: "Dinner moved to seven tonight."');
    expect(
      formatRecentTextReviewLocalTimestamp(
        '2026-04-15T16:15:00.000Z',
        'America/Chicago',
      ),
    ).toBe('Apr 15, 2026, 11:15 AM CDT');

    const mediaChatJid = 'bb:iMessage;-;media-summary-fixture';
    storeChatMetadata(
      mediaChatJid,
      '2026-04-15T16:10:00.000Z',
      'Media thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'media-summary-photo-only',
      chat_jid: mediaChatJid,
      sender: 'media-contact',
      sender_name: 'Media contact',
      content: '',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:summary-photo',
          chatJid: mediaChatJid,
          messageId: 'media-summary-photo-only',
          sourceChannel: 'bluebubbles',
          kind: 'image',
          fetchStatus: 'metadata_only',
        },
      ],
    });
    storeMessage({
      id: 'media-summary-caption-photo',
      chat_jid: mediaChatJid,
      sender: 'media-contact',
      sender_name: 'Media contact',
      content: 'Here is the setup.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:summary-caption-photo',
          chatJid: mediaChatJid,
          messageId: 'media-summary-caption-photo',
          sourceChannel: 'bluebubbles',
          kind: 'image',
          fetchStatus: 'cached',
        },
      ],
    });
    const reactionChatJid = 'bb:iMessage;-;reaction-summary-fixture';
    storeChatMetadata(
      reactionChatJid,
      '2026-04-15T16:15:00.000Z',
      'Reaction thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'reaction-summary-target',
      chat_jid: reactionChatJid,
      sender: 'reaction-contact',
      sender_name: 'Reaction contact',
      content: 'Dinner moved to seven tonight.',
      timestamp: '2026-04-15T16:14:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'reaction-summary-like',
      chat_jid: reactionChatJid,
      sender: 'reaction-contact',
      sender_name: 'Reaction contact',
      content: '[BlueBubbles reaction: like]',
      timestamp: '2026-04-15T16:15:00.000Z',
      is_from_me: false,
      reply_to_id: 'reaction-summary-target',
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const media = result.items.find(
      (item) => item.chatLabel === 'Media thread',
    );
    const reaction = result.items.find(
      (item) => item.chatLabel === 'Reaction thread',
    );

    expect(media?.summaryText).toContain(
      '[Attached: photo; contents not included in this text summary]',
    );
    expect(media?.summaryText).toContain('Here is the setup.');
    expect(reaction).toMatchObject({
      section: 'no_reply_needed',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(reaction?.summaryText).toContain('[Reacted with like]');
    expect(reaction?.summaryText).toContain('Dinner moved to seven tonight.');
    expect(reaction?.recommendedAction).toContain('No reply needed');
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('Latest activity: Apr 15, 2026');
  });

  it('binds reaction freshness to the exact reply target identity', async () => {
    const chatJid = 'bb:iMessage;-;reaction-freshness-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:15:00.000Z',
      'Reaction freshness',
      'bluebubbles',
      false,
    );
    const reaction = {
      id: 'reaction-freshness-like',
      chat_jid: chatJid,
      sender: 'reaction-contact',
      sender_name: 'Reaction contact',
      content: '[BlueBubbles reaction: like]',
      timestamp: '2026-04-15T16:15:00.000Z',
      is_from_me: false,
    };
    storeMessage({ ...reaction, reply_to_id: 'target-message-a' });
    const first = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const firstHash = first.items.find((item) => item.chatJid === chatJid)
      ?.freshnessSnapshot?.snapshotHash;

    storeMessage({ ...reaction, reply_to_id: 'target-message-b' });
    const second = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const secondHash = second.items.find((item) => item.chatJid === chatJid)
      ?.freshnessSnapshot?.snapshotHash;

    expect(firstHash).toBeTruthy();
    expect(secondHash).toBeTruthy();
    expect(secondHash).not.toBe(firstHash);
  });

  it('reviews passive contact @Andrea text but excludes configured self-thread control traffic', async () => {
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;owner@example.invalid',
    );
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      'iMessage;-;owner@example.invalid,iMessage;-;+15550009999',
    );
    const selfThreadJid = 'bb:iMessage;-;owner@example.invalid';
    const contactJid = 'bb:iMessage;-;+15550001111';

    storeChatMetadata(
      selfThreadJid,
      '2026-04-15T16:20:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'self-thread-summary-command',
      chat_jid: selfThreadJid,
      sender: 'owner',
      sender_name: 'Owner',
      content: 'summarize my recent texts',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: true,
    });
    storeChatMetadata(
      contactJid,
      '2026-04-15T16:25:00.000Z',
      'Andrea G',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'passive-contact-andrea-text',
      chat_jid: contactJid,
      sender: 'bb:+15550001111',
      sender_name: 'Andrea G',
      content: '@Andrea can you bring the salad tonight?',
      timestamp: '2026-04-15T16:25:00.000Z',
      is_from_me: false,
      message_ingress_origin: 'passive_contact_sync',
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.reviewedConversationCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      chatJid: contactJid,
      chatLabel: 'Andrea G',
      section: 'needs_reply',
    });
    expect(result.items[0]?.summaryText).toContain(
      '@Andrea can you bring the salad tonight?',
    );
    expect(result.items.some((item) => item.chatJid === selfThreadJid)).toBe(
      false,
    );
  });

  it('raises priority for explicitly confirmed people and active life threads', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const chatJid = 'bb:iMessage;-;+14695550123';
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
    upsertCommunicationThread({
      id: 'comm-candace-confirmed',
      groupFolder: 'main',
      title: 'Candace',
      linkedSubjectIds: ['subject-candace'],
      linkedLifeThreadIds: ['life-candace-dinner'],
      channel: 'bluebubbles',
      channelChatJid: chatJid,
      lastInboundSummary: null,
      lastOutboundSummary: null,
      followupState: 'unknown',
      urgency: 'none',
      followupDueAt: null,
      suggestedNextAction: null,
      toneStyleHints: [],
      lastContactAt: now,
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    });
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'candace-known-1',
      chat_jid: chatJid,
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
      'existing communication thread',
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

  it('does not auto-link participant metadata or third-party names without confirmation', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    for (const [id, name] of [
      ['subject-alice', 'Alice'],
      ['subject-bob', 'Bob'],
      ['subject-ann', 'Ann'],
      ['subject-joanne', 'Joanne'],
    ] as const) {
      upsertProfileSubject({
        id,
        groupFolder: 'main',
        kind: 'person',
        canonicalName: name.toLowerCase(),
        displayName: name,
        createdAt: now,
        updatedAt: now,
      });
    }
    upsertLifeThread({
      id: 'life-bob-project',
      groupFolder: 'main',
      title: 'Bob project',
      category: 'work',
      status: 'active',
      scope: 'work',
      relatedSubjectIds: ['subject-bob'],
      contextTags: [],
      summary: 'A project involving Bob.',
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
      'bb:iMessage;-;+15550004101',
      '2026-04-15T16:10:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'identity-body-alice',
      chat_jid: 'bb:iMessage;-;+15550004101',
      sender: 'bb:+15550004101',
      sender_name: 'Alice',
      content: 'Bob asked whether you can send the plan tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;-;+15550004102',
      '2026-04-15T16:11:00.000Z',
      'Joanne',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'identity-boundary-joanne',
      chat_jid: 'bb:iMessage;-;+15550004102',
      sender: 'bb:+15550004102',
      sender_name: 'Joanne',
      content: 'Can you send the plan tonight?',
      timestamp: '2026-04-15T16:11:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const alice = result.items.find((item) => item.chatLabel === 'Alice');
    const joanne = result.items.find((item) => item.chatLabel === 'Joanne');

    expect(alice?.linkedSubjectIds).toEqual([]);
    expect(alice?.linkedLifeThreadIds).toEqual([]);
    expect(joanne?.linkedSubjectIds).toEqual([]);
    expect(joanne?.linkedLifeThreadIds).toEqual([]);
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: false,
        limit: 20,
      }).every(
        (thread) =>
          thread.linkedSubjectIds.length === 0 &&
          thread.linkedLifeThreadIds.length === 0,
      ),
    ).toBe(true);
  });

  it('persists an explicit inbound closure and clears stale reply-needed state', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const chatJid = 'bb:iMessage;-;+15550004201';
    upsertCommunicationThread({
      id: 'comm-closure-inbound',
      groupFolder: 'main',
      title: 'Alice',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: chatJid,
      lastInboundSummary: 'Alice previously asked for help.',
      lastOutboundSummary: null,
      followupState: 'reply_needed',
      urgency: 'tonight',
      followupDueAt: '2026-04-15T18:00:00.000Z',
      suggestedNextAction: 'draft_reply',
      toneStyleHints: [],
      lastContactAt: '2026-04-15T15:00:00.000Z',
      lastMessageId: 'old-open-message',
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: '2026-04-15T15:00:00.000Z',
      updatedAt: '2026-04-15T15:00:00.000Z',
      disabledAt: null,
    });
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:30:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'closure-inbound-message',
      chat_jid: chatJid,
      sender: 'bb:+15550004201',
      sender_name: 'Alice',
      content: 'Never mind, I handled it.',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.id === 'comm-closure-inbound');
    const signal = listCommunicationSignalsForThread('comm-closure-inbound').at(
      -1,
    );

    expect(item).toMatchObject({
      section: 'no_reply_needed',
      communicationThreadId: 'comm-closure-inbound',
    });
    expect(item?.recommendedAction).toContain('already handled');
    expect(thread).toMatchObject({
      followupState: 'resolved',
      urgency: 'none',
      followupDueAt: null,
      suggestedNextAction: null,
      inferenceState: 'user_confirmed',
    });
    expect(thread?.lastInboundSummary).toContain('Never mind, I handled it.');
    expect(signal).toMatchObject({
      direction: 'inbound',
      followupState: 'resolved',
      suggestedAction: null,
    });
  });

  it('records an owner reply as outbound and preserves separate inbound and outbound summaries', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const chatJid = 'bb:iMessage;-;+15550004202';
    upsertCommunicationThread({
      id: 'comm-closure-outbound',
      groupFolder: 'main',
      title: 'Joanne',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: chatJid,
      lastInboundSummary: null,
      lastOutboundSummary: null,
      followupState: 'reply_needed',
      urgency: 'soon',
      followupDueAt: null,
      suggestedNextAction: 'draft_reply',
      toneStyleHints: [],
      lastContactAt: '2026-04-15T16:00:00.000Z',
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'assistant_inferred',
      trackingMode: 'default',
      createdAt: '2026-04-15T16:00:00.000Z',
      updatedAt: '2026-04-15T16:00:00.000Z',
      disabledAt: null,
    });
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:25:00.000Z',
      'Joanne',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'closure-question',
      chat_jid: chatJid,
      sender: 'bb:+15550004202',
      sender_name: 'Joanne',
      content: 'Can you confirm dinner still works?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'closure-answer',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Me',
      content: 'Yes, dinner still works for me.',
      timestamp: '2026-04-15T16:25:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.id === 'comm-closure-outbound');
    const signal = listCommunicationSignalsForThread(
      'comm-closure-outbound',
    ).at(-1);

    expect(item?.section).toBe('no_reply_needed');
    expect(thread).toMatchObject({
      followupState: 'resolved',
      urgency: 'none',
    });
    expect(thread?.lastInboundSummary).toContain(
      'Can you confirm dinner still works?',
    );
    expect(thread?.lastOutboundSummary).toContain(
      'Yes, dinner still works for me.',
    );
    expect(signal).toMatchObject({
      direction: 'outbound',
      followupState: 'resolved',
    });
  });

  it('keeps a new question open when it follows a closure phrase in the same inbound message', async () => {
    const chatJid = 'bb:iMessage;-;+15550004203';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:30:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'mixed-closure-question',
      chat_jid: chatJid,
      sender: 'bb:+15550004203',
      sender_name: 'Alice',
      content: 'No need to bring chairs; can you send the address?',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );

    expect(item).toMatchObject({ section: 'needs_reply' });
    expect(item?.whyText).toContain('asks for an answer');
  });

  it('keeps an unanswered inbound question open after an unrelated owner message', async () => {
    const chatJid = 'bb:iMessage;-;+15550004204';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:30:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'unrelated-open-question',
      chat_jid: chatJid,
      sender: 'bb:+15550004204',
      sender_name: 'Alice',
      content: 'Can you confirm whether dinner still works?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });
    await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T16:25:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    storeMessage({
      id: 'unrelated-owner-message',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'The weather forecast looks sunny this weekend.',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === chatJid);

    expect(item?.section).toBe('needs_reply');
    expect(thread?.followupState).toBe('reply_needed');
    expect(thread?.lastOutboundSummary).toContain('weather forecast');
  });

  it('preserves multiple and compound asks when a generic owner acknowledgement does not answer them', async () => {
    const multipleJid = 'bb:iMessage;-;multiple-open-asks';
    storeChatMetadata(
      multipleJid,
      '2026-04-15T16:30:00.000Z',
      'Multiple asks',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'multiple-open-ask-dinner',
      chat_jid: multipleJid,
      sender: 'multiple-asks-contact',
      sender_name: 'Multiple asks',
      content: 'Can you confirm whether dinner still works?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'multiple-open-ask-address',
      chat_jid: multipleJid,
      sender: 'multiple-asks-contact',
      sender_name: 'Multiple asks',
      content: 'Can you send the venue address?',
      timestamp: '2026-04-15T16:21:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'multiple-open-ask-generic-answer',
      chat_jid: multipleJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Yes.',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: true,
    });

    const compoundJid = 'bb:iMessage;-;compound-open-ask';
    storeChatMetadata(
      compoundJid,
      '2026-04-15T16:31:00.000Z',
      'Compound ask',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'compound-open-ask-request',
      chat_jid: compoundJid,
      sender: 'compound-ask-contact',
      sender_name: 'Compound ask',
      content: 'Can you confirm dinner and send the venue address?',
      timestamp: '2026-04-15T16:29:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'compound-open-ask-generic-answer',
      chat_jid: compoundJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Done.',
      timestamp: '2026-04-15T16:31:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const multiple = result.items.find(
      (candidate) => candidate.chatJid === multipleJid,
    );
    const compound = result.items.find(
      (candidate) => candidate.chatJid === compoundJid,
    );

    expect(multiple).toMatchObject({ section: 'needs_reply' });
    expect(multiple?.summaryText).toContain('their open asks remain');
    expect(multiple?.summaryText).toContain('dinner still works');
    expect(multiple?.summaryText).toContain('venue address');
    expect(multiple?.whyText).toContain('multiple earlier asks remain open');
    expect(compound).toMatchObject({ section: 'needs_reply' });
    expect(compound?.summaryText).toContain(
      'Can you confirm dinner and send the venue address?',
    );
    expect(compound?.whyText).toContain('an earlier ask remains open');
  });

  it('resolves a stale open turn when the owner explicitly closes it', async () => {
    const chatJid = 'bb:iMessage;-;+15550004205';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:30:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'owner-closure-open-question',
      chat_jid: chatJid,
      sender: 'bb:+15550004205',
      sender_name: 'Alice',
      content: 'Can you handle the reservation?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });
    await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T16:25:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    storeMessage({
      id: 'owner-closure-message',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Never mind, I handled it.',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === chatJid);

    expect(item?.section).toBe('no_reply_needed');
    expect(thread?.followupState).toBe('resolved');
    expect(thread?.lastOutboundSummary).toContain('Never mind, I handled it.');
  });

  it('tracks an owner-authored question as waiting on the recipient', async () => {
    const chatJid = 'bb:iMessage;-;+15550004206';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:30:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'owner-waiting-question',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Can you send me the address?',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: true,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === chatJid);

    expect(item?.section).toBe('no_reply_needed');
    expect(item?.summaryText).toContain('waiting on them');
    expect(thread).toMatchObject({
      followupState: 'waiting_on_them',
      urgency: 'none',
    });
    expect(thread?.lastInboundSummary).toBeNull();
    expect(thread?.lastOutboundSummary).toContain(
      'Can you send me the address?',
    );
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

  it('uses existing thread state without trusting an assistant-inferred identity', async () => {
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
    expect(known?.contextLink.confidence).toBe('medium');
    expect(known?.contextLink.reason).toBe('matched a safe synced chat label');
    expect(known?.linkedSubjectIds).toEqual([]);
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: false,
        limit: 20,
      }).find((thread) => thread.id === 'comm-candace-active')
        ?.linkedSubjectIds,
    ).toEqual([]);
    expect(known!.priorityScore).toBeGreaterThan(unknown!.priorityScore);
  });

  it('uses accepted relationship tone memory for safer suggested replies', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const chatJid = 'bb:iMessage;-;+14695550123';
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
    upsertCommunicationThread({
      id: 'comm-candace-tone-confirmed',
      groupFolder: 'main',
      title: 'Candace',
      linkedSubjectIds: ['subject-candace'],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: chatJid,
      lastInboundSummary: null,
      lastOutboundSummary: null,
      followupState: 'unknown',
      urgency: 'none',
      followupDueAt: null,
      suggestedNextAction: null,
      toneStyleHints: [],
      lastContactAt: now,
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    });
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'candace-tone-1',
      chat_jid: chatJid,
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Dinner moved to seven tonight, just keeping you posted.',
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
    expect(result.needsReply[0]?.suggestedReply).toBe(
      'Thanks for the heads-up. I appreciate it.',
    );
    expect(result.needsReply[0]?.suggestedReply).not.toMatch(
      /\b(?:checking|will confirm|will get back)\b/i,
    );
    const formatted = formatRecentTextReviewReply({
      result,
      channel: 'telegram',
    });
    expect(result.needsReply[0]?.suggestedReplies).toHaveLength(3);
    expect(formatted).toContain('Unsent draft options:');
    expect(formatted).toContain('1) warm:');
    expect(formatted).toContain('2) direct:');
    expect(formatted).toContain('3) brief:');
  });

  it('does not let proposed relationship facts influence reply tone', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const chatJid = 'bb:iMessage;-;+14695550124';
    upsertProfileSubject({
      id: 'subject-alex',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'alex',
      displayName: 'Alex',
      createdAt: now,
      updatedAt: now,
    });
    upsertProfileFact({
      id: 'fact-alex-proposed-tone',
      groupFolder: 'main',
      subjectId: 'subject-alex',
      category: 'conversational_style',
      factKey: 'learning.alex.reply_tone',
      valueJson: JSON.stringify({ value: 'Use a warm, careful tone.' }),
      state: 'proposed',
      sourceChannel: 'telegram',
      sourceSummary: 'Proposed warm tone for Alex.',
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    });
    upsertCommunicationThread({
      id: 'comm-alex-tone-confirmed',
      groupFolder: 'main',
      title: 'Alex',
      linkedSubjectIds: ['subject-alex'],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: chatJid,
      lastInboundSummary: null,
      lastOutboundSummary: null,
      followupState: 'unknown',
      urgency: 'none',
      followupDueAt: null,
      suggestedNextAction: null,
      toneStyleHints: [],
      lastContactAt: now,
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    });
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Alex',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'alex-tone-proposed-1',
      chat_jid: chatJid,
      sender: 'bb:+14695550124',
      sender_name: 'Alex',
      content: 'Load-in moved to six tonight, just sharing the update.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date(now),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.needsReply[0]?.linkedSubjectIds).toEqual(['subject-alex']);
    expect(result.needsReply[0]?.suggestedReply).toBe(
      'Thanks for the timing update.',
    );
    expect(result.needsReply[0]?.suggestedReply).not.toContain('appreciate');
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

  it('does not expose a numeric SMS short code as a conversation label', async () => {
    const chatJid = 'bb:SMS;-;84018';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      '84018',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'short-code-notice',
      chat_jid: chatJid,
      sender: 'bb:84018',
      sender_name: '84018',
      content:
        'TXHEALTH: Your payment plan auto-pay is scheduled tomorrow. Reply STOP to opt out.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    expect(result.items[0]?.chatLabel).toBe('Messages chat');
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).not.toContain('84018');
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
            'bb:iMessage;-;+14695550123 sent verification code 847263 and asked for OPENAI_API_KEY=sk-secret and jeff@example.com',
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
          evidenceSnippets: [
            'Them: Your one-time passcode is 847263. Call me at +14695550123.',
          ],
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
    expect(prompt).not.toContain('847263');
    expect(prompt).toContain('[redacted email]');
    expect(prompt).toContain('[redacted code]');
    expect(prompt).toContain('OPENAI_API_KEY=***');
    expect(prompt).toContain(
      'Do not add or rewrite recommendedAction, suggestedReply, or suggestedReplies',
    );
    expect(redactRecentTextReviewText('Reach me at +14695550123')).toContain(
      '[redacted number]',
    );
    expect(
      redactRecentTextReviewText('Your code is 765432. Do not share it.'),
    ).toContain('[redacted code]');
    expect(redactRecentTextReviewText('Use 123-456 to sign in.')).toContain(
      '[redacted code]',
    );
    expect(redactRecentTextReviewText('Your login code is A9B2C7.')).toContain(
      '[redacted code]',
    );
    expect(redactRecentTextReviewText('My ZIP code is 75201.')).toContain(
      '75201',
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
      content:
        'Your security code is 836204. Can you confirm if dinner still works tonight?',
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
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('Synthesis: OpenAI refined bounded recap wording');
    expect(providerBody).toContain('dinner still works tonight');
    expect(providerBody).not.toContain('836204');
    expect(providerBody).toContain('[redacted code]');
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
    storeChatMetadata(
      'bb:iMessage;-;+15550004003',
      '2026-04-15T16:30:00.000Z',
      'Pool chat',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'provider-guard-confusion-outbound',
      chat_jid: 'bb:iMessage;-;+15550004003',
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Want me to write a pool reply?',
      timestamp: '2026-04-15T16:29:00.000Z',
      is_from_me: true,
    });
    storeMessage({
      id: 'provider-guard-confusion-inbound',
      chat_jid: 'bb:iMessage;-;+15550004003',
      sender: 'bb:+15550004003',
      sender_name: 'Pool chat',
      content: 'Huh',
      timestamp: '2026-04-15T16:30:00.000Z',
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
      const human = providerItems.find((item) =>
        item.riskFlags.includes('needs_owner_answer'),
      )!;
      const confusion = providerItems.find((item) =>
        item.riskFlags.includes('needs_owner_context'),
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
              {
                itemId: confusion.itemId,
                recommendedAction:
                  'Send an automatic clarification to fix the confusion.',
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
    const confusion = result.items.find(
      (item) => item.chatLabel === 'Pool chat',
    );

    expect(result.providerUsed).toBe('openai');
    expect(automated).toMatchObject({
      section: 'no_reply_needed',
      suggestedReply: null,
      suggestedReplies: [],
    });
    expect(automated?.summaryText).not.toBe('Urgent personal reply required.');
    expect(human?.riskFlags).toContain('needs_owner_answer');
    expect(human?.suggestedReply).toBeNull();
    expect(human?.suggestedReplies).toEqual([]);
    expect(confusion?.recommendedAction).toContain(
      'No automatic draft or send is appropriate',
    );
    expect(confusion?.recommendedAction).not.toContain(
      'Send an automatic clarification',
    );
  });

  it('rejects provider recap patches that invent state, timing, negation, or people', async () => {
    for (const [index, label] of ['Candace', 'Riley', 'Morgan'].entries()) {
      const chatJid = `bb:iMessage;-;+1555000401${index + 1}`;
      const timestamp = `2026-04-15T16:${String(10 + index).padStart(2, '0')}:00.000Z`;
      storeChatMetadata(chatJid, timestamp, label, 'bluebubbles', false);
      storeMessage({
        id: `provider-grounding-human-${index}`,
        chat_jid: chatJid,
        sender: `bb:+1555000401${index + 1}`,
        sender_name: label,
        content: 'Can you tell me whether dinner still works tonight?',
        timestamp,
        is_from_me: false,
      });
    }

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
      const humans = JSON.parse(serializedItems) as Array<{
        itemId: string;
        chatLabel: string;
      }>;
      const itemIdFor = (chatLabel: string): string | undefined =>
        humans.find((item) => item.chatLabel === chatLabel)?.itemId;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            items: [
              {
                itemId: itemIdFor('Candace'),
                summaryText: 'Candace confirmed dinner works tomorrow.',
              },
              {
                itemId: itemIdFor('Riley'),
                summaryText: 'Jordan asked whether dinner still works tonight.',
              },
              {
                itemId: itemIdFor('Morgan'),
                whyText:
                  'No reply is needed about whether dinner still works tonight.',
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
    const human = result.items.find((item) => item.chatLabel === 'Candace');
    const properNoun = result.items.find((item) => item.chatLabel === 'Riley');
    const negation = result.items.find((item) => item.chatLabel === 'Morgan');

    expect(result.providerUsed).toBe('openai');
    expect(human?.summaryText).toContain('dinner still works tonight');
    expect(human?.summaryText).not.toContain('confirmed dinner works tomorrow');
    expect(properNoun?.summaryText).not.toContain('Jordan');
    expect(properNoun?.summaryText).toContain('Riley');
    expect(negation?.whyText).toContain('asks for an answer');
    expect(negation?.whyText).toContain('awaiting your reply');
    expect(negation?.whyText).not.toContain('No reply is needed');
  });

  it('rejects a mixed provider recap patch when one claim removes evidence negation', async () => {
    const chatJid = 'bb:iMessage;-;+15550004021';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:20:00.000Z',
      'Avery',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'provider-polarity-mixed-claim',
      chat_jid: chatJid,
      sender: 'bb:+15550004021',
      sender_name: 'Avery',
      content:
        'The dinner plan is not confirmed, but the pickup remains scheduled. Can you let me know what you think?',
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
      const [providerItem] = JSON.parse(serializedItems) as Array<{
        itemId: string;
      }>;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            items: [
              {
                itemId: providerItem?.itemId,
                summaryText:
                  'The pickup remains scheduled, and the dinner plan is confirmed.',
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
    const item = result.items.find(
      (candidate) => candidate.chatLabel === 'Avery',
    );

    expect(result.providerUsed).toBe('openai');
    expect(item?.summaryText).toContain('not confirmed');
    expect(item?.summaryText).toContain('pickup remains scheduled');
    expect(item?.summaryText).not.toContain('dinner plan is confirmed');
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
    expect(seed?.items[0]?.riskFlags).toContain('needs_owner_answer');
    expect(seed?.items[0]?.suggestedReply).toBeNull();
    expect(seed?.items[0]?.suggestedReplies).toEqual([]);
    expect(seed?.items[0]?.freshnessSnapshot?.snapshotHash).toBeTruthy();
    const target = resolveRecentTextReviewFollowupTarget(seed!.items[0]!);
    expect(target).toMatchObject({
      ok: true,
      chatJid: 'bb:iMessage;-;+14695550123',
    });
  });

  it('includes Telegram chats in recent text review', async () => {
    const telegramChatJid = 'tg:alice';
    storeChatMetadata(
      telegramChatJid,
      '2026-04-15T16:10:00.000Z',
      'Alice',
      'telegram',
      false,
    );
    storeMessage({
      id: 'telegram-review-1',
      chat_jid: telegramChatJid,
      sender: 'tg:alice',
      sender_name: 'Alice',
      content: 'Can you confirm dinner is still on for tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === telegramChatJid,
    );
    expect(item).toMatchObject({
      chatJid: telegramChatJid,
      chatLabel: 'Alice',
    });

    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === telegramChatJid);
    expect(thread).toMatchObject({
      channel: 'telegram',
      channelChatJid: telegramChatJid,
    });
  });

  it('includes legacy Telegram chats without an explicit channel by tg: JID prefix', async () => {
    const telegramChatJid = 'tg:alice-legacy';
    storeChatMetadata(
      telegramChatJid,
      '2026-04-15T16:20:00.000Z',
      'Alice Legacy',
      undefined,
      false,
    );
    storeMessage({
      id: 'telegram-legacy-review-1',
      chat_jid: telegramChatJid,
      sender: 'tg:alice',
      sender_name: 'Alice Legacy',
      content: 'Can we still meet tomorrow morning?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === telegramChatJid,
    );
    expect(item).toMatchObject({
      chatJid: telegramChatJid,
      chatLabel: 'Alice Legacy',
      sourceChannel: 'telegram',
    });

    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === telegramChatJid);
    expect(thread).toMatchObject({
      channel: 'telegram',
      channelChatJid: telegramChatJid,
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

  it('resolves Telegram review items to follow-up targets and validates freshness', async () => {
    const telegramChatJid = 'tg:bob';
    storeChatMetadata(
      telegramChatJid,
      '2026-04-15T16:20:00.000Z',
      'Bob',
      'telegram',
      false,
    );
    storeMessage({
      id: 'tg-refresh-1',
      chat_jid: telegramChatJid,
      sender: 'tg:bob',
      sender_name: 'Bob',
      content: 'Can you confirm pickup is still today?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });

    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seedItem = parseRecentTextReviewSeedJson(
      buildRecentTextReviewSeedJson(review),
    )!.items[0]!;

    expect(resolveRecentTextReviewFollowupTarget(seedItem)).toMatchObject({
      ok: true,
      chatJid: telegramChatJid,
    });
    expect(
      validateRecentTextReviewFollowupFreshness({
        seedJson: buildRecentTextReviewSeedJson(review),
        item: seedItem,
        now: new Date('2026-04-15T17:05:00.000Z'),
      }),
    ).toMatchObject({ ok: true });
  });

  it('uses the immutable thread channel when a follow-up item surface no longer matches', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550131',
      '2026-04-15T16:20:00.000Z',
      'Evelyn',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'cross-surface-1',
      chat_jid: 'bb:iMessage;-;+14695550131',
      sender: 'bb:+14695550131',
      sender_name: 'Evelyn',
      content: 'Can we send that update today?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });

    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seedItem = parseRecentTextReviewSeedJson(
      buildRecentTextReviewSeedJson(review),
    )!.items[0]!;
    const mismatchedSurfaceItem = {
      ...seedItem,
      sourceChannel: 'telegram',
      section: seedItem.section,
    } as typeof seedItem & { sourceChannel: 'telegram' };

    expect(
      resolveRecentTextReviewFollowupTarget(mismatchedSurfaceItem),
    ).toMatchObject({
      ok: true,
      targetChannel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;+14695550131',
    });
    expect(
      validateRecentTextReviewFollowupFreshness({
        seedJson: buildRecentTextReviewSeedJson(review),
        item: mismatchedSurfaceItem,
        now: new Date('2026-04-15T17:05:00.000Z'),
      }),
    ).toMatchObject({ ok: true });
  });

  it('refreshes the exact quiet review thread before action-grade freshness validation', async () => {
    const chatJid = 'bb:iMessage;-;+14695550124';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Quiet Contact',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'quiet-review-1',
      chat_jid: chatJid,
      sender: 'bb:+14695550124',
      sender_name: 'Quiet Contact',
      content: 'Can you confirm dinner tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seedJson = buildRecentTextReviewSeedJson(review);
    const item = parseRecentTextReviewSeedJson(seedJson)!.items[0]!;
    const primeChatHistory = vi.fn(async (requestedChatJid: string) => {
      expect(requestedChatJid).toBe(chatJid);
      storeMessage({
        id: 'quiet-review-2',
        chat_jid: chatJid,
        sender: 'bb:+14695550124',
        sender_name: 'Quiet Contact',
        content: 'Never mind, dinner is handled.',
        timestamp: '2026-04-15T17:02:00.000Z',
        is_from_me: false,
      });
      return { chatJid: requestedChatJid, storedCount: 1, totalCount: 1 };
    });

    const freshness =
      await validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh({
        seedJson,
        item,
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeChatHistory,
      });

    expect(primeChatHistory).toHaveBeenCalledOnce();
    expect(freshness).toMatchObject({
      ok: false,
      reason: 'newer_thread_activity',
      outcome: 'blocked_stale',
      target: { chatJid },
    });
  });

  it('fails closed when the exact review thread cannot be refreshed', async () => {
    const chatJid = 'bb:iMessage;-;+14695550125';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Refresh Failure',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'refresh-failure-1',
      chat_jid: chatJid,
      sender: 'bb:+14695550125',
      sender_name: 'Refresh Failure',
      content: 'Does tomorrow work?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seedJson = buildRecentTextReviewSeedJson(review);
    const item = parseRecentTextReviewSeedJson(seedJson)!.items[0]!;
    expect(resolveRecentTextReviewFollowupTarget(item)).toMatchObject({
      ok: true,
      chatJid,
    });

    const freshness =
      await validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh({
        seedJson,
        item,
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeChatHistory: vi.fn(async () => {
          throw new Error('provider unavailable');
        }),
      });

    expect(freshness).toMatchObject({
      ok: false,
      reason: 'targeted_refresh_failed',
      outcome: 'blocked_stale',
      target: { chatJid },
    });

    const zeroRowRefresh =
      await validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh({
        seedJson,
        item,
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeChatHistory: vi.fn(async () => ({
          chatJid,
          storedCount: 0,
          totalCount: 0,
        })),
      });
    expect(zeroRowRefresh).toMatchObject({
      ok: false,
      reason: 'targeted_refresh_failed',
      outcome: 'blocked_stale',
      target: { chatJid },
    });
  });

  it('records review outcomes without overwriting directional message summaries', async () => {
    const chatJid = 'bb:iMessage;-;+15550004301';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Alice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'outcome-summary-inbound',
      chat_jid: chatJid,
      sender: 'bb:+15550004301',
      sender_name: 'Alice',
      content: 'Can you confirm the reservation?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T16:15:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    storeMessage({
      id: 'outcome-summary-outbound',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Yes, the reservation is confirmed.',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: true,
    });
    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T16:25:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const seed = parseRecentTextReviewSeedJson(
      buildRecentTextReviewSeedJson(result),
    )!;
    const item = seed.items.find(
      (candidate) => candidate.chatLabel === 'Alice',
    )!;
    const before = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === chatJid)!;

    expect(
      recordRecentTextReviewOutcome({
        groupFolder: 'main',
        item,
        outcome: 'handled',
        now: new Date('2026-04-15T16:30:00.000Z'),
      }),
    ).toBe(true);
    const after = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === chatJid)!;

    expect(after.lastInboundSummary).toBe(before.lastInboundSummary);
    expect(after.lastOutboundSummary).toBe(before.lastOutboundSummary);
    expect(after.followupState).toBe('resolved');
  });

  it('preserves handled, skipped, and scheduled review decisions until genuinely newer activity arrives', async () => {
    const cases = [
      {
        suffix: '4401',
        label: 'Handled thread',
        outcome: 'handled' as const,
        expectedState: 'resolved' as const,
        expectedSection: 'no_reply_needed' as const,
        expectedStatePhrase: 'marked this handled',
      },
      {
        suffix: '4402',
        label: 'Skipped thread',
        outcome: 'skipped' as const,
        expectedState: 'ignored' as const,
        expectedSection: 'no_reply_needed' as const,
        expectedStatePhrase: 'skipped this',
      },
      {
        suffix: '4403',
        label: 'Scheduled thread',
        outcome: 'reminded' as const,
        expectedState: 'scheduled' as const,
        expectedSection: 'worth_watching' as const,
        expectedStatePhrase: 'follow-up is already scheduled',
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const chatJid = `bb:iMessage;-;+1555000${testCase.suffix}`;
      const timestamp = `2026-04-15T16:1${index}:00.000Z`;
      storeChatMetadata(
        chatJid,
        timestamp,
        testCase.label,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `state-initial-${testCase.suffix}`,
        chat_jid: chatJid,
        sender: `bb:+1555000${testCase.suffix}`,
        sender_name: testCase.label,
        content: 'Can you confirm the original plan?',
        timestamp,
        is_from_me: false,
      });
    }

    const initialReview = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const initialSeed = parseRecentTextReviewSeedJson(
      buildRecentTextReviewSeedJson(initialReview),
    )!;
    for (const [index, testCase] of cases.entries()) {
      const item = initialSeed.items.find(
        (candidate) => candidate.chatLabel === testCase.label,
      )!;
      expect(
        recordRecentTextReviewOutcome({
          groupFolder: 'main',
          item,
          outcome: testCase.outcome,
          now: new Date(`2026-04-15T17:0${index + 1}:00.000Z`),
          timingHint: testCase.outcome === 'reminded' ? 'tonight' : null,
        }),
      ).toBe(true);
    }

    const scheduledBefore = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((thread) => thread.title === 'Scheduled thread');
    expect(scheduledBefore).toBeTruthy();
    upsertCommunicationThread({
      ...scheduledBefore!,
      followupDueAt: '2026-04-15T21:00:00.000Z',
      trackingMode: 'manual_only',
      updatedAt: '2026-04-15T17:04:00.000Z',
    });

    const sameActivityReview = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:10:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const sameActivityThreads = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    });
    for (const testCase of cases) {
      const item = sameActivityReview.items.find(
        (candidate) => candidate.chatLabel === testCase.label,
      );
      const thread = sameActivityThreads.find(
        (candidate) => candidate.title === testCase.label,
      );
      expect(item?.section).toBe(testCase.expectedSection);
      expect(item?.summaryText).toContain(testCase.expectedStatePhrase);
      expect(item?.whyText).toContain('no newer Messages activity');
      expect(thread).toMatchObject({
        followupState: testCase.expectedState,
        lastMessageId: `state-initial-${testCase.suffix}`,
      });
    }
    expect(
      sameActivityThreads.find((thread) => thread.title === 'Scheduled thread'),
    ).toMatchObject({
      followupState: 'scheduled',
      urgency: 'tonight',
      followupDueAt: '2026-04-15T21:00:00.000Z',
      suggestedNextAction: 'create_reminder',
      trackingMode: 'manual_only',
    });

    for (const [index, testCase] of cases.entries()) {
      const chatJid = `bb:iMessage;-;+1555000${testCase.suffix}`;
      const timestamp = `2026-04-15T17:2${index}:00.000Z`;
      storeChatMetadata(
        chatJid,
        timestamp,
        testCase.label,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `state-newer-${testCase.suffix}`,
        chat_jid: chatJid,
        sender: `bb:+1555000${testCase.suffix}`,
        sender_name: testCase.label,
        content: 'Can you confirm the updated plan?',
        timestamp,
        is_from_me: false,
      });
    }

    const newerActivityReview = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T18:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const reopenedThreads = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    });
    for (const testCase of cases) {
      expect(
        newerActivityReview.items.find(
          (candidate) => candidate.chatLabel === testCase.label,
        )?.section,
      ).toBe('needs_reply');
      expect(
        reopenedThreads.find((thread) => thread.title === testCase.label),
      ).toMatchObject({
        followupState: 'reply_needed',
        lastMessageId: `state-newer-${testCase.suffix}`,
      });
    }
  });

  it('does not reopen a newer handled thread when reviewing an older historical window', async () => {
    const chatJid = 'bb:iMessage;-;+15550004409';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Historical window thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'historical-window-older',
      chat_jid: chatJid,
      sender: 'bb:+15550004409',
      sender_name: 'Historical window thread',
      content: 'Can you confirm the earlier plan?',
      timestamp: '2026-04-14T16:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'historical-window-newer',
      chat_jid: chatJid,
      sender: 'bb:+15550004409',
      sender_name: 'Historical window thread',
      content: 'Can you confirm the current plan?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const currentReview = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const currentItem = parseRecentTextReviewSeedJson(
      buildRecentTextReviewSeedJson(currentReview),
    )!.items[0]!;
    expect(
      recordRecentTextReviewOutcome({
        groupFolder: 'main',
        item: currentItem,
        outcome: 'handled',
        now: new Date('2026-04-15T17:01:00.000Z'),
      }),
    ).toBe(true);

    const historicalReview = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:10:00.000Z'),
      timeWindowKind: 'yesterday',
      cloudAnalysisMode: 'disabled',
    });
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === chatJid);

    expect(historicalReview.items[0]).toMatchObject({
      section: 'no_reply_needed',
      latestMessageId: 'historical-window-older',
    });
    expect(historicalReview.items[0]?.summaryText).toContain(
      'marked this handled',
    );
    expect(thread).toMatchObject({
      followupState: 'resolved',
      lastMessageId: 'historical-window-newer',
      lastContactAt: '2026-04-15T16:10:00.000Z',
    });
  });

  it('records stale and unbound blocks as audit signals without changing canonical thread state', async () => {
    const chatJid = 'bb:iMessage;-;+15550004410';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Audit-only thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'audit-only-initial',
      chat_jid: chatJid,
      sender: 'bb:+15550004410',
      sender_name: 'Audit-only thread',
      content: 'Can you confirm the plan?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = parseRecentTextReviewSeedJson(
      buildRecentTextReviewSeedJson(review),
    )!.items[0]!;
    expect(
      recordRecentTextReviewOutcome({
        groupFolder: 'main',
        item,
        outcome: 'handled',
        now: new Date('2026-04-15T17:01:00.000Z'),
      }),
    ).toBe(true);
    const before = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((thread) => thread.channelChatJid === chatJid)!;

    for (const [index, outcome] of (
      ['blocked_stale', 'blocked_unbound'] as const
    ).entries()) {
      expect(
        recordRecentTextReviewOutcome({
          groupFolder: 'main',
          item,
          outcome,
          now: new Date(`2026-04-15T17:0${index + 2}:00.000Z`),
        }),
      ).toBe(true);
    }

    const after = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((thread) => thread.channelChatJid === chatJid)!;
    expect(after).toMatchObject({
      followupState: before.followupState,
      urgency: before.urgency,
      suggestedNextAction: before.suggestedNextAction,
      updatedAt: before.updatedAt,
    });
    const blockedSignals = listCommunicationSignalsForThread(after.id).filter(
      (signal) => signal.summaryText.includes('blocked_'),
    );
    expect(blockedSignals).toHaveLength(2);
    expect(blockedSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          followupState: 'resolved',
          suggestedAction: 'ignore',
        }),
      ]),
    );
  });

  it('records recent text review outcomes with the source channel of the communication thread', async () => {
    const telegramChatJid = 'tg:signal-thread';
    storeChatMetadata(
      telegramChatJid,
      '2026-04-15T16:30:00.000Z',
      'Signal Thread',
      'telegram',
      false,
    );
    storeMessage({
      id: 'review-signal-telegram-1',
      chat_jid: telegramChatJid,
      sender: 'tg:signal-thread',
      sender_name: 'Signal Thread',
      content: 'Can you confirm if you got this?',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });

    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = review.items.find(
      (candidate) => candidate.chatJid === telegramChatJid,
    );
    if (!item) {
      throw new Error('expected telegram review item in seed');
    }
    expect(
      recordRecentTextReviewOutcome({
        groupFolder: 'main',
        item,
        outcome: 'handled',
        now: new Date('2026-04-15T17:10:00.000Z'),
      }),
    ).toBe(true);
    const thread = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 20,
    }).find((candidate) => candidate.channelChatJid === telegramChatJid);
    if (!thread) {
      throw new Error('expected telegram communication thread');
    }
    const signal = listCommunicationSignalsForThread(thread.id).at(0);
    expect(signal?.sourceChannel).toBe('telegram');
  });

  it('preserves group participant identity without assuming an unaddressed question is owner-owed', async () => {
    const now = '2026-04-15T17:00:00.000Z';
    const chatJid = 'bb:iMessage;+;band-chat';
    upsertProfileSubject({
      id: 'subject-group-alex',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'alex',
      displayName: 'Alex',
      createdAt: now,
      updatedAt: now,
    });
    upsertLifeThread({
      id: 'life-group-alex',
      groupFolder: 'main',
      title: 'Alex band planning',
      category: 'work',
      status: 'active',
      scope: 'work',
      relatedSubjectIds: ['subject-group-alex'],
      contextTags: [],
      summary: 'Band planning with Alex.',
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
    upsertCommunicationThread({
      id: 'comm-group-stale-person-link',
      groupFolder: 'main',
      title: 'Pops of Punk',
      linkedSubjectIds: ['subject-group-alex'],
      linkedLifeThreadIds: ['life-group-alex'],
      channel: 'bluebubbles',
      channelChatJid: chatJid,
      lastInboundSummary: null,
      lastOutboundSummary: null,
      followupState: 'unknown',
      urgency: 'none',
      followupDueAt: null,
      suggestedNextAction: null,
      toneStyleHints: ['warm'],
      lastContactAt: now,
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    });
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'group-question-1',
      chat_jid: chatJid,
      sender: 'bb:+15550009999',
      sender_name: 'Alex',
      content: 'Can you confirm the set list before tonight?',
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
      (candidate) => candidate.chatJid === chatJid,
    );

    expect(item).toMatchObject({
      chatLabel: 'Pops of Punk',
      isGroup: true,
      section: 'worth_watching',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
    });
    expect(item?.riskFlags).toContain('group_chat_confirm_audience');
    expect(item?.riskFlags).toContain('group_question_audience_unclear');
    expect(item?.riskFlags).not.toContain('needs_owner_answer');
    expect(item?.summaryText).toContain('Alex:');
    expect(item?.summaryText).toContain('intended responder is unclear');
    expect(item?.evidenceSnippets).toContain(
      'Alex: Can you confirm the set list before tonight?',
    );
    expect(item?.recommendedAction).toContain(
      'not assumed to be assigned to you',
    );
    expect(item?.suggestedReply).toBeNull();
    expect(
      listCommunicationThreadsForGroup({
        groupFolder: 'main',
        includeDisabled: false,
        limit: 20,
      }).find((thread) => thread.id === 'comm-group-stale-person-link'),
    ).toMatchObject({
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
    });
    expect(
      formatRecentTextReviewReply({ result, channel: 'telegram' }),
    ).toContain('group chat - draft only');
  });

  it('recognizes a group question that explicitly replies to the owner', async () => {
    const chatJid = 'bb:iMessage;+;explicit-owner-group-question';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Planning group',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'explicit-owner-group-context',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'I posted the current running order above.',
      timestamp: '2026-04-15T16:09:00.000Z',
      is_from_me: true,
    });
    storeMessage({
      id: 'explicit-owner-group-question',
      chat_jid: chatJid,
      sender: 'alex-participant',
      sender_name: 'Alex',
      content: 'Can you confirm the final order?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
      reply_to_id: 'explicit-owner-group-context',
    });

    const result = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const item = result.items.find(
      (candidate) => candidate.chatJid === chatJid,
    );

    expect(item).toMatchObject({ section: 'needs_reply', isGroup: true });
    expect(item?.riskFlags).toContain('needs_owner_answer');
    expect(item?.riskFlags).not.toContain('group_question_audience_unclear');
    expect(item?.summaryText).toContain('Alex:');
    expect(item?.whyText).toContain('explicitly directed to you');
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
    expect(followup && isBoundRecentTextReviewItemFollowup(followup)).toBe(
      true,
    );
    if (followup && isBoundRecentTextReviewItemFollowup(followup)) {
      expect(followup.item).toMatchObject({
        itemId: visibleItem.itemId,
        rank: visibleItem.rank,
        communicationThreadId: visibleItem.communicationThreadId,
      });
    }
  });

  it('reports full classified-conversation coverage within the bounded local snapshot', async () => {
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
    expect(formatted).toContain(
      '15 conversations with in-window activity classified',
    );
    expect(formatted).toContain(
      'Sync completeness was not independently verified',
    );
    expect(formatted).toContain('newest 120 in-window messages');
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
        {
          itemId: 'review-4',
          rank: 4,
          section: 'no_reply_needed',
          chatJid: 'bb:four',
          chatLabel: 'Closed loop',
          summaryText: 'The request was already handled.',
          whyText: 'no reply is owed',
          recommendedAction: 'No action.',
        },
        {
          itemId: 'review-5',
          rank: 5,
          section: 'needs_reply',
          chatJid: 'bb:five',
          chatLabel: 'Risky answer',
          summaryText: 'They asked for a decision only the owner can make.',
          whyText: 'needs an owner answer',
          recommendedAction: 'Provide the answer first.',
          riskFlags: ['needs_owner_answer'],
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
    const whyOne = parseRecentTextReviewItemFollowup({
      seedJson,
      userText: 'why #1',
    });
    expect(whyOne && isBoundRecentTextReviewItemFollowup(whyOne)).toBe(true);
    if (whyOne && isBoundRecentTextReviewItemFollowup(whyOne)) {
      expect(formatRecentTextReviewItemWhyReply(whyOne.item)).toContain(
        'asks for an answer',
      );
    }
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
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: '2' }),
    ).toMatchObject({ kind: 'draft', item: { rank: 2 } });
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: '4' }),
    ).toBeNull();
    expect(
      parseRecentTextReviewItemFollowup({ seedJson, userText: '5' }),
    ).toBeNull();
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'draft #5',
      }),
    ).toMatchObject({ kind: 'draft', item: { rank: 5 } });
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
    const whyThat = parseRecentTextReviewItemFollowup({
      seedJson,
      userText: 'why that',
    });
    expect(whyThat && isBoundRecentTextReviewItemFollowup(whyThat)).toBe(true);
    if (whyThat && isBoundRecentTextReviewItemFollowup(whyThat)) {
      expect(formatRecentTextReviewItemWhyReply(whyThat.item)).toContain(
        'asks for an answer',
      );
    }
    expect(
      buildReviewDraftPrompt({ seedJson, userText: 'make it warmer' })?.text,
    ).toContain('Starting suggestion');
  });

  it('binds unique person-name follow-ups and fail-closes ambiguous names', () => {
    const seedJson = JSON.stringify({
      version: 1,
      items: [
        {
          itemId: 'review-1',
          rank: 1,
          section: 'needs_reply',
          chatLabel: 'Candace',
          summaryText: 'Candace asked whether dinner still works tonight.',
          whyText: 'asks for an answer',
          recommendedAction: 'Draft a reply.',
        },
        {
          itemId: 'review-2',
          rank: 2,
          section: 'needs_reply',
          chatLabel: 'Alex Rivera',
          summaryText: 'Alex asked for a set list update.',
          whyText: 'latest message from them',
          recommendedAction: 'Draft a reply.',
        },
        {
          itemId: 'review-3',
          rank: 3,
          section: 'worth_watching',
          chatLabel: 'Alex Chen',
          summaryText: 'Alex mentioned a loose follow-up.',
          whyText: 'worth keeping visible',
          recommendedAction: 'Set a reminder if useful.',
        },
        {
          itemId: 'review-4',
          rank: 4,
          section: 'needs_reply',
          chatLabel: 'Annie',
          summaryText: 'Annie asked about pickup.',
          whyText: 'asks for an answer',
          recommendedAction: 'Draft a reply.',
        },
      ],
    });

    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'draft Candace',
      }),
    ).toMatchObject({
      kind: 'draft',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'reply to Candace',
      }),
    ).toMatchObject({
      kind: 'draft',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'draft a reply to Candace',
      }),
    ).toMatchObject({
      kind: 'draft',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'remind me about Candace tonight',
      }),
    ).toMatchObject({
      kind: 'remind',
      timingHint: 'tonight',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'skip Candace',
      }),
    ).toMatchObject({
      kind: 'skip',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'why Candace',
      }),
    ).toMatchObject({
      kind: 'why',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'mark Candace handled',
      }),
    ).toMatchObject({
      kind: 'handled',
      item: { rank: 1, chatLabel: 'Candace' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'draft Alex Rivera',
      }),
    ).toMatchObject({
      kind: 'draft',
      item: { rank: 2, chatLabel: 'Alex Rivera' },
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'draft Alex',
      }),
    ).toMatchObject({
      kind: 'ambiguous_name',
      query: 'alex',
      candidates: [
        { rank: 2, chatLabel: 'Alex Rivera' },
        { rank: 3, chatLabel: 'Alex Chen' },
      ],
    });
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'draft Ann',
      }),
    ).toBeNull();
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'send it',
      }),
    ).toBeNull();
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'send it now',
      }),
    ).toBeNull();
    expect(
      parseRecentTextReviewItemFollowup({
        seedJson,
        userText: 'send now',
      }),
    ).toBeNull();
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
