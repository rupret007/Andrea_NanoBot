import type { BackendJobHandle, BackendLaneId } from './backend-lanes/types.js';
import type { CursorAgentView, CursorJobInventory } from './cursor-jobs.js';
import {
  getCursorMessageContext,
  getCursorOperatorContext,
  storeCursorMessageContext,
  upsertCursorOperatorContext,
} from './db.js';
import { normalizeCursorAgentId } from './cursor-agent-id.js';
import {
  formatShellTaskCard,
  formatHumanTaskStatus,
  formatOpaqueTaskId,
} from './task-presentation.js';
import type { ChannelInlineAction } from './types.js';

const CURSOR_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTEXT_GUIDANCE_BY_LANE: Record<BackendLaneId, string> = {
  cursor:
    'Open `/cursor`, then tap `Jobs` or `Current Job` and reply to a task card. `/cursor-jobs` still works when you want an explicit fallback.',
  andrea_runtime:
    'Open `/cursor` -> `Codex/OpenAI` -> `Recent Work`, then reply to a task card. `/runtime-jobs`, list numbers, and `current` still work as explicit fallbacks.',
};
const CURSOR_LANE_ID: BackendLaneId = 'cursor';

export type CursorJobBucket =
  | 'cloudTracked'
  | 'desktopTracked'
  | 'cloudRecoverable'
  | 'desktopRecoverable';

export interface CursorListSnapshotItem {
  laneId: BackendLaneId;
  id: string;
  provider?: 'cloud' | 'desktop' | null;
}

export interface FlattenedCursorJobEntry extends CursorAgentView {
  laneId: BackendLaneId;
  bucket: CursorJobBucket;
  ordinal: number;
}

export interface ResolvedCursorTarget {
  laneId: BackendLaneId;
  handle: BackendJobHandle;
  agentId: string;
  via: 'explicit' | 'ordinal' | 'current' | 'reply' | 'selected';
}

export interface CursorTargetResolutionResult {
  target: ResolvedCursorTarget | null;
  failureMessage: string | null;
}

export interface ActiveCursorMessageContext {
  chatJid: string;
  platformMessageId: string;
  threadId?: string;
  contextKind: string;
  laneId: BackendLaneId;
  agentId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SelectedJobsByLane {
  cursor?: string | null;
  andrea_runtime?: string | null;
}

export interface ActiveCursorOperatorContext {
  chatJid: string;
  threadId?: string;
  selectedLaneId: BackendLaneId | null;
  selectedAgentId: string | null;
  selectedJobsByLane: SelectedJobsByLane | null;
  lastListSnapshotsByLane: Partial<
    Record<BackendLaneId, CursorListSnapshotItem[]>
  > | null;
  lastListSnapshot: CursorListSnapshotItem[] | null;
  lastListMessageId: string | null;
  dashboardMessageId: string | null;
  updatedAt: string;
}

function isFreshTimestamp(timestamp: string | null | undefined): boolean {
  return isFreshTimestampAt(timestamp, new Date().toISOString());
}

function isFreshTimestampAt(
  timestamp: string | null | undefined,
  nowIso: string,
): boolean {
  if (!timestamp) return false;
  const createdAt = Date.parse(timestamp);
  if (!Number.isFinite(createdAt)) return false;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return false;
  return now - createdAt <= CURSOR_CONTEXT_TTL_MS;
}

function parseSnapshotItems(parsed: unknown): CursorListSnapshotItem[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const laneId =
      row.laneId === 'andrea_runtime' || row.laneId === 'cursor'
        ? row.laneId
        : CURSOR_LANE_ID;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const provider =
      row.provider === 'desktop' || row.provider === 'cloud'
        ? row.provider
        : null;
    if (!id) return [];
    return [{ laneId, id, provider }];
  });
}

