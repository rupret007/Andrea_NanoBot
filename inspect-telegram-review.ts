import { _initTestDatabase, upsertCommunicationThread, storeChatMetadata, storeMessage } from './src/db.ts';
import { reviewRecentTexts } from './src/recent-text-review.ts';
import { executeAssistantCapability } from './src/assistant-capabilities.ts';

async function main() {
  _initTestDatabase();

  upsertCommunicationThread({
    id: 'comm-telegram-review',
    groupFolder: 'main',
    title: 'Olive',
    linkedSubjectIds: [],
    linkedLifeThreadIds: [],
    channel: 'telegram',
    channelChatJid: 'tg:555555501',
    lastInboundSummary: 'Olive asked if we can connect.',
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
  storeChatMetadata('tg:555555501', '2026-04-15T16:00:00.000Z', 'Olive', 'telegram', false);
  storeMessage({
    id: 'review-olive-current',
    chat_jid: 'tg:555555501',
    sender: 'Olive',
    sender_name: 'Olive',
    content: 'Can we connect later this afternoon?',
    timestamp: '2026-04-15T16:00:00.000Z',
    is_from_me: false,
  });

  const review = await reviewRecentTexts({
    groupFolder: 'main',
    now: new Date('2026-04-15T17:00:00.000Z'),
    timeWindowKind: 'today',
    cloudAnalysisMode: 'disabled',
  });
  const seededItem = review.items[0];
  if (!seededItem) throw new Error('expected seeded item');

  const reviewJson = JSON.stringify({
    version: 1,
    reviewedAt: review.reviewedAt,
    windowStartTimestamp: review.window.startTimestamp,
    windowEndTimestamp: review.window.endTimestamp,
    items: [
      {
        ...seededItem,
        itemId: 'review-1',
        rank: 1,
        section: 'needs_reply',
        communicationThreadId: 'comm-telegram-review',
        summaryText: 'Olive asked if we can connect.',
        whyText: 'asks for a response',
        recommendedAction: 'Draft a warmer reply.',
        linkedSubjectIds: [],
        linkedLifeThreadIds: [],
        sourceChannel: 'telegram',
      },
    ],
  });

  const result = await executeAssistantCapability({
    capabilityId: 'communication.draft_reply',
    context: {
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:100000001',
      now: new Date('2026-04-15T17:05:00.000Z'),
      primeMessagesChatHistory: async (chatJid: string) => ({
        chatJid,
        storedCount: 1,
        totalCount: 1,
      }),
      priorSubjectData: {
        activeCapabilityId: 'communication.review_recent_texts',
        recentTextReviewJson: reviewJson,
      },
    },
    input: {
      text: 'make #1 warmer',
      canonicalText: 'make #1 warmer',
    },
  });

  console.log('outcomeKind', result.outcomeMetadata?.outcomeKind);
  console.log('replyText', result.replyText);
  console.log('messageAction', result.messageAction);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
