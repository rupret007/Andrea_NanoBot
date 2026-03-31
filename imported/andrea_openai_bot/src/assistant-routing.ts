import { NewMessage } from './types.js';

export type AssistantRequestRoute =
  | 'direct_assistant'
  | 'protected_assistant'
  | 'operator_control'
  | 'code_plane';

export interface AssistantRequestPolicy {
  route: AssistantRequestRoute;
  reason: string;
  builtinTools: string[];
  mcpTools: string[];
  guidance: string;
}

const STANDARD_ASSISTANT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'Skill',
  'NotebookEdit',
] as const;

const ADVANCED_EXECUTION_TOOLS = [
  'Bash',
  'Task',
  'TaskOutput',
  'TaskStop',
  'SendMessage',
] as const;

const TASK_MCP_TOOLS = [
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
] as const;

const MAIN_CONTROL_MCP_TOOLS = [
  ...TASK_MCP_TOOLS,
  'mcp__nanoclaw__register_group',
] as const;

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function buildGuidance(route: AssistantRequestRoute): string {
  const shared = [
    'Andrea is the only public assistant identity in this chat.',
    'Keep replies warm, clear, helpful, and lightly witty when appropriate.',
    'Do not expose internal runtime, provider, or orchestration details unless the user explicitly asks for them.',
    'If you are unsure whether a local action really completed, say so plainly instead of implying success.',
  ];

  const byRoute: Record<AssistantRequestRoute, string[]> = {
    direct_assistant: [
      'Treat this as a normal assistant conversation or lightweight question.',
      'Prefer concise answers and avoid turning it into an operator workflow.',
    ],
    protected_assistant: [
      'Treat this as a reminder, planning, scheduling, or personal assistant task.',
      'Use task tools when the request is really asking Andrea to remember or follow up later.',
    ],
    operator_control: [
      'Treat this as operator control work.',
      'Keep the reply operational and factual without surfacing internal noise.',
    ],
    code_plane: [
      'Treat this as project or coding work.',
      'Engineering tools are allowed when needed, but the final reply should stay user-focused.',
    ],
  };

  return [...shared, ...byRoute[route]].join('\n');
}

function createPolicy(
  route: AssistantRequestRoute,
  reason: string,
): AssistantRequestPolicy {
  switch (route) {
    case 'protected_assistant':
      return {
        route,
        reason,
        builtinTools: dedupe(STANDARD_ASSISTANT_TOOLS),
        mcpTools: dedupe(TASK_MCP_TOOLS),
        guidance: buildGuidance(route),
      };
    case 'operator_control':
      return {
        route,
        reason,
        builtinTools: dedupe([
          ...STANDARD_ASSISTANT_TOOLS,
          ...ADVANCED_EXECUTION_TOOLS,
        ]),
        mcpTools: dedupe(MAIN_CONTROL_MCP_TOOLS),
        guidance: buildGuidance(route),
      };
    case 'code_plane':
      return {
        route,
        reason,
        builtinTools: dedupe([
          ...STANDARD_ASSISTANT_TOOLS,
          ...ADVANCED_EXECUTION_TOOLS,
        ]),
        mcpTools: ['mcp__nanoclaw__send_message'],
        guidance: buildGuidance(route),
      };
    case 'direct_assistant':
    default:
      return {
        route: 'direct_assistant',
        reason,
        builtinTools: dedupe(STANDARD_ASSISTANT_TOOLS),
        mcpTools: [],
        guidance: buildGuidance('direct_assistant'),
      };
  }
}

function classifyText(text: string): AssistantRequestPolicy {
  const normalized = text.trim();
  if (!normalized) {
    return createPolicy(
      'direct_assistant',
      'empty request defaults to direct assistant',
    );
  }

  if (/^\/(?:runtime|codex|register|status|help)\b/i.test(normalized)) {
    return createPolicy('operator_control', 'matched operator command');
  }

  if (
    /\b(remind|reminder|schedule|scheduled|appointment|meeting|calendar|availability|todo|to-do|checklist|follow up|follow-up|later today|tomorrow)\b/i.test(
      normalized,
    )
  ) {
    return createPolicy(
      'protected_assistant',
      'matched reminder or scheduling intent',
    );
  }

  if (
    /\b(implement|fix|debug|refactor|patch|write|add|update|rename|build|compile|test|review|repo|repository|pull request|pr\b|branch|function|file|handler|module|integration|api)\b/i.test(
      normalized,
    )
  ) {
    return createPolicy('code_plane', 'matched coding intent');
  }

  return createPolicy('direct_assistant', 'defaulted to direct assistant');
}

export function classifyAssistantRequest(
  messages: Pick<NewMessage, 'content'>[],
): AssistantRequestPolicy {
  const text = messages
    .slice(-3)
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n');
  return classifyText(text);
}

export function classifyScheduledTaskRequest(
  prompt: string,
): AssistantRequestPolicy {
  return classifyText(prompt);
}
