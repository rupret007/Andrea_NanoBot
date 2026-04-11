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
    id: 'reminders_and_calendar',
    preferredAlias: 'reminders and calendar scheduling',
    acceptedAliases: ['remind me later', 'put this on my calendar'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Reminders, recurring follow-through, and calendar scheduling.',
    description:
      'Telegram is the richest place for reminder and calendar follow-through.',
  },
  {
    id: 'research_and_library',
    preferredAlias: 'research and knowledge library',
    acceptedAliases: ['research this', 'save this to my library'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Research, summaries, and source-grounded saved material.',
    description:
      'Supports richer research, source explanation, and library save/reuse flows.',
  },
  {
    id: 'life_threads_and_followthrough',
    preferredAlias: 'life threads and follow-through',
    acceptedAliases: ['what am I forgetting', "what's still open with Candace"],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'bluebubbles', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'live_proven',
    summary: 'Ongoing people, household, and open-loop guidance.',
    description: 'Thread-aware daily guidance and relationship follow-through.',
  },
  {
    id: 'communication_companion',
    preferredAlias: 'communication companion',
    acceptedAliases: ['what should I say back', 'summarize this'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'bluebubbles', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'bounded',
    summary: 'Draft, revise, save, remind, and same-thread messaging help.',
    description:
      'Best in Telegram for richer management, with BlueBubbles as the bounded real messaging channel.',
  },
  {
    id: 'missions_and_chief_of_staff',
    preferredAlias: 'missions and chief-of-staff guidance',
    acceptedAliases: ['help me plan tonight', 'what matters most today'],
    audience: 'user',
    surfaceKind: 'natural_language',
    channelScope: ['telegram', 'alexa', 'cross_channel'],
    discoverability: ['/features'],
    truthClass: 'bounded',
    summary: 'Planning, priorities, blockers, and next-step guidance.',
    description:
      'Supports bounded planning, mission follow-through, and explainable decision support.',
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
  return [
    `*Welcome to ${assistantName}*`,
    '',
    '- Start with a normal request in plain language.',
    "- Telegram is Andrea's richest surface for day-to-day help, follow-through, and deeper answers.",
    '',
    '*Start Here*',
    '- In a direct chat: send a normal message. If this will be your main Andrea chat, run `/registermain` once.',
    '- In a group: mention my Telegram username when you want me to jump in.',
    '- Use `/commands` for setup and status commands, and `/features` for the short capability guide.',
    '',
    '*Try One Of These*',
    '- `What am I forgetting today?`',
    '- `Add dinner with Candace tomorrow at 6:30 PM`',
    '- `What should I say back?`',
    '- `Research the best standing desks for a small office`',
  ];
}

export function buildTelegramHelpLines(assistantName: string): string[] {
  return [
    `*How ${assistantName} Works Here*`,
    '',
    '- Most people should just send a normal message.',
    "- Telegram is Andrea's richest surface for planning, reminders, research, and follow-through.",
    '',
    '*Best Habits*',
    '- In a DM: ask normally, or run `/registermain` once if this should be your main Andrea chat.',
    '- In a group: mention my Telegram username when you want a reply.',
    '- Use `/commands` for setup and status commands.',
    '- Use `/features` for the short guide to what Andrea is best at here.',
    '',
    '*Good Next Messages*',
    '- `What am I forgetting today?`',
    '- `What should I say back?`',
    '- `Help me plan tonight`',
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
    '- Telegram is the deepest day-to-day surface. Use it when you want a real answer, a plan, or follow-through.',
    '',
    '*Best Here*',
    "- Figure out what matters today and what you're forgetting.",
    '- Capture reminders, recurring tasks, and calendar scheduling when that path is enabled.',
    '- Research options, compare them, and get source-grounded summaries.',
    '- Draft replies, save things for later, and plan the next step.',
    '- Keep track of people, projects, and household follow-through.',
    '',
    '*Surface Map*',
    '- Telegram is the richest surface for detailed answers and action completion.',
    '- Alexa is concise voice help for calendar, reminders, orientation, and short follow-up.',
    '- BlueBubbles is bounded Messages help in the current thread; mention `@Andrea` there.',
    '- Research and image generation are optional lanes when those provider paths are available.',
    '- `/cursor_status` is the safe readiness check for coding and work help. Deeper operator controls stay in Telegram admin surfaces.',
  ];
}

export function buildTelegramDescription(assistantName: string): string {
  return `${assistantName} helps with planning, reminders, research, and calm follow-through. Start with a normal message. In DM, run /registermain once to make it your main Andrea chat.`;
}

export function buildTelegramShortDescription(assistantName: string): string {
  return `${assistantName}: planning, reminders, research, and calm follow-through.`;
}


