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
import { planAlexaDialogueTurn } from './alexa-dialogue.js';
import {
  resolveAlexaIntentToCapability,
} from './assistant-capability-router.js';
import {
  executeAssistantCapability,
  type AssistantCapabilityConversationSeed,
} from './assistant-capabilities.js';
import {
  completeAssistantActionFromAlexa,
} from './assistant-action-completion.js';
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
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
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
import { ASSISTANT_NAME, RUNTIME_STATE_DIR } from './config.js';
import {
  buildDailyCompanionResponse,
  type DailyCompanionContext,
} from './daily-companion.js';
import { getAllTasks } from './db.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import {
  handleLifeThreadCommand,
} from './life-threads.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { handleRitualCommand } from './rituals.js';
import {
  type AlexaCompanionGuidanceGoal,
  type CompanionContinuationCandidate,
} from './types.js';
import { getUserFacingErrorDetail } from './user-facing-error.js';
import { normalizeVoicePrompt } from './voice-ready.js';
import type { CompanionHandoffDeps } from './cross-channel-handoffs.js';

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
  try {
    if (!fs.existsSync(ALEXA_LAST_SIGNED_REQUEST_STATE_PATH)) {
      return undefined;
    }
    const raw = fs
      .readFileSync(ALEXA_LAST_SIGNED_REQUEST_STATE_PATH, 'utf8')
      .trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<AlexaSignedRequestState>;
    if (
      !parsed ||
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
  } catch {
    return undefined;
  }
}