function parseSnapshotCollectionJson(
  raw: string | null,
): Partial<Record<BackendLaneId, CursorListSnapshotItem[]>> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        cursor: parseSnapshotItems(parsed),
      };
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const row = parsed as Record<string, unknown>;
    const snapshots: Partial<Record<BackendLaneId, CursorListSnapshotItem[]>> =
      {};
    if ('cursor' in row) {
      snapshots.cursor = parseSnapshotItems(row.cursor);
    }
    if ('andrea_runtime' in row) {
      snapshots.andrea_runtime = parseSnapshotItems(row.andrea_runtime);
    }
    return snapshots;
  } catch {
    return undefined;
  }
}

function parseSnapshotJson(
  raw: string | null,
  laneId: BackendLaneId = CURSOR_LANE_ID,
): CursorListSnapshotItem[] | undefined {
  return parseSnapshotCollectionJson(raw)?.[laneId];
}

function parseSelectedJobsByLaneJson(
  raw: string | null,
): SelectedJobsByLane | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const row = parsed as Record<string, unknown>;
    const selectedJobs: SelectedJobsByLane = {};
    if (typeof row.cursor === 'string' || row.cursor === null) {
      selectedJobs.cursor = row.cursor as string | null;
    }
    if (typeof row.andrea_runtime === 'string' || row.andrea_runtime === null) {
      selectedJobs.andrea_runtime = row.andrea_runtime as string | null;
    }
    return selectedJobs;
  } catch {
    return undefined;
  }
}

function formatSelectedJobsByLaneJson(
  laneId: BackendLaneId,
  agentId: string | null,
  existingRaw: string | null,
): string | null {
  const selectedJobs = parseSelectedJobsByLaneJson(existingRaw) || {};
  selectedJobs[laneId] = agentId;
  return JSON.stringify(selectedJobs);
}

function formatSnapshotCollectionJson(
  laneId: BackendLaneId,
  items: CursorListSnapshotItem[],
  existingRaw: string | null,
): string {
  const existing = parseSnapshotCollectionJson(existingRaw) || {};
  existing[laneId] = items;
  return JSON.stringify(existing);
}

function getSelectedJobId(
  record:
    | {
        selected_lane_id: string | null;
        selected_agent_id: string | null;
        selected_jobs_by_lane_json: string | null;
      }
    | null
    | undefined,
  laneId: BackendLaneId,
): string | null {
  if (!record) return null;
  const selectedJobs =
    parseSelectedJobsByLaneJson(record.selected_jobs_by_lane_json) || null;
  const selectedByLane =
    laneId === 'andrea_runtime'
      ? selectedJobs?.andrea_runtime
      : selectedJobs?.cursor;
  if (selectedByLane !== undefined) {
    return selectedByLane || null;
  }
  if ((record.selected_lane_id || CURSOR_LANE_ID) === laneId) {
    return record.selected_agent_id;
  }
  return record.selected_agent_id &&
    !record.selected_lane_id &&
    laneId === CURSOR_LANE_ID
    ? record.selected_agent_id
    : null;
}

export function getCursorContextGuidance(): string {
  return CONTEXT_GUIDANCE_BY_LANE.cursor;
}

export function getBackendContextGuidance(
  laneId: BackendLaneId = CURSOR_LANE_ID,
): string {
  return CONTEXT_GUIDANCE_BY_LANE[laneId];
}

export function flattenCursorJobInventory(
  inventory: CursorJobInventory,
): FlattenedCursorJobEntry[] {
  const buckets: Array<[CursorJobBucket, CursorAgentView[]]> = [
    ['cloudTracked', inventory.cloudTracked],
    ['desktopTracked', inventory.desktopTracked],
    ['cloudRecoverable', inventory.cloudRecoverable],
    ['desktopRecoverable', inventory.desktopRecoverable],
  ];

  const flattened: FlattenedCursorJobEntry[] = [];
  for (const [bucket, records] of buckets) {
    for (const record of records) {
      flattened.push({
        ...record,
        laneId: CURSOR_LANE_ID,
        bucket,
        ordinal: flattened.length + 1,
      });
    }
  }
  return flattened;
}

