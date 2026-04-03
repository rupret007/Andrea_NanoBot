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
  ALEXA_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_WHAT_NEXT_INTENT,
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
  const envFile = readEnvFile([
    'ALEXA_SKILL_ID',
    'ALEXA_HOST',
    'ALEXA_PORT',
    'ALEXA_PATH',
    'ALEXA_VERIFY_SIGNATURE',
    'ALEXA_REQUIRE_ACCOUNT_LINKING',
    'ALEXA_ALLOWED_USER_IDS',
    'ALEXA_TARGET_GROUP_FOLDER',
  ]);

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
): AlexaStatus {
  if (!config) {
    return { enabled: false, running: false };
  }

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

async function runLinkedAlexaTurn(
  handlerInput: HandlerInput,
  config: AlexaConfig,
  assistantName: string,
  principal: AlexaPrincipal,
  linked: Extract<ReturnType<typeof resolveAlexaLinkedAccount>, { ok: true }>,
  utterance: string,
) {
  try {
    const result = await runAlexaAssistantTurn(
      {
        utterance,
        principal: {
          ...principal,
          displayName: linked.account.displayName,
        },
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

    return handlerInput.responseBuilder
      .speak(speech)
      .reprompt(DEFAULT_ALEXA_REPROMPT)
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
        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_MY_DAY_INTENT),
        );
      }

      if (intentName === ALEXA_UPCOMING_SOON_INTENT) {
        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_UPCOMING_SOON_INTENT),
        );
      }

      if (intentName === ALEXA_WHAT_NEXT_INTENT) {
        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_WHAT_NEXT_INTENT),
        );
      }

      if (intentName === ALEXA_BEFORE_NEXT_MEETING_INTENT) {
        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_BEFORE_NEXT_MEETING_INTENT),
        );
      }

      if (intentName === ALEXA_TOMORROW_CALENDAR_INTENT) {
        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_TOMORROW_CALENDAR_INTENT),
        );
      }

      if (intentName === ALEXA_CANDACE_UPCOMING_INTENT) {
        clearAlexaPendingSession(linked.principalKey);
        return runLinkedAlexaTurn(
          handlerInput,
          config,
          assistantName,
          authorization.principal,
          linked,
          buildAlexaPersonalPrompt(ALEXA_CANDACE_UPCOMING_INTENT),
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
        );
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

      const speech =
        pending.pendingKind === 'confirm_reminder_before_next_meeting'
          ? `Okay, I will not save that reminder.`
          : pending.pendingKind === 'confirm_save_for_later'
            ? `Okay, I will not save that for later.`
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
      return getAlexaStatus(config, running, boundPort);
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
