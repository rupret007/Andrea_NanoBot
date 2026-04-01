import type {
  BackendLaneId,
  BackendPrimaryOutputResult,
} from './backend-lanes/types.js';

export function formatOpaqueTaskId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-6)}`;
}

export type ShellTaskLane = 'cursor_cloud' | 'cursor_desktop' | 'codex_runtime';

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
  const normalized = (status || '')
    .trim()
    .toLowerCase()
    .replace(/^\[+/, '')
    .replace(/\]+$/, '');
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

export function formatTaskLaneLabel(lane: ShellTaskLane): string {
  if (lane === 'cursor_cloud') return 'Cursor Cloud';
  if (lane === 'cursor_desktop') return 'Cursor Desktop';
  return 'Codex/OpenAI runtime';
}

export function formatCurrentFocusLabel(
  laneId: BackendLaneId | null | undefined,
): string {
  if (laneId === 'andrea_runtime') return 'Codex/OpenAI runtime';
  if (laneId === 'cursor') return 'Cursor';
  return 'none selected yet';
}

export function formatTaskUpdatedLine(
  updatedAt: string | null | undefined,
): string | null {
  return updatedAt ? `Updated: ${updatedAt}` : null;
}

export function formatTaskOutputHeading(
  source: BackendPrimaryOutputResult['source'],
): string {
  if (source === 'logs') return 'Recent activity';
  if (source === 'none') return 'Output';
  return 'Current output';
}

export function stripLeadingMarkdownTitle(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return '';

  const lines = trimmed.split('\n');
  const firstLine = lines[0]?.trim() || '';
  if (/^\*[^*].*[^*]\*$/.test(firstLine)) {
    return lines.slice(1).join('\n').trim();
  }
  return trimmed;
}

export function formatWorkPanel(params: {
  title: string;
  lines?: Array<string | null | undefined>;
  sections?: Array<string | null | undefined>;
  next?: string | null;
}): string {
  const rendered: string[] = [params.title];
  const lines = (params.lines || []).filter((line): line is string =>
    Boolean(line),
  );
  const sections = (params.sections || []).filter(
    (section): section is string => Boolean(section),
  );

  if (lines.length > 0) {
    rendered.push(...lines);
  }

  if (sections.length > 0) {
    rendered.push('');
    sections.forEach((section, index) => {
      if (index > 0) rendered.push('');
      rendered.push(section);
    });
  }

  if (params.next) {
    rendered.push('', params.next);
  }

  return rendered.join('\n');
}

export function formatTaskNextStepMessage(params: {
  primaryActions: string;
  canReplyContinue?: boolean;
  explicitFallback?: string | null;
}): string {
  return [
    'Next:',
    `- ${params.primaryActions}`,
    ...(params.canReplyContinue
      ? ['- Reply with plain text to continue this task.']
      : []),
    ...(params.explicitFallback ? [`- ${params.explicitFallback}`] : []),
  ].join('\n');
}

export function formatTaskContinuationGuidance(params: {
  lane: ShellTaskLane;
  canReplyContinue?: boolean;
}): string {
  if (params.lane === 'cursor_desktop') {
    return 'Tap below to refresh this session, view output, or use machine-side terminal controls.';
  }

  if (params.lane === 'codex_runtime' && !params.canReplyContinue) {
    return 'Tap below to refresh this task or view output. New runtime execution stays off on this host until it is explicitly enabled.';
  }

  if (params.lane === 'cursor_cloud') {
    return 'Tap below to refresh this task, view output, or check results. Reply with plain text to continue this task.';
  }

  return 'Tap below to refresh this task or view output. Reply with plain text to continue this task.';
}

export function formatTaskReplyPrompt(params: {
  lane: ShellTaskLane;
  taskId: string;
}): string {
  return [
    'Reply here with what Andrea should change next for this task.',
    `Task: ${formatTaskLaneLabel(params.lane)} ${formatOpaqueTaskId(params.taskId)}.`,
  ].join('\n');
}

export function formatTaskReplyRoutingGuidance(): string {
  return 'Replying to a task card always continues that task. Otherwise Andrea uses the current task in the lane you opened.';
}

export function formatShellTaskCard(params: {
  title: string;
  lane: ShellTaskLane;
  status: string | null | undefined;
  systemStatus?: string | null | undefined;
  detailLines?: Array<string | null | undefined>;
  summary?: string | null;
  updatedAt?: string | null | undefined;
}): string {
  return [
    params.title,
    `Lane: ${formatTaskLaneLabel(params.lane)}`,
    `Status: ${formatHumanTaskStatus(params.status)}`,
    `System status: ${formatSystemStatus(
      params.systemStatus === undefined ? params.status : params.systemStatus,
    )}`,
    ...((params.detailLines || []).filter((line): line is string =>
      Boolean(line),
    ) || []),
    params.summary ? `Summary: ${params.summary}` : null,
    formatTaskUpdatedLine(params.updatedAt),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
