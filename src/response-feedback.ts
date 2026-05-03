import { execFileSync } from 'child_process';

import {
  getCursorAgentById,
  getRuntimeBackendJob,
  listRecentResponseFeedback,
  updateResponseFeedback,
} from './db.js';
import {
  ANDREA_OPENAI_BACKEND_ID,
  AndreaOpenAiBackendClient,
} from './andrea-openai-backend.js';
import { parseGitDirtyPaths } from './git-status-paths.js';
import type {
  ChannelInlineAction,
  PilotBlockerOwner,
  ResponseFeedbackClassification,
  ResponseFeedbackRecord,
  ResponseFeedbackRuntimePreference,
  SendMessageOptions,
} from './types.js';

export type ResponseFeedbackActionKind =
  | 'capture'
  | 'start'
  | 'approve_local'
  | 'why'
  | 'not_now'
  | 'keep_local'
  | 'approve_landing'
  | 'commit_only'
  | 'commit_push';

export interface ParsedResponseFeedbackAction {
  feedbackId: string;
  operation: ResponseFeedbackActionKind;
}

export type PendingRepairApprovalResolution =
  | { state: 'not_approval' }
  | { state: 'not_found' }
  | {
      state: 'stale';
      record: ResponseFeedbackRecord;
      ageMs: number;
    }
  | {
      state: 'ready';
      action: ParsedResponseFeedbackAction;
      record: ResponseFeedbackRecord;
      ageMs: number;
      absorbedRecord?: ResponseFeedbackRecord;
    };

export interface ResponseFeedbackClassificationResult {
  classification: ResponseFeedbackClassification;
  status: ResponseFeedbackRecord['status'];
  blockerOwner: PilotBlockerOwner;
  explanation: string;
}

export interface ResponseFeedbackLaneAvailability {
  runtimeAvailable: boolean;
  runtimeLocalPreferred: boolean;
  runtimeCloudAllowed: boolean;
  runtimeDetail?: string | null;
  cursorCloudAvailable: boolean;
  cursorCloudDetail?: string | null;
  cursorDesktopAvailable: boolean;
  cursorDesktopDetail?: string | null;
}

export interface ResponseFeedbackLaneSelection {
  laneId: 'cursor' | 'andrea_runtime' | null;
  runtimePreference: ResponseFeedbackRuntimePreference | null;
  label: string;
  promptPrefix: string;
  reason: string;
}

interface ResponseFeedbackRefreshOptions {
  runtimeStatusLookup?: (jobId: string) => Promise<string | null | undefined>;
  cursorStatusLookup?: (jobId: string) => string | null | undefined;
  localHotfixReadyCheck?: (record: ResponseFeedbackRecord) => boolean;
}

const RESPONSE_FEEDBACK_ACTION_PREFIX = 'feedback';

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTaskStatus(status: string | null | undefined): string {
  return (status || '').trim().toLowerCase();
}

function isSuccessfulResponseFeedbackTaskStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeTaskStatus(status);
  return (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'finished' ||
    normalized === 'succeeded' ||
    normalized === 'success'
  );
}

function isFailedResponseFeedbackTaskStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeTaskStatus(status);
  return (
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'stopped'
  );
}

function buildResponseFeedbackFailureNote(
  taskStatus: string | null | undefined,
): string {
  const normalized = normalizeTaskStatus(taskStatus);
  switch (normalized) {
    case 'cancelled':
    case 'canceled':
      return 'The remediation task was cancelled before it produced a clean local hotfix, so it is back in review.';
    case 'stopped':
      return 'The remediation task was stopped before it produced a clean local hotfix, so it is back in review.';
    case 'error':
      return 'The remediation task hit an execution error before it produced a clean local hotfix, so it is back in review.';
    case 'failed':
    default:
      return 'The remediation task failed before it produced a clean local hotfix, so it is back in review.';
  }
}

async function lookupRuntimeStatusFromBackend(
  jobId: string,
): Promise<string | null> {
  try {
    const client = new AndreaOpenAiBackendClient();
    const job = await client.getJob(jobId);
    return job.status || null;
  } catch {
    return (
      getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, jobId)?.status || null
    );
  }
}

