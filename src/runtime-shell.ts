import { AndreaOpenAiRuntimeError } from './andrea-openai-runtime.js';
import type {
  RegisteredGroup,
  RuntimeBackendJob,
  RuntimeBackendJobLogs,
  RuntimeBackendStatus,
  RuntimeBackendStopResult,
} from './types.js';
import { extractRuntimeBackendJobIdFromText } from './runtime-chat-context.js';
import { formatUserFacingOperationFailure } from './user-facing-error.js';

export function formatRuntimeThreadLabel(threadId: string): string {
  return threadId.length > 24 ? `${threadId.slice(0, 24)}...` : threadId;
}

export function clipRuntimeText(text: string, limit = 1200): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 3)}...`;
}

function summarizeRuntimeJob(job: RuntimeBackendJob): string {
  return (
    job.errorText ||
    job.finalOutputText ||
    job.latestOutputText ||
    'No backend output is available yet.'
  );
}

function renderJobLead(job: RuntimeBackendJob): string {
  if (job.status === 'failed') {
    return `Andrea OpenAI job ${job.jobId} failed.`;
  }

  if (job.status === 'succeeded') {
    return `Andrea OpenAI job ${job.jobId} finished.`;
  }

  if (job.stopRequested) {
    return `Andrea OpenAI job ${job.jobId} is stopping.`;
  }

  if (
    job.status === 'running' &&
    (job.finalOutputText || job.latestOutputText)
  ) {
    return `Andrea OpenAI job ${job.jobId} is still running, and useful output is already available.`;
  }

  if (job.status === 'running') {
    return `Andrea OpenAI job ${job.jobId} is running.`;
  }

  return `Andrea OpenAI job ${job.jobId} is queued.`;
}

function renderJobOutputLabel(job: RuntimeBackendJob): string {
  if (job.errorText) return 'Error summary';
  if (job.finalOutputText) return 'Final output';
  if (
    job.latestOutputText &&
    (job.status === 'running' || job.status === 'queued')
  ) {
    return 'Latest useful output';
  }
  return 'Output';
}

function renderRuntimeActionHints(job: RuntimeBackendJob): string[] {
  return [
    '- Reply: reply to this card to continue the same runtime job',
    '- Refresh: /runtime-job',
    '- Logs: /runtime-logs [LINES]',
    job.capabilities.stop ? '- Stop: /runtime-stop' : null,
    `- Fallback: /runtime-followup ${job.jobId} TEXT`,
  ].filter((line): line is string => Boolean(line));
}

function renderStatusVerdict(status: RuntimeBackendStatus): string {
  switch (status.state) {
    case 'available':
      return 'Andrea OpenAI backend is reachable and codex_local execution is authenticated.';
    case 'auth_required':
      return 'Andrea OpenAI backend is reachable, but codex_local still needs login on the backend host.';
    case 'not_ready':
      return 'Andrea OpenAI backend is not ready yet.';
    case 'unavailable':
      return 'Andrea OpenAI backend is unavailable on loopback.';
    case 'not_enabled':
      return 'Andrea OpenAI backend is not enabled in this NanoBot runtime.';
  }
}

export function formatRuntimeBackendStatusSummary(
  status: RuntimeBackendStatus,
  group: RegisteredGroup,
  backendUrl: string,
): string {
  return [
    renderStatusVerdict(status),
    '',
    '*Andrea OpenAI Backend*',
    `- Backend: ${status.backend}`,
    `- Group folder: ${group.folder}`,
    `- State: ${status.state}`,
    `- Version: ${status.version || 'unknown'}`,
    `- Transport: ${status.transport}`,
    `- URL: ${backendUrl}`,
    status.meta
      ? `- Local execution state: ${status.meta.localExecutionState}`
      : null,
    status.meta ? `- Auth state: ${status.meta.authState}` : null,
    status.detail ? `- Detail: ${status.detail}` : null,
    status.meta?.operatorGuidance
      ? `- Guidance: ${status.meta.operatorGuidance}`
      : null,
    '- Commands: /runtime-create, /runtime-jobs, /runtime-job, /runtime-followup, /runtime-logs, /runtime-stop',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function formatRuntimeBackendJobCard(job: RuntimeBackendJob): string {
  return [
    renderJobLead(job),
    '',
    '*Andrea OpenAI Runtime*',
    `- Job ID: ${job.jobId}`,
    `- Status: ${job.status}${job.stopRequested ? ' (stop requested)' : ''}`,
    `- Backend: ${job.backend}`,
    `- Group folder: ${job.groupFolder}`,
    job.selectedRuntime ? `- Selected runtime: ${job.selectedRuntime}` : null,
    job.threadId
      ? `- Thread continuity: ${formatRuntimeThreadLabel(job.threadId)}`
      : null,
    `- Prompt preview: ${clipRuntimeText(job.promptPreview, 280)}`,
    `- ${renderJobOutputLabel(job)}: ${clipRuntimeText(summarizeRuntimeJob(job), 600)}`,
    '',
    '*Current actions*',
    ...renderRuntimeActionHints(job),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function formatRuntimeBackendListLine(
  job: RuntimeBackendJob,
  index: number,
): string {
  return `${index + 1}. ${job.jobId} [${job.status}]${job.selectedRuntime ? ` runtime=${job.selectedRuntime}` : ''}${job.threadId ? ` thread=${formatRuntimeThreadLabel(job.threadId)}` : ''}`;
}

export function formatRuntimeBackendJobsMessage(params: {
  group: RegisteredGroup;
  jobs: RuntimeBackendJob[];
  nextBeforeJobId?: string | null;
  limit: number;
}): string {
  return [
    '*Andrea OpenAI Jobs*',
    `- Group folder: ${params.group.folder}`,
    ...params.jobs.map(formatRuntimeBackendListLine),
    params.nextBeforeJobId
      ? `- Next page: /runtime-jobs ${params.limit} ${params.nextBeforeJobId}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function formatRuntimeBackendCreateAcceptedMessage(
  job: RuntimeBackendJob,
): string {
  return `Andrea OpenAI job accepted.\n\n${formatRuntimeBackendJobCard(job)}`;
}

