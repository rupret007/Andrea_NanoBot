import { describe, expect, it } from 'vitest';

import {
  ALL_SYNCED_MESSAGES_TARGET,
  parseAllSyncedMessagesSummaryIntent,
  parseRecentTextReviewIntent,
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