function buildResponseFeedbackNoHotfixNote(
  laneId?: ResponseFeedbackRecord['remediationLaneId'] | null,
): string {
  if (laneId === 'andrea_runtime') {
    return 'The remediation task finished, but the Codex/OpenAI runtime lane is read-only on this host, so there is no local hotfix to land yet.';
  }
  return 'The remediation task finished, but I do not see a new local hotfix on this host yet, so it is back in review.';
}

function listCurrentGitDirtyPaths(): string[] {
  try {
    const output = execFileSync('git', ['status', '--short'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseGitDirtyPaths(output);
  } catch {
    return [];
  }
}

function hasResponseFeedbackLocalHotfix(
  record: Pick<ResponseFeedbackRecord, 'linkedRefs'>,
): boolean {
  const baseline = new Set(record.linkedRefs?.repoDirtyPathsAtStart || []);
  return listCurrentGitDirtyPaths().some((path) => !baseline.has(path));
}

function syncResponseFeedbackRecordFromTaskStatus(
  record: ResponseFeedbackRecord,
  taskStatus: string | null | undefined,
  options: ResponseFeedbackRefreshOptions = {},
): ResponseFeedbackRecord {
  if (
    isSuccessfulResponseFeedbackTaskStatus(taskStatus) &&
    record.status !== 'resolved_locally' &&
    record.status !== 'landed'
  ) {
    if (record.remediationLaneId === 'andrea_runtime') {
      return updateResponseFeedback(record.feedbackId, {
        status: 'captured',
        operatorNote: buildResponseFeedbackNoHotfixNote(
          record.remediationLaneId,
        ),
      });
    }
    const localHotfixReady = options.localHotfixReadyCheck
      ? options.localHotfixReadyCheck(record)
      : hasResponseFeedbackLocalHotfix(record);
    if (!localHotfixReady) {
      return updateResponseFeedback(record.feedbackId, {
        status: 'captured',
        operatorNote: buildResponseFeedbackNoHotfixNote(
          record.remediationLaneId,
        ),
      });
    }
    return updateResponseFeedback(record.feedbackId, {
      status: 'resolved_locally',
      operatorNote:
        'The remediation task completed locally and is waiting for explicit landing approval.',
    });
  }

  if (
    isFailedResponseFeedbackTaskStatus(taskStatus) &&
    record.status !== 'resolved_locally' &&
    record.status !== 'landed'
  ) {
    const operatorNote = buildResponseFeedbackFailureNote(taskStatus);
    if (record.status === 'failed' && record.operatorNote === operatorNote) {
      return record;
    }
    return updateResponseFeedback(record.feedbackId, {
      status: 'failed',
      operatorNote,
    });
  }

  return record;
}

export async function refreshResponseFeedbackRecordTruth(
  record: ResponseFeedbackRecord,
  options: ResponseFeedbackRefreshOptions = {},
): Promise<ResponseFeedbackRecord> {
  if (!record.remediationLaneId || !record.remediationJobId) {
    return record;
  }

  if (record.remediationLaneId === 'andrea_runtime') {
    const taskStatus = options.runtimeStatusLookup
      ? await options.runtimeStatusLookup(record.remediationJobId)
      : await lookupRuntimeStatusFromBackend(record.remediationJobId);
    return syncResponseFeedbackRecordFromTaskStatus(
      record,
      taskStatus,
      options,
    );
  }

  if (record.remediationLaneId === 'cursor') {
    const taskStatus = options.cursorStatusLookup
      ? options.cursorStatusLookup(record.remediationJobId)
      : getCursorAgentById(record.remediationJobId)?.status;
    return syncResponseFeedbackRecordFromTaskStatus(
      record,
      taskStatus,
      options,
    );
  }

  return record;
}

export async function refreshRecentResponseFeedbackTruth(
  params: {
    chatJid?: string;
    status?: ResponseFeedbackRecord['status'];
    limit?: number;
  } = {},
  options: ResponseFeedbackRefreshOptions = {},
): Promise<ResponseFeedbackRecord[]> {
  const records = listRecentResponseFeedback(params);
  const refreshed = await Promise.all(
    records.map((record) =>
      refreshResponseFeedbackRecordTruth(record, options),
    ),
  );
  return refreshed.sort(
    (left, right) =>
      Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || ''),
  );
}

function splitInlineActionsIntoRows(
  actions: ChannelInlineAction[],
): ChannelInlineAction[][] {
  return actions.reduce<ChannelInlineAction[][]>((rows, action, index) => {
    const rowIndex = Math.floor(index / 3);
    if (!rows[rowIndex]) rows[rowIndex] = [];
    rows[rowIndex].push(action);
    return rows;
  }, []);
}

function formatClassificationLabel(
  classification: ResponseFeedbackClassification,
): string {
  switch (classification) {
    case 'repo_side_broken':
      return 'repo-side broken flow';
    case 'repo_side_rough_edge':
      return 'repo-side rough edge';
    case 'manual_sync_only':
      return 'manual sync step';
    case 'externally_blocked':
    default:
      return 'external blocker';
  }
}

export function buildResponseFeedbackActionId(
  feedbackId: string,
  operation: ResponseFeedbackActionKind,
): string {
  return `${RESPONSE_FEEDBACK_ACTION_PREFIX}:${feedbackId}:${operation}`;
}

export function parseResponseFeedbackAction(
  text: string | null | undefined,
): ParsedResponseFeedbackAction | null {
  const trimmed = normalizeText(text);
  const match = trimmed.match(
    /^feedback:([a-f0-9-]{8,}):(capture|start|approve_local|why|not_now|keep_local|approve_landing|commit_only|commit_push)$/i,
  );
  if (!match) return null;
  return {
    feedbackId: match[1] || '',
    operation: (match[2] || 'capture') as ResponseFeedbackActionKind,
  };
}

function getNaturalRepairApprovalOperation(
  text: string | null | undefined,
): ResponseFeedbackActionKind | null {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return null;
  if (
    /\b(?:do not|don't|dont|no|not)\s+(?:approve|start|run|do|proceed|fix|repair)\b/i.test(
      normalized,
    )
  ) {
    return null;
  }
  if (
    /\b(?:approve|approved|start|run|use|try|fallback to|fall back to)\b.{0,40}\b(?:local codex|codex local|local fallback|local repair)\b/i.test(
      normalized,
    ) ||
    /\bapprove local fallback\b/i.test(normalized)
  ) {
    return 'approve_local';
  }
  const approvalPatterns = [
    /\byou have my approval\b/i,
    /\bi approve\b/i,
    /\bapproved\b/i,
    /\bgo ahead\b/i,
    /\bdo it\b/i,
    /\bstart (?:the )?(?:repair|fix|self[- ]?repair|self[- ]?fix)\b/i,
    /\brun (?:the )?(?:repair|fix|self[- ]?repair|self[- ]?fix)\b/i,
    /\bproceed\b/i,
    /\bmake (?:the )?fix\b/i,
    /\bfix (?:it|that|what'?s broken|the issue)\b/i,
    /\brepair (?:it|that|the issue|the response)\b/i,
  ];
  return approvalPatterns.some((pattern) => pattern.test(normalized))
    ? 'start'
    : null;
}

function getResponseFeedbackApprovalAgeMs(
  record: Pick<ResponseFeedbackRecord, 'createdAt' | 'updatedAt'>,
  now: Date,
): number {
  const timestamps = [record.updatedAt, record.createdAt]
    .map((value) => Date.parse(value || ''))
    .filter((value) => Number.isFinite(value));
  const newest = timestamps.length ? Math.max(...timestamps) : 0;
  return newest > 0
    ? Math.max(0, now.getTime() - newest)
    : Number.POSITIVE_INFINITY;
}

function isRepairApprovalCandidate(record: ResponseFeedbackRecord): boolean {
  if (
    record.classification === 'externally_blocked' ||
    record.classification === 'manual_sync_only'
  ) {
    return false;
  }
  if (
    record.status !== 'awaiting_confirmation' &&
    record.status !== 'failed' &&
    record.status !== 'captured'
  ) {
    return false;
  }
  return Boolean(
    record.linkedRefs?.platformRepairPlanId ||
    record.remediationLaneId ||
    record.remediationRuntimePreference,
  );
}

function isNaturalRepairApprovalFeedbackRecord(
  record: ResponseFeedbackRecord,
): boolean {
  if (getNaturalRepairApprovalOperation(record.originalUserText) !== 'start') {
    return false;
  }
  const reply = normalizeText(record.assistantReplyText).toLowerCase();
  const routeKey = normalizeText(record.routeKey).toLowerCase();
  const capabilityId = normalizeText(record.capabilityId).toLowerCase();
  return (
    /\b(?:what would you like|how can i help|let me know|next)\b/.test(reply) ||
    routeKey.includes('direct_assistant') ||
    capabilityId.includes('assistant')
  );
}

export function resolvePendingResponseFeedbackApproval(
  text: string | null | undefined,
  records: ResponseFeedbackRecord[],
  options: { now?: Date; maxAgeMs?: number } = {},
): PendingRepairApprovalResolution {
  const operation = getNaturalRepairApprovalOperation(text);
  if (!operation) return { state: 'not_approval' };

  const now = options.now || new Date();
  const maxAgeMs = options.maxAgeMs ?? 12 * 60 * 60 * 1000;
  const candidates = records
    .filter(isRepairApprovalCandidate)
    .map((record) => ({
      record,
      ageMs: getResponseFeedbackApprovalAgeMs(record, now),
    }))
    .sort((a, b) => a.ageMs - b.ageMs);

  const selected = candidates[0];
  if (!selected) return { state: 'not_found' };

  let target = selected;
  let absorbedRecord: ResponseFeedbackRecord | undefined;
  if (isNaturalRepairApprovalFeedbackRecord(selected.record)) {
    const prior = candidates.find(
      (candidate) =>
        candidate.record.feedbackId !== selected.record.feedbackId &&
        !isNaturalRepairApprovalFeedbackRecord(candidate.record),
    );
    if (!prior) return { state: 'not_found' };
    target = prior;
    absorbedRecord = selected.record;
  }

  if (target.ageMs > maxAgeMs) {
    return {
      state: 'stale',
      record: target.record,
      ageMs: target.ageMs,
    };
  }

  return {
    state: 'ready',
    record: target.record,
    ageMs: target.ageMs,
    absorbedRecord,
    action: {
      feedbackId: target.record.feedbackId,
      operation,
    },
  };
}

export function shouldCancelPendingContinuationForFeedback(
  record: Pick<
    ResponseFeedbackRecord,
    'routeKey' | 'capabilityId' | 'handlerKind'
  >,
): boolean {
  const routeKey = normalizeText(record.routeKey).toLowerCase();
  const capabilityId = normalizeText(record.capabilityId).toLowerCase();
  const handlerKind = normalizeText(record.handlerKind).toLowerCase();
  return (
    routeKey.startsWith('google_calendar.create_event') ||
    capabilityId === 'calendar.google_create' ||
    handlerKind === 'google_calendar_create_local'
  );
}

export function appendResponseFeedbackInlineRow(
  options: SendMessageOptions = {},
  feedbackId: string,
): SendMessageOptions {
  const feedbackRow: ChannelInlineAction[] = [
    {
      label: 'Not helpful',
      actionId: buildResponseFeedbackActionId(feedbackId, 'capture'),
    },
  ];
  const existingRows =
    options.inlineActionRows && options.inlineActionRows.length > 0
      ? options.inlineActionRows.map((row) => [...row])
      : options.inlineActions && options.inlineActions.length > 0
        ? splitInlineActionsIntoRows(options.inlineActions)
        : [];
  return {
    ...options,
    inlineActions: undefined,
    inlineActionRows: [...existingRows, feedbackRow],
  };
}

export function classifyResponseFeedbackCandidate(params: {
  originalUserText: string;
  assistantReplyText: string;
  routeKey?: string | null;
  capabilityId?: string | null;
  responseSource?: string | null;
  traceReason?: string | null;
  blockerClass?: string | null;
}): ResponseFeedbackClassificationResult {
  const ask = normalizeText(params.originalUserText).toLowerCase();
  const reply = normalizeText(params.assistantReplyText).toLowerCase();
  const routeKey = normalizeText(params.routeKey).toLowerCase();
  const capabilityId = normalizeText(params.capabilityId).toLowerCase();
  const responseSource = normalizeText(params.responseSource).toLowerCase();
  const traceReason = normalizeText(params.traceReason).toLowerCase();
  const blockerClass = normalizeText(params.blockerClass).toLowerCase();
  const combined = [reply, traceReason, blockerClass, routeKey, capabilityId]
    .filter(Boolean)
    .join(' ');

  if (
    /manual sync|build model|mark-synced|developer console|interaction model/.test(
      combined,
    )
  ) {
    return {
      classification: 'manual_sync_only',
      status: 'manual_sync_only',
      blockerOwner: 'external',
      explanation:
        'This looks like a manual surface-sync step rather than a repo bug, so Andrea should keep it captured without auto-starting a fix.',
    };
  }

  if (
    responseSource === 'research_handoff' ||
    responseSource === 'media_handoff' ||
    /quota|provider|api key|not configured|blocked|live research|image generation|can't check that live|couldn't check that live|live lookup (?:was )?unavailable|live lookup unavailable|can't do a live lookup|can't pull live|can't fetch live/.test(
      combined,
    )
  ) {
    return {
      classification: 'externally_blocked',
      status: 'blocked_external',
      blockerOwner: 'external',
      explanation:
        'This reply looks limited by a blocked external lane, so Andrea should keep the issue and explain the blocker instead of auto-starting a repo fix.',
    };
  }

  if (
    /\b(news|headlines|latest news|news today|what(?:’|')?s the news|today(?:’|')?s news)\b/.test(
      ask,
    ) &&
    !/\b(news|headline|today|story|stories)\b/.test(reply)
  ) {
    return {
      classification: 'repo_side_broken',
      status: 'awaiting_confirmation',
      blockerOwner: 'repo_side',
      explanation:
        'The ask looks like a current-news request, but the reply stayed generic instead of routing into the right live-news or honest-fallback path.',
    };
  }

  if (!routeKey && !capabilityId && responseSource !== 'local_companion') {
    return {
      classification: 'repo_side_broken',
      status: 'awaiting_confirmation',
      blockerOwner: 'repo_side',
      explanation:
        'Andrea lost the intended route for this reply, so this looks like a repo-side broken path rather than a simple wording miss.',
    };
  }

  return {
    classification: 'repo_side_rough_edge',
    status: 'awaiting_confirmation',
    blockerOwner: 'repo_side',
    explanation:
      'This looks like a real repo-side rough edge: the answer landed, but the route, fallback, or wording still missed the user’s intent.',
  };
}

export function buildResponseFeedbackActionRows(
  record: Pick<
    ResponseFeedbackRecord,
    | 'feedbackId'
    | 'status'
    | 'classification'
    | 'remediationRuntimePreference'
    | 'linkedRefs'
  >,
): SendMessageOptions['inlineActionRows'] {
  if (record.status === 'resolved_locally') {
    return [
      [
        {
          label: 'Approve landing',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'approve_landing',
          ),
        },
      ],
      [
        {
          label: 'Commit + push',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'commit_push',
          ),
        },
        {
          label: 'Commit only',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'commit_only',
          ),
        },
      ],
      [
        {
          label: 'Keep local',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'keep_local',
          ),
        },
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
      ],
    ];
  }
  if (record.status === 'landed') {
    return [
      [
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
      ],
    ];
  }
  if (
    record.status === 'blocked_external' ||
    record.status === 'manual_sync_only'
  ) {
    return [
      [
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
        {
          label: 'Not now',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
        },
      ],
    ];
  }
  if (record.status === 'running') {
    return [
      [
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
      ],
    ];
  }
  if (record.status === 'failed') {
    return [
      [
        {
          label: 'Retry fix',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'start'),
        },
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
        {
          label: 'Not now',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
        },
      ],
    ];
  }
  if (
    record.status === 'awaiting_confirmation' &&
    record.remediationRuntimePreference === 'codex_local'
  ) {
    return [
      [
        {
          label: 'Approve local fallback',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'approve_local',
          ),
        },
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
        {
          label: 'Not now',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
        },
      ],
    ];
  }
  return [
    [
      {
        label: record.linkedRefs?.platformRepairPlanId
          ? 'Approve repair'
          : 'Prepare repair',
        actionId: buildResponseFeedbackActionId(record.feedbackId, 'start'),
      },
      {
        label: 'Why',
        actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
      },
      {
        label: 'Not now',
        actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
      },
    ],
  ];
}

