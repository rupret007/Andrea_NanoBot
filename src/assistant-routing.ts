import { NewMessage } from './types.js';
import { classifyConversationalTurn } from './conversational-core.js';
import { planCompoundCalendarResearchRequest } from './calendar-research-coordinator.js';

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

const FILE_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;

const WEB_LOOKUP_TOOLS = ['WebSearch', 'WebFetch'] as const;

const RESEARCH_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
] as const;

const DIRECT_ASSISTANT_TOOLS: readonly string[] = [];

const ENGINEERING_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Bash',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
] as const;

const TASK_ASSISTANT_MCP_TOOLS = [
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
] as const;

const SHOPPING_ASSISTANT_MCP_TOOLS = [
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

const SKILL_MANAGEMENT_MCP_TOOLS = [
  'mcp__nanoclaw__search_openclaw_skills',
  'mcp__nanoclaw__enable_openclaw_skill',
  'mcp__nanoclaw__install_openclaw_skill',
  'mcp__nanoclaw__disable_openclaw_skill',
  'mcp__nanoclaw__list_enabled_openclaw_skills',
] as const;

const CURSOR_CREATION_MCP_TOOLS = [
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__create_cursor_agent',
] as const;

// Shell-capable profiles deliberately receive no host-action MCP surface.
// Without a kernel-enforced broker, Bash could otherwise forge the writable
// IPC files used by those tools and bypass the route allowlist.
const EXECUTION_LANE_MCP_TOOLS: readonly string[] = [];

const HOST_ACTION_INCOMPATIBLE_BUILTINS = new Set([
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
]);

const ROUTE_BUILTIN_MAXIMUMS: Record<
  AssistantRequestRoute,
  ReadonlySet<string>
> = {
  direct_assistant: new Set(),
  protected_assistant: new Set(RESEARCH_TOOLS),
  control_plane: new Set(FILE_READ_TOOLS),
  advanced_helper: new Set(ENGINEERING_TOOLS),
  code_plane: new Set(ENGINEERING_TOOLS),
};

const ROUTE_MCP_MAXIMUMS: Record<AssistantRequestRoute, ReadonlySet<string>> = {
  direct_assistant: new Set(),
  protected_assistant: new Set([
    ...TASK_ASSISTANT_MCP_TOOLS,
    ...SHOPPING_ASSISTANT_MCP_TOOLS,
  ]),
  control_plane: new Set(CONTROL_PLANE_MCP_TOOLS),
  advanced_helper: new Set([
    ...SKILL_MANAGEMENT_MCP_TOOLS,
    ...CURSOR_CREATION_MCP_TOOLS,
  ]),
  code_plane: new Set(),
};

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

const EXPLICIT_ADVANCED_HELPER_SIGNALS: RouteSignal[] = [
  {
    pattern: /(?:^|[\s([{-])@openclaw\b/i,
    reason: 'matched explicit OpenClaw address',
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
      /\b(implement|fix|debug|refactor|patch|write|edit|add|update|rename|build|compile|test|commit|ship)\b[\s\S]{0,80}\b(code|repo|repository|bug|feature|test|tests|pr\b|pull request|branch|function|file|command|handler|route|routing|logic|module|integration|api)\b/i,
    reason: 'matched coding intent and engineering target',
  },
  {
    pattern:
      /\b(code|repo|repository|bug|feature|tests?|pr\b|pull request|branch|function|file|command|handler|route|routing|logic|module|integration|api)\b[\s\S]{0,80}\b(implement|fix|debug|refactor|patch|write|edit|add|update|rename|build|compile|test|commit|ship)\b/i,
    reason: 'matched engineering target and coding action',
  },
];

const ADVANCED_HELPER_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(clawhub|clawskills|community skill|skill catalog|enable skill|disable skill|install skill|search skills)\b/i,
    reason: 'matched community skill management intent',
  },
  {
    pattern: /\bopenclaw\b/i,
    reason: 'matched OpenClaw helper intent',
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
      /\b(remind|reminder|schedule|scheduled|appointment|appointments|calendar|meeting|availability|available|help me remember|remember to)\b/i,
    reason: 'matched assistant scheduling intent',
  },
  {
    pattern: /\b(todo|to-do|task list|checklist|agenda)\b/i,
    reason: 'matched personal organization intent',
  },
];

const EXTERNAL_MESSAGE_SEND_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?send\s+(?:a\s+)?(?:text\s+)?message\s+to\s+.+?(?::|\s+saying\b)/i,
    reason: 'matched approval-gated external message intent',
  },
  {
    pattern:
      /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?send\s+(?:a\s+)?text\s+to\s+.+?:/i,
    reason: 'matched approval-gated external message intent',
  },
  {
    pattern:
      /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?text\s+.+?(?::|\s+(?:saying|and\s+say|to\s+say|that\s+says|that)\b)/i,
    reason: 'matched approval-gated external message intent',
  },
  {
    pattern:
      /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?send\s+.+?\s+(?:a\s+)?(?:text|message)\s+(?:saying|that\s+says|to\s+say)\b/i,
    reason: 'matched approval-gated external message intent',
  },
];

