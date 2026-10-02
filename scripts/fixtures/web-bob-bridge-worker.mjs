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
import { readWebBobRecipient } from '../../dist/web-bob-bridge-server.js';

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
const target = {
  guid: 'iMessage;-;+15550101010',
  participants: [{ address: '+15550101010' }],
};
const recent = Array.from({ length: 200 }, (_, index) => ({
  guid: `SMS;-;+1555020${String(index).padStart(4, '0')}`,
  participants: [{ address: '+15550101000' }],
}));
const queries = [];
const messaging = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (
    req.method !== 'POST' ||
    url.pathname !== '/api/v1/chat/query' ||
    url.searchParams.get('password') !== 'synthetic-read-password'
  ) {
    res.writeHead(403).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const query = JSON.parse(Buffer.concat(chunks).toString());
  queries.push(query);
  fs.writeFileSync('recipient-queries.json', JSON.stringify(queries));
  const rows =
    query.guid === target.guid ? [target] : recent.slice(0, query.limit);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 200, data: rows }));
});
await new Promise((resolve) => messaging.listen(0, '127.0.0.1', resolve));
process.env.BLUEBUBBLES_BASE_URL = `http://127.0.0.1:${messaging.address().port}`;
process.env.BLUEBUBBLES_PASSWORD = 'synthetic-read-password';
const bridge = new WebBobBridge(
  {
    token,
    denyAddresses: ['+15550109999'],
    denyChatGuids: ['iMessage;-;+15550109999'],
  },
  path.join(process.cwd(), 'bridge.db'),
  {
    connected: () => true,
    resolveRecipient: readWebBobRecipient,
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
    messaging.close();
    bridge.close();
    _closeDatabase();
    input.close();
    process.exit(0);
  });
process.on('SIGTERM', close);
input.on('close', close);