export function formatRuntimeBackendFollowupAcceptedMessage(
  job: RuntimeBackendJob,
): string {
  return `Andrea OpenAI follow-up accepted.\n\n${formatRuntimeBackendJobCard(job)}`;
}

export function formatRuntimeBackendStopMessage(
  result: RuntimeBackendStopResult,
): string {
  const { job } = result;
  const lead = result.liveStopAccepted
    ? `Stop requested for Andrea OpenAI job ${job.jobId}.`
    : job.status === 'succeeded' || job.status === 'failed'
      ? `Andrea OpenAI job ${job.jobId} is already finished.`
      : `Andrea OpenAI job ${job.jobId} is no longer active enough to accept a live stop.`;

  return `${lead}\n\n${formatRuntimeBackendJobCard(job)}`;
}

export function formatRuntimeBackendLogsMessage(
  result: RuntimeBackendJobLogs,
  job?: RuntimeBackendJob | null,
): string {
  if (result.logText?.trim()) {
    return [
      `Andrea OpenAI logs for ${result.jobId}.`,
      result.logFile ? `- Log file: ${result.logFile}` : null,
      '',
      clipRuntimeText(result.logText, 3200),
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  if (!job) {
    return `Andrea OpenAI logs are not available yet for job ${result.jobId}.`;
  }

  const lead =
    job.status === 'running' || job.status === 'queued'
      ? job.latestOutputText?.trim() || job.finalOutputText?.trim()
        ? `Andrea OpenAI logs are not ready yet for job ${result.jobId}, but useful output is already available.`
        : `Andrea OpenAI logs are not ready yet for job ${result.jobId}.`
      : `Andrea OpenAI log output is not available for job ${result.jobId}.`;

  return [
    lead,
    `- Current status: ${job.status}${job.stopRequested ? ' (stop requested)' : ''}`,
    `- Group folder: ${job.groupFolder}`,
    job.selectedRuntime ? `- Selected runtime: ${job.selectedRuntime}` : null,
    job.threadId
      ? `- Thread continuity: ${formatRuntimeThreadLabel(job.threadId)}`
      : null,
    `- ${renderJobOutputLabel(job)}: ${clipRuntimeText(summarizeRuntimeJob(job), 600)}`,
    '',
    '*Current actions*',
    ...renderRuntimeActionHints(job),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export { extractRuntimeBackendJobIdFromText };

export function formatRuntimeBackendFailure(
  err: unknown,
  chatJid: string,
  group: RegisteredGroup | undefined,
): string {
  if (err instanceof AndreaOpenAiRuntimeError) {
    const lines = [err.message];
    const groupFolder = group?.folder || err.groupFolder || null;

    if (
      err.kind === 'bootstrap_required' ||
      err.kind === 'bootstrap_failed' ||
      err.kind === 'not_enabled' ||
      err.kind === 'not_ready' ||
      err.kind === 'unavailable'
    ) {
      lines.push('- Backend: andrea_openai');
    }

    if (err.kind === 'bootstrap_required' || err.kind === 'bootstrap_failed') {
      lines.push(`- Source chat: ${chatJid}`);
    }

    if (err.kind === 'context_mismatch') {
      lines.push(`- Source chat: ${chatJid}`);
    }

    if (groupFolder) {
      lines.push(`- Group folder: ${groupFolder}`);
    }

    if (err.detail) {
      lines.push(`- Detail: ${err.detail}`);
    } else if (err.kind === 'not_found') {
      lines.push('- Detail: Check the job ID or page anchor and try again.');
    } else if (err.kind === 'validation') {
      lines.push('- Detail: Check the command arguments and try again.');
    }

    return lines.join('\n');
  }

  return formatUserFacingOperationFailure(
    'Andrea OpenAI backend operation failed',
    err,
  );
}
