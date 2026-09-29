import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  type BlueBubblesChannel,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { RUNTIME_STATE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { WebBobBridge, type WebBobBridgeConfig } from './web-bob-bridge.js';

/** Read only; the provider's private API and send HTTP are never used here. */
export async function readWebBobRecipient(chatGuid: string): Promise<string[]> {
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
  const url = new URL('/api/v1/chat/query', base);
  url.searchParams.set('password', config.password);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit: 200,
      offset: 0,
      with: ['participants', 'lastMessage'],
      sort: 'lastmessage',
    }),
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
    data?: { guid?: unknown; participants?: { address?: unknown }[] }[];
  };
  if (
    (parsed.status !== undefined && parsed.status !== 200) ||
    !Array.isArray(parsed.data)
  )
    throw new Error('Recipient verification returned invalid data.');
  const rows = parsed.data.filter((row) => row?.guid === chatGuid);
  if (
    rows.length !== 1 ||
    !Array.isArray(rows[0].participants) ||
    rows[0].participants.length !== 1 ||
    typeof rows[0].participants[0]?.address !== 'string'
  ) {
    throw new Error('The direct-thread membership is not uniquely verified.');
  }
  return [rows[0].participants[0].address];
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
        connected: () => deps.getChannel()?.isConnected() === true,
        resolveRecipient: readWebBobRecipient,
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
