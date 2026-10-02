import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  type BlueBubblesChannel,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { RUNTIME_STATE_DIR } from './config.js';
import {
  readCurrentGitCommit,
  requireVerifiedRuntimeBuild,
  resolveRuntimeArtifactContext,
} from './build-provenance.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  WebBobBridge,
  canonicalWebBobAddress,
  type WebBobBridgeConfig,
  type WebBobDeliveryTarget,
  type WebBobDeliveryEvidence,
} from './web-bob-bridge.js';

/** Operator maintenance hold for automatic service alerts only. Explicit
 * owner-approved dispatch still uses the normal message-action fences. The
 * hold is checked on each alert, so removing it restores the saved setting
 * without another restart or a queued burst of deployment notifications. */
export function isWebBobReleaseAlertHold(): boolean {
  const hold = process.env.ANDREA_WEBBOB_RELEASE_ALERT_HOLD;
  if (!hold) return false;
  if (!path.isAbsolute(hold)) return true;
  try {
    fs.statSync(hold);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Read only; the provider's private API and send HTTP are never used here. */
async function readLocalMessaging(
  route: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const config = resolveBlueBubblesConfig();
  if (!config.baseUrl || !config.password) {
    throw new Error('Andrea BlueBubbles read configuration is unavailable.');
  }
  // This optional bridge is restricted to the local messaging service.
  const base = new URL(config.baseUrl);
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.username ||
    base.password ||
    !base.port
  ) {
    throw new Error(
      'Web Bob recipient verification requires local BlueBubbles.',
    );
  }
  const url = new URL(route, base);
  url.searchParams.set('password', config.password);
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok || !response.body)
    throw new Error('Recipient verification unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024)
        throw new Error('Recipient verification exceeded its limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    status?: number;
    data?: unknown;
  };
  if (parsed.status !== undefined && parsed.status !== 200)
    throw new Error('Messaging verification returned invalid data.');
  return parsed.data;
}

export async function readWebBobRecipient(
  chatGuid: string,
  signal = AbortSignal.timeout(12000),
): Promise<string[]> {
  const data = await readLocalMessaging(
    '/api/v1/chat/query',
    {
      guid: chatGuid,
      limit: 2,
      offset: 0,
      with: ['participants'],
    },
    signal,
  );
  const parsed = { data } as {
    status?: number;
    data?: { guid?: unknown; participants?: { address?: unknown }[] }[];
  };
  if (
    (parsed.status !== undefined && parsed.status !== 200) ||
    !Array.isArray(parsed.data)
  )
    throw new Error('Recipient verification returned invalid data.');
  const rows = parsed.data;
  if (
    rows.length !== 1 ||
    rows[0]?.guid !== chatGuid ||
    !Array.isArray(rows[0].participants) ||
    rows[0].participants.length !== 1 ||
    typeof rows[0].participants[0]?.address !== 'string'
  ) {
    throw new Error('The direct-thread membership is not uniquely verified.');
  }
  return [rows[0].participants[0].address];
}

/** The provider GUID is global: Messages can associate a submitted SMS thread
 * with RCS later. Verify every observed direct alias against the original
 * approved address without changing that scope or attempting another send. */
export async function readWebBobDelivery(
  target: WebBobDeliveryTarget,
): Promise<WebBobDeliveryEvidence> {
  const guid = target.messageGuid.replace(/^bb:/, '');
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(guid))
    throw new Error('Invalid message identity.');
  const signal = AbortSignal.timeout(4000);
  const raw = await readLocalMessaging(
    '/api/v1/message/' + encodeURIComponent(guid) + '?with=chats',
    undefined,
    signal,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Missing message.');
  const message = raw as Record<string, unknown>;
  if (
    message.guid !== guid ||
    message.text !== target.text ||
    message.isFromMe !== true ||
    !Array.isArray(message.chats) ||
    !message.chats.length ||
    message.chats.length > 3
  )
    throw new Error('Message evidence does not match the approved submission.');
  const address = canonicalWebBobAddress(target.address);
  const chats = new Set<string>();
  for (const chat of message.chats) {
    if (
      !chat ||
      typeof chat.guid !== 'string' ||
      !/^(iMessage|SMS|RCS);-;[^;\s]+$/.test(chat.guid) ||
      canonicalWebBobAddress(chat.guid.split(';')[2]) !== address
    )
      throw new Error('Message has an unrelated recipient.');
    chats.add(chat.guid);
  }
  for (const chat of chats) {
    const members = await readWebBobRecipient(chat, signal);
    if (members.length !== 1 || canonicalWebBobAddress(members[0]) !== address)
      throw new Error('Message recipient could not be verified.');
  }
  const error =
    typeof message.error === 'number' &&
    Number.isSafeInteger(message.error) &&
    message.error >= 0
      ? message.error
      : null;
  const deliveredAt =
    typeof message.dateDelivered === 'number' &&
    Number.isFinite(message.dateDelivered) &&
    message.dateDelivered > 0 &&
    message.dateDelivered <= Date.now() + 1000
      ? message.dateDelivered
      : null;
  // Installed BlueBubbles omits isSent. Never infer it from a GUID/error0.
  const state =
    error !== null && error !== 0
      ? 'delivery_failed'
      : error === 0 && message.isDelivered === true
        ? 'delivered'
        : error === 0 && message.isSent === true
          ? 'sent'
          : error === 0
            ? 'submitted'
            : 'delivery_unconfirmed';
  return { state, error, deliveredAt };
}

/** Default off. A dedicated private configuration explicitly enables this
 * owner surface; the existing control token can never activate it. */
export function startWebBobBridgeServer(deps: {
  getChannel(): BlueBubblesChannel | null;
}): http.Server | null {
  const configPath =
    process.env.ANDREA_WEBBOB_CONFIG_PATH ||
    readEnvFile(['ANDREA_WEBBOB_CONFIG_PATH']).ANDREA_WEBBOB_CONFIG_PATH;
  if (!configPath) return null;
  try {
    if (!path.isAbsolute(configPath))
      throw new Error('Absolute configuration path required.');
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 24000)
      throw new Error('Private regular configuration file required.');
    const config = JSON.parse(
      fs.readFileSync(configPath, 'utf8'),
    ) as WebBobBridgeConfig & { enabled: boolean; port: number };
    if (config.enabled !== true) return null;
    const artifact = resolveRuntimeArtifactContext(
      import.meta.url,
      'web-bob-bridge-server.js',
    );
    if (!artifact.isCompiledArtifact)
      throw new Error(
        'The enabled owner bridge requires a verified compiled artifact.',
      );
    const buildSha = readCurrentGitCommit(artifact.projectRoot);
    requireVerifiedRuntimeBuild({
      projectRoot: artifact.projectRoot,
      expectedGitCommit: buildSha,
      runnerBuildId: process.env.ANDREA_BUILD_ID,
      runtimeName: 'Web Bob bridge',
    });
    const controlToken =
      process.env.BLUEBUBBLES_CONTROL_TOKEN ||
      readEnvFile(['BLUEBUBBLES_CONTROL_TOKEN']).BLUEBUBBLES_CONTROL_TOKEN;
    if (controlToken && config.token === controlToken)
      throw new Error('A dedicated bridge credential is required.');
    if (
      !Number.isInteger(config.port) ||
      config.port < 1024 ||
      config.port > 65535
    )
      throw new Error('Invalid port.');
    const bridge = new WebBobBridge(
      config,
      path.join(RUNTIME_STATE_DIR, 'webbob', 'challenges.db'),
      {
        buildSha,
        connected: () => deps.getChannel()?.isConnected() === true,
        resolveRecipient: readWebBobRecipient,
        readDelivery: readWebBobDelivery,
        sendToTarget: async (channel, chatJid, text, options) => {
          const provider = deps.getChannel();
          if (channel !== 'bluebubbles' || !provider?.isConnected())
            throw new Error('Andrea messaging is unavailable.');
          return provider.sendMessage(chatJid, text, options);
        },
      },
    );
    const server = http.createServer((req, res) => {
      void bridge.handleRequest(req, res);
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 5000;
    server.on('close', () => bridge.close());
    server.on('error', () => {
      logger.error(
        'Web Bob bridge could not listen; delivery remains unavailable.',
      );
      server.close();
    });
    server.listen(config.port, '127.0.0.1');
    return server;
  } catch {
    logger.error(
      'Web Bob bridge configuration is invalid; delivery remains unavailable.',
    );
    return null;
  }
}