export function rememberCursorOperatorSelection(params: {
  chatJid: string;
  threadId?: string;
  agentId: string;
  laneId?: BackendLaneId;
}): void {
  upsertCursorOperatorContext({
    chatJid: params.chatJid,
    threadId: params.threadId,
    selectedLaneId: params.laneId || CURSOR_LANE_ID,
    selectedAgentId: params.agentId,
    selectedJobsByLaneJson: formatSelectedJobsByLaneJson(
      params.laneId || CURSOR_LANE_ID,
      params.agentId,
      getCursorOperatorContext(params.chatJid, params.threadId)
        ?.selected_jobs_by_lane_json || null,
    ),
  });
}

export function clearSelectedLaneJob(params: {
  chatJid: string;
  threadId?: string;
  laneId: BackendLaneId;
}): void {
  const existing = getCursorOperatorContext(params.chatJid, params.threadId);
  const selectedJobs =
    parseSelectedJobsByLaneJson(existing?.selected_jobs_by_lane_json || null) ||
    {};
  selectedJobs[params.laneId] = null;

  const existingLaneId =
    existing?.selected_lane_id === 'andrea_runtime'
      ? 'andrea_runtime'
      : existing?.selected_lane_id === CURSOR_LANE_ID
        ? CURSOR_LANE_ID
        : null;
  const nextSelectedLaneId =
    existingLaneId === params.laneId ? null : existingLaneId;
  const nextSelectedAgentId = nextSelectedLaneId
    ? (selectedJobs[nextSelectedLaneId] ?? null)
    : null;

  upsertCursorOperatorContext({
    chatJid: params.chatJid,
    threadId: params.threadId,
    selectedLaneId: nextSelectedLaneId,
    selectedAgentId: nextSelectedAgentId,
    selectedJobsByLaneJson: JSON.stringify(selectedJobs),
  });
}

export function rememberCursorDashboardMessage(params: {
  chatJid: string;
  threadId?: string;
  dashboardMessageId: string | null;
  selectedAgentId?: string | null;
  selectedLaneId?: BackendLaneId | null;
}): void {
  const existing = getCursorOperatorContext(params.chatJid, params.threadId);
  const selectedLaneId = params.selectedLaneId || CURSOR_LANE_ID;
  upsertCursorOperatorContext({
    chatJid: params.chatJid,
    threadId: params.threadId,
    selectedLaneId,
    selectedAgentId: params.selectedAgentId,
    selectedJobsByLaneJson:
      params.selectedAgentId === undefined
        ? existing?.selected_jobs_by_lane_json || null
        : formatSelectedJobsByLaneJson(
            selectedLaneId,
            params.selectedAgentId,
            existing?.selected_jobs_by_lane_json || null,
          ),
    dashboardMessageId: params.dashboardMessageId,
  });
}

export function rememberCursorJobList(params: {
  chatJid: string;
  threadId?: string;
  listMessageId?: string;
  items: CursorListSnapshotItem[];
  selectedAgentId?: string | null;
  selectedLaneId?: BackendLaneId | null;
}): void {
  const existing = getCursorOperatorContext(params.chatJid, params.threadId);
  const selectedLaneId = params.selectedLaneId || CURSOR_LANE_ID;
  upsertCursorOperatorContext({
    chatJid: params.chatJid,
    threadId: params.threadId,
    selectedLaneId,
    selectedAgentId: params.selectedAgentId,
    selectedJobsByLaneJson:
      params.selectedAgentId === undefined
        ? existing?.selected_jobs_by_lane_json || null
        : formatSelectedJobsByLaneJson(
            selectedLaneId,
            params.selectedAgentId,
            existing?.selected_jobs_by_lane_json || null,
          ),
    lastListSnapshotJson: formatSnapshotCollectionJson(
      selectedLaneId,
      params.items,
      existing?.last_list_snapshot_json || null,
    ),
    lastListMessageId: params.listMessageId || null,
  });
}