const SHOPPING_ASSISTANT_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(amazon|shop for|shopping|buy|purchase|order this|find .* on amazon)\b/i,
    reason: 'matched shopping or purchase intent',
  },
];

const WEATHER_LOOKUP_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(weather|forecast|temperature|current conditions?|rain|snow|umbrella|precipitation|wind|humidity|humid)\b/i,
    reason: 'matched explicit weather lookup intent',
  },
];

const FILE_READ_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(?:what(?:'s| is)?|what does|tell me|show me|contents?|inside|about)\b[\s\S]{0,100}(?:\bpackage\.json\b|\breadme(?:\.md)?\b|(?:^|[\s'"(])(?:~\/|\.{0,2}\/|[A-Za-z]:[\\/])[^\s'"()]+)/i,
    reason: 'matched a content question about a concrete file or path',
  },
  {
    pattern:
      /(?:\bpackage\.json\b|\breadme(?:\.md)?\b|(?:^|[\s'"(])(?:~\/|\.{0,2}\/|[A-Za-z]:[\\/])[^\s'"()]+)[\s\S]{0,100}\b(?:say|contain|inside|about|contents?)\b/i,
    reason: 'matched a concrete file or path content question',
  },
  {
    pattern:
      /\b(read|open|inspect|summarize|review|search|find|check)\b[\s\S]{0,80}\b(file|files|document|documents|folder|directory|attachment|workspace)\b/i,
    reason: 'matched explicit local file inspection intent',
  },
  {
    pattern:
      /\b(file|files|document|documents|folder|directory|attachment|workspace)\b[\s\S]{0,80}\b(read|open|inspect|summarize|review|search|find|check)\b/i,
    reason: 'matched explicit local file inspection target',
  },
  {
    pattern:
      /\b(read|open|inspect|summarize|review|search|find|check)\b[\s\S]{0,100}(?:\brepo(?:sitory)?\b|\bworkspace\b|\bpackage\.json\b|\breadme(?:\.md)?\b|(?:^|[\s'"(])(?:~\/|\.{0,2}\/|[A-Za-z]:[\\/])?[^\s'"()]+\.[A-Za-z0-9]{1,12})/i,
    reason: 'matched explicit repository or path inspection intent',
  },
  {
    pattern:
      /(?:\brepo(?:sitory)?\b|\bworkspace\b|\bpackage\.json\b|\breadme(?:\.md)?\b|(?:^|[\s'"(])(?:~\/|\.{0,2}\/|[A-Za-z]:[\\/])?[^\s'"()]+\.[A-Za-z0-9]{1,12})[\s\S]{0,100}\b(read|open|inspect|summarize|review|search|find|check)\b/i,
    reason: 'matched repository or path target and inspection action',
  },
];

const WEB_LOOKUP_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /^\s*(?:please\s+)?(?:search(?:\s+(?:the\s+)?(?:web|internet))?\s+for|look\s+up)\s+\S/i,
    reason: 'matched explicit search or look-up request',
  },
  {
    pattern: /^\s*(?:please\s+)?find\s+(?:the\s+)?(?:latest|recent|current)\b/i,
    reason: 'matched explicit current-information lookup request',
  },
  {
    pattern:
      /\b(search|look up|browse|check|verify|find)\b[\s\S]{0,80}\b(web|internet|online|website|site|latest|current|today)\b/i,
    reason: 'matched explicit web lookup intent',
  },
  {
    pattern:
      /\b(web|internet|online|website|site|latest|current)\b[\s\S]{0,80}\b(search|look up|browse|check|verify|find)\b/i,
    reason: 'matched explicit web lookup target',
  },
  {
    pattern: /https?:\/\/[^\s]+/i,
    reason: 'matched explicit URL lookup intent',
  },
];

const RESEARCH_SIGNALS: RouteSignal[] = [
  {
    pattern:
      /\b(research|investigate|literature review|compare sources|source-backed|deep dive)\b/i,
    reason: 'matched explicit research intent',
  },
  {
    pattern:
      /^\s*(?:please\s+)?(?:can|could|would)\s+you\s+(?:also\s+)?(?:(?:look\s+for|find)\b(?=[\s\S]{0,100}\b(?:good|best|right|suitable|recommended|recommendation|source[- ]backed|current|latest|recent|information|info|evidence|sources?|guides?|options?|comparison|research)\b)|look\s+into\b|recommend\b|compare\b)/i,
    reason: 'matched explicit conversational research intent',
  },
];

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function wasExplicitlyAddressedToOpenClaw(reason: string): boolean {
  return /explicit OpenClaw address/i.test(reason);
}

export function maybeBuildOpenClawPresenceReply(
  messages: Pick<NewMessage, 'content'>[],
): string | null {
  const raw = messages.at(-1)?.content?.trim() || '';
  if (!/(?:^|[\s([{-])@openclaw\b/i.test(raw)) {
    return null;
  }
  const normalized = raw
    .replace(/(^|[\s([{-])@openclaw\b[,:;!?-]*/i, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    /^(?:are you there(?: too)?|you there|are you online|online|status|hi|hello|hey|what'?s up|who are you|what are you)\b/.test(
      normalized,
    )
  ) {
    return 'OpenClaw here, online and ready. I am the helper lane for deeper orchestration and skill work. Use @andrea for Andrea, and @openclaw when you want me.';
  }
  return null;
}

function buildGuidance(route: AssistantRequestRoute, reason: string): string {
  const explicitOpenClaw =
    route === 'advanced_helper' && wasExplicitlyAddressedToOpenClaw(reason);
  const shared = explicitOpenClaw
    ? [
        'The user explicitly addressed @openclaw, so the public reply should speak as OpenClaw, not Andrea.',
        'OpenClaw is the public helper/tool lane for deeper orchestration, skill work, and advanced helper requests.',
        'Do not say OpenClaw is not separate or that Andrea is the only public identity for this turn.',
        'Do not leak internal routes, hidden planning, or tool plumbing in user-facing replies.',
        'Every handled user turn must end with a user-facing reply. Never finish with an empty final response.',
      ]
    : [
        'Andrea is the only public assistant identity in this chat unless the user explicitly addresses @openclaw.',
        'OpenClaw, helper tools, and internal orchestration are implementation details on non-@openclaw turns. Never present them as a second public bot or public persona unless the user explicitly addresses @openclaw.',
        'Do not leak internal routes, helper chatter, hidden planning, or tool plumbing in user-facing replies.',
        'Andrea should remain the final response formatter even when internal helper capability is used.',
        'Every handled user turn must end with a user-facing reply. Never finish with an empty final response.',
      ];

  const routeSpecific: Record<AssistantRequestRoute, string[]> = {
    direct_assistant: [
      'Treat this as a direct assistant request. Answer clearly and directly.',
      'Use a concise, confident, and lightly witty tone when appropriate. For classic jokes or pop-culture prompts (like meaning of life), prefer the expected punchline first.',
      'This route is tool-free. Answer only from the visible prompt and established conversation context.',
      'Do not escalate into heavy orchestration, background jobs, or community skill management unless the user explicitly asks for that kind of workflow.',
    ],
    protected_assistant: [
      'Treat this as a protected personal assistant task such as reminders, scheduling, weather, availability, or lightweight organization.',
      'Prefer the smallest viable action and a concise confirmation. Do not turn it into a coding or helper-orchestration workflow.',
      'For reminders, scheduling, recurring follow-ups, and task changes, use the task MCP tools instead of freehand promises.',
      'Do not claim a reminder, schedule, or task update is complete unless the relevant tool call succeeded and you can confirm the result.',
      'If you cannot confirm completion, say so plainly instead of ending with a blank or implicit result.',
      'When local inspection tools are available, the repository is a read-only tracked-file snapshot at /workspace/project; never claim access to ignored or untracked owner data.',
    ],
    control_plane: [
      'Treat this as control-plane work: inspect, stop, resume, sync, or update existing operational state.',
      'Do not reinterpret this as code generation or broad feature work.',
    ],
    advanced_helper: [
      'Treat this as an advanced helper request where internal orchestration is allowed.',
      explicitOpenClaw
        ? 'The user explicitly addressed @openclaw, so keep the answer in the OpenClaw helper/tool lane.'
        : 'If the user explicitly addressed @openclaw, treat that as selection of the OpenClaw helper/tool lane.',
      'Use helper capabilities intentionally, but keep the public reply outcome-focused and free of internal implementation chatter.',
      'The tracked Andrea repository is a read-only snapshot at /workspace/project. Write only to the group workspace or an explicitly allowlisted writable mount; never claim the host repository was changed unless a separate host-side workflow proves it.',
    ],
    code_plane: [
      'Treat this as code-plane work. Engineering tools and async helper execution are allowed when useful.',
      'The tracked Andrea repository is a read-only snapshot at /workspace/project. Write artifacts only to the group workspace or an explicitly allowlisted writable mount; never claim the host repository was changed unless a separate host-side workflow proves it.',
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

export function isAssistantContinuationMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  return /^(?:yes|yeah|yep|ok|okay|sure|sounds good|please do|do it|go ahead|continue|retry|again|next|go on|keep going|carry on|resume|enable it|disable it|install it|stop it|pause it|resume it|sync it|that one|this one|the first one|the second one|use that|use this)\b/.test(
    normalized,
  );
}

export function assistantCapabilityKey(
  policy: Pick<AssistantRequestPolicy, 'route' | 'builtinTools' | 'mcpTools'>,
): string {
  return JSON.stringify([
    policy.route,
    [...new Set(policy.builtinTools)].sort(),
    [...new Set(policy.mcpTools)].sort(),
  ]);
}

function shouldUseCombinedContext(lastContent: string): boolean {
  if (!lastContent) return true;

  const normalized = lastContent.trim().toLowerCase();
  if (!normalized) return true;

  // Follow-up approvals and terse references should inherit the immediate
  // conversation context. Rich new asks should stand on their own so an older
  // control/helper message does not force the wrong route.
  return isAssistantContinuationMessage(normalized);
}

function createPolicy(
  route: AssistantRequestRoute,
  reason: string,
  overrides: {
    builtinTools?: readonly string[];
    mcpTools?: readonly string[];
  } = {},
): AssistantRequestPolicy {
  let builtinTools: readonly string[];
  let mcpTools: readonly string[];
  switch (route) {
    case 'direct_assistant':
      builtinTools = DIRECT_ASSISTANT_TOOLS;
      mcpTools = [];
      break;
    case 'protected_assistant':
      builtinTools = [];
      mcpTools = TASK_ASSISTANT_MCP_TOOLS;
      break;
    case 'control_plane':
      builtinTools = FILE_READ_TOOLS;
      mcpTools = CONTROL_PLANE_MCP_TOOLS;
      break;
    case 'advanced_helper':
      builtinTools = ENGINEERING_TOOLS;
      mcpTools = EXECUTION_LANE_MCP_TOOLS;
      break;
    case 'code_plane':
      builtinTools = ENGINEERING_TOOLS;
      mcpTools = EXECUTION_LANE_MCP_TOOLS;
      break;
  }
  return {
    route,
    reason,
    builtinTools: dedupe(overrides.builtinTools ?? builtinTools),
    mcpTools: dedupe(overrides.mcpTools ?? mcpTools),
    guidance: buildGuidance(route, reason),
  };
}

export function createDirectAssistantRequestPolicy(
  reason: string,
): AssistantRequestPolicy {
  return createPolicy('direct_assistant', reason);
}

export function createCompatibilityRequestPolicy(): AssistantRequestPolicy {
  return createPolicy('code_plane', 'explicit development mode');
}

/** Normalize an untrusted serialized policy before it can influence host
 * mounts, writable IPC, session context, or the container payload. The
 * container repeats this validation as a separate defense-in-depth boundary. */
export function normalizeAssistantRequestPolicy(
  policy: unknown,
): AssistantRequestPolicy {
  const failClosed = (reason: string) =>
    createPolicy('direct_assistant', reason);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return failClosed('missing or malformed request policy');
  }
  const candidate = policy as Record<string, unknown>;
  if (
    typeof candidate.route !== 'string' ||
    !Object.hasOwn(ROUTE_BUILTIN_MAXIMUMS, candidate.route) ||
    typeof candidate.reason !== 'string' ||
    typeof candidate.guidance !== 'string' ||
    !Array.isArray(candidate.builtinTools) ||
    !candidate.builtinTools.every((tool) => typeof tool === 'string') ||
    !Array.isArray(candidate.mcpTools) ||
    !candidate.mcpTools.every((tool) => typeof tool === 'string')
  ) {
    return failClosed('missing or malformed request policy');
  }

  const route = candidate.route as AssistantRequestRoute;
  if (route === 'direct_assistant') {
    return {
      route,
      reason: candidate.reason,
      builtinTools: [],
      mcpTools: [],
      guidance: candidate.guidance,
    };
  }

  const builtinTools = dedupe(candidate.builtinTools as string[]);
  const mcpTools = dedupe(candidate.mcpTools as string[]);
  if (
    (mcpTools.length > 0 &&
      builtinTools.some((tool) =>
        HOST_ACTION_INCOMPATIBLE_BUILTINS.has(tool),
      )) ||
    builtinTools.some((tool) => !ROUTE_BUILTIN_MAXIMUMS[route].has(tool)) ||
    mcpTools.some((tool) => !ROUTE_MCP_MAXIMUMS[route].has(tool))
  ) {
    return failClosed('request policy exceeds its route capability boundary');
  }

  return {
    route,
    reason: candidate.reason,
    builtinTools,
    mcpTools,
    guidance: candidate.guidance,
  };
}

/** Explicit runtime jobs are execution work even when a terse follow-up such
 * as "continue" has no standalone coding keyword. Keeping them on the
 * execution lane preserves that transcript without contaminating ordinary
 * chat or the host-action session. */
export function classifyRuntimeJobRequest(
  prompt: string,
): AssistantRequestPolicy {
  const classified = classifyAssistantRequest([{ content: prompt }]);
  return classified.route === 'direct_assistant'
    ? createPolicy('code_plane', 'explicit runtime orchestration job')
    : classified;
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

  const explicitHelperReason = evaluateSignals(
    lastOnly,
    EXPLICIT_ADVANCED_HELPER_SIGNALS,
  );
  if (explicitHelperReason) {
    if (
      /\b(clawhub|clawskills|community skills?|skill catalog|enable skill|disable skill|install skill|search skills?|calendar skill)\b/i.test(
        lastContent,
      )
    ) {
      return createPolicy('advanced_helper', explicitHelperReason, {
        builtinTools: [],
        mcpTools: SKILL_MANAGEMENT_MCP_TOOLS,
      });
    }
    if (
      /\b(create|launch|start|spin up)\b[\s\S]{0,60}\b(cursor agent|cursor job|agent job|background agent)\b/i.test(
        lastContent,
      )
    ) {
      return createPolicy('advanced_helper', explicitHelperReason, {
        builtinTools: [],
        mcpTools: CURSOR_CREATION_MCP_TOOLS,
      });
    }
    return createPolicy('advanced_helper', explicitHelperReason);
  }

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
    return createPolicy('protected_assistant', explicitProtectedReason, {
      builtinTools: [],
      mcpTools: SHOPPING_ASSISTANT_MCP_TOOLS,
    });
  }

  const directReason = evaluateSignals(lastOnly, DIRECT_ASSISTANT_SIGNALS);
  if (directReason) {
    return createPolicy('direct_assistant', directReason);
  }

  const externalMessageSendReason = evaluateSignals(
    lastOnly,
    EXTERNAL_MESSAGE_SEND_SIGNALS,
  );
  if (externalMessageSendReason) {
    return createPolicy('protected_assistant', externalMessageSendReason, {
      builtinTools: [],
      mcpTools: [],
    });
  }

  const compoundCalendarResearch = candidates
    .map((candidate) => planCompoundCalendarResearchRequest(candidate))
    .find((plan) => plan !== null);
  if (compoundCalendarResearch) {
    return createPolicy(
      'protected_assistant',
      'matched coordinated calendar-create and research request',
      {
        builtinTools: RESEARCH_TOOLS,
        // The host-owned calendar path stages the approval-bound draft. Keep
        // the fallback research-only so web-derived content can never share a
        // session with mutable task tools.
        mcpTools: [],
      },
    );
  }

  // Preserve the requested host action when a reminder or purchase includes a
  // file/URL as payload. Fetching the reference is not required to schedule or
  // stage the action, and must not silently strip its exact MCP capability.
  const earlyProtectedActionReason = evaluateSignals(
    candidates.filter((candidate) =>
      /\b(remind|reminder|schedule|scheduled|help me remember|remember to)\b/i.test(
        candidate,
      ),
    ),
    PROTECTED_ASSISTANT_SIGNALS,
  );
  if (earlyProtectedActionReason) {
    return createPolicy('protected_assistant', earlyProtectedActionReason);
  }

  const earlyShoppingReason = evaluateSignals(
    candidates.filter((candidate) =>
      /\b(?:buy|order this|shop for|shopping for|purchase (?:this|it|the\b)|find\b[\s\S]{0,50}\bon amazon)\b/i.test(
        candidate,
      ),
    ),
    SHOPPING_ASSISTANT_SIGNALS,
  );
  if (earlyShoppingReason) {
    return createPolicy('protected_assistant', earlyShoppingReason, {
      builtinTools: [],
      mcpTools: SHOPPING_ASSISTANT_MCP_TOOLS,
    });
  }

  // Resolve explicit information gathering before mutation-oriented code
  // signals. A request to inspect a repository/file must not gain Bash or
  // write tools merely because its target is code.
  const localInspectionCandidates = candidates.map((candidate) =>
    candidate.replace(/https?:\/\/\S+/gi, ' '),
  );
  const earlyFileReadReason = evaluateSignals(
    localInspectionCandidates,
    FILE_READ_SIGNALS,
  );
  const earlyWebLookupReason = evaluateSignals(candidates, WEB_LOOKUP_SIGNALS);
  const earlyResearchReason = earlyFileReadReason
    ? null
    : evaluateSignals(candidates, RESEARCH_SIGNALS);
  if (earlyResearchReason || (earlyFileReadReason && earlyWebLookupReason)) {
    return createPolicy(
      'protected_assistant',
      earlyResearchReason || `${earlyFileReadReason}; ${earlyWebLookupReason}`,
      {
        builtinTools: RESEARCH_TOOLS,
        mcpTools: [],
      },
    );
  }

  if (earlyFileReadReason) {
    return createPolicy('protected_assistant', earlyFileReadReason, {
      builtinTools: FILE_READ_TOOLS,
      mcpTools: [],
    });
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
    const helperIntentText = candidates.join('\n');
    if (
      /clawhub|clawskills|community skills?|skill catalog|openclaw catalog|calendar skill|enable skill|disable skill|install skill|search skills?/i.test(
        helperIntentText,
      )
    ) {
      return createPolicy('advanced_helper', helperReason, {
        builtinTools: [],
        mcpTools: SKILL_MANAGEMENT_MCP_TOOLS,
      });
    }
    if (/async helper job creation/i.test(helperReason)) {
      return createPolicy('advanced_helper', helperReason, {
        builtinTools: [],
        mcpTools: CURSOR_CREATION_MCP_TOOLS,
      });
    }
    return createPolicy('advanced_helper', helperReason);
  }

  const fileReadReason = evaluateSignals(
    localInspectionCandidates,
    FILE_READ_SIGNALS,
  );
  if (fileReadReason) {
    return createPolicy('protected_assistant', fileReadReason, {
      builtinTools: FILE_READ_TOOLS,
      mcpTools: [],
    });
  }

  const researchReason = evaluateSignals(candidates, RESEARCH_SIGNALS);
  if (researchReason) {
    return createPolicy('protected_assistant', researchReason, {
      builtinTools: RESEARCH_TOOLS,
      mcpTools: [],
    });
  }

  const webLookupReason = evaluateSignals(candidates, WEB_LOOKUP_SIGNALS);
  if (webLookupReason) {
    return createPolicy('protected_assistant', webLookupReason, {
      builtinTools: WEB_LOOKUP_TOOLS,
      mcpTools: [],
    });
  }

  const weatherReason = evaluateSignals(candidates, WEATHER_LOOKUP_SIGNALS);
  if (weatherReason) {
    return createPolicy('protected_assistant', weatherReason, {
      builtinTools: WEB_LOOKUP_TOOLS,
      mcpTools: [],
    });
  }

  const shoppingReason = evaluateSignals(
    candidates,
    SHOPPING_ASSISTANT_SIGNALS,
  );
  if (shoppingReason) {
    return createPolicy('protected_assistant', shoppingReason, {
      builtinTools: [],
      mcpTools: SHOPPING_ASSISTANT_MCP_TOOLS,
    });
  }

  const protectedReason = evaluateSignals(
    candidates,
    PROTECTED_ASSISTANT_SIGNALS,
  );
  if (protectedReason) {
    return createPolicy('protected_assistant', protectedReason);
  }

  if (lastContent) {
    const conversationalTurnClass = classifyConversationalTurn(lastContent);
    if (conversationalTurnClass !== 'work_or_operator') {
      return createPolicy(
        'direct_assistant',
        `matched conversational ${conversationalTurnClass} request`,
      );
    }
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
