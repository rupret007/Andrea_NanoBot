import { listRecentResponseFeedback } from './db.js';
import {
  buildFieldTrialOperatorTruth,
  type FieldTrialOperatorTruth,
  type FieldTrialProofState,
  type FieldTrialSurfaceTruth,
} from './field-trial-readiness.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type { ResponseFeedbackRecord } from './types.js';

export type IntegrationDoctorState =
  | 'healthy'
  | 'near_live_only'
  | 'degraded_but_usable'
  | 'externally_blocked'
  | 'needs_auth'
  | 'needs_proof'
  | 'manual_action_required'
  | 'repo_fix_available';

export type IntegrationCredentialState =
  | 'configured'
  | 'healthy'
  | 'missing'
  | 'invalid'
  | 'not_required'
  | 'unknown';

export type IntegrationTransportState =
  | 'healthy'
  | 'degraded'
  | 'blocked'
  | 'not_configured'
  | 'not_required'
  | 'unknown';

export type IntegrationRepairability =
  | 'automatic'
  | 'guided_manual'
  | 'manual_external'
  | 'repo_fix_available'
  | 'proof_drill'
  | 'status_only';

export interface IntegrationStatus {
  integrationId: string;
  label: string;
  state: IntegrationDoctorState;
  credentialState: IntegrationCredentialState;
  transportState: IntegrationTransportState;
  proofState: IntegrationDoctorState;
  lastHealthyAt: string | null;
  lastFailure: string;
  blockerOwner: 'none' | 'repo_side' | 'external' | 'manual' | 'mixed';
  nextAction: string;
  repairability: IntegrationRepairability;
  safeActions: string[];
  detail: string;
}

export interface IntegrationDoctorReport {
  generatedAt: string;
  summary: {
    total: number;
    healthy: number;
    actionNeeded: number;
    needsProof: number;
    manualOrExternal: number;
  };
  statuses: IntegrationStatus[];
  secretsRedacted: true;
}

export interface BuildIntegrationDoctorReportOptions {
  now?: Date;
  projectRoot?: string;
  truth?: FieldTrialOperatorTruth;
  providers?: ProviderHealthSnapshot[];
  recentFeedback?: ResponseFeedbackRecord[];
}

const ACTION_NEEDED_STATES = new Set<IntegrationDoctorState>([
  'needs_auth',
  'externally_blocked',
  'manual_action_required',
  'repo_fix_available',
]);

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bcrsr_[A-Za-z0-9_]{20,}\b/g,
  /\bBSA-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
];
const SECRET_ASSIGNMENT_PATTERN =
  /\b(password|token|secret|api[_-]?key)=([^;\s]+)/gi;

function cleanText(value: string | null | undefined): string {
  if (!value) return '';
  let cleaned = value.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string) => `${key}=***`,
  );
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[redacted-secret]');
  }
  return cleaned.trim();
}

export function redactIntegrationDoctorText(value: string): string {
  return cleanText(value);
}

function stateFromProof(
  proofState: FieldTrialProofState,
): IntegrationDoctorState {
  if (proofState === 'live_proven') return 'healthy';
  if (proofState === 'degraded_but_usable') return 'degraded_but_usable';
  if (proofState === 'near_live_only') return 'near_live_only';
  if (proofState === 'externally_blocked') return 'externally_blocked';
  return 'healthy';
}

function transportStateFromBlueBubbles(
  truth: FieldTrialOperatorTruth,
): IntegrationTransportState {
  const transportState = truth.bluebubbles.transportState.toLowerCase();
  if (transportState === 'ready' || transportState === 'healthy')
    return 'healthy';
  if (transportState === 'stopped' || transportState === 'not_configured')
    return 'not_configured';
  if (transportState.includes('blocked') || transportState.includes('failed'))
    return 'blocked';
  return 'degraded';
}