export function rememberCursorMessageContext(params: {
  chatJid: string;
  platformMessageId: string;
  threadId?: string;
  contextKind: string;
  laneId?: BackendLaneId;
  agentId?: string | null;
  payload?: Record<string, unknown> | null;
}): void {
  storeCursorMessageContext({
    chatJid: params.chatJid,
    platformMessageId: params.platformMessageId,
    threadId: params.threadId,
    contextKind: params.contextKind,
    laneId: params.laneId || CURSOR_LANE_ID,
    agentId: params.agentId || null,
    payloadJson: params.payload ? JSON.stringify(params.payload) : null,
  });
}

export function getActiveCursorMessageContext(
  chatJid: string,
  platformMessageId: string | undefined,
): ActiveCursorMessageContext | null {
  if (!platformMessageId) return null;
  const record = getCursorMessageContext(chatJid, platformMessageId);
  if (!record || !isFreshTimestamp(record.created_at)) return null;

  let payload: Record<string, unknown> | null = null;
  if (record.payload_json) {
    try {
      const parsed = JSON.parse(record.payload_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }

  return {
    chatJid: record.chat_jid,
    platformMessageId: record.platform_message_id,
    threadId: record.thread_id || undefined,
    contextKind: record.context_kind,
    laneId:
      record.lane_id === 'andrea_runtime' ? 'andrea_runtime' : CURSOR_LANE_ID,
    agentId: record.agent_id,
    payload,
    createdAt: record.created_at,
  };
}

export function getActiveCursorOperatorContext(
  chatJid: string,
  threadId?: string,
): ActiveCursorOperatorContext | null {
  const record = getCursorOperatorContext(chatJid, threadId);
  if (!record || !isFreshTimestamp(record.updated_at)) return null;
  const requestedLaneId =
    record.selected_lane_id === 'andrea_runtime'
      ? 'andrea_runtime'
      : record.selected_lane_id === CURSOR_LANE_ID
        ? CURSOR_LANE_ID
        : null;
  const lastListSnapshotsByLane =
    parseSnapshotCollectionJson(record.last_list_snapshot_json) || null;
  const selectedJobsByLane =
    parseSelectedJobsByLaneJson(record.selected_jobs_by_lane_json) || null;
  const selectedLaneId =
    requestedLaneId &&
    (requestedLaneId === 'andrea_runtime'
      ? selectedJobsByLane?.andrea_runtime
      : selectedJobsByLane?.cursor)
      ? requestedLaneId
      : null;
  return {
    chatJid: record.chat_jid,
    threadId: record.thread_id || undefined,
    selectedLaneId,
    selectedAgentId: selectedLaneId ? getSelectedJobId(record, selectedLaneId) : null,
    selectedJobsByLane,
    lastListSnapshotsByLane,
    lastListSnapshot:
      (selectedLaneId ? lastListSnapshotsByLane?.[selectedLaneId] : null) ||
      lastListSnapshotsByLane?.cursor ||
      null,
    lastListMessageId: record.last_list_message_id,
    dashboardMessageId: record.dashboard_message_id,
    updatedAt: record.updated_at,
  };
}

export function getSelectedLaneJobId(
  chatJid: string,
  threadId: string | undefined,
  laneId: BackendLaneId,
): string | null {
  const context = getActiveCursorOperatorContext(chatJid, threadId);
  if (!context) return null;
  if (laneId === 'andrea_runtime') {
    return context.selectedJobsByLane?.andrea_runtime || null;
  }
  return context.selectedJobsByLane?.cursor || null;
}

export function looksLikeCursorTargetToken(raw: string | undefined): boolean {
  const trimmed = raw?.trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) return true;
  if (trimmed.toLowerCase() === 'current') return true;
  try {
    normalizeCursorAgentId(trimmed);
    return true;
  } catch {
    return false;
  }
}

export type CursorReplyContextProvider = 'cloud' | 'desktop';

export interface CursorReplyContextResolution {
  kind: 'not_work_reply' | 'missing' | 'expired' | 'ready';
  provider: CursorReplyContextProvider | null;
  agentId: string | null;
}

export function detectCursorReplyProvider(
  text: string | null | undefined,
): CursorReplyContextProvider | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (
    /Lane:\s*Cursor Desktop/i.test(trimmed) ||
    /Task:\s*Cursor Desktop/i.test(trimmed) ||
    /Desktop bridge/i.test(trimmed) ||
    /Desktop session/i.test(trimmed)
  ) {
    return 'desktop';
  }
  if (
    /Lane:\s*Cursor Cloud/i.test(trimmed) ||
    /Task:\s*Cursor Cloud/i.test(trimmed) ||
    /Cursor Cloud/i.test(trimmed) ||
    /Current output for this task/i.test(trimmed) ||
    /No output is available yet for this task/i.test(trimmed)
  ) {
    return 'cloud';
  }
  return null;
}

