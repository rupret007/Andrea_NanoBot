import { NewMessage } from './types.js';

export type AssistantRequestRoute =
  | 'direct_assistant'
  | 'protected_assistant'
  | 'control_plane'
  | 'advanced_helper'
  | 'code_plane';

export interface AssistantRequestPolicy {
  route: AssistantRequestRoute;
  reason: string;
  builtinTools: string[];
  mcpTools: string[];
  guidance: string;
}

export interface AssistantRoutingOptions {
  allowCombinedContext?: boolean;
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

const DIRECT_ASSISTANT_TOOLS = ['Read'] as const;

const ADVANCED_EXECUTION_TOOLS = [
  'Bash',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
] as const;

const ALL_INTERNAL_MCP_TOOLS = [
  'mcp__nanoclaw__search_openclaw_skills',
  'mcp__nanoclaw__enable_openclaw_skill',
  'mcp__nanoclaw__install_openclaw_skill',
  'mcp__nanoclaw__disable_openclaw_skill',
  'mcp__nanoclaw__list_enabled_openclaw_skills',
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__create_cursor_agent',
  'mcp__nanoclaw__followup_cursor_agent',
  'mcp__nanoclaw__stop_cursor_agent',
  'mcp__nanoclaw__sync_cursor_agent',
  'mcp__nanoclaw__list_cursor_agent_artifacts',
  'mcp__nanoclaw__search_amazon_products',
  'mcp__nanoclaw__request_amazon_purchase',
  'mcp__nanoclaw__list_amazon_purchase_requests',
  'mcp__nanoclaw__approve_amazon_purchase_request',
  'mcp__nanoclaw__cancel_amazon_purchase_request',
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
  'mcp__nanoclaw__register_group',
] as const;

const PROTECTED_TASK_MCP_TOOLS = [
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
  'mcp__nanoclaw__search_amazon_products',
  'mcp__nanoclaw__request_amazon_purchase',
  'mcp__nanoclaw__list_amazon_purchase_requests',
] as const;

const CONTROL_PLANE_MCP_TOOLS = [
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__followup_cursor_agent',
  'mcp__nanoclaw__stop_cursor_agent',
  'mcp__nanoclaw__sync_cursor_agent',
  'mcp__nanoclaw__list_cursor_agent_artifacts',
  'mcp__nanoclaw__list_amazon_purchase_requests',
  'mcp__nanoclaw__approve_amazon_purchase_request',
  'mcp__nanoclaw__cancel_amazon_purchase_request',
  'mcp__nanoclaw__register_group',
] as const;

const ADVANCED_HELPER_MCP_TOOLS = [
  'mcp__nanoclaw__search_openclaw_skills',
  'mcp__nanoclaw__enable_openclaw_skill',
  'mcp__nanoclaw__install_openclaw_skill',
  'mcp__nanoclaw__disable_openclaw_skill',
  'mcp__nanoclaw__list_enabled_openclaw_skills',
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__create_cursor_agent',
  'mcp__nanoclaw__followup_cursor_agent',
  'mcp__nanoclaw__stop_cursor_agent',
  'mcp__nanoclaw__sync_cursor_agent',
  'mcp__nanoclaw__list_cursor_agent_artifacts',
  'mcp__nanoclaw__search_amazon_products',
  'mcp__nanoclaw__request_amazon_purchase',
  'mcp__nanoclaw__list_amazon_purchase_requests',
  'mcp__nanoclaw__approve_amazon_purchase_request',
  'mcp__nanoclaw__cancel_amazon_purchase_request',
  'mcp__nanoclaw__send_message',
] as const;

const CODE_PLANE_MCP_TOOLS = [
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__create_cursor_agent',
  'mcp__nanoclaw__followup_cursor_agent',
  'mcp__nanoclaw__stop_cursor_agent',
  'mcp__nanoclaw__sync_cursor_agent',
  'mcp__nanoclaw__list_cursor_agent_artifacts',
  'mcp__nanoclaw__search_openclaw_skills',
  'mcp__nanoclaw__list_enabled_openclaw_skills',
  'mcp__nanoclaw__send_message',
] as const;

interface RouteSignal {
  pattern: RegExp;
  reason: string;
}

const EXPLICIT_CONTROL_PLANE_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /^\/(?:cursor|cursor_|cursor-|jobs?|status|pause|resume|cancel|sync|stop)/i,
    reason: 'matched explicit control command',
  },
  {
    pattern: /^\/(?:amazon-status|amazon_status)/i,
    reason: 'matched explicit purchase control command',
  },
  {
    pattern:
      /^\/(?:purchase-requests|purchase_requests|purchase-approve|purchase_approve|purchase-cancel|purchase_cancel)/i,
    reason: 'matched explicit purchase control command',
  },
];

