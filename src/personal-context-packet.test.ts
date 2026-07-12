import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listAssistantMetricEvents,
  listPersonalMemoryFacts,
} from './db.js';
import {
  buildPersonalContextPacket,
  getPersonalMemoryPolicies,
  reviewPersonalMemoryFact,
  setPersonalMemoryPolicy,
  stagePersonalMemoryFact,
} from './personal-context-packet.js';
import { buildAssistantMetricSnapshot } from './personal-assistant-metrics.js';
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
    const retrievalMetrics = listAssistantMetricEvents({
      groupFolder: 'main',
    }).filter((event) =>
      ['memory_retrieval', 'retrieval_with_citation'].includes(event.kind),
    );
    expect(retrievalMetrics).toHaveLength(2);
    expect(
      retrievalMetrics.every((event) => {
        const metadata = JSON.parse(event.metadataJson) as Record<
          string,
          unknown
        >;
        return (
          metadata.metricClass === 'assistant_interaction' &&
          metadata.packetId === packet.packetId &&
          Number(metadata.resultCount) > 0
        );
      }),
    ).toBe(true);
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

  it('records an empty lookup without claiming an uncited result', async () => {
    const packet = await buildPersonalContextPacket({
      groupFolder: 'main',
      query: 'a detail that is not stored',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(packet.items).toHaveLength(0);
    const events = listAssistantMetricEvents({ groupFolder: 'main' });
    const retrieval = events.find((event) => event.kind === 'memory_retrieval');
    expect(retrieval).toBeDefined();
    expect(JSON.parse(retrieval?.metadataJson || '{}')).toMatchObject({
      metricClass: 'assistant_interaction',
      packetId: packet.packetId,
      resultCount: 0,
    });
    expect(
      events.some((event) => event.kind === 'retrieval_with_citation'),
    ).toBe(false);
    expect(buildAssistantMetricSnapshot({ groupFolder: 'main' })).toMatchObject(
      {
        memoryRetrievalSampleCount: 1,
        retrievalCitationCoverage: 0,
        retrievalCitationSampleCount: 0,
      },
    );
  });

  it('fails closed for stopword-only topical queries instead of injecting personal context', async () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'telegram',
      enabled: true,
      now,
    });
    const fact = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'telegram',
      sourceRef: 'message:private-context',
      subjectKey: 'preference:quiet-time',
      valueSummary: 'Prefers quiet time after dinner.',
      confidence: 0.9,
      observedAt: now,
    });
    reviewPersonalMemoryFact({
      groupFolder: 'main',
      factId: fact.factId,
      decision: 'accept',
      now,
    });

    const packet = await buildPersonalContextPacket({
      groupFolder: 'main',
      query: 'who are you?',
      now,
    });

    expect(packet.items).toHaveLength(0);
    expect(packet.citations).toHaveLength(0);
    const retrieval = listAssistantMetricEvents({ groupFolder: 'main' }).find(
      (event) => event.kind === 'memory_retrieval',
    );
    expect(JSON.parse(retrieval?.metadataJson || '{}')).toMatchObject({
      packetId: packet.packetId,
      resultCount: 0,
      rankingMode: 'hybrid_lexical_and_local_concept',
    });
  });

  it('uses deterministic local concepts for natural synonym retrieval without a provider call', async () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'calendar',
      enabled: true,
      now,
    });
    const fact = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'calendar',
      sourceRef: 'event:dentist',
      subjectKey: 'appointment:dentist',
      valueSummary: 'Dentist appointment at 3 PM.',
      confidence: 0.9,
      observedAt: now,
    });
    reviewPersonalMemoryFact({
      groupFolder: 'main',
      factId: fact.factId,
      decision: 'accept',
      now,
    });

    const packet = await buildPersonalContextPacket({
      groupFolder: 'main',
      query: 'what is on my agenda?',
      now,
    });

    expect(packet.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: `derived:${fact.factId}`,
          summary: 'Dentist appointment at 3 PM.',
        }),
      ]),
    );
    expect(packet.citations).toContain(fact.sourceRef);
    const retrieval = listAssistantMetricEvents({ groupFolder: 'main' }).find(
      (event) => event.kind === 'memory_retrieval',
    );
    expect(JSON.parse(retrieval?.metadataJson || '{}')).toMatchObject({
      packetId: packet.packetId,
      rankingMode: 'hybrid_lexical_and_local_concept',
    });
  });

  it('keeps explicit broad personal-memory review bounded and cited', async () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'saved_material',
      enabled: true,
      now,
    });
    const fact = stagePersonalMemoryFact({
      groupFolder: 'main',
      source: 'saved_material',
      sourceRef: 'saved:owner-note',
      subjectKey: 'preference:planning',
      valueSummary: 'Prefers a short written plan before deep work.',
      confidence: 0.85,
      observedAt: now,
    });
    reviewPersonalMemoryFact({
      groupFolder: 'main',
      factId: fact.factId,
      decision: 'accept',
      now,
    });

    const packet = await buildPersonalContextPacket({
      groupFolder: 'main',
      query: 'what do you know about me?',
      limit: 5,
      now,
    });

    expect(packet.items.length).toBeGreaterThan(0);
    expect(packet.items.length).toBeLessThanOrEqual(5);
    expect(packet.citations).toContain(fact.sourceRef);
  });

  it('keeps bounded context for intentionally broad daily-guidance queries', async () => {
    const packet = await buildPersonalContextPacket({
      groupFolder: 'main',
      query: 'what am I forgetting tonight',
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(packet.items.length).toBeGreaterThan(0);
    expect(packet.citations.length).toBeGreaterThan(0);
    const retrieval = listAssistantMetricEvents({
      groupFolder: 'main',
    }).find((event) => event.kind === 'memory_retrieval');
    expect(JSON.parse(retrieval?.metadataJson || '{}')).toMatchObject({
      packetId: packet.packetId,
      resultCount: packet.items.length,
    });
  });
});