export function resolveCursorReplyContext(params: {
  replyMessageId?: string;
  replyText?: string;
  contextMessageId?: string;
  contextAgentId?: string | null;
  contextCreatedAt?: string | null;
  nowIso: string;
  payload?: Record<string, unknown> | null;
}): CursorReplyContextResolution {
  const replyMessageId = params.replyMessageId?.trim() || '';
  const replyText = params.replyText?.trim() || '';
  const payloadProvider =
    params.payload?.provider === 'desktop' || params.payload?.provider === 'cloud'
      ? params.payload.provider
      : null;
  const detectedProvider = payloadProvider || detectCursorReplyProvider(replyText);

  if (!replyMessageId || !detectedProvider) {
    return {
      kind: 'not_work_reply',
      provider: null,
      agentId: null,
    };
  }

  if (
    !params.contextMessageId ||
    params.contextMessageId !== replyMessageId ||
    !params.contextAgentId
  ) {
    return {
      kind: 'missing',
      provider: detectedProvider,
      agentId: null,
    };
  }

  if (!isFreshTimestampAt(params.contextCreatedAt, params.nowIso)) {
    return {
      kind: 'expired',
      provider: detectedProvider,
      agentId: null,
    };
  }

  return {
    kind: 'ready',
    provider: detectedProvider,
    agentId: params.contextAgentId,
  };
}

export function buildCursorReplyContextMissingMessage(
  provider: CursorReplyContextProvider | null,
): string {
  if (provider === 'desktop') {
    return [
      'I can only use a fresh reply-linked context for Cursor work cards.',
      'This desktop session reply is missing or stale.',
      'Open `/cursor` -> `Current Job` again, or use `/cursor-sync`, `/cursor-terminal-status`, or `/cursor-terminal-log` explicitly.',
    ].join(' ');
  }

  return [
    'I can only continue a Cursor task when that reply points to a fresh task card.',
    'Open `/cursor` -> `Current Work` or `Jobs`, then reply to a fresh card, or use `/cursor-followup [AGENT_ID|LIST_NUMBER|current] TEXT` explicitly.',
  ].join(' ');
}

function resolveFromOrdinal(
  chatJid: string,
  threadId: string | undefined,
  rawOrdinal: string,
  laneId: BackendLaneId,
): CursorTargetResolutionResult {
  const ordinal = Number.parseInt(rawOrdinal, 10);
  if (!Number.isFinite(ordinal) || ordinal <= 0) {
    return {
      target: null,
      failureMessage: `That job number is invalid. ${getBackendContextGuidance(laneId)}`,
    };
  }

  const context = getCursorOperatorContext(chatJid, threadId);
  if (!context || !isFreshTimestamp(context.updated_at)) {
    return {
      target: null,
      failureMessage: getBackendContextGuidance(laneId),
    };
  }

  const snapshot = parseSnapshotJson(context.last_list_snapshot_json, laneId);
  const selected = snapshot?.[ordinal - 1];
  if (!selected) {
    return {
      target: null,
      failureMessage: `That job number is no longer in the latest list for this chat. ${getBackendContextGuidance(laneId)}`,
    };
  }

  return {
    target: {
      laneId: selected.laneId,
      handle: { laneId: selected.laneId, jobId: selected.id },
      agentId: selected.id,
      via: 'ordinal',
    },
    failureMessage: null,
  };
}

