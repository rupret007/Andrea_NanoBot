import { describe, expect, it } from 'vitest';

import {
  ALL_SYNCED_MESSAGES_TARGET,
  parseAllSyncedMessagesSummaryIntent,
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
});
