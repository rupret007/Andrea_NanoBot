import type {
  ChannelInlineAction,
  PilotBlockerOwner,
  ResponseFeedbackClassification,
  ResponseFeedbackRecord,
  ResponseFeedbackRuntimePreference,
  SendMessageOptions,
} from './types.js';

export type ResponseFeedbackActionKind =
  | 'capture'
  | 'start'
  | 'why'
  | 'not_now'
  | 'keep_local'
  | 'commit_only'
  | 'commit_push';

export interface ParsedResponseFeedbackAction {
  feedbackId: string;
  operation: ResponseFeedbackActionKind;
}

export interface ResponseFeedbackClassificationResult {
  classification: ResponseFeedbackClassification;
  status: ResponseFeedbackRecord['status'];
  blockerOwner: PilotBlockerOwner;
  explanation: string;
}

export interface ResponseFeedbackLaneAvailability {
  runtimeAvailable: boolean;
  runtimeLocalPreferred: boolean;
  runtimeCloudAllowed: boolean;
  runtimeDetail?: string | null;
  cursorCloudAvailable: boolean;
  cursorCloudDetail?: string | null;
  cursorDesktopAvailable: boolean;
  cursorDesktopDetail?: string | null;
}

export interface ResponseFeedbackLaneSelection {
  laneId: 'cursor' | 'andrea_runtime' | null;
  runtimePreference: ResponseFeedbackRuntimePreference | null;
  label: string;
  promptPrefix: string;
  reason: string;
}

const RESPONSE_FEEDBACK_ACTION_PREFIX = 'feedback';

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function splitInlineActionsIntoRows(
  actions: ChannelInlineAction[],
): ChannelInlineAction[][] {
  return actions.reduce<ChannelInlineAction[][]>((rows, action, index) => {
    const rowIndex = Math.floor(index / 3);
    if (!rows[rowIndex]) rows[rowIndex] = [];
    rows[rowIndex].push(action);
    return rows;
  }, []);
}

function formatClassificationLabel(
  classification: ResponseFeedbackClassification,
): string {
  switch (classification) {
    case 'repo_side_broken':
      return 'repo-side broken flow';
    case 'repo_side_rough_edge':
      return 'repo-side rough edge';
    case 'manual_sync_only':
      return 'manual sync step';
    case 'externally_blocked':
    default:
      return 'external blocker';
  }
}

export function buildResponseFeedbackActionId(
  feedbackId: string,
  operation: ResponseFeedbackActionKind,
): string {
  return `${RESPONSE_FEEDBACK_ACTION_PREFIX}:${feedbackId}:${operation}`;
}

export function parseResponseFeedbackAction(
  text: string | null | undefined,
): ParsedResponseFeedbackAction | null {
  const trimmed = normalizeText(text);
  const match = trimmed.match(
    /^feedback:([a-f0-9-]{8,}):(capture|start|why|not_now|keep_local|commit_only|commit_push)$/i,
  );
  if (!match) return null;
  return {
    feedbackId: match[1] || '',
    operation: (match[2] || 'capture') as ResponseFeedbackActionKind,
  };
}

export function appendResponseFeedbackInlineRow(
  options: SendMessageOptions = {},
  feedbackId: string,
): SendMessageOptions {
  const feedbackRow: ChannelInlineAction[] = [
    {
      label: 'Not helpful',
      actionId: buildResponseFeedbackActionId(feedbackId, 'capture'),
    },
  ];
  const existingRows =
    options.inlineActionRows && options.inlineActionRows.length > 0
      ? options.inlineActionRows.map((row) => [...row])
      : options.inlineActions && options.inlineActions.length > 0
        ? splitInlineActionsIntoRows(options.inlineActions)
        : [];
  return {
    ...options,
    inlineActions: undefined,
    inlineActionRows: [...existingRows, feedbackRow],
  };
}

