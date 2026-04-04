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
  buildAlexaPersonalPrompt,
  buildAlexaWelcomeSpeech,
  buildDraftFollowUpQuestion,
  buildReminderConfirmationSpeech,
  buildReminderLeadTimeQuestion,
  buildSaveForLaterConfirmationSpeech,
  buildSaveForLaterQuestion,
  isAlexaPersonalIntent,
} from './alexa-v1.js';
import { ASSISTANT_NAME } from './config.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { type AlexaCompanionGuidanceGoal } from './types.js';
import { getUserFacingErrorDetail } from './user-facing-error.js';

const ALEXA_REQUEST_LIMIT_BYTES = 256 * 1024;
const DEFAULT_ALEXA_HOST = '127.0.0.1';
const DEFAULT_ALEXA_PORT = 4300;
const DEFAULT_ALEXA_PATH = '/alexa';
const DEFAULT_ALEXA_REPROMPT = 'What would you like to know?';

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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw;
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
  };
}

export function formatAlexaStatusMessage(status: AlexaStatus): string {
  if (!status.enabled) {
    return [
      '*Alexa Voice*',
      '- Status: disabled',
      '- Detail: set `ALEXA_SKILL_ID` to enable the Alexa voice ingress.',
      '- Andrea note: no skill ID means no Echo serenades tonight.',
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

function isBareReference(value: string): boolean {
  return ['that', 'this', 'it', 'something'].includes(
    value.trim().toLowerCase(),
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
    },
  );
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
      saveAlexaConversationState(
        linked.principalKey,
        linked.account.accessTokenHash,
        linked.account.groupFolder,
        {
          ...options.conversationState,
          summaryText:
            options.conversationState.summaryText.trim() || speech,
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

    return handlerInput.responseBuilder
      .speak(finalSpeech)
      .reprompt(reprompt)
      .getResponse();
  } catch (err) {
    if (err instanceof AlexaTargetGroupMissingError) {
      return buildBarrierResponse(
        handlerInput,
        buildSetupBarrier(assistantName, err.groupFolder),
      );
    }
    throw err;
  }
}

export function createAlexaSkill(config: AlexaConfig): SkillLike {
  const assistantName = ASSISTANT_NAME;
  const helpSpeech = buildAlexaHelpSpeech(assistantName);

  const resolveLinkedContext = (
    handlerInput: HandlerInput,
    principal: AlexaPrincipal,
  ) => {
    const linked = resolveAlexaLinkedAccount(principal, assistantName);
    if (!linked.ok) {
      return {
        ok: false as const,
        response: buildBarrierResponse(handlerInput, linked),
      };
    }
    return { ok: true as const, linked };
  };

  const runCompanionIntent = (
    handlerInput: HandlerInput,
    principal: AlexaPrincipal,
    linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
    intentName: string,
    conversationState: AlexaConversationState,
    options: Parameters<typeof buildAlexaPersonalPrompt>[1] = {},
    proactiveSignalText?: string,
  ) => {
    clearAlexaPendingSession(linked.principalKey);
    return runLinkedAlexaTurn(
      handlerInput,
      config,
      assistantName,
      principal,
      linked,
      buildAlexaPersonalPrompt(intentName, options),
      {
        conversationState,
        proactiveSignalText,
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
        return buildBarrierResponse(handlerInput, authorization);
      }

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
        return buildBarrierResponse(handlerInput, authorization);
      }

      const linkedResolution = resolveLinkedContext(
        handlerInput,
        authorization.principal,
      );
      if (!linkedResolution.ok) {
        return linkedResolution.response;
      }

      const linked = linkedResolution.linked;
      const requestIntent = buildRequestIntent(handlerInput.requestEnvelope);
      if (!requestIntent) {
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

      if (intentName === ALEXA_MY_DAY_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_MY_DAY_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'my_day',
            subjectKind: 'day_brief',
            summaryText: 'today and what matters most',
            guidanceGoal: 'daily_brief',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
          }),
          {},
          'what should I know about today',
        );
      }

      if (intentName === ALEXA_UPCOMING_SOON_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_UPCOMING_SOON_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'upcoming_soon',
            subjectKind: 'event',
            summaryText: 'what is coming up soon',
            guidanceGoal: 'upcoming_soon',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
          }),
          {},
          'what do I have coming up soon',
        );
      }

      if (intentName === ALEXA_WHAT_NEXT_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_WHAT_NEXT_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'what_next',
            subjectKind: 'event',
            summaryText: 'what should I do next',
            guidanceGoal: 'next_action',
            prioritizationLens: 'general',
            hasActionItem: true,
            reminderCandidate: true,
          }),
          {},
          'what should I do next',
        );
      }

      if (intentName === ALEXA_BEFORE_NEXT_MEETING_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_BEFORE_NEXT_MEETING_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'before_next_meeting',
            subjectKind: 'meeting',
            summaryText: 'your next meeting and what to handle before it',
            guidanceGoal: 'meeting_prep',
            prioritizationLens: 'meeting',
            hasActionItem: true,
            hasRiskSignal: true,
            reminderCandidate: true,
          }),
          {},
          'what should I handle before my next meeting',
        );
      }

      if (intentName === ALEXA_TOMORROW_CALENDAR_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_TOMORROW_CALENDAR_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'tomorrow_calendar',
            subjectKind: 'day_brief',
            summaryText: 'tomorrow and what it looks like',
            guidanceGoal: 'tomorrow_brief',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
          }),
          {},
          'what is on my calendar tomorrow',
        );
      }

      if (intentName === ALEXA_CANDACE_UPCOMING_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_CANDACE_UPCOMING_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'candace_upcoming',
            subjectKind: 'person',
            summaryText: 'shared plans with Candace',
            guidanceGoal: 'shared_plans',
            subjectData: { personName: 'Candace', activePeople: ['Candace'] },
            prioritizationLens: 'family',
            hasActionItem: true,
          }),
          {},
          'what do Candace and I have coming up',
        );
      }

      if (intentName === ALEXA_FAMILY_UPCOMING_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_FAMILY_UPCOMING_INTENT,
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
          }),
          {},
          'what does the family have going on',
        );
      }

      if (intentName === ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'what_matters_most_today',
            subjectKind: 'day_brief',
            summaryText: 'what matters most today',
            guidanceGoal: 'what_matters_most',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            hasRiskSignal: true,
          }),
          {},
          'what matters most today',
        );
      }

      if (intentName === ALEXA_ANYTHING_IMPORTANT_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_ANYTHING_IMPORTANT_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'anything_important',
            subjectKind: 'day_brief',
            summaryText: 'anything important to know or keep in mind',
            guidanceGoal: 'anything_important',
            prioritizationLens: 'general',
            hasRiskSignal: true,
            hasActionItem: true,
          }),
          {},
          'anything I should know',
        );
      }

      if (intentName === ALEXA_WHAT_AM_I_FORGETTING_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_WHAT_AM_I_FORGETTING_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'what_am_i_forgetting',
            subjectKind: 'day_brief',
            summaryText: 'likely loose ends, prep gaps, and what you may be forgetting',
            guidanceGoal: 'what_am_i_forgetting',
            prioritizationLens: 'general',
            hasActionItem: true,
            hasRiskSignal: true,
            reminderCandidate: true,
          }),
          {},
          'what am I forgetting',
        );
      }

      if (intentName === ALEXA_EVENING_RESET_INTENT) {
        return runCompanionIntent(
          handlerInput,
          authorization.principal,
          linked,
          ALEXA_EVENING_RESET_INTENT,
          buildAlexaCompanionConversationState({
            flowKey: 'evening_reset',
            subjectKind: 'day_brief',
            summaryText: 'what to wrap up today, what to remember tonight, and what to tee up for tomorrow',
            guidanceGoal: 'evening_reset',
            prioritizationLens: 'evening',
            hasActionItem: true,
            reminderCandidate: true,
          }),
          {},
          'give me an evening reset',
        );
      }

      if (intentName === ALEXA_ANYTHING_ELSE_INTENT) {
        if (!conversationState) {
          return handlerInput.responseBuilder
            .speak(
              'I can do that once we have a little more context. Start with what you want to know first.',
            )
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }

        const resolution = resolveAlexaConversationFollowup(
          'anything else',
          conversationState,
        );
        if (!resolution.ok || !resolution.action) {
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
          return handlerInput.responseBuilder
            .speak('What would you like me to follow up on?')
            .reprompt('Say the follow-up in a few words.')
            .addElicitSlotDirective('followupText', requestIntent)
            .getResponse();
        }

        const resolution = resolveAlexaConversationFollowup(
          followupText,
          conversationState,
        );
        if (!resolution.ok || !resolution.action) {
          return handlerInput.responseBuilder
            .speak(resolution.speech || buildAlexaFallbackSpeech(assistantName))
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
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
            return handlerInput.responseBuilder
              .speak(memoryResult.responseText || 'Okay.')
              .reprompt(DEFAULT_ALEXA_REPROMPT)
              .getResponse();
          }
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
          return handlerInput.responseBuilder
            .speak(
              'You can say remember this, what do you remember about me, why did you say that, or be more direct.',
            )
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .addElicitSlotDirective('memoryCommand', requestIntent)
            .getResponse();
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
          return handlerInput.responseBuilder
            .speak(memoryResult.responseText || 'Okay.')
            .reprompt(DEFAULT_ALEXA_REPROMPT)
            .getResponse();
        }
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
        return buildBarrierResponse(handlerInput, authorization);
      }

      const linkedResolution = resolveLinkedContext(
        handlerInput,
        authorization.principal,
      );
      if (!linkedResolution.ok) {
        return linkedResolution.response;
      }

      const linked = linkedResolution.linked;
      const pending = loadAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      if (!pending) {
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
        return handlerInput.responseBuilder
          .speak('Okay. I will remember that.')
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }

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
        return buildBarrierResponse(handlerInput, authorization);
      }

      const linked = resolveAlexaLinkedAccount(
        authorization.principal,
        assistantName,
      );
      if (!linked.ok) {
        return handlerInput.responseBuilder.speak('Okay.').getResponse();
      }

      const pending = loadAlexaPendingSession(
        linked.principalKey,
        linked.account.accessTokenHash,
      );
      clearAlexaPendingSession(linked.principalKey);

      if (!pending) {
        return handlerInput.responseBuilder.speak('Okay.').getResponse();
      }

      const payload = parseAlexaSessionPayload(pending);

      const speech =
        pending.pendingKind === 'confirm_reminder_before_next_meeting'
          ? `Okay, I will not save that reminder.`
          : pending.pendingKind === 'confirm_save_for_later'
            ? `Okay, I will not save that for later.`
            : pending.pendingKind === 'confirm_profile_fact'
              ? (() => {
                  if (payload.profileFactId) {
                    rejectProposedProfileFact(payload.profileFactId);
                  }
                  return `Okay, I will not keep that.`;
                })()
            : `Okay, never mind.`;

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
      return handlerInput.responseBuilder
        .speak(buildAlexaFallbackSpeech(assistantName))
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
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
        return buildBarrierResponse(handlerInput, authorization);
      }

      return handlerInput.responseBuilder
        .speak(buildAlexaFallbackSpeech(assistantName))
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  const SessionEndedRequestHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest'
      );
    },
    handle(handlerInput: HandlerInput) {
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
  return skill.invoke(requestEnvelope);
}

export async function startAlexaServer(
  config = resolveAlexaConfig(),
): Promise<AlexaRuntime | null> {
  if (!config) return null;

  const skill = createAlexaSkill(config);
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
