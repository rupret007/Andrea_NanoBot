export const RUNTIME_BACKEND_CARD_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

export type RuntimeSelectionAction = 'view' | 'logs' | 'stop';

export interface RuntimeJobTargetResolution {
  jobId: string | null;
  usedSelection: boolean;
  missingSelection: boolean;
}

export interface RuntimeLogsTargetResolution
  extends RuntimeJobTargetResolution {
  limit: number;
}

export interface RuntimeReplyContextResolution {
  kind: 'not_runtime_reply' | 'missing' | 'expired' | 'ready';
  jobIdHint: string | null;
  jobId: string | null;
}

function parsePositiveIntCapped(
  rawValue: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(rawValue || '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(max, parsed)
    : fallback;
}

export function computeRuntimeCardContextExpiry(
  createdAtIso: string,
  ttlMs = RUNTIME_BACKEND_CARD_CONTEXT_TTL_MS,
): string {
  return new Date(new Date(createdAtIso).getTime() + ttlMs).toISOString();
}

export function extractRuntimeBackendJobIdFromText(
  text: string,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const cardMatch = trimmed.match(/^(?:- )?Job ID:\s*(\S+)/m);
  if (cardMatch?.[1]) return cardMatch[1];

  const acceptedMatch = trimmed.match(
    /Andrea OpenAI (?:job|follow-up) ([A-Za-z0-9_.:-]+)/i,
  );
  if (acceptedMatch?.[1]) return acceptedMatch[1];

  const logsMatch = trimmed.match(/Andrea OpenAI logs for ([A-Za-z0-9_.:-]+)/i);
  if (logsMatch?.[1]) return logsMatch[1];

  const commandFallbackMatch = trimmed.match(
    /\/(?:runtime|codex)-(?:job|followup|logs|stop)\s+([A-Za-z0-9_.:-]+)/i,
  );
  if (commandFallbackMatch?.[1]) return commandFallbackMatch[1];

  return null;
}

export function isRuntimeBackendCardText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (extractRuntimeBackendJobIdFromText(trimmed)) return true;

  return (
    trimmed.includes('Andrea OpenAI logs are not ready yet') ||
    trimmed.includes('Andrea OpenAI log output is not available') ||
    trimmed.includes('Stop requested for Andrea OpenAI job') ||
    trimmed.includes('Andrea OpenAI job is already finished') ||
    trimmed.includes('Andrea OpenAI job is no longer active enough')
  );
}

export function buildRuntimeReplyContextMissingMessage(
  jobIdHint: string | null = null,
): string {
  const fallback = jobIdHint
    ? `/runtime-followup ${jobIdHint} TEXT`
    : '/runtime-followup JOB_ID TEXT';
  return [
    'I can only continue a runtime job when that reply points to a fresh Andrea runtime card.',
    `Use ${fallback} if the card context is missing or stale.`,
  ].join(' ');
}

export function buildRuntimeSelectionMissingMessage(
  action: RuntimeSelectionAction,
): string {
  const actionLabel =
    action === 'view'
      ? '/runtime-job JOB_ID'
      : action === 'logs'
        ? '/runtime-logs JOB_ID [LINES]'
        : '/runtime-stop JOB_ID';
  return [
    'There is no current Andrea runtime job selected for this chat.',
    `Use ${actionLabel} to target a specific backend job.`,
  ].join(' ');
}

export function resolveRuntimeJobTarget(
  explicitJobId: string | undefined,
  selectedJobId: string | null,
): RuntimeJobTargetResolution {
  const trimmed = explicitJobId?.trim() || '';
  if (trimmed) {
    return {
      jobId: trimmed,
      usedSelection: false,
      missingSelection: false,
    };
  }

  if (selectedJobId) {
    return {
      jobId: selectedJobId,
      usedSelection: true,
      missingSelection: false,
    };
  }

  return {
    jobId: null,
    usedSelection: false,
    missingSelection: true,
  };
}

export function resolveRuntimeLogsTarget(
  firstToken: string | undefined,
  secondToken: string | undefined,
  selectedJobId: string | null,
  defaultLimit = 40,
  maxLimit = 120,
): RuntimeLogsTargetResolution {
  const first = (firstToken || '').trim();
  const second = (secondToken || '').trim();

  if (!first) {
    return {
      ...resolveRuntimeJobTarget(undefined, selectedJobId),
      limit: defaultLimit,
    };
  }

  const parsedFirstLimit = Number.parseInt(first, 10);
  if (
    selectedJobId &&
    Number.isFinite(parsedFirstLimit) &&
    parsedFirstLimit > 0 &&
    /^[0-9]+$/.test(first)
  ) {
    return {
      jobId: selectedJobId,
      usedSelection: true,
      missingSelection: false,
      limit: Math.min(maxLimit, parsedFirstLimit),
    };
  }

  return {
    ...resolveRuntimeJobTarget(first, selectedJobId),
    limit: parsePositiveIntCapped(second, defaultLimit, maxLimit),
  };
}

export function resolveRuntimeReplyContext(params: {
  replyMessageId?: string;
  replyText?: string;
  contextMessageId?: string;
  contextJobId?: string;
  contextGroupFolder?: string;
  currentGroupFolder: string;
  expiresAt?: string;
  nowIso: string;
}): RuntimeReplyContextResolution {
  const replyText = params.replyText?.trim() || '';
  const replyMessageId = params.replyMessageId?.trim() || '';
  if (!replyText || !replyMessageId || !isRuntimeBackendCardText(replyText)) {
    return {
      kind: 'not_runtime_reply',
      jobIdHint: null,
      jobId: null,
    };
  }

  const jobIdHint = extractRuntimeBackendJobIdFromText(replyText);
  if (
    !params.contextMessageId ||
    params.contextMessageId !== replyMessageId ||
    !params.contextJobId ||
    !params.contextGroupFolder ||
    params.contextGroupFolder !== params.currentGroupFolder
  ) {
    return {
      kind: 'missing',
      jobIdHint,
      jobId: null,
    };
  }

  if (params.expiresAt && params.expiresAt <= params.nowIso) {
    return {
      kind: 'expired',
      jobIdHint,
      jobId: null,
    };
  }

  return {
    kind: 'ready',
    jobIdHint,
    jobId: params.contextJobId,
  };
}
