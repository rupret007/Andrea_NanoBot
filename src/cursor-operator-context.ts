import type {
  BackendJobHandle,
  BackendLaneId,
} from './backend-lanes/types.js';
import type { CursorAgentView, CursorJobInventory } from './cursor-jobs.js';
import {
  getCursorMessageContext,
  getCursorOperatorContext,
  storeCursorMessageContext,
  upsertCursorOperatorContext,
} from './db.js';
import { normalizeCursorAgentId } from './cursor-agent-id.js';
import type { ChannelInlineAction } from './types.js';

const CURSOR_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NO_CURSOR_CONTEXT_MESSAGE =
  'Run `/cursor` or `/cursor-jobs`, then tap a job or reply to a Cursor card.';
const CURSOR_LANE_ID: BackendLaneId = 'cursor';

export type CursorJobBucket =
  | 'cloudTracked'
  | 'desktopTracked'
  | 'cloudRecoverable'
  | 'desktopRecoverable';

export interface CursorListSnapshotItem {
  laneId: BackendLaneId;
  id: string;
  provider: 'cloud' | 'desktop';
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
  selectedLaneId: BackendLaneId;
  selectedAgentId: string | null;
  selectedJobsByLane: SelectedJobsByLane | null;
  lastListSnapshot: CursorListSnapshotItem[] | null;
  lastListMessageId: string | null;
  dashboardMessageId: string | null;
  updatedAt: string;
}

function isFreshTimestamp(timestamp: string | null | undefined): boolean {
  if (!timestamp) return false;
  const createdAt = Date.parse(timestamp);
  if (!Number.isFinite(createdAt)) return false;
  return Date.now() - createdAt <= CURSOR_CONTEXT_TTL_MS;
}

