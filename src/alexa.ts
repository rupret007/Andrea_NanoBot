import fs from 'fs';
import http, { type IncomingHttpHeaders, type Server } from 'http';

import {
  getIntentName,
  getRequestType,
  SkillBuilders,
  type HandlerInput,
} from 'ask-sdk-core';
import {
  type Intent,
  type RequestEnvelope,
  type ResponseEnvelope,
} from 'ask-sdk-model';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';

import {
  clearAlexaConversationState,
  getAlexaConversationReferencedFactId,
  loadAlexaConversationState,
  resolveAlexaConversationFollowup,
  saveAlexaConversationState,
  type AlexaConversationState,
  type AlexaConversationSubjectData,
} from './alexa-conversation.js';
import {
  extractAlexaVoiceIntentCapture,
  planAlexaDialogueTurn,
  resolveAlexaVoiceIntentFamily,
  type AlexaVoiceIntentFamily,
} from './alexa-dialogue.js';
import {
  resolveAlexaIntentToCapability,
} from './assistant-capability-router.js';
import {
  executeAssistantCapability,
  type AssistantCapabilityConversationSeed,
  type AssistantCapabilityResult,
} from './assistant-capabilities.js';
import {
  completeAssistantActionFromAlexa,
  type AssistantActionCompletionResult,
} from './assistant-action-completion.js';
import {
  buildActionBundleVoiceSummary,
  createOrRefreshActionBundle,
} from './action-bundles.js';
import {
  buildCalendarAssistantResponse,
  type CalendarActiveEventContext,
} from './calendar-assistant.js';
import {
  buildDelegationRuleListPresentation,
  buildDelegationRulePreview,
  buildDelegationRuleWhyText,
  saveDelegationRuleFromPreview,
  updateDelegationRuleMode,
} from './delegation-rules.js';
import {
  getAlexaOAuthStatus,
  handleAlexaOAuthRequest,
  resolveAlexaOAuthConfig,
} from './alexa-oauth.js';
import {
  AlexaTargetGroupMissingError,
  type AlexaBridgeConfig,
  type AlexaPrincipal,
  runAlexaAssistantTurn,
} from './alexa-bridge.js';
import { resolveAlexaLinkedAccount } from './alexa-identity.js';
import {
  clearAlexaPendingSession,
  loadAlexaPendingSession,
  parseAlexaSessionPayload,
  saveAlexaPendingSession,
} from './alexa-session.js';
import {
  acceptProposedProfileFact,
  handlePersonalizationCommand,
  maybeCreateProactiveProfileCandidate,
  rejectProposedProfileFact,
} from './assistant-personalization.js';
import {
  ALEXA_DEFAULT_REPROMPT,
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_ANYTHING_IMPORTANT_INTENT,
  ALEXA_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_COMPANION_GUIDANCE_INTENT,
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_CONVERSATION_CONTROL_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_OPEN_ASK_INTENT,
  ALEXA_PEOPLE_HOUSEHOLD_INTENT,
  ALEXA_PLANNING_ORIENTATION_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_SAVE_REMIND_HANDOFF_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_WHAT_AM_I_FORGETTING_INTENT,
  ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT,
  ALEXA_WHAT_NEXT_INTENT,
  buildAlexaConversationalFollowupPrompt,
  buildAlexaFallbackSpeech,
  buildAlexaHelpSpeech,
  buildAlexaOpenConversationPrompt,
  buildAlexaPersonalPrompt,
  buildAlexaWelcomeSpeech,
  buildDraftFollowUpQuestion,
  buildReminderConfirmationSpeech,
  buildReminderLeadTimeQuestion,
  buildSaveForLaterConfirmationSpeech,
  buildSaveForLaterQuestion,
  isAlexaPersonalIntent,
} from './alexa-v1.js';
import { ASSISTANT_NAME, RUNTIME_STATE_DIR, TIMEZONE } from './config.js';
import {
  buildDailyCompanionResponse,
  type DailyCompanionContext,
} from './daily-companion.js';
import {
  createTask,
  getActionBundleSnapshot,
  getAllTasks,
  getDelegationRule,
  listDelegationRulesForGroup,
} from './db.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import {
  handleLifeThreadCommand,
} from './life-threads.js';
import { logger } from './logger.js';
import {
  completePilotJourney,
  resolvePilotJourneyFromCapability,
  startPilotJourney,
} from './pilot-mode.js';
import { formatOutbound } from './router.js';
import { handleRitualCommand } from './rituals.js';
import {
  type AlexaCompanionGuidanceGoal,
  type CompanionContinuationCandidate,
  type PilotBlockerOwner,
  type PilotJourneyOutcome,
} from './types.js';
import {
  buildCalendarCompanionEventReply,
  buildCalendarCompanionFailureReply,
  buildCalendarCompanionReminderReply,
  buildGracefulDegradedReply,
} from './conversational-core.js';
import { getUserFacingErrorDetail } from './user-facing-error.js';
import { normalizeVoicePrompt } from './voice-ready.js';
import type { CompanionHandoffDeps } from './cross-channel-handoffs.js';
import {
  applyOutcomeReviewControl,
  buildOutcomeReviewResponse,
  interpretOutcomeReviewControl,
  matchOutcomeReviewPrompt,
  syncOutcomeFromReminderTask,
  type OutcomeReviewPromptMatch,
} from './outcome-reviews.js';
import {
  classifyGoogleCalendarFailureDetail,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  isGoogleCalendarAuthFailureKind,
  type GoogleCalendarEventRecord,
  type GoogleCalendarMetadata,
  listGoogleCalendarEvents,
  listGoogleCalendars,
  moveGoogleCalendarEvent,
  resolveGoogleCalendarConfig,
  updateGoogleCalendarEvent,
} from './google-calendar.js';
import {
  advancePendingGoogleCalendarCreate,
  buildGoogleCalendarSchedulingContextState,
  buildPendingGoogleCalendarCreateState,
  formatGoogleCalendarCreatePrompt,
  isExplicitGoogleCalendarCreateRequest,
  planGoogleCalendarCreate,
  type GoogleCalendarSchedulingContextState,
  type PendingGoogleCalendarCreateState,
} from './google-calendar-create.js';
import {
  advancePendingCalendarReminder,
  advancePendingGoogleCalendarEventAction,
  buildActiveGoogleCalendarEventContextState,
  buildEventReminderTaskPlan,
  formatPendingGoogleCalendarEventActionPrompt,
  isActiveGoogleCalendarEventContextExpired,
  isPendingCalendarReminderExpired,
  isPendingGoogleCalendarEventActionExpired,
  matchGoogleCalendarTrackedEvents,
  planCalendarEventReminder,
  planGoogleCalendarEventAction,
  resolveCalendarReminderLookup,
  type ActiveGoogleCalendarEventContextState,
  type PendingCalendarReminderState,
  type PendingGoogleCalendarEventActionState,
} from './google-calendar-followthrough.js';
import { planContextualReminder } from './local-reminder.js';

const ALEXA_REQUEST_LIMIT_BYTES = 256 * 1024;
const DEFAULT_ALEXA_HOST = '127.0.0.1';
const DEFAULT_ALEXA_PORT = 4300;
const DEFAULT_ALEXA_PATH = '/alexa';
const DEFAULT_ALEXA_REPROMPT = ALEXA_DEFAULT_REPROMPT;

export interface AlexaConfig extends AlexaBridgeConfig {
  skillId: string;
  host: string;
  port: number;
  path: string;
  healthPath: string;
  verifySignature: boolean;
  requireAccountLinking: boolean;
  allowedUserIds: string[];
}

export interface AlexaRuntime {
  close(): Promise<void>;
  getStatus(): AlexaStatus;
}

export interface AlexaStatus {
  enabled: boolean;
  running: boolean;
  host?: string;
  port?: number;
  path?: string;
  healthPath?: string;
  verifySignature?: boolean;
  requireAccountLinking?: boolean;
  allowedUserIdsCount?: number;
  targetGroupFolder?: string;
  oauthEnabled?: boolean;
  oauthAuthorizationPath?: string;
  oauthTokenPath?: string;
  oauthHealthPath?: string;
  oauthScope?: string;
  oauthGroupFolder?: string;
  publicBaseUrl?: string;
  publicEndpointUrl?: string;
  publicOAuthHealthUrl?: string;
  publicIngressKind?: string;
  publicIngressHint?: string;
  publicBrowserHint?: string;
  lastSignedRequestAt?: string;
  lastSignedRequestType?: string;
  lastSignedIntent?: string;
  lastSignedGroupFolder?: string;
  lastSignedResponseSource?: string;
}

export interface AlexaCompanionDeps extends Partial<CompanionHandoffDeps> {}

interface AlexaSignedRequestState {
  updatedAt: string;
  requestId: string;
  requestType: string;
  intentName?: string;
  applicationIdVerified: boolean;
  linkingResolved: boolean;
  groupFolder?: string;
  responseSource: string;
}

interface AlexaSignedRequestProofState {
  lastSignedRequest?: AlexaSignedRequestState | null;
  lastHandledProofIntent?: AlexaSignedRequestState | null;
}

type SkillLike = {
  invoke(
    requestEnvelope: RequestEnvelope,
    context?: unknown,
  ): Promise<ResponseEnvelope>;
};

type AuthorizationResult =
  | { ok: true; principal: AlexaPrincipal }
  | {
      ok: false;
      kind: 'forbidden';
      speech: string;
      reprompt?: string;
    };

type AlexaBarrierResponse = {
  kind: 'link-account' | 'forbidden' | 'setup';
  speech: string;
  reprompt?: string;
};

const ALEXA_LAST_SIGNED_REQUEST_STATE_SUFFIX = process.env.VITEST_WORKER_ID
  ? `-${process.env.VITEST_WORKER_ID}`
  : '';
const ALEXA_LAST_SIGNED_REQUEST_STATE_PATH = `${RUNTIME_STATE_DIR}\\alexa-last-signed-request${ALEXA_LAST_SIGNED_REQUEST_STATE_SUFFIX}.json`;

function readAlexaLastSignedRequestState():
  | AlexaSignedRequestState
  | undefined {
  return readAlexaSignedRequestProofState().lastSignedRequest ?? undefined;
}

function isQualifyingHandledAlexaProofState(
  state: AlexaSignedRequestState | undefined | null,
): state is AlexaSignedRequestState {
  return Boolean(
    state &&
      state.requestType === 'IntentRequest' &&
      state.applicationIdVerified &&
      state.linkingResolved &&
      ['local_companion', 'life_thread_local', 'assistant_bridge', 'bridge'].includes(
        state.responseSource,
      ),
  );
}

function normalizeAlexaSignedRequestState(
  value: unknown,
): AlexaSignedRequestState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const parsed = value as Partial<AlexaSignedRequestState>;
  if (
    typeof parsed.updatedAt !== 'string' ||
    typeof parsed.requestId !== 'string' ||
    typeof parsed.requestType !== 'string' ||
    typeof parsed.responseSource !== 'string'
  ) {
    return undefined;
  }
  return {
    updatedAt: parsed.updatedAt,
    requestId: parsed.requestId,
    requestType: parsed.requestType,
    intentName:
      typeof parsed.intentName === 'string' ? parsed.intentName : undefined,
    applicationIdVerified: parsed.applicationIdVerified === true,
    linkingResolved: parsed.linkingResolved === true,
    groupFolder:
      typeof parsed.groupFolder === 'string' ? parsed.groupFolder : undefined,
    responseSource: parsed.responseSource,
  };
}

function readAlexaSignedRequestProofState(): AlexaSignedRequestProofState {
  try {
    if (!fs.existsSync(ALEXA_LAST_SIGNED_REQUEST_STATE_PATH)) {
      return {};
    }
    const raw = fs
      .readFileSync(ALEXA_LAST_SIGNED_REQUEST_STATE_PATH, 'utf8')
      .trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AlexaSignedRequestProofState;
    const lastSignedRequest = normalizeAlexaSignedRequestState(
      'lastSignedRequest' in parsed
        ? parsed.lastSignedRequest
        : (parsed as unknown),
    );
    const explicitHandledProof = normalizeAlexaSignedRequestState(
      parsed.lastHandledProofIntent,
    );
    return {
      lastSignedRequest,
      lastHandledProofIntent:
        (isQualifyingHandledAlexaProofState(explicitHandledProof)
          ? explicitHandledProof
          : undefined) ||
        (isQualifyingHandledAlexaProofState(lastSignedRequest)
          ? lastSignedRequest
          : undefined),
    };
  } catch {
    return {};
  }
}