export function classifyResponseFeedbackCandidate(params: {
  originalUserText: string;
  assistantReplyText: string;
  routeKey?: string | null;
  capabilityId?: string | null;
  responseSource?: string | null;
  traceReason?: string | null;
  blockerClass?: string | null;
}): ResponseFeedbackClassificationResult {
  const ask = normalizeText(params.originalUserText).toLowerCase();
  const reply = normalizeText(params.assistantReplyText).toLowerCase();
  const routeKey = normalizeText(params.routeKey).toLowerCase();
  const capabilityId = normalizeText(params.capabilityId).toLowerCase();
  const responseSource = normalizeText(params.responseSource).toLowerCase();
  const traceReason = normalizeText(params.traceReason).toLowerCase();
  const blockerClass = normalizeText(params.blockerClass).toLowerCase();
  const combined = [reply, traceReason, blockerClass, routeKey, capabilityId]
    .filter(Boolean)
    .join(' ');

  if (
    /manual sync|build model|mark-synced|developer console|interaction model/.test(
      combined,
    )
  ) {
    return {
      classification: 'manual_sync_only',
      status: 'manual_sync_only',
      blockerOwner: 'external',
      explanation:
        'This looks like a manual surface-sync step rather than a repo bug, so Andrea should keep it captured without auto-starting a fix.',
    };
  }

  if (
    responseSource === 'research_handoff' ||
    responseSource === 'media_handoff' ||
    /quota|provider|api key|not configured|blocked|live research|image generation|can't check that live|couldn't check that live|live lookup (?:was )?unavailable|live lookup unavailable|can't do a live lookup|can't pull live|can't fetch live/.test(
      combined,
    )
  ) {
    return {
      classification: 'externally_blocked',
      status: 'blocked_external',
      blockerOwner: 'external',
      explanation:
        'This reply looks limited by a blocked external lane, so Andrea should keep the issue and explain the blocker instead of auto-starting a repo fix.',
    };
  }

  if (
    /\b(news|headlines|latest news|news today|what(?:’|')?s the news|today(?:’|')?s news)\b/.test(
      ask,
    ) &&
    !/\b(news|headline|today|story|stories)\b/.test(reply)
  ) {
    return {
      classification: 'repo_side_broken',
      status: 'awaiting_confirmation',
      blockerOwner: 'repo_side',
      explanation:
        'The ask looks like a current-news request, but the reply stayed generic instead of routing into the right live-news or honest-fallback path.',
    };
  }

  if (!routeKey && !capabilityId && responseSource !== 'local_companion') {
    return {
      classification: 'repo_side_broken',
      status: 'awaiting_confirmation',
      blockerOwner: 'repo_side',
      explanation:
        'Andrea lost the intended route for this reply, so this looks like a repo-side broken path rather than a simple wording miss.',
    };
  }

  return {
    classification: 'repo_side_rough_edge',
    status: 'awaiting_confirmation',
    blockerOwner: 'repo_side',
    explanation:
      'This looks like a real repo-side rough edge: the answer landed, but the route, fallback, or wording still missed the user’s intent.',
  };
}

export function buildResponseFeedbackActionRows(
  record: Pick<ResponseFeedbackRecord, 'feedbackId' | 'status' | 'classification'>,
): SendMessageOptions['inlineActionRows'] {
  if (record.status === 'resolved_locally') {
    return [
      [
        {
          label: 'Commit + push',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'commit_push',
          ),
        },
        {
          label: 'Commit only',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'commit_only',
          ),
        },
      ],
      [
        {
          label: 'Keep local',
          actionId: buildResponseFeedbackActionId(
            record.feedbackId,
            'keep_local',
          ),
        },
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
      ],
    ];
  }
  if (record.status === 'landed') {
    return [
      [
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
      ],
    ];
  }
  if (
    record.status === 'blocked_external' ||
    record.status === 'manual_sync_only'
  ) {
    return [
      [
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
        {
          label: 'Not now',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
        },
      ],
    ];
  }
  if (record.status === 'running') {
    return [
      [
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
      ],
    ];
  }
  if (record.status === 'failed') {
    return [
      [
        {
          label: 'Retry fix',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'start'),
        },
        {
          label: 'Why',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
        },
        {
          label: 'Not now',
          actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
        },
      ],
    ];
  }
  return [
    [
      {
        label: 'Start fix',
        actionId: buildResponseFeedbackActionId(record.feedbackId, 'start'),
      },
      {
        label: 'Why',
        actionId: buildResponseFeedbackActionId(record.feedbackId, 'why'),
      },
      {
        label: 'Not now',
        actionId: buildResponseFeedbackActionId(record.feedbackId, 'not_now'),
      },
    ],
  ];
}

export function appendResponseFeedbackActionRows(params: {
  record: Pick<ResponseFeedbackRecord, 'feedbackId' | 'status' | 'classification'>;
  inlineActions?: ChannelInlineAction[] | null;
  inlineActionRows?: ChannelInlineAction[][] | null;
}): SendMessageOptions['inlineActionRows'] {
  const baseRows =
    params.inlineActionRows && params.inlineActionRows.length > 0
      ? params.inlineActionRows.map((row) => [...row])
      : params.inlineActions && params.inlineActions.length > 0
        ? splitInlineActionsIntoRows(params.inlineActions)
        : [];
  return [
    ...baseRows,
    ...(buildResponseFeedbackActionRows(params.record) || []),
  ];
}

