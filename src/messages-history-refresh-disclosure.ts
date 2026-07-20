export type MessagesHistoryRefreshMode =
  | 'targeted_succeeded'
  | 'targeted_failed'
  | 'global_succeeded'
  | 'global_failed'
  | 'local_only';

export interface MessagesHistoryRefreshDisclosureInput {
  mode: MessagesHistoryRefreshMode;
  requestedLimit?: number;
  inspectedCount?: number;
  storedCount?: number;
  latestLocalMessageAt?: string | null;
  timeZone: string;
  precedingGlobalDiscovery?: {
    mode: 'global_succeeded' | 'global_failed' | 'local_only';
    requestedLimit?: number;
    inspectedCount?: number;
    storedCount?: number;
  };
}

function formatLocalTimestamp(
  value: string | null | undefined,
  timeZone: string,
): string | null {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date);
}

export function formatMessagesHistoryRefreshDisclosure(
  input: MessagesHistoryRefreshDisclosureInput,
): string {
  const requestedLimit = Math.max(1, input.requestedLimit || 1);
  const inspectedCount = Math.max(0, input.inspectedCount || 0);
  const storedCount = Math.max(0, input.storedCount || 0);
  const latestLocal = formatLocalTimestamp(
    input.latestLocalMessageAt,
    input.timeZone,
  );

  const refreshLine =
    input.mode === 'targeted_succeeded'
      ? `History refresh: Targeted refresh succeeded for one exact known Messages thread; ${inspectedCount} bounded provider row${inspectedCount === 1 ? '' : 's'} inspected and ${storedCount} new local row${storedCount === 1 ? '' : 's'} stored.`
      : input.mode === 'targeted_failed'
        ? 'History refresh: Targeted refresh failed, so this answer uses the existing local snapshot only.'
        : input.mode === 'global_succeeded'
          ? `History refresh: Global refresh succeeded; ${inspectedCount} bounded provider row${inspectedCount === 1 ? '' : 's'} inspected and ${storedCount} new local row${storedCount === 1 ? '' : 's'} stored.`
          : input.mode === 'global_failed'
            ? 'History refresh: Global refresh failed, so this answer uses the existing local snapshot only.'
            : 'History refresh: No provider refresh was attempted; this answer uses the existing local snapshot only.';

  const boundsLine = input.mode.startsWith('targeted_')
    ? `Snapshot bounds: The targeted provider read requested at most the newest ${requestedLimit} messages for one already-known exact thread.`
    : input.mode.startsWith('global_')
      ? `Snapshot bounds: The global provider read requested at most the newest ${requestedLimit} messages across chats, so a quiet thread can fall outside that slice.`
      : 'Snapshot bounds: No provider read supplemented the local store for this answer.';

  const discovery = input.precedingGlobalDiscovery;
  const discoveryLine = discovery
    ? discovery.mode === 'global_succeeded'
      ? `Metadata discovery refresh: Before the targeted read, a bounded global refresh succeeded; ${Math.max(0, discovery.inspectedCount || 0)} provider row${Math.max(0, discovery.inspectedCount || 0) === 1 ? '' : 's'} inspected and ${Math.max(0, discovery.storedCount || 0)} new local row${Math.max(0, discovery.storedCount || 0) === 1 ? '' : 's'} stored.`
      : discovery.mode === 'global_failed'
        ? 'Metadata discovery refresh: The global refresh attempted before the targeted read failed.'
        : 'Metadata discovery refresh: No provider-backed global discovery refresh was available before the targeted read.'
    : null;
  const discoveryBounds = discovery
    ? `The preceding global discovery read was bounded to at most the newest ${Math.max(1, discovery.requestedLimit || 1)} messages across chats, so a quiet thread could have fallen outside that slice.`
    : null;

  return [
    refreshLine,
    discoveryLine,
    latestLocal
      ? `Newest eligible local Messages item: ${latestLocal}.`
      : 'Newest eligible local Messages item: none found.',
    `${boundsLine}${discoveryBounds ? ` ${discoveryBounds}` : ''} Provider and local sync completeness were not independently verified.`,
  ]
    .filter((line): line is string => Boolean(line))
    .join(' ');
}