const EXPLICIT_PROTECTED_ASSISTANT_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /^\/(?:amazon-search|amazon_search|purchase-request|purchase_request)/i,
    reason: 'matched explicit shopping assistant command',
  },
];

const DIRECT_ASSISTANT_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(help me follow up on this task|help me follow up on this work|draft a follow[- ]?up(?: for this meeting)?|draft an email about this|draft a quick update about what's next|turn this into a short follow[- ]?up message|what should i send (?:after this meeting|before my next meeting))\b/i,
    reason: 'matched natural follow-through drafting intent',
  },
];

const CONTROL_PLANE_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(status|list|show|inspect|sync|refresh|pause|resume|cancel|stop|retry|follow[- ]?up|continue)\b[\s\S]{0,60}\b(cursor|job|jobs|agent|agents|task|tasks|run|runs|queue|artifact|artifacts|work)\b/i,
    reason: 'matched operational status keywords',
  },
  {
    pattern:
      /\b(cursor|job|jobs|agent|agents|task|tasks|run|runs|queue|artifact|artifacts|work)\b[\s\S]{0,60}\b(status|list|show|inspect|sync|refresh|pause|resume|cancel|stop|retry|follow[- ]?up|continue)\b/i,
    reason: 'matched operational control target',
  },
  {
    pattern:
      /\b(approve|cancel|list|show|inspect)\b[\s\S]{0,60}\b(purchase request|purchase approval|approval code|amazon purchase|order approval)\b/i,
    reason: 'matched purchase control intent',
  },
  {
    pattern:
      /\b(purchase request|purchase approval|approval code|amazon purchase|order approval)\b[\s\S]{0,60}\b(approve|cancel|list|show|inspect)\b/i,
    reason: 'matched purchase control target',
  },
];

const CODE_PLANE_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(implement|fix|debug|refactor|patch|write|add|update|rename|build|compile|test|review|commit|ship)\b[\s\S]{0,80}\b(code|repo|repository|bug|feature|test|tests|pr\b|pull request|branch|function|file|command|handler|route|routing|logic|module|integration|api)\b/i,
    reason: 'matched coding intent and engineering target',
  },
  {
    pattern:
      /\b(code|repo|repository|bug|feature|tests?|pr\b|pull request|branch|function|file|command|handler|route|routing|logic|module|integration|api)\b[\s\S]{0,80}\b(implement|fix|debug|refactor|patch|write|add|update|rename|build|compile|test|review|commit|ship)\b/i,
    reason: 'matched engineering target and coding action',
  },
];

const ADVANCED_HELPER_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(openclaw|clawhub|clawskills|community skill|skill catalog|enable skill|disable skill|install skill|search skills)\b/i,
    reason: 'matched community skill management intent',
  },
  {
    pattern:
      /\b(delegate|delegation|orchestrate|orchestration|specialist|subagent|sub-agent|workflow chain|tool routing|node action|helper layer)\b/i,
    reason: 'matched advanced helper orchestration intent',
  },
  {
    pattern:
      /\b(create|launch|start|spin up)\b[\s\S]{0,60}\b(cursor agent|cursor job|agent job|background agent)\b/i,
    reason: 'matched async helper job creation intent',
  },
];

