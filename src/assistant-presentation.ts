export type AssistantPresentationChannel =
  | 'telegram'
  | 'bluebubbles'
  | 'alexa'
  | 'cockpit';

export type AssistantPresentationState =
  | 'ready'
  | 'verified'
  | 'stale'
  | 'partial'
  | 'blocked'
  | 'failed';

export interface AssistantPresentationSource {
  label: string;
  checkedAt?: string | null;
  freshness?: 'fresh' | 'stale' | 'unknown';
}

export interface AssistantPresentationAction {
  label: string;
  actionId: string;
  kind: 'primary' | 'secondary' | 'details' | 'approval';
  externalEffect?: boolean;
}

/** A bounded, channel-neutral answer. It intentionally contains no raw records. */
export interface AssistantPresentation {
  kind: string;
  title?: string | null;
  lead: string;
  facts?: string[];
  state?: AssistantPresentationState;
  sources?: AssistantPresentationSource[];
  nextAction?: string | null;
  details?: string[];
  actions?: AssistantPresentationAction[];
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundedFacts(presentation: AssistantPresentation): string[] {
  return (presentation.facts || []).map(clean).filter(Boolean).slice(0, 3);
}

export function renderAssistantPresentation(
  presentation: AssistantPresentation,
  channel: Exclude<AssistantPresentationChannel, 'cockpit'>,
): string {
  const lead = clean(presentation.lead);
  const facts = boundedFacts(presentation);
  const next = presentation.nextAction ? clean(presentation.nextAction) : null;

  if (channel === 'alexa') {
    return [lead, facts[0], next ? `Next, ${next}` : null]
      .filter(Boolean)
      .join(' ');
  }

  if (channel === 'bluebubbles') {
    return [lead, ...facts, next ? `Next: ${next}` : null]
      .filter(Boolean)
      .join('\n');
  }

  return [
    presentation.title ? `*${clean(presentation.title)}*` : null,
    lead,
    ...facts.map((fact) => `• ${fact}`),
    next ? `\n*Next:* ${next}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function primaryPresentationActions(
  presentation: AssistantPresentation,
): AssistantPresentationAction[] {
  const actions = presentation.actions || [];
  const primary = actions
    .filter((action) => action.kind === 'primary')
    .slice(0, 2);
  const details = actions.find((action) => action.kind === 'details');
  return details ? [...primary, details] : primary;
}
