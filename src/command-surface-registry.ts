import {
  ALEXA_STATUS_COMMANDS,
  AMAZON_SEARCH_COMMANDS,
  AMAZON_STATUS_COMMANDS,
  CURSOR_ARTIFACT_LINK_COMMANDS,
  CURSOR_ARTIFACTS_COMMANDS,
  CURSOR_CONVERSATION_COMMANDS,
  CURSOR_CREATE_COMMANDS,
  CURSOR_DASHBOARD_COMMANDS,
  CURSOR_FOLLOWUP_COMMANDS,
  CURSOR_JOBS_COMMANDS,
  CURSOR_MODELS_COMMANDS,
  CURSOR_SELECT_COMMANDS,
  CURSOR_STOP_COMMANDS,
  CURSOR_SYNC_COMMANDS,
  CURSOR_TERMINAL_COMMANDS,
  CURSOR_TERMINAL_HELP_COMMANDS,
  CURSOR_TERMINAL_LOG_COMMANDS,
  CURSOR_TERMINAL_STATUS_COMMANDS,
  CURSOR_TERMINAL_STOP_COMMANDS,
  CURSOR_TEST_COMMANDS,
  CURSOR_UI_COMMANDS,
  DEBUG_LEVEL_COMMANDS,
  DEBUG_LOGS_COMMANDS,
  DEBUG_RESET_COMMANDS,
  DEBUG_STATUS_COMMANDS,
  PURCHASE_APPROVE_COMMANDS,
  PURCHASE_CANCEL_COMMANDS,
  PURCHASE_REQUEST_COMMANDS,
  PURCHASE_REQUESTS_COMMANDS,
  REMOTE_CONTROL_START_COMMANDS,
  REMOTE_CONTROL_STOP_COMMANDS,
  RUNTIME_CREATE_COMMANDS,
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOB_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
} from './operator-command-gate.js';

export type CommandSurfaceAudience = 'user' | 'operator' | 'internal';
export type CommandSurfaceKind =
  | 'slash'
  | 'button_backing'
  | 'inline_action'
  | 'natural_language'
  | 'script';
export type CommandSurfaceChannel =
  | 'telegram'
  | 'alexa'
  | 'bluebubbles'
  | 'cross_channel'
  | 'operator';
export type CommandSurfaceDiscoverability =
  | '/start'
  | '/help'
  | '/commands'
  | '/features'
  | 'operator_docs'
  | 'internal_only';
export type CommandSurfaceTruth =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'degraded_but_usable'
  | 'bounded'
  | 'operator_only'
  | 'disabled';

export interface CommandSurfaceEntry {
  id: string;
  preferredAlias: string;
  acceptedAliases: string[];
  audience: CommandSurfaceAudience;
  surfaceKind: CommandSurfaceKind;
  channelScope: CommandSurfaceChannel[];
  discoverability: CommandSurfaceDiscoverability[];
  truthClass: CommandSurfaceTruth;
  summary: string;
  description?: string;
  menuDescription?: string;
  statusAuthority?: string;
}

function aliases(
  preferredAlias: string,
  acceptedAliases: Iterable<string> = [],
): string[] {
  return Array.from(new Set([preferredAlias, ...acceptedAliases]));
}

function family(
  id: string,
  preferredAlias: string,
  acceptedAliases: Iterable<string>,
  summary: string,
  audience: CommandSurfaceAudience,
  truthClass: CommandSurfaceTruth,
  description?: string,
): CommandSurfaceEntry {
  return {
    id,
    preferredAlias,
    acceptedAliases: aliases(preferredAlias, acceptedAliases),
    audience,
    surfaceKind: 'slash',
    channelScope: ['telegram', 'operator'],
    discoverability: ['operator_docs'],
    truthClass,
    summary,
    description,
  };
}