function parseSnapshotJson(
  raw: string | null,
): CursorListSnapshotItem[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
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
      if (!id || !provider) return [];
      return [{ laneId, id, provider }];
    });
  } catch {
    return undefined;
  }
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
    if (
      typeof row.andrea_runtime === 'string' ||
      row.andrea_runtime === null
    ) {
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

function getSelectedCursorAgentId(
  record:
    | {
        selected_lane_id: string | null;
        selected_agent_id: string | null;
        selected_jobs_by_lane_json: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!record) return null;
  const selectedJobs =
    parseSelectedJobsByLaneJson(record.selected_jobs_by_lane_json) || null;
  if (selectedJobs?.cursor !== undefined) {
    return selectedJobs.cursor || null;
  }
  if (record.selected_lane_id === CURSOR_LANE_ID) {
    return record.selected_agent_id;
  }
  return record.selected_agent_id && !record.selected_lane_id
    ? record.selected_agent_id
    : null;
}

export function getCursorContextGuidance(): string {
  return NO_CURSOR_CONTEXT_MESSAGE;
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

export function rememberCursorDashboardMessage(params: {
  chatJid: string;
  threadId?: string;
  dashboardMessageId: string | null;
  selectedAgentId?: string | null;
  selectedLaneId?: BackendLaneId | null;
}): void {
  const existing = getCursorOperatorContext(params.chatJid, params.threadId);
  const selectedLaneId =
    params.selectedLaneId ||
    (existing?.selected_lane_id === 'andrea_runtime'
      ? 'andrea_runtime'
      : CURSOR_LANE_ID);
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
  const selectedLaneId =
    params.selectedLaneId ||
    (existing?.selected_lane_id === 'andrea_runtime'
      ? 'andrea_runtime'
      : CURSOR_LANE_ID);
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
    lastListSnapshotJson: JSON.stringify(params.items),
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
  return {
    chatJid: record.chat_jid,
    threadId: record.thread_id || undefined,
    selectedLaneId:
      record.selected_lane_id === 'andrea_runtime'
        ? 'andrea_runtime'
        : CURSOR_LANE_ID,
    selectedAgentId: getSelectedCursorAgentId(record),
    selectedJobsByLane:
      parseSelectedJobsByLaneJson(record.selected_jobs_by_lane_json) || null,
    lastListSnapshot: parseSnapshotJson(record.last_list_snapshot_json) || null,
    lastListMessageId: record.last_list_message_id,
    dashboardMessageId: record.dashboard_message_id,
    updatedAt: record.updated_at,
  };
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

function resolveFromOrdinal(
  chatJid: string,
  threadId: string | undefined,
  rawOrdinal: string,
): CursorTargetResolutionResult {
  const ordinal = Number.parseInt(rawOrdinal, 10);
  if (!Number.isFinite(ordinal) || ordinal <= 0) {
    return {
      target: null,
      failureMessage:
        'That job number is invalid. Run `/cursor-jobs`, then tap a job or use one of the listed numbers.',
    };
  }

  const context = getCursorOperatorContext(chatJid, threadId);
  if (!context || !isFreshTimestamp(context.updated_at)) {
    return {
      target: null,
      failureMessage: NO_CURSOR_CONTEXT_MESSAGE,
    };
  }

  const snapshot = parseSnapshotJson(context.last_list_snapshot_json);
  const selected = snapshot?.[ordinal - 1];
  if (!selected) {
    return {
      target: null,
      failureMessage:
        'That job number is no longer in the latest `/cursor-jobs` list for this chat. Run `/cursor-jobs` again, then tap a job or use one of the listed numbers.',
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

export function resolveCursorTarget(params: {
  chatJid: string;
  threadId?: string;
  replyToMessageId?: string;
  requestedTarget?: string | null;
}): CursorTargetResolutionResult {
  const requestedTarget = params.requestedTarget?.trim();
  if (requestedTarget) {
    if (/^\d+$/.test(requestedTarget)) {
      return resolveFromOrdinal(
        params.chatJid,
        params.threadId,
        requestedTarget,
      );
    }

    if (requestedTarget.toLowerCase() === 'current') {
      const context = getCursorOperatorContext(params.chatJid, params.threadId);
      if (!context || !isFreshTimestamp(context.updated_at)) {
        return {
          target: null,
          failureMessage: NO_CURSOR_CONTEXT_MESSAGE,
        };
      }
      const selectedAgentId = getSelectedCursorAgentId(context);
      if (!selectedAgentId) {
        return {
          target: null,
          failureMessage: NO_CURSOR_CONTEXT_MESSAGE,
        };
      }
      return {
        target: {
          laneId: CURSOR_LANE_ID,
          handle: { laneId: CURSOR_LANE_ID, jobId: selectedAgentId },
          agentId: selectedAgentId,
          via: 'current',
        },
        failureMessage: null,
      };
    }

    return {
      target: {
        laneId: CURSOR_LANE_ID,
        handle: {
          laneId: CURSOR_LANE_ID,
          jobId: normalizeCursorAgentId(requestedTarget),
        },
        agentId: normalizeCursorAgentId(requestedTarget),
        via: 'explicit',
      },
      failureMessage: null,
    };
  }

  if (params.replyToMessageId) {
    const messageContext = getCursorMessageContext(
      params.chatJid,
      params.replyToMessageId,
    );
    if (
      messageContext?.agent_id &&
      (messageContext.lane_id === 'cursor' || !messageContext.lane_id) &&
      isFreshTimestamp(messageContext.created_at)
    ) {
      return {
        target: {
          laneId: CURSOR_LANE_ID,
          handle: { laneId: CURSOR_LANE_ID, jobId: messageContext.agent_id },
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
      ? getSelectedCursorAgentId(context)
      : null;
  if (selectedAgentId) {
    return {
      target: {
        laneId: CURSOR_LANE_ID,
        handle: { laneId: CURSOR_LANE_ID, jobId: selectedAgentId },
        agentId: selectedAgentId,
        via: 'selected',
      },
      failureMessage: null,
    };
  }

  return {
    target: null,
    failureMessage: NO_CURSOR_CONTEXT_MESSAGE,
  };
}

export function formatCursorDisplayId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}...${id.slice(-6)}`;
}

function summarizeCursorRecord(record: CursorAgentView): string | null {
  return (
    record.sourceRepository ||
    record.targetUrl ||
    record.targetPrUrl ||
    record.summary
  );
}

export function formatCursorListEntry(record: FlattenedCursorJobEntry): string {
  const summary = summarizeCursorRecord(record);
  const updatedAt = record.updatedAt || record.lastSyncedAt || record.createdAt;
  return `${record.ordinal}. ${record.provider === 'cloud' ? 'Cloud' : 'Desktop'} ${formatCursorDisplayId(record.id)} [${record.status}]${summary ? `\n   ${summary}` : ''}${updatedAt ? `\n   updated ${updatedAt}` : ''}`;
}

export function formatCursorJobCard(
  record: CursorAgentView,
  resultCount = 0,
): string {
  const title = `${record.provider === 'cloud' ? 'Cursor Cloud job' : 'Desktop bridge session'} ${formatCursorDisplayId(record.id)}`;
  const lines = [
    title,
    `Status: ${record.status}`,
    record.model ? `Model: ${record.model}` : null,
    record.sourceRepository ? `Repo: ${record.sourceRepository}` : null,
    record.targetUrl ? `URL: ${record.targetUrl}` : null,
    record.targetPrUrl ? `PR: ${record.targetPrUrl}` : null,
    record.updatedAt ? `Updated: ${record.updatedAt}` : null,
    record.provider === 'cloud' ? `Result files: ${resultCount}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
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

export function buildCursorJobCardActions(
  record: CursorAgentView,
): ChannelInlineAction[] {
  if (record.provider === 'desktop') {
    return [
      { label: 'Sync', actionId: '/cursor-sync' },
      { label: 'Messages', actionId: '/cursor-conversation' },
      { label: 'Terminal', actionId: '/cursor-terminal-help' },
      { label: 'Terminal Log', actionId: '/cursor-terminal-log' },
    ];
  }

  return [
    { label: 'Sync', actionId: '/cursor-sync' },
    { label: 'Text', actionId: '/cursor-conversation' },
    { label: 'Files', actionId: '/cursor-results' },
    ...(record.targetUrl ? [{ label: 'Open', url: record.targetUrl }] : []),
    { label: 'Stop', actionId: '/cursor-stop' },
  ];
}
