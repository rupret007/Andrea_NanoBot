import http, { type IncomingMessage, type ServerResponse } from 'http';

import {
  getAllChats,
  getMessageAction,
  listRecentMessagesForChat,
} from './db.js';
import { readEnvFile } from './env.js';
import {
  buildFieldTrialOperatorTruth,
  type FieldTrialBlueBubblesTruth,
} from './field-trial-readiness.js';
import { logger } from './logger.js';
import {
  applyMessageActionOperation,
  listBlueBubblesMessageActionContinuitySnapshots,
  reconcileBlueBubblesMessageActionContinuity,
  type MessageActionOperation,
} from './message-actions.js';
import { resolveBlueBubblesReplyGateMode } from './messages-fluidity.js';
import {
  type BlueBubblesChannel,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import type {
  BlueBubblesChatSummary,
  BlueBubblesControlApiConfig,
  BlueBubblesControlStatus,
  BlueBubblesExecuteMessageActionRequest,
  BlueBubblesMessageActionOperationKind,
  BlueBubblesMessageView,
  BlueBubblesOpenMessageAction,
  BlueBubblesProofReport,
  SendMessageOptions,
} from './types.js';

interface BlueBubblesControlServerDeps {
  getChannel(): BlueBubblesChannel | null;
  buildTruth?(): FieldTrialBlueBubblesTruth;
  now?(): Date;
}

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toLimit(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function splitPathname(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const body = Buffer.concat(chunks).toString('utf-8').trim();
  if (!body) {
    return {};
  }
  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function clipPreview(value: string | null | undefined, max = 180): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function buildProofReport(truth: FieldTrialBlueBubblesTruth): BlueBubblesProofReport {
  return {
    proofState: truth.proofState,
    blocker: truth.blocker,
    blockerOwner: truth.blockerOwner,
    nextAction: truth.nextAction,
    detail: truth.detail,
    configuredReplyGateMode: truth.configuredReplyGateMode as
      | 'mention_required'
      | 'direct_1to1',
    effectiveReplyGateMode: truth.effectiveReplyGateMode as
      | 'mention_required'
      | 'direct_1to1',
    messageActionProofState: truth.messageActionProofState,
    messageActionProofChatJid: truth.messageActionProofChatJid,
    messageActionProofAt: truth.messageActionProofAt,
    messageActionProofDetail: truth.messageActionProofDetail,
    detectionState: truth.detectionState,
    detectionDetail: truth.detectionDetail,
    detectionNextAction: truth.detectionNextAction,
    transportState: truth.transportState,
    transportDetail: truth.transportDetail,
    webhookRegistrationState: truth.webhookRegistrationState,
    webhookRegistrationDetail: truth.webhookRegistrationDetail,
    recentTargetChatJid: truth.recentTargetChatJid,
    recentTargetAt: truth.recentTargetAt,
    openMessageActionCount: truth.openMessageActionCount,
    continuityState: truth.continuityState,
    proofCandidateChatJid: truth.proofCandidateChatJid,
    activeMessageActionId: truth.activeMessageActionId,
    conversationKind: truth.conversationKind,
    decisionPolicy: truth.decisionPolicy,
    conversationalEligibility: truth.conversationalEligibility,
    requiresExplicitMention: truth.requiresExplicitMention,
    activePresentationAt: truth.activePresentationAt,
    eligibleFollowups: [...truth.eligibleFollowups],
    canonicalSelfThreadChatJid: truth.canonicalSelfThreadChatJid,
    sourceSelfThreadChatJid: truth.sourceSelfThreadChatJid,
  };
}

function buildStatus(params: {
  truth: FieldTrialBlueBubblesTruth;
  channel: BlueBubblesChannel | null;
}): BlueBubblesControlStatus {
  const config = resolveBlueBubblesConfig();
  const snapshot = params.channel?.getControlSnapshot();
  return {
    enabled: snapshot?.enabled ?? config.enabled,
    configured: params.truth.configured,
    connected: params.channel?.isConnected() === true,
    groupFolder: snapshot?.groupFolder || config.groupFolder,
    chatScope: snapshot?.chatScope || params.truth.chatScope,
    sendEnabled: snapshot?.sendEnabled ?? config.sendEnabled,
    listenerHost: snapshot?.listenerHost || config.host,
    listenerPort: snapshot?.listenerPort || config.port,
    configuredBaseUrl: snapshot?.configuredBaseUrl || config.baseUrl,
    activeBaseUrl: snapshot?.activeBaseUrl || params.truth.activeServerBaseUrl || null,
    candidateBaseUrls: snapshot?.candidateBaseUrls || config.baseUrlCandidates,
    publicWebhookUrl: snapshot?.publicWebhookUrl || params.truth.publicWebhookUrl,
    webhookRegistrationState:
      params.truth.webhookRegistrationState,
    webhookRegistrationDetail:
      params.truth.webhookRegistrationDetail,
    transportState: params.truth.transportState,
    transportDetail: params.truth.transportDetail,
    shadowPollLastOkAt: params.truth.shadowPollLastOkAt,
    shadowPollLastError: params.truth.shadowPollLastError,
    shadowPollMostRecentChat: params.truth.shadowPollMostRecentChat,
    configuredReplyGateMode:
      params.truth.configuredReplyGateMode as
        | 'mention_required'
        | 'direct_1to1',
    effectiveReplyGateMode:
      params.truth.effectiveReplyGateMode as
        | 'mention_required'
        | 'direct_1to1',
    proofState: params.truth.proofState,
    blocker: params.truth.blocker,
    blockerOwner: params.truth.blockerOwner,
    nextAction: params.truth.nextAction,
    detectionState: params.truth.detectionState,
    detectionDetail: params.truth.detectionDetail,
    detectionNextAction: params.truth.detectionNextAction,
    mostRecentEngagedChatJid: params.truth.mostRecentEngagedChatJid,
    mostRecentEngagedAt: params.truth.mostRecentEngagedAt,
    lastInboundAt: snapshot?.lastInboundObservedAt || params.truth.lastInboundObservedAt,
    lastInboundChatJid:
      snapshot?.lastInboundChatJid || params.truth.lastInboundChatJid,
    lastInboundWasSelfAuthored:
      snapshot?.lastInboundWasSelfAuthored ?? params.truth.lastInboundWasSelfAuthored,
    lastOutboundResult: snapshot?.lastOutboundResult || params.truth.lastOutboundResult,
    lastOutboundTargetKind:
      snapshot?.lastOutboundTargetKind || params.truth.lastOutboundTargetKind,
    lastOutboundTarget: snapshot?.lastOutboundTarget || params.truth.lastOutboundTarget,
    recentTargetChatJid: params.truth.recentTargetChatJid,
    recentTargetAt: params.truth.recentTargetAt,
    openMessageActionCount: params.truth.openMessageActionCount,
    continuityState: params.truth.continuityState,
    proofCandidateChatJid: params.truth.proofCandidateChatJid,
    activeMessageActionId: params.truth.activeMessageActionId,
    conversationKind: params.truth.conversationKind,
    decisionPolicy: params.truth.decisionPolicy,
    conversationalEligibility: params.truth.conversationalEligibility,
    requiresExplicitMention: params.truth.requiresExplicitMention,
    activePresentationAt: params.truth.activePresentationAt,
    eligibleFollowups: [...params.truth.eligibleFollowups],
    canonicalSelfThreadChatJid: params.truth.canonicalSelfThreadChatJid,
    sourceSelfThreadChatJid: params.truth.sourceSelfThreadChatJid,
    messageActionProofState: params.truth.messageActionProofState,
    messageActionProofChatJid: params.truth.messageActionProofChatJid,
    messageActionProofAt: params.truth.messageActionProofAt,
  };
}

function listChats(limit: number): BlueBubblesChatSummary[] {
  return getAllChats()
    .filter((chat) => chat.jid.startsWith('bb:'))
    .slice(0, Math.max(limit * 3, limit))
    .map((chat) => {
      const recent = listRecentMessagesForChat(chat.jid, 12);
      const lastInbound = recent.find((message) => !message.is_from_me);
      const lastOutbound = recent.find((message) => message.is_from_me);
      return {
        chatJid: chat.jid,
        name: chat.name || null,
        isGroup: chat.is_group !== 0,
        lastMessageAt: recent[0]?.timestamp || chat.last_message_time || null,
        lastInboundAt: lastInbound?.timestamp || null,
        lastOutboundAt: lastOutbound?.timestamp || null,
        effectiveReplyGateMode: resolveBlueBubblesReplyGateMode({
          chatJid: chat.jid,
          isGroup: chat.is_group !== 0,
        }),
      } satisfies BlueBubblesChatSummary;
    })
    .sort(
      (left, right) =>
        Date.parse(right.lastMessageAt || '') - Date.parse(left.lastMessageAt || ''),
    )
    .slice(0, limit);
}

function listMessages(chatJid: string, limit: number): BlueBubblesMessageView[] {
  return listRecentMessagesForChat(chatJid, limit).map((message) => ({
    messageId: message.id,
    chatJid: message.chat_jid,
    timestamp: message.timestamp,
    isBotMessage: Boolean(message.is_bot_message),
    isFromMe: Boolean(message.is_from_me),
    preview: clipPreview(message.content, 220),
    replyToMessageId: message.reply_to_id || undefined,
  }));
}

function listOpenBlueBubblesMessageActions(
  groupFolder: string,
  chatJid: string | null,
  now: Date,
): BlueBubblesOpenMessageAction[] {
  const continuities = chatJid
    ? [
        reconcileBlueBubblesMessageActionContinuity({
          groupFolder,
          chatJid,
          now,
          allowRehydrate: true,
        }),
      ]
    : listBlueBubblesMessageActionContinuitySnapshots({
        groupFolder,
        now,
        allowRehydrate: true,
      });
  return continuities
    .flatMap((continuity) =>
      continuity.openActions.map((entry) => ({
        entry,
        continuity,
      })),
    )
    .filter(
      ({ entry }) =>
        !chatJid ||
        entry.presentationChatJid === chatJid ||
        entry.action.presentationChatJid === chatJid,
    )
    .map((entry) => ({
      actionId: entry.entry.action.messageActionId,
      chatJid: entry.entry.presentationChatJid || 'none',
      status: entry.entry.action.sendStatus,
      draftPreview: clipPreview(entry.entry.action.draftText, 220),
      allowedOperations: buildAllowedOperations(entry.entry.action.sendStatus),
      createdAt: entry.entry.action.createdAt,
      scheduledFor: entry.entry.action.followupAt || null,
      isActive: entry.entry.isActive,
      conversationKind: entry.entry.conversationKind,
      decisionPolicy: entry.entry.decisionPolicy,
      conversationalEligibility: entry.entry.conversationalEligibility,
      requiresExplicitMention: entry.entry.requiresExplicitMention,
      activePresentationAt: entry.entry.activePresentationAt,
      eligibleFollowups: [...entry.entry.eligibleFollowups],
    }))
    .sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }
      const rank = (kind: typeof left.conversationKind): number => {
        if (kind === 'self_thread') return 0;
        if (kind === 'direct_1to1') return 1;
        return 2;
      };
      const kindRank = rank(left.conversationKind) - rank(right.conversationKind);
      if (kindRank !== 0) {
        return kindRank;
      }
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });
}