export function buildResponseFeedbackCaptureReply(
  record: Pick<
    ResponseFeedbackRecord,
    'classification' | 'assistantReplyText' | 'feedbackId' | 'status'
  >,
  explanation: string,
): string {
  const classification = formatClassificationLabel(record.classification);
  const replyPreview =
    normalizeText(record.assistantReplyText).slice(0, 140) || 'that reply';
  if (
    record.status === 'blocked_external' ||
    record.status === 'manual_sync_only'
  ) {
    return [
      'I saved that as a private pilot issue.',
      `This one looks like an ${classification}, so I am not auto-starting a repo fix.`,
      explanation,
      `Saved reply excerpt: "${replyPreview}"`,
    ].join('\n');
  }
  return [
    'I saved that as a private pilot issue.',
    `This looks like a ${classification}, and I can prep a targeted fix job if you want.`,
    explanation,
    `Saved reply excerpt: "${replyPreview}"`,
  ].join('\n');
}

export function buildResponseFeedbackWhyText(
  record: Pick<
    ResponseFeedbackRecord,
    | 'classification'
    | 'routeKey'
    | 'capabilityId'
    | 'responseSource'
    | 'traceReason'
    | 'blockerClass'
    | 'remediationLaneId'
    | 'remediationRuntimePreference'
  >,
  explanation: string,
): string {
  return [
    `Why I classified this as ${formatClassificationLabel(record.classification)}:`,
    explanation,
    record.capabilityId ? `Capability: ${record.capabilityId}` : null,
    record.routeKey ? `Route key: ${record.routeKey}` : null,
    record.responseSource ? `Response source: ${record.responseSource}` : null,
    record.traceReason ? `Trace reason: ${record.traceReason}` : null,
    record.blockerClass ? `Blocker class: ${record.blockerClass}` : null,
    record.remediationLaneId
      ? `Prepared lane: ${record.remediationLaneId}${record.remediationRuntimePreference ? ` (${record.remediationRuntimePreference})` : ''}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function selectResponseFeedbackLane(
  availability: ResponseFeedbackLaneAvailability,
): ResponseFeedbackLaneSelection {
  if (availability.runtimeAvailable && availability.runtimeLocalPreferred) {
    return {
      laneId: 'andrea_runtime',
      runtimePreference: 'codex_local',
      label: 'Codex local',
      promptPrefix: '[runtime: local]',
      reason:
        availability.runtimeDetail ||
        'Codex local is healthy and authenticated on this host, so it is the best remediation lane.',
    };
  }

  if (availability.runtimeAvailable && availability.runtimeCloudAllowed) {
    return {
      laneId: 'andrea_runtime',
      runtimePreference: 'codex_cloud',
      label: 'Codex cloud',
      promptPrefix: '[runtime: cloud]',
      reason:
        availability.runtimeDetail ||
        'The Codex/OpenAI runtime lane is healthy, but local execution is not the best ready path right now.',
    };
  }

  if (availability.cursorCloudAvailable) {
    return {
      laneId: 'cursor',
      runtimePreference: 'cursor_cloud',
      label: 'Cursor Cloud',
      promptPrefix: '',
      reason:
        availability.cursorCloudDetail ||
        'Cursor Cloud is the healthiest queued remediation lane available right now.',
    };
  }

  if (availability.cursorDesktopAvailable) {
    return {
      laneId: null,
      runtimePreference: 'cursor_local',
      label: 'Cursor desktop bridge',
      promptPrefix: '',
      reason:
        availability.cursorDesktopDetail ||
        'The desktop bridge is reachable, but queued self-fix jobs still belong on Cursor Cloud in the current product.',
    };
  }

  return {
    laneId: null,
    runtimePreference: null,
    label: 'No ready remediation lane',
    promptPrefix: '',
    reason:
      'Neither the Codex/OpenAI runtime lane nor Cursor Cloud is healthy enough to auto-start a remediation job right now.',
  };
}

export function selectResponseFeedbackRetryLane(params: {
  record: Pick<
    ResponseFeedbackRecord,
    'status' | 'remediationRuntimePreference'
  >;
  availability: ResponseFeedbackLaneAvailability;
}): ResponseFeedbackLaneSelection {
  const selection = selectResponseFeedbackLane(params.availability);
  if (
    params.record.status === 'failed' &&
    params.record.remediationRuntimePreference === 'codex_local' &&
    selection.laneId === 'andrea_runtime' &&
    selection.runtimePreference === 'codex_local' &&
    params.availability.runtimeAvailable &&
    params.availability.runtimeCloudAllowed
  ) {
    return {
      laneId: 'andrea_runtime',
      runtimePreference: 'codex_cloud',
      label: 'Codex cloud',
      promptPrefix: '[runtime: cloud]',
      reason:
        'Codex local already failed on this feedback item, so Andrea is retrying in Codex cloud.',
    };
  }

  return selection;
}

function buildExpectedBehavior(record: Pick<
  ResponseFeedbackRecord,
  'originalUserText' | 'routeKey' | 'capabilityId' | 'classification'
>): string {
  const ask = normalizeText(record.originalUserText).toLowerCase();
  const routeKey = normalizeText(record.routeKey).toLowerCase();
  const capabilityId = normalizeText(record.capabilityId).toLowerCase();

  if (
    /\b(news|headlines|latest news|news today|what(?:’|')?s the news|today(?:’|')?s news)\b/.test(
      ask,
    )
  ) {
    return 'Answer with the current news when the live lane is available, or say clearly that live news is blocked and offer the best local fallback instead of a canned reply.';
  }
  if (routeKey.includes('calendar') || capabilityId.includes('calendar')) {
    return 'Answer as a calendar request, keep the same-thread continuation intact, and ask only for the one missing detail when needed.';
  }
  if (routeKey.includes('communication') || capabilityId.includes('communication')) {
    return 'Give a grounded draft or summary, preserve rewrite continuity, and avoid generic or template-shaped reply help.';
  }
  if (routeKey.includes('daily') || capabilityId.includes('daily')) {
    return 'Give a grounded, concise daily-guidance answer with one practical next step and no system-shaped scaffolding.';
  }
  if (record.classification === 'externally_blocked') {
    return 'Keep the blocker honest and useful-first. Improve routing or fallback wording only if that makes the blocked path clearer.';
  }
  return 'Answer the user’s ask directly, or give one clear clarification/fallback instead of drifting into canned or generic copy.';
}

function buildTraceSummary(
  record: Pick<
    ResponseFeedbackRecord,
    'capabilityId' | 'routeKey' | 'responseSource' | 'traceReason' | 'blockerClass'
  >,
): string[] {
  return [
    record.capabilityId ? `- Capability: ${record.capabilityId}` : null,
    record.routeKey ? `- Route key: ${record.routeKey}` : null,
    record.responseSource ? `- Response source: ${record.responseSource}` : null,
    record.traceReason ? `- Trace reason: ${record.traceReason}` : null,
    record.blockerClass ? `- Blocker class: ${record.blockerClass}` : null,
  ].filter((line): line is string => Boolean(line));
}

export function buildResponseFeedbackRemediationPrompt(params: {
  record: ResponseFeedbackRecord;
  laneSelection: ResponseFeedbackLaneSelection;
  hostTruthLines: string[];
}): string {
  const { record, laneSelection, hostTruthLines } = params;
  const expectedBehavior = buildExpectedBehavior(record);
  const traceSummary = buildTraceSummary(record);
  const prefix = laneSelection.promptPrefix ? `${laneSelection.promptPrefix}\n\n` : '';
  return [
    prefix +
      'Andrea just received a Telegram main-control-chat reply that was downvoted as `Not helpful`.',
    'Fix only the smallest repo-side issue that would make this class of reply better.',
    '',
    'Downvoted exchange:',
    `- Original ask: ${record.originalUserText}`,
    `- Andrea reply: ${record.assistantReplyText}`,
    `- Classification: ${formatClassificationLabel(record.classification)}`,
    ...traceSummary,
    '',
    'Expected correct behavior:',
    `- ${expectedBehavior}`,
    '',
    'Current host truth to preserve:',
    ...hostTruthLines.map((line) => `- ${line}`),
    '',
    'Implementation rules:',
    '- Do not add broad new product surface or another routing stack.',
    '- Keep Telegram as the richer action surface and preserve current trust boundaries.',
    '- If this turns out to be mainly an external/manual blocker, do not overclaim a code bug. Improve fallback wording or routing only if that would help.',
    '- Keep the fix small and repo-local.',
    '',
    'Validation before you report success:',
    '- Run focused tests for touched areas.',
    '- Run npm run typecheck.',
    '- Run npm run build.',
    '- Run npm test.',
    '- If messaging or Telegram behavior changed, rerun npm run telegram:user:smoke.',
    '',
    'Local host handling:',
    '- If you applied a local hotfix and validation passed on this host, restart with npm run services:restart.',
    '- Do not commit or push. Report exactly what changed, what passed, and whether the host restarted cleanly.',
  ].join('\n');
}
