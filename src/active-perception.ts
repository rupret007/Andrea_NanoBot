import type {
  ActivePerceptionAssessment,
  ActivePerceptionSignal,
  PersonalContextPacket,
  PersonalContextPacketItem,
} from './types.js';

const MATCHERS: Record<ActivePerceptionSignal, RegExp> = {
  calendar: /calendar|event|schedule/i,
  open_loops: /open.?loop|thread|follow.?through|reminder|task/i,
  goals: /goal|mission|priority|plan/i,
  messages: /message|telegram|bluebubbles|communication|text/i,
  repository: /repository|repo|git|coding|code/i,
  tools: /tool|integration|service|provider/i,
};

function matchesSignal(
  item: PersonalContextPacketItem,
  signal: ActivePerceptionSignal,
): boolean {
  return MATCHERS[signal].test(
    `${item.source} ${item.citation} ${item.summary}`,
  );
}

export function requiredPerceptionSignals(
  query: string | null | undefined,
): ActivePerceptionSignal[] {
  const text = query || '';
  if (
    /\b(?:code|coding|repo|repository|implement|build|test|debug)\b/i.test(text)
  ) {
    return ['repository', 'tools', 'goals'];
  }
  if (/\b(?:today|daily|morning|evening|schedule|what.*next)\b/i.test(text)) {
    return ['calendar', 'open_loops', 'goals', 'messages'];
  }
  if (/\b(?:plan|priority|mission|goal)\b/i.test(text)) {
    return ['goals', 'open_loops', 'calendar'];
  }
  return [];
}

export function assessActivePerception(params: {
  packet: PersonalContextPacket;
  requiredSignals?: ActivePerceptionSignal[];
  now?: Date;
  maxRefreshRequests?: number;
}): ActivePerceptionAssessment {
  const requiredSignals = Array.from(
    new Set(
      params.requiredSignals || requiredPerceptionSignals(params.packet.query),
    ),
  );
  const freshSignals: ActivePerceptionSignal[] = [];
  const agingSignals: ActivePerceptionSignal[] = [];
  const staleSignals: ActivePerceptionSignal[] = [];
  const missingSignals: ActivePerceptionSignal[] = [];
  const conflictedSignals: ActivePerceptionSignal[] = [];
  const conflictIds = new Set(
    params.packet.conflicts.flatMap((conflict) => conflict.itemIds),
  );

  for (const signal of requiredSignals) {
    const matching = params.packet.items.filter((item) =>
      matchesSignal(item, signal),
    );
    if (matching.length === 0) {
      missingSignals.push(signal);
      continue;
    }
    if (matching.some((item) => conflictIds.has(item.itemId))) {
      conflictedSignals.push(signal);
    }
    if (matching.some((item) => item.freshness === 'fresh')) {
      freshSignals.push(signal);
    } else if (matching.some((item) => item.freshness === 'aging')) {
      agingSignals.push(signal);
    } else {
      staleSignals.push(signal);
    }
  }
  const maxRefresh = Math.max(
    0,
    Math.min(params.maxRefreshRequests ?? 3, requiredSignals.length),
  );
  const refreshRequests = Array.from(
    new Set([...missingSignals, ...staleSignals, ...conflictedSignals]),
  ).slice(0, maxRefresh);
  return {
    assessedAt: (params.now || new Date()).toISOString(),
    requiredSignals,
    freshSignals,
    agingSignals,
    staleSignals,
    missingSignals,
    conflictedSignals,
    refreshRequests,
    bounded: true,
  };
}