function buildAllowedOperations(
  status: string,
): BlueBubblesMessageActionOperationKind[] {
  if (status === 'sent' || status === 'skipped') {
    return [];
  }
  return ['send', 'defer', 'remind_instead', 'save_to_thread'];
}

function resolveOperation(
  request: BlueBubblesExecuteMessageActionRequest,
): MessageActionOperation {
  if (request.operation === 'send') {
    return { kind: 'send' };
  }
  if (request.operation === 'defer') {
    return { kind: 'defer', timingHint: request.timingHint || null };
  }
  if (request.operation === 'remind_instead') {
    return { kind: 'remind_instead', timingHint: request.timingHint || null };
  }
  return { kind: 'save_to_thread' };
}

export function resolveBlueBubblesControlApiConfig(
  env = readEnvFile([
    'BLUEBUBBLES_CONTROL_API_ENABLED',
    'BLUEBUBBLES_CONTROL_HOST',
    'BLUEBUBBLES_CONTROL_PORT',
    'BLUEBUBBLES_CONTROL_TOKEN',
    'BLUEBUBBLES_CONTROL_BASE_URL',
  ]),
): BlueBubblesControlApiConfig {
  const host =
    process.env.BLUEBUBBLES_CONTROL_HOST ||
    env.BLUEBUBBLES_CONTROL_HOST ||
    '0.0.0.0';
  const port = parsePort(
    process.env.BLUEBUBBLES_CONTROL_PORT || env.BLUEBUBBLES_CONTROL_PORT,
    4315,
  );
  return {
    enabled: parseBool(
      process.env.BLUEBUBBLES_CONTROL_API_ENABLED ||
        env.BLUEBUBBLES_CONTROL_API_ENABLED,
      false,
    ),
    host,
    port,
    token:
      process.env.BLUEBUBBLES_CONTROL_TOKEN ||
      env.BLUEBUBBLES_CONTROL_TOKEN ||
      '',
    baseUrl:
      normalizeBaseUrl(
        process.env.BLUEBUBBLES_CONTROL_BASE_URL ||
          env.BLUEBUBBLES_CONTROL_BASE_URL,
      ) || `http://${host}:${port}`,
  };
}