export const PUBLIC_TELEGRAM_COMMAND_SURFACES: readonly CommandSurfaceEntry[] = [
  {
    id: 'telegram_start',
    preferredAlias: '/start',
    acceptedAliases: ['/start'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/start', '/help', '/commands'],
    truthClass: 'live_proven',
    summary: 'Quick start for new chats and first asks.',
    menuDescription: 'Quick start and example asks',
  },
  {
    id: 'telegram_help',
    preferredAlias: '/help',
    acceptedAliases: ['/help'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/start', '/help', '/commands'],
    truthClass: 'live_proven',
    summary: 'How Andrea works in Telegram, in one screen.',
    menuDescription: 'How Andrea works here',
  },
  {
    id: 'telegram_commands',
    preferredAlias: '/commands',
    acceptedAliases: ['/commands'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/start', '/help', '/commands'],
    truthClass: 'live_proven',
    summary: 'Setup and status commands for this safe Telegram surface.',
    menuDescription: 'Setup and status commands',
  },
  {
    id: 'telegram_features',
    preferredAlias: '/features',
    acceptedAliases: ['/features'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/start', '/help', '/features'],
    truthClass: 'live_proven',
    summary: 'What Andrea is best at here and where other surfaces fit.',
    menuDescription: 'What Andrea is best at',
  },
  {
    id: 'telegram_ping',
    preferredAlias: '/ping',
    acceptedAliases: ['/ping'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/commands', '/help'],
    truthClass: 'live_proven',
    summary: 'Quick online check.',
    menuDescription: 'Check if Andrea is online',
  },
  {
    id: 'telegram_chatid',
    preferredAlias: '/chatid',
    acceptedAliases: ['/chatid'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/commands'],
    truthClass: 'live_proven',
    summary: 'Show the current Telegram chat ID and type.',
    menuDescription: "Show this chat's ID",
  },
  {
    id: 'telegram_registermain',
    preferredAlias: '/registermain',
    acceptedAliases: ['/registermain'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/start', '/help', '/commands'],
    truthClass: 'live_proven',
    summary: "Make this DM Andrea's main control chat.",
    menuDescription: 'Make this DM your main chat',
  },
  {
    id: 'telegram_cursor_status',
    preferredAlias: '/cursor_status',
    acceptedAliases: ['/cursor_status'],
    audience: 'user',
    surfaceKind: 'slash',
    channelScope: ['telegram'],
    discoverability: ['/commands', '/help', '/features'],
    truthClass: 'live_proven',
    summary: 'Check whether coding and work help are ready right now.',
    menuDescription: 'Coding and work readiness',
  },
] as const;

export type PracticalCommandFamilyId =
  | 'local_basics'
  | 'calendar_schedule'
  | 'reminders_save'
  | 'orientation_planning'
  | 'communication_help'
  | 'compare_explain'
  | 'review_followthrough'
  | 'household_coordination';

export type PracticalCommandSurface =
  | 'alexa'
  | 'telegram'
  | 'bluebubbles'
  | 'handoff'
  | 'operator_only';

export type PracticalCommandRoutingTarget =
  | 'local'
  | 'calendar_read'
  | 'calendar_write'
  | 'reminder_write'
  | 'daily_guidance'
  | 'planning'
  | 'communication'
  | 'research_or_knowledge'
  | 'review'
  | 'thread_followup'
  | 'telegram_handoff'
  | 'operator_only';

export type PracticalCommandDiscoveryTier = 'primary' | 'secondary';

export interface PracticalCommandEntry {
  family: PracticalCommandFamilyId;
  prompt: string;
  primarySurface: PracticalCommandSurface;
  secondarySurfaces: PracticalCommandSurface[];
  routingTarget: PracticalCommandRoutingTarget;
  discoveryTier: PracticalCommandDiscoveryTier;
}

export interface PracticalCommandFamilyFinding {
  rank: number;
  family: PracticalCommandFamilyId;
  label: string;
  whyItMatters: string;
  routeStrategy:
    | 'local-first'
    | 'capability-first'
    | 'research-first'
    | 'handoff-first';
}

function practicalCommand(
  family: PracticalCommandFamilyId,
  prompt: string,
  primarySurface: PracticalCommandSurface,
  secondarySurfaces: PracticalCommandSurface[],
  routingTarget: PracticalCommandRoutingTarget,
  discoveryTier: PracticalCommandDiscoveryTier = 'primary',
): PracticalCommandEntry {
  return {
    family,
    prompt,
    primarySurface,
    secondarySurfaces,
    routingTarget,
    discoveryTier,
  };
}

export const PRACTICAL_COMMAND_FAMILY_FINDINGS: readonly PracticalCommandFamilyFinding[] = [
  {
    rank: 1,
    family: 'calendar_schedule',
    label: 'Calendar and schedule',
    whyItMatters:
      'This is the most common daily assistant job and one of the clearest trust builders when it works cleanly.',
    routeStrategy: 'capability-first',
  },
  {
    rank: 2,
    family: 'reminders_save',
    label: 'Reminders and follow-up',
    whyItMatters:
      'People lean on assistants to stop dropped balls more than to entertain them.',
    routeStrategy: 'capability-first',
  },
  {
    rank: 3,
    family: 'communication_help',
    label: 'Messages and reply help',
    whyItMatters:
      'Reply help is one of the highest-value everyday assistant behaviors because it is emotional as well as practical.',
    routeStrategy: 'capability-first',
  },
  {
    rank: 4,
    family: 'orientation_planning',
    label: 'Daily orientation and planning',
    whyItMatters:
      "This is where Andrea's chief-of-staff value shows up in normal life instead of in internal product labels.",
    routeStrategy: 'capability-first',
  },
  {
    rank: 5,
    family: 'review_followthrough',
    label: 'Review and open follow-through',
    whyItMatters:
      "People naturally ask what's still open far more often than they ask for a subsystem by name.",
    routeStrategy: 'capability-first',
  },
  {
    rank: 6,
    family: 'reminders_save',
    label: 'Save, notes, and remember-this',
    whyItMatters:
      'Lightweight capture is an everyday assistant behavior even when it stays bounded.',
    routeStrategy: 'capability-first',
  },
  {
    rank: 7,
    family: 'local_basics',
    label: 'Time and date',
    whyItMatters:
      'Quick deterministic answers build trust and make the assistant feel alive in ordinary use.',
    routeStrategy: 'local-first',
  },
  {
    rank: 8,
    family: 'compare_explain',
    label: 'Compare, explain, and what should I know',
    whyItMatters:
      'Bounded decision help feels intelligent and useful, especially before a purchase or tradeoff.',
    routeStrategy: 'research-first',
  },
  {
    rank: 9,
    family: 'orientation_planning',
    label: 'Routines like good morning, tonight, and review',
    whyItMatters:
      'Routine phrasing creates repeatable entry points into the assistant.',
    routeStrategy: 'capability-first',
  },
  {
    rank: 10,
    family: 'household_coordination',
    label: 'Household and family coordination',
    whyItMatters:
      'This is valuable, but it works better as a continuation lane than as the top public story.',
    routeStrategy: 'capability-first',
  },
] as const;

export const PRACTICAL_COMMAND_INVENTORY: readonly PracticalCommandEntry[] = [
  practicalCommand('local_basics', 'what time is it', 'alexa', ['telegram'], 'local'),
  practicalCommand('local_basics', 'what day is it', 'alexa', ['telegram'], 'local'),
  practicalCommand('local_basics', "what's up", 'alexa', ['telegram', 'bluebubbles'], 'local'),
  practicalCommand('local_basics', 'can you help me', 'alexa', ['telegram', 'bluebubbles'], 'local'),
  practicalCommand('local_basics', 'what can you do', 'alexa', ['telegram', 'bluebubbles'], 'local'),

  practicalCommand('calendar_schedule', "what's on my calendar today", 'alexa', ['telegram'], 'calendar_read'),
  practicalCommand('calendar_schedule', "what's on my calendar tomorrow", 'alexa', ['telegram'], 'calendar_read'),
  practicalCommand('calendar_schedule', 'what do I have this afternoon', 'alexa', ['telegram'], 'calendar_read'),
  practicalCommand('calendar_schedule', 'when is my first meeting tomorrow', 'alexa', ['telegram'], 'calendar_read'),
  practicalCommand('calendar_schedule', "what's next on my calendar", 'alexa', ['telegram'], 'calendar_read'),
  practicalCommand('calendar_schedule', 'what should I handle before my next meeting', 'alexa', ['telegram'], 'calendar_read'),

  practicalCommand('calendar_schedule', 'add dinner tomorrow at 6:30 PM', 'alexa', ['telegram'], 'calendar_write'),
  practicalCommand('calendar_schedule', 'put workout on my calendar Friday at 7', 'alexa', ['telegram'], 'calendar_write'),
  practicalCommand('calendar_schedule', 'schedule lunch tomorrow at noon', 'alexa', ['telegram'], 'calendar_write'),
  practicalCommand('calendar_schedule', 'move that to 7', 'alexa', ['telegram'], 'calendar_write'),
  practicalCommand('calendar_schedule', 'move my 3 PM to tomorrow', 'alexa', ['telegram'], 'calendar_write'),
  practicalCommand('calendar_schedule', 'cancel dinner tomorrow', 'alexa', ['telegram'], 'calendar_write'),

  practicalCommand('reminders_save', 'remind me to call Sam tomorrow at 3', 'alexa', ['telegram'], 'reminder_write'),
  practicalCommand('reminders_save', 'remind me at 4 to text Mom', 'alexa', ['telegram'], 'reminder_write'),
  practicalCommand('reminders_save', 'remind me about that tonight', 'alexa', ['telegram'], 'reminder_write'),
  practicalCommand('reminders_save', 'remind me later', 'alexa', ['telegram', 'bluebubbles'], 'reminder_write'),
  practicalCommand('reminders_save', 'save that for later', 'alexa', ['telegram', 'bluebubbles'], 'review'),
  practicalCommand('reminders_save', 'remember this', 'alexa', ['telegram'], 'review'),
  practicalCommand('reminders_save', 'add this to my evening reset', 'alexa', ['telegram'], 'reminder_write'),
  practicalCommand('reminders_save', 'send me the fuller version', 'handoff', ['alexa', 'telegram', 'bluebubbles'], 'telegram_handoff'),

  practicalCommand('orientation_planning', 'what am I forgetting', 'alexa', ['telegram'], 'daily_guidance'),
  practicalCommand('orientation_planning', 'what matters today', 'alexa', ['telegram'], 'planning'),
  practicalCommand('orientation_planning', 'what should I do next', 'alexa', ['telegram'], 'planning'),
  practicalCommand('orientation_planning', 'what should I remember tonight', 'alexa', ['telegram'], 'daily_guidance'),
  practicalCommand('orientation_planning', 'help me plan tonight', 'alexa', ['telegram'], 'planning'),
  practicalCommand('orientation_planning', 'help me figure out tomorrow morning', 'alexa', ['telegram'], 'planning'),
  practicalCommand('orientation_planning', "what's still open", 'alexa', ['telegram'], 'review'),

  practicalCommand('communication_help', 'what should I say back', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'give me a short reply', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'make that warmer', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'make that more direct', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'summarize this message', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'who do I still owe a reply', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'what do I owe people', 'alexa', ['telegram', 'bluebubbles'], 'communication'),
  practicalCommand('communication_help', 'remind me to reply later', 'alexa', ['telegram', 'bluebubbles'], 'communication'),

  practicalCommand('compare_explain', 'compare meal delivery and grocery delivery for a busy week', 'alexa', ['telegram'], 'research_or_knowledge'),
  practicalCommand('compare_explain', 'what should I know before deciding', 'alexa', ['telegram'], 'research_or_knowledge'),
  practicalCommand('compare_explain', 'explain this simply', 'alexa', ['telegram'], 'research_or_knowledge'),
  practicalCommand('compare_explain', 'tell me something interesting', 'alexa', ['telegram'], 'research_or_knowledge'),
  practicalCommand('compare_explain', 'summarize this', 'alexa', ['telegram', 'bluebubbles'], 'research_or_knowledge'),
  practicalCommand('compare_explain', 'help me think through this choice', 'alexa', ['telegram'], 'research_or_knowledge'),

  practicalCommand('review_followthrough', 'anything else', 'alexa', ['telegram', 'bluebubbles'], 'review'),
  practicalCommand('review_followthrough', 'what still needs attention', 'alexa', ['telegram', 'bluebubbles'], 'review'),
  practicalCommand('review_followthrough', 'what did I save about this', 'alexa', ['telegram'], 'review'),
  practicalCommand('review_followthrough', 'send that to Telegram', 'handoff', ['alexa', 'bluebubbles'], 'telegram_handoff'),

  practicalCommand('household_coordination', "what's still open with my family", 'telegram', ['alexa', 'bluebubbles'], 'thread_followup', 'secondary'),
  practicalCommand('household_coordination', 'what do I need to follow up on at home', 'telegram', ['alexa', 'bluebubbles'], 'thread_followup', 'secondary'),
  practicalCommand('household_coordination', 'what about Candace', 'telegram', ['alexa', 'bluebubbles'], 'thread_followup', 'secondary'),
  practicalCommand('household_coordination', "what's still open with Candace", 'telegram', ['alexa', 'bluebubbles'], 'thread_followup', 'secondary'),
  practicalCommand('household_coordination', 'what should I say back to Candace', 'telegram', ['alexa', 'bluebubbles'], 'communication', 'secondary'),
  practicalCommand('household_coordination', 'save this under the Candace thread', 'telegram', ['bluebubbles'], 'thread_followup', 'secondary'),
  practicalCommand('household_coordination', 'remind me to check in with Candace tonight', 'telegram', ['alexa', 'bluebubbles'], 'reminder_write', 'secondary'),
  practicalCommand('household_coordination', 'what do Candace and I have coming up', 'telegram', ['alexa', 'bluebubbles'], 'thread_followup', 'secondary'),
] as const;

const PRACTICAL_DISCOVERY_FAMILY_LABELS: Record<PracticalCommandFamilyId, string> = {
  local_basics: 'local basics',
  calendar_schedule: 'calendar and schedule',
  reminders_save: 'reminders and save-for-later',
  orientation_planning: 'planning and what matters today',
  communication_help: 'communication and quick reply help',
  compare_explain: 'compare, explain, and what to know',
  review_followthrough: 'review and follow-through',
  household_coordination: 'open follow-through and people',
};

const PRACTICAL_DISCOVERY_SPOTLIGHTS: Record<
  'telegram' | 'alexa' | 'bluebubbles',
  readonly string[]
> = {
  telegram: [
    "what's on my calendar tomorrow",
    'remind me to call Sam tomorrow at 3',
    'what should I say back',
    'help me plan tonight',
    'what should I know before deciding',
  ],
  alexa: [
    "what's on my calendar tomorrow",
    'remind me to call Sam tomorrow at 3',
    'help me plan tonight',
    'what should I say back',
    'what should I remember tonight',
  ],
  bluebubbles: [
    'what should I say back',
    'summarize this message',
    'give me a short reply',
    'remind me to reply later',
  ],
};

function includesSurface(
  entry: PracticalCommandEntry,
  surface: PracticalCommandSurface,
): boolean {
  return (
    entry.primarySurface === surface || entry.secondarySurfaces.includes(surface)
  );
}

export function getPracticalCommandsForSurface(
  surface: PracticalCommandSurface,
  options: {
    discoveryTier?: PracticalCommandDiscoveryTier;
    family?: PracticalCommandFamilyId;
  } = {},
): PracticalCommandEntry[] {
  return PRACTICAL_COMMAND_INVENTORY.filter((entry) => {
    if (!includesSurface(entry, surface)) return false;
    if (options.discoveryTier && entry.discoveryTier !== options.discoveryTier) {
      return false;
    }
    if (options.family && entry.family !== options.family) {
      return false;
    }
    return true;
  });
}

export function getPracticalDiscoverySpotlights(
  surface: 'telegram' | 'alexa' | 'bluebubbles',
): PracticalCommandEntry[] {
  const byPrompt = new Map(
    PRACTICAL_COMMAND_INVENTORY.map((entry) => [entry.prompt.toLowerCase(), entry] as const),
  );
  return PRACTICAL_DISCOVERY_SPOTLIGHTS[surface]
    .map((prompt) => byPrompt.get(prompt.toLowerCase()))
    .filter((entry): entry is PracticalCommandEntry => Boolean(entry));
}

export function getPracticalFamilyLabels(
  families: readonly PracticalCommandFamilyId[],
): string[] {
  return families.map((family) => PRACTICAL_DISCOVERY_FAMILY_LABELS[family]);
}

export const OPERATOR_SLASH_COMMAND_SURFACES: readonly CommandSurfaceEntry[] = [
  family('remote_control_start', '/remote-control', REMOTE_CONTROL_START_COMMANDS, 'Disabled experimental remote-control bridge.', 'operator', 'disabled'),
  family('remote_control_stop', '/remote-control-end', REMOTE_CONTROL_STOP_COMMANDS, 'Disabled remote-control stop path.', 'operator', 'disabled'),
  family('cursor_dashboard', '/cursor', CURSOR_DASHBOARD_COMMANDS, 'Open the main work cockpit.', 'operator', 'operator_only'),
  family('cursor_models', '/cursor-models', CURSOR_MODELS_COMMANDS, 'List available Cursor Cloud models.', 'operator', 'operator_only'),
  family('cursor_test', '/cursor-test', CURSOR_TEST_COMMANDS, 'Run Cursor troubleshooting smoke.', 'operator', 'operator_only'),
  family('cursor_jobs', '/cursor-jobs', CURSOR_JOBS_COMMANDS, 'Open tracked Cursor jobs.', 'operator', 'operator_only'),
  family('cursor_create', '/cursor-create', CURSOR_CREATE_COMMANDS, 'Start a Cursor Cloud job.', 'operator', 'operator_only'),
  family('cursor_sync', '/cursor-sync', CURSOR_SYNC_COMMANDS, 'Attach or refresh the current work item.', 'operator', 'operator_only'),
  family('cursor_select', '/cursor-select', CURSOR_SELECT_COMMANDS, 'Hidden current-work selector helper.', 'internal', 'operator_only'),
  family('cursor_ui', '/cursor-ui', CURSOR_UI_COMMANDS, 'Internal backing command for work-cockpit buttons.', 'internal', 'operator_only'),
  family('cursor_stop', '/cursor-stop', CURSOR_STOP_COMMANDS, 'Stop the current Cursor job.', 'operator', 'operator_only'),
  family('cursor_followup', '/cursor-followup', CURSOR_FOLLOWUP_COMMANDS, 'Send follow-up instructions to the current Cursor job.', 'operator', 'operator_only'),
  family('cursor_terminal', '/cursor-terminal', CURSOR_TERMINAL_COMMANDS, 'Run a line-oriented terminal command on the desktop bridge.', 'operator', 'operator_only'),
  family('cursor_terminal_help', '/cursor-terminal-help', CURSOR_TERMINAL_HELP_COMMANDS, 'Show desktop bridge terminal help.', 'operator', 'operator_only'),
  family('cursor_terminal_status', '/cursor-terminal-status', CURSOR_TERMINAL_STATUS_COMMANDS, 'Inspect desktop bridge terminal state.', 'operator', 'operator_only'),
  family('cursor_terminal_log', '/cursor-terminal-log', CURSOR_TERMINAL_LOG_COMMANDS, 'Read cached desktop bridge terminal output.', 'operator', 'operator_only'),
  family('cursor_terminal_stop', '/cursor-terminal-stop', CURSOR_TERMINAL_STOP_COMMANDS, 'Stop the current desktop bridge terminal command.', 'operator', 'operator_only'),
  family('cursor_conversation', '/cursor-conversation', CURSOR_CONVERSATION_COMMANDS, 'Show the text trail for the current work item.', 'operator', 'operator_only'),
  family('cursor_results', '/cursor-results', CURSOR_ARTIFACTS_COMMANDS, 'List tracked output files for the current Cursor job.', 'operator', 'operator_only'),
  family('cursor_download', '/cursor-download', CURSOR_ARTIFACT_LINK_COMMANDS, 'Generate a temporary download link for one result file.', 'operator', 'operator_only'),
  family('runtime_status', '/runtime-status', RUNTIME_STATUS_COMMANDS, 'Show the Codex/OpenAI runtime lane status.', 'operator', 'operator_only'),
  family('runtime_jobs', '/runtime-jobs', RUNTIME_JOBS_COMMANDS, 'List runtime-lane jobs.', 'operator', 'operator_only'),
  family('runtime_create', '/runtime-create', RUNTIME_CREATE_COMMANDS, 'Create a runtime-lane job.', 'operator', 'operator_only'),
  family('runtime_job', '/runtime-job', RUNTIME_JOB_COMMANDS, 'Inspect one runtime-lane job.', 'operator', 'operator_only'),
  family('runtime_followup', '/runtime-followup', RUNTIME_FOLLOWUP_COMMANDS, 'Send follow-up instructions to a runtime-lane job.', 'operator', 'operator_only'),
  family('runtime_stop', '/runtime-stop', RUNTIME_STOP_COMMANDS, 'Stop a runtime-lane job.', 'operator', 'operator_only'),
  family('runtime_logs', '/runtime-logs', RUNTIME_LOGS_COMMANDS, 'Read runtime-lane logs.', 'operator', 'operator_only'),
  family('debug_status', '/debug-status', DEBUG_STATUS_COMMANDS, 'Show live troubleshooting state.', 'operator', 'operator_only'),
  family('debug_level', '/debug-level', DEBUG_LEVEL_COMMANDS, 'Apply a temporary live debug override.', 'operator', 'operator_only'),
  family('debug_reset', '/debug-reset', DEBUG_RESET_COMMANDS, 'Clear one or all debug overrides.', 'operator', 'operator_only'),
  family('debug_logs', '/debug-logs', DEBUG_LOGS_COMMANDS, 'Read recent sanitized troubleshooting logs.', 'operator', 'operator_only'),
  family('alexa_status', '/alexa-status', ALEXA_STATUS_COMMANDS, 'Show Alexa listener, model-sync, and proof status.', 'operator', 'operator_only'),
  family('amazon_status', '/amazon-status', AMAZON_STATUS_COMMANDS, 'Show Amazon Business integration status.', 'operator', 'bounded'),
  family('amazon_search', '/amazon-search', AMAZON_SEARCH_COMMANDS, 'Search Amazon Business offers.', 'operator', 'bounded'),
  family('purchase_request', '/purchase-request', PURCHASE_REQUEST_COMMANDS, 'Open a purchase request.', 'operator', 'bounded'),
  family('purchase_requests', '/purchase-requests', PURCHASE_REQUESTS_COMMANDS, 'List open purchase requests.', 'operator', 'bounded'),
  family('purchase_approve', '/purchase-approve', PURCHASE_APPROVE_COMMANDS, 'Approve a purchase request.', 'operator', 'bounded'),
  family('purchase_cancel', '/purchase-cancel', PURCHASE_CANCEL_COMMANDS, 'Cancel a purchase request.', 'operator', 'bounded'),
];

export const INTERNAL_BUTTON_COMMAND_SURFACES: readonly CommandSurfaceEntry[] = [
  {
    id: 'cursor_ui_family',
    preferredAlias: '/cursor-ui *',
    acceptedAliases: ['/cursor-ui *', '/cursor_ui *'],
    audience: 'internal',
    surfaceKind: 'button_backing',
    channelScope: ['telegram', 'operator'],
    discoverability: ['operator_docs', 'internal_only'],
    truthClass: 'operator_only',
    summary: 'Backs the /cursor dashboard buttons and tiles.',
    description:
      'Includes status, jobs, home, sync, text, files, followup, stop, terminal, runtime, and wizard actions.',
  },
  {
    id: 'bundle_command_family',
    preferredAlias: '/bundle-*',
    acceptedAliases: [
      '/bundle-toggle',
      '/bundle-run-selected',
      '/bundle-skip-selected',
      '/bundle-show',
      '/bundle-run-all',
      '/bundle-pick',
      '/bundle-defer',
    ],
    audience: 'internal',
    surfaceKind: 'button_backing',
    channelScope: ['telegram', 'cross_channel', 'operator'],
    discoverability: ['operator_docs', 'internal_only'],
    truthClass: 'bounded',
    summary: 'Backs action-bundle and review buttons.',
    description:
      'Internal button family for bundle selection, run, skip, show, and defer controls.',
  },
  {
    id: 'runtime_card_actions',
    preferredAlias: '/runtime-* card actions',
    acceptedAliases: [
      '/runtime-status',
      '/runtime-jobs',
      '/runtime-logs',
      '/runtime-stop',
    ],
    audience: 'internal',
    surfaceKind: 'inline_action',
    channelScope: ['telegram', 'operator'],
    discoverability: ['operator_docs', 'internal_only'],
    truthClass: 'operator_only',
    summary: 'Backs runtime cards inside the work cockpit.',
    description:
      'Reply-linked current-work actions for the explicit runtime fallback lane.',
  },
  {
    id: 'review_controls',
    preferredAlias: 'review controls',
    acceptedAliases: [
      'send',
      'send later',
      'remind later',
      'save under thread',
      'keep as draft',
    ],
    audience: 'internal',
    surfaceKind: 'inline_action',
    channelScope: ['telegram', 'bluebubbles', 'cross_channel'],
    discoverability: ['operator_docs'],
    truthClass: 'bounded',
    summary: 'Inline action language for send, remind, save, defer, and keep-as-draft.',
    description:
      'Used across messaging, action bundles, and follow-through review.',
  },
];

export const NATURAL_LANGUAGE_DISCOVERY_SURFACES: readonly CommandSurfaceEntry[] = [
  {
    id: 'telegram_rich_surface',
    preferredAlias: 'Telegram rich companion surface',
    acceptedAliases: ['Telegram'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram'],
    discoverability: ['/help', '/features'],
    truthClass: 'live_proven',
    summary: "Andrea's richest day-to-day companion and operator surface.",
    description:
      'Best for follow-through, planning, reminders, scheduling, messaging review, and richer execution.',
  },
  {
    id: 'alexa_voice_surface',
    preferredAlias: 'Alexa bounded voice surface',
    acceptedAliases: ['Alexa', 'Andrea custom skill'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['alexa'],
    discoverability: ['/help', '/features', 'operator_docs'],
    truthClass: 'bounded',
    summary: 'Concise voice help for your day, calendar, reminders, and short follow-up.',
    description:
      'Best for voice orientation, calendar and reminder asks, short planning follow-up, and quick reply help.',
    statusAuthority:
      'Check npm run services:status or npm run debug:status for the current live proof and model-sync state.',
  },
  {
    id: 'bluebubbles_bounded_surface',
    preferredAlias: 'BlueBubbles bounded messaging companion',
    acceptedAliases: ['BlueBubbles', '@Andrea in Messages'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['bluebubbles'],
    discoverability: ['/help', '/features', 'operator_docs'],
    truthClass: 'bounded',
    summary: 'Bounded personal messaging help in the current thread.',
    description:
      'Mention-required personal messaging companion for summarizing, drafting, reminding later, and same-thread send/defer decisions.',
    statusAuthority:
      'Use npm run debug:bluebubbles -- --live and npm run services:status for the current proof bar.',
  },
  {
    id: 'ordinary_chat',
    preferredAlias: 'ordinary chat',
    acceptedAliases: ['hi', "what's up", 'how is it going', 'thanks'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'bluebubbles', 'alexa'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Warm ordinary-chat replies and fast local asks.',
    description: 'Includes greetings, time/date, light math, and concise help prompts.',
  },
  {
    id: 'calendar_and_schedule',
    preferredAlias: 'calendar and schedule',
    acceptedAliases: [
      "what's on my calendar tomorrow",
      "what's next on my calendar",
      'add dinner tomorrow at 6:30 PM',
    ],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Calendar reads, adds, moves, and short schedule check-ins.',
    description:
      'Alexa is strong for quick voice scheduling, and Telegram is richer when you want more detail or completion.',
  },
  {
    id: 'reminders_and_save_for_later',
    preferredAlias: 'reminders and save-for-later',
    acceptedAliases: [
      'remind me to call Sam tomorrow at 3',
      'remind me later',
      'save that for later',
    ],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'bluebubbles', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Reminders, remember-this capture, and bounded save-for-later flow.',
    description:
      'Good for not dropping the ball, with Telegram as the richer continuation surface.',
  },
  {
    id: 'planning_and_next_steps',
    preferredAlias: 'planning and next steps',
    acceptedAliases: [
      'what am I forgetting',
      'what matters today',
      'help me plan tonight',
    ],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Daily orientation, planning, and what to do next.',
    description:
      'The most practical Andrea-first planning surface for everyday decisions, prep, and open loops.',
  },
  {
    id: 'communication_and_reply_help',
    preferredAlias: 'communication and reply help',
    acceptedAliases: [
      'what should I say back',
      'what do I owe people',
      'summarize this message',
    ],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'bluebubbles', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'bounded',
    summary: 'Reply drafting, message summaries, and open communication follow-through.',
    description:
      'Telegram is richer, BlueBubbles is calmer same-thread help, and Alexa is good for a concise first draft.',
  },
  {
    id: 'compare_explain_and_saved_context',
    preferredAlias: 'compare, explain, and saved context',
    acceptedAliases: [
      'what should I know before deciding',
      'compare these options',
      'tell me something interesting',
    ],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'bounded',
    summary: 'Compare, explain, summarize, and use saved context when it helps.',
    description:
      'Telegram is richest for fuller answers, while Alexa keeps it short and bounded.',
  },
  {
    id: 'open_followthrough_and_people',
    preferredAlias: 'open follow-through and people',
    acceptedAliases: [
      "what's still open",
      "what's still open with my family",
      "what about Candace",
    ],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'bluebubbles', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Review open loops, people, and household follow-through.',
    description:
      'Person-specific continuity is strong, but it is now framed as a continuation lane rather than the top public story.',
  },
  {
    id: 'coding_and_work_help',
    preferredAlias: 'coding and work help',
    acceptedAliases: ['/cursor_status', 'project help'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram'],
    discoverability: ['/features', '/commands'],
    truthClass: 'live_proven',
    summary: 'Coding/work help stays available, with deeper operator control kept separate.',
    description:
      'Normal users get /cursor_status and natural-language project help. Deeper work-cockpit controls stay operator-only.',
  },
];

export const OPERATOR_SCRIPT_SURFACES: readonly CommandSurfaceEntry[] = [
  {
    id: 'services_status',
    preferredAlias: 'npm run services:status',
    acceptedAliases: ['npm run services:status'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Canonical host and proof summary.',
  },
  {
    id: 'setup_verify',
    preferredAlias: 'npm run setup -- --step verify',
    acceptedAliases: ['npm run setup -- --step verify'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Canonical setup and external-blocker verifier.',
  },
  {
    id: 'debug_status',
    preferredAlias: 'npm run debug:status',
    acceptedAliases: ['npm run debug:status'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Detailed proof and debug surface.',
  },
  {
    id: 'debug_pilot',
    preferredAlias: 'npm run debug:pilot',
    acceptedAliases: ['npm run debug:pilot'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Flagship journey proof and pilot review surface.',
  },
  {
    id: 'debug_bluebubbles_live',
    preferredAlias: 'npm run debug:bluebubbles -- --live',
    acceptedAliases: ['npm run debug:bluebubbles -- --live'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Live BlueBubbles transport and proof view.',
  },
  {
    id: 'debug_google_calendar',
    preferredAlias: 'npm run debug:google-calendar',
    acceptedAliases: ['npm run debug:google-calendar'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Bounded Google Calendar read/write proof harness.',
  },
  {
    id: 'debug_signature_flows',
    preferredAlias: 'npm run debug:signature-flows',
    acceptedAliases: ['npm run debug:signature-flows'],
    audience: 'operator',
    surfaceKind: 'script',
    channelScope: ['operator'],
    discoverability: ['operator_docs'],
    truthClass: 'operator_only',
    summary: 'Signature-journey product proof harness.',
  },
];

export const COMMAND_SURFACE_REGISTRY: readonly CommandSurfaceEntry[] = [
  ...PUBLIC_TELEGRAM_COMMAND_SURFACES,
  ...OPERATOR_SLASH_COMMAND_SURFACES,
  ...INTERNAL_BUTTON_COMMAND_SURFACES,
  ...NATURAL_LANGUAGE_DISCOVERY_SURFACES,
  ...OPERATOR_SCRIPT_SURFACES,
];

export function getTelegramBotMenuCommands(): Array<{
  command: string;
  description: string;
}> {
  return PUBLIC_TELEGRAM_COMMAND_SURFACES.map((entry) => ({
    command: entry.preferredAlias.replace(/^\//, ''),
    description: entry.menuDescription ?? entry.summary,
  }));
}

export function getTelegramBotGroupMenuCommands(): Array<{
  command: string;
  description: string;
}> {
  const groupMenuIds = new Set([
    'telegram_help',
    'telegram_commands',
    'telegram_features',
    'telegram_ping',
  ]);
  return PUBLIC_TELEGRAM_COMMAND_SURFACES.filter((entry) =>
    groupMenuIds.has(entry.id),
  ).map((entry) => ({
    command: entry.preferredAlias.replace(/^\//, ''),
    description: entry.menuDescription ?? entry.summary,
  }));
}

export function buildTelegramWelcomeLines(assistantName: string): string[] {
  const examples = getPracticalDiscoverySpotlights('telegram')
    .slice(0, 4)
    .map((entry) => `- \`${entry.prompt}\``);
  return [
    `*Welcome to ${assistantName}*`,
    '',
    '- Start with a normal request in plain language.',
    "- Telegram is Andrea's richest surface for calendar help, reminders, planning, reply help, and deeper answers.",
    '',
    '*Start Here*',
    '- In a direct chat: send a normal message. If this will be your main Andrea chat, run `/registermain` once.',
    '- In a group: mention my Telegram username when you want me to jump in.',
    '- Use `/commands` for setup and status commands, and `/features` for the short capability guide.',
    '',
    '*Best First Asks*',
    ...examples,
  ];
}

export function buildTelegramHelpLines(assistantName: string): string[] {
  const examples = getPracticalDiscoverySpotlights('telegram')
    .slice(0, 4)
    .map((entry) => `- \`${entry.prompt}\``);
  return [
    `*How ${assistantName} Works Here*`,
    '',
    '- Most people should just send a normal message.',
    "- Telegram is Andrea's richest surface for scheduling, reminders, planning, reply help, review, and richer detail.",
    '',
    '*Best Habits*',
    '- In a DM: ask normally, or run `/registermain` once if this should be your main Andrea chat.',
    '- In a group: mention my Telegram username when you want a reply.',
    '- Use `/commands` for setup and status commands.',
    '- Use `/features` for the short guide to what Andrea is best at here.',
    '',
    '*Good Next Messages*',
    ...examples,
  ];
}

export function buildTelegramCommandLines(): string[] {
  const surfaceById = new Map(
    PUBLIC_TELEGRAM_COMMAND_SURFACES.map((entry) => [entry.id, entry] as const),
  );
  const render = (id: string): string => {
    const entry = surfaceById.get(id);
    if (!entry) {
      throw new Error(`Missing Telegram command surface: ${id}`);
    }
    return `- \`${entry.preferredAlias}\` - ${entry.summary}`;
  };
  return [
    '*Telegram Commands*',
    '',
    '- Most people can ignore commands and just type normally. Commands are mainly for onboarding, setup, and status.',
    '',
    '*Start Here*',
    render('telegram_start'),
    render('telegram_help'),
    render('telegram_registermain'),
    '',
    '*Useful Checks*',
    render('telegram_commands'),
    render('telegram_features'),
    render('telegram_ping'),
    render('telegram_chatid'),
    render('telegram_cursor_status'),
    '',
    '*In Groups*',
    '- Mention my Telegram username when you want me to jump in. The group command menu stays intentionally small.',
    '',
    '- Deeper operator/admin controls stay out of normal help and live in the admin path.',
  ];
}

export function buildTelegramFeatureLines(assistantName: string): string[] {
  return [
    `*What ${assistantName} Is Best At*`,
    '',
    '- Telegram is the deepest day-to-day surface. Use it when you want a real answer, a concrete next step, or richer follow-through.',
    '',
    '*Best Here*',
    '- Check your schedule, add or move something on your calendar, and set reminders.',
    '- Figure out what matters today, what is still open, and what to do next.',
    '- Draft replies, summarize messages, and keep communication follow-through clean.',
    '- Compare options, explain a decision, and get source-grounded summaries when those lanes are available.',
    '- Keep track of open follow-through across people, projects, and home without making that the whole public story.',
    '',
    '*Surface Map*',
    '- Telegram is the richest surface for detailed answers and action completion.',
    '- Alexa is concise voice help for calendar, reminders, planning, review, and quick reply help.',
    '- BlueBubbles is bounded Messages help in the current thread; mention `@Andrea` there for summaries, drafts, and remind-later decisions.',
    '- Research and image generation are optional lanes when those provider paths are available.',
    '- `/cursor_status` is the safe readiness check for coding and work help. Deeper operator controls stay in Telegram admin surfaces.',
  ];
}

export function buildTelegramDescription(assistantName: string): string {
  return `${assistantName} helps with calendar and schedule questions, reminders, planning, reply help, and calm follow-through. Start with a normal message. In DM, run /registermain once to make it your main Andrea chat.`;
}

export function buildTelegramShortDescription(assistantName: string): string {
  return `${assistantName}: calendar, reminders, planning, replies, and follow-through.`;
}


