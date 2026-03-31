import type { BackendLaneId } from './backend-lanes/types.js';
import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
} from './user-facing-error.js';

function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/[. ]+$/, '');
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || '';
  return typeof err === 'string' ? err : '';
}

function getBackendOperatorDetail(
  laneId: BackendLaneId,
  err: unknown,
): string | null {
  const message = normalizeErrorMessage(err).trim();
  if (!message) return null;

  const safePatterns =
    laneId === 'cursor'
      ? [
          /^cursor is not configured\./i,
          /^cursor cloud is not configured\./i,
          /^cursor cloud is required/i,
          /^cursor desktop bridge is not configured\./i,
          /^cursor cloud job control is only supported/i,
          /^cursor model listing is only available/i,
          /^cursor results are only available/i,
          /^cursor artifact listing is only available/i,
          /^cursor download links are only available/i,
          /^cursor artifact links are only available/i,
          /^desktop bridge sessions are not part of the queued cloud/i,
          /^cursor desktop sessions do not expose artifact/i,
          /^cursor terminal control is only available/i,
          /^cursor agent id is required\./i,
          /^invalid cursor agent id /i,
          /^cursor group folder is required/i,
        ]
      : [
          /^andrea runtime execution is integrated but not enabled/i,
          /^no runtime job found for /i,
          /^no runtime thread found for /i,
          /^no registered group found for folder /i,
          /^follow-up requires one of: jobid, threadid, or groupfolder\./i,
          /^follow-up target mismatch:/i,
          /^runtime group folder is required/i,
          /^andrea runtime jobs do not expose shell file results yet\./i,
        ];

  return safePatterns.some((pattern) => pattern.test(message)) ? message : null;
}

function laneLabel(laneId: BackendLaneId): string {
  return laneId === 'andrea_runtime' ? 'Andrea runtime' : 'Cursor';
}

export function formatBackendOperationFailure(params: {
  laneId: BackendLaneId;
  operation: string;
  err: unknown;
  targetDisplay?: string | null;
  guidance?: string | null;
}): string {
  const prefix = `${normalizePrefix(params.operation)}${params.targetDisplay ? ` for ${params.targetDisplay}` : ''}`;
  const detail =
    getBackendOperatorDetail(params.laneId, params.err) ||
    getUserFacingErrorDetail(params.err);
  const lines = [`${prefix}. ${detail}`];
  if (params.guidance) {
    lines.push('', params.guidance);
  }
  return lines.join('\n');
}

export function formatBackendUnsupportedCapability(params: {
  laneId: BackendLaneId;
  operation: string;
  targetDisplay?: string | null;
  guidance?: string | null;
}): string {
  const lines = [
    `${normalizePrefix(params.operation)}${params.targetDisplay ? ` for ${params.targetDisplay}` : ''} is not available for ${laneLabel(params.laneId)} in this shell.`,
  ];
  if (params.guidance) {
    lines.push('', params.guidance);
  }
  return lines.join('\n');
}

export function formatBackendGenericFailure(
  prefix: string,
  err: unknown,
): string {
  return formatUserFacingOperationFailure(prefix, err);
}