const PROTECTED_ASSISTANT_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(remind|reminder|schedule|scheduled|appointment|appointments|calendar|meeting|availability|available|weather|forecast|help me remember|remember to)\b/i,
    reason: 'matched assistant scheduling or lookup intent',
  },
  {
    pattern: /\b(todo|to-do|task list|checklist|agenda)\b/i,
    reason: 'matched personal organization intent',
  },
  {
    pattern:
      /\b(amazon|shop for|shopping|buy|purchase|order this|find .* on amazon)\b/i,
    reason: 'matched shopping or purchase intent',
  },
];

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function buildGuidance(route: AssistantRequestRoute): string {
  const shared = [
    'Andrea is the only public assistant identity in this chat.',
    'OpenClaw, helper tools, and internal orchestration are implementation details. Never present them as a second public bot or public persona.',
    'Do not leak internal routes, helper chatter, hidden planning, or tool plumbing in user-facing replies.',
    'Andrea should remain the final response formatter even when internal helper capability is used.',
    'Every handled user turn must end with a user-facing reply. Never finish with an empty final response.',
  ];

  const routeSpecific: Record<AssistantRequestRoute, string[]> = {
    direct_assistant: [
      'Treat this as a direct assistant request. Answer clearly and directly.',
      'Use a concise, confident, and lightly witty tone when appropriate. For classic jokes or pop-culture prompts (like meaning of life), prefer the expected punchline first.',
      'Do not use tools unless the user explicitly asks you to inspect local files, search the web, or fetch external content.',
      'Do not escalate into heavy orchestration, background jobs, or community skill management unless the user explicitly asks for that kind of workflow.',
    ],
    protected_assistant: [
      'Treat this as a protected personal assistant task such as reminders, scheduling, weather, availability, or lightweight organization.',
      'Prefer the smallest viable action and a concise confirmation. Do not turn it into a coding or helper-orchestration workflow.',
      'For reminders, scheduling, recurring follow-ups, and task changes, use the task MCP tools instead of freehand promises.',
      'Do not claim a reminder, schedule, or task update is complete unless the relevant tool call succeeded and you can confirm the result.',
      'If you cannot confirm completion, say so plainly instead of ending with a blank or implicit result.',
    ],
    control_plane: [
      'Treat this as control-plane work: inspect, stop, resume, sync, or update existing operational state.',
      'Do not reinterpret this as code generation or broad feature work.',
    ],
    advanced_helper: [
      'Treat this as an advanced helper request where internal orchestration is allowed.',
      'Use helper capabilities intentionally, but keep the public reply outcome-focused and free of internal implementation chatter.',
    ],
    code_plane: [
      'Treat this as code-plane work. Engineering tools and async helper execution are allowed when useful.',
      'Stay outcome-focused in the final reply and avoid narrating internal helper mechanics unless the user explicitly asks for them.',
    ],
  };

  return [...shared, ...routeSpecific[route]].join('\n');
}

function evaluateSignals(
  texts: string[],
  signals: RouteSignal[],
): string | null {
  for (const text of texts) {
    for (const signal of signals) {
      if (signal.pattern.test(text)) {
        return signal.reason;
      }
    }
  }
  return null;
}

function shouldUseCombinedContext(lastContent: string): boolean {
  if (!lastContent) return true;

  const normalized = lastContent.trim().toLowerCase();
  if (!normalized) return true;

  // Follow-up approvals and terse references should inherit the immediate
  // conversation context. Rich new asks should stand on their own so an older
  // control/helper message does not force the wrong route.
  return /^(?:yes|yeah|yep|ok|okay|sure|sounds good|please do|do it|go ahead|continue|retry|enable it|disable it|install it|stop it|pause it|resume it|sync it|that one|this one|the first one|the second one|use that|use this)\b/.test(
    normalized,
  );
}

