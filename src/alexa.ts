import http, { type IncomingHttpHeaders, type Server } from 'http';

import {
  getIntentName,
  getRequestType,
  SkillBuilders,
  type HandlerInput,
} from 'ask-sdk-core';
import { type RequestEnvelope, type ResponseEnvelope } from 'ask-sdk-model';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';

import {
  type AlexaBridgeConfig,
  type AlexaPrincipal,
  runAlexaAssistantTurn,
} from './alexa-bridge.js';
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
const DEFAULT_ALEXA_HELP =
  'Try asking Andrea to research a topic, remind you about something important, or help with a shopping idea before she asks for any approvals.';
const DEFAULT_ALEXA_REPROMPT = 'What would you like Andrea to do?';

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
      kind: 'link-account' | 'forbidden';
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
    `- Account linking required: ${status.requireAccountLinking ? 'yes' : 'no'}`,
    `- Allowed Alexa IDs: ${status.allowedUserIdsCount || 0}`,
    status.targetGroupFolder
      ? `- Target group folder: ${status.targetGroupFolder}`
      : '- Target group folder: auto (main when available, otherwise isolated voice workspace)',
    '- Tip: expose this endpoint through HTTPS before connecting the skill in the Alexa developer console.',
  ].join('\n');
}

function buildWelcomeSpeech(assistantName: string): string {
  return [
    `${assistantName} is here.`,
    'You can ask for research, reminders, shopping prep, or a quick brainy assist.',
    'She is charming, practical, and still refuses surprise invoices.',
  ].join(' ');
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

function extractPrincipal(requestEnvelope: RequestEnvelope): AlexaPrincipal {
  const system = requestEnvelope.context?.System;
  const user = system?.user;
  const person = requestEnvelope.context?.System.person;

  return {
    userId: person?.personId || user?.userId || 'anonymous-alexa-user',
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

  if (config.requireAccountLinking && !principal.accessToken) {
    logger.info('Alexa request rejected because account linking is required');
    return {
      ok: false,
      kind: 'link-account',
      speech: `${assistantName} needs account linking before handling this request. Please link the skill in the Alexa app and then try again.`,
      reprompt: 'Link the skill in the Alexa app, then ask Andrea again.',
    };
  }

  return { ok: true, principal };
}

function buildAuthorizationResponse(
  handlerInput: HandlerInput,
  authorization: Extract<AuthorizationResult, { ok: false }>,
) {
  const builder = handlerInput.responseBuilder
    .speak(authorization.speech)
    .reprompt(authorization.reprompt || DEFAULT_ALEXA_REPROMPT);
  if (authorization.kind === 'link-account') {
    builder.withLinkAccountCard();
  }
  return builder.getResponse();
}

function getIntentSlotValue(requestEnvelope: RequestEnvelope): string {
  const request = requestEnvelope.request;
  if (request.type !== 'IntentRequest') return '';
  const candidateSlots = ['utterance', 'query', 'request'];
  for (const slotName of candidateSlots) {
    const slot = request.intent.slots?.[slotName];
    if (slot?.value?.trim()) return slot.value.trim();
  }
  return '';
}

export function createAlexaSkill(config: AlexaConfig): SkillLike {
  const assistantName = ASSISTANT_NAME;

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
        return buildAuthorizationResponse(handlerInput, authorization);
      }

      return handlerInput.responseBuilder
        .speak(buildWelcomeSpeech(assistantName))
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  const AskAndreaIntentHandler = {
    canHandle(handlerInput: HandlerInput) {
      return (
        getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
        getIntentName(handlerInput.requestEnvelope) === 'AskAndreaIntent'
      );
    },
    async handle(handlerInput: HandlerInput) {
      const authorization = authorizeAlexaRequest(
        handlerInput.requestEnvelope,
        config,
        assistantName,
      );
      if (!authorization.ok) {
        return buildAuthorizationResponse(handlerInput, authorization);
      }

      const utterance = getIntentSlotValue(handlerInput.requestEnvelope);
      if (!utterance) {
        return handlerInput.responseBuilder
          .speak(
            `${assistantName} did not catch the request yet. Ask me to research something, help with a task, or prep a shopping idea.`,
          )
          .reprompt(DEFAULT_ALEXA_REPROMPT)
          .getResponse();
      }

      const result = await runAlexaAssistantTurn(
        {
          utterance,
          principal: authorization.principal,
        },
        {
          assistantName,
          targetGroupFolder: config.targetGroupFolder,
        },
      );
      const speech =
        normalizeAlexaSpeech(result.text) ||
        `${assistantName} is thinking, but the answer came back empty. Please try asking again.`;

      return handlerInput.responseBuilder
        .speak(speech)
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
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
        .speak(DEFAULT_ALEXA_HELP)
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
        .speak(
          `${assistantName} can help with research, reminders, coding questions, and shopping prep. ${DEFAULT_ALEXA_HELP}`,
        )
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
        return buildAuthorizationResponse(handlerInput, authorization);
      }

      return handlerInput.responseBuilder
        .speak(
          `${assistantName} can help with research, reminders, shopping prep, and coding support. Try saying: ask Andrea to summarize my priorities for today.`,
        )
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
          `Sorry, ${assistantName} hit a voice-service snag: ${normalizeAlexaSpeech(getUserFacingErrorDetail(error))}`,
        )
        .reprompt(DEFAULT_ALEXA_REPROMPT)
        .getResponse();
    },
  };

  return SkillBuilders.custom()
    .withSkillId(config.skillId)
    .addRequestHandlers(
      LaunchRequestHandler,
      AskAndreaIntentHandler,
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
      const statusCode =
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
