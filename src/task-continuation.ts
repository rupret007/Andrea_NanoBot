import type { BackendLaneId } from './backend-lanes/types.js';

export type TaskContextType = 'job_card' | 'output' | 'results' | 'activity';

export interface TaskMessageContextPayload extends Record<string, unknown> {
  taskContextType?: TaskContextType;
  taskTitle?: string | null;
  taskSummary?: string | null;
  outputPreview?: string | null;
  outputSource?: string | null;
}

export type TaskContinuationKind =
  | 'retry'
  | 'revise_shorter'
  | 'revise_more_detail'
  | 'adapt_variant'
  | 'fix_issue'
  | 'generic_continue'
  | 'fresh_instruction';

export interface InterpretTaskContinuationParams {
  laneId: BackendLaneId;
  rawPrompt: string;
  contextKind?: TaskContextType | null;
  messageContextPayload?: Record<string, unknown> | null;
  taskLabel?: string;
  taskId?: string;
}

export interface InterpretedTaskContinuation {
  normalizedPromptText: string;
  continuationKind: TaskContinuationKind;
  usedVisibleContext: boolean;
  suggestedReplyExamples?: string[];
}

const DEFAULT_SUGGESTED_REPLY_EXAMPLES = [
  'make it shorter',
  'add more detail',
  'adapt it for X',
];

const TIGHTEN_PATTERNS = new Set([
  'make it shorter',
  'shorter',
  'tighten this',
]);
const EXPAND_PATTERNS = new Set([
  'add more detail',
  'expand this',
  'make it more detailed',
]);
const FIX_PATTERNS = new Set([
  'fix that',
  'fix it',
  'correct that',
  'improve that',
  'improve it',
  'clean that up',
  'make this better',
]);
const RETRY_PATTERNS = new Set(['try again', 'retry', 'do it again']);
const CONTINUE_PATTERNS = new Set(['continue', 'go ahead', 'use that']);
const HARMLESS_ACK_PATTERNS = new Set([
  'thanks',
  'thank you',
  'thx',
  'ok',
  'okay',
  'ok thanks',
  'okay thanks',
  'hi',
  'hello',
]);

function normalizeLoosePhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[,.\s]+|[,.!?\s]+$/g, '')
    .replace(/^please\s+/, '')
    .replace(/\s+/g, ' ');
}

