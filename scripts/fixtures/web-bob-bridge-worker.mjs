/** Hermetic cross-language fixture. No runtime credentials or live transport. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

import {
  _closeDatabase,
  _initTestDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from '../../dist/db.js';
import { WebBobBridge } from '../../dist/web-bob-bridge.js';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE !== '1'
) {
  throw new Error('Hermetic test boundary is required.');
}
const input = readline.createInterface({ input: process.stdin });
const first = await new Promise((resolve) => input.once('line', resolve));
const { token } = JSON.parse(first);
_initTestDatabase();
let sends = 0;
const bridge = new WebBobBridge(
  {
    token,
    denyAddresses: ['+15550109999'],
    denyChatGuids: ['iMessage;-;+15550109999'],
  },
  path.join(process.cwd(), 'bridge.db'),
  {
    connected: () => true,
    resolveRecipient: async (guid) =>
      guid === 'iMessage;-;+15550101010' ? ['+15550101010'] : [],
    sendToTarget: async (_channel, chatJid, text, options) => {
      // Persist only counts and identity, never private fixture text.
      fs.writeFileSync(
        'provider-count.json',
        JSON.stringify({ sends: ++sends, actionId: options?.idempotencyKey }),
      );
      // Match the real channel contract: a persisted outbound row, followed
      // by an ID-only receipt. Fixture message bytes stay in the memory DB.
      const timestamp = new Date().toISOString();
      storeChatMetadata(chatJid, timestamp, undefined, 'bluebubbles');
      storeMessageDirect({
        id: 'synthetic-provider-receipt',
        chat_jid: chatJid,
        sender: 'Me',
        sender_name: 'You',
        content: text,
        timestamp,
        is_from_me: true,
        is_bot_message: false,
        provider_idempotency_key: options?.idempotencyKey,
        message_ingress_origin: 'assistant_outbound',
      });
      return { platformMessageId: 'synthetic-provider-receipt' };
    },
  },
);
const server = http.createServer((req, res) => {
  void bridge.handleRequest(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
const close = () =>
  server.close(() => {
    bridge.close();
    _closeDatabase();
    input.close();
    process.exit(0);
  });
process.on('SIGTERM', close);
input.on('close', close);