export function appendResponseFeedbackActionRows(params: {
  record: Pick<
    ResponseFeedbackRecord,
    | 'feedbackId'
    | 'status'
    | 'classification'
    | 'remediationRuntimePreference'
    | 'linkedRefs'
  >;
  inlineActions?: ChannelInlineAction[] | null;
  inlineActionRows?: ChannelInlineAction[][] | null;
}): SendMessageOptions['inlineActionRows'] {
  const baseRows =
    params.inlineActionRows && params.inlineActionRows.length > 0
      ? params.inlineActionRows.map((row) => [...row])
      : params.inlineActions && params.inlineActions.length > 0
        ? splitInlineActionsIntoRows(params.inlineActions)
        : [];
  return [
    ...baseRows,
    ...(buildResponseFeedbackActionRows(params.record) || []),
  ];
}

export function buildResponseFeedbackCaptureReply(
  record: Pick<
    ResponseFeedbackRecord,
    | 'classification'
    | 'assistantReplyText'
    | 'feedbackId'
    | 'status'
    | 'remediationLaneId'
    | 'remediationRuntimePreference'
    | 'linkedRefs'
  >,
  explanation: string,
): string {
  const classification = formatClassificationLabel(record.classification);
  const replyPreview =
    normalizeText(record.assistantReplyText).slice(0, 140) || 'that reply';
  if (
    record.status === 'blocked_external' ||
    record.status === 'manual_sync_only'
  ) {
    return [
      'I saved that as a private pilot issue.',
      `This one looks like an ${classification}, so I am not auto-starting a repo fix.`,
      explanation,
      `Saved reply excerpt: "${replyPreview}"`,
    ].join('\n');
  }
  const stagedPlan = record.linkedRefs?.platformRepairPlanId;
  const selectedWorker =
    record.remediationRuntimePreference === 'cursor_cloud'
      ? 'Cursor Cloud'
      : record.remediationRuntimePreference === 'codex_cloud'
        ? 'Codex cloud'
        : record.remediationRuntimePreference === 'codex_local'
          ? 'Codex local fallback'
          : null;
  return [
    'I saved that as a private pilot issue.',
    stagedPlan
      ? `This looks like a ${classification}, and I staged a bounded repair plan for approval.`
      : `This looks like a ${classification}, and I can prep a targeted repair plan if you want.`,
    selectedWorker
      ? `Selected lane: ${selectedWorker}.`
      : 'Repair lane: not selected yet.',
    record.remediationRuntimePreference === 'codex_local'
      ? 'Cloud repair is not ready, so local Codex will only run if you approve that fallback explicitly.'
      : 'Cloud repair is preferred; local Codex remains fallback only.',
    stagedPlan
      ? `Plan: ${stagedPlan}. One approval is scoped to this feedback item, Andrea_NanoBot, focused tests/build, and no secrets or external-account changes.`
      : 'Next step: prepare a repair plan, then approve only if the scope looks right.',
    explanation,
    `Saved reply excerpt: "${replyPreview}"`,
  ].join('\n');
}