function createPolicy(
  route: AssistantRequestRoute,
  reason: string,
): AssistantRequestPolicy {
  switch (route) {
    case 'direct_assistant':
      return {
        route,
        reason,
        builtinTools: dedupe(DIRECT_ASSISTANT_TOOLS),
        mcpTools: [],
        guidance: buildGuidance(route),
      };
    case 'protected_assistant':
      return {
        route,
        reason,
        builtinTools: dedupe(STANDARD_ASSISTANT_TOOLS),
        mcpTools: dedupe(PROTECTED_TASK_MCP_TOOLS),
        guidance: buildGuidance(route),
      };
    case 'control_plane':
      return {
        route,
        reason,
        builtinTools: dedupe([
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'TodoWrite',
          'Skill',
          'NotebookEdit',
        ]),
        mcpTools: dedupe(CONTROL_PLANE_MCP_TOOLS),
        guidance: buildGuidance(route),
      };
    case 'advanced_helper':
      return {
        route,
        reason,
        builtinTools: dedupe([
          ...STANDARD_ASSISTANT_TOOLS,
          ...ADVANCED_EXECUTION_TOOLS,
        ]),
        mcpTools: dedupe(ADVANCED_HELPER_MCP_TOOLS),
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
        mcpTools: dedupe(CODE_PLANE_MCP_TOOLS),
        guidance: buildGuidance(route),
      };
  }
}

export function createDirectAssistantRequestPolicy(
  reason: string,
): AssistantRequestPolicy {
  return createPolicy('direct_assistant', reason);
}

export function createCompatibilityRequestPolicy(): AssistantRequestPolicy {
  return {
    route: 'code_plane',
    reason: 'compatibility fallback',
    builtinTools: dedupe([
      ...STANDARD_ASSISTANT_TOOLS,
      ...ADVANCED_EXECUTION_TOOLS,
    ]),
    mcpTools: dedupe(ALL_INTERNAL_MCP_TOOLS),
    guidance: buildGuidance('code_plane'),
  };
}

export function classifyAssistantRequest(
  messages: Pick<NewMessage, 'content'>[],
  options: AssistantRoutingOptions = {},
): AssistantRequestPolicy {
  const contents = messages
    .map((message) => message.content.trim())
    .filter(Boolean);
  const lastContent = contents.at(-1) || '';
  const combinedContent = contents.join('\n');
  const lastOnly = dedupe([lastContent]).filter(Boolean);
  const allowCombinedContext = options.allowCombinedContext !== false;
  const candidates = dedupe([
    ...lastOnly,
    ...(allowCombinedContext && shouldUseCombinedContext(lastContent)
      ? [combinedContent]
      : []),
  ]).filter(Boolean);

  const explicitControlReason = evaluateSignals(
    lastOnly,
    EXPLICIT_CONTROL_PLANE_SIGNALS,
  );
  if (explicitControlReason) {
    return createPolicy('control_plane', explicitControlReason);
  }

  const explicitProtectedReason = evaluateSignals(
    lastOnly,
    EXPLICIT_PROTECTED_ASSISTANT_SIGNALS,
  );
  if (explicitProtectedReason) {
    return createPolicy('protected_assistant', explicitProtectedReason);
  }

  const directReason = evaluateSignals(lastOnly, DIRECT_ASSISTANT_SIGNALS);
  if (directReason) {
    return createPolicy('direct_assistant', directReason);
  }

  const codeReason = evaluateSignals(candidates, CODE_PLANE_SIGNALS);
  if (codeReason) {
    return createPolicy('code_plane', codeReason);
  }

  const controlReason = evaluateSignals(candidates, CONTROL_PLANE_SIGNALS);
  if (controlReason) {
    return createPolicy('control_plane', controlReason);
  }

  const helperReason = evaluateSignals(candidates, ADVANCED_HELPER_SIGNALS);
  if (helperReason) {
    return createPolicy('advanced_helper', helperReason);
  }

  const protectedReason = evaluateSignals(
    candidates,
    PROTECTED_ASSISTANT_SIGNALS,
  );
  if (protectedReason) {
    return createPolicy('protected_assistant', protectedReason);
  }

  return createPolicy(
    'direct_assistant',
    lastContent ? 'defaulted to direct assistant handling' : 'empty prompt',
  );
}

export function classifyScheduledTaskRequest(
  prompt: string,
): AssistantRequestPolicy {
  const basePolicy = classifyAssistantRequest([
    {
      content: prompt,
    },
  ]);

  if (basePolicy.route === 'direct_assistant') {
    return createPolicy(
      'protected_assistant',
      'scheduled task defaulted to protected assistant handling',
    );
  }

  return basePolicy;
}