function writeAlexaLastSignedRequestState(
  state: AlexaSignedRequestState,
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
  writeAlexaLastSignedRequestState(state);
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
  normalized = normalized.replace(/```[\s\S]*?```/g, ' code snippet omitted ');
  normalized = normalized.replace(/`([^`]+)`/g, '$1');
  normalized = normalized.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1');
  normalized = normalized.replace(/https?:\/\/\S+/g, ' ');
  normalized = normalized.replace(/[*_#>|]/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length > 7000) {
    normalized = `${normalized.slice(0, 6970).trim()} ... I can keep going if you want.`;
  }
  return normalized;
}

export function shapeAlexaSpeech(text: string): string {
  const normalized = normalizeAlexaSpeech(text);
  if (!normalized) return '';

  const sentences =
    normalized
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean) || [];
  const selected: string[] = [];
  let totalLength = 0;

  for (const sentence of sentences) {
    const nextLength =
      totalLength + sentence.length + (selected.length > 0 ? 1 : 0);
    if (selected.length >= 3 || nextLength > 320) break;
    selected.push(sentence);
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

function getRequestTimestampDate(requestEnvelope: RequestEnvelope): Date {
  const raw = requestEnvelope.request.timestamp;
  const parsed = raw ? new Date(raw) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date();
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
      fallbackCount: 0,
      threadId: context.usedThreadIds?.[0],
      threadTitle: context.usedThreadTitles?.[0],
      threadSummaryLines: context.threadSummaryLines || [],
      lastAnswerSummary: context.summaryText,
      lastRecommendation: context.recommendationText || undefined,
      pendingActionText: context.recommendationText || undefined,
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

function buildAlexaStateFromCapabilitySeed(
  seed: AssistantCapabilityConversationSeed,
): AlexaConversationState {
  return buildAlexaCompanionConversationState({
    flowKey: seed.flowKey,
    subjectKind: seed.subjectKind,
    summaryText: seed.summaryText,
    guidanceGoal: seed.guidanceGoal,
    subjectData: seed.subjectData,
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

function baseFollowupsForSubject(
  subjectKind: AlexaConversationState['subjectKind'],
) : import('./types.js').AlexaConversationFollowupAction[] {
  const common: AlexaConversationState['supportedFollowups'] = [
    'anything_else',
    'shorter',
    'say_more',
    'memory_control',
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
      fallbackCount: 0,
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
      .speak(response.reply)
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

  const runCompanionActionCompletion = async (
    handlerInput: HandlerInput,
    authorization: { principal: AlexaPrincipal },
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    action: import('./types.js').AlexaConversationFollowupAction,
    utterance: string,
    conversationState?: AlexaConversationState,
  ) => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: linked.account.groupFolder,
        action,
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
    if (!result.handled) {
      return null;
    }

    if (result.bridgeSaveForLaterText) {
      return runLinkedAlexaTurn(
        handlerInput,
        config,
        assistantName,
        authorization.principal,
        linked,
        buildAlexaPersonalPrompt(ALEXA_SAVE_FOR_LATER_INTENT, {
          captureText: result.bridgeSaveForLaterText,
        }),
        {
          conversationState: buildAlexaCompanionConversationState({
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
        },
      );
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
        action === 'send_details'
          ? conversationState?.subjectData.activeCapabilityId ===
            'media.image_generate'
            ? 'media_handoff'
            : 'research_handoff'
          : 'local_companion',
      linked: true,
      groupFolder: linked.account.groupFolder,
    });
    return handlerInput.responseBuilder
      .speak(result.replyText || 'Okay.')
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
  ) => {
    clearAlexaPendingSession(linked.principalKey);
    const priorCompanionContext = parseDailyCompanionContext(conversationState);
    const result = await executeAssistantCapability({
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
    if (!result.handled) {
      return null;
    }

    if (result.dailyResponse) {
      const nextState = result.conversationSeed
        ? buildAlexaStateFromCapabilitySeed(result.conversationSeed)
        : conversationState ||
          buildAlexaCompanionConversationState({
            flowKey: capability.capabilityId.replace(/\./g, '_'),
            subjectKind: result.dailyResponse.context.subjectKind,
            summaryText: result.dailyResponse.context.summaryText,
            guidanceGoal: 'open_conversation',
            responseSource: 'local_companion',
          });
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
        buildAlexaStateFromCapabilitySeed(result.conversationSeed),
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
    return handlerInput.responseBuilder
      .speak(result.replyText || 'Okay.')
      .reprompt(DEFAULT_ALEXA_REPROMPT)
      .getResponse();
  };

  const runOpenConversationTurn = async (
    handlerInput: HandlerInput,
    principal: AlexaPrincipal,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    utterance: string,
    conversationState?: AlexaConversationState,
  ) => {
    const plan = planAlexaDialogueTurn(utterance, conversationState);
    if (plan.route === 'clarify') {
      recordHandledRequest(handlerInput.requestEnvelope, {
        responseSource: 'fallback',
        linked: true,
        groupFolder: linked.account.groupFolder,
      });
      return handlerInput.responseBuilder
        .speak(
          plan.clarificationSpeech ||
            'I need one quick anchor first. Ask about today, Candace, or what to remember tonight.',
        )
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
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

    return runLinkedAlexaTurn(
      handlerInput,
      config,
      assistantName,
      principal,
      linked,
      buildAlexaOpenConversationPrompt(plan.normalizedText, {
        conversationSummary: conversationState?.summaryText,
      }),
      {
        conversationState: buildAlexaBridgeConversationState(
          plan.normalizedText,
          conversationState,
        ),
        proactiveSignalText: plan.normalizedText,
      },
    );
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
      const pending = loadAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const conversationState = loadAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      const priorCompanionContext = parseDailyCompanionContext(conversationState);

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

      const sharedCapabilityMatch = resolveAlexaIntentToCapability(intentName, {
        slotValue:
          getIntentSlotValue(handlerInput.requestEnvelope, 'followupText') ||
          getIntentSlotValue(handlerInput.requestEnvelope, 'memoryCommand'),
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
        );
        if (capabilityResponse) {
          return capabilityResponse;
        }
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
              'I can do that once we have a little more context. Start with what you want to know first.',
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

        const earlyResolution = resolveAlexaConversationFollowup(
          followupText,
          conversationState,
        );
        if (
          earlyResolution.ok &&
          (earlyResolution.action === 'send_details' ||
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
            authorization.principal,
            linked,
            followupText,
            conversationState,
          );
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
              'You can say remember this, what do you remember about me, why did you say that, or be more direct.',
            )
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .addElicitSlotDirective('memoryCommand', requestIntent)
            .getResponse();
        }

        if (priorCompanionContext && isDirectnessMemoryCommand(memoryCommand)) {
          const localResponse = await buildDailyCompanionResponse(
            'be a little more direct',
            {
              channel: 'alexa',
              groupFolder: linked.account.groupFolder,
              tasks: getAllTasks().filter(
                (task) => task.group_folder === linked.account.groupFolder,
              ),
              priorContext: priorCompanionContext,
            },
          );
          if (localResponse && conversationState) {
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
          authorization.principal,
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
      clearAlexaPendingSession(linked.principalKey);

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
      return handlerInput.responseBuilder
        .speak(
          `Sorry, ${assistantName} hit a voice-service snag: ${shapeAlexaSpeech(getUserFacingErrorDetail(error))}`,
        )
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
  writeAlexaLastSignedRequestState(receivedState);
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
