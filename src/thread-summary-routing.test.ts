import { describe, expect, it } from 'vitest';

import {
  ALL_SYNCED_MESSAGES_TARGET,
  parseAllSyncedMessagesSummaryIntent,
  parseRecentTextReviewIntent,
  parseThreadSummaryIntent,
} from './thread-summary-routing.js';

describe('thread summary routing', () => {
  it('recognizes all-synced Messages summary phrasing with a time window', () => {
    expect(
      parseAllSyncedMessagesSummaryIntent('yeah all text messages for today'),
    ).toMatchObject({
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });
    expect(
      parseAllSyncedMessagesSummaryIntent(
        'Ok Andrea can you use blue bubbles and provide a summary of my texts for the past 48 hours',
      ),
    ).toMatchObject({
      canonicalText:
        'summarize all synced text messages from the last 48 hours',
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'last_hours',
        timeWindowValue: 48,
      },
    });
    expect(
      parseAllSyncedMessagesSummaryIntent(
        'Summarize my text messages for today',
      ),
    ).toMatchObject({
      canonicalText: 'summarize all synced text messages from today',
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });
    expect(
      parseAllSyncedMessagesSummaryIntent(
        'Summarize my text messages in Pops of Punk from today',
      ),
    ).toBeNull();
    expect(
      parseThreadSummaryIntent(
        'Summarize my text messages in Pops of Punk from today',
      ),
    ).toMatchObject({
      arguments: {
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'today',
      },
    });
  });

  it('recognizes recent text review phrasing with a time window', () => {
    expect(
      parseRecentTextReviewIntent(
        'review my recent texts from the last 6 hours',
      ),
    ).toMatchObject({
      canonicalText: 'review recent text messages from the last 6 hours',
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'last_hours',
        timeWindowValue: 6,
      },
    });
    expect(
      parseRecentTextReviewIntent('summarize the latest news today'),
    ).toBeNull();
  });
});
