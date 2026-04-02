function normalizeSmartQuotes(message: string): string {
  return message
    .replace(/[â€™â€˜]/g, "'")
    .replace(/[â€œâ€]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export function normalizeVoicePrompt(message: string): string {
  let normalized = normalizeSmartQuotes(message).trim();
  if (!normalized) return '';

  const leadingPatterns = [
    /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|please)[,!. ]+)*/i,
    /^(?:andrea)[,!. ]+/i,
    /^(?:(?:can|could|would|will)\s+you)\s+/i,
    /^(?:real quick|quickly)\b[,!. ]*/i,
  ];

  let previous = '';
  while (normalized && normalized !== previous) {
    previous = normalized;
    for (const pattern of leadingPatterns) {
      normalized = normalized.replace(pattern, '').trim();
    }
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

export function buildVoiceReply(input: {
  summary: string;
  details?: Array<string | null | undefined>;
  honesty?: string | null;
  offerMore?: boolean;
  maxDetails?: number;
}): string {
  const summary = normalizeSmartQuotes(input.summary).trim();
  const details: string[] = [];
  const maxDetails = input.maxDetails ?? 2;

  for (const detail of input.details || []) {
    const normalized = normalizeSmartQuotes(detail || '').trim();
    if (!normalized) continue;
    if (normalized === summary) continue;
    if (details.includes(normalized)) continue;
    if (details.length >= maxDetails) break;
    details.push(normalized);
  }

  const lines = [summary, ...details];
  if (input.offerMore) {
    lines.push('I can list the rest if you want.');
  }
  if (input.honesty?.trim()) {
    lines.push(normalizeSmartQuotes(input.honesty).trim());
  }
  return lines.join('\n');
}

export function formatVoiceChoicePrompt(input: {
  question: string;
  choices: string[];
  directForTwo?: boolean;
  prefixForTwo?: string;
  replyHint?: string | null;
}): string {
  const choices = input.choices
    .map((choice) => normalizeSmartQuotes(choice).trim())
    .filter(Boolean)
    .slice(0, 3);
  if (choices.length === 0) {
    return normalizeSmartQuotes(input.question).trim();
  }

  if (input.directForTwo && choices.length === 2) {
    const prefix =
      normalizeSmartQuotes(input.prefixForTwo || '').trim() ||
      normalizeSmartQuotes(input.question).trim();
    return `${prefix} ${choices[0]} or ${choices[1]}?`;
  }

  return [
    normalizeSmartQuotes(input.question).trim(),
    ...choices.map((choice, index) => `${index + 1}. ${choice}`),
    ...(input.replyHint ? [normalizeSmartQuotes(input.replyHint).trim()] : []),
  ].join('\n');
}
