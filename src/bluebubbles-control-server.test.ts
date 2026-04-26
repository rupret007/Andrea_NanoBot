import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBlueBubblesMonitorState } from './bluebubbles-monitor-state.js';
import { BlueBubblesControlServer } from './bluebubbles-control-server.js';
import { BLUEBUBBLES_CANONICAL_SELF_THREAD_JID } from './bluebubbles-self-thread.js';
import { BlueBubblesChannel } from './channels/bluebubbles.js';
import {
  _closeDatabase,
  _initTestDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import type { FieldTrialBlueBubblesTruth } from './field-trial-readiness.js';
import { createOrRefreshMessageActionFromDraft } from './message-actions.js';
import type { BlueBubblesConfig } from './types.js';

async function startBlueBubblesApiStub(
  handler?: (
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<{
  baseUrl: string;
  sentBodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const sentBodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').startsWith('/api/v1/ping')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 200, message: 'Ping received!', data: 'pong' }));
      return;
    }
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').startsWith('/api/v1/server/info')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { api_proxy_url: null } }));
      return;
    }
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').startsWith('/api/v1/webhook')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 1, url: 'http://example.test/hook' }] }));
      return;
    }
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').startsWith('/api/v1/message')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').includes('/api/v1/chat/')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    if (bodyText) {
      sentBodies.push(JSON.parse(bodyText) as Record<string, unknown>);
    }
    if (handler) {
      await handler(req, bodyText, res);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { guid: `server-msg-${sentBodies.length}` } }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve BlueBubbles stub address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sentBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function buildConfig(
  overrides: Partial<BlueBubblesConfig> = {},
): BlueBubblesConfig {
  const config: BlueBubblesConfig = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:9999',
    baseUrlCandidates: ['http://127.0.0.1:9999'],
    password: 'secret',
    host: '127.0.0.1',
    port: 0,
    groupFolder: 'main',
    webhookPublicBaseUrl: 'http://192.168.5.136:4305',
    chatScope: 'all_synced',
    allowedChatGuids: ['iMessage;-;+14695405551'],
    allowedChatGuid: 'iMessage;-;+14695405551',
    webhookPath: '/bluebubbles/webhook',
    webhookSecret: 'hook-secret',
    sendEnabled: true,
    ...overrides,
  };
  if (!overrides.baseUrlCandidates) {
    config.baseUrlCandidates = config.baseUrl ? [config.baseUrl] : [];
  }
  return config;
}

function buildTruth(
  overrides: Partial<FieldTrialBlueBubblesTruth> = {},
): FieldTrialBlueBubblesTruth {
  return {
    proofState: 'degraded_but_usable',
    blocker: 'same-thread message_action proof leg missing',
    blockerOwner: 'repo_side',
    nextAction: 'Use send it in that same BlueBubbles chat.',
    detail: 'Real Messages bridge traffic is flowing, but the proof chain is incomplete.',
    providerName: 'bluebubbles',
    bridgeAvailability: 'available',
    configured: true,
    serverBaseUrl: 'http://macbook-pro.local:1234',
    activeServerBaseUrl: 'http://macbook-pro.local:1234',
    serverBaseUrlCandidates: 'http://macbook-pro.local:1234',
    serverBaseUrlCandidateResults:
      'http://macbook-pro.local:1234 => reachable/auth ok (200)',
    listenerHost: '127.0.0.1',
    listenerPort: 4305,
    publicWebhookUrl: 'http://192.168.5.136:4305/bluebubbles/webhook?secret=***',
    webhookRegistrationState: 'registered',
    webhookRegistrationDetail: 'registered on the BlueBubbles server as webhook 1',
    chatScope: 'all_synced',
    configuredReplyGateMode: 'mention_required',
    effectiveReplyGateMode: 'direct_1to1',
    replyGateMode: 'direct_1to1',
    mostRecentEngagedChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    mostRecentEngagedAt: '2026-04-25T15:00:00.000Z',
    lastInboundObservedAt: '2026-04-25T15:01:00.000Z',
    lastInboundChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    lastInboundWasSelfAuthored: false,
    lastOutboundResult: `2026-04-25T15:02:00.000Z (${BLUEBUBBLES_CANONICAL_SELF_THREAD_JID})`,
    lastOutboundTargetKind: 'chat_guid',
    lastOutboundTarget: 'iMessage;-;+14695405551',
    lastSendErrorDetail: 'none',
    sendMethod: 'apple-script',
    privateApiAvailable: 'no',
    lastMetadataHydrationSource: 'none',
    attemptedTargetSequence: 'chat_guid',
    transportState: 'ready',
    transportDetail: 'reachable/auth ok (200)',
    detectionState: 'healthy',
    detectionDetail: 'none',
    detectionNextAction: 'none',
    shadowPollLastOkAt: '2026-04-25T15:03:00.000Z',
    shadowPollLastError: 'none',
    shadowPollMostRecentChat: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    mostRecentServerSeenAt: '2026-04-25T15:03:00.000Z',
    mostRecentServerSeenChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    mostRecentWebhookObservedAt: '2026-04-25T15:03:00.000Z',
    mostRecentWebhookObservedChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    lastIgnoredAt: 'none',
    lastIgnoredChatJid: 'none',
    lastIgnoredReason: 'none',
    crossSurfaceFallbackState: 'idle',
    crossSurfaceFallbackLastSentAt: 'none',
    recentTargetChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    recentTargetAt: '2026-04-25T15:04:00.000Z',
    openMessageActionCount: 0,
    continuityState: 'idle',
    proofCandidateChatJid: 'none',
    activeMessageActionId: 'none',
    conversationKind: 'self_thread',
    decisionPolicy: 'semi_auto_self_thread',
    conversationalEligibility: 'conversational_now',
    requiresExplicitMention: false,
    activePresentationAt: null,
    eligibleFollowups: [],
    canonicalSelfThreadChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    sourceSelfThreadChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    messageActionProofState: 'none',
    messageActionProofChatJid: 'none',
    messageActionProofAt: 'none',
    messageActionProofDetail: 'No fresh BlueBubbles message-action decision is recorded yet.',
    ...overrides,
  };
}