function surfaceStatus(params: {
  integrationId: string;
  label: string;
  truth: FieldTrialSurfaceTruth;
  credentialState?: IntegrationCredentialState;
  transportState?: IntegrationTransportState;
  overrideState?: IntegrationDoctorState;
  overrideProofState?: IntegrationDoctorState;
  repairability?: IntegrationRepairability;
  safeActions?: string[];
  lastHealthyAt?: string | null;
  blockerOwner?: IntegrationStatus['blockerOwner'];
  detail?: string;
  nextAction?: string;
}): IntegrationStatus {
  const proofState =
    params.overrideProofState || stateFromProof(params.truth.proofState);
  const state = params.overrideState || proofState;
  return {
    integrationId: params.integrationId,
    label: params.label,
    state,
    credentialState: params.credentialState || 'unknown',
    transportState: params.transportState || 'unknown',
    proofState,
    lastHealthyAt:
      params.lastHealthyAt ||
      (params.truth.proofState === 'live_proven'
        ? new Date().toISOString()
        : null),
    lastFailure:
      params.truth.proofState === 'live_proven' && !params.truth.blocker
        ? ''
        : cleanText(params.truth.blocker || params.truth.detail),
    blockerOwner:
      params.blockerOwner ||
      (params.truth.blockerOwner === 'external'
        ? 'external'
        : params.truth.blockerOwner === 'repo_side'
          ? 'repo_side'
          : 'none'),
    nextAction: cleanText(params.nextAction || params.truth.nextAction),
    repairability: params.repairability || 'status_only',
    safeActions: (params.safeActions || []).map(cleanText),
    detail: cleanText(
      params.detail ||
        (params.truth.proofState === 'live_proven' && !params.truth.blocker
          ? `${params.label} is healthy.`
          : params.truth.detail),
    ),
  };
}

function normalizeGoogleCalendar(
  truth: FieldTrialOperatorTruth,
): IntegrationStatus {
  const detail =
    `${truth.googleCalendar.blocker} ${truth.googleCalendar.detail}`.toLowerCase();
  const needsAuth =
    truth.googleCalendar.proofState === 'externally_blocked' &&
    (detail.includes('invalid_grant') ||
      detail.includes('refresh token') ||
      detail.includes('oauth'));
  return surfaceStatus({
    integrationId: 'google_calendar',
    label: 'Google Calendar',
    truth: truth.googleCalendar,
    credentialState: needsAuth ? 'invalid' : 'configured',
    transportState: needsAuth ? 'blocked' : 'healthy',
    overrideState: needsAuth ? 'needs_auth' : undefined,
    overrideProofState: needsAuth ? 'needs_auth' : undefined,
    blockerOwner: needsAuth ? 'external' : undefined,
    repairability: needsAuth ? 'guided_manual' : 'status_only',
    safeActions: [
      'Run the existing Google Calendar auth setup flow.',
      'Then run npm run debug:google-calendar and npm run services:status.',
    ],
    nextAction: needsAuth
      ? 'Reauthorize Google Calendar; the refresh token is invalid_grant, so code cannot repair it without a fresh OAuth grant.'
      : truth.googleCalendar.nextAction,
  });
}

