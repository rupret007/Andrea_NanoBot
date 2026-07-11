import { describe, expect, it } from 'vitest';

import {
  assessActivePerception,
  requiredPerceptionSignals,
} from './active-perception.js';
import type { PersonalContextPacket } from './types.js';

function packet(): PersonalContextPacket {
  return {
    packetId: 'packet-1',
    generatedAt: '2026-07-11T12:00:00.000Z',
    groupFolder: 'main',
    query: 'What should I do today?',
    items: [
      {
        itemId: 'calendar-1',
        source: 'calendar',
        summary: 'Calendar is current.',
        confidence: 1,
        freshness: 'fresh',
        citation: 'calendar:event-1',
      },
      {
        itemId: 'goal-1',
        source: 'goal',
        summary: 'Ship the current mission.',
        confidence: 0.9,
        freshness: 'stale',
        citation: 'context-graph:goal-1',
      },
    ],
    conflicts: [],
    citations: ['calendar:event-1', 'context-graph:goal-1'],
    sourcePolicies: [],
    privacy: {
      localFirst: true,
      rawMessagesStored: false,
      derivedFactsOnly: true,
      boundedItems: 2,
    },
  };
}

describe('bounded active perception', () => {
  it('selects only missing, stale, or conflicted signals for refresh', () => {
    const result = assessActivePerception({ packet: packet() });
    expect(result.freshSignals).toContain('calendar');
    expect(result.staleSignals).toContain('goals');
    expect(result.refreshRequests).toEqual(['open_loops', 'goals', 'messages']);
    expect(result.bounded).toBe(true);
  });

  it('uses a repository-specific signal set for coding work', () => {
    expect(requiredPerceptionSignals('Implement and test this repo')).toEqual([
      'repository',
      'tools',
      'goals',
    ]);
  });
});