export class BlueBubblesControlServer {
  private readonly buildTruth: () => FieldTrialBlueBubblesTruth;
  private readonly now: () => Date;

  constructor(
    private readonly config: BlueBubblesControlApiConfig,
    private readonly deps: BlueBubblesControlServerDeps,
  ) {
    this.buildTruth =
      deps.buildTruth ?? (() => buildFieldTrialOperatorTruth().bluebubbles);
    this.now = deps.now ?? (() => new Date());
  }

  getHealth(): Record<string, unknown> {
    const truth = this.buildTruth();
    const channel = this.deps.getChannel();
    return {
      ok: true,
      service: 'bluebubbles-control',
      enabled: this.config.enabled,
      baseUrl: this.config.baseUrl,
      connected: channel?.isConnected() === true,
      bluebubbles: {
        proofState: truth.proofState,
        transportState: truth.transportState,
        webhookRegistrationState: truth.webhookRegistrationState,
      },
    };
  }

  private requireChannel(): BlueBubblesChannel {
    const channel = this.deps.getChannel();
    if (!channel || !channel.isConnected()) {
      throw new Error('BlueBubbles channel is unavailable on this host.');
    }
    return channel;
  }

  private ensureAuthorized(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${this.config.token}`) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  private requireKnownChat(chatJid: string): { name: string | null; isGroup: boolean } {
    const chat = getAllChats().find((entry) => entry.jid === chatJid);
    if (!chat) {
      throw new Error(`Unknown BlueBubbles chat: ${chatJid}`);
    }
    return {
      name: chat.name || null,
      isGroup: chat.is_group !== 0,
    };
  }

  private async executeMessageAction(
    actionId: string,
    request: BlueBubblesExecuteMessageActionRequest,
  ): Promise<Record<string, unknown>> {
    const action = getMessageAction(actionId);
    if (!action) {
      throw new Error(`Unknown message action: ${actionId}`);
    }
    if (action.targetChannel !== 'bluebubbles') {
      throw new Error('This message action is not owned by BlueBubbles.');
    }
    if (!action.presentationChatJid?.startsWith('bb:')) {
      throw new Error('This BlueBubbles message action is missing a presentation chat.');
    }
    const operation = resolveOperation(request);
    const result = await applyMessageActionOperation(
      action.messageActionId,
      operation,
      {
        groupFolder: action.groupFolder,
        channel: 'bluebubbles',
        chatJid: action.presentationChatJid,
        currentTime: this.now(),
        sendToTarget: async (
          targetChannel: string,
          chatJid: string,
          text: string,
          options?: SendMessageOptions,
        ) => {
          if (targetChannel !== 'bluebubbles') {
            throw new Error('This control surface only executes BlueBubbles sends.');
          }
          return this.requireChannel().sendMessage(chatJid, text, options);
        },
      },
    );
    if (!result.handled) {
      throw new Error('BlueBubbles could not execute that message action.');
    }
    let confirmationMessageId: string | null = null;
    let confirmationError: string | null = null;
    const confirmationText = result.replyText || result.presentation?.text || null;
    if (confirmationText) {
      try {
        const confirmation = await this.requireChannel().sendMessage(
          action.presentationChatJid,
          confirmationText,
        );
        confirmationMessageId = confirmation.platformMessageId || null;
      } catch (err) {
        confirmationError =
          err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, actionId, chatJid: action.presentationChatJid },
          'BlueBubbles control API executed a message action but could not post the same-thread confirmation',
        );
      }
    }
    return {
      handled: result.handled,
      action: getMessageAction(actionId),
      replyText: result.replyText || null,
      presentation: result.presentation || null,
      confirmationMessageId,
      confirmationError,
      proof: buildProofReport(this.buildTruth()),
    };
  }

  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.ensureAuthorized(req, res)) {
      return;
    }

    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');
    const segments = splitPathname(url.pathname);

    try {
      if (method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, this.getHealth());
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/bluebubbles/status') {
        writeJson(res, 200, {
          status: buildStatus({
            truth: this.buildTruth(),
            channel: this.deps.getChannel(),
          }),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/bluebubbles/proof') {
        writeJson(res, 200, { proof: buildProofReport(this.buildTruth()) });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/bluebubbles/chats') {
        writeJson(res, 200, {
          chats: listChats(toLimit(url.searchParams.get('limit'), 20, 100)),
        });
        return;
      }

      if (
        method === 'GET' &&
        segments[0] === 'v1' &&
        segments[1] === 'bluebubbles' &&
        segments[2] === 'chats' &&
        segments[3] &&
        segments[4] === 'messages'
      ) {
        const chatJid = decodeURIComponent(segments[3]!);
        this.requireKnownChat(chatJid);
        writeJson(res, 200, {
          messages: listMessages(
            chatJid,
            toLimit(url.searchParams.get('limit'), 20, 100),
          ),
        });
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/v1/bluebubbles/message-actions/open'
      ) {
        const config = resolveBlueBubblesConfig();
        const truth = this.buildTruth();
        const chatJid = toNullableString(url.searchParams.get('chatJid'));
        if (chatJid) {
          this.requireKnownChat(chatJid);
        }
        writeJson(res, 200, {
          actions: listOpenBlueBubblesMessageActions(
            config.groupFolder,
            chatJid,
            this.now(),
          ),
          recentTargetChatJid: truth.recentTargetChatJid,
          recentTargetAt: truth.recentTargetAt,
          openMessageActionCount: truth.openMessageActionCount,
          continuityState: truth.continuityState,
          proofCandidateChatJid: truth.proofCandidateChatJid,
        });
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/v1/bluebubbles/refresh'
      ) {
        const body = await readJsonBody(req);
        const mode =
          body.mode === 'transport' ||
          body.mode === 'webhook' ||
          body.mode === 'shadow'
            ? body.mode
            : 'all';
        const snapshot = await this.requireChannel().refreshControlState(mode);
        writeJson(res, 200, {
          refreshed: mode,
          channel: snapshot,
          status: buildStatus({
            truth: this.buildTruth(),
            channel: this.deps.getChannel(),
          }),
          proof: buildProofReport(this.buildTruth()),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/bluebubbles/send') {
        const body = await readJsonBody(req);
        const chatJid = toNullableString(body.chatJid);
        const text = toNullableString(body.text);
        const replyToMessageId = toNullableString(body.replyToMessageId);
        if (!chatJid || !text) {
          throw new Error('chatJid and text are required.');
        }
        const knownChat = this.requireKnownChat(chatJid);
        const effectiveReplyGateMode = resolveBlueBubblesReplyGateMode({
          chatJid,
          isGroup: knownChat.isGroup,
        });
        if (effectiveReplyGateMode !== 'direct_1to1') {
          throw new Error(
            'Direct BlueBubbles send is only allowed for safe direct 1:1 chats. Use a same-thread message action for other chats.',
          );
        }
        const result = await this.requireChannel().sendMessage(chatJid, text, {
          replyToMessageId: replyToMessageId || undefined,
          suppressSenderLabel: true,
        });
        writeJson(res, 200, {
          sent: true,
          result,
          proof: buildProofReport(this.buildTruth()),
        });
        return;
      }

      if (
        method === 'POST' &&
        segments[0] === 'v1' &&
        segments[1] === 'bluebubbles' &&
        segments[2] === 'message-actions' &&
        segments[3] &&
        segments[4] === 'execute'
      ) {
        const body = (await readJsonBody(
          req,
        )) as unknown as BlueBubblesExecuteMessageActionRequest;
        if (
          body.operation !== 'send' &&
          body.operation !== 'defer' &&
          body.operation !== 'remind_instead' &&
          body.operation !== 'save_to_thread'
        ) {
          throw new Error('operation must be send, defer, remind_instead, or save_to_thread.');
        }
        writeJson(
          res,
          200,
          await this.executeMessageAction(segments[3]!, body),
        );
        return;
      }

      writeJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.warn(
        { err, method, pathname: url.pathname },
        'BlueBubbles control request failed',
      );
      writeJson(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function startBlueBubblesControlServer(
  deps: BlueBubblesControlServerDeps,
): http.Server | null {
  const config = resolveBlueBubblesControlApiConfig();
  if (!config.enabled) {
    return null;
  }
  if (!config.token.trim()) {
    throw new Error(
      'BLUEBUBBLES_CONTROL_TOKEN is required to start the BlueBubbles control API.',
    );
  }

  const control = new BlueBubblesControlServer(config, deps);
  const server = http.createServer((req, res) => {
    control.handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'BlueBubbles control request crashed');
      writeJson(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        baseUrl: config.baseUrl,
      },
      'BlueBubbles control API started',
    );
  });

  return server;
}
