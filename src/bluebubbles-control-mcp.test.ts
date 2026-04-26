import http from 'http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BlueBubblesControlClient,
  createBlueBubblesMcpToolHandlers,
} from './bluebubbles-control-mcp.js';

async function startControlStub(): Promise<{
  baseUrl: string;
  requests: Array<{ method: string; url: string; body: string; auth: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ method: string; url: string; body: string; auth: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    requests.push({
      method: req.method || 'GET',
      url: req.url || '/',
      body: Buffer.concat(chunks).toString('utf8'),
      auth: req.headers.authorization || '',
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    if ((req.url || '').startsWith('/v1/bluebubbles/status')) {
      res.end(JSON.stringify({ status: { proofState: 'degraded_but_usable' } }));
      return;
    }
    if ((req.url || '').startsWith('/v1/bluebubbles/send')) {
      res.end(JSON.stringify({ sent: true }));
      return;
    }
    if ((req.url || '').startsWith('/v1/bluebubbles/message-actions/')) {
      res.end(JSON.stringify({ handled: true }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve control stub address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('BlueBubbles MCP bridge helpers', () => {
  const openCloses: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (openCloses.length > 0) {
      const close = openCloses.pop();
      if (close) {
        await close();
      }
    }
  });

  it('calls the control API with bearer auth through the client', async () => {
    const stub = await startControlStub();
    openCloses.push(stub.close);
    const client = new BlueBubblesControlClient({
      baseUrl: stub.baseUrl,
      token: 'control-token',
    });

    const status = await client.status();
    expect(status).toEqual({ status: { proofState: 'degraded_but_usable' } });
    expect(stub.requests[0]?.auth).toBe('Bearer control-token');
  });

  it('routes MCP tool handlers to the matching control API endpoints', async () => {
    const stub = await startControlStub();
    openCloses.push(stub.close);
    const handlers = createBlueBubblesMcpToolHandlers(
      new BlueBubblesControlClient({
        baseUrl: stub.baseUrl,
        token: 'control-token',
      }),
    );

    await handlers.bluebubbles_send({
      chatJid: 'bb:iMessage;-;+15551234567',
      text: 'Hello there',
    });
    await handlers.bluebubbles_execute_message_action({
      actionId: 'action-1',
      operation: 'defer',
      timingHint: 'later tonight',
    });

    expect(stub.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          url: '/v1/bluebubbles/send',
        }),
        expect.objectContaining({
          method: 'POST',
          url: '/v1/bluebubbles/message-actions/action-1/execute',
        }),
      ]),
    );
    expect(stub.requests[0]?.body).toContain('Hello there');
    expect(stub.requests[1]?.body).toContain('later tonight');
  });
});
