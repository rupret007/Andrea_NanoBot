import { createHash, randomUUID } from 'node:crypto';

import {
  deletePersonalMemoryFact,
  listPersonalMemoryFacts,
  listPersonalMemoryPolicies,
  updatePersonalMemoryFactsForSource,
  upsertPersonalMemoryFact,
  upsertPersonalMemoryPolicy,
} from './db.js';
import {
  buildPersonalContextGraph,
  redactPersonalContextText,
} from './personal-context-graph.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
import { assessActivePerception } from './active-perception.js';
import type {
  PersonalContextPacket,
  PersonalContextPacketItem,
  PersonalMemoryFactRecord,
  PersonalMemoryPolicyRecord,
  PersonalMemorySource,
} from './types.js';

const SOURCES: PersonalMemorySource[] = [
  'telegram',
  'bluebubbles',
  'calendar',
  'saved_material',
];

export interface PersonalContextSemanticScorer {
  score(query: string, summaries: string[]): Promise<number[]>;
}

function sourceCitation(
  source: PersonalMemorySource,
  sourceRef: string,
): string {
  const digest = createHash('sha256')
    .update(sourceRef)
    .digest('hex')
    .slice(0, 16);
  return `${source}:${digest}`;
}

function defaultPolicy(
  groupFolder: string,
  source: PersonalMemorySource,
): PersonalMemoryPolicyRecord {
  return {
    groupFolder,
    source,
    enabled: false,
    allowDerivedFacts: false,
    retentionDays: 90,
    consentedAt: null,
    revokedAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export function getPersonalMemoryPolicies(
  groupFolder: string,
): PersonalMemoryPolicyRecord[] {
  const stored = new Map(
    listPersonalMemoryPolicies(groupFolder).map((policy) => [
      policy.source,
      policy,
    ]),
  );
  return SOURCES.map(
    (source) => stored.get(source) || defaultPolicy(groupFolder, source),
  );
}

export function setPersonalMemoryPolicy(params: {
  groupFolder: string;
  source: PersonalMemorySource;
  enabled: boolean;
  allowDerivedFacts?: boolean;
  retentionDays?: number;
  now?: Date;
}): PersonalMemoryPolicyRecord {
  const now = (params.now || new Date()).toISOString();
  const previous = getPersonalMemoryPolicies(params.groupFolder).find(
    (policy) => policy.source === params.source,
  );
  const record: PersonalMemoryPolicyRecord = {
    groupFolder: params.groupFolder,
    source: params.source,
    enabled: params.enabled,
    allowDerivedFacts:
      params.enabled &&
      (params.allowDerivedFacts ??
        (previous?.consentedAt ? previous.allowDerivedFacts : true)),
    retentionDays: Math.max(
      1,
      Math.min(3650, params.retentionDays ?? previous?.retentionDays ?? 90),
    ),
    consentedAt: params.enabled ? previous?.consentedAt || now : null,
    revokedAt: params.enabled ? null : now,
    updatedAt: now,
  };
  upsertPersonalMemoryPolicy(record);
  if (!params.enabled) {
    updatePersonalMemoryFactsForSource({
      groupFolder: params.groupFolder,
      source: params.source,
      status: 'revoked',
      updatedAt: now,
    });
  }
  return record;
}

export function stagePersonalMemoryFact(params: {
  groupFolder: string;
  source: PersonalMemorySource;
  sourceRef: string;
  subjectKey: string;
  valueSummary: string;
  confidence: number;
  observedAt?: Date;
  citations?: string[];
}): PersonalMemoryFactRecord {
  const policy = getPersonalMemoryPolicies(params.groupFolder).find(
    (candidate) => candidate.source === params.source,
  );
  if (!policy?.enabled || !policy.allowDerivedFacts) {
    throw new Error(`Personal memory source ${params.source} is not opted in.`);
  }
  const observed = params.observedAt || new Date();
  const expiresAt = new Date(
    observed.getTime() + policy.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const citation = sourceCitation(params.source, params.sourceRef);
  const record: PersonalMemoryFactRecord = {
    factId: randomUUID(),
    groupFolder: params.groupFolder,
    source: params.source,
    sourceRef: citation,
    subjectKey: redactPersonalContextText(params.subjectKey).slice(0, 120),
    valueSummary: redactPersonalContextText(params.valueSummary).slice(0, 260),
    confidence: Math.max(0, Math.min(1, params.confidence)),
    status: 'candidate',
    observedAt: observed.toISOString(),
    expiresAt,
    citationsJson: JSON.stringify(
      Array.from(
        new Set([
          citation,
          ...(params.citations || []).map((item) =>
            redactPersonalContextText(item),
          ),
        ]),
      ),
    ),
    createdAt: observed.toISOString(),
    updatedAt: observed.toISOString(),
  };
  upsertPersonalMemoryFact(record);
  return record;
}

export function reviewPersonalMemoryFact(params: {
  groupFolder: string;
  factId: string;
  decision: 'accept' | 'revoke' | 'forget';
  now?: Date;
}): boolean {
  const fact = listPersonalMemoryFacts({
    groupFolder: params.groupFolder,
    limit: 1000,
  }).find((candidate) => candidate.factId === params.factId);
  if (!fact) return false;
  if (params.decision === 'forget')
    return deletePersonalMemoryFact(fact.factId);
  upsertPersonalMemoryFact({
    ...fact,
    status: params.decision === 'accept' ? 'accepted' : 'revoked',
    updatedAt: (params.now || new Date()).toISOString(),
  });
  return true;
}

export function expirePersonalMemoryFacts(params: {
  groupFolder: string;
  now?: Date;
}): number {
  const now = (params.now || new Date()).toISOString();
  let expired = 0;
  for (const fact of listPersonalMemoryFacts({
    groupFolder: params.groupFolder,
    statuses: ['candidate', 'accepted'],
    limit: 1000,
  })) {
    if (fact.expiresAt > now) continue;
    upsertPersonalMemoryFact({ ...fact, status: 'expired', updatedAt: now });
    expired += 1;
  }
  return expired;
}

function lexicalScore(query: string, summary: string): number {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) || []);
  if (!terms.size) return 0.5;
  const textTerms = new Set(summary.toLowerCase().match(/[a-z0-9]{2,}/g) || []);
  let matches = 0;
  for (const term of terms) if (textTerms.has(term)) matches += 1;
  return matches / terms.size;
}

function freshness(updatedAt: string | null | undefined, now: Date) {
  if (!updatedAt) return 'stale' as const;
  const ageDays = (now.getTime() - new Date(updatedAt).getTime()) / 86_400_000;
  return ageDays <= 7
    ? ('fresh' as const)
    : ageDays <= 45
      ? ('aging' as const)
      : ('stale' as const);
}

export async function buildPersonalContextPacket(params: {
  groupFolder: string;
  query?: string;
  limit?: number;
  now?: Date;
  semanticScorer?: PersonalContextSemanticScorer;
}): Promise<PersonalContextPacket> {
  const now = params.now || new Date();
  expirePersonalMemoryFacts({ groupFolder: params.groupFolder, now });
  const policies = getPersonalMemoryPolicies(params.groupFolder);
  const enabledSources = new Set(
    policies.filter((policy) => policy.enabled).map((policy) => policy.source),
  );
  const graph = buildPersonalContextGraph({
    groupFolder: params.groupFolder,
    now,
  });
  const graphItems: PersonalContextPacketItem[] = graph.nodes.map((node) => ({
    itemId: node.nodeId,
    source: node.nodeKind,
    summary: redactPersonalContextText(
      [node.label, node.summary].filter(Boolean).join(': '),
    ),
    confidence: node.status === 'accepted' ? 0.9 : 0.72,
    freshness: freshness(node.updatedAt, now),
    citation: `context-graph:${node.nodeId}`,
  }));
  graphItems.push(
    ...graph.rankedInsights.map((insight) => ({
      itemId: insight.insightId,
      source: `context_insight:${insight.kind}`,
      summary: redactPersonalContextText(
        `${insight.title}: ${insight.reason} Next: ${insight.nextAction}`,
      ),
      confidence: Math.max(0.5, Math.min(0.95, insight.priorityScore)),
      freshness: 'fresh' as const,
      citation: `context-graph:${insight.insightId}`,
    })),
  );
  const derivedItems: PersonalContextPacketItem[] = listPersonalMemoryFacts({
    groupFolder: params.groupFolder,
    statuses: ['accepted'],
    limit: 500,
  })
    .filter(
      (fact) =>
        enabledSources.has(fact.source) && fact.expiresAt > now.toISOString(),
    )
    .map((fact) => ({
      itemId: `derived:${fact.factId}`,
      source: fact.source,
      summary: fact.valueSummary,
      confidence: fact.confidence,
      freshness: freshness(fact.observedAt, now),
      citation: fact.sourceRef,
      subjectKey: fact.subjectKey,
      expiresAt: fact.expiresAt,
    }));
  const items = [...graphItems, ...derivedItems];
  const semanticScores =
    params.query && params.semanticScorer
      ? await params.semanticScorer.score(
          params.query,
          items.map((item) => item.summary),
        )
      : [];
  for (const [index, item] of items.entries()) {
    const lexical = params.query
      ? lexicalScore(params.query, item.summary)
      : 0.5;
    const semantic = semanticScores[index];
    const freshnessBoost =
      item.freshness === 'fresh' ? 0.1 : item.freshness === 'aging' ? 0.04 : 0;
    item.score = Number(
      (
        lexical * 0.5 +
        (Number.isFinite(semantic) ? semantic * 0.3 : lexical * 0.3) +
        item.confidence * 0.2 +
        freshnessBoost
      ).toFixed(3),
    );
  }
  const bySubject = new Map<string, PersonalContextPacketItem[]>();
  for (const item of derivedItems) {
    if (!item.subjectKey) continue;
    const group = bySubject.get(item.subjectKey) || [];
    group.push(item);
    bySubject.set(item.subjectKey, group);
  }
  const conflicts = Array.from(bySubject.entries())
    .filter(
      ([, subjectItems]) =>
        new Set(subjectItems.map((item) => item.summary.toLowerCase())).size >
        1,
    )
    .map(([subjectKey, subjectItems]) => ({
      subjectKey,
      itemIds: subjectItems.map((item) => item.itemId),
      requiresReview: true as const,
    }));
  const bounded = items
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, Math.max(1, Math.min(params.limit || 20, 50)));
  if (params.query) {
    recordAssistantMetric({
      groupFolder: params.groupFolder,
      kind: 'memory_retrieval',
      value: 1,
      now,
    });
    if (bounded.length > 0 && bounded.every((item) => Boolean(item.citation))) {
      recordAssistantMetric({
        groupFolder: params.groupFolder,
        kind: 'retrieval_with_citation',
        value: 1,
        now,
      });
    }
  }
  const packet: PersonalContextPacket = {
    packetId: randomUUID(),
    generatedAt: now.toISOString(),
    groupFolder: params.groupFolder,
    query: params.query || null,
    items: bounded,
    conflicts,
    citations: Array.from(new Set(bounded.map((item) => item.citation))),
    sourcePolicies: policies,
    privacy: {
      localFirst: true,
      rawMessagesStored: false,
      derivedFactsOnly: true,
      boundedItems: bounded.length,
    },
  };
  packet.perception = assessActivePerception({ packet, now });
  return packet;
}
