import type { CompanionHandoffPayload } from './types.js';

type SignatureFlowChannel = 'alexa' | 'telegram' | 'bluebubbles';

const SIGNATURE_SIGNAL_LABELS: Record<string, string> = {
  calendar: 'your calendar',
  reminders: 'reminders',
  life_threads: 'ongoing threads',
  communication_threads: 'open conversations',
  current_work: 'current work',
  household_context: 'home context',
  missions: 'active plans',
  chief_of_staff: 'the strongest pressure in view',
  knowledge_library: 'saved material',
};

function normalizeText(value: string | null | undefined): string {
  return (value || '')
    .replace(/\btoday evening\b/gi, 'tonight')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/, '').trim();
}

function ensureSentence(value: string | null | undefined): string {
  const normalized = normalizeText(value).replace(/[.!?]+$/g, '').trim();
  if (!normalized) return '';
  return `${normalized}.`;
}

function dedupeLines(lines: Array<string | null | undefined>): string[] {
  const next: string[] = [];
  for (const line of lines) {
    const normalized = stripSignatureFlowSystemPrefix(line);
    if (!normalized) continue;
    if (
      next.some(
        (existing) => existing.toLowerCase() === normalized.toLowerCase(),
      )
    ) {
      continue;
    }
    next.push(normalized);
  }
  return next;
}

export function stripSignatureFlowSystemPrefix(
  value: string | null | undefined,
): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';

  return normalized
    .replace(/^(?:conversation carryover|open conversation):\s*/i, '')
    .replace(/^(?:mission carryover|plan carryover|chief-of-staff read):\s*/i, '')
    .replace(/^current work:\s*/i, 'Work: ')
    .replace(/^household:\s*/i, 'At home, ')
    .trim();
}

export function buildSignatureSignalsWhyLine(
  signalsUsed: string[] | null | undefined,
): string | undefined {
  const labels = dedupeLines(
    (signalsUsed || []).map(
      (signal) =>
        SIGNATURE_SIGNAL_LABELS[signal] || signal.replace(/_/g, ' '),
    ),
  );

  if (labels.length === 0) return undefined;
  if (labels.length === 1) {
    return `This came from ${labels[0]}.`;
  }
  if (labels.length === 2) {
    return `This came from ${labels[0]} and ${labels[1]}.`;
  }
  return `This came from ${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}.`;
}

function normalizeActionText(value: string | null | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  return normalized
    .replace(/^suggestion:\s*/i, '')
    .replace(/^next:\s*/i, '')
    .trim();
}

function formatLabelLine(label: string, value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return `${label}: ${ensureSentence(normalized)}`;
}

export function buildSignatureFlowText(input: {
  lead: string;
  detailLines?: Array<string | null | undefined>;
  bodyText?: string | null;
  nextAction?: string | null;
  whyLine?: string | null;
}): string {
  const lead = normalizeText(input.lead);
  const nextAction = normalizeActionText(input.nextAction);
  const bodyText = input.bodyText?.trim();
  const detailLines = dedupeLines(input.detailLines || []).filter((line) => {
    const normalizedLine = normalizeText(line);
    if (!normalizedLine) return false;
    return normalizedLine.toLowerCase() !== lead.toLowerCase();
  });
  const lines: string[] = [];

  if (lead) lines.push(lead);
  if (bodyText) {
    const normalizedBody = normalizeText(bodyText);
    if (
      normalizedBody &&
      normalizedBody.toLowerCase() !== lead.toLowerCase() &&
      !normalizedBody.toLowerCase().startsWith(lead.toLowerCase())
    ) {
      lines.push('', bodyText.trim());
    }
  } else if (detailLines.length > 0) {
    lines.push('', ...detailLines.slice(0, 3));
  }

  const nextLine = formatLabelLine('Next', nextAction);
  const whyLine = formatLabelLine('Why this came up', input.whyLine);
  if (nextLine) {
    lines.push('', nextLine);
  }
  if (whyLine) {
    lines.push(whyLine);
  }

  return lines.filter(Boolean).join('\n').trim();
}

export function buildSignatureFlowPayload(input: {
  title: string;
  lead: string;
  detailLines?: Array<string | null | undefined>;
  bodyText?: string | null;
  nextAction?: string | null;
  whyLine?: string | null;
  followupSuggestions?: string[];
  sourceSummary?: string | null;
}): CompanionHandoffPayload {
  return {
    kind: 'message',
    title: normalizeText(input.title) || 'Andrea follow-up',
    text: buildSignatureFlowText({
      lead: input.lead,
      detailLines: input.detailLines,
      bodyText: input.bodyText,
      nextAction: input.nextAction,
      whyLine: input.whyLine,
    }),
    sourceSummary: normalizeText(input.sourceSummary) || undefined,
    followupSuggestions: dedupeLines(input.followupSuggestions || []).slice(0, 3),
  };
}

export function buildSignaturePostActionConfirmation(input: {
  channel: SignatureFlowChannel;
  didWhat: string;
  stillOpen?: string | null;
  nextSuggestion?: string | null;
}): string {
  const didWhat = ensureSentence(input.didWhat);
  const stillOpen = normalizeText(input.stillOpen);
  const nextSuggestion = normalizeActionText(input.nextSuggestion);

  if (input.channel === 'alexa') {
    return [
      didWhat,
      stillOpen ? `The open piece is ${stripTrailingPunctuation(stillOpen)}.` : null,
      nextSuggestion
        ? `If you want, I can ${stripTrailingPunctuation(nextSuggestion).replace(/^(?:i can|you can)\s+/i, '')}.`
        : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    didWhat,
    stillOpen ? `Still open: ${ensureSentence(stillOpen)}` : null,
    nextSuggestion ? `Next: ${ensureSentence(nextSuggestion)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
