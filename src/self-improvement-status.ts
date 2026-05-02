import type { ResponseFeedbackRecord, ScheduledTask } from './types.js';

const STATUS_MONITOR_PROMPT_PREFIX =
  'Send Andrea self-improvement status update';

function normalizeText(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim()
    .replace(/\s+/g, ' ');
}

function isSelfImprovementReference(message: string): boolean {
  return /\b(self[- ]?improvement|self[- ]?repair|self[- ]?fix|fix(?:ed|es|ing)? itself|repair(?:ed|s|ing)? itself|repair job|fix job|improvement job|downvote repair|not helpful repair)\b/i.test(
    message,
  );
}

export function isSelfImprovementStatusRequest(message: string): boolean {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  if (/\b(did it fix itself|has it fixed itself|did the fix land|did the repair land)\b/i.test(normalized)) {
    return true;
  }
  return (
    isSelfImprovementReference(normalized) &&
    /\b(status|update|progress|what happened|where (?:are we|is it)|is it running|did it work|fixed|landed)\b/i.test(
      normalized,
    )
  );
}

export function isSelfImprovementStatusFollowupRequest(message: string): boolean {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  return /\b(has it been a minute|been a minute|do not see an update|don't see an update|dont see an update|this is the update|what'?s the status|what is the status|is it running|did it work)\b/i.test(
    normalized,
  );
}

export function isSelfImprovementStatusMonitorRequest(message: string): boolean {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  return (
    /\b(?:update|status|progress)\b/i.test(normalized) &&
    /\b(?:every minute|each minute|once a minute|per minute|minute by minute)\b/i.test(
      normalized,
    ) &&
    (isSelfImprovementReference(normalized) ||
      /\b(self|repair|fix|job|status)\b/i.test(normalized))
  );
}

export function isSelfImprovementStatusTask(task: Pick<ScheduledTask, 'prompt'>): boolean {
  return task.prompt.startsWith(STATUS_MONITOR_PROMPT_PREFIX);
}

function formatWorker(record: ResponseFeedbackRecord): string {
  switch (record.remediationRuntimePreference) {
    case 'cursor_cloud':
      return 'Cursor Cloud';
    case 'codex_cloud':
      return 'Codex cloud';
    case 'codex_local':
      return 'Codex local fallback';
    case 'cursor_local':
      return 'Cursor desktop bridge';
    default:
      return 'none selected';
  }
}

function formatStatusMeaning(record: ResponseFeedbackRecord): string {
  switch (record.status) {
    case 'landed':
      return 'landed';
    case 'resolved_locally':
      return 'fixed locally, waiting on landing approval';
    case 'running':
      return 'repair is running';
    case 'awaiting_confirmation':
      return 'repair is staged and waiting for approval';
    case 'captured':
      return 'captured for review';
    case 'failed':
      return 'repair attempt failed';
    case 'blocked_external':
      return 'blocked by an external/manual dependency';
    case 'manual_sync_only':
      return 'manual sync only';
    case 'cancelled':
      return 'cancelled';
    default:
      return record.status;
  }
}

function formatNextAction(record: ResponseFeedbackRecord): string {
  if (record.status === 'landed') return 'No action needed unless the behavior regresses.';
  if (record.status === 'resolved_locally') return 'Use the feedback card landing action after validation.';
  if (record.status === 'running') return 'Wait for the repair job to finish, then refresh status.';
  if (
    record.status === 'awaiting_confirmation' &&
    record.remediationRuntimePreference === 'codex_local'
  ) {
    return 'Cloud repair is not ready; use Approve local fallback only if you want this host to run Codex locally.';
  }
  if (record.status === 'awaiting_confirmation') {
    return 'Use Approve repair on the feedback card to start the bounded repair run.';
  }
  if (record.status === 'failed') return 'Use Retry fix, preferably on a cloud lane if available.';
  if (record.status === 'blocked_external' || record.status === 'manual_sync_only') {
    return 'Fix the external/manual blocker; repo code should not fake this.';
  }
  return 'Review the feedback card or ask for a repair plan.';
}

export function buildSelfImprovementStatusText(
  records: ResponseFeedbackRecord[],
  now = new Date(),
): string {
  const active = records.filter((record) =>
    [
      'awaiting_confirmation',
      'running',
      'failed',
      'resolved_locally',
      'landed',
      'captured',
    ].includes(record.status),
  );
  const latest = active[0] || records[0] || null;
  if (!latest) {
    return [
      '*Self-Improvement Status*',
      'I do not see an active feedback repair item yet.',
      'If a reply misses, tap Not helpful and I will stage a bounded diagnosis and repair plan instead of silently running a local job.',
      `Checked: ${now.toISOString()}`,
    ].join('\n');
  }

  const lines = [
    '*Self-Improvement Status*',
    `Latest item: ${formatStatusMeaning(latest)}.`,
    `Feedback: ${latest.feedbackId}`,
    latest.issueId ? `Pilot issue: ${latest.issueId}` : null,
    latest.linkedRefs?.platformRepairPlanId
      ? `Repair plan: ${latest.linkedRefs.platformRepairPlanId}`
      : 'Repair plan: not linked yet',
    latest.remediationJobId ? `Repair job: ${latest.remediationJobId}` : null,
    `Selected worker: ${formatWorker(latest)}.`,
    latest.operatorNote ? `Note: ${normalizeText(latest.operatorNote).slice(0, 220)}` : null,
    `Next action: ${formatNextAction(latest)}`,
    `Open tracked items: ${active.length}`,
    `Checked: ${now.toISOString()}`,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

export function planSelfImprovementStatusMonitor(
  message: string,
  groupFolder: string,
  chatJid: string,
  now = new Date(),
): { confirmation: string; task: Omit<ScheduledTask, 'last_run' | 'last_result'> } | null {
  if (!isSelfImprovementStatusMonitorRequest(message)) return null;
  const nextRun = new Date(now.getTime() + 60_000);
  return {
    confirmation:
      "Okay. I'll send a self-improvement status update every minute until you pause or delete that scheduled task.",
    task: {
      id: `task-self-improvement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: `${STATUS_MONITOR_PROMPT_PREFIX} for recent response-feedback repair runs.`,
      script: null,
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: nextRun.toISOString(),
      status: 'active',
      created_at: now.toISOString(),
    },
  };
}

export function buildScheduledSelfImprovementStatusUpdate(
  task: Pick<ScheduledTask, 'prompt'>,
  records: ResponseFeedbackRecord[],
  now = new Date(),
): string | null {
  if (!isSelfImprovementStatusTask(task)) return null;
  return buildSelfImprovementStatusText(records, now);
}