export function buildResponseFeedbackWhyText(
  record: Pick<
    ResponseFeedbackRecord,
    | 'classification'
    | 'routeKey'
    | 'capabilityId'
    | 'responseSource'
    | 'traceReason'
    | 'blockerClass'
    | 'remediationLaneId'
    | 'remediationRuntimePreference'
  >,
  explanation: string,
): string {
  return [
    `Why I classified this as ${formatClassificationLabel(record.classification)}:`,
    explanation,
    record.capabilityId ? `Capability: ${record.capabilityId}` : null,
    record.routeKey ? `Route key: ${record.routeKey}` : null,
    record.responseSource ? `Response source: ${record.responseSource}` : null,
    record.traceReason ? `Trace reason: ${record.traceReason}` : null,
    record.blockerClass ? `Blocker class: ${record.blockerClass}` : null,
    record.remediationLaneId
      ? `Prepared lane: ${record.remediationLaneId}${record.remediationRuntimePreference ? ` (${record.remediationRuntimePreference})` : ''}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function selectResponseFeedbackLane(
  availability: ResponseFeedbackLaneAvailability,
): ResponseFeedbackLaneSelection {
  if (availability.cursorCloudAvailable) {
    return {
      laneId: 'cursor',
      runtimePreference: 'cursor_cloud',
      label: 'Cursor Cloud',
      promptPrefix: '',
      reason:
        availability.cursorCloudDetail ||
        'Cursor Cloud is the healthiest queued remediation lane available right now.',
    };
  }

  if (availability.runtimeAvailable && availability.runtimeCloudAllowed) {
    return {
      laneId: 'andrea_runtime',
      runtimePreference: 'codex_cloud',
      label: 'Codex cloud',
      promptPrefix: '[runtime: cloud]',
      reason:
        availability.runtimeDetail ||
        'The Codex/OpenAI runtime lane is healthy, but local execution is not the best ready path right now.',
    };
  }

  if (availability.runtimeAvailable && availability.runtimeLocalPreferred) {
    return {
      laneId: 'andrea_runtime',
      runtimePreference: 'codex_local',
      label: 'Codex local',
      promptPrefix: '[runtime: local]',
      reason:
        availability.runtimeDetail ||
        'No cloud repair lane is ready, so Andrea is falling back to authenticated Codex local on this host.',
    };
  }

  if (availability.cursorDesktopAvailable) {
    return {
      laneId: null,
      runtimePreference: 'cursor_local',
      label: 'Cursor desktop bridge',
      promptPrefix: '',
      reason:
        availability.cursorDesktopDetail ||
        'The desktop bridge is reachable, but queued self-fix jobs still belong on Cursor Cloud in the current product.',
    };
  }

  return {
    laneId: null,
    runtimePreference: null,
    label: 'No ready remediation lane',
    promptPrefix: '',
    reason:
      'Neither the Codex/OpenAI runtime lane nor Cursor Cloud is healthy enough to auto-start a remediation job right now.',
  };
}

export function selectResponseFeedbackRetryLane(params: {
  record: Pick<
    ResponseFeedbackRecord,
    'status' | 'remediationRuntimePreference'
  >;
  availability: ResponseFeedbackLaneAvailability;
}): ResponseFeedbackLaneSelection {
  const selection = selectResponseFeedbackLane(params.availability);
  if (
    params.record.status === 'failed' &&
    params.record.remediationRuntimePreference === 'codex_local' &&
    selection.laneId === 'andrea_runtime' &&
    selection.runtimePreference === 'codex_local' &&
    params.availability.runtimeAvailable &&
    params.availability.runtimeCloudAllowed
  ) {
    return {
      laneId: 'andrea_runtime',
      runtimePreference: 'codex_cloud',
      label: 'Codex cloud',
      promptPrefix: '[runtime: cloud]',
      reason:
        'Codex local already failed on this feedback item, so Andrea is retrying in Codex cloud.',
    };
  }

  return selection;
}

function buildExpectedBehavior(
  record: Pick<
    ResponseFeedbackRecord,
    'originalUserText' | 'routeKey' | 'capabilityId' | 'classification'
  >,
): string {
  const ask = normalizeText(record.originalUserText).toLowerCase();
  const routeKey = normalizeText(record.routeKey).toLowerCase();
  const capabilityId = normalizeText(record.capabilityId).toLowerCase();

  if (
    /\b(news|headlines|latest news|news today|what(?:’|')?s the news|today(?:’|')?s news)\b/.test(
      ask,
    )
  ) {
    return 'Answer with the current news when the live lane is available, or say clearly that live news is blocked and offer the best local fallback instead of a canned reply.';
  }
  if (routeKey.includes('calendar') || capabilityId.includes('calendar')) {
    return 'Answer as a calendar request, keep the same-thread continuation intact, and ask only for the one missing detail when needed.';
  }
  if (
    routeKey.includes('communication') ||
    capabilityId.includes('communication')
  ) {
    return 'Give a grounded draft or summary, preserve rewrite continuity, and avoid generic or template-shaped reply help.';
  }
  if (routeKey.includes('daily') || capabilityId.includes('daily')) {
    return 'Give a grounded, concise daily-guidance answer with one practical next step and no system-shaped scaffolding.';
  }
  if (record.classification === 'externally_blocked') {
    return 'Keep the blocker honest and useful-first. Improve routing or fallback wording only if that makes the blocked path clearer.';
  }
  return 'Answer the user’s ask directly, or give one clear clarification/fallback instead of drifting into canned or generic copy.';
}

function buildTraceSummary(
  record: Pick<
    ResponseFeedbackRecord,
    | 'capabilityId'
    | 'routeKey'
    | 'responseSource'
    | 'traceReason'
    | 'blockerClass'
  >,
): string[] {
  return [
    record.capabilityId ? `- Capability: ${record.capabilityId}` : null,
    record.routeKey ? `- Route key: ${record.routeKey}` : null,
    record.responseSource
      ? `- Response source: ${record.responseSource}`
      : null,
    record.traceReason ? `- Trace reason: ${record.traceReason}` : null,
    record.blockerClass ? `- Blocker class: ${record.blockerClass}` : null,
  ].filter((line): line is string => Boolean(line));
}

export function buildResponseFeedbackRemediationPrompt(params: {
  record: ResponseFeedbackRecord;
  laneSelection: ResponseFeedbackLaneSelection;
  hostTruthLines: string[];
}): string {
  const { record, laneSelection, hostTruthLines } = params;
  const expectedBehavior = buildExpectedBehavior(record);
  const traceSummary = buildTraceSummary(record);
  const prefix = laneSelection.promptPrefix
    ? `${laneSelection.promptPrefix}\n\n`
    : '';
  const approvalScope =
    record.linkedRefs?.repairApprovalScope ||
    'No landing approval has been granted yet; prepare a bounded fix and stop before commit/push/restart unless a later approval scope says otherwise.';
  const fallbackPolicy =
    record.linkedRefs?.repairFallbackPolicy ||
    'Use the selected repair lane only; do not silently fall back to local execution.';
  return [
    prefix +
      'Andrea just received a Telegram main-control-chat reply that was downvoted as `Not helpful`.',
    'Fix only the smallest repo-side issue that would make this class of reply better.',
    '',
    'Downvoted exchange:',
    `- Original ask: ${record.originalUserText}`,
    `- Andrea reply: ${record.assistantReplyText}`,
    `- Classification: ${formatClassificationLabel(record.classification)}`,
    ...traceSummary,
    '',
    'Expected correct behavior:',
    `- ${expectedBehavior}`,
    '',
    'Current host truth to preserve:',
    ...hostTruthLines.map((line) => `- ${line}`),
    '',
    'Implementation rules:',
    '- Do not add broad new product surface or another routing stack.',
    '- Keep Telegram as the richer action surface and preserve current trust boundaries.',
    '- If this turns out to be mainly an external/manual blocker, do not overclaim a code bug. Improve fallback wording or routing only if that would help.',
    '- Keep the fix small and repo-local.',
    `- Repair approval scope: ${approvalScope}`,
    `- Fallback policy: ${fallbackPolicy}`,
    '',
    'Validation before you report success:',
    '- Run focused tests for touched areas.',
    '- Run npm run typecheck.',
    '- Run npm run build.',
    '- Run npm test.',
    '- If messaging or Telegram behavior changed, rerun npm run telegram:user:smoke.',
    '',
    'Local host handling:',
    '- Commit, push, restart, or deploy only when the active repair approval scope explicitly authorizes landing and the required tests/builds pass.',
    '- If landing is not authorized, stop with the hotfix ready for review and report exactly what changed and what passed.',
    '- If landing is authorized and validation passed on this host, restart with npm run services:restart and link the verification evidence.',
    '',
    'Required final worker result contract:',
    '- End with one JSON object named `repairWorkerResult`.',
    '- Include: status, changedFiles, testsRun, testsPassed, patchArtifact, commitSha, blockerClass, needsLocalApply, verificationSummary, nextLegalAction.',
    '- Use status `verified` only when the focused tests/builds passed. Use `failed_tests`, `blocked_external`, or `needs_local_landing` when appropriate.',
    '- Do not include secrets, tokens, private message bodies, personal memory content, or raw credentials in the result.',
  ].join('\n');
}
