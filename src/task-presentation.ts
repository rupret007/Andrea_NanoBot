export function formatOpaqueTaskId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-6)}`;
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatHumanTaskStatus(
  status: string | null | undefined,
): string {
  const normalized = (status || '').trim().toLowerCase();
  if (!normalized) return 'Unknown';

  if (
    normalized === 'queued' ||
    normalized === 'creating' ||
    normalized === 'pending'
  ) {
    return 'Queued';
  }
  if (
    normalized === 'running' ||
    normalized === 'working' ||
    normalized === 'in_progress' ||
    normalized === 'in progress'
  ) {
    return 'Working';
  }
  if (
    normalized === 'finished' ||
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'success'
  ) {
    return 'Done';
  }
  if (
    normalized === 'stopped' ||
    normalized === 'cancelled' ||
    normalized === 'canceled'
  ) {
    return 'Stopped';
  }
  if (
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'errored'
  ) {
    return 'Needs attention';
  }

  return toTitleCase(normalized.replace(/[_-]+/g, ' '));
}

export function formatSystemStatus(status: string | null | undefined): string {
  const trimmed = (status || '').trim();
  return trimmed || 'unknown';
}