function normalizeBlueBubbles(
  truth: FieldTrialOperatorTruth,
): IntegrationStatus {
  const transportState = transportStateFromBlueBubbles(truth);
  const transportHealthy = transportState === 'healthy';
  const proofNeedsDecision =
    truth.bluebubbles.messageActionProofState !== 'fresh' ||
    truth.bluebubbles.proofState !== 'live_proven';
  const directChatGate =
    truth.bluebubbles.lastIgnoredReason &&
    truth.bluebubbles.lastIgnoredReason !== 'none' &&
    truth.bluebubbles.lastIgnoredChatJid;
  const safeActions = [
    'Run npm run debug:bluebubbles -- --live.',
    'In the canonical self-thread, ask @Andrea start bluebubbles proof, then reply send it later tonight.',
  ];
  if (directChatGate) {
    safeActions.push(
      'For the ignored direct 1:1 thread, send @Andrea once in that same thread to reactivate fresh context.',
    );
  }
  return surfaceStatus({
    integrationId: 'bluebubbles',
    label: 'BlueBubbles / iMessage',
    truth: truth.bluebubbles,
    credentialState: truth.bluebubbles.configured ? 'configured' : 'missing',
    transportState,
    overrideState:
      transportHealthy && proofNeedsDecision ? 'needs_proof' : undefined,
    overrideProofState: proofNeedsDecision ? 'needs_proof' : undefined,
    repairability: transportHealthy ? 'proof_drill' : 'guided_manual',
    safeActions,
    detail: [
      truth.bluebubbles.detail,
      transportHealthy
        ? `Transport is reachable at ${truth.bluebubbles.activeServerBaseUrl || truth.bluebubbles.serverBaseUrl || 'configured Mac endpoint'}.`
        : 'Transport is not currently ready.',
      proofNeedsDecision
        ? 'Same-thread proof still needs a real deferred message_action decision.'
        : 'Same-thread proof is fresh.',
      directChatGate
        ? `Latest ignored direct chat needs @Andrea once before bare follow-ups: ${truth.bluebubbles.detectionDetail}`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    nextAction: proofNeedsDecision
      ? 'Complete the self-thread proof drill with send it later tonight; keep immediate send stricter.'
      : truth.bluebubbles.nextAction,
  });
}

function normalizeAlexa(truth: FieldTrialOperatorTruth): IntegrationStatus {
  const missingSignedTurn = truth.alexa.proofState !== 'live_proven';
  const baseUrlMissing =
    !process.env.ALEXA_PUBLIC_BASE_URL &&
    !truth.alexa.detail.includes('public');
  return surfaceStatus({
    integrationId: 'alexa',
    label: 'Alexa',
    truth: truth.alexa,
    credentialState: 'configured',
    transportState: missingSignedTurn ? 'degraded' : 'healthy',
    overrideState: missingSignedTurn ? 'manual_action_required' : undefined,
    overrideProofState: missingSignedTurn ? 'near_live_only' : undefined,
    blockerOwner: missingSignedTurn ? 'manual' : undefined,
    repairability: 'manual_external',
    safeActions: [
      'Verify local listener on port 4300 and public tunnel/base URL.',
      'Confirm Alexa Developer Console endpoint points at the public URL.',
      'Run npm run debug:alexa-conversation -- --review.',
      'Send one real signed simulator/device turn; do not fake live_proven.',
    ],
    detail: [
      truth.alexa.detail,
      baseUrlMissing
        ? 'ALEXA_PUBLIC_BASE_URL is not loaded in this process.'
        : '',
      truth.alexa.failureChecklist,
    ]
      .filter(Boolean)
      .join(' '),
    nextAction:
      'Complete the Alexa checklist, then prove one real signed IntentRequest reaches this host.',
  });
}

function normalizeProvider(
  provider: ProviderHealthSnapshot,
): IntegrationStatus {
  const state: IntegrationDoctorState =
    provider.state === 'healthy'
      ? 'healthy'
      : provider.credentialState === 'missing' ||
          provider.credentialState === 'invalid'
        ? 'needs_auth'
        : provider.state === 'externally_blocked'
          ? 'externally_blocked'
          : 'degraded_but_usable';
  return {
    integrationId: provider.providerId,
    label: provider.providerId.replace(/_/g, ' '),
    state,
    credentialState:
      provider.credentialState === 'configured'
        ? 'configured'
        : provider.credentialState,
    transportState: provider.state === 'healthy' ? 'healthy' : 'degraded',
    proofState: state,
    lastHealthyAt: provider.lastHealthyAt,
    lastFailure: cleanText(provider.blocker),
    blockerOwner:
      provider.failureClass === 'missing_credentials' ||
      provider.failureClass === 'quota_or_rate_limit' ||
      provider.failureClass === 'manual_external'
        ? 'external'
        : provider.failureClass === 'none'
          ? 'none'
          : 'mixed',
    nextAction: cleanText(provider.nextAction),
    repairability:
      provider.state === 'healthy' ? 'status_only' : 'guided_manual',
    safeActions: [
      provider.nextAction ||
        `Run npm run debug:providers to refresh ${provider.providerId}.`,
    ].map(cleanText),
    detail: cleanText(
      provider.blocker ||
        `${provider.providerId} provider health is ${provider.state}.`,
    ),
  };
}

function normalizeRuntime(truth: FieldTrialOperatorTruth): IntegrationStatus {
  return surfaceStatus({
    integrationId: 'runtime_backend',
    label: 'Runtime backend',
    truth: truth.hostHealth,
    credentialState: 'not_required',
    transportState:
      truth.hostHealth.proofState === 'live_proven' ? 'healthy' : 'degraded',
    repairability:
      truth.hostHealth.proofState === 'live_proven'
        ? 'status_only'
        : 'repo_fix_available',
    safeActions: [
      'Run npm run services:status.',
      'If degraded, run npm run services:restart and platform determinism-audit after tests pass.',
    ],
  });
}

function normalizeFeatureProofs(
  truth: FieldTrialOperatorTruth,
): IntegrationStatus {
  const nearLive = Object.entries(truth.journeys || {})
    .filter(([, journey]) => journey.proofState === 'near_live_only')
    .map(([id]) => id);
  return {
    integrationId: 'feature_proofs',
    label: 'Feature proof gaps',
    state: nearLive.length > 0 ? 'near_live_only' : 'healthy',
    credentialState: 'not_required',
    transportState: 'not_required',
    proofState: nearLive.length > 0 ? 'near_live_only' : 'healthy',
    lastHealthyAt: nearLive.length > 0 ? null : new Date().toISOString(),
    lastFailure: '',
    blockerOwner: 'none',
    nextAction:
      nearLive.length > 0
        ? 'Run fresh proof turns for near-live product journeys; these are proof gaps, not broken integrations.'
        : '',
    repairability: 'status_only',
    safeActions:
      nearLive.length > 0 ? [`Proof needed for: ${nearLive.join(', ')}`] : [],
    detail:
      nearLive.length > 0
        ? 'Near-live product surfaces are grouped here so launch truth distinguishes proof debt from broken systems.'
        : 'No near-live proof gaps are currently visible.',
  };
}

function normalizeSelfRepair(
  recentFeedback: ResponseFeedbackRecord[],
): IntegrationStatus {
  const pending = recentFeedback.filter((record) => {
    const state =
      record.linkedRefs.repairExecutionState ||
      record.linkedRefs.repairBindingState ||
      record.status;
    return [
      'captured',
      'awaiting_confirmation',
      'awaiting_approval',
      'approved_not_started',
      'waiting_for_cloud_result',
    ].includes(state);
  });
  const latest = pending[0];
  return {
    integrationId: 'self_repair',
    label: 'Self-repair plans',
    state: pending.length > 0 ? 'repo_fix_available' : 'healthy',
    credentialState: 'not_required',
    transportState: 'not_required',
    proofState: pending.length > 0 ? 'repo_fix_available' : 'healthy',
    lastHealthyAt: pending.length > 0 ? null : new Date().toISOString(),
    lastFailure: latest
      ? cleanText(
          latest.operatorNote ||
            latest.originalUserText ||
            latest.linkedRefs.repairNextLegalAction ||
            '',
        )
      : '',
    blockerOwner: pending.length > 0 ? 'repo_side' : 'none',
    nextAction:
      pending.length > 0
        ? 'Review self-improvement status; approve, cancel, or let the selected cloud repair lane run inside the scoped repair plan.'
        : '',
    repairability: pending.length > 0 ? 'repo_fix_available' : 'status_only',
    safeActions:
      pending.length > 0
        ? [
            'Ask self-improvement status or did it fix itself?',
            'Use natural approval only for the repair you actually want to run.',
            'Cancel stale repair plans if they are no longer relevant.',
          ]
        : [],
    detail:
      pending.length > 0
        ? `${pending.length} pending/stale repair item(s) are visible in response-feedback truth.`
        : 'No pending response-feedback repair plans are visible in NanoBot truth.',
  };
}

function summarize(
  statuses: IntegrationStatus[],
): IntegrationDoctorReport['summary'] {
  return {
    total: statuses.length,
    healthy: statuses.filter((status) => status.state === 'healthy').length,
    actionNeeded: statuses.filter((status) =>
      ACTION_NEEDED_STATES.has(status.state),
    ).length,
    needsProof: statuses.filter((status) => status.state === 'needs_proof')
      .length,
    manualOrExternal: statuses.filter((status) =>
      ['manual_action_required', 'externally_blocked', 'needs_auth'].includes(
        status.state,
      ),
    ).length,
  };
}

export function buildIntegrationDoctorReport(
  options: BuildIntegrationDoctorReportOptions = {},
): IntegrationDoctorReport {
  const now = options.now || new Date();
  const truth =
    options.truth ||
    buildFieldTrialOperatorTruth({
      projectRoot: options.projectRoot || process.cwd(),
    });
  const providers =
    options.providers || collectProviderHealthSnapshots(now.toISOString());
  const recentFeedback =
    options.recentFeedback || listRecentResponseFeedback({ limit: 20 });

  const statuses = [
    surfaceStatus({
      integrationId: 'telegram',
      label: 'Telegram',
      truth: truth.telegram,
      credentialState:
        truth.telegram.proofState === 'live_proven' ? 'configured' : 'unknown',
      transportState:
        truth.telegram.proofState === 'live_proven' ? 'healthy' : 'degraded',
      repairability: 'status_only',
      safeActions: [
        'Run npm run telegram:user:smoke if Telegram ever looks stale.',
      ],
    }),
    normalizeGoogleCalendar(truth),
    normalizeBlueBubbles(truth),
    normalizeAlexa(truth),
    normalizeRuntime(truth),
    surfaceStatus({
      integrationId: 'research',
      label: 'Research',
      truth: truth.research,
      credentialState:
        truth.research.proofState === 'live_proven' ? 'configured' : 'unknown',
      transportState:
        truth.research.proofState === 'live_proven' ? 'healthy' : 'degraded',
      repairability:
        truth.research.proofState === 'live_proven'
          ? 'status_only'
          : 'guided_manual',
      safeActions: [
        'Run npm run debug:research-mode and npm run debug:providers.',
      ],
    }),
    surfaceStatus({
      integrationId: 'image_generation',
      label: 'Image generation',
      truth: truth.imageGeneration,
      credentialState:
        truth.imageGeneration.proofState === 'live_proven'
          ? 'configured'
          : 'unknown',
      transportState:
        truth.imageGeneration.proofState === 'live_proven'
          ? 'healthy'
          : 'degraded',
      repairability:
        truth.imageGeneration.proofState === 'live_proven'
          ? 'status_only'
          : 'guided_manual',
      safeActions: ['Run provider checks before image-generation proof.'],
    }),
    ...providers.map(normalizeProvider),
    normalizeSelfRepair(recentFeedback),
    normalizeFeatureProofs(truth),
  ];
  const uniqueStatuses = Array.from(
    new Map(statuses.map((status) => [status.integrationId, status])).values(),
  );
  return {
    generatedAt: now.toISOString(),
    summary: summarize(uniqueStatuses),
    statuses: uniqueStatuses,
    secretsRedacted: true,
  };
}

function sortStatuses(statuses: IntegrationStatus[]): IntegrationStatus[] {
  const priority: Record<IntegrationDoctorState, number> = {
    needs_auth: 0,
    manual_action_required: 1,
    externally_blocked: 2,
    repo_fix_available: 3,
    needs_proof: 4,
    degraded_but_usable: 5,
    near_live_only: 6,
    healthy: 7,
  };
  return [...statuses].sort(
    (left, right) =>
      priority[left.state] - priority[right.state] ||
      left.integrationId.localeCompare(right.integrationId),
  );
}

function formatStatusLine(status: IntegrationStatus): string {
  const owner =
    status.blockerOwner === 'none' ? '' : ` owner=${status.blockerOwner}`;
  const next = status.nextAction ? ` Next: ${status.nextAction}` : '';
  return `- ${status.label}: ${status.state}${owner}.${next}`;
}

export function formatIntegrationDoctorReport(
  report: IntegrationDoctorReport,
  mode: 'status' | 'doctor' = 'status',
): string {
  const sorted = sortStatuses(report.statuses);
  const actionNeeded = sorted.filter((status) =>
    ACTION_NEEDED_STATES.has(status.state),
  );
  const proofNeeded = sorted.filter((status) => status.state === 'needs_proof');
  const nearLive = sorted.filter((status) => status.state === 'near_live_only');
  const degraded = sorted.filter(
    (status) => status.state === 'degraded_but_usable',
  );
  const healthy = sorted.filter((status) => status.state === 'healthy');
  const lines = [
    mode === 'doctor'
      ? 'Andrea integration doctor'
      : 'Andrea integration status',
    `Summary: ${report.summary.healthy}/${report.summary.total} healthy, ${report.summary.actionNeeded} action-needed, ${report.summary.needsProof} proof-needed. Secrets are redacted.`,
  ];
  if (actionNeeded.length > 0) {
    lines.push('', 'Action needed');
    lines.push(...actionNeeded.map(formatStatusLine));
  }
  if (proofNeeded.length > 0) {
    lines.push('', 'Proof needed, not broken');
    lines.push(...proofNeeded.map(formatStatusLine));
  }
  if (degraded.length > 0) {
    lines.push('', 'Degraded but usable');
    lines.push(...degraded.map(formatStatusLine));
  }
  if (nearLive.length > 0) {
    lines.push('', 'Near-live proof gaps');
    lines.push(...nearLive.map(formatStatusLine));
  }
  if (healthy.length > 0) {
    lines.push('', 'Healthy');
    lines.push(...healthy.slice(0, 12).map((status) => `- ${status.label}`));
    if (healthy.length > 12) {
      lines.push(
        `- ${healthy.length - 12} more healthy integrations hidden for brevity.`,
      );
    }
  }
  return cleanText(lines.join('\n'));
}

const FIX_GUIDANCE: Record<string, string[]> = {
  google_calendar: [
    'Google Calendar needs OAuth reauth, not a code patch.',
    'Run the existing setup/auth flow for Google Calendar, then run npm run debug:google-calendar.',
    'After auth succeeds, run npm run services:status and confirm calendar proof returns live_proven.',
  ],
  bluebubbles: [
    'BlueBubbles transport is usable when the Mac BlueBubbles server is online.',
    'Run npm run debug:bluebubbles -- --live.',
    'In the canonical self-thread, send @Andrea start bluebubbles proof, then reply send it later tonight.',
    'For ignored direct 1:1 chats, send @Andrea once in that same thread to create fresh context.',
  ],
  alexa: [
    'Alexa needs manual public ingress proof.',
    'Verify local listener port 4300, ngrok/public URL, ALEXA_PUBLIC_BASE_URL, and Developer Console endpoint.',
    'Run npm run debug:alexa-conversation -- --review, then make one real signed simulator/device turn.',
  ],
  self_repair: [
    'Self-repair plans need operator cleanup or approval.',
    'Ask did it fix itself? or self-improvement status.',
    'Approve only the repair you want, or cancel stale repair plans so audit noise clears.',
  ],
  telegram: [
    'Telegram is currently healthy. If it regresses, run npm run telegram:user:smoke and npm run services:status.',
  ],
  providers: [
    'Provider status is managed by npm run debug:providers, npm run debug:credentials, and npm run debug:alerts.',
    'MiniMax, Brave, and OpenAI secrets stay in .env only and must never be committed.',
  ],
};

export function normalizeIntegrationId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

export function buildIntegrationFixGuidance(id: string): string {
  const normalized = normalizeIntegrationId(id);
  const alias =
    normalized === 'calendar'
      ? 'google_calendar'
      : normalized === 'imessage' || normalized === 'messages'
        ? 'bluebubbles'
        : normalized === 'repair' || normalized === 'repairs'
          ? 'self_repair'
          : normalized === 'openai' ||
              normalized === 'minimax' ||
              normalized === 'brave'
            ? 'providers'
            : normalized;
  const guidance = FIX_GUIDANCE[alias];
  if (!guidance) {
    return cleanText(
      [
        `No dedicated fixer exists for ${id}.`,
        'Run npm run integrations:doctor for the canonical status and safe next actions.',
      ].join('\n'),
    );
  }
  return cleanText(
    [
      `Integration fix guidance: ${alias}`,
      ...guidance.map((line) => `- ${line}`),
    ].join('\n'),
  );
}

export function isIntegrationDoctorRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    /\b(?:what'?s|what is|whats)\s+(?:still\s+)?broken\b/.test(normalized) ||
    /\bintegration(?:s)?\s+(?:status|doctor|health)\b/.test(normalized) ||
    /\b(?:fix|repair)\s+integrations?\b/.test(normalized)
  );
}

export function parseIntegrationFixTarget(message: string): string | null {
  const normalized = message.trim().toLowerCase();
  const match = normalized.match(
    /\b(?:fix|repair|doctor)\s+(google calendar|calendar|bluebubbles|imessage|messages|alexa|self repair|repairs|repair|telegram|providers?|openai|minimax|brave)\b/,
  );
  return match ? match[1] : null;
}