export function resolveBackendTarget(params: {
  chatJid: string;
  threadId?: string;
  replyToMessageId?: string;
  requestedTarget?: string | null;
  laneId: BackendLaneId;
  parseExplicitTarget?: ((raw: string) => string | null) | null;
}): CursorTargetResolutionResult {
  const requestedTarget = params.requestedTarget?.trim();
  if (requestedTarget) {
    if (/^\d+$/.test(requestedTarget)) {
      return resolveFromOrdinal(
        params.chatJid,
        params.threadId,
        requestedTarget,
        params.laneId,
      );
    }

    if (requestedTarget.toLowerCase() === 'current') {
      const context = getCursorOperatorContext(params.chatJid, params.threadId);
      if (!context || !isFreshTimestamp(context.updated_at)) {
        return {
          target: null,
          failureMessage: getBackendContextGuidance(params.laneId),
        };
      }
      const selectedAgentId = getSelectedJobId(context, params.laneId);
      if (!selectedAgentId) {
        return {
          target: null,
          failureMessage: getBackendContextGuidance(params.laneId),
        };
      }
      return {
        target: {
          laneId: params.laneId,
          handle: { laneId: params.laneId, jobId: selectedAgentId },
          agentId: selectedAgentId,
          via: 'current',
        },
        failureMessage: null,
      };
    }

    const explicitTarget = params.parseExplicitTarget
      ? params.parseExplicitTarget(requestedTarget)
      : null;
    if (explicitTarget) {
      return {
        target: {
          laneId: params.laneId,
          handle: {
            laneId: params.laneId,
            jobId: explicitTarget,
          },
          agentId: explicitTarget,
          via: 'explicit',
        },
        failureMessage: null,
      };
    }
  }

  if (params.replyToMessageId) {
    const messageContext = getCursorMessageContext(
      params.chatJid,
      params.replyToMessageId,
    );
    if (
      messageContext?.agent_id &&
      isFreshTimestamp(messageContext.created_at) &&
      (messageContext.lane_id === params.laneId ||
        (!messageContext.lane_id && params.laneId === CURSOR_LANE_ID))
    ) {
      return {
        target: {
          laneId: params.laneId,
          handle: { laneId: params.laneId, jobId: messageContext.agent_id },
          agentId: messageContext.agent_id,
          via: 'reply',
        },
        failureMessage: null,
      };
    }
  }

  const context = getCursorOperatorContext(params.chatJid, params.threadId);
  const selectedAgentId =
    context && isFreshTimestamp(context.updated_at)
      ? getSelectedJobId(context, params.laneId)
      : null;
  if (selectedAgentId) {
    return {
      target: {
        laneId: params.laneId,
        handle: { laneId: params.laneId, jobId: selectedAgentId },
        agentId: selectedAgentId,
        via: 'selected',
      },
      failureMessage: null,
    };
  }

  return {
    target: null,
    failureMessage: getBackendContextGuidance(params.laneId),
  };
}

export function resolveCursorTarget(params: {
  chatJid: string;
  threadId?: string;
  replyToMessageId?: string;
  requestedTarget?: string | null;
}): CursorTargetResolutionResult {
  return resolveBackendTarget({
    ...params,
    laneId: CURSOR_LANE_ID,
    parseExplicitTarget(raw) {
      try {
        return normalizeCursorAgentId(raw);
      } catch {
        return null;
      }
    },
  });
}

export function formatCursorDisplayId(id: string): string {
  return formatOpaqueTaskId(id);
}

