const CURSOR_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,127}$/i;

function stripWrappingPunctuation(value: string): string {
  return value.replace(/^[\s"'`([{<]+|[\s"'`)\]}>.,;:!?]+$/g, '');
}

function extractAgentIdFromUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    const fromQuery =
      parsed.searchParams.get('id') ||
      parsed.searchParams.get('agent_id') ||
      parsed.searchParams.get('agentId');
    if (fromQuery) return fromQuery;

    const match = parsed.pathname.match(/\/agents\/([a-z0-9_-]+)/i);
    if (match?.[1]) return match[1];
    return null;
  } catch {
    return null;
  }
}

export function normalizeCursorAgentId(rawAgentId: string): string {
  const raw = (rawAgentId || '').trim();
  if (!raw) {
    throw new Error('Cursor agent id is required.');
  }

  const stripped = stripWrappingPunctuation(raw);
  const extractedFromUrl = extractAgentIdFromUrl(stripped);
  const normalized = stripWrappingPunctuation(extractedFromUrl || stripped);

  if (!CURSOR_AGENT_ID_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid Cursor agent id "${rawAgentId}". Use an id like bc_abc123 or a Cursor URL that contains ?id=<agent_id>.`,
    );
  }

  return normalized;
}