function writeAlexaSignedRequestProofState(
  state: AlexaSignedRequestProofState,
): void {
  try {
    fs.mkdirSync(RUNTIME_STATE_DIR, { recursive: true });
    fs.writeFileSync(
      ALEXA_LAST_SIGNED_REQUEST_STATE_PATH,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to persist Alexa signed-request state');
  }
}

function buildAlexaSignedRequestState(
  requestEnvelope: RequestEnvelope,
  overrides: Partial<AlexaSignedRequestState> = {},
): AlexaSignedRequestState {
  const requestType = getRequestType(requestEnvelope);
  const requestId = requestEnvelope.request?.requestId || 'unknown';
  const intentName =
    requestType === 'IntentRequest'
      ? getIntentName(requestEnvelope)
      : undefined;
  return {
    updatedAt: new Date().toISOString(),
    requestId,
    requestType,
    intentName,
    applicationIdVerified: overrides.applicationIdVerified ?? true,
    linkingResolved: overrides.linkingResolved ?? false,
    groupFolder: overrides.groupFolder,
    responseSource: overrides.responseSource || 'received_trusted_request',
  };
}

function recordHandledRequest(
  requestEnvelope: RequestEnvelope,
  options: {
    responseSource: string;
    linked?: boolean;
    groupFolder?: string;
  },
): void {
  const state = buildAlexaSignedRequestState(requestEnvelope, {
    applicationIdVerified: true,
    linkingResolved: options.linked ?? false,
    groupFolder: options.groupFolder,
    responseSource: options.responseSource,
  });
  const existingState = readAlexaSignedRequestProofState();
  writeAlexaSignedRequestProofState({
    lastSignedRequest: state,
    lastHandledProofIntent: isQualifyingHandledAlexaProofState(state)
      ? state
      : existingState.lastHandledProofIntent,
  });
  logger.info(
    {
      requestId: state.requestId,
      requestType: state.requestType,
      intentName: state.intentName,
      applicationIdVerified: true,
      linkingResolved: state.linkingResolved,
      groupFolder: state.groupFolder,
      responseSource: state.responseSource,
    },
    'Alexa signed request handled',
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

function buildPublicUrl(
  baseUrl: string | undefined,
  pathValue: string | undefined,
): string | undefined {
  if (!baseUrl || !pathValue) return undefined;
  return `${baseUrl}${pathValue.startsWith('/') ? pathValue : `/${pathValue}`}`;
}

function getAlexaPublicIngressMetadata(publicBaseUrl: string | undefined): {
  kind?: string;
  hint?: string;
  browserHint?: string;
} {
  if (!publicBaseUrl) return {};
  try {
    const host = new URL(publicBaseUrl).hostname.toLowerCase();
    if (host.endsWith('.ngrok-free.dev')) {
      return {
        kind: 'wildcard_certificate_domain',
        hint: 'Alexa Developer Console endpoint SSL type must be set to the wildcard certificate option for *.ngrok-free.dev.',
        browserHint:
          'Browser health checks against ngrok free tunnels can show the ngrok warning page unless you send the ngrok-skip-browser-warning header.',
      };
    }
  } catch {
    return {};
  }

  return {
    kind: 'standard_certificate_domain',
  };
}

function healthPathFor(pathValue: string): string {
  return pathValue.endsWith('/') ? `${pathValue}health` : `${pathValue}/health`;
}

export function resolveAlexaConfig(env = process.env): AlexaConfig | null {
  const envFile =
    env === process.env
      ? readEnvFile([
          'ALEXA_SKILL_ID',
          'ALEXA_HOST',
          'ALEXA_PORT',
          'ALEXA_PATH',
          'ALEXA_PUBLIC_BASE_URL',
          'ALEXA_VERIFY_SIGNATURE',
          'ALEXA_REQUIRE_ACCOUNT_LINKING',
          'ALEXA_ALLOWED_USER_IDS',
          'ALEXA_TARGET_GROUP_FOLDER',
        ])
      : {};

  const skillId = (env.ALEXA_SKILL_ID || envFile.ALEXA_SKILL_ID || '').trim();
  if (!skillId) return null;

  const targetGroupFolder = (
    env.ALEXA_TARGET_GROUP_FOLDER ||
    envFile.ALEXA_TARGET_GROUP_FOLDER ||
    ''
  ).trim();
  if (targetGroupFolder) {
    assertValidGroupFolder(targetGroupFolder);
  }

  const host = (
    env.ALEXA_HOST ||
    envFile.ALEXA_HOST ||
    DEFAULT_ALEXA_HOST
  ).trim();
  const rawPort =
    env.ALEXA_PORT || envFile.ALEXA_PORT || `${DEFAULT_ALEXA_PORT}`;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ALEXA_PORT "${rawPort}"`);
  }

  const pathValue = normalizePath(
    env.ALEXA_PATH || envFile.ALEXA_PATH,
    DEFAULT_ALEXA_PATH,
  );
  const allowedUserIds = (
    env.ALEXA_ALLOWED_USER_IDS ||
    envFile.ALEXA_ALLOWED_USER_IDS ||
    ''
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    skillId,
    host,
    port,
    path: pathValue,
    healthPath: healthPathFor(pathValue),
    verifySignature: parseBoolean(
      env.ALEXA_VERIFY_SIGNATURE || envFile.ALEXA_VERIFY_SIGNATURE,
      true,
    ),
    requireAccountLinking: parseBoolean(
      env.ALEXA_REQUIRE_ACCOUNT_LINKING ||
        envFile.ALEXA_REQUIRE_ACCOUNT_LINKING,
      false,
    ),
    allowedUserIds,
    targetGroupFolder: targetGroupFolder || undefined,
  };
}

export function getAlexaStatus(
  config = resolveAlexaConfig(),
  running = false,
  boundPort?: number,
  oauthConfig = resolveAlexaOAuthConfig(process.env, config?.path || DEFAULT_ALEXA_PATH),
): AlexaStatus {
  const lastSignedRequest = readAlexaLastSignedRequestState();
  const envFile = readEnvFile(['ALEXA_PUBLIC_BASE_URL']);
  const publicBaseUrl = normalizeBaseUrl(
    process.env.ALEXA_PUBLIC_BASE_URL || envFile.ALEXA_PUBLIC_BASE_URL,
  );
  const publicIngress = getAlexaPublicIngressMetadata(publicBaseUrl);

  if (!config) {
    const oauthStatus = getAlexaOAuthStatus(
      resolveAlexaOAuthConfig(process.env, DEFAULT_ALEXA_PATH),
    );
    return {
      enabled: false,
      running: false,
      oauthEnabled: oauthStatus.enabled,
      oauthAuthorizationPath: oauthStatus.authorizationPath,
      oauthTokenPath: oauthStatus.tokenPath,
      oauthHealthPath: oauthStatus.healthPath,
      oauthScope: oauthStatus.scope,
      oauthGroupFolder: oauthStatus.groupFolder,
      publicBaseUrl,
      publicEndpointUrl: buildPublicUrl(publicBaseUrl, DEFAULT_ALEXA_PATH),
      publicOAuthHealthUrl: buildPublicUrl(
        publicBaseUrl,
        oauthStatus.healthPath,
      ),
      publicIngressKind: publicIngress.kind,
      publicIngressHint: publicIngress.hint,
      publicBrowserHint: publicIngress.browserHint,
      lastSignedRequestAt: lastSignedRequest?.updatedAt,
      lastSignedRequestType: lastSignedRequest?.requestType,
      lastSignedIntent: lastSignedRequest?.intentName,
      lastSignedGroupFolder: lastSignedRequest?.groupFolder,
      lastSignedResponseSource: lastSignedRequest?.responseSource,
    };
  }

  const oauthStatus = getAlexaOAuthStatus(oauthConfig);
  return {
    enabled: true,
    running,
    host: config.host,
    port: boundPort ?? config.port,
    path: config.path,
    healthPath: config.healthPath,
    verifySignature: config.verifySignature,
    requireAccountLinking: config.requireAccountLinking,
    allowedUserIdsCount: config.allowedUserIds.length,
    targetGroupFolder: config.targetGroupFolder,
    oauthEnabled: oauthStatus.enabled,
    oauthAuthorizationPath: oauthStatus.authorizationPath,
    oauthTokenPath: oauthStatus.tokenPath,
    oauthHealthPath: oauthStatus.healthPath,
    oauthScope: oauthStatus.scope,
    oauthGroupFolder: oauthStatus.groupFolder,
    publicBaseUrl,
    publicEndpointUrl: buildPublicUrl(publicBaseUrl, config.path),
    publicOAuthHealthUrl: buildPublicUrl(publicBaseUrl, oauthStatus.healthPath),
    publicIngressKind: publicIngress.kind,
    publicIngressHint: publicIngress.hint,
    publicBrowserHint: publicIngress.browserHint,
    lastSignedRequestAt: lastSignedRequest?.updatedAt,
    lastSignedRequestType: lastSignedRequest?.requestType,
    lastSignedIntent: lastSignedRequest?.intentName,
    lastSignedGroupFolder: lastSignedRequest?.groupFolder,
    lastSignedResponseSource: lastSignedRequest?.responseSource,
  };
}

export function formatAlexaStatusMessage(status: AlexaStatus): string {
  if (!status.enabled) {
    return [
      '*Alexa Voice*',
      '- Status: disabled',
      '- Detail: set `ALEXA_SKILL_ID` to enable the Alexa voice ingress.',
      '- Next step: configure the skill ID before expecting Alexa requests on this host.',
    ].join('\n');
  }

  return [
    '*Alexa Voice*',
    `- Status: ${status.running ? 'listening' : 'configured but not started'}`,
    `- Bind: ${status.host}:${status.port}${status.path}`,
    `- Health: ${status.healthPath}`,
    `- Request signature verification: ${status.verifySignature ? 'on' : 'off (dev only)'}`,
    `- Personal-account linking gate: ${status.requireAccountLinking ? 'strict' : 'required by Alexa intents'}`,
    `- Allowed Alexa IDs: ${status.allowedUserIdsCount || 0}`,
    status.targetGroupFolder
      ? `- Target group folder fallback: ${status.targetGroupFolder}`
      : '- Target group folder fallback: linked-account mapping',
    `- OAuth account linking: ${status.oauthEnabled ? 'configured' : 'not configured'}`,
    status.oauthAuthorizationPath
      ? `- OAuth auth path: ${status.oauthAuthorizationPath}`
      : '- OAuth auth path: unavailable',
    status.oauthTokenPath
      ? `- OAuth token path: ${status.oauthTokenPath}`
      : '- OAuth token path: unavailable',
    status.oauthHealthPath
      ? `- OAuth health path: ${status.oauthHealthPath}`
      : '- OAuth health path: unavailable',
    status.oauthGroupFolder
      ? `- OAuth target group: ${status.oauthGroupFolder}`
      : '- OAuth target group: unavailable',
    status.oauthScope
      ? `- OAuth scope: ${status.oauthScope}`
      : '- OAuth scope: unavailable',
    status.publicBaseUrl
      ? `- Public HTTPS base: ${status.publicBaseUrl}`
      : '- Public HTTPS base: unavailable',
    status.publicEndpointUrl
      ? `- Public endpoint URL: ${status.publicEndpointUrl}`
      : '- Public endpoint URL: unavailable',
    status.publicOAuthHealthUrl
      ? `- Public OAuth health URL: ${status.publicOAuthHealthUrl}`
      : '- Public OAuth health URL: unavailable',
    status.publicIngressKind
      ? `- Public ingress type: ${status.publicIngressKind}`
      : '- Public ingress type: unknown',
    status.publicIngressHint
      ? `- Public ingress note: ${status.publicIngressHint}`
      : '- Public ingress note: make sure the Alexa console SSL certificate type matches the public endpoint certificate.',
    status.publicBrowserHint
      ? `- Browser check note: ${status.publicBrowserHint}`
      : '- Browser check note: unavailable',
    status.lastSignedRequestAt
      ? `- Last signed request at: ${status.lastSignedRequestAt}`
      : '- Last signed request at: none seen since startup',
    status.lastSignedRequestType
      ? `- Last signed request type: ${status.lastSignedRequestType}`
      : '- Last signed request type: unavailable',
    status.lastSignedIntent
      ? `- Last signed intent: ${status.lastSignedIntent}`
      : '- Last signed intent: unavailable',
    status.lastSignedGroupFolder
      ? `- Last signed group folder: ${status.lastSignedGroupFolder}`
      : '- Last signed group folder: unavailable',
    status.lastSignedResponseSource
      ? `- Last signed response source: ${status.lastSignedResponseSource}`
      : '- Last signed response source: unavailable',
    '- Tip: expose this endpoint through HTTPS and configure account linking before using personal Alexa intents.',
  ].join('\n');
}

export function normalizeAlexaSpeech(text: string): string {
  let normalized = formatOutbound(text);
  normalized = normalized.replace(
    /Open in Google Calendar:\s*https?:\/\/\S+/gi,
    ' ',
  );
  normalized = normalized.replace(/```[\s\S]*?```/g, ' code snippet omitted ');
  normalized = normalized.replace(/`([^`]+)`/g, '$1');
  normalized = normalized.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1');
  normalized = normalized.replace(/https?:\/\/\S+/g, ' ');
  normalized = normalized.replace(/\bOpen in Google Calendar:\s*/gi, ' ');
  normalized = normalized.replace(/\b(Got it|Done|Okay)\s*-\s*/g, '$1. ');
  normalized = normalized.replace(/\btoday afternoon\b/gi, 'this afternoon');
  normalized = normalized.replace(/\btoday evening\b/gi, 'tonight');
  normalized = normalized.replace(/\btoday morning\b/gi, 'this morning');
  normalized = normalized.replace(
    /\s*@\s*([^,.\n]+),\s*\d{1,5}[^.!?\n]*?(?=\s+\d{1,2}:\d{2}\s*(?:AM|PM)-|$)/gi,
    ' at $1',
  );
  normalized = normalized.replace(
    /\bWith ([A-Z][a-z' -]+), I would stay with\s+/g,
    'With $1, ',
  );
  normalized = normalized.replace(
    /\bSo the main thing is fairly clear\.\s*/gi,
    '',
  );
  normalized = normalized.replace(
    /\bI think the clearest next step is this\./gi,
    'If you want, I can make that more direct.',
  );
  normalized = normalized.replace(
    /\bI can't check that live right now\. Narrow the question and I'll keep it grounded\. If you want, I can send the fuller version to telegram, save the key result to the library, and remind me to revisit this\./gi,
    "I can't check that live right now. If you want, I can send the fuller version to Telegram.",
  );
  normalized = normalized.replace(
    /\bIf you want, I can set a reminder for the follow-through, save it under ([A-Za-z][A-Za-z' -]+), and pin it into the evening reset\./gi,
    (_match, name: string) =>
      `If you want, I can remind you about ${name
        .trim()
        .replace(/\bcandace\b/gi, 'Candace')} later tonight.`,
  );
  normalized = normalized.replace(/\bcandace\b/g, 'Candace');
  normalized = normalized.replace(/[*_#>|]/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length > 7000) {
    normalized = `${normalized.slice(0, 6970).trim()} ... I can keep going if you want.`;
  }
  return normalized;
}

function softenAlexaBundleBoilerplate(text: string): string {
  return text
    .replace(
      /\bI have (?:one next step|\d+ next steps) ready:\s*([^.]+)\./gi,
      (_match, actions: string) => `If you want, I can ${actions}.`,
    )
    .replace(
      /\bI have a bundle ready if you want me to go over it again\./gi,
      'If you want, I can go over the next options again.',
    );
}

function normalizeAlexaSentenceKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/^[\s,]+/, '')
    .replace(
      /^(the main thing (?:still open with [a-z' -]+ )?is |so the main thing is |also keep in mind |at home, |one loose end is |the conversation most likely to slip is )/i,
      '',
    )
    .replace(/^[a-z' -]+:\s+/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shapeAlexaSpeech(text: string): string {
  const normalized = softenAlexaBundleBoilerplate(normalizeAlexaSpeech(text));
  if (!normalized) return '';

  const sentences =
    normalized
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean) || [];
  const selected: string[] = [];
  const selectedKeys: string[] = [];
  let totalLength = 0;

  for (const sentence of sentences) {
    const key = normalizeAlexaSentenceKey(sentence);
    if (
      key &&
      selectedKeys.some(
        (existing) =>
          existing === key ||
          existing.includes(key) ||
          key.includes(existing),
      )
    ) {
      continue;
    }
    const nextLength =
      totalLength + sentence.length + (selected.length > 0 ? 1 : 0);
    if (selected.length >= 3 || nextLength > 320) break;
    selected.push(sentence);
    if (key) selectedKeys.push(key);
    totalLength = nextLength;
  }

  if (selected.length > 0) {
    return selected.join(' ');
  }

  return normalized.length > 320
    ? `${normalized.slice(0, 317).trim()}...`
    : normalized;
}

function extractPrincipal(requestEnvelope: RequestEnvelope): AlexaPrincipal {
  const system = requestEnvelope.context?.System;
  const user = system?.user;
  const person = requestEnvelope.context?.System.person;

  return {
    userId: user?.userId || 'anonymous-alexa-user',
    personId: person?.personId || undefined,
    accessToken: person?.accessToken || user?.accessToken || undefined,
  };
}

function authorizeAlexaRequest(
  requestEnvelope: RequestEnvelope,
  config: AlexaConfig,
  assistantName: string,
): AuthorizationResult {
  const principal = extractPrincipal(requestEnvelope);
  const candidates = [principal.personId, principal.userId].filter(
    (value): value is string => Boolean(value),
  );

  if (
    config.allowedUserIds.length > 0 &&
    !candidates.some((candidate) => config.allowedUserIds.includes(candidate))
  ) {
    logger.warn(
      { candidates, allowedUserIdsCount: config.allowedUserIds.length },
      'Alexa request denied by allowlist',
    );
    return {
      ok: false,
      kind: 'forbidden',
      speech: `${assistantName} is not authorized for this Alexa account yet. Please add this user ID to the allowlist before trying again.`,
      reprompt: 'Please check the Alexa allowlist configuration and try again.',
    };
  }

  return { ok: true, principal };
}

function buildBarrierResponse(
  handlerInput: HandlerInput,
  barrier: AlexaBarrierResponse,
) {
  const builder = handlerInput.responseBuilder
    .speak(barrier.speech)
    .reprompt(barrier.reprompt || DEFAULT_ALEXA_REPROMPT);
  if (barrier.kind === 'link-account') {
    builder.withLinkAccountCard();
  }
  return builder.getResponse();
}

function getIntentSlotValue(
  requestEnvelope: RequestEnvelope,
  slotName: string,
): string {
  const request = requestEnvelope.request;
  if (request.type !== 'IntentRequest') return '';
  const slot = request.intent.slots?.[slotName];
  return slot?.value?.trim() || '';
}

function getIntentSlotValues(
  requestEnvelope: RequestEnvelope,
): Record<string, string> {
  const request = requestEnvelope.request;
  if (request.type !== 'IntentRequest') return {};
  return Object.fromEntries(
    Object.entries(request.intent.slots || {}).map(([name, slot]) => [
      name,
      slot?.value?.trim() || '',
    ]),
  );
}

function getRequestTimestampDate(requestEnvelope: RequestEnvelope): Date {
  const raw = requestEnvelope.request.timestamp;
  const parsed = raw ? new Date(raw) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function buildAlexaLocalVoiceResponse(
  kind: 'time' | 'day' | 'whats_up' | 'help',
  referenceDate: Date,
): { speech: string; reprompt: string } {
  if (kind === 'time') {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: 'numeric',
      minute: '2-digit',
    }).format(referenceDate);
    return {
      speech: `It's ${formatted}.`,
      reprompt: DEFAULT_ALEXA_REPROMPT,
    };
  }
  if (kind === 'day') {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(referenceDate);
    return {
      speech: `It's ${formatted}.`,
      reprompt: DEFAULT_ALEXA_REPROMPT,
    };
  }
  if (kind === 'whats_up') {
    return {
      speech:
        "I'm here. We can look at what matters today, what you're forgetting, or one thing you want help with.",
      reprompt: DEFAULT_ALEXA_REPROMPT,
    };
  }
  return {
    speech:
      'Yes. I can help with plans, open loops, people stuff, reminders, and I can send the fuller version to Telegram when voice gets too tight.',
    reprompt: DEFAULT_ALEXA_REPROMPT,
  };
}

function isBareReference(value: string): boolean {
  return ['that', 'this', 'it', 'something'].includes(
    value.trim().toLowerCase(),
  );
}

function isDirectnessMemoryCommand(value: string): boolean {
  return /^(?:be )?(?:a little |a bit )?more direct[.!?]*$/i.test(
    normalizeVoicePrompt(value).trim(),
  );
}

function buildRequestIntent(requestEnvelope: RequestEnvelope): Intent | null {
  const request = requestEnvelope.request;
  return request.type === 'IntentRequest' ? request.intent : null;
}

function buildLinkAccountBarrier(
  speech: string,
  reprompt?: string,
): AlexaBarrierResponse {
  return {
    kind: 'link-account',
    speech,
    reprompt,
  };
}

function assertTrustedSkillRequest(
  requestEnvelope: RequestEnvelope,
  config: AlexaConfig,
): void {
  const candidates = [
    requestEnvelope.context?.System?.application?.applicationId,
    requestEnvelope.session?.application?.applicationId,
  ].filter((value): value is string => Boolean(value));

  if (candidates.length === 0) {
    throw new Error('Alexa request rejected: application ID missing');
  }
  if (!candidates.every((candidate) => candidate === config.skillId)) {
    throw new Error('Alexa request rejected: skill ID mismatch');
  }
}

function buildSetupBarrier(
  assistantName: string,
  groupFolder: string,
): AlexaBarrierResponse {
  return {
    kind: 'setup',
    speech: `${assistantName} is linked, but the ${groupFolder} workspace is not ready yet.`,
    reprompt: 'Finish the Andrea workspace setup, then try again.',
  };
}

function buildAlexaConversationState(
  flowKey: string,
  subjectKind: AlexaConversationState['subjectKind'],
  summaryText: string,
  supportedFollowups: AlexaConversationState['supportedFollowups'],
  subjectData: AlexaConversationSubjectData = {},
  styleHints: AlexaConversationState['styleHints'] = {},
): AlexaConversationState {
  return {
    flowKey,
    subjectKind,
    summaryText,
    supportedFollowups,
    subjectData,
    styleHints,
  };
}

function buildAlexaCompanionConversationState(params: {
  flowKey: string;
  subjectKind: AlexaConversationState['subjectKind'];
  summaryText: string;
  guidanceGoal: AlexaCompanionGuidanceGoal;
  subjectData?: AlexaConversationSubjectData;
  supportedFollowups?: AlexaConversationState['supportedFollowups'];
  prioritizationLens?: AlexaConversationState['styleHints']['prioritizationLens'];
  hasActionItem?: boolean;
  hasRiskSignal?: boolean;
  reminderCandidate?: boolean;
  responseStyle?: AlexaConversationState['styleHints']['responseStyle'];
  responseSource?: AlexaConversationState['styleHints']['responseSource'];
  toneProfile?: AlexaConversationState['styleHints']['toneProfile'];
  personalityCooldown?: AlexaConversationState['styleHints']['personalityCooldown'];
}): AlexaConversationState {
  return buildAlexaConversationState(
    params.flowKey,
    params.subjectKind,
    params.summaryText,
    params.supportedFollowups || baseFollowupsForSubject(params.subjectKind),
    params.subjectData,
    {
      channelMode: 'alexa_companion',
      guidanceGoal: params.guidanceGoal,
      initiativeLevel: 'measured',
      prioritizationLens: params.prioritizationLens || 'general',
      hasActionItem: params.hasActionItem,
      hasRiskSignal: params.hasRiskSignal,
      reminderCandidate: params.reminderCandidate,
      responseStyle: params.responseStyle,
      responseSource: params.responseSource,
      toneProfile: params.toneProfile,
      personalityCooldown: params.personalityCooldown,
    },
  );
}

function parseAlexaJsonField<T>(
  raw: string | undefined,
): T | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

function serializeAlexaJsonField(value: unknown): string | undefined {
  return value ? JSON.stringify(value) : undefined;
}

function formatAlexaCalendarWhen(input: {
  startIso: string;
  endIso: string;
  allDay: boolean;
  timeZone?: string;
}): string {
  const timeZone = input.timeZone || TIMEZONE;
  const start = new Date(input.startIso);
  const end = new Date(input.endIso);
  if (input.allDay) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(start);
  }
  const dateText = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(start);
  const startText = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(start);
  const endText = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(end);
  return `${dateText} from ${startText} to ${endText}`;
}

function parseAlexaSchedulingContext(
  state: AlexaConversationState | undefined,
): GoogleCalendarSchedulingContextState | undefined {
  return parseAlexaJsonField<GoogleCalendarSchedulingContextState>(
    state?.subjectData.activeSchedulingContextJson,
  );
}

function parseAlexaActiveEventContext(
  state: AlexaConversationState | undefined,
  now = new Date(),
): ActiveGoogleCalendarEventContextState | undefined {
  const parsed = parseAlexaJsonField<ActiveGoogleCalendarEventContextState>(
    state?.subjectData.activeCalendarEventContextJson,
  );
  if (!parsed) return undefined;
  return isActiveGoogleCalendarEventContextExpired(parsed, now)
    ? undefined
    : parsed;
}

function parseAlexaPendingCalendarCreate(
  state: AlexaConversationState | undefined,
): PendingGoogleCalendarCreateState | undefined {
  return parseAlexaJsonField<PendingGoogleCalendarCreateState>(
    state?.subjectData.pendingCalendarCreateJson,
  );
}

function parseAlexaPendingCalendarEventAction(
  state: AlexaConversationState | undefined,
  now = new Date(),
): PendingGoogleCalendarEventActionState | undefined {
  const parsed = parseAlexaJsonField<PendingGoogleCalendarEventActionState>(
    state?.subjectData.pendingCalendarEventActionJson,
  );
  if (!parsed) return undefined;
  return isPendingGoogleCalendarEventActionExpired(parsed, now)
    ? undefined
    : parsed;
}

function parseAlexaPendingCalendarReminder(
  state: AlexaConversationState | undefined,
  now = new Date(),
): PendingCalendarReminderState | undefined {
  const parsed = parseAlexaJsonField<PendingCalendarReminderState>(
    state?.subjectData.pendingCalendarReminderJson,
  );
  if (!parsed) return undefined;
  return isPendingCalendarReminderExpired(parsed, now) ? undefined : parsed;
}

function buildAlexaAssistantTaskState(params: {
  previousState?: AlexaConversationState;
  flowKey: string;
  subjectKind: AlexaConversationState['subjectKind'];
  summaryText: string;
  guidanceGoal: AlexaCompanionGuidanceGoal;
  taskKind: NonNullable<AlexaConversationSubjectData['activeTaskKind']>;
  taskSummary?: string;
  entityLabel?: string;
  dateTimeContext?: string;
  pendingWriteAction?: AlexaConversationSubjectData['pendingWriteAction'];
  activeEventContext?: ActiveGoogleCalendarEventContextState | null;
  schedulingContext?: GoogleCalendarSchedulingContextState | null;
  pendingCreateState?: PendingGoogleCalendarCreateState | null;
  pendingEventActionState?: PendingGoogleCalendarEventActionState | null;
  pendingReminderState?: PendingCalendarReminderState | null;
  pendingReminderBody?: string | null;
  supportedFollowups?: AlexaConversationState['supportedFollowups'];
  prioritizationLens?: AlexaConversationState['styleHints']['prioritizationLens'];
  hasActionItem?: boolean;
  hasRiskSignal?: boolean;
  reminderCandidate?: boolean;
  responseSource?: AlexaConversationState['styleHints']['responseSource'];
  subjectData?: AlexaConversationSubjectData;
}): AlexaConversationState {
  const previous = params.previousState;
  const entityLabel =
    params.entityLabel ||
    params.subjectData?.activeSubjectLabel ||
    previous?.subjectData.activeSubjectLabel;
  const summaryText = params.summaryText.trim();
  const taskSummary =
    params.taskSummary?.trim() ||
    params.subjectData?.lastRecommendation?.trim() ||
    summaryText;
  const nextState = buildAlexaCompanionConversationState({
    flowKey: params.flowKey,
    subjectKind: params.subjectKind,
    summaryText,
    guidanceGoal: params.guidanceGoal,
    subjectData: {
      ...(previous?.subjectData || {}),
      ...(params.subjectData || {}),
      lastRouteOutcome: 'local_assistant_task',
      fallbackCount: 0,
      activeTaskKind: params.taskKind,
      activeTaskSummary: taskSummary,
      activeEntityLabel: entityLabel,
      activeDateTimeContext:
        params.dateTimeContext || previous?.subjectData.activeDateTimeContext,
      pendingWriteAction: params.pendingWriteAction,
      activeVoiceAnchor:
        entityLabel ||
        params.subjectData?.activeVoiceAnchor ||
        previous?.subjectData.activeVoiceAnchor ||
        params.subjectKind,
      activeVoiceActionSummary:
        taskSummary ||
        params.subjectData?.activeVoiceActionSummary ||
        previous?.subjectData.activeVoiceActionSummary,
      activeSubjectLabel: entityLabel,
      conversationFocus:
        entityLabel ||
        taskSummary ||
        params.subjectData?.conversationFocus ||
        previous?.subjectData.conversationFocus,
      activeCalendarEventContextJson: serializeAlexaJsonField(
        params.activeEventContext,
      ),
      activeSchedulingContextJson: serializeAlexaJsonField(
        params.schedulingContext,
      ),
      pendingCalendarCreateJson: serializeAlexaJsonField(
        params.pendingCreateState,
      ),
      pendingCalendarEventActionJson: serializeAlexaJsonField(
        params.pendingEventActionState,
      ),
      pendingCalendarReminderJson: serializeAlexaJsonField(
        params.pendingReminderState,
      ),
      pendingReminderBody: params.pendingReminderBody || undefined,
    },
    supportedFollowups: params.supportedFollowups,
    prioritizationLens: params.prioritizationLens,
    hasActionItem: params.hasActionItem,
    hasRiskSignal: params.hasRiskSignal,
    reminderCandidate: params.reminderCandidate,
    responseSource: params.responseSource || 'local_companion',
  });
  return nextState;
}

function clearAlexaAssistantPendingState(
  state: AlexaConversationState | undefined,
): AlexaConversationSubjectData {
  return {
    ...(state?.subjectData || {}),
    pendingWriteAction: undefined,
    pendingCalendarCreateJson: undefined,
    pendingCalendarEventActionJson: undefined,
    pendingCalendarReminderJson: undefined,
    pendingReminderBody: undefined,
  };
}

function extractAlexaReminderTiming(utterance: string): string | undefined {
  const normalized = normalizeVoicePrompt(utterance).toLowerCase();
  const directMatch =
    normalized.match(
      /\b(today at \d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow(?: morning| afternoon| evening)?|today(?: morning| afternoon| evening)?|tonight)\b/i,
    )?.[1] ||
    normalized.match(
      /\b(at \d{1,2}(?::\d{2})?\s*(?:am|pm)? today|at \d{1,2}(?::\d{2})?\s*(?:am|pm)? tomorrow)\b/i,
    )?.[1];
  const trimmed = directMatch?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'tonight') return 'today evening';
  return trimmed.startsWith('at ') ? trimmed.replace(/\s+today$/, ' today') : trimmed;
}

function escapeAlexaRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAlexaReminderPrompt(reminderBody: string, state?: AlexaConversationState): string {
  const cleaned = reminderBody.trim().replace(/[.?!]+$/g, '');
  const entityLabel = state?.subjectData.activeEntityLabel?.trim();
  const escapedEntity = entityLabel ? escapeAlexaRegex(entityLabel) : null;
  if (
    entityLabel &&
    escapedEntity &&
    (new RegExp(`^keep ${escapedEntity} in view`, 'i').test(cleaned) ||
      new RegExp(`^with ${escapedEntity},`, 'i').test(cleaned))
  ) {
    return `When should I remind you to follow up with ${entityLabel}?`;
  }
  if (
    /^(?:call|text|email|reply|follow up|check in|send|ask|confirm|pay|pick up|book|schedule|move|cancel|circle back)\b/i.test(
      cleaned,
    )
  ) {
    return `When should I remind you to ${cleaned}?`;
  }
  return `When should I remind you about ${cleaned}?`;
}

function parseDirectAlexaReminderRequest(input: {
  utterance: string;
  state?: AlexaConversationState;
}): {
  reminderBody?: string;
  timingText?: string;
  needsTiming?: boolean;
} | null {
  const normalized = normalizeVoicePrompt(input.utterance).trim();
  if (!/^remind me\b/i.test(normalized)) {
    return null;
  }

  const aboutThatMatch = normalized.match(
    /^remind me(?: about)? (that|it|this)(?: (today(?: morning| afternoon| evening)?|tomorrow(?: morning| afternoon| evening)?|tonight|at .+))?$/i,
  );
  if (aboutThatMatch) {
    const reminderBody =
      input.state?.subjectData.activeTaskSummary?.trim() ||
      input.state?.subjectData.activeVoiceActionSummary?.trim() ||
      input.state?.subjectData.lastRecommendation?.trim() ||
      input.state?.subjectData.lastAnswerSummary?.trim() ||
      input.state?.summaryText?.trim();
    if (!reminderBody) {
      return { needsTiming: false };
    }
    return {
      reminderBody,
      timingText:
        aboutThatMatch[2]?.trim() ||
        extractAlexaReminderTiming(normalized) ||
        undefined,
      needsTiming: !aboutThatMatch[2]?.trim(),
    };
  }

  const toMatch = normalized.match(/^remind me (.+?) to (.+)$/i);
  if (toMatch) {
    return {
      timingText: toMatch[1]?.trim(),
      reminderBody: toMatch[2]?.trim(),
    };
  }

  const directBodyMatch = normalized.match(/^remind me to (.+)$/i);
  if (directBodyMatch) {
    return {
      reminderBody: directBodyMatch[1]?.trim(),
      timingText: extractAlexaReminderTiming(normalized),
      needsTiming: true,
    };
  }

  if (/^remind me later$/i.test(normalized)) {
    const reminderBody =
      input.state?.subjectData.activeTaskSummary?.trim() ||
      input.state?.subjectData.activeVoiceActionSummary?.trim() ||
      input.state?.subjectData.lastRecommendation?.trim() ||
      input.state?.subjectData.lastAnswerSummary?.trim();
    if (!reminderBody) return { needsTiming: false };
    return {
      reminderBody,
      needsTiming: true,
    };
  }

  return null;
}

function startOfAlexaDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addAlexaDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function resolveAlexaEventSearchWindow(
  utterance: string,
  now = new Date(),
): { start: Date; end: Date } {
  const normalized = normalizeVoicePrompt(utterance).toLowerCase();
  if (/\btomorrow\b/.test(normalized)) {
    const start = addAlexaDays(startOfAlexaDay(now), 1);
    return { start, end: addAlexaDays(start, 1) };
  }
  if (/\bthis afternoon\b/.test(normalized)) {
    const start = new Date(now);
    start.setHours(12, 0, 0, 0);
    const end = new Date(now);
    end.setHours(17, 0, 0, 0);
    return { start, end };
  }
  if (/\btoday\b/.test(normalized) || /\btonight\b/.test(normalized)) {
    const start = startOfAlexaDay(now);
    return { start, end: addAlexaDays(start, 1) };
  }
  const start = startOfAlexaDay(now);
  return { start, end: addAlexaDays(start, 14) };
}

function extractAlexaEventLookupQuery(
  utterance: string,
): string | undefined {
  let normalized = normalizeVoicePrompt(utterance)
    .replace(
      /^(?:please\s+)?(?:move|reschedule|cancel|delete|remove)\s+/i,
      '',
    )
    .trim();
  normalized = normalized
    .replace(
      /\b(?:to|for)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+(?:today|tomorrow))?\b.*$/i,
      '',
    )
    .replace(
      /\b(?:today|tomorrow|this afternoon|tonight|this evening)\b/gi,
      '',
    )
    .trim();
  return normalized || undefined;
}

function looksLikeAlexaCalendarReadRequest(utterance: string): boolean {
  const normalized = normalizeVoicePrompt(utterance).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /^(?:add|put|schedule|move|reschedule|cancel|delete|remove|remind me)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /^(?:what(?:'s| is)\s+on\s+my\s+(?:calendar|schedule)|what\s+do\s+i\s+have\b|what\s+have\s+i\s+got\b|anything\s+on\s+my\s+(?:calendar|schedule)\b|what(?:'s| is)\s+coming\s+up\b|coming up soon\b)/.test(
    normalized,
  );
}

function parseDailyCompanionContext(
  state: AlexaConversationState | undefined,
): DailyCompanionContext | undefined {
  const raw = state?.subjectData.dailyCompanionContextJson?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as DailyCompanionContext;
    if (parsed && parsed.version === 1) {
      return {
        ...parsed,
        usedThreadIds: parsed.usedThreadIds || [],
        usedThreadTitles: parsed.usedThreadTitles || [],
        usedThreadReasons: parsed.usedThreadReasons || [],
        threadSummaryLines: parsed.threadSummaryLines || [],
        comparisonKeys: {
          ...parsed.comparisonKeys,
          thread: parsed.comparisonKeys?.thread || null,
        },
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inferDailyCompanionModeFromAlexaState(
  state: AlexaConversationState,
): DailyCompanionContext['mode'] {
  switch (state.styleHints.guidanceGoal) {
    case 'family_guidance':
    case 'shared_plans':
      return 'household_guidance';
    case 'evening_reset':
      return 'evening_reset';
    default:
      return 'open_guidance';
  }
}

function buildFallbackDailyCompanionContextFromAlexaState(
  state: AlexaConversationState | undefined,
): DailyCompanionContext | undefined {
  if (!state || state.styleHints.responseSource !== 'local_companion') {
    return undefined;
  }

  const summaryText =
    state.subjectData.lastAnswerSummary?.trim() || state.summaryText.trim();
  if (!summaryText) {
    return undefined;
  }

  const recommendationText =
    state.subjectData.lastRecommendation?.trim() ||
    state.subjectData.pendingActionText?.trim() ||
    null;
  const threadId = state.subjectData.threadId?.trim();
  const threadTitle = state.subjectData.threadTitle?.trim();
  const shortText = recommendationText || summaryText;
  const extendedText = recommendationText || summaryText;
  const focusText =
    state.subjectData.conversationFocus?.trim() ||
    state.subjectData.personName?.trim() ||
    threadTitle ||
    state.subjectKind;

  return {
    version: 1,
    mode: inferDailyCompanionModeFromAlexaState(state),
    channel: 'alexa',
    generatedAt: new Date().toISOString(),
    summaryText,
    shortText,
    extendedText,
    leadReason: 'conversation_followup',
    signalsUsed: [],
    signalsOmitted: [],
    householdSignals: [],
    recommendationKind: recommendationText ? 'do_now' : 'none',
    recommendationText,
    subjectKind: state.subjectKind,
    supportedFollowups: state.supportedFollowups,
    subjectData: {
      personName: state.subjectData.personName,
      activePeople: state.subjectData.activePeople,
      householdFocus: state.subjectData.householdFocus,
    },
    extraDetails:
      state.subjectData.threadSummaryLines?.length
        ? state.subjectData.threadSummaryLines
        : recommendationText && recommendationText !== summaryText
          ? [summaryText]
          : [],
    memoryLines: [],
    usedThreadIds: threadId ? [threadId] : [],
    usedThreadTitles: threadTitle ? [threadTitle] : [],
    usedThreadReasons:
      threadTitle || threadId ? ['it was the active thread in the last answer'] : [],
    threadSummaryLines: state.subjectData.threadSummaryLines || [],
    comparisonKeys: {
      nextEvent: null,
      nextReminder: null,
      recommendation: recommendationText,
      household: state.subjectData.householdFocus ? focusText : null,
      focus: focusText || null,
      thread: threadTitle || threadId || null,
    },
    toneProfile: state.styleHints.toneProfile || 'balanced',
    ritualType: null,
    ritualToneStyle: null,
    ritualTriggerStyle: null,
    personalityCooldown: state.styleHints.personalityCooldown,
  };
}

function resolveAlexaCompanionPriorContext(
  state: AlexaConversationState | undefined,
): DailyCompanionContext | undefined {
  return (
    parseDailyCompanionContext(state) ||
    buildFallbackDailyCompanionContextFromAlexaState(state)
  );
}

function shouldRunAlexaAssistantTaskTurn(intentName: string): boolean {
  return [
    ALEXA_COMPANION_GUIDANCE_INTENT,
    ALEXA_PEOPLE_HOUSEHOLD_INTENT,
    ALEXA_PLANNING_ORIENTATION_INTENT,
    ALEXA_SAVE_REMIND_HANDOFF_INTENT,
    ALEXA_OPEN_ASK_INTENT,
    ALEXA_CONVERSATION_CONTROL_INTENT,
    ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ].includes(intentName);
}

function buildAlexaStateFromDailyCompanion(
  baseState: AlexaConversationState,
  response: Awaited<ReturnType<typeof buildDailyCompanionResponse>>,
): AlexaConversationState {
  const context = response?.context;
  if (!context) {
    return {
      ...baseState,
      styleHints: {
        ...baseState.styleHints,
        responseSource: 'local_companion',
      },
    };
  }
  const continuationCandidate = {
    voiceSummary: context.summaryText,
    handoffPayload: {
      kind: 'message' as const,
      title:
        context.usedThreadTitles?.[0] ||
        context.subjectData.personName ||
        'Andrea follow-up',
      text: context.extendedText || response.reply,
      sourceSummary:
        context.signalsUsed.length > 0
          ? `Using ${context.signalsUsed.join(', ')}`
          : undefined,
      followupSuggestions: [],
    },
    completionText:
      context.recommendationText || context.extendedText || context.summaryText,
    threadId: context.usedThreadIds?.[0],
    threadTitle: context.usedThreadTitles?.[0],
    followupSuggestions: [] as string[],
  };
  return {
    ...baseState,
    subjectKind: context.subjectKind,
    subjectData: {
      ...baseState.subjectData,
      ...context.subjectData,
      lastRouteOutcome: 'local',
      fallbackCount: 0,
      threadId: context.usedThreadIds?.[0],
      threadTitle: context.usedThreadTitles?.[0],
      threadSummaryLines: context.threadSummaryLines || [],
      lastAnswerSummary: context.summaryText,
      lastRecommendation: context.recommendationText || undefined,
      pendingActionText: context.recommendationText || undefined,
      activeTaskKind:
        context.subjectKind === 'person' ||
        context.subjectKind === 'household' ||
        context.subjectKind === 'communication_thread'
          ? 'communication_draft'
          : 'planning_guidance',
      activeTaskSummary:
        context.recommendationText || context.summaryText || baseState.summaryText,
      activeEntityLabel:
        context.subjectData.personName ||
        context.usedThreadTitles?.[0] ||
        (context.subjectData as AlexaConversationSubjectData).activeSubjectLabel,
      activeVoiceFamily:
        baseState.subjectData.activeVoiceFamily ||
        baseState.subjectData.lastIntentFamily ||
        baseState.flowKey,
      activeVoiceAnchor:
        context.subjectData.personName ||
        context.usedThreadTitles?.[0] ||
        baseState.subjectData.activeVoiceAnchor ||
        context.subjectKind,
      activeVoiceActionSummary:
        context.recommendationText || context.summaryText,
      activeSubjectLabel:
        context.subjectData.personName ||
        context.usedThreadTitles?.[0] ||
        context.subjectKind,
      conversationFocus:
        context.usedThreadTitles?.[0] ||
        context.subjectData.personName ||
        context.subjectKind,
      dailyCompanionContextJson: JSON.stringify(context),
      companionContinuationJson: JSON.stringify(continuationCandidate),
    },
    summaryText: context.summaryText,
    supportedFollowups: Array.from(
      new Set([
        ...context.supportedFollowups,
        'send_details',
        'save_to_library',
        'track_thread',
        'create_reminder',
      ]),
    ),
    styleHints: {
      ...baseState.styleHints,
      channelMode: 'alexa_companion',
      initiativeLevel: 'measured',
      responseSource: 'local_companion',
      toneProfile: context.toneProfile,
      personalityCooldown: context.personalityCooldown,
    },
  };
}

function preserveAlexaConversationFrameForStyleChange(
  previousState: AlexaConversationState,
  nextState: AlexaConversationState,
): AlexaConversationState {
  return {
    ...nextState,
    flowKey: previousState.flowKey,
    subjectKind: previousState.subjectKind,
    summaryText: nextState.summaryText || previousState.summaryText,
    supportedFollowups:
      previousState.supportedFollowups.length > 0
        ? previousState.supportedFollowups
        : nextState.supportedFollowups,
    subjectData: {
      ...previousState.subjectData,
      ...nextState.subjectData,
      fallbackCount: 0,
      threadId:
        nextState.subjectData.threadId || previousState.subjectData.threadId,
      threadTitle:
        nextState.subjectData.threadTitle ||
        previousState.subjectData.threadTitle,
      threadSummaryLines:
        nextState.subjectData.threadSummaryLines &&
        nextState.subjectData.threadSummaryLines.length > 0
          ? nextState.subjectData.threadSummaryLines
          : previousState.subjectData.threadSummaryLines,
      lastAnswerSummary:
        nextState.subjectData.lastAnswerSummary ||
        previousState.subjectData.lastAnswerSummary ||
        nextState.summaryText ||
        previousState.summaryText,
      lastRecommendation:
        nextState.subjectData.lastRecommendation ||
        previousState.subjectData.lastRecommendation,
      pendingActionText:
        nextState.subjectData.pendingActionText ||
        previousState.subjectData.pendingActionText,
      activeVoiceFamily:
        nextState.subjectData.activeVoiceFamily ||
        previousState.subjectData.activeVoiceFamily ||
        previousState.subjectData.lastIntentFamily,
      activeVoiceAnchor:
        nextState.subjectData.activeVoiceAnchor ||
        previousState.subjectData.activeVoiceAnchor ||
        previousState.subjectData.personName ||
        previousState.subjectData.threadTitle ||
        previousState.subjectKind,
      activeVoiceActionSummary:
        nextState.subjectData.activeVoiceActionSummary ||
        previousState.subjectData.activeVoiceActionSummary ||
        nextState.subjectData.pendingActionText ||
        previousState.subjectData.pendingActionText ||
        nextState.subjectData.lastAnswerSummary ||
        previousState.subjectData.lastAnswerSummary,
      conversationFocus:
        nextState.subjectData.conversationFocus ||
        previousState.subjectData.conversationFocus ||
        previousState.subjectData.personName ||
        previousState.subjectData.threadTitle ||
        previousState.subjectKind,
      activeCapabilityId:
        previousState.subjectData.activeCapabilityId ||
        nextState.subjectData.activeCapabilityId,
      researchHandoffEligible:
        previousState.subjectData.researchHandoffEligible ??
        nextState.subjectData.researchHandoffEligible,
    },
    styleHints: {
      ...previousState.styleHints,
      ...nextState.styleHints,
      responseStyle: 'short_direct',
    },
  };
}

function seedSubjectKindLooksCommunication(
  subjectKind: AlexaConversationState['subjectKind'],
): boolean {
  return (
    subjectKind === 'person' ||
    subjectKind === 'communication_thread' ||
    subjectKind === 'life_thread'
  );
}

function buildAlexaStateFromCapabilitySeed(
  seed: AssistantCapabilityConversationSeed,
  options: {
    intentFamily?: AlexaVoiceIntentFamily;
    routeOutcome?: string;
    userUtterance?: string;
    clarifierHints?: string[];
  } = {},
): AlexaConversationState {
  const seedSubjectData =
    (seed.subjectData || {}) as AlexaConversationSubjectData;
  return buildAlexaCompanionConversationState({
    flowKey: seed.flowKey,
    subjectKind: seed.subjectKind,
    summaryText: seed.summaryText,
    guidanceGoal: seed.guidanceGoal,
    subjectData: {
      ...seedSubjectData,
      lastIntentFamily: options.intentFamily || seedSubjectData.lastIntentFamily,
      lastRouteOutcome:
        options.routeOutcome || seedSubjectData.lastRouteOutcome,
      lastUserUtterance:
        options.userUtterance || seedSubjectData.lastUserUtterance,
      clarifierHints:
        options.clarifierHints || seedSubjectData.clarifierHints,
      activeVoiceFamily:
        options.intentFamily ||
        seedSubjectData.activeVoiceFamily ||
        seedSubjectData.lastIntentFamily,
      activeVoiceAnchor:
        seedSubjectData.activeVoiceAnchor ||
        seedSubjectData.personName ||
        seedSubjectData.activeSubjectLabel ||
        seedSubjectData.threadTitle ||
        seed.subjectKind,
      activeVoiceActionSummary:
        seedSubjectData.activeVoiceActionSummary ||
        seedSubjectData.pendingActionText ||
        seedSubjectData.lastAnswerSummary ||
        seed.summaryText,
      activeTaskKind:
        seedSubjectData.activeTaskKind ||
        (seed.flowKey.includes('communication') ||
        seedSubjectKindLooksCommunication(seed.subjectKind)
          ? 'communication_draft'
          : seed.guidanceGoal === 'action_follow_through' ||
              seed.guidanceGoal === 'next_action' ||
              seed.guidanceGoal === 'meeting_prep'
            ? 'planning_guidance'
            : seedSubjectData.activeTaskKind),
      activeTaskSummary:
        seedSubjectData.activeTaskSummary ||
        seedSubjectData.lastRecommendation ||
        seedSubjectData.pendingActionText ||
        seed.summaryText,
      activeEntityLabel:
        seedSubjectData.activeEntityLabel ||
        seedSubjectData.personName ||
        seedSubjectData.activeSubjectLabel,
    },
    supportedFollowups: seed.supportedFollowups,
    prioritizationLens: seed.prioritizationLens,
    hasActionItem: seed.hasActionItem,
    hasRiskSignal: seed.hasRiskSignal,
    reminderCandidate: seed.reminderCandidate,
    responseStyle: seed.responseStyle,
    responseSource: seed.responseSource,
    toneProfile: seed.subjectData?.toneProfile,
  });
}

function extractFollowupPersonName(text: string): string | undefined {
  const match = text.match(/^what about ([a-z][a-z' -]+)$/i);
  return match?.[1]?.trim();
}

function buildAlexaNextStateForFollowupAction(
  action: import('./types.js').AlexaConversationFollowupAction,
  followupText: string,
  conversationState: AlexaConversationState | undefined,
  options: {
    intentFamily?: AlexaVoiceIntentFamily;
    routeOutcome?: string;
    clarifierHints?: string[];
  } = {},
): AlexaConversationState {
  const personName =
    extractFollowupPersonName(followupText) ||
    conversationState?.subjectData.personName;
  const normalizedFollowup = normalizeVoicePrompt(followupText) || followupText;
  const nextVoiceMetadata = {
    lastIntentFamily:
      options.intentFamily || conversationState?.subjectData.lastIntentFamily,
    lastRouteOutcome:
      options.routeOutcome ||
      conversationState?.subjectData.lastRouteOutcome ||
      'handoff',
    lastUserUtterance: normalizedFollowup,
    clarifierHints:
      options.clarifierHints || conversationState?.subjectData.clarifierHints,
    activeVoiceFamily:
      options.intentFamily ||
      conversationState?.subjectData.activeVoiceFamily ||
      conversationState?.subjectData.lastIntentFamily,
    activeVoiceAnchor:
      personName ||
      conversationState?.subjectData.activeVoiceAnchor ||
      conversationState?.subjectData.activeSubjectLabel ||
      conversationState?.subjectData.threadTitle ||
      conversationState?.subjectData.conversationFocus,
    activeVoiceActionSummary:
      conversationState?.subjectData.pendingActionText ||
      conversationState?.subjectData.activeVoiceActionSummary ||
      conversationState?.subjectData.lastAnswerSummary ||
      conversationState?.summaryText,
  };

  if (action === 'shorter') {
    return buildAlexaCompanionConversationState({
      flowKey: conversationState?.flowKey || 'followup',
      subjectKind: conversationState?.subjectKind || 'general',
      summaryText:
        conversationState?.summaryText || 'recent assistant context',
      guidanceGoal:
        conversationState?.styleHints.guidanceGoal || 'daily_brief',
      subjectData: {
        ...(conversationState?.subjectData || {}),
        ...nextVoiceMetadata,
      },
      supportedFollowups:
        conversationState?.supportedFollowups ||
        baseFollowupsForSubject('general'),
      prioritizationLens:
        conversationState?.styleHints.prioritizationLens || 'general',
      hasActionItem: conversationState?.styleHints.hasActionItem,
      hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
      reminderCandidate: conversationState?.styleHints.reminderCandidate,
      responseStyle: 'short_direct',
    });
  }

  if (action === 'say_more') {
    return buildAlexaCompanionConversationState({
      flowKey: conversationState?.flowKey || 'followup',
      subjectKind: conversationState?.subjectKind || 'general',
      summaryText:
        conversationState?.summaryText || 'recent assistant context',
      guidanceGoal:
        conversationState?.styleHints.guidanceGoal || 'daily_brief',
      subjectData: {
        ...(conversationState?.subjectData || {}),
        ...nextVoiceMetadata,
      },
      supportedFollowups:
        conversationState?.supportedFollowups ||
        baseFollowupsForSubject('general'),
      prioritizationLens:
        conversationState?.styleHints.prioritizationLens || 'general',
      hasActionItem: conversationState?.styleHints.hasActionItem,
      hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
      reminderCandidate: conversationState?.styleHints.reminderCandidate,
      responseStyle: 'expanded',
    });
  }

  if (action === 'switch_person') {
    return buildAlexaCompanionConversationState({
      flowKey: 'person_followup',
      subjectKind: 'person',
      summaryText: `follow-up about ${personName || 'that person'}`,
      guidanceGoal:
        conversationState?.subjectKind === 'household' ||
        conversationState?.styleHints.guidanceGoal === 'family_guidance'
          ? 'family_guidance'
          : 'shared_plans',
      subjectData: {
        ...(conversationState?.subjectData || {}),
        personName,
        activePeople: personName ? [personName] : undefined,
        activeSubjectLabel: personName || 'that person',
        ...nextVoiceMetadata,
      },
      prioritizationLens: 'family',
      hasActionItem: true,
      hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
      reminderCandidate: conversationState?.styleHints.reminderCandidate,
    });
  }

  return buildAlexaCompanionConversationState({
    flowKey: conversationState?.flowKey || 'followup',
    subjectKind: conversationState?.subjectKind || 'general',
    summaryText:
      conversationState?.summaryText || 'recent assistant context',
    guidanceGoal:
      action === 'action_guidance'
        ? 'action_follow_through'
        : action === 'risk_check'
          ? 'risk_check'
          : action === 'memory_control'
            ? 'explainability'
            : conversationState?.styleHints.guidanceGoal || 'daily_brief',
    subjectData: {
      ...(conversationState?.subjectData || {}),
      activeSubjectLabel:
        conversationState?.subjectData.activeSubjectLabel ||
        conversationState?.subjectData.personName ||
        conversationState?.subjectData.threadTitle ||
        conversationState?.subjectData.conversationFocus ||
        conversationState?.subjectKind,
      ...nextVoiceMetadata,
    },
    supportedFollowups:
      conversationState?.supportedFollowups ||
      baseFollowupsForSubject('general'),
    prioritizationLens:
      conversationState?.styleHints.prioritizationLens || 'general',
    hasActionItem:
      action === 'action_guidance'
        ? true
        : conversationState?.styleHints.hasActionItem,
    hasRiskSignal:
      action === 'risk_check'
        ? true
        : conversationState?.styleHints.hasRiskSignal,
    reminderCandidate: conversationState?.styleHints.reminderCandidate,
    responseStyle:
      action === 'memory_control'
        ? 'short_direct'
        : conversationState?.styleHints.responseStyle,
  });
}

function baseFollowupsForSubject(
  subjectKind: AlexaConversationState['subjectKind'],
) : import('./types.js').AlexaConversationFollowupAction[] {
  const common: AlexaConversationState['supportedFollowups'] = [
    'anything_else',
    'shorter',
    'say_more',
    'memory_control',
    'delegation_control',
    'show_rules',
  ];

  switch (subjectKind) {
    case 'meeting':
      return [
        ...common,
        'before_that',
        'after_that',
        'remind_before_that',
        'draft_followup',
        'action_guidance',
        'risk_check',
        'save_that',
      ] as import('./types.js').AlexaConversationFollowupAction[];
    case 'person':
    case 'household':
      return [
        ...common,
        'switch_person',
        'action_guidance',
        'risk_check',
        'save_that',
      ] as import('./types.js').AlexaConversationFollowupAction[];
    case 'saved_item':
    case 'draft':
      return [
        ...common,
        'save_that',
        'action_guidance',
      ] as import('./types.js').AlexaConversationFollowupAction[];
    default:
      return [
        ...common,
        'after_that',
        'switch_person',
        'action_guidance',
        'risk_check',
        'save_that',
      ] as import('./types.js').AlexaConversationFollowupAction[];
  }
}

function joinAlexaSuggestedPhrases(suggestions: string[]): string {
  if (suggestions.length === 0) return '';
  if (suggestions.length === 1) return suggestions[0]!;
  if (suggestions.length === 2) {
    return `${suggestions[0]} or ${suggestions[1]}`;
  }
  return `${suggestions.slice(0, -1).join(', ')}, or ${suggestions.at(-1)}`;
}

function buildAlexaFallbackSuggestions(
  state: AlexaConversationState | undefined,
): string[] {
  const personName = state?.subjectData.personName?.trim().toLowerCase();
  const activePeople =
    state?.subjectData.activePeople?.map((value) => value.trim().toLowerCase()) ||
    [];
  const threadTitle = state?.subjectData.threadTitle?.trim().toLowerCase();

  const candaceFocused =
    personName === 'candace' ||
    activePeople.includes('candace') ||
    threadTitle?.includes('candace') === true ||
    state?.styleHints.prioritizationLens === 'family' ||
    state?.subjectKind === 'person' ||
    state?.subjectKind === 'household' ||
    state?.subjectKind === 'life_thread';

  if (candaceFocused) {
    return [
      "what's still open with Candace",
      'what should I remember tonight',
      'what am I forgetting',
    ];
  }

  if (
    state?.styleHints.guidanceGoal === 'evening_reset' ||
    state?.styleHints.prioritizationLens === 'evening'
  ) {
    return [
      'what should I remember tonight',
      'what am I forgetting',
      "what's still open with Candace",
    ];
  }

  return [
    'what am I forgetting',
    "what's still open with Candace",
    'what should I remember tonight',
  ];
}

function buildAlexaContextualFallbackPhrases(
  state: AlexaConversationState,
): string[] {
  const phrases: string[] = [];
  const personName = state.subjectData.personName?.trim();

  if (state.supportedFollowups.includes('say_more')) {
    phrases.push('say more');
  }
  if (state.supportedFollowups.includes('memory_control')) {
    phrases.push('ask why I said that');
  }

  if (personName) {
    phrases.push(`ask what's still open with ${personName}`);
  } else if (
    state.styleHints.guidanceGoal === 'evening_reset' ||
    state.styleHints.prioritizationLens === 'evening'
  ) {
    phrases.push('ask what you should remember tonight');
  } else if (
    state.supportedFollowups.includes('save_that') ||
    state.supportedFollowups.includes('save_for_later')
  ) {
    phrases.push('say save that for later');
  } else if (state.supportedFollowups.includes('anything_else')) {
    phrases.push('say anything else');
  }

  return [...new Set(phrases)];
}

function buildAlexaContextualFallbackRecovery(
  state: AlexaConversationState | undefined,
  fallbackCount: number,
): { speech: string; reprompt: string } | undefined {
  if (!state || fallbackCount > 1) return undefined;

  const hasStrongContext = Boolean(
    state.subjectData.personName?.trim() ||
      state.subjectData.threadTitle?.trim() ||
      state.subjectData.lastRecommendation?.trim() ||
      state.subjectData.pendingActionText?.trim() ||
      state.subjectData.lastAnswerSummary?.trim() ||
      state.subjectData.conversationFocus?.trim(),
  );
  if (!hasStrongContext) return undefined;

  const phrases = buildAlexaContextualFallbackPhrases(state);
  if (phrases.length === 0) return undefined;

  const anchor = state.subjectData.personName?.trim()
    ? `I am still with ${state.subjectData.personName.trim()}.`
    : state.styleHints.guidanceGoal === 'evening_reset' ||
        state.styleHints.prioritizationLens === 'evening'
      ? 'I am still on tonight.'
      : 'I am still on that last answer.';

  return {
    speech: `${anchor} If you mean the same thing, ${joinAlexaSuggestedPhrases(phrases.slice(0, 3))}.`,
    reprompt: `${joinAlexaSuggestedPhrases(phrases.slice(0, 2))}.`,
  };
}

function buildAlexaFallbackSpeechForState(
  assistantName: string,
  suggestions: string[],
  fallbackCount: number,
): string {
  if (fallbackCount >= 2) {
    return `This is ${assistantName}. I am still not quite getting it. Try asking ${suggestions[0]}.`;
  }
  return `This is ${assistantName}. I did not quite catch that. You can ask ${joinAlexaSuggestedPhrases(suggestions.slice(0, 3))}.`;
}

function buildAlexaFallbackRepromptForState(
  suggestions: string[],
  fallbackCount: number,
): string {
  if (fallbackCount >= 2) {
    return `Try asking ${suggestions[0]}.`;
  }
  return `You can ask ${joinAlexaSuggestedPhrases(suggestions.slice(0, 3))}.`;
}

function inferAlexaSubjectKindForUtterance(
  utterance: string,
  conversationState: AlexaConversationState | undefined,
): AlexaConversationState['subjectKind'] {
  const normalized = utterance.toLowerCase();
  const personName = extractFollowupPersonName(utterance);
  if (personName) return 'person';
  if (
    /\b(candace|travis|family|household|home)\b/.test(normalized) ||
    conversationState?.subjectKind === 'household'
  ) {
    return /\b(candace|travis)\b/.test(normalized) ? 'person' : 'household';
  }
  if (/\b(meeting|calendar|schedule|next|today|tonight|tomorrow)\b/.test(normalized)) {
    return 'day_brief';
  }
  return conversationState?.subjectKind || 'general';
}

function inferAlexaGuidanceGoalForUtterance(
  utterance: string,
  conversationState: AlexaConversationState | undefined,
): AlexaCompanionGuidanceGoal {
  const normalized = utterance.toLowerCase();
  if (/\b(candace|family|household|home)\b/.test(normalized)) {
    return /\b(candace)\b/.test(normalized) ? 'shared_plans' : 'family_guidance';
  }
  if (/\b(tonight|evening)\b/.test(normalized)) {
    return 'evening_reset';
  }
  if (/\b(forgetting|loose ends|still open)\b/.test(normalized)) {
    return 'what_am_i_forgetting';
  }
  if (/\b(next|after that|do about)\b/.test(normalized)) {
    return 'next_action';
  }
  return conversationState?.styleHints.guidanceGoal || 'open_conversation';
}

function buildAlexaBridgeConversationState(
  utterance: string,
  conversationState: AlexaConversationState | undefined,
  options: {
    intentFamily?: AlexaVoiceIntentFamily;
    routeOutcome?: string;
    clarifierHints?: string[];
  } = {},
): AlexaConversationState {
  const personName =
    extractFollowupPersonName(utterance) ||
    conversationState?.subjectData.personName;
  const subjectKind = inferAlexaSubjectKindForUtterance(
    utterance,
    conversationState,
  );
  return buildAlexaCompanionConversationState({
    flowKey: conversationState?.flowKey || 'open_conversation',
    subjectKind,
    summaryText:
      conversationState?.summaryText ||
      normalizeVoicePrompt(utterance) ||
      'the current Alexa conversation',
    guidanceGoal: inferAlexaGuidanceGoalForUtterance(
      utterance,
      conversationState,
    ),
    subjectData: {
      ...conversationState?.subjectData,
      personName,
      activePeople: personName
        ? [personName]
        : conversationState?.subjectData.activePeople,
      lastIntentFamily:
        options.intentFamily || conversationState?.subjectData.lastIntentFamily,
      lastRouteOutcome:
        options.routeOutcome ||
        conversationState?.subjectData.lastRouteOutcome ||
        'assistant_bridge',
      lastUserUtterance: normalizeVoicePrompt(utterance) || utterance,
      clarifierHints:
        options.clarifierHints || conversationState?.subjectData.clarifierHints,
      fallbackCount: 0,
      activeVoiceFamily:
        options.intentFamily ||
        conversationState?.subjectData.activeVoiceFamily ||
        conversationState?.subjectData.lastIntentFamily,
      activeVoiceAnchor:
        personName ||
        conversationState?.subjectData.activeVoiceAnchor ||
        conversationState?.subjectData.threadTitle ||
        conversationState?.subjectData.conversationFocus ||
        conversationState?.subjectKind,
      activeVoiceActionSummary:
        conversationState?.subjectData.pendingActionText ||
        conversationState?.subjectData.activeVoiceActionSummary ||
        conversationState?.subjectData.lastAnswerSummary ||
        normalizeVoicePrompt(utterance) ||
        utterance,
      activeSubjectLabel:
        personName ||
        conversationState?.subjectData.activeSubjectLabel ||
        conversationState?.subjectData.threadTitle ||
        conversationState?.subjectData.conversationFocus ||
        conversationState?.subjectKind,
      conversationFocus:
        personName ||
        conversationState?.subjectData.threadTitle ||
        conversationState?.subjectData.conversationFocus ||
        utterance,
    },
    supportedFollowups:
      conversationState?.supportedFollowups ||
      baseFollowupsForSubject(subjectKind),
    prioritizationLens:
      conversationState?.styleHints.prioritizationLens ||
      (subjectKind === 'person' || subjectKind === 'household'
        ? 'family'
        : 'general'),
    hasActionItem: true,
    hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
    reminderCandidate: conversationState?.styleHints.reminderCandidate,
    responseStyle: conversationState?.styleHints.responseStyle,
    responseSource: 'assistant_bridge',
  });
}

async function runLinkedAlexaTurn(
  handlerInput: HandlerInput,
  config: AlexaConfig,
  assistantName: string,
  principal: AlexaPrincipal,
  linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
  utterance: string,
  options: {
    conversationState?: AlexaConversationState;
    proactiveSignalText?: string;
  } = {},
) {
  try {
    const result = await runAlexaAssistantTurn(
      {
        utterance,
        principal: {
          ...principal,
          displayName: linked.account.displayName,
        },
        promptContext: options.conversationState
          ? {
              conversationSummary: options.conversationState.summaryText,
              conversationSubjectKind: options.conversationState.subjectKind,
              supportedFollowups: options.conversationState.supportedFollowups,
              channelMode:
                options.conversationState.styleHints.channelMode ||
                'alexa_companion',
              guidanceGoal: options.conversationState.styleHints.guidanceGoal,
              initiativeLevel:
                options.conversationState.styleHints.initiativeLevel ||
                'measured',
            }
          : undefined,
      },
      {
        assistantName,
        targetGroupFolder: linked.account.groupFolder,
        requireExistingTargetGroup: true,
      },
    );
    const speech =
      shapeAlexaSpeech(result.text) ||
      `${assistantName} is thinking, but the answer came back empty. Please try again.`;
    let finalSpeech = speech;
    let reprompt = DEFAULT_ALEXA_REPROMPT;

    if (options.conversationState) {
      const summaryText =
        speech.split(/(?<=[.!?])\s+/)[0]?.trim() ||
        options.conversationState.summaryText.trim() ||
        speech;
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        {
          ...options.conversationState,
          summaryText,
          subjectData: {
            ...options.conversationState.subjectData,
            fallbackCount: 0,
            lastRouteOutcome: 'assistant_bridge',
            lastUserUtterance:
              options.proactiveSignalText?.trim() ||
              options.conversationState.subjectData.lastUserUtterance,
            lastAnswerSummary: summaryText,
            lastRecommendation:
              options.conversationState.subjectData.lastRecommendation,
            pendingActionText:
              options.conversationState.subjectData.pendingActionText,
            conversationFocus:
              options.conversationState.subjectData.conversationFocus ||
              options.conversationState.subjectData.personName ||
              options.conversationState.subjectData.threadTitle ||
              options.conversationState.subjectKind,
            activeSubjectLabel:
              options.conversationState.subjectData.activeSubjectLabel ||
              options.conversationState.subjectData.personName ||
              options.conversationState.subjectData.threadTitle ||
              options.conversationState.subjectData.conversationFocus ||
              options.conversationState.subjectKind,
          },
          styleHints: {
            ...options.conversationState.styleHints,
            responseSource: 'assistant_bridge',
          },
        },
      );
    } else {
      clearAlexaConversationState(linked.principalKey);
    }

    const proactiveSignalText = options.proactiveSignalText?.trim() || '';
    if (proactiveSignalText) {
      const candidate = maybeCreateProactiveProfileCandidate({
        groupFolder: linked.account.groupFolder,
        chatJid: result.chatJid,
        channel: 'alexa',
        text: proactiveSignalText,
      });
      if (candidate) {
        saveAlexaPendingSession(
          linked.principalKey,
          linked.account.accessTokenHash,
          'confirm_profile_fact',
          {
            profileFactId: candidate.factId,
            profileAskText: candidate.askText,
          },
        );
        finalSpeech = `${speech} ${candidate.askText}`;
        reprompt = 'Say yes to keep it, or no to skip it.';
      }
    }

    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: 'bridge',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(finalSpeech)
      .reprompt(reprompt)
      .getResponse();
  } catch (err) {
    if (err instanceof AlexaTargetGroupMissingError) {
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'barrier',
        linked: true,
        groupFolder: err.groupFolder,
      });
      return buildBarrierResponse(
        handlerInput,
        buildSetupBarrier(assistantName, err.groupFolder),
      );
    }
    throw err;
  }
}

export function createAlexaSkill(
  config: AlexaConfig,
  deps: AlexaCompanionDeps = {},
): SkillLike {
  const assistantName = ASSISTANT_NAME;
  const helpSpeech = buildAlexaHelpSpeech(assistantName);
  const hasCompanionHandoffDeps = () =>
    Boolean(deps.resolveTelegramMainChat && deps.sendTelegramMessage);

  const resolveLinkedContext = (
    handlerInput: HandlerInput,
    principal: AlexaPrincipal,
  ) => {
    const linked = resolveAlexaLinkedAccount(principal, assistantName);
    if (!linked.ok) {
      return {
        ok: false as const,
        barrier: linked,
        response: buildBarrierResponse(handlerInput, linked),
      };
    }
    return { ok: true as const, linked };
  };

  const resolveOptionalLinkedContext = (principal: AlexaPrincipal) => {
    if (!principal.accessToken?.trim()) {
      return undefined;
    }
    const linked = resolveAlexaLinkedAccount(principal, assistantName);
    return linked.ok ? linked : undefined;
  };

  const saveLinkedConversationState = (
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    state: AlexaConversationState,
  ) =>
    saveAlexaConversationState(
      linked.principalKey,
      linked.account.accessTokenHash,
      linked.account.groupFolder,
      state,
    );

  const resolveReminderTargetChat = (groupFolder: string) => {
    if (!deps.resolveTelegramMainChat) return null;
    return deps.resolveTelegramMainChat(groupFolder);
  };

  const buildAlexaCalendarFailureSpeech = (
    action: 'create_event' | 'update_event' | 'confirm_reminder',
    error: unknown,
  ): string => {
    const detail = getUserFacingErrorDetail(error);
    const failureKind = classifyGoogleCalendarFailureDetail(detail);
    return buildCalendarCompanionFailureReply({
      channel: 'alexa',
      action: action === 'update_event' ? 'create_event' : action,
      kind: isGoogleCalendarAuthFailureKind(failureKind)
        ? 'calendar_auth_unavailable'
        : 'temporary_unavailable',
    });
  };

  const buildAlexaCalendarCreateChoiceSpeech = (
    state: PendingGoogleCalendarCreateState,
  ): string => {
    if (state.calendars.length === 2) {
      return `Which calendar should I use for ${state.draft.title}: ${state.calendars[0]!.summary} or ${state.calendars[1]!.summary}?`;
    }
    return `Which calendar should I use for ${state.draft.title}? Say the calendar name or number.`;
  };

  const buildAlexaCalendarActionPromptSpeech = (
    state: PendingGoogleCalendarEventActionState,
  ): string => {
      if (state.action === 'delete') {
        return `Do you want me to cancel ${state.sourceEvent.title} on ${formatAlexaCalendarWhen({
          startIso: state.sourceEvent.startIso,
          endIso: state.sourceEvent.endIso,
          allDay: state.sourceEvent.allDay,
        })}?`;
      }
    if (state.step === 'choose_calendar') {
      if (state.calendars.length === 2) {
        return `Which calendar should I move ${state.sourceEvent.title} to: ${state.calendars[0]!.summary} or ${state.calendars[1]!.summary}?`;
      }
      return `Which calendar should I move ${state.sourceEvent.title} to? Say the calendar name or number.`;
    }
    return shapeAlexaSpeech(
      formatPendingGoogleCalendarEventActionPrompt(state),
    );
  };

  const applyAlexaReminderCreation = (
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    conversationState: AlexaConversationState | undefined,
    reminderBody: string,
    timingText: string,
    now: Date,
  ) => {
    const target = resolveReminderTargetChat(linked.account.groupFolder);
    if (!target?.chatJid) {
      return {
        handled: true as const,
        speech:
          'I can save reminders once your main Telegram chat is set up for this account.',
      };
    }

    const plannedReminder = planContextualReminder(
      timingText,
      reminderBody,
      linked.account.groupFolder,
      target.chatJid,
      now,
    );
    if (!plannedReminder) {
      return {
        handled: true as const,
        speech:
          'Tell me when, like today at 4, tomorrow morning, or tonight.',
      };
    }

    createTask(plannedReminder.task);
    syncOutcomeFromReminderTask(plannedReminder.task, {
      linkedRefs: {
        reminderTaskId: plannedReminder.task.id,
        threadId: conversationState?.subjectData.threadId,
        communicationThreadId:
          conversationState?.subjectData.communicationThreadId,
        missionId: conversationState?.subjectData.missionId,
      },
      summaryText: plannedReminder.confirmation,
      now,
    });

    const speech =
      shapeAlexaSpeech(plannedReminder.confirmation) ||
      plannedReminder.confirmation;
    const nextState = buildAlexaAssistantTaskState({
      previousState: conversationState,
      flowKey: 'assistant_reminder_write',
      subjectKind: conversationState?.subjectKind || 'saved_item',
      summaryText: reminderBody,
      guidanceGoal: 'action_follow_through',
      taskKind: 'reminder_write',
      taskSummary: reminderBody,
      entityLabel:
        conversationState?.subjectData.activeEntityLabel ||
        conversationState?.subjectData.personName ||
        reminderBody,
      dateTimeContext: timingText,
      pendingWriteAction: undefined,
      pendingReminderBody: null,
      subjectData: clearAlexaAssistantPendingState(conversationState),
      supportedFollowups: ['anything_else', 'shorter', 'say_more'],
      hasActionItem: true,
      reminderCandidate: true,
    });
    saveLinkedConversationState(linked, nextState);
    return { handled: true as const, speech };
  };

  const resolveAlexaEventContextFromUtterance = async (
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    utterance: string,
    now: Date,
  ): Promise<
    | { kind: 'resolved'; context: ActiveGoogleCalendarEventContextState }
    | { kind: 'missing'; speech: string }
    | { kind: 'ambiguous'; speech: string }
    | { kind: 'none' }
  > => {
    const queryText = extractAlexaEventLookupQuery(utterance);
    if (!queryText) return { kind: 'none' };
    const googleConfig = resolveGoogleCalendarConfig();
    const window = resolveAlexaEventSearchWindow(utterance, now);
    const { events } = await listGoogleCalendarEvents(
      {
        start: window.start,
        end: window.end,
        calendarIds: googleConfig.calendarIds,
      },
      googleConfig,
    );
    const matches = matchGoogleCalendarTrackedEvents(events, queryText);
    if (matches.length === 1) {
      return {
        kind: 'resolved',
        context: buildActiveGoogleCalendarEventContextState(matches[0], now),
      };
    }
    if (matches.length === 0) {
      return {
        kind: 'missing',
        speech: `I could not find a calendar event matching ${queryText}.`,
      };
    }
    return {
      kind: 'ambiguous',
      speech: `I found more than one event matching ${queryText}. Tell me which one you mean.`,
    };
  };

  const toAlexaActiveEventContextState = (
    event: CalendarActiveEventContext | GoogleCalendarEventRecord | null | undefined,
    now: Date,
  ): ActiveGoogleCalendarEventContextState | null => {
    if (!event?.calendarId) return null;
    return buildActiveGoogleCalendarEventContextState(
      {
        id: event.id,
        title: event.title,
        startIso: event.startIso,
        endIso: event.endIso,
        allDay: event.allDay,
        calendarId: event.calendarId,
        calendarName: event.calendarName || 'Google Calendar',
        htmlLink: event.htmlLink || null,
      },
      now,
    );
  };

  const buildAlexaCalendarReadState = (input: {
    previousState?: AlexaConversationState;
    utterance: string;
    speech: string;
    activeEventContext?: CalendarActiveEventContext | null;
    schedulingContext?: { title: string; durationMinutes: number; timeZone: string } | null;
    now: Date;
  }): AlexaConversationState =>
    buildAlexaAssistantTaskState({
      previousState: input.previousState,
      flowKey: 'assistant_calendar_read',
      subjectKind: input.activeEventContext ? 'event' : 'day_brief',
      summaryText: input.speech,
      guidanceGoal: /\btomorrow\b/i.test(input.utterance)
        ? 'tomorrow_brief'
        : /\btonight\b/i.test(input.utterance)
          ? 'evening_reset'
          : 'daily_brief',
      taskKind: 'calendar_read',
      taskSummary: input.speech,
      entityLabel:
        input.activeEventContext?.title ||
        input.previousState?.subjectData.activeEntityLabel,
      dateTimeContext: input.utterance,
      activeEventContext: toAlexaActiveEventContextState(
        input.activeEventContext,
        input.now,
      ),
      schedulingContext: input.schedulingContext
        ? {
            version: 1,
            createdAt: input.now.toISOString(),
            title: input.schedulingContext.title,
            durationMinutes: input.schedulingContext.durationMinutes,
            timeZone: input.schedulingContext.timeZone,
          }
        : null,
      subjectData: clearAlexaAssistantPendingState(input.previousState),
      supportedFollowups: ['anything_else', 'shorter', 'say_more'],
      prioritizationLens: 'calendar',
      hasActionItem: true,
      reminderCandidate: true,
    });

  const buildAlexaAssistantCandidates = (input: {
    primarySlotValue?: string;
    voiceCapture?: ReturnType<typeof extractAlexaVoiceIntentCapture> | null;
    slotValues: Record<string, string>;
  }): string[] => {
    const guidanceText = input.slotValues.guidanceText || '';
    const guidanceLooksCalendarish =
      /\b(?:calendar|schedule)\b/i.test(guidanceText) ||
      /^(?:today|tomorrow|tonight|this morning|this afternoon|this evening|this weekend|this week)\b/i.test(
        guidanceText.trim(),
      );
    const candidates = [
      input.primarySlotValue,
      input.voiceCapture?.preferredText,
      ...(input.voiceCapture?.candidateTexts || []),
      input.slotValues.calendarReadText
        ? `what is on my calendar ${input.slotValues.calendarReadText}`
        : '',
      input.slotValues.calendarReadText
        ? `what do I have ${input.slotValues.calendarReadText}`
        : '',
      input.slotValues.guidanceText
        && guidanceLooksCalendarish
        ? `what do I have ${input.slotValues.guidanceText}`
        : '',
      input.slotValues.guidanceText
        && guidanceLooksCalendarish
        ? `what is on my calendar ${input.slotValues.guidanceText}`
        : '',
      input.slotValues.calendarCreateText
        ? `add ${input.slotValues.calendarCreateText}`
        : '',
      input.slotValues.calendarCreateText
        ? `schedule ${input.slotValues.calendarCreateText}`
        : '',
      input.slotValues.calendarCreateText
        ? `put ${input.slotValues.calendarCreateText} on my calendar`
        : '',
      input.slotValues.calendarMoveText
        ? `move ${input.slotValues.calendarMoveText}`
        : '',
      input.slotValues.calendarMoveText
        ? `reschedule ${input.slotValues.calendarMoveText}`
        : '',
      input.slotValues.calendarCancelText
        ? `cancel ${input.slotValues.calendarCancelText}`
        : '',
      input.slotValues.calendarCancelText
        ? `delete ${input.slotValues.calendarCancelText}`
        : '',
      input.slotValues.reminderText
        ? `remind me ${input.slotValues.reminderText}`
        : '',
      input.slotValues.reminderText
        ? `remind me to ${input.slotValues.reminderText}`
        : '',
      input.slotValues.reminderText
        ? `remind me at ${input.slotValues.reminderText}`
        : '',
      input.slotValues.reminderText
        ? `remind me about ${input.slotValues.reminderText}`
        : '',
    ];
    const seen = new Set<string>();
    return candidates
      .map((value) => normalizeVoicePrompt(value || '').trim())
      .filter(Boolean)
      .filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  const executeAlexaCalendarCreate = async (input: {
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>;
    conversationState?: AlexaConversationState;
    draft: PendingGoogleCalendarCreateState['draft'];
    calendarId: string;
    calendars: GoogleCalendarMetadata[];
    now: Date;
  }): Promise<{ speech: string }> => {
    const googleConfig = resolveGoogleCalendarConfig();
    const created = await createGoogleCalendarEvent(
      {
        calendarId: input.calendarId,
        title: input.draft.title,
        start: new Date(input.draft.startIso),
        end: new Date(input.draft.endIso),
        timeZone: input.draft.timeZone,
        allDay: input.draft.allDay,
        location: input.draft.location || null,
        description: input.draft.description || null,
      },
      googleConfig,
    );
    const calendarName =
      input.calendars.find((calendar) => calendar.id === input.calendarId)?.summary ||
      created.calendarName;
    const speech =
      shapeAlexaSpeech(
        buildCalendarCompanionEventReply({
          action: 'create_event',
          title: created.title,
          startIso: created.startIso,
          endIso: created.endIso,
          allDay: created.allDay,
          timeZone: TIMEZONE,
          calendarName,
          htmlLink: created.htmlLink || null,
        }),
      ) || `I added ${created.title} to your calendar.`;
    saveLinkedConversationState(
      input.linked,
      buildAlexaAssistantTaskState({
        previousState: input.conversationState,
        flowKey: 'assistant_calendar_write',
        subjectKind: 'event',
        summaryText: speech,
        guidanceGoal: 'action_follow_through',
        taskKind: 'calendar_write',
        taskSummary: `Added ${created.title}`,
        entityLabel: created.title,
        dateTimeContext: formatAlexaCalendarWhen(created),
        activeEventContext: toAlexaActiveEventContextState(created, input.now),
        schedulingContext: buildGoogleCalendarSchedulingContextState({
          draft: input.draft,
          now: input.now,
        }),
        subjectData: clearAlexaAssistantPendingState(input.conversationState),
        supportedFollowups: ['anything_else', 'shorter', 'say_more'],
        prioritizationLens: 'calendar',
        hasActionItem: true,
        reminderCandidate: true,
      }),
    );
    return { speech };
  };

  const executeAlexaCalendarEventAction = async (input: {
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>;
    conversationState?: AlexaConversationState;
    state: PendingGoogleCalendarEventActionState;
    now: Date;
  }): Promise<{ speech: string }> => {
    const googleConfig = resolveGoogleCalendarConfig();
    if (input.state.action === 'delete') {
      await deleteGoogleCalendarEvent(
        {
          calendarId: input.state.sourceEvent.calendarId,
          eventId: input.state.sourceEvent.id,
        },
        googleConfig,
      );
      const speech = `Okay, I canceled ${input.state.sourceEvent.title}.`;
      saveLinkedConversationState(
        input.linked,
        buildAlexaAssistantTaskState({
          previousState: input.conversationState,
          flowKey: 'assistant_calendar_cancel',
          subjectKind: 'event',
          summaryText: speech,
          guidanceGoal: 'action_follow_through',
          taskKind: 'calendar_cancel',
          taskSummary: `Canceled ${input.state.sourceEvent.title}`,
          entityLabel: input.state.sourceEvent.title,
          subjectData: clearAlexaAssistantPendingState(input.conversationState),
          supportedFollowups: ['anything_else', 'shorter'],
          prioritizationLens: 'calendar',
          hasActionItem: true,
          reminderCandidate: false,
        }),
      );
      return { speech };
    }

    let updatedEvent: GoogleCalendarEventRecord;
    if (input.state.action === 'reassign') {
      updatedEvent = await moveGoogleCalendarEvent(
        {
          sourceCalendarId: input.state.sourceEvent.calendarId,
          destinationCalendarId:
            input.state.selectedCalendarId || input.state.sourceEvent.calendarId,
          eventId: input.state.sourceEvent.id,
        },
        googleConfig,
      );
    } else {
      const targetEvent = input.state.proposedEvent || input.state.sourceEvent;
      updatedEvent = await updateGoogleCalendarEvent(
        {
          calendarId: input.state.sourceEvent.calendarId,
          eventId: input.state.sourceEvent.id,
          start: new Date(targetEvent.startIso),
          end: new Date(targetEvent.endIso),
          timeZone: TIMEZONE,
          allDay: targetEvent.allDay,
        },
        googleConfig,
      );
    }

    const speech =
      shapeAlexaSpeech(
        buildCalendarCompanionEventReply({
          action: 'update_event',
          title: updatedEvent.title,
          startIso: updatedEvent.startIso,
          endIso: updatedEvent.endIso,
          allDay: updatedEvent.allDay,
          timeZone: TIMEZONE,
          calendarName: updatedEvent.calendarName,
          htmlLink: updatedEvent.htmlLink || null,
        }),
      ) || `Okay, I updated ${updatedEvent.title}.`;
    saveLinkedConversationState(
      input.linked,
      buildAlexaAssistantTaskState({
        previousState: input.conversationState,
        flowKey: 'assistant_calendar_update',
        subjectKind: 'event',
        summaryText: speech,
        guidanceGoal: 'action_follow_through',
        taskKind:
          input.state.action === 'move' || input.state.action === 'resize'
            ? 'calendar_move'
            : 'calendar_write',
        taskSummary: `Updated ${updatedEvent.title}`,
        entityLabel: updatedEvent.title,
        dateTimeContext: formatAlexaCalendarWhen(updatedEvent),
        activeEventContext: toAlexaActiveEventContextState(updatedEvent, input.now),
        subjectData: clearAlexaAssistantPendingState(input.conversationState),
        supportedFollowups: ['anything_else', 'shorter', 'say_more'],
        prioritizationLens: 'calendar',
        hasActionItem: true,
        reminderCandidate: true,
      }),
    );
    return { speech };
  };

  const maybeHandleAlexaAssistantTaskTurn = async (input: {
    handlerInput: HandlerInput;
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>;
    intentName: string;
    slotValues: Record<string, string>;
    primarySlotValue?: string;
    conversationState?: AlexaConversationState;
    voiceCapture?: ReturnType<typeof extractAlexaVoiceIntentCapture> | null;
  }): Promise<{ speech: string; reprompt?: string } | undefined> => {
    const now = getRequestTimestampDate(input.handlerInput.requestEnvelope);
    const assistantCandidates = buildAlexaAssistantCandidates({
      primarySlotValue: input.primarySlotValue,
      voiceCapture: input.voiceCapture,
      slotValues: input.slotValues,
    });
    const activeEventContext = parseAlexaActiveEventContext(
      input.conversationState,
      now,
    );
    const schedulingContext = parseAlexaSchedulingContext(input.conversationState);
    const pendingCreate = parseAlexaPendingCalendarCreate(input.conversationState);
    const pendingEventAction = parseAlexaPendingCalendarEventAction(
      input.conversationState,
      now,
    );
    const pendingReminderBody =
      input.conversationState?.subjectData.pendingReminderBody?.trim() || undefined;

    const persistPendingCreate = (
      state: PendingGoogleCalendarCreateState,
      speech: string,
    ) => {
      saveLinkedConversationState(
        input.linked,
        buildAlexaAssistantTaskState({
          previousState: input.conversationState,
          flowKey: 'assistant_calendar_write',
          subjectKind: 'event',
          summaryText: speech,
          guidanceGoal: 'action_follow_through',
          taskKind: 'calendar_write',
          taskSummary: state.draft.title,
          entityLabel: state.draft.title,
          dateTimeContext: formatAlexaCalendarWhen({
            startIso: state.draft.startIso,
            endIso: state.draft.endIso,
            allDay: state.draft.allDay,
          }),
          schedulingContext: buildGoogleCalendarSchedulingContextState({
            draft: state.draft,
            now,
          }),
          pendingCreateState: state,
          pendingWriteAction: 'create_event',
          subjectData: clearAlexaAssistantPendingState(input.conversationState),
          supportedFollowups: ['anything_else', 'shorter'],
          prioritizationLens: 'calendar',
          hasActionItem: true,
          reminderCandidate: true,
        }),
      );
    };

    const persistPendingEventAction = (
      state: PendingGoogleCalendarEventActionState,
      speech: string,
    ) => {
      saveLinkedConversationState(
        input.linked,
        buildAlexaAssistantTaskState({
          previousState: input.conversationState,
          flowKey:
            state.action === 'delete'
              ? 'assistant_calendar_cancel'
              : 'assistant_calendar_update',
          subjectKind: 'event',
          summaryText: speech,
          guidanceGoal: 'action_follow_through',
          taskKind:
            state.action === 'delete' ? 'calendar_cancel' : 'calendar_move',
          taskSummary: state.sourceEvent.title,
          entityLabel: state.sourceEvent.title,
          dateTimeContext: formatAlexaCalendarWhen(state.sourceEvent),
          activeEventContext: toAlexaActiveEventContextState(
            state.sourceEvent,
            now,
          ),
          pendingEventActionState: state,
          pendingWriteAction:
            state.action === 'delete' ? 'delete_event' : 'update_event',
          subjectData: clearAlexaAssistantPendingState(input.conversationState),
          supportedFollowups: ['anything_else', 'shorter'],
          prioritizationLens: 'calendar',
          hasActionItem: true,
          reminderCandidate: state.action !== 'delete',
        }),
      );
    };

    if (pendingReminderBody) {
      for (const candidate of assistantCandidates) {
        const timing = extractAlexaReminderTiming(candidate);
        if (!timing) continue;
        return applyAlexaReminderCreation(
          input.linked,
          input.conversationState,
          pendingReminderBody,
          timing,
          now,
        );
      }
    }

    if (pendingCreate) {
      for (const candidate of assistantCandidates) {
        const continued = advancePendingGoogleCalendarCreate(candidate, pendingCreate);
        if (continued.kind === 'no_match') continue;
        if (continued.kind === 'cancelled') {
          saveLinkedConversationState(
            input.linked,
            buildAlexaAssistantTaskState({
              previousState: input.conversationState,
              flowKey: 'assistant_calendar_write',
              subjectKind: 'event',
              summaryText: continued.message,
              guidanceGoal: 'action_follow_through',
              taskKind: 'calendar_write',
              taskSummary: pendingCreate.draft.title,
              entityLabel: pendingCreate.draft.title,
              subjectData: clearAlexaAssistantPendingState(input.conversationState),
              supportedFollowups: ['anything_else'],
              prioritizationLens: 'calendar',
            }),
          );
          return { speech: continued.message };
        }
        if (continued.kind === 'resolve_anchor') {
          return {
            speech:
              'Tell me the time you want instead, like tomorrow at 7 or tomorrow morning.',
          };
        }
        if (continued.kind === 'confirmed') {
          return executeAlexaCalendarCreate({
            linked: input.linked,
            conversationState: input.conversationState,
            draft: continued.state.draft,
            calendarId: continued.calendarId,
            calendars: continued.state.calendars.map((calendar) => ({
              ...calendar,
              accessRole: 'owner',
              writable: true,
              selected: true,
            })),
            now,
          });
        }
        if (
          pendingCreate.step === 'choose_calendar' &&
          continued.state.step === 'confirm_create' &&
          continued.state.selectedCalendarId
        ) {
          return executeAlexaCalendarCreate({
            linked: input.linked,
            conversationState: input.conversationState,
            draft: continued.state.draft,
            calendarId: continued.state.selectedCalendarId,
            calendars: continued.state.calendars.map((calendar) => ({
              ...calendar,
              accessRole: 'owner',
              writable: true,
              selected: true,
            })),
            now,
          });
        }
        const speech =
          continued.state.step === 'choose_calendar'
            ? buildAlexaCalendarCreateChoiceSpeech(continued.state)
            : shapeAlexaSpeech(continued.message) || continued.message;
        persistPendingCreate(continued.state, speech);
        return { speech };
      }
    }

    if (pendingEventAction) {
      for (const candidate of assistantCandidates) {
        const continued = advancePendingGoogleCalendarEventAction(
          candidate,
          pendingEventAction,
          now,
        );
        if (continued.kind === 'no_match') continue;
        if (continued.kind === 'cancelled') {
          saveLinkedConversationState(
            input.linked,
            buildAlexaAssistantTaskState({
              previousState: input.conversationState,
              flowKey: 'assistant_calendar_update',
              subjectKind: 'event',
              summaryText: continued.message,
              guidanceGoal: 'action_follow_through',
              taskKind:
                pendingEventAction.action === 'delete'
                  ? 'calendar_cancel'
                  : 'calendar_move',
              taskSummary: pendingEventAction.sourceEvent.title,
              entityLabel: pendingEventAction.sourceEvent.title,
              activeEventContext: toAlexaActiveEventContextState(
                pendingEventAction.sourceEvent,
                now,
              ),
              subjectData: clearAlexaAssistantPendingState(input.conversationState),
              supportedFollowups: ['anything_else'],
              prioritizationLens: 'calendar',
            }),
          );
          return { speech: continued.message };
        }
        if (continued.kind === 'resolve_anchor') {
          return {
            speech:
              'Tell me the time you want instead, like move it to tomorrow at 7.',
          };
        }
        if (continued.kind === 'confirmed') {
          return executeAlexaCalendarEventAction({
            linked: input.linked,
            conversationState: input.conversationState,
            state: continued.state,
            now,
          });
        }
        if (
          continued.state.action !== 'delete' &&
          pendingEventAction.step === 'choose_calendar' &&
          continued.state.step === 'confirm'
        ) {
          return executeAlexaCalendarEventAction({
            linked: input.linked,
            conversationState: input.conversationState,
            state: continued.state,
            now,
          });
        }
        const speech = buildAlexaCalendarActionPromptSpeech(continued.state);
        persistPendingEventAction(continued.state, speech);
        return { speech };
      }
    }

    for (const candidate of assistantCandidates) {
      const reminderRequest = parseDirectAlexaReminderRequest({
        utterance: candidate,
        state: input.conversationState,
      });
      if (!reminderRequest) continue;
      if (!reminderRequest.reminderBody) {
        return { speech: 'What should I remind you about?' };
      }
      if (reminderRequest.timingText) {
        return applyAlexaReminderCreation(
          input.linked,
          input.conversationState,
          reminderRequest.reminderBody,
          reminderRequest.timingText,
          now,
        );
      }
      if (reminderRequest.needsTiming) {
        const speech = buildAlexaReminderPrompt(
          reminderRequest.reminderBody,
          input.conversationState,
        );
        saveLinkedConversationState(
          input.linked,
          buildAlexaAssistantTaskState({
            previousState: input.conversationState,
            flowKey: 'assistant_reminder_write',
            subjectKind: input.conversationState?.subjectKind || 'saved_item',
            summaryText: reminderRequest.reminderBody,
            guidanceGoal: 'action_follow_through',
            taskKind: 'reminder_write',
            taskSummary: reminderRequest.reminderBody,
            entityLabel:
              input.conversationState?.subjectData.activeEntityLabel ||
              input.conversationState?.subjectData.personName ||
              reminderRequest.reminderBody,
            pendingWriteAction: 'create_reminder',
            pendingReminderBody: reminderRequest.reminderBody,
            subjectData: clearAlexaAssistantPendingState(input.conversationState),
            supportedFollowups: ['anything_else', 'shorter'],
            prioritizationLens: 'general',
            hasActionItem: true,
            reminderCandidate: true,
          }),
        );
        return { speech };
      }
      return { speech: 'Tell me when, like today at 4 or tomorrow morning.' };
    }

    for (const candidate of assistantCandidates) {
      if (!looksLikeAlexaCalendarReadRequest(candidate)) {
        continue;
      }
      const response = await buildCalendarAssistantResponse(candidate, {
        now,
        timeZone: TIMEZONE,
        activeEventContext: activeEventContext?.event
          ? {
              providerId: 'google_calendar',
              id: activeEventContext.event.id,
              title: activeEventContext.event.title,
              startIso: activeEventContext.event.startIso,
              endIso: activeEventContext.event.endIso,
              allDay: activeEventContext.event.allDay,
              calendarId: activeEventContext.event.calendarId,
              calendarName: activeEventContext.event.calendarName,
              htmlLink: activeEventContext.event.htmlLink || null,
            }
          : null,
      });
      if (!response) continue;
      const speech = shapeAlexaSpeech(response.reply) || response.reply;
      saveLinkedConversationState(
        input.linked,
        buildAlexaCalendarReadState({
          previousState: input.conversationState,
          utterance: candidate,
          speech,
          activeEventContext: response.activeEventContext,
          schedulingContext: response.schedulingContext,
          now,
        }),
      );
      return { speech };
    }

    let discoveredCalendars: GoogleCalendarMetadata[] | undefined;
    let writableCalendars: GoogleCalendarMetadata[] | undefined;
    const loadCalendars = async () => {
      if (!discoveredCalendars) {
        const googleConfig = resolveGoogleCalendarConfig();
        discoveredCalendars = await listGoogleCalendars(googleConfig);
        writableCalendars = discoveredCalendars.filter(
          (calendar) => calendar.selected && calendar.writable,
        );
      }
      return {
        discoveredCalendars: discoveredCalendars || [],
        writableCalendars: writableCalendars || [],
      };
    };

    for (const candidate of assistantCandidates) {
      if (!isExplicitGoogleCalendarCreateRequest(candidate)) continue;
      try {
        const calendars = await loadCalendars();
        const createPlan = planGoogleCalendarCreate(
          candidate,
          calendars.writableCalendars,
          now,
          TIMEZONE,
          schedulingContext,
        );
        if (createPlan.kind === 'none') continue;
        if (createPlan.kind === 'needs_details') {
          return { speech: shapeAlexaSpeech(createPlan.message) || createPlan.message };
        }
        if (calendars.writableCalendars.length === 0) {
          return {
            speech: buildAlexaCalendarFailureSpeech('create_event', new Error('calendar auth unavailable')),
          };
        }
        const selectedCalendarId =
          createPlan.selectedCalendarId ||
          (calendars.writableCalendars.length === 1
            ? calendars.writableCalendars[0]?.id
            : null);
        if (selectedCalendarId) {
          return executeAlexaCalendarCreate({
            linked: input.linked,
            conversationState: input.conversationState,
            draft: createPlan.draft,
            calendarId: selectedCalendarId,
            calendars: calendars.writableCalendars,
            now,
          });
        }
        const pendingState = buildPendingGoogleCalendarCreateState({
          draft: createPlan.draft,
          writableCalendars: calendars.writableCalendars,
          selectedCalendarId: createPlan.selectedCalendarId,
          now,
        });
        const speech = buildAlexaCalendarCreateChoiceSpeech(pendingState);
        persistPendingCreate(pendingState, speech);
        return { speech };
      } catch (error) {
        return { speech: buildAlexaCalendarFailureSpeech('create_event', error) };
      }
    }

    for (const candidate of assistantCandidates) {
      if (!/\b(?:move|reschedule|cancel|delete|remove)\b/i.test(candidate)) {
        continue;
      }
      try {
        const calendars = await loadCalendars();
        let resolvedContext = activeEventContext;
        if (!resolvedContext) {
          const lookup = await resolveAlexaEventContextFromUtterance(
            input.linked,
            candidate,
            now,
          );
          if (lookup.kind === 'missing' || lookup.kind === 'ambiguous') {
            return { speech: lookup.speech };
          }
          resolvedContext = lookup.kind === 'resolved' ? lookup.context : undefined;
        }
        const actionPlan = planGoogleCalendarEventAction(
          candidate,
          calendars.discoveredCalendars,
          now,
          resolvedContext,
        );
        if (actionPlan.kind === 'none') continue;
        if (actionPlan.kind === 'needs_event_context') {
          return { speech: actionPlan.message };
        }
        if (actionPlan.kind === 'resolve_anchor') {
          return {
            speech:
              'Tell me the new time directly, like move dinner to tomorrow at 7.',
          };
        }
        if (actionPlan.state.action === 'delete') {
          const speech = buildAlexaCalendarActionPromptSpeech(actionPlan.state);
          persistPendingEventAction(actionPlan.state, speech);
          return { speech };
        }
        if (
          actionPlan.state.step === 'confirm' &&
          (actionPlan.state.action === 'move' ||
            actionPlan.state.action === 'resize' ||
            actionPlan.state.action === 'reassign')
        ) {
          return executeAlexaCalendarEventAction({
            linked: input.linked,
            conversationState: input.conversationState,
            state: actionPlan.state,
            now,
          });
        }
        const speech = buildAlexaCalendarActionPromptSpeech(actionPlan.state);
        persistPendingEventAction(actionPlan.state, speech);
        return { speech };
      } catch (error) {
        return { speech: buildAlexaCalendarFailureSpeech('update_event', error) };
      }
    }

    return undefined;
  };

  const respondWithAlexaFallback = (handlerInput: HandlerInput) => {
    const principal = extractPrincipal(handlerInput.requestEnvelope);
    const linked = resolveOptionalLinkedContext(principal);
    const conversationState = linked
      ? loadAlexaConversationState(
          linked.principalKey,
          linked.account.accessTokenHash,
        )
      : undefined;
    const nextFallbackCount =
      Math.max(0, conversationState?.subjectData.fallbackCount || 0) + 1;
    const suggestions = buildAlexaFallbackSuggestions(conversationState);
    const contextualRecovery = buildAlexaContextualFallbackRecovery(
      conversationState,
      nextFallbackCount,
    );
    const speech =
      contextualRecovery?.speech ||
      buildAlexaFallbackSpeechForState(
        assistantName,
        suggestions,
        nextFallbackCount,
      );
    const reprompt =
      contextualRecovery?.reprompt ||
      buildAlexaFallbackRepromptForState(suggestions, nextFallbackCount);

    if (linked) {
      const nextState =
        conversationState ||
        buildAlexaCompanionConversationState({
          flowKey: 'launch_fallback',
          subjectKind: 'general',
          summaryText: 'the start of this Alexa conversation',
          guidanceGoal: 'daily_brief',
        });
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        {
          ...nextState,
          subjectData: {
            ...nextState.subjectData,
            fallbackCount: nextFallbackCount,
          },
        },
      );
    }

    logger.info(
      {
        requestId: handlerInput.requestEnvelope.request.requestId,
        requestType: getRequestType(handlerInput.requestEnvelope),
        intentName:
          getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            ? getIntentName(handlerInput.requestEnvelope)
            : undefined,
        groupFolder: linked?.account.groupFolder,
        responseSource: 'fallback',
        fallbackCount: nextFallbackCount,
        suggestions,
      },
      'Alexa fallback answered with targeted suggestions',
    );

    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: 'fallback',
      linked: Boolean(linked),
      groupFolder: linked?.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(linked ? speech : buildAlexaFallbackSpeech(assistantName))
      .reprompt(linked ? reprompt : DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const respondWithLocalCompanion = (
    handlerInput: HandlerInput,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    conversationState: AlexaConversationState,
    response: NonNullable<Awaited<ReturnType<typeof buildDailyCompanionResponse>>>,
  ) => {
    const speech =
      shapeAlexaSpeech(response.reply) ||
      response.reply ||
      `${assistantName} is thinking, but the answer came back empty.`;
    const nextState = buildAlexaStateFromDailyCompanion(
      conversationState,
      response,
    );
    saveAlexaConversationState(
      linked.principalKey,
      linked.account.accessTokenHash,
      linked.account.groupFolder,
      nextState,
    );
    logger.info(
      {
        requestId: handlerInput.requestEnvelope.request.requestId,
        requestType: getRequestType(handlerInput.requestEnvelope),
        intentName:
          getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            ? getIntentName(handlerInput.requestEnvelope)
            : undefined,
        groupFolder: linked.account.groupFolder,
        mode: response.mode,
        leadReason: response.leadReason,
        signalsUsed: response.signalsUsed,
        usedThreadTitles: response.context.usedThreadTitles,
        responseSource: 'local_companion',
      },
      'Alexa daily companion answered locally',
    );
    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: 'local_companion',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(speech)
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const respondWithOutcomeReview = (
    handlerInput: HandlerInput,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    conversationState: AlexaConversationState | undefined,
    match: OutcomeReviewPromptMatch,
    now = new Date(),
  ) => {
    const presentation = buildOutcomeReviewResponse({
      groupFolder: linked.account.groupFolder,
      match,
      channel: 'alexa',
      now,
    });
    const nextState = buildAlexaCompanionConversationState({
      flowKey: `outcome_review_${match.kind}`,
      subjectKind:
        match.kind === 'still_open_person' ? 'person' : 'day_brief',
      summaryText:
        conversationState?.summaryText ||
        presentation.summaryText ||
        'review and follow-through',
      guidanceGoal:
        match.kind === 'weekly_review' || match.kind === 'review_weekend'
          ? 'evening_reset'
          : 'daily_brief',
      subjectData: {
        ...(conversationState?.subjectData || {}),
        personName:
          match.kind === 'still_open_person'
            ? match.personName
            : conversationState?.subjectData.personName,
        outcomeReviewPromptJson: JSON.stringify(match),
        outcomeReviewFocusOutcomeIds: presentation.focusOutcomeIds,
        outcomeReviewPrimaryOutcomeId: presentation.primaryOutcomeId,
        outcomeReviewSummary: presentation.summaryText,
      },
      responseSource: 'local_companion',
      hasActionItem: presentation.focusOutcomeIds.length > 0,
      hasRiskSignal:
        match.kind === 'slipped' ||
        match.kind === 'needs_attention' ||
        match.kind === 'weekly_review' ||
        match.kind === 'review_weekend',
    });
    saveAlexaConversationState(
      linked.principalKey,
      linked.account.accessTokenHash,
      linked.account.groupFolder,
      nextState,
    );
    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: 'local_companion',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(shapeAlexaSpeech(presentation.text) || presentation.text)
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const runLocalCompanionIntent = async (
    handlerInput: HandlerInput,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    utterance: string,
    conversationState: AlexaConversationState,
    priorContext?: DailyCompanionContext,
  ) => {
    clearAlexaPendingSession(linked.principalKey);
    const reviewPrompt = matchOutcomeReviewPrompt(utterance);
    if (reviewPrompt) {
      return respondWithOutcomeReview(
        handlerInput,
        linked,
        conversationState,
        reviewPrompt,
      );
    }
    const response = await buildDailyCompanionResponse(utterance, {
      channel: 'alexa',
      groupFolder: linked.account.groupFolder,
      tasks: getAllTasks().filter(
        (task) => task.group_folder === linked.account.groupFolder,
      ),
      priorContext: priorContext || null,
    });
    if (!response) {
      logger.warn(
        { groupFolder: linked.account.groupFolder, utterance },
        'Alexa local companion could not classify request',
      );
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(
          `${assistantName} could not ground that daily read cleanly yet. Please ask it a different way.`,
        )
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    }

    return respondWithLocalCompanion(
      handlerInput,
      linked,
      conversationState,
      response,
    );
  };

  const runLifeThreadCommand = (
    handlerInput: HandlerInput,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    text: string,
    conversationState?: AlexaConversationState,
  ) => {
    const priorCompanionContext =
      parseDailyCompanionContext(conversationState) ||
      (conversationState?.subjectData.threadId
        ? {
            summaryText: conversationState.summaryText,
            usedThreadIds: [conversationState.subjectData.threadId],
            usedThreadTitles: conversationState.subjectData.threadTitle
              ? [conversationState.subjectData.threadTitle]
              : [],
            usedThreadReasons: ['it was the active thread in the last answer'],
            threadSummaryLines:
              conversationState.subjectData.threadSummaryLines || [],
          }
        : null);
    const result = handleLifeThreadCommand({
      groupFolder: linked.account.groupFolder,
      channel: 'alexa',
      text,
      conversationSummary: conversationState?.summaryText,
      priorContext: priorCompanionContext,
    });
    if (!result.handled) {
      return null;
    }

    if (result.referencedThread) {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaCompanionConversationState({
          flowKey: 'life_thread',
          subjectKind: 'life_thread',
          summaryText: result.responseText || result.referencedThread.title,
          guidanceGoal: 'life_thread_guidance',
          subjectData: {
            fallbackCount: 0,
            threadId: result.referencedThread.id,
            threadTitle: result.referencedThread.title,
            threadSummaryLines: [
              result.referencedThread.nextAction ||
                result.referencedThread.summary,
            ],
            dailyCompanionContextJson: JSON.stringify({
              version: 1,
              mode: 'open_guidance',
              channel: 'alexa',
              generatedAt: new Date().toISOString(),
              summaryText: result.responseText || result.referencedThread.title,
              shortText: result.responseText || result.referencedThread.title,
              extendedText: result.responseText || result.referencedThread.title,
              leadReason: 'life_thread',
              signalsUsed: ['life_threads'],
              signalsOmitted: [],
              householdSignals: [],
              recommendationKind: 'none',
              recommendationText: null,
              subjectKind: 'life_thread',
              supportedFollowups: ['anything_else', 'shorter', 'say_more', 'memory_control'],
              subjectData: {},
              toneProfile: 'balanced',
              extraDetails: [],
              memoryLines: [],
              usedThreadIds: [result.referencedThread.id],
              usedThreadTitles: [result.referencedThread.title],
              usedThreadReasons: ['it was the active thread in the last answer'],
              threadSummaryLines: [
                result.referencedThread.nextAction || result.referencedThread.summary,
              ],
              comparisonKeys: {
                nextEvent: null,
                nextReminder: null,
                recommendation: null,
                household: null,
                focus: result.referencedThread.id,
                thread:
                  result.referencedThread.nextAction || result.referencedThread.summary,
              },
            } satisfies DailyCompanionContext),
          },
          supportedFollowups: ['anything_else', 'shorter', 'say_more', 'memory_control'],
        }),
      );
    }

    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: 'life_thread_local',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(result.responseText || 'Okay.')
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const runRitualCommand = (
    handlerInput: HandlerInput,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    text: string,
    conversationState?: AlexaConversationState,
  ) => {
    const priorCompanionContext = parseDailyCompanionContext(conversationState);
    const result = handleRitualCommand({
      groupFolder: linked.account.groupFolder,
      channel: 'alexa',
      text,
      replyText:
        conversationState?.subjectData.pendingActionText ||
        conversationState?.subjectData.lastAnswerSummary,
      conversationSummary: conversationState?.summaryText,
      priorCompanionMode: priorCompanionContext?.mode,
      priorContext: priorCompanionContext
        ? { usedThreadIds: priorCompanionContext.usedThreadIds }
        : null,
      now: new Date(),
    });
    if (!result.handled) {
      return null;
    }
    saveAlexaConversationState(
      linked.principalKey,
      linked.account.accessTokenHash,
      linked.account.groupFolder,
      buildAlexaCompanionConversationState({
        flowKey: 'ritual_control',
        subjectKind: 'saved_item',
        summaryText: result.responseText || 'ritual update',
        guidanceGoal: 'action_follow_through',
        subjectData: {
          ...(conversationState?.subjectData || {}),
          fallbackCount: 0,
          lastAnswerSummary: result.responseText || 'ritual update',
          pendingActionText: undefined,
        },
        responseSource: 'local_companion',
        hasActionItem: true,
      }),
    );
    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: 'local_companion',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(result.responseText || 'Okay.')
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const runDraftFollowUpCompletion = async (
    handlerInput: HandlerInput,
    authorization: { principal: AlexaPrincipal },
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    draftReference: string,
    conversationState?: AlexaConversationState,
  ) => {
    try {
      const utterance = buildAlexaPersonalPrompt(ALEXA_DRAFT_FOLLOW_UP_INTENT, {
        meetingReference: draftReference,
      });
      const result = await runAlexaAssistantTurn(
        {
          utterance,
          principal: {
            ...authorization.principal,
            displayName: linked.account.displayName,
          },
          promptContext: conversationState
            ? {
                conversationSummary: conversationState.summaryText,
                conversationSubjectKind: conversationState.subjectKind,
                supportedFollowups: conversationState.supportedFollowups,
                channelMode:
                  conversationState.styleHints.channelMode || 'alexa_companion',
                guidanceGoal: conversationState.styleHints.guidanceGoal,
                initiativeLevel:
                  conversationState.styleHints.initiativeLevel || 'measured',
              }
            : undefined,
        },
        {
          assistantName,
          targetGroupFolder: linked.account.groupFolder,
          requireExistingTargetGroup: true,
        },
      );
      const speech =
        shapeAlexaSpeech(result.text) ||
        `${assistantName} is thinking, but the answer came back empty. Please try again.`;
      const summaryText =
        speech.split(/(?<=[.!?])\s+/)[0]?.trim() ||
        `Drafted a follow-up for ${draftReference}.`;
      const continuationCandidate: CompanionContinuationCandidate = {
        capabilityId: 'followthrough.draft_follow_up',
        voiceSummary: summaryText,
        completionText: result.text,
        handoffPayload: {
          kind: 'message',
          title: 'Draft follow-up',
          text: result.text,
          followupSuggestions: ['I can send the full draft to Telegram if you want.'],
        },
        threadId: conversationState?.subjectData.threadId,
        threadTitle: conversationState?.subjectData.threadTitle,
        knowledgeSourceIds: conversationState?.subjectData.knowledgeSourceIds,
        knowledgeSourceTitles:
          conversationState?.subjectData.knowledgeSourceTitles,
        followupSuggestions: ['I can send the full draft to Telegram if you want.'],
      };

      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaCompanionConversationState({
          flowKey: 'draft_follow_up',
          subjectKind: 'draft',
          summaryText,
          guidanceGoal: 'action_follow_through',
          subjectData: {
            ...(conversationState?.subjectData || {}),
            fallbackCount: 0,
            meetingReference: draftReference,
            lastAnswerSummary: summaryText,
            pendingActionText: result.text,
            companionContinuationJson: JSON.stringify(continuationCandidate),
          },
          supportedFollowups: [
            'anything_else',
            'shorter',
            'say_more',
            'send_details',
            'save_to_library',
            'save_for_later',
            'create_reminder',
            'memory_control',
          ],
          prioritizationLens:
            conversationState?.styleHints.prioritizationLens || 'work',
          hasActionItem: true,
          responseSource: 'assistant_bridge',
        }),
      );

      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'bridge',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(speech)
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    } catch (err) {
      if (err instanceof AlexaTargetGroupMissingError) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
          linked: true,
          groupFolder: err.groupFolder,
        });
        return buildBarrierResponse(
          handlerInput,
          buildSetupBarrier(assistantName, err.groupFolder),
        );
      }
      throw err;
    }
  };

  const buildAlexaCapabilityPilotOutcome = (
    result: AssistantCapabilityResult,
  ): {
    outcome: PilotJourneyOutcome;
    blockerClass?: string | null;
    blockerOwner?: PilotBlockerOwner;
    degradedPath?: string | null;
    systemsInvolved?: string[];
    handoffCreated?: boolean;
    missionCreated?: boolean;
    threadSaved?: boolean;
    reminderCreated?: boolean;
    librarySaved?: boolean;
    summaryText?: string | null;
  } => {
    const systemsInvolved = new Set<string>();
    const capabilityId = result.capabilityId || '';
    if (result.dailyResponse) systemsInvolved.add('daily_companion');
    if (result.lifeThreadResult?.referencedThread) systemsInvolved.add('life_threads');
    if (capabilityId.startsWith('communication.')) {
      systemsInvolved.add('communication_companion');
    }
    if (capabilityId.startsWith('missions.')) {
      systemsInvolved.add('missions');
      systemsInvolved.add('chief_of_staff');
    }
    if (capabilityId.startsWith('staff.')) systemsInvolved.add('chief_of_staff');
    if (capabilityId.startsWith('knowledge.')) systemsInvolved.add('knowledge_library');
    if (capabilityId.startsWith('threads.')) systemsInvolved.add('life_threads');
    if (result.trace?.responseSource?.startsWith('research')) {
      systemsInvolved.add('research');
    }
    if (result.trace?.responseSource?.startsWith('media')) {
      systemsInvolved.add('image_generation');
    }
    return {
      outcome:
        (capabilityId.startsWith('research.') ||
          capabilityId.startsWith('media.')) &&
        result.trace?.responseSource === 'unavailable'
          ? 'externally_blocked'
          : result.trace?.responseSource === 'unavailable'
            ? 'degraded_usable'
            : 'success',
      blockerClass:
        capabilityId.startsWith('research.') &&
        result.trace?.responseSource === 'unavailable'
          ? 'outward_research_blocked'
          : capabilityId.startsWith('media.') &&
              result.trace?.responseSource === 'unavailable'
            ? 'image_generation_blocked'
            : result.trace?.responseSource === 'unavailable'
              ? 'local_degraded_path'
              : null,
      blockerOwner:
        (capabilityId.startsWith('research.') ||
          capabilityId.startsWith('media.')) &&
        result.trace?.responseSource === 'unavailable'
          ? 'external'
          : result.trace?.responseSource === 'unavailable'
            ? 'repo_side'
            : 'none',
      degradedPath:
        result.trace?.responseSource === 'unavailable'
          ? result.trace.reason
          : null,
      systemsInvolved: [...systemsInvolved],
      handoffCreated: false,
      missionCreated: Boolean(
        result.conversationSeed?.subjectData?.missionId ||
          result.continuationCandidate?.missionId,
      ),
      threadSaved: Boolean(result.lifeThreadResult?.referencedThread),
      librarySaved: capabilityId === 'knowledge.save_source',
      summaryText:
        result.conversationSeed?.summaryText ||
        result.replyText ||
        result.trace?.reason ||
        null,
    };
  };

  const buildAlexaCompletionPilotOutcome = (
    result: AssistantActionCompletionResult,
  ): {
    outcome: PilotJourneyOutcome;
    blockerClass?: string | null;
    blockerOwner?: PilotBlockerOwner;
    degradedPath?: string | null;
    systemsInvolved?: string[];
    handoffCreated?: boolean;
    missionCreated?: boolean;
    threadSaved?: boolean;
    reminderCreated?: boolean;
    librarySaved?: boolean;
    summaryText?: string | null;
  } => {
    const capabilityOutcome = result.capabilityResult
      ? buildAlexaCapabilityPilotOutcome(result.capabilityResult)
      : null;
    const systemsInvolved = new Set(capabilityOutcome?.systemsInvolved || []);
    if (result.handoffResult) {
      systemsInvolved.add('cross_channel_handoffs');
    }
    if (result.bridgeSaveForLaterText || result.lifeThreadResult?.referencedThread) {
      systemsInvolved.add('life_threads');
    }
    if (result.reminderTaskId) {
      systemsInvolved.add('reminders');
    }
    if (result.bridgeDraftReference) {
      systemsInvolved.add('communication_companion');
    }
    return {
      outcome: capabilityOutcome?.outcome || 'success',
      blockerClass: capabilityOutcome?.blockerClass || null,
      blockerOwner: capabilityOutcome?.blockerOwner || 'none',
      degradedPath: capabilityOutcome?.degradedPath || null,
      systemsInvolved: [...systemsInvolved],
      handoffCreated: Boolean(result.handoffResult),
      missionCreated: Boolean(
        capabilityOutcome?.missionCreated ||
          result.capabilityResult?.conversationSeed?.subjectData?.missionId,
      ),
      threadSaved: Boolean(
        result.bridgeSaveForLaterText || result.lifeThreadResult?.referencedThread,
      ),
      reminderCreated: Boolean(result.reminderTaskId),
      librarySaved: Boolean(capabilityOutcome?.librarySaved),
      summaryText:
        result.replyText ||
        result.bridgeSaveForLaterText ||
        result.bridgeDraftReference ||
        result.capabilityResult?.conversationSeed?.summaryText ||
        result.capabilityResult?.replyText ||
        null,
    };
  };

  const runCompanionActionCompletion = async (
    handlerInput: HandlerInput,
    authorization: { principal: AlexaPrincipal },
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    action: import('./types.js').AlexaConversationFollowupAction,
    utterance: string,
    conversationState?: AlexaConversationState,
  ) => {
    const completionAction =
      action === 'save_that' ? 'save_for_later' : action;
    const pilotRecord = startPilotJourney({
      journeyId: 'cross_channel_handoff',
      systemsInvolved: ['alexa', 'cross_channel_handoffs'],
      summaryText: `Alexa companion action ${completionAction}`,
      routeKey: `alexa_completion:${completionAction}`,
      channel: 'alexa',
      groupFolder: linked.account.groupFolder,
    });
    let result: AssistantActionCompletionResult;
    try {
      result = await completeAssistantActionFromAlexa(
        {
          groupFolder: linked.account.groupFolder,
          action: completionAction,
          utterance,
          conversationSummary: conversationState?.summaryText,
          priorSubjectData: conversationState?.subjectData,
          replyText:
            conversationState?.subjectData.pendingActionText ||
            conversationState?.subjectData.lastAnswerSummary,
          now: getRequestTimestampDate(handlerInput.requestEnvelope),
        },
        {
          resolveTelegramMainChat: deps.resolveTelegramMainChat,
          sendTelegramMessage: deps.sendTelegramMessage,
          sendTelegramArtifact: deps.sendTelegramArtifact,
        },
      );
    } catch (err) {
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'internal_failure',
          blockerClass: 'alexa_companion_completion_failed',
          blockerOwner: 'repo_side',
          summaryText:
            err instanceof Error ? err.message : 'alexa companion completion failed',
        });
      }
      throw err;
    }
    if (!result.handled) {
      return null;
    }

    if (result.bridgeSaveForLaterText) {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaCompanionConversationState({
          flowKey: 'save_for_later',
          subjectKind: 'saved_item',
          summaryText: result.bridgeSaveForLaterText,
          guidanceGoal: 'action_follow_through',
          subjectData: {
            ...(conversationState?.subjectData || {}),
            savedText: result.bridgeSaveForLaterText,
            lastAnswerSummary: result.bridgeSaveForLaterText,
            pendingActionText: result.bridgeSaveForLaterText,
          },
          supportedFollowups: [
            'anything_else',
            'shorter',
            'say_more',
            'send_details',
            'save_to_library',
            'track_thread',
            'create_reminder',
            'memory_control',
          ],
          prioritizationLens:
            conversationState?.styleHints.prioritizationLens || 'general',
          hasActionItem: true,
          responseSource: 'local_companion',
        }),
      );
      saveAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
        'confirm_save_for_later',
        { captureText: result.bridgeSaveForLaterText },
      );
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'barrier',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          ...buildAlexaCompletionPilotOutcome(result),
        });
      }
      return handlerInput.responseBuilder
        .speak(
          buildSaveForLaterConfirmationSpeech(
            assistantName,
            result.bridgeSaveForLaterText,
          ),
        )
        .reprompt('Say yes to save it, or no to cancel.')
        .getResponse();
    }

    if (result.bridgeDraftReference) {
      return runDraftFollowUpCompletion(
        handlerInput,
        authorization,
        linked,
        result.bridgeDraftReference,
        conversationState,
      );
    }

    if (result.capabilityResult?.conversationSeed) {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaStateFromCapabilitySeed(result.capabilityResult.conversationSeed),
      );
    } else if (result.lifeThreadResult?.referencedThread) {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaCompanionConversationState({
          flowKey: 'life_thread',
          subjectKind: 'life_thread',
          summaryText:
            result.replyText || result.lifeThreadResult.referencedThread.title,
          guidanceGoal: 'life_thread_guidance',
          subjectData: {
            ...(conversationState?.subjectData || {}),
            fallbackCount: 0,
            threadId: result.lifeThreadResult.referencedThread.id,
            threadTitle: result.lifeThreadResult.referencedThread.title,
            threadSummaryLines: [
              result.lifeThreadResult.referencedThread.nextAction ||
                result.lifeThreadResult.referencedThread.summary,
            ],
            lastAnswerSummary:
              result.replyText || result.lifeThreadResult.referencedThread.title,
          },
          supportedFollowups: [
            'anything_else',
            'shorter',
            'say_more',
            'send_details',
            'memory_control',
          ],
          responseSource: 'local_companion',
          hasActionItem: true,
        }),
      );
    } else {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaCompanionConversationState({
          flowKey: conversationState?.flowKey || 'companion_completion',
          subjectKind: conversationState?.subjectKind || 'saved_item',
          summaryText: result.replyText || 'action complete',
          guidanceGoal:
            conversationState?.styleHints.guidanceGoal || 'action_follow_through',
          subjectData: {
            ...(conversationState?.subjectData || {}),
            fallbackCount: 0,
            lastAnswerSummary: result.replyText || 'action complete',
          },
          supportedFollowups:
            conversationState?.supportedFollowups || [
              'anything_else',
              'shorter',
              'say_more',
              'memory_control',
            ],
          prioritizationLens:
            conversationState?.styleHints.prioritizationLens || 'general',
          responseSource: 'local_companion',
          hasActionItem: true,
        }),
      );
    }

    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource:
        completionAction === 'send_details'
          ? conversationState?.subjectData.activeCapabilityId ===
            'media.image_generate'
            ? 'media_handoff'
            : 'research_handoff'
          : 'local_companion',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    if (pilotRecord) {
      completePilotJourney({
        eventId: pilotRecord.eventId,
        ...buildAlexaCompletionPilotOutcome(result),
      });
    }
    return handlerInput.responseBuilder
      .speak(shapeAlexaSpeech(result.replyText || 'Okay.') || 'Okay.')
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const runSharedAlexaCapability = async (
    handlerInput: HandlerInput,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    capability: {
      capabilityId: import('./assistant-capabilities.js').AssistantCapabilityId;
      canonicalText?: string;
      normalizedText: string;
      reason: string;
    },
    conversationState?: AlexaConversationState,
    options: {
      intentFamily?: AlexaVoiceIntentFamily;
      routeOutcome?: string;
      clarifierHints?: string[];
    } = {},
  ) => {
    clearAlexaPendingSession(linked.principalKey);
    const priorCompanionContext = parseDailyCompanionContext(conversationState);
    const priorSubjectData = conversationState?.subjectData;
    const pilotRecord = startPilotJourney({
      ...(resolvePilotJourneyFromCapability({
        capabilityId: capability.capabilityId,
        channel: 'alexa',
        text: capability.normalizedText,
        canonicalText: capability.canonicalText,
        personName: conversationState?.subjectData?.personName,
        threadTitle: conversationState?.subjectData?.threadTitle,
        summaryText: conversationState?.summaryText,
      }) || {
        journeyId: 'alexa_orientation' as const,
        systemsInvolved: ['alexa'],
        summaryText: 'Alexa shared capability',
        routeKey: capability.capabilityId,
      }),
      channel: 'alexa',
      groupFolder: linked.account.groupFolder,
    });
    let result: AssistantCapabilityResult;
    try {
      result = await executeAssistantCapability({
        capabilityId: capability.capabilityId,
        context: {
          channel: 'alexa',
          groupFolder: linked.account.groupFolder,
          conversationSummary: conversationState?.summaryText,
          priorCompanionContext: priorCompanionContext || null,
          priorSubjectData: conversationState?.subjectData,
          factIdHint: getAlexaConversationReferencedFactId(conversationState),
          now: new Date(),
        },
        input: {
          text: capability.normalizedText,
          canonicalText: capability.canonicalText,
        },
      });
    } catch (err) {
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'internal_failure',
          blockerClass: 'alexa_shared_capability_failed',
          blockerOwner: 'repo_side',
          summaryText:
            err instanceof Error ? err.message : 'alexa shared capability failed',
        });
      }
      throw err;
    }
    if (!result.handled) {
      return null;
    }

    const actionBundle = createOrRefreshActionBundle({
      groupFolder: linked.account.groupFolder,
      presentationChannel: 'alexa',
      capabilityId: result.capabilityId,
      continuationCandidate: result.continuationCandidate,
      summaryText: result.conversationSeed?.summaryText || result.replyText,
      replyText: result.replyText,
      utterance: capability.normalizedText,
    });
    if (actionBundle) {
      const voiceSummary = buildActionBundleVoiceSummary(actionBundle);
      if (result.dailyResponse) {
        result.dailyResponse.reply = `${result.dailyResponse.reply} ${voiceSummary.summary}`.trim();
      } else {
        result.replyText = `${result.replyText || 'Okay.'} ${voiceSummary.summary}`.trim();
      }
      if (result.conversationSeed) {
        const firstRuleAction = actionBundle.actions.find(
          (action) => action.delegationRuleId,
        );
        result.conversationSeed.subjectData = {
          ...(result.conversationSeed.subjectData || {}),
          actionBundleId: actionBundle.bundle.bundleId,
          actionBundleTitle: actionBundle.bundle.title,
          actionBundleSummary: actionBundle.actions
            .slice(0, 3)
            .map((action) => action.summary)
            .join(', '),
          delegationRuleFocusRuleId:
            firstRuleAction?.delegationRuleId || undefined,
        };
        result.conversationSeed.supportedFollowups = Array.from(
          new Set([
            ...(result.conversationSeed.supportedFollowups || []),
            'approve_bundle',
            'show_bundle',
            'send_details',
            'delegation_control',
            'show_rules',
          ]),
        );
      }
      if (result.continuationCandidate) {
        result.continuationCandidate.actionBundleId = actionBundle.bundle.bundleId;
        result.continuationCandidate.actionBundleTitle = actionBundle.bundle.title;
        result.continuationCandidate.actionBundleSummary = actionBundle.actions
          .slice(0, 3)
          .map((action) => action.summary)
          .join(', ');
      }
    }

    if (result.dailyResponse) {
      const nextState = result.conversationSeed
        ? buildAlexaStateFromCapabilitySeed(result.conversationSeed, {
            intentFamily: options.intentFamily,
            routeOutcome: options.routeOutcome || 'shared_capability',
            userUtterance: capability.normalizedText,
            clarifierHints: options.clarifierHints,
          })
        : conversationState ||
          buildAlexaCompanionConversationState({
            flowKey: capability.capabilityId.replace(/\./g, '_'),
            subjectKind: result.dailyResponse.context.subjectKind,
            summaryText: result.dailyResponse.context.summaryText,
            guidanceGoal: 'open_conversation',
            responseSource: 'local_companion',
            subjectData: {
              lastIntentFamily:
                options.intentFamily || priorSubjectData?.lastIntentFamily,
              lastRouteOutcome:
                options.routeOutcome ||
                priorSubjectData?.lastRouteOutcome ||
                'shared_capability',
              lastUserUtterance: capability.normalizedText,
              clarifierHints:
                options.clarifierHints || priorSubjectData?.clarifierHints,
            },
          });
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          ...buildAlexaCapabilityPilotOutcome(result),
        });
      }
      return respondWithLocalCompanion(
        handlerInput,
        linked,
        nextState,
        result.dailyResponse,
      );
    }

    if (result.conversationSeed) {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaStateFromCapabilitySeed(result.conversationSeed, {
          intentFamily: options.intentFamily,
          routeOutcome: options.routeOutcome || 'shared_capability',
          userUtterance: capability.normalizedText,
          clarifierHints: options.clarifierHints,
        }),
      );
    }

    if (
      result.handoffOffer &&
      result.continuationCandidate?.handoffPayload &&
      hasCompanionHandoffDeps()
    ) {
      saveAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
        'confirm_companion_completion',
        {
          action: 'send_details',
          companionContinuationJson: JSON.stringify(result.continuationCandidate),
          replyText: result.replyText,
          conversationSummary:
            result.conversationSeed?.summaryText || conversationState?.summaryText,
        },
      );
    }

    logger.info(
      {
        requestId: handlerInput.requestEnvelope.request.requestId,
        requestType: getRequestType(handlerInput.requestEnvelope),
        intentName:
          getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            ? getIntentName(handlerInput.requestEnvelope)
            : undefined,
        capabilityId: result.capabilityId,
        capabilityReason: capability.reason,
        traceReason: result.trace?.reason,
        sourceNotes: result.trace?.notes || [],
        responseSource: result.trace?.responseSource || 'local_companion',
      },
      'Alexa shared capability answered locally',
    );
    recordHandledRequest(handlerInput.requestEnvelope, {
      responseSource: result.trace?.responseSource || 'local_companion',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    if (pilotRecord) {
      completePilotJourney({
        eventId: pilotRecord.eventId,
        ...buildAlexaCapabilityPilotOutcome(result),
      });
    }
    return handlerInput.responseBuilder
      .speak(shapeAlexaSpeech(result.replyText || 'Okay.') || 'Okay.')
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const runOpenConversationTurn = async (
    handlerInput: HandlerInput,
    authorization: { principal: AlexaPrincipal },
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    utterance: string,
    conversationState?: AlexaConversationState,
    options: {
      candidateTexts?: string[];
      family?: AlexaVoiceIntentFamily;
    } = {},
  ) => {
    const pilotFamily = options.family || 'legacy';
    const candidateTexts = Array.from(
      new Set(
        [utterance, ...(options.candidateTexts || [])]
          .map((value) => normalizeVoicePrompt(value).trim())
          .filter(Boolean)
          .map((value) => value.toLowerCase()),
      ),
    ).map((lower) =>
      [utterance, ...(options.candidateTexts || [])].find(
        (candidate) => normalizeVoicePrompt(candidate).trim().toLowerCase() === lower,
      ) || utterance,
    );
    const plan =
      candidateTexts
        .map((candidate) =>
          planAlexaDialogueTurn(candidate, conversationState, options.family),
        )
        .find((candidatePlan) => candidatePlan.route !== 'assistant_bridge') ||
      planAlexaDialogueTurn(utterance, conversationState, options.family);
    const reviewPilotRecord =
      plan.route === 'clarify' || plan.route === 'assistant_bridge'
        ? startPilotJourney({
            journeyId: 'alexa_orientation',
            systemsInvolved:
              plan.route === 'assistant_bridge'
                ? ['alexa', 'voice_router', 'assistant_bridge']
                : ['alexa', 'voice_router'],
            summaryText: plan.normalizedText || utterance,
            routeKey: `alexa_voice_router:${pilotFamily}:${plan.route}`,
            channel: 'alexa',
            groupFolder: linked.account.groupFolder,
          })
        : null;

    if (plan.route === 'local' && plan.localKind) {
      const local = buildAlexaLocalVoiceResponse(
        plan.localKind,
        getRequestTimestampDate(handlerInput.requestEnvelope),
      );
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'local_companion',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(local.speech)
        .reprompt(local.reprompt)
        .getResponse();
    }

    if (plan.route === 'clarify') {
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        buildAlexaBridgeConversationState(
          plan.normalizedText || utterance,
          conversationState,
          {
            intentFamily: options.family,
            routeOutcome: 'clarify',
            clarifierHints: conversationState?.subjectData.personName
              ? [conversationState.subjectData.personName]
              : ['plans', 'open loops', 'reminder'],
          },
        ),
      );
      if (reviewPilotRecord) {
        completePilotJourney({
          eventId: reviewPilotRecord.eventId,
          outcome: 'degraded_usable',
          blockerClass: plan.blockerClass || 'weak_clarifier_recovery',
          blockerOwner: 'repo_side',
          summaryText: plan.normalizedText || utterance,
        });
      }
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(
          plan.clarificationSpeech ||
            "Give me one quick anchor first. Ask what you're forgetting, what's still open with Candace, or what to remember tonight.",
        )
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    }

    if (plan.route === 'handoff' && plan.followupAction) {
      if (plan.followupAction === 'memory_control') {
        const memoryResult = handlePersonalizationCommand({
          groupFolder: linked.account.groupFolder,
          channel: 'alexa',
          text: plan.followupText || plan.normalizedText,
          conversationSummary: conversationState?.summaryText,
          factIdHint: getAlexaConversationReferencedFactId(conversationState),
        });
        if (memoryResult.handled) {
          const priorCompanionContext =
            resolveAlexaCompanionPriorContext(conversationState);
          if (
            priorCompanionContext &&
            /be (?:a little |a bit )?more direct/i.test(
              plan.followupText || plan.normalizedText,
            )
          ) {
            return runLocalCompanionIntent(
              handlerInput,
              linked,
              'be a little more direct',
              preserveAlexaConversationFrameForStyleChange(
                conversationState ||
                  buildAlexaCompanionConversationState({
                    flowKey: 'memory_control',
                    subjectKind: 'memory_fact',
                    summaryText: memoryResult.responseText || 'memory control',
                    guidanceGoal: 'explainability',
                    supportedFollowups: ['memory_control'],
                  }),
                buildAlexaCompanionConversationState({
                  flowKey: conversationState?.flowKey || 'memory_control',
                  subjectKind:
                    conversationState?.subjectKind || 'memory_fact',
                  summaryText:
                    conversationState?.summaryText ||
                    memoryResult.responseText ||
                    'memory control',
                  guidanceGoal:
                    conversationState?.styleHints.guidanceGoal ||
                    'open_conversation',
                  supportedFollowups:
                    conversationState?.supportedFollowups || ['memory_control'],
                  responseSource: 'local_companion',
                  subjectData: {
                    ...(conversationState?.subjectData || {}),
                    lastAnswerSummary:
                      conversationState?.subjectData.lastAnswerSummary ||
                      conversationState?.summaryText,
                    pendingActionText:
                      conversationState?.subjectData.pendingActionText,
                  },
                }),
              ),
              priorCompanionContext,
            );
          }
          if (memoryResult.referencedFactId) {
            saveAlexaConversationState(
              linked.principalKey,
              linked.account.accessTokenHash,
              linked.account.groupFolder,
              buildAlexaCompanionConversationState({
                flowKey: 'memory_control',
                subjectKind: 'memory_fact',
                summaryText: memoryResult.responseText || 'memory control',
                guidanceGoal: 'explainability',
                supportedFollowups: ['memory_control'],
                subjectData: { profileFactId: memoryResult.referencedFactId },
              }),
            );
          }
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'barrier',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(memoryResult.responseText || 'Okay.')
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }
      }

      if (
        plan.followupAction === 'save_that' ||
        plan.followupAction === 'send_details' ||
        plan.followupAction === 'save_to_library' ||
        plan.followupAction === 'track_thread' ||
        plan.followupAction === 'create_reminder' ||
        plan.followupAction === 'save_for_later' ||
        plan.followupAction === 'draft_follow_up'
      ) {
        return (
          (await runCompanionActionCompletion(
            handlerInput,
            authorization,
            linked,
            plan.followupAction,
            plan.followupText || plan.normalizedText,
            conversationState,
          )) ||
          handlerInput.responseBuilder
            .speak('I need a little more context before I do that.')
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse()
        );
      }

      const followupText = plan.followupText || plan.normalizedText;
      const personName =
        extractFollowupPersonName(followupText) ||
        conversationState?.subjectData.personName;
      return runLinkedAlexaTurn(
        handlerInput,
        config,
        assistantName,
        authorization.principal,
        linked,
        buildAlexaConversationalFollowupPrompt(plan.followupAction, {
          conversationSummary: conversationState?.summaryText,
          followupText,
          personName,
        }),
        {
          conversationState: buildAlexaNextStateForFollowupAction(
            plan.followupAction,
            followupText,
            conversationState,
            {
              intentFamily: options.family,
              routeOutcome: 'handoff',
            },
          ),
          proactiveSignalText: followupText,
        },
      );
    }

    if (plan.route === 'shared_capability' && plan.capabilityId) {
      const capabilityResponse = await runSharedAlexaCapability(
        handlerInput,
        linked,
        {
          capabilityId: plan.capabilityId,
          canonicalText: plan.capabilityText,
          normalizedText: utterance,
          reason: 'open conversation matched shared capability',
        },
        conversationState,
          {
            intentFamily: options.family,
            routeOutcome: 'shared_capability',
          },
      );
      if (capabilityResponse) {
        return capabilityResponse;
      }
    }

    if (plan.route === 'blocked') {
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'barrier',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(
          plan.blockedSpeech ||
            'I can help with personal planning here, but heavier system controls are better in Telegram.',
        )
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    }

    const response = await runLinkedAlexaTurn(
      handlerInput,
      config,
      assistantName,
      authorization.principal,
      linked,
      buildAlexaOpenConversationPrompt(plan.normalizedText, {
        conversationSummary: conversationState?.summaryText,
      }),
      {
        conversationState: buildAlexaBridgeConversationState(
          plan.normalizedText,
          conversationState,
          {
            intentFamily: options.family,
            routeOutcome: 'assistant_bridge',
          },
        ),
        proactiveSignalText: plan.normalizedText,
      },
    );
    if (reviewPilotRecord) {
      completePilotJourney({
        eventId: reviewPilotRecord.eventId,
        outcome: 'degraded_usable',
        blockerClass:
          plan.blockerClass || 'fallback_unmatched_open_utterance',
        blockerOwner: 'repo_side',
        summaryText: plan.normalizedText,
      });
    }
    return response;
  };

  const LaunchRequestHandler = {
    canHandle(handlerInput: HandlerInput) {
      return getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput: HandlerInput) {
      const authorization = authorizeAlexaRequest(
        handlerInput.requestEnvelope,
        config,
        assistantName,
      );
      if (!authorization.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return buildBarrierResponse(handlerInput, authorization);
      }

      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'launch',
      });
      return handlerInput.responseBuilder
        .speak(buildAlexaWelcomeSpeech(assistantName))
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  const PersonalIntentHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        isAlexaPersonalIntent(getIntentName(handlerInput.requestEnvelope))
      );
    },
    async handle(handlerInput: HandlerInput) {
      const authorization = authorizeAlexaRequest(
        handlerInput.requestEnvelope,
        config,
        assistantName,
      );
      if (!authorization.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return buildBarrierResponse(handlerInput, authorization);
      }

      const linkedResolution = resolveLinkedContext(
        handlerInput,
        authorization.principal,
      );
      if (!linkedResolution.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return linkedResolution.response;
      }

      const linked = linkedResolution.linked;
      const requestIntent = buildRequestIntent(handlerInput.requestEnvelope);
      if (!requestIntent) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'fallback',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak(`${assistantName} did not catch that request yet.`)
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }

      const intentName = requestIntent.name;
      const slotValues = getIntentSlotValues(handlerInput.requestEnvelope);
      const primarySlotValue =
        slotValues.followupText ||
        slotValues.memoryCommand ||
        slotValues.guidanceText ||
        slotValues.subject ||
        slotValues.topic ||
        slotValues.item ||
        slotValues.query ||
        slotValues.controlText ||
        slotValues.captureText ||
        slotValues.meetingReference ||
        slotValues.leadTime ||
        '';
      const pending = loadAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const conversationState = loadAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const priorCompanionContext =
        resolveAlexaCompanionPriorContext(conversationState);
      const voiceCapture = extractAlexaVoiceIntentCapture(intentName, slotValues);

      if (
        pending &&
        !(
          (pending.pendingKind === 'capture_reminder_lead_time' &&
            intentName === ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT) ||
          (pending.pendingKind === 'capture_save_for_later_content' &&
            intentName === ALEXA_SAVE_FOR_LATER_INTENT) ||
          (pending.pendingKind === 'capture_follow_up_reference' &&
            intentName === ALEXA_DRAFT_FOLLOW_UP_INTENT)
        )
      ) {
        clearAlexaPendingSession(linked.principalKey);
      }

      if (shouldRunAlexaAssistantTaskTurn(intentName)) {
        const assistantTaskResponse = await maybeHandleAlexaAssistantTaskTurn({
          handlerInput,
          linked,
          intentName,
          slotValues,
          primarySlotValue,
          conversationState,
          voiceCapture,
        });
        if (assistantTaskResponse) {
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'local_companion',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(assistantTaskResponse.speech)
            .reprompt(assistantTaskResponse.reprompt || DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }
      }

      const sharedCapabilityMatch = resolveAlexaIntentToCapability(intentName, {
        slotValue: primarySlotValue,
        conversationState,
      });
      if (sharedCapabilityMatch) {
        const capabilityResponse = await runSharedAlexaCapability(
          handlerInput,
          linked,
          {
            capabilityId: sharedCapabilityMatch.capabilityId,
            canonicalText: sharedCapabilityMatch.canonicalText,
            normalizedText:
              sharedCapabilityMatch.normalizedText ||
              sharedCapabilityMatch.canonicalText ||
              intentName,
            reason: sharedCapabilityMatch.reason,
          },
          conversationState,
          {
            intentFamily: resolveAlexaVoiceIntentFamily(intentName) || undefined,
            routeOutcome: 'shared_capability',
          },
        );
        if (capabilityResponse) {
          return capabilityResponse;
        }
      }

      if (
        voiceCapture &&
        (intentName === ALEXA_COMPANION_GUIDANCE_INTENT ||
          intentName === ALEXA_PEOPLE_HOUSEHOLD_INTENT ||
          intentName === ALEXA_PLANNING_ORIENTATION_INTENT ||
          intentName === ALEXA_SAVE_REMIND_HANDOFF_INTENT ||
          intentName === ALEXA_OPEN_ASK_INTENT ||
          intentName === ALEXA_CONVERSATION_CONTROL_INTENT)
      ) {
        return runOpenConversationTurn(
          handlerInput,
          authorization,
          linked,
          voiceCapture.preferredText,
          conversationState,
          {
            candidateTexts: voiceCapture.candidateTexts,
            family: voiceCapture.family,
          },
        );
      }

      if (intentName === ALEXA_MY_DAY_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what should I know about today',
          buildAlexaCompanionConversationState({
            flowKey: 'my_day',
            subjectKind: 'day_brief',
            summaryText: 'today and what matters most',
            guidanceGoal: 'daily_brief',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_UPCOMING_SOON_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what do I have coming up soon',
          buildAlexaCompanionConversationState({
            flowKey: 'upcoming_soon',
            subjectKind: 'event',
            summaryText: 'what is coming up soon',
            guidanceGoal: 'upcoming_soon',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_WHAT_NEXT_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what should I do next',
          buildAlexaCompanionConversationState({
            flowKey: 'what_next',
            subjectKind: 'event',
            summaryText: 'what should I do next',
            guidanceGoal: 'next_action',
            prioritizationLens: 'general',
            hasActionItem: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_BEFORE_NEXT_MEETING_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what should I handle before my next meeting',
          buildAlexaCompanionConversationState({
            flowKey: 'before_next_meeting',
            subjectKind: 'meeting',
            summaryText: 'your next meeting and what to handle before it',
            guidanceGoal: 'meeting_prep',
            prioritizationLens: 'meeting',
            hasActionItem: true,
            hasRiskSignal: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_TOMORROW_CALENDAR_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what is on my calendar tomorrow',
          buildAlexaCompanionConversationState({
            flowKey: 'tomorrow_calendar',
            subjectKind: 'day_brief',
            summaryText: 'tomorrow and what it looks like',
            guidanceGoal: 'tomorrow_brief',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_CANDACE_UPCOMING_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what do Candace and I have coming up',
          buildAlexaCompanionConversationState({
            flowKey: 'candace_upcoming',
            subjectKind: 'person',
            summaryText: 'shared plans with Candace',
            guidanceGoal: 'shared_plans',
            subjectData: { personName: 'Candace', activePeople: ['Candace'] },
            prioritizationLens: 'family',
            hasActionItem: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_FAMILY_UPCOMING_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what does the family have going on',
          buildAlexaCompanionConversationState({
            flowKey: 'family_upcoming',
            subjectKind: 'household',
            summaryText: 'family plans, household logistics, and what the family needs',
            guidanceGoal: 'family_guidance',
            subjectData: {
              activePeople: ['Candace', 'Travis'],
              householdFocus: true,
            },
            prioritizationLens: 'family',
            hasActionItem: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what matters most today',
          buildAlexaCompanionConversationState({
            flowKey: 'what_matters_most_today',
            subjectKind: 'day_brief',
            summaryText: 'what matters most today',
            guidanceGoal: 'what_matters_most',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            hasRiskSignal: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_ANYTHING_IMPORTANT_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'anything I should know',
          buildAlexaCompanionConversationState({
            flowKey: 'anything_important',
            subjectKind: 'day_brief',
            summaryText: 'anything important to know or keep in mind',
            guidanceGoal: 'anything_important',
            prioritizationLens: 'general',
            hasRiskSignal: true,
            hasActionItem: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_WHAT_AM_I_FORGETTING_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'what am I forgetting',
          buildAlexaCompanionConversationState({
            flowKey: 'what_am_i_forgetting',
            subjectKind: 'day_brief',
            summaryText: 'likely loose ends, prep gaps, and what you may be forgetting',
            guidanceGoal: 'what_am_i_forgetting',
            prioritizationLens: 'general',
            hasActionItem: true,
            hasRiskSignal: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_EVENING_RESET_INTENT) {
        return runLocalCompanionIntent(
          handlerInput,
          linked,
          'give me an evening reset',
          buildAlexaCompanionConversationState({
            flowKey: 'evening_reset',
            subjectKind: 'day_brief',
            summaryText: 'what to wrap up today, what to remember tonight, and what to tee up for tomorrow',
            guidanceGoal: 'evening_reset',
            prioritizationLens: 'evening',
            hasActionItem: true,
            reminderCandidate: true,
            responseSource: 'local_companion',
          }),
        );
      }

      if (intentName === ALEXA_ANYTHING_ELSE_INTENT) {
        if (!conversationState) {
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'fallback',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(
              "Start with what you want to check, like what you're forgetting, what matters today, or what to remember tonight.",
            )
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }

        if (priorCompanionContext) {
          return runLocalCompanionIntent(
            handlerInput,
            linked,
            'anything else',
            conversationState,
            priorCompanionContext,
          );
        }

        const resolution = resolveAlexaConversationFollowup(
          'anything else',
          conversationState,
        );
        if (!resolution.ok || !resolution.action) {
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'fallback',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(resolution.speech || buildAlexaFallbackSpeech(assistantName))
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }

        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaConversationalFollowupPrompt(resolution.action, {
            conversationSummary: conversationState.summaryText,
          }),
          {
            conversationState: {
              ...conversationState,
              styleHints: {
                channelMode: 'alexa_companion',
                initiativeLevel: 'measured',
                ...conversationState.styleHints,
              },
            },
          },
        );
      }

      if (intentName === ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT) {
        const followupText = getIntentSlotValue(
          handlerInput.requestEnvelope,
          'followupText',
        );
        if (!followupText) {
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'fallback',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak('What would you like me to follow up on?')
            .reprompt('Say the follow-up in a few words.')
            .addElicitSlotDirective('followupText', requestIntent)
            .getResponse();
        }

        const reviewPrompt = matchOutcomeReviewPrompt(followupText);
        if (reviewPrompt) {
          return respondWithOutcomeReview(
            handlerInput,
            linked,
            conversationState,
            reviewPrompt,
          );
        }

        const reviewControl = interpretOutcomeReviewControl(followupText);
        const reviewOutcomeId =
          conversationState?.subjectData.outcomeReviewPrimaryOutcomeId ||
          conversationState?.subjectData.outcomeReviewFocusOutcomeIds?.[0];
        const reviewPromptJson =
          conversationState?.subjectData.outcomeReviewPromptJson?.trim();
        if (reviewControl && reviewOutcomeId && reviewPromptJson) {
          const controlResult = applyOutcomeReviewControl({
            groupFolder: linked.account.groupFolder,
            outcomeId: reviewOutcomeId,
            control: reviewControl,
            now: new Date(),
          });
          if (controlResult.handled) {
            let refreshedPrompt: OutcomeReviewPromptMatch | null = null;
            try {
              refreshedPrompt = JSON.parse(
                reviewPromptJson,
              ) as OutcomeReviewPromptMatch;
            } catch {
              refreshedPrompt = null;
            }

            if (!refreshedPrompt) {
              recordHandledRequest(handlerInput.requestEnvelope, {
                responseSource: 'local_companion',
                linked: true,
                groupFolder: linked.account.groupFolder,
              });
              return handlerInput.responseBuilder
                .speak(controlResult.replyText || 'Okay.')
                .reprompt(DEFAULT_ALEXA_REPROMPT)
                .getResponse();
            }

            const presentation = buildOutcomeReviewResponse({
              groupFolder: linked.account.groupFolder,
              match: refreshedPrompt,
              channel: 'alexa',
              now: new Date(),
            });
            saveAlexaConversationState(
              linked.principalKey,
              linked.account.accessTokenHash,
              linked.account.groupFolder,
              buildAlexaCompanionConversationState({
                flowKey: `outcome_review_${refreshedPrompt.kind}`,
                subjectKind:
                  refreshedPrompt.kind === 'still_open_person'
                    ? 'person'
                    : 'day_brief',
                summaryText: presentation.summaryText,
                guidanceGoal:
                  refreshedPrompt.kind === 'weekly_review' ||
                  refreshedPrompt.kind === 'review_weekend'
                    ? 'evening_reset'
                    : 'daily_brief',
                subjectData: {
                  ...(conversationState?.subjectData || {}),
                  personName:
                    refreshedPrompt.kind === 'still_open_person'
                      ? refreshedPrompt.personName
                      : conversationState?.subjectData.personName,
                  outcomeReviewPromptJson: JSON.stringify(refreshedPrompt),
                  outcomeReviewFocusOutcomeIds: presentation.focusOutcomeIds,
                  outcomeReviewPrimaryOutcomeId:
                    presentation.primaryOutcomeId,
                  outcomeReviewSummary: presentation.summaryText,
                },
                responseSource: 'local_companion',
                hasActionItem: presentation.focusOutcomeIds.length > 0,
                hasRiskSignal: true,
              }),
            );
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'local_companion',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak(controlResult.replyText || presentation.text)
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
        }

        const earlyResolution = resolveAlexaConversationFollowup(
          followupText,
          conversationState,
        );
        if (
          earlyResolution.ok &&
          (earlyResolution.action === 'save_that' ||
            earlyResolution.action === 'send_details' ||
            earlyResolution.action === 'save_to_library' ||
            earlyResolution.action === 'track_thread' ||
            earlyResolution.action === 'create_reminder' ||
            earlyResolution.action === 'save_for_later' ||
            earlyResolution.action === 'draft_follow_up')
        ) {
          return (
            (await runCompanionActionCompletion(
              handlerInput,
              authorization,
              linked,
              earlyResolution.action,
              followupText,
              conversationState,
            )) ||
            handlerInput.responseBuilder
              .speak('I need a little more context before I do that.')
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse()
          );
        }

        const hasDelegationFollowup =
          earlyResolution.ok &&
          (earlyResolution.action === 'delegation_control' ||
            earlyResolution.action === 'show_rules');
        if (!hasDelegationFollowup) {
          const localResponse = await buildDailyCompanionResponse(followupText, {
            channel: 'alexa',
            groupFolder: linked.account.groupFolder,
            tasks: getAllTasks().filter(
              (task) => task.group_folder === linked.account.groupFolder,
            ),
            priorContext: priorCompanionContext || null,
          });
          if (localResponse) {
            return respondWithLocalCompanion(
              handlerInput,
              linked,
              conversationState ||
                buildAlexaCompanionConversationState({
                  flowKey: 'daily_companion_followup',
                  subjectKind: localResponse.context.subjectKind,
                  summaryText: localResponse.context.summaryText,
                  guidanceGoal: localResponse.context.subjectKind === 'person'
                    ? 'shared_plans'
                    : 'open_conversation',
                  subjectData: {
                    ...localResponse.context.subjectData,
                    threadId: localResponse.context.usedThreadIds?.[0],
                    threadTitle: localResponse.context.usedThreadTitles?.[0],
                    threadSummaryLines:
                      localResponse.context.threadSummaryLines || [],
                  },
                  prioritizationLens:
                    localResponse.context.subjectKind === 'person' ||
                    localResponse.context.subjectKind === 'household'
                      ? 'family'
                      : 'general',
                  hasActionItem: Boolean(localResponse.context.recommendationText),
                  responseSource: 'local_companion',
                }),
              localResponse,
            );
          }
        }

        const lifeThreadResponse = runLifeThreadCommand(
          handlerInput,
          linked,
          followupText,
          conversationState,
        );
        if (lifeThreadResponse) {
          return lifeThreadResponse;
        }

        const ritualResponse = runRitualCommand(
          handlerInput,
          linked,
          followupText,
          conversationState,
        );
        if (ritualResponse) {
          return ritualResponse;
        }

        const resolution = resolveAlexaConversationFollowup(
          followupText,
          conversationState,
        );
        if (!resolution.ok || !resolution.action) {
          return runOpenConversationTurn(
            handlerInput,
            authorization,
            linked,
            followupText,
            conversationState,
          );
        }

        if (resolution.action === 'show_rules') {
          const rules = listDelegationRulesForGroup({
            groupFolder: linked.account.groupFolder,
            statuses: ['active', 'paused'],
            limit: 6,
          });
          const lead =
            rules.length === 0
              ? 'You do not have any saved delegation rules yet.'
              : rules.length === 1
                ? `You have one saved delegation rule. The main one is ${rules[0]!.title}. I can send the fuller list to Telegram if you want.`
                : `You have ${rules.length} saved delegation rules. The main one is ${rules[0]!.title}. I can send the fuller list to Telegram if you want.`;
          saveAlexaConversationState(
            linked.principalKey,
            linked.account.accessTokenHash,
            linked.account.groupFolder,
            buildAlexaCompanionConversationState({
              flowKey: 'delegation_rules',
              subjectKind: 'saved_item',
              summaryText: 'delegation rules',
              guidanceGoal: 'explainability',
              supportedFollowups: ['delegation_control', 'show_rules'],
              subjectData: {
                ...(conversationState?.subjectData || {}),
                delegationRuleFocusRuleId: rules[0]?.ruleId,
              },
            }),
          );
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'barrier',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(lead)
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }

        if (resolution.action === 'delegation_control') {
          const previewJson =
            conversationState?.subjectData.delegationRulePreviewJson?.trim();
          if (
            previewJson &&
            /^(yes|save it|remember that default|use that default)\b/i.test(
              followupText.trim(),
            )
          ) {
            try {
              const preview = JSON.parse(previewJson);
              saveDelegationRuleFromPreview(
                linked.account.groupFolder,
                preview,
                new Date(),
              );
              saveAlexaConversationState(
                linked.principalKey,
                linked.account.accessTokenHash,
                linked.account.groupFolder,
                buildAlexaCompanionConversationState({
                  flowKey: 'delegation_rules',
                  subjectKind: 'saved_item',
                  summaryText: 'saved delegation rule',
                  guidanceGoal: 'explainability',
                  supportedFollowups: ['delegation_control', 'show_rules'],
                  subjectData: {
                    ...(conversationState?.subjectData || {}),
                    delegationRulePreviewJson: undefined,
                  },
                }),
              );
              recordHandledRequest(handlerInput.requestEnvelope, {
                responseSource: 'barrier',
                linked: true,
                groupFolder: linked.account.groupFolder,
              });
              return handlerInput.responseBuilder
                .speak(
                  'Okay. I saved that as a delegation rule. Ask me to show your rules if you want the fuller list in Telegram.',
                )
                .reprompt(DEFAULT_ALEXA_REPROMPT)
                .getResponse();
            } catch {
              /* fall through to a new preview */
            }
          }

          const focusedRuleId =
            conversationState?.subjectData.delegationRuleFocusRuleId || null;
          if (
            focusedRuleId &&
            /^(always ask before doing that|stop doing that automatically)\b/i.test(
              followupText.trim(),
            )
          ) {
            updateDelegationRuleMode(focusedRuleId, 'always_ask');
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'barrier',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak('Okay. I will ask each time before doing that.')
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
          if (focusedRuleId && /^why did that fire\b/i.test(followupText.trim())) {
            const rule = getDelegationRule(focusedRuleId);
            const explanation = rule
              ? `I used ${rule.title} because it matched this kind of flow. It is set to ${rule.approvalMode.replace(/_/g, ' ')}.`
              : 'I used the saved rule that matched this situation.';
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'barrier',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak(explanation)
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }

          const currentBundle = conversationState?.subjectData.actionBundleId
            ? getActionBundleSnapshot(conversationState.subjectData.actionBundleId)
            : undefined;
          const previewResult = buildDelegationRulePreview({
            utterance: followupText,
            context: {
              groupFolder: linked.account.groupFolder,
              channel: 'alexa',
              currentBundle,
              actionTypeHint: currentBundle?.actions.find((action) =>
                ['approved', 'proposed'].includes(action.status),
              )?.actionType,
              originKind: currentBundle?.bundle.originKind,
              threadTitle:
                conversationState?.subjectData.threadTitle ||
                currentBundle?.bundle.title ||
                null,
              personName:
                conversationState?.subjectData.personName ||
                currentBundle?.bundle.title ||
                null,
              communicationContext:
                currentBundle?.bundle.originKind === 'communication'
                  ? 'reply_followthrough'
                  : currentBundle?.bundle.originKind === 'daily_guidance'
                    ? 'household_followthrough'
                    : 'general',
            },
          });
          if (previewResult.clarificationQuestion) {
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'barrier',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak(previewResult.clarificationQuestion)
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
          if (previewResult.preview) {
            saveAlexaConversationState(
              linked.principalKey,
              linked.account.accessTokenHash,
              linked.account.groupFolder,
              buildAlexaCompanionConversationState({
                flowKey: 'delegation_rules',
                subjectKind: 'saved_item',
                summaryText: previewResult.preview.title,
                guidanceGoal: 'explainability',
                supportedFollowups: ['delegation_control', 'show_rules'],
                subjectData: {
                  ...(conversationState?.subjectData || {}),
                  delegationRulePreviewJson: JSON.stringify(previewResult.preview),
                },
              }),
            );
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'barrier',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak(
                `${previewResult.preview.explanation} ${previewResult.preview.safetyNote} Say yes to save it, or say always ask before doing that.`,
              )
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
        }

        if (resolution.action === 'memory_control') {
          const memoryResult = handlePersonalizationCommand({
            groupFolder: linked.account.groupFolder,
            channel: 'alexa',
            text: followupText,
            conversationSummary: conversationState?.summaryText,
            factIdHint: getAlexaConversationReferencedFactId(conversationState),
          });
          if (memoryResult.handled) {
            if (memoryResult.referencedFactId) {
              saveAlexaConversationState(
                linked.principalKey,
                linked.account.accessTokenHash,
                linked.account.groupFolder,
                buildAlexaCompanionConversationState({
                  flowKey: 'memory_control',
                  subjectKind: 'memory_fact',
                  summaryText: memoryResult.responseText || 'memory control',
                  guidanceGoal: 'explainability',
                  supportedFollowups: ['memory_control'],
                  subjectData: { profileFactId: memoryResult.referencedFactId },
                }),
              );
            }
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'barrier',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak(memoryResult.responseText || 'Okay.')
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
        }

        if (
          resolution.action === 'save_that' ||
          resolution.action === 'send_details' ||
          resolution.action === 'save_to_library' ||
          resolution.action === 'track_thread' ||
          resolution.action === 'create_reminder' ||
          resolution.action === 'save_for_later' ||
          resolution.action === 'draft_follow_up'
        ) {
          return (
            (await runCompanionActionCompletion(
              handlerInput,
              authorization,
              linked,
              resolution.action,
              followupText,
              conversationState,
            )) ||
            handlerInput.responseBuilder
              .speak('I need a little more context before I do that.')
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse()
          );
        }

        const personName =
          extractFollowupPersonName(followupText) ||
          conversationState?.subjectData.personName;

        const nextState =
          resolution.action === 'shorter'
            ? buildAlexaCompanionConversationState({
                flowKey: conversationState?.flowKey || 'followup',
                subjectKind: conversationState?.subjectKind || 'general',
                summaryText:
                  conversationState?.summaryText || 'recent assistant context',
                guidanceGoal:
                  conversationState?.styleHints.guidanceGoal || 'daily_brief',
                subjectData: conversationState?.subjectData || {},
                supportedFollowups:
                  conversationState?.supportedFollowups ||
                  baseFollowupsForSubject('general'),
                prioritizationLens:
                  conversationState?.styleHints.prioritizationLens ||
                  'general',
                hasActionItem: conversationState?.styleHints.hasActionItem,
                hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
                reminderCandidate:
                  conversationState?.styleHints.reminderCandidate,
                responseStyle: 'short_direct',
              })
            : resolution.action === 'say_more'
              ? buildAlexaCompanionConversationState({
                  flowKey: conversationState?.flowKey || 'followup',
                  subjectKind: conversationState?.subjectKind || 'general',
                  summaryText:
                    conversationState?.summaryText ||
                    'recent assistant context',
                  guidanceGoal:
                    conversationState?.styleHints.guidanceGoal ||
                    'daily_brief',
                  subjectData: conversationState?.subjectData || {},
                  supportedFollowups:
                    conversationState?.supportedFollowups ||
                    baseFollowupsForSubject('general'),
                  prioritizationLens:
                    conversationState?.styleHints.prioritizationLens ||
                    'general',
                  hasActionItem: conversationState?.styleHints.hasActionItem,
                  hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
                  reminderCandidate:
                    conversationState?.styleHints.reminderCandidate,
                  responseStyle: 'expanded',
                })
            : resolution.action === 'switch_person'
              ? buildAlexaCompanionConversationState({
                  flowKey: 'person_followup',
                  subjectKind: 'person',
                  summaryText: `follow-up about ${personName || 'that person'}`,
                  guidanceGoal:
                    conversationState?.subjectKind === 'household' ||
                    conversationState?.styleHints.guidanceGoal ===
                      'family_guidance'
                      ? 'family_guidance'
                      : 'shared_plans',
                  subjectData: {
                    personName,
                    activePeople: personName ? [personName] : undefined,
                  },
                  prioritizationLens: 'family',
                  hasActionItem: true,
                  hasRiskSignal: conversationState?.styleHints.hasRiskSignal,
                  reminderCandidate:
                    conversationState?.styleHints.reminderCandidate,
                })
              : buildAlexaCompanionConversationState({
                  flowKey: conversationState?.flowKey || 'followup',
                  subjectKind: conversationState?.subjectKind || 'general',
                  summaryText:
                    conversationState?.summaryText || 'recent assistant context',
                  guidanceGoal:
                    resolution.action === 'action_guidance'
                      ? 'action_follow_through'
                      : resolution.action === 'risk_check'
                        ? 'risk_check'
                        : conversationState?.styleHints.guidanceGoal ||
                          'daily_brief',
                  subjectData: conversationState?.subjectData || {},
                  supportedFollowups:
                    conversationState?.supportedFollowups ||
                    baseFollowupsForSubject('general'),
                  prioritizationLens:
                    conversationState?.styleHints.prioritizationLens ||
                    'general',
                  hasActionItem:
                    resolution.action === 'action_guidance'
                      ? true
                      : conversationState?.styleHints.hasActionItem,
                  hasRiskSignal:
                    resolution.action === 'risk_check'
                      ? true
                      : conversationState?.styleHints.hasRiskSignal,
                  reminderCandidate:
                    conversationState?.styleHints.reminderCandidate,
                });

        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaConversationalFollowupPrompt(resolution.action, {
            conversationSummary: conversationState?.summaryText,
            followupText,
            personName,
          }),
          {
            conversationState: nextState,
            proactiveSignalText: followupText,
          },
        );
      }

      if (intentName === ALEXA_MEMORY_CONTROL_INTENT) {
        const memoryCommand = getIntentSlotValue(
          handlerInput.requestEnvelope,
          'memoryCommand',
        );
        if (!memoryCommand) {
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'fallback',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(
              'You can say be more direct, remember this, or ask why I said that.',
            )
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .addElicitSlotDirective('memoryCommand', requestIntent)
            .getResponse();
        }

        const directnessPriorContext =
          resolveAlexaCompanionPriorContext(conversationState);
        if (
          directnessPriorContext &&
          conversationState &&
          isDirectnessMemoryCommand(memoryCommand)
        ) {
          const localResponse = await buildDailyCompanionResponse(
            'be a little more direct',
            {
              channel: 'alexa',
              groupFolder: linked.account.groupFolder,
              tasks: getAllTasks().filter(
                (task) => task.group_folder === linked.account.groupFolder,
              ),
              priorContext: directnessPriorContext,
            },
          );
          if (localResponse) {
            const nextState = preserveAlexaConversationFrameForStyleChange(
              conversationState,
              buildAlexaStateFromDailyCompanion(
                {
                  ...conversationState,
                  styleHints: {
                    ...conversationState.styleHints,
                    responseStyle: 'short_direct',
                  },
                },
                localResponse,
              ),
            );
            saveAlexaConversationState(
              linked.principalKey,
              linked.account.accessTokenHash,
              linked.account.groupFolder,
              nextState,
            );
            logger.info(
              {
                requestId: handlerInput.requestEnvelope.request.requestId,
                requestType: getRequestType(handlerInput.requestEnvelope),
                intentName,
                groupFolder: linked.account.groupFolder,
                mode: localResponse.mode,
                leadReason: localResponse.leadReason,
                signalsUsed: localResponse.signalsUsed,
                usedThreadTitles: localResponse.context.usedThreadTitles,
                responseSource: 'local_companion',
              },
              'Alexa daily companion answered locally',
            );
            recordHandledRequest(handlerInput.requestEnvelope, {
              responseSource: 'local_companion',
              linked: true,
              groupFolder: linked.account.groupFolder,
            });
            return handlerInput.responseBuilder
              .speak(localResponse.reply)
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
        }

        if (
          isBareReference(memoryCommand) &&
          conversationState?.supportedFollowups.includes('save_that')
        ) {
          const personName = conversationState?.subjectData.personName;
          return runLinkedAlexaTurn(
            handlerInput,
            config,
            assistantName,
            authorization.principal,
            linked,
            buildAlexaConversationalFollowupPrompt('save_that', {
              conversationSummary:
                conversationState?.subjectData.lastRecommendation ||
                conversationState?.summaryText,
              followupText: memoryCommand,
              personName,
            }),
            {
              conversationState: buildAlexaBridgeConversationState(
                memoryCommand,
                conversationState,
              ),
              proactiveSignalText: memoryCommand,
            },
          );
        }

        const memoryResult = handlePersonalizationCommand({
          groupFolder: linked.account.groupFolder,
          channel: 'alexa',
          text: memoryCommand,
          conversationSummary: conversationState?.summaryText,
          factIdHint: getAlexaConversationReferencedFactId(conversationState),
        });
        if (memoryResult.handled) {
          if (memoryResult.referencedFactId) {
            saveAlexaConversationState(
              linked.principalKey,
              linked.account.accessTokenHash,
              linked.account.groupFolder,
              buildAlexaCompanionConversationState({
                flowKey: 'memory_control',
                subjectKind: 'memory_fact',
                summaryText: memoryResult.responseText || 'memory control',
                guidanceGoal: 'explainability',
                supportedFollowups: ['memory_control'],
                subjectData: { profileFactId: memoryResult.referencedFactId },
              }),
            );
          }
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'barrier',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(memoryResult.responseText || 'Okay.')
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }

        const lifeThreadResponse = runLifeThreadCommand(
          handlerInput,
          linked,
          memoryCommand,
          conversationState,
        );
        if (lifeThreadResponse) {
          return lifeThreadResponse;
        }

        return runOpenConversationTurn(
          handlerInput,
          authorization,
          linked,
          memoryCommand,
          conversationState,
        );
      }

      if (intentName === ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT) {
        const leadTimeText = getIntentSlotValue(
          handlerInput.requestEnvelope,
          'leadTime',
        );
        if (!leadTimeText) {
          saveAlexaPendingSession(
            linked.principalKey,
            linked.account.accessTokenHash,
            'capture_reminder_lead_time',
            {},
          );
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'barrier',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(buildReminderLeadTimeQuestion(assistantName))
            .reprompt(buildReminderLeadTimeQuestion(assistantName))
            .addElicitSlotDirective('leadTime', requestIntent)
            .getResponse();
        }

        saveAlexaPendingSession(
          linked.principalKey,
          linked.account.accessTokenHash,
          'confirm_reminder_before_next_meeting',
          { leadTimeText },
        );
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak(buildReminderConfirmationSpeech(assistantName, leadTimeText))
          .reprompt('Say yes to save it, or no to cancel.')
          .getResponse();
      }

      if (intentName === ALEXA_SAVE_FOR_LATER_INTENT) {
        const captureText = getIntentSlotValue(
          handlerInput.requestEnvelope,
          'captureText',
        );
        if (!captureText || isBareReference(captureText)) {
          saveAlexaPendingSession(
            linked.principalKey,
            linked.account.accessTokenHash,
            'capture_save_for_later_content',
            {},
          );
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'barrier',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(buildSaveForLaterQuestion(assistantName))
            .reprompt(buildSaveForLaterQuestion(assistantName))
            .addElicitSlotDirective('captureText', requestIntent)
            .getResponse();
        }

        saveAlexaPendingSession(
          linked.principalKey,
          linked.account.accessTokenHash,
          'confirm_save_for_later',
          { captureText },
        );
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak(
            buildSaveForLaterConfirmationSpeech(assistantName, captureText),
          )
          .reprompt('Say yes to save it, or no to cancel.')
          .getResponse();
      }

      if (intentName === ALEXA_DRAFT_FOLLOW_UP_INTENT) {
        const meetingReference = getIntentSlotValue(
          handlerInput.requestEnvelope,
          'meetingReference',
        );
        if (!meetingReference) {
          saveAlexaPendingSession(
            linked.principalKey,
            linked.account.accessTokenHash,
            'capture_follow_up_reference',
            {},
          );
          recordHandledRequest(handlerInput.requestEnvelope, {
            responseSource: 'barrier',
            linked: true,
            groupFolder: linked.account.groupFolder,
          });
          return handlerInput.responseBuilder
            .speak(buildDraftFollowUpQuestion())
            .reprompt(buildDraftFollowUpQuestion())
            .addElicitSlotDirective('meetingReference', requestIntent)
            .getResponse();
        }

        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_DRAFT_FOLLOW_UP_INTENT, {
            meetingReference,
          }),
          {
            conversationState: buildAlexaCompanionConversationState({
              flowKey: 'draft_follow_up',
              subjectKind: 'draft',
              summaryText: `a follow-up draft for ${meetingReference}`,
              guidanceGoal: 'action_follow_through',
              subjectData: { meetingReference },
              prioritizationLens: 'work',
              hasActionItem: true,
            }),
            proactiveSignalText: `draft a follow up for ${meetingReference}`,
          },
        );
      }

      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(buildAlexaFallbackSpeech(assistantName))
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  const YesIntentHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent'
      );
    },
    async handle(handlerInput: HandlerInput) {
      const authorization = authorizeAlexaRequest(
        handlerInput.requestEnvelope,
        config,
        assistantName,
      );
      if (!authorization.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return buildBarrierResponse(handlerInput, authorization);
      }

      const linkedResolution = resolveLinkedContext(
        handlerInput,
        authorization.principal,
      );
      if (!linkedResolution.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return linkedResolution.response;
      }

      const linked = linkedResolution.linked;
      const conversationState = loadAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const now = getRequestTimestampDate(handlerInput.requestEnvelope);
      const pendingConversationCreate = parseAlexaPendingCalendarCreate(
        conversationState,
      );
      if (
        pendingConversationCreate?.step === 'confirm_create' &&
        pendingConversationCreate.selectedCalendarId
      ) {
        const result = await executeAlexaCalendarCreate({
          linked,
          conversationState,
          draft: pendingConversationCreate.draft,
          calendarId: pendingConversationCreate.selectedCalendarId,
          calendars: pendingConversationCreate.calendars.map((calendar) => ({
            ...calendar,
            accessRole: 'owner',
            writable: true,
            selected: true,
          })),
          now,
        });
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'local_companion',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak(result.speech)
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }
      const pendingConversationAction = parseAlexaPendingCalendarEventAction(
        conversationState,
        now,
      );
      if (pendingConversationAction?.step === 'confirm') {
        const result = await executeAlexaCalendarEventAction({
          linked,
          conversationState,
          state: pendingConversationAction,
          now,
        });
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'local_companion',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak(result.speech)
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }
      const pending = loadAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      if (!pending) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'fallback',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak(`There is nothing waiting for a yes right now.`)
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }

      const payload = parseAlexaSessionPayload(pending);
      clearAlexaPendingSession(linked.principalKey);

      if (pending.pendingKind === 'confirm_reminder_before_next_meeting') {
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT, {
            leadTimeText: payload.leadTimeText,
          }),
          {
            conversationState: buildAlexaCompanionConversationState({
              flowKey: 'before_next_meeting',
              subjectKind: 'meeting',
              summaryText: 'your next meeting and a reminder before it',
              guidanceGoal: 'action_follow_through',
              prioritizationLens: 'meeting',
              hasActionItem: true,
              reminderCandidate: true,
            }),
          },
        );
      }

      if (pending.pendingKind === 'confirm_save_for_later') {
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_SAVE_FOR_LATER_INTENT, {
            captureText: payload.captureText,
          }),
          {
            conversationState: buildAlexaCompanionConversationState({
              flowKey: 'save_for_later',
              subjectKind: 'saved_item',
              summaryText: payload.captureText || 'saved follow-through',
              guidanceGoal: 'action_follow_through',
              subjectData: { savedText: payload.captureText },
              hasActionItem: true,
            }),
          },
        );
      }

      if (pending.pendingKind === 'confirm_companion_completion') {
        const completionResponse = await runCompanionActionCompletion(
          handlerInput,
          authorization,
          linked,
          (payload.action as import('./types.js').AlexaConversationFollowupAction) ||
            'send_details',
          payload.originalUtterance || 'send me the details',
          payload.companionContinuationJson
            ? {
                ...(conversationState ||
                  buildAlexaCompanionConversationState({
                    flowKey: 'companion_handoff',
                    subjectKind: 'saved_item',
                    summaryText:
                      payload.conversationSummary || payload.replyText || 'recent context',
                    guidanceGoal: 'action_follow_through',
                  })),
                subjectData: {
                  ...(conversationState?.subjectData || {}),
                  companionContinuationJson: payload.companionContinuationJson,
                  lastAnswerSummary:
                    payload.replyText ||
                    conversationState?.subjectData.lastAnswerSummary,
                },
                summaryText:
                  payload.conversationSummary ||
                  conversationState?.summaryText ||
                  payload.replyText ||
                  'recent context',
              }
            : conversationState,
        );
        if (completionResponse) {
          return completionResponse;
        }
      }

      if (
        pending.pendingKind === 'confirm_profile_fact' &&
        payload.profileFactId &&
        acceptProposedProfileFact(payload.profileFactId)
      ) {
        saveAlexaConversationState(
          linked.principalKey,
          linked.account.accessTokenHash,
          linked.account.groupFolder,
          buildAlexaCompanionConversationState({
            flowKey: 'memory_control',
            subjectKind: 'memory_fact',
            summaryText: payload.profileAskText || 'remembered preference',
            guidanceGoal: 'explainability',
            supportedFollowups: ['memory_control'],
            subjectData: { profileFactId: payload.profileFactId },
          }),
        );
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder
          .speak('Okay. I will remember that.')
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }

      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(`Please answer the question first.`)
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  const NoIntentHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent'
      );
    },
    async handle(handlerInput: HandlerInput) {
      const authorization = authorizeAlexaRequest(
        handlerInput.requestEnvelope,
        config,
        assistantName,
      );
      if (!authorization.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return buildBarrierResponse(handlerInput, authorization);
      }

      const linked = resolveAlexaLinkedAccount(
        authorization.principal,
        assistantName,
      );
      if (!linked.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return handlerInput.responseBuilder.speak('Okay.').getResponse();
      }

      const pending = loadAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const conversationState = loadAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const pendingConversationCreate = parseAlexaPendingCalendarCreate(
        conversationState,
      );
      const pendingConversationAction = parseAlexaPendingCalendarEventAction(
        conversationState,
      );
      const pendingReminderBody =
        conversationState?.subjectData.pendingReminderBody?.trim() || undefined;
      clearAlexaPendingSession(linked.principalKey);

      if (!pending && !pendingConversationCreate && !pendingConversationAction && !pendingReminderBody) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'fallback',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder.speak('Okay.').getResponse();
      }

      if (pendingConversationCreate || pendingConversationAction || pendingReminderBody) {
        saveLinkedConversationState(
          linked,
          buildAlexaCompanionConversationState({
            flowKey: conversationState?.flowKey || 'assistant_cancelled',
            subjectKind: conversationState?.subjectKind || 'general',
            summaryText:
              pendingConversationCreate?.draft.title ||
              pendingConversationAction?.sourceEvent.title ||
              pendingReminderBody ||
              conversationState?.summaryText ||
              'Okay.',
            guidanceGoal:
              conversationState?.styleHints.guidanceGoal || 'action_follow_through',
            subjectData: clearAlexaAssistantPendingState(conversationState),
            supportedFollowups:
              conversationState?.supportedFollowups || ['anything_else'],
            prioritizationLens:
              conversationState?.styleHints.prioritizationLens || 'general',
            responseSource:
              conversationState?.styleHints.responseSource || 'local_companion',
          }),
        );
        const speech = pendingConversationCreate
          ? `Okay, I won't add that to your calendar.`
          : pendingConversationAction?.action === 'delete'
            ? `Okay, I won't cancel that event.`
            : pendingConversationAction
              ? `Okay, I won't change that event.`
              : `Okay, I won't set that reminder.`;
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'local_companion',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder.speak(speech).getResponse();
      }

      if (!pending) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'fallback',
          linked: true,
          groupFolder: linked.account.groupFolder,
        });
        return handlerInput.responseBuilder.speak('Okay.').getResponse();
      }

      const payload = parseAlexaSessionPayload(pending);

      const speech =
        pending.pendingKind === 'confirm_reminder_before_next_meeting'
          ? `Okay, I will not save that reminder.`
          : pending.pendingKind === 'confirm_save_for_later'
            ? `Okay, I will not save that for later.`
            : pending.pendingKind === 'confirm_companion_completion'
              ? `Okay, I will not send that to Telegram.`
            : pending.pendingKind === 'confirm_profile_fact'
              ? (() => {
                  if (payload.profileFactId) {
                    rejectProposedProfileFact(payload.profileFactId);
                  }
                  return `Okay, I will not keep that.`;
                })()
            : `Okay, never mind.`;

      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'barrier',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder.speak(speech).getResponse();
    },
  };

  const HelpHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
      );
    },
    handle(handlerInput: HandlerInput) {
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'help',
      });
      return handlerInput.responseBuilder
        .speak(helpSpeech)
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  const ExitHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(
          getIntentName(handlerInput.requestEnvelope),
        )
      );
    },
    handle(handlerInput: HandlerInput) {
      const principal = extractPrincipal(handlerInput.requestEnvelope);
      clearAlexaPendingSession(
        `alexa:${principal.personId?.trim() || principal.userId.trim()}`,
      );
      clearAlexaConversationState(
        `alexa:${principal.personId?.trim() || principal.userId.trim()}`,
      );
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
      });
      return handlerInput.responseBuilder
        .speak('Okay. Andrea will be right here when you need her again.')
        .getResponse();
    },
  };

  const FallbackHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent'
      );
    },
    handle(handlerInput: HandlerInput) {
      return respondWithAlexaFallback(handlerInput);
    },
  };

  const UnknownIntentHandler = {
    canHandle(handlerInput: HandlerInput) {
      return getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
    },
    handle(handlerInput: HandlerInput) {
      const authorization = authorizeAlexaRequest(
        handlerInput.requestEnvelope,
        config,
        assistantName,
      );
      if (!authorization.ok) {
        recordHandledRequest(handlerInput.requestEnvelope, {
          responseSource: 'barrier',
        });
        return buildBarrierResponse(handlerInput, authorization);
      }

      return respondWithAlexaFallback(handlerInput);
    },
  };

  const SessionEndedRequestHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest'
      );
    },
    handle(handlerInput: HandlerInput) {
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
      });
      return handlerInput.responseBuilder.getResponse();
    },
  };

  const ErrorHandler = {
    canHandle() {
      return true;
    },
    handle(handlerInput: HandlerInput, error: Error) {
      logger.error({ err: error }, 'Alexa skill request failed');
      const speech = buildGracefulDegradedReply({
        kind: 'assistant_runtime_unavailable',
        channel: 'alexa',
        text: 'can you still help',
      });
      return handlerInput.responseBuilder
        .speak(shapeAlexaSpeech(speech))
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  return SkillBuilders.custom()
    .withSkillId(config.skillId)
    .addRequestHandlers(
      LaunchRequestHandler,
      PersonalIntentHandler,
      YesIntentHandler,
      NoIntentHandler,
      HelpHandler,
      ExitHandler,
      FallbackHandler,
      UnknownIntentHandler,
      SessionEndedRequestHandler,
    )
    .addErrorHandlers(ErrorHandler)
    .create();
}

async function readRawBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > ALEXA_REQUEST_LIMIT_BYTES) {
        reject(new Error('Alexa request body exceeded size limit'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function verifyAlexaRequest(
  rawBody: string,
  headers: IncomingHttpHeaders,
  config: AlexaConfig,
): Promise<void> {
  if (!config.verifySignature) return;

  const verifiers = [
    new SkillRequestSignatureVerifier(),
    new TimestampVerifier(),
  ];
  for (const verifier of verifiers) {
    await verifier.verify(rawBody, headers);
  }
}

async function invokeAlexaSkill(
  skill: SkillLike,
  rawBody: string,
  headers: IncomingHttpHeaders,
  config: AlexaConfig,
): Promise<ResponseEnvelope> {
  await verifyAlexaRequest(rawBody, headers, config);
  const requestEnvelope = JSON.parse(rawBody) as RequestEnvelope;
  assertTrustedSkillRequest(requestEnvelope, config);
  const receivedState = buildAlexaSignedRequestState(requestEnvelope, {
    applicationIdVerified: true,
    responseSource: 'received_trusted_request',
  });
  const existingState = readAlexaSignedRequestProofState();
  writeAlexaSignedRequestProofState({
    lastSignedRequest: receivedState,
    lastHandledProofIntent: existingState.lastHandledProofIntent,
  });
  logger.info(
    {
      requestId: receivedState.requestId,
      requestType: receivedState.requestType,
      intentName: receivedState.intentName,
      applicationIdVerified: true,
      linkingResolved: false,
      groupFolder: undefined,
      responseSource: receivedState.responseSource,
    },
    'Alexa signed request received',
  );
  return skill.invoke(requestEnvelope);
}

export async function startAlexaServer(
  config = resolveAlexaConfig(),
  deps: AlexaCompanionDeps = {},
): Promise<AlexaRuntime | null> {
  if (!config) return null;

  const skill = createAlexaSkill(config, deps);
  const oauthConfig = resolveAlexaOAuthConfig(process.env, config.path);
  let running = false;

  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(
        request.url || '/',
        `http://${request.headers.host || `${config.host}:${config.port}`}`,
      ).pathname;

      if (request.method === 'GET' && pathname === config.healthPath) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, assistant: ASSISTANT_NAME }));
        return;
      }

      if (
        await handleAlexaOAuthRequest(
          request,
          response,
          config.path,
          oauthConfig,
        )
      ) {
        return;
      }

      if (request.method !== 'POST' || pathname !== config.path) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const rawBody = await readRawBody(request);
      const responseEnvelope = await invokeAlexaSkill(
        skill,
        rawBody,
        request.headers,
        config,
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseEnvelope));
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.warn({ err }, 'Alexa HTTP request failed');
      const detail = getUserFacingErrorDetail(err);
      const rawDetail =
        err instanceof Error
          ? err.message.toLowerCase()
          : String(err).toLowerCase();
      const statusCode =
        rawDetail.includes('verification') ||
        rawDetail.includes('invalid') ||
        rawDetail.includes('skill id') ||
        rawDetail.includes('application id') ||
        rawDetail.includes('request rejected') ||
        detail.toLowerCase().includes('verification') ||
        detail.toLowerCase().includes('invalid')
          ? 400
          : 500;
      response.writeHead(statusCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Alexa request rejected' }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      running = true;
      logger.info(
        {
          host: config.host,
          port: config.port,
          path: config.path,
          verifySignature: config.verifySignature,
        },
        'Alexa voice ingress listening',
      );
      resolve();
    });
  });

  return {
    close: async () => {
      if (!running) return;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      running = false;
    },
    getStatus: () => {
      const address = server.address();
      const boundPort =
        address && typeof address !== 'string' ? address.port : config.port;
      return getAlexaStatus(config, running, boundPort, oauthConfig);
    },
  };
}

export async function invokeAlexaHttpRequest(
  server: Server,
  rawBody: string,
  pathValue = DEFAULT_ALEXA_PATH,
): Promise<{ status: number; body: string }> {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Alexa test server address unavailable');
  }

  const response = await fetch(`http://127.0.0.1:${address.port}${pathValue}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });

  return {
    status: response.status,
    body: await response.text(),
  };
}