async function startControlServer(params: {
  channel: BlueBubblesChannel | null;
  truth?: FieldTrialBlueBubblesTruth;
}): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const control = new BlueBubblesControlServer(
    {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      token: 'control-token',
      baseUrl: null,
    },
    {
      getChannel: () => params.channel,
      buildTruth: () => params.truth || buildTruth(),
      now: () => new Date('2026-04-25T15:05:00.000Z'),
    },
  );
  const server = http.createServer((req, res) => {
    control.handleRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve control server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('BlueBubbles control server', () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-bluebubbles-control-'),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(tempProjectRoot);
    _initTestDatabase();
    clearBlueBubblesMonitorState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearBlueBubblesMonitorState();
    _closeDatabase();
    fs.rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it('requires bearer auth and returns sanitized status/proof with configured and effective gates', async () => {
    const apiStub = await startBlueBubblesApiStub();
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onHealthUpdate: () => undefined,
        onMessage: async () => undefined,
        onChatMetadata: () => undefined,
        registeredGroups: () => ({}),
        onRegisterMainChat: async () => ({ ok: true, message: 'ok' }),
      },
    );
    storeChatMetadata(
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      '2026-04-25T15:01:00.000Z',
      'Andrea Proof',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb-msg-1',
      chat_jid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      sender: 'Andrea Proof',
      sender_name: 'Andrea Proof',
      content: 'Hey there',
      timestamp: '2026-04-25T15:01:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await channel.connect();
    const control = await startControlServer({
      channel,
      truth: buildTruth({
        recentTargetChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
        recentTargetAt: '2026-04-25T15:04:00.000Z',
        openMessageActionCount: 1,
        continuityState: 'draft_open',
        proofCandidateChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      }),
    });

    const unauthorized = await fetch(`${control.baseUrl}/v1/bluebubbles/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${control.baseUrl}/v1/bluebubbles/status`, {
      headers: {
        Authorization: 'Bearer control-token',
      },
    });
    expect(authorized.status).toBe(200);
    const statusBody = (await authorized.json()) as {
      status: {
        configuredReplyGateMode: string;
        effectiveReplyGateMode: string;
        transportState: string;
        recentTargetChatJid: string;
        continuityState: string;
        activeMessageActionId: string;
        conversationKind: string;
        decisionPolicy: string;
        conversationalEligibility: string;
        requiresExplicitMention: boolean;
        activePresentationAt: string | null;
        eligibleFollowups: string[];
        canonicalSelfThreadChatJid: string;
      };
    };
    expect(statusBody.status.configuredReplyGateMode).toBe('mention_required');
    expect(statusBody.status.effectiveReplyGateMode).toBe('direct_1to1');
    expect(statusBody.status.recentTargetChatJid).toBe(BLUEBUBBLES_CANONICAL_SELF_THREAD_JID);
    expect(statusBody.status.continuityState).toBe('draft_open');
    expect(statusBody.status.activeMessageActionId).toBe('none');
    expect(statusBody.status.conversationKind).toBe('self_thread');
    expect(statusBody.status.decisionPolicy).toBe('semi_auto_self_thread');
    expect(statusBody.status.conversationalEligibility).toBe('conversational_now');
    expect(statusBody.status.requiresExplicitMention).toBe(false);
    expect(statusBody.status.activePresentationAt).toBeNull();
    expect(statusBody.status.eligibleFollowups).toEqual([]);
    expect(statusBody.status.canonicalSelfThreadChatJid).toBe(
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    );
    expect(JSON.stringify(statusBody)).not.toContain('hook-secret');
    expect(JSON.stringify(statusBody)).toContain('secret=***');
    expect(statusBody.status.transportState).toBe('ready');

    const proofResponse = await fetch(`${control.baseUrl}/v1/bluebubbles/proof`, {
      headers: {
        Authorization: 'Bearer control-token',
      },
    });
    const proofBody = (await proofResponse.json()) as {
      proof: {
        messageActionProofState: string;
        blocker: string;
        recentTargetChatJid: string;
        openMessageActionCount: number;
        conversationKind: string;
        decisionPolicy: string;
        conversationalEligibility: string;
        requiresExplicitMention: boolean;
        canonicalSelfThreadChatJid: string;
      };
    };
    expect(proofBody.proof.messageActionProofState).toBe('none');
    expect(proofBody.proof.blocker).toContain('message_action');
    expect(proofBody.proof.recentTargetChatJid).toBe(BLUEBUBBLES_CANONICAL_SELF_THREAD_JID);
    expect(proofBody.proof.openMessageActionCount).toBe(1);
    expect(proofBody.proof.conversationKind).toBe('self_thread');
    expect(proofBody.proof.decisionPolicy).toBe('semi_auto_self_thread');
    expect(proofBody.proof.conversationalEligibility).toBe('conversational_now');
    expect(proofBody.proof.requiresExplicitMention).toBe(false);
    expect(proofBody.proof.canonicalSelfThreadChatJid).toBe(
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    );

    await control.close();
    await channel.disconnect();
    await apiStub.close();
  });

  it('refreshes state and blocks unsafe direct sends outside safe 1:1 chats', async () => {
    const apiStub = await startBlueBubblesApiStub();
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onHealthUpdate: () => undefined,
        onMessage: async () => undefined,
        onChatMetadata: () => undefined,
        registeredGroups: () => ({}),
        onRegisterMainChat: async () => ({ ok: true, message: 'ok' }),
      },
    );
    storeChatMetadata(
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      '2026-04-25T15:01:00.000Z',
      'Andrea Proof',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;+;group-proof',
      '2026-04-25T15:01:30.000Z',
      'Family Group',
      'bluebubbles',
      true,
    );
    await channel.connect();
    const control = await startControlServer({
      channel,
      truth: buildTruth({
        transportState: 'ready',
        transportDetail: 'reachable/auth ok (200)',
      }),
    });

    const refreshResponse = await fetch(`${control.baseUrl}/v1/bluebubbles/refresh`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'all' }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshBody = (await refreshResponse.json()) as {
      refreshed: string;
      channel: { transportState: string };
    };
    expect(refreshBody.refreshed).toBe('all');
    expect(refreshBody.channel.transportState).toBe('reachable');

    const sendResponse = await fetch(`${control.baseUrl}/v1/bluebubbles/send`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
        text: 'Safe direct send',
      }),
    });
    expect(sendResponse.status).toBe(200);

    const blockedGroupSend = await fetch(`${control.baseUrl}/v1/bluebubbles/send`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatJid: 'bb:iMessage;+;group-proof',
        text: 'Unsafe group send',
      }),
    });
    expect(blockedGroupSend.status).toBe(400);
    expect(await blockedGroupSend.json()).toMatchObject({
      error: expect.stringContaining('Direct BlueBubbles send is only allowed'),
    });

    await control.close();
    await channel.disconnect();
    await apiStub.close();
  });

  it('lists and executes open BlueBubbles message actions through the safe control path', async () => {
    const apiStub = await startBlueBubblesApiStub();
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onHealthUpdate: () => undefined,
        onMessage: async () => undefined,
        onChatMetadata: () => undefined,
        registeredGroups: () => ({}),
        onRegisterMainChat: async () => ({ ok: true, message: 'ok' }),
      },
    );
    storeChatMetadata(
      'bb:iMessage;-;+15551234567',
      '2026-04-25T15:01:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      '2026-04-25T15:02:00.000Z',
      'Andrea Self',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;+;group-proof',
      '2026-04-25T15:01:30.000Z',
      'Family Group',
      'bluebubbles',
      true,
    );
    await channel.connect();

    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      sourceType: 'manual_prompt',
      sourceKey: 'bb-control-proof',
      sourceSummary: 'Candace still needs an answer.',
      draftText: 'Dinner still works for me tonight.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;-;+15551234567',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-25T15:04:00.000Z'),
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;+;group-proof',
      sourceType: 'manual_prompt',
      sourceKey: 'bb-control-group-proof',
      sourceSummary: 'Family group needs a draft.',
      draftText: 'Dinner around 7 works here too.',
      personName: 'Family Group',
      threadTitle: 'Family Group',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;group-proof',
        threadId: null,
        replyToMessageId: null,
        isGroup: true,
        personName: 'Family Group',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-25T15:03:00.000Z'),
    });

    const control = await startControlServer({
      channel,
      truth: buildTruth({
        recentTargetChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
        recentTargetAt: '2026-04-25T15:04:00.000Z',
        openMessageActionCount: 1,
        continuityState: 'draft_open',
        proofCandidateChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
      }),
    });
    const actionsResponse = await fetch(
      `${control.baseUrl}/v1/bluebubbles/message-actions/open?chatJid=${encodeURIComponent(BLUEBUBBLES_CANONICAL_SELF_THREAD_JID)}`,
      {
        headers: {
          Authorization: 'Bearer control-token',
        },
      },
    );
    expect(actionsResponse.status).toBe(200);
    const actionsBody = (await actionsResponse.json()) as {
      actions: Array<{ actionId: string; allowedOperations: string[]; isActive: boolean }>;
      recentTargetChatJid: string;
      openMessageActionCount: number;
      continuityState: string;
    };
    expect(actionsBody.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: action.messageActionId,
          allowedOperations: expect.arrayContaining(['send', 'defer']),
          isActive: true,
        }),
      ]),
    );
    expect(actionsBody.recentTargetChatJid).toBe(BLUEBUBBLES_CANONICAL_SELF_THREAD_JID);
    expect(actionsBody.openMessageActionCount).toBeGreaterThanOrEqual(1);
    expect(actionsBody.continuityState).toBe('draft_open');

    const allActionsResponse = await fetch(
      `${control.baseUrl}/v1/bluebubbles/message-actions/open`,
      {
        headers: {
          Authorization: 'Bearer control-token',
        },
      },
    );
    expect(allActionsResponse.status).toBe(200);
    const allActionsBody = (await allActionsResponse.json()) as {
      actions: Array<{
        actionId: string;
        isActive: boolean;
        conversationKind: string;
        decisionPolicy: string;
        conversationalEligibility: string;
        requiresExplicitMention: boolean;
        eligibleFollowups: string[];
      }>;
    };
    expect(allActionsBody.actions[0]).toMatchObject({
      actionId: action.messageActionId,
      isActive: true,
      conversationKind: 'self_thread',
      decisionPolicy: 'semi_auto_self_thread',
      conversationalEligibility: 'conversational_now',
      requiresExplicitMention: false,
    });
    expect(allActionsBody.actions.some((entry) => entry.conversationKind === 'group')).toBe(
      true,
    );

    const executeResponse = await fetch(
      `${control.baseUrl}/v1/bluebubbles/message-actions/${action.messageActionId}/execute`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer control-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operation: 'send' }),
      },
    );
    expect(executeResponse.status).toBe(200);
    const executeBody = (await executeResponse.json()) as {
      action: { sendStatus: string };
      proof: unknown;
    };
    expect(executeBody.action.sendStatus).toBe('sent');
    expect(executeBody.proof).toBeTruthy();

    await control.close();
    await channel.disconnect();
    await apiStub.close();
  });
});
