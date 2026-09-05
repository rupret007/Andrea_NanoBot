import type {
  BackendGetJobParams,
  BackendJobDetails,
} from './backend-lanes/types.js';
import type { RuntimeBackendJobCacheRecord } from './types.js';

export type RuntimeWorkRecoveryUnavailableReason =
  | 'not_enabled'
  | 'unavailable'
  | 'not_ready'
  | 'bootstrap_required'
  | 'bootstrap_failed'
  | 'context_mismatch'
  | 'invalid_response'
  | 'unknown';

export interface RuntimeWorkCachedMetadata {
  jobId: string;
  status: string;
  updatedAt: string;
  freshness: 'stale';
}

export type RuntimeWorkRecovery =
  | {
      kind: 'available';
      selectedJobId: string;
      job: BackendJobDetails;
      freshness: 'current';
    }
  | {
      kind: 'missing';
      selectedJobId: string | null;
      reason: 'not-selected' | 'not-found';
    }
  | {
      kind: 'unavailable';
      selectedJobId: string;
      reason: RuntimeWorkRecoveryUnavailableReason;
      cached: RuntimeWorkCachedMetadata | null;
    };

export interface RuntimeWorkRecoveryParams {
  selectedJobId: string | null;
  groupFolder: string;
  chatJid: string;
  getJob(params: BackendGetJobParams): Promise<BackendJobDetails | null>;
  getCachedJob?(jobId: string): RuntimeBackendJobCacheRecord | undefined;
}

export function getRuntimeWorkRecoveryReply(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  return payload?.readOnlyRecovery === true
    ? 'This is a status-recovery card, not a continuation prompt. Tap Check again to verify the selected task first. Nothing was started, continued, or stopped.'
    : null;
}

const RUNTIME_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed']);
const UNAVAILABLE_REASONS = new Set<RuntimeWorkRecoveryUnavailableReason>([
  'not_enabled',
  'unavailable',
  'not_ready',
  'bootstrap_required',
  'bootstrap_failed',
  'context_mismatch',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function validRecordedTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    time >= 0 &&
    time <= Date.now() &&
    calendar.getUTCFullYear() === Number(year) &&
    calendar.getUTCMonth() + 1 === Number(month) &&
    calendar.getUTCDate() === Number(day)
  );
}

function cachedMetadata(
  params: RuntimeWorkRecoveryParams,
  selectedJobId: string,
): RuntimeWorkCachedMetadata | null {
  try {
    const cached = params.getCachedJob?.(selectedJobId);
    if (
      !cached ||
      cached.backend_id !== 'andrea_openai' ||
      cached.job_id !== selectedJobId ||
      cached.group_folder !== params.groupFolder ||
      cached.chat_jid !== params.chatJid ||
      !RUNTIME_STATUSES.has(cached.status) ||
      !validRecordedTimestamp(cached.updated_at)
    ) {
      return null;
    }
    // A narrow projection, never a fallback current job. Do not parse raw_json
    // or return cached prompts, output, errors, paths, or action capabilities.
    return {
      jobId: selectedJobId,
      status: cached.status,
      updatedAt: cached.updated_at,
      freshness: 'stale',
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Optional stale metadata never justifies losing the recovery handle.
  } catch {
    // A failed cache read must not hide the retained selection or leak details.
    return null;
  }
}

function receiptMatches(
  job: unknown,
  selectedJobId: string,
  groupFolder: string,
): job is BackendJobDetails {
  if (!object(job) || !object(job.handle) || !object(job.metadata))
    return false;
  if (
    job.handle.laneId !== 'andrea_runtime' ||
    job.handle.jobId !== selectedJobId ||
    job.metadata.groupFolder !== groupFolder ||
    typeof job.title !== 'string' ||
    typeof job.laneLabel !== 'string' ||
    typeof job.status !== 'string' ||
    !RUNTIME_STATUSES.has(job.status) ||
    !nullableString(job.summary) ||
    !nullableString(job.createdAt) ||
    !nullableString(job.updatedAt) ||
    !object(job.capabilities)
  ) {
    return false;
  }
  const capabilities = job.capabilities;
  return (
    [
      'canCreateJob',
      'canFollowUp',
      'canGetLogs',
      'canStop',
      'canRefresh',
      'canViewOutput',
      'canViewFiles',
    ].every((key) => typeof capabilities[key] === 'boolean') &&
    Array.isArray(capabilities.actionIds) &&
    capabilities.actionIds.every((action) => typeof action === 'string')
  );
}

/**
 * Resolve exactly the selected task. Only the lane's explicit null is evidence
 * of absence; any failure keeps the selection recoverable. In particular, this
 * does not inventory tasks or invoke the list route's group bootstrap behavior.
 */
export async function resolveRuntimeWorkRecovery(
  params: RuntimeWorkRecoveryParams,
): Promise<RuntimeWorkRecovery> {
  const { selectedJobId } = params;
  if (selectedJobId === null) {
    return { kind: 'missing', selectedJobId, reason: 'not-selected' };
  }
  if (
    !selectedJobId.trim() ||
    selectedJobId.length > 4096 ||
    [...selectedJobId].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return {
      kind: 'unavailable',
      selectedJobId,
      reason: 'invalid_response',
      cached: null,
    };
  }
  try {
    const job = await params.getJob({
      handle: { laneId: 'andrea_runtime', jobId: selectedJobId },
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    });
    if (job === null) {
      return { kind: 'missing', selectedJobId, reason: 'not-found' };
    }
    if (!receiptMatches(job, selectedJobId, params.groupFolder)) {
      return {
        kind: 'unavailable',
        selectedJobId,
        reason: 'invalid_response',
        cached: cachedMetadata(params, selectedJobId),
      };
    }
    return { kind: 'available', selectedJobId, job, freshness: 'current' };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unknown read errors are deliberately unavailable, never evidence of deletion.
  } catch (error) {
    const kind = object(error) ? error.kind : null;
    const reason =
      typeof kind === 'string' &&
      UNAVAILABLE_REASONS.has(kind as RuntimeWorkRecoveryUnavailableReason)
        ? (kind as RuntimeWorkRecoveryUnavailableReason)
        : 'unknown';
    return {
      kind: 'unavailable',
      selectedJobId,
      reason,
      cached: cachedMetadata(params, selectedJobId),
    };
  }
}
