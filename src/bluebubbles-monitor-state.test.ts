import { describe, expect, it } from 'vitest';

import {
  createDefaultBlueBubblesMonitorState,
  reconcileBlueBubblesWebhookCatchUp,
} from './bluebubbles-monitor-state.js';

describe('BlueBubbles monitor state', () => {
  it('clears stale missed-inbound detection after webhook freshness catches up', () => {
    const reconciled = reconcileBlueBubblesWebhookCatchUp({
      ...createDefaultBlueBubblesMonitorState('2026-04-08T12:00:00.000Z'),
      detectionState: 'suspected_missed_inbound',
      detectionDetail:
        'BlueBubbles server saw newer chat activity than Andrea on the webhook side.',
      detectionNextAction: 'Check the webhook target.',
      mostRecentServerSeenAt: '2026-04-08T11:56:30.000Z',
      mostRecentServerSeenChatJid: 'bb:iMessage;-;+14695550123',
      mostRecentWebhookObservedAt: '2026-04-08T11:58:00.000Z',
      mostRecentWebhookObservedChatJid: 'bb:iMessage;-;+14695550123',
      recentEvidence: [
        {
          kind: 'missed_inbound',
          chatJid: 'bb:iMessage;-;+14695550123',
          signature: 'bb:missed-msg-1',
          observedAt: '2026-04-08T11:56:30.000Z',
        },
      ],
    });

    expect(reconciled.detectionState).toBe('healthy');
    expect(reconciled.detectionDetail).toBeNull();
    expect(reconciled.recentEvidence).toEqual([]);
  });
});

