import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listPersonalMemoryFacts,
} from './db.js';
import {
  buildPersonalContextPacket,
  getPersonalMemoryPolicies,
  reviewPersonalMemoryFact,
  setPersonalMemoryPolicy,
  stagePersonalMemoryFact,
} from './personal-context-packet.js';
import { buildCognitiveWorldSnapshot } from './cognitive-executive.js';

describe('personal context packet', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('requires per-source opt-in and revokes derived facts with the source', () => {
    expect(() =>
      stagePersonalMemoryFact({
        groupFolder: 'main',
        source: 'telegram',
        sourceRef: 'message:private-id',
        subjectKey: 'preference:coffee',
        valueSummary: 'Prefers decaf after lunch.',
        confidence: 0.8,
      }),
    ).toThrow('not opted in');

    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'telegram',
      enabled: true,
      retentionDays: 30,
    });
    const fact = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'telegram',
      sourceRef: 'message:private-id',
      subjectKey: 'preference:coffee',
      valueSummary: 'Prefers decaf after lunch.',
      confidence: 0.8,
    });
    expect(fact.sourceRef).not.toContain('private-id');

    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'telegram',
      enabled: false,
    });
    expect(listPersonalMemoryFacts({ groupFolder: 'main' })[0]?.status).toBe(
      'revoked',
    );
    expect(
      getPersonalMemoryPolicies('main').find(
        (policy) => policy.source === 'telegram',
      )?.enabled,
    ).toBe(false);
  });

  it('expires facts, supports forget, cites retrieval, and surfaces conflicts', async () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'calendar',
      enabled: true,
      retentionDays: 1,
      now,
    });
    const oldFact = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'calendar',
      sourceRef: 'event:old',
      subjectKey: 'availability:friday',
      valueSummary: 'Friday afternoon is blocked.',
      confidence: 0.9,
      observedAt: new Date('2026-07-01T12:00:00.000Z'),
    });
    const first = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'calendar',
      sourceRef: 'event:first',
      subjectKey: 'availability:monday',
      valueSummary: 'Monday afternoon is open.',
      confidence: 0.9,
      observedAt: now,
    });
    const second = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'calendar',
      sourceRef: 'event:second',
      subjectKey: 'availability:monday',
      valueSummary: 'Monday afternoon is blocked.',
      confidence: 0.8,
      observedAt: now,
    });
    for (const fact of [first, second]) {
      expect(
        reviewPersonalMemoryFact({
          groupFolder: 'main',
          factId: fact.factId,
          decision: 'accept',
          now,
        }),
      ).toBe(true);
    }
    const semanticScorer = {
      score: vi.fn(async (_query: string, summaries: string[]) =>
        summaries.map((summary) => (summary.includes('Monday') ? 1 : 0)),
      ),
    };
    const packet = await buildPersonalContextPacket({
      groupFolder: 'main',
      query: 'Monday availability',
      now,
      semanticScorer,
    });

    expect(packet.conflicts).toEqual([
      expect.objectContaining({
        subjectKey: 'availability:monday',
        requiresReview: true,
      }),
    ]);
    expect(
      packet.citations.some((citation) => citation.startsWith('calendar:')),
    ).toBe(true);
    expect(packet.privacy.rawMessagesStored).toBe(false);
    const world = buildCognitiveWorldSnapshot({
      groupFolder: 'main',
      personalContextPacket: packet,
      persist: false,
      now,
    });
    const conflictedIds = new Set(
      packet.conflicts.flatMap((conflict) => conflict.itemIds),
    );
    expect(
      world.items.some((item) => item.itemKind === 'personal_context'),
    ).toBe(true);
    expect(
      world.items
        .filter((item) =>
          JSON.parse(item.sourceIdsJson).some((id: string) =>
            conflictedIds.has(id),
          ),
        )
        .every((item) => item.confidence <= 0.45),
    ).toBe(true);
    expect(
      listPersonalMemoryFacts({ groupFolder: 'main' }).find(
        (fact) => fact.factId === oldFact.factId,
      )?.status,
    ).toBe('expired');
    expect(
      reviewPersonalMemoryFact({
        groupFolder: 'main',
        factId: first.factId,
        decision: 'forget',
      }),
    ).toBe(true);
  });
});