function summarizeCursorRecord(record: CursorAgentView): string | null {
  return (
    record.sourceRepository ||
    record.targetUrl ||
    record.targetPrUrl ||
    record.summary
  );
}

function clipCursorPromptPreview(text: string | null | undefined): string | null {
  const trimmed = text?.trim() || '';
  if (!trimmed) return null;
  return trimmed.length <= 180 ? trimmed : `${trimmed.slice(0, 177)}...`;
}

export function formatCursorListEntry(record: FlattenedCursorJobEntry): string {
  const summary = summarizeCursorRecord(record);
  const updatedAt = record.updatedAt || record.lastSyncedAt || record.createdAt;
  return `${record.ordinal}. ${record.provider === 'cloud' ? 'Cloud' : 'Desktop'} ${formatCursorDisplayId(record.id)} ${formatHumanTaskStatus(record.status)}${summary ? `\n   ${summary}` : ''}${updatedAt ? `\n   updated ${updatedAt}` : ''}`;
}

export function formatCursorJobCard(
  record: CursorAgentView,
  resultCount = 0,
): string {
  const isDesktop = record.provider === 'desktop';
  const promptPreview = clipCursorPromptPreview(record.promptText);
  return formatShellTaskCard({
    title: `${isDesktop ? 'Session' : 'Task'} ${formatCursorDisplayId(record.id)}`,
    lane: isDesktop ? 'cursor_desktop' : 'cursor_cloud',
    status: record.status,
    detailLines: [
      promptPreview ? `Prompt preview: ${promptPreview}` : null,
      record.model ? `Model: ${record.model}` : null,
      record.sourceRepository ? `Repo: ${record.sourceRepository}` : null,
      record.targetUrl ? `URL: ${record.targetUrl}` : null,
      record.targetPrUrl ? `PR: ${record.targetPrUrl}` : null,
      !isDesktop
        ? `Results: ${resultCount === 0 ? 'none yet' : `${resultCount} file${resultCount === 1 ? '' : 's'}`}`
        : null,
    ],
    summary: record.summary || null,
    updatedAt: record.updatedAt,
  });
}

export function buildCursorListSelectionActions(
  visibleCount: number,
): ChannelInlineAction[] {
  const actions: ChannelInlineAction[] = [];
  for (let index = 1; index <= Math.min(6, visibleCount); index += 1) {
    actions.push({
      label: String(index),
      actionId: `/cursor-select ${index}`,
    });
  }
  actions.push({
    label: 'Refresh',
    actionId: '/cursor-jobs',
  });
  return actions;
}

export function buildCursorCloudTaskActions(
  targetUrl?: string | null,
): ChannelInlineAction[] {
  return [
    { label: 'Refresh', actionId: '/cursor-sync' },
    { label: 'View Output', actionId: '/cursor-conversation' },
    { label: 'Results', actionId: '/cursor-results' },
    ...(targetUrl ? [{ label: 'Open in Cursor', url: targetUrl }] : []),
    { label: 'Stop Run', actionId: '/cursor-stop' },
  ];
}

export function buildCursorTerminalCardActions(): ChannelInlineAction[] {
  return [
    { label: 'Refresh', actionId: '/cursor-sync' },
    { label: 'Terminal Status', actionId: '/cursor-terminal-status' },
    { label: 'Terminal Log', actionId: '/cursor-terminal-log' },
    { label: 'Terminal Help', actionId: '/cursor-terminal-help' },
  ];
}

export function buildCursorJobCardActions(
  record: CursorAgentView,
): ChannelInlineAction[] {
  if (record.provider === 'desktop') {
    return [
      { label: 'Refresh', actionId: '/cursor-sync' },
      { label: 'View Output', actionId: '/cursor-conversation' },
      { label: 'Terminal', actionId: '/cursor-terminal-help' },
      { label: 'Terminal Log', actionId: '/cursor-terminal-log' },
    ];
  }

  return buildCursorCloudTaskActions(record.targetUrl);
}