export function summarizeVisibleTaskText(
  text: string | null | undefined,
  maxLength = 280,
): string | null {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function readTextField(
  payload: Record<string, unknown> | null | undefined,
  key: keyof TaskMessageContextPayload,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getTaskContextType(
  payload: Record<string, unknown> | null | undefined,
  fallback?: TaskContextType | null,
): TaskContextType | null {
  const payloadValue = payload?.taskContextType;
  if (
    payloadValue === 'job_card' ||
    payloadValue === 'output' ||
    payloadValue === 'results' ||
    payloadValue === 'activity'
  ) {
    return payloadValue;
  }
  return fallback || null;
}

export function mergeTaskMessageContextPayload(
  basePayload: Record<string, unknown> | null | undefined,
  additions: TaskMessageContextPayload,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {
    ...(basePayload || {}),
    ...additions,
  };
  const entries = Object.entries(merged).filter(([, value]) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function maybeBuildHarmlessTaskReply(rawPrompt: string): string | null {
  const normalized = normalizeLoosePhrase(rawPrompt);
  if (!normalized || !HARMLESS_ACK_PATTERNS.has(normalized)) {
    return null;
  }
  if (normalized === 'hi' || normalized === 'hello') {
    return "I'm here. Reply with what Andrea should change next for this task when you're ready.";
  }
  return "Happy to. Reply with what Andrea should change next for this task when you're ready.";
}

function extractAdaptationTarget(normalized: string): string | null {
  const patterns = [
    /^do that but for\s+(.+)$/i,
    /^same thing for\s+(.+)$/i,
    /^make a version for\s+(.+)$/i,
    /^adapt (?:it|that) for\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function buildVisibleContextLabel(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  return (
    summarizeVisibleTaskText(readTextField(payload, 'outputPreview')) ||
    summarizeVisibleTaskText(readTextField(payload, 'taskSummary')) ||
    summarizeVisibleTaskText(readTextField(payload, 'taskTitle'))
  );
}

function buildContextualPrompt(params: {
  actionText: string;
  visibleContext: string;
}): string {
  return `${params.actionText}\n\nVisible task context:\n${params.visibleContext}`;
}

function classifyTerseContinuation(
  rawPrompt: string,
): { kind: TaskContinuationKind; target?: string } | null {
  const normalized = normalizeLoosePhrase(rawPrompt);
  if (!normalized) return null;

  const adaptTarget = extractAdaptationTarget(normalized);
  if (adaptTarget) {
    return { kind: 'adapt_variant', target: adaptTarget };
  }
  if (RETRY_PATTERNS.has(normalized)) return { kind: 'retry' };
  if (FIX_PATTERNS.has(normalized)) return { kind: 'fix_issue' };
  if (TIGHTEN_PATTERNS.has(normalized)) return { kind: 'revise_shorter' };
  if (EXPAND_PATTERNS.has(normalized)) return { kind: 'revise_more_detail' };
  if (CONTINUE_PATTERNS.has(normalized)) return { kind: 'generic_continue' };
  return null;
}

function isSubstantialInstruction(rawPrompt: string): boolean {
  const trimmed = rawPrompt.trim();
  if (!trimmed) return false;
  if (trimmed.length >= 90) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 9;
}

export function interpretTaskContinuation(
  params: InterpretTaskContinuationParams,
): InterpretedTaskContinuation {
  const trimmedPrompt = params.rawPrompt.trim();
  const visibleContext = buildVisibleContextLabel(params.messageContextPayload);
  const parsed = classifyTerseContinuation(trimmedPrompt);
  if (!trimmedPrompt || !parsed || isSubstantialInstruction(trimmedPrompt)) {
    return {
      normalizedPromptText: trimmedPrompt,
      continuationKind: 'fresh_instruction',
      usedVisibleContext: false,
      suggestedReplyExamples: DEFAULT_SUGGESTED_REPLY_EXAMPLES,
    };
  }

  if (!visibleContext) {
    return {
      normalizedPromptText: trimmedPrompt,
      continuationKind: parsed.kind,
      usedVisibleContext: false,
      suggestedReplyExamples: DEFAULT_SUGGESTED_REPLY_EXAMPLES,
    };
  }

  let actionText = '';
  switch (parsed.kind) {
    case 'retry':
      actionText =
        'Try this task again using the visible task context below as the baseline, and produce a fresh attempt rather than repeating the last pass.';
      break;
    case 'fix_issue':
      actionText =
        'Revise the previous output using the visible task context below. Improve clarity, wording, and overall quality. If no specific issue is stated, perform a general improvement pass.';
      break;
    case 'revise_shorter':
      actionText =
        'Use the visible task context below and make it shorter while preserving the key meaning.';
      break;
    case 'revise_more_detail':
      actionText =
        'Use the visible task context below and expand it with more detail while keeping the same scope.';
      break;
    case 'adapt_variant':
      actionText = `Use the visible task context below as the pattern, but adapt it for ${parsed.target}.`;
      break;
    case 'generic_continue':
      actionText = 'Continue this task using the visible task context below.';
      break;
    default:
      actionText = trimmedPrompt;
      break;
  }

  return {
    normalizedPromptText: buildContextualPrompt({
      actionText,
      visibleContext,
    }),
    continuationKind: parsed.kind,
    usedVisibleContext: true,
    suggestedReplyExamples: DEFAULT_SUGGESTED_REPLY_EXAMPLES,
  };
}

export function buildTaskOutputSuggestion(params: {
  laneId: BackendLaneId;
  contextKind: TaskContextType;
  hasStructuredOutput: boolean;
  canReplyContinue: boolean;
}): string | null {
  if (!params.canReplyContinue) return null;
  if (params.contextKind === 'activity' || !params.hasStructuredOutput) {
    return 'If you want, reply with what Andrea should try next for this task.';
  }
  return 'If you want, reply with "make it shorter," "add more detail," or "adapt it for X."';
}
