import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listMessageActionsForGroup,
} from './db.js';
import type { OwnerChallengeSummary } from './owner-challenge-delivery.js';
import { WebBobBridge } from './web-bob-bridge.js';

const routes = ['draft', 'confirm', 'cancel', 'status'] as const;
type Route = (typeof routes)[number];
const token = 'synthetic-http-bridge-token-1234567890';
const draft = () => ({
  issuer: 'web-bob',
  audience: 'andrea',
  actor: 'a'.repeat(64),
  conversationId: 'http-conversation',
  epoch: 'http-epoch',
  draftId: 'http-draft',
  revision: 1,
  draftRequestId: 'http-request',
  chatGuid: 'iMessage;-;+12025550102',
  addresses: ['+12025550102'],
  text: 'Synthetic HTTP exact text.',
});

describe('Web Bob JSON security at the HTTP boundary', () => {
  let bridge: WebBobBridge;
  let server: http.Server;
  let baseUrl: string;
  const send = vi.fn();
  const resolveRecipient = vi.fn();
  const readDelivery = vi.fn();
  const deliver =
    vi.fn<
      (challenge: string, summary: OwnerChallengeSummary) => Promise<void>
    >();

  const post = (route: Route, body: string) =>
    fetch(`${baseUrl}/web-bob/v1/${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    });

  beforeEach(async () => {
    _initTestDatabase();
    send.mockReset().mockResolvedValue({
      platformMessageId: 'synthetic-http-receipt',
      threadId: 'bb:iMessage;-;+12025550102',
    });
    resolveRecipient.mockReset().mockResolvedValue(['+12025550102']);
    readDelivery.mockReset();
    deliver.mockReset().mockResolvedValue(undefined);
    bridge = new WebBobBridge(
      {
        token,
        denyAddresses: ['+12025550199'],
        denyChatGuids: ['iMessage;-;+12025550199'],
      },
      ':memory:',
      {
        connected: () => true,
        resolveRecipient,
        readDelivery,
        sendToTarget: send,
        ownerChallengeDelivery: { deliver },
      },
    );
    server = http.createServer((req, res) => {
      void bridge.handleRequest(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge.close();
    _closeDatabase();
  });

  async function validBody(route: Route): Promise<Record<string, unknown>> {
    if (route === 'draft') return draft();
    const response = await post('draft', JSON.stringify(draft()));
    expect(response.status).toBe(200);
    const card = await response.json();
    expect(deliver).toHaveBeenCalledOnce();
    const approvalToken = deliver.mock.calls[0][0];
    deliver.mockClear();
    resolveRecipient.mockClear();
    return {
      bridgeDraftId: card.draftId,
      requestDigest: card.requestDigest,
      ...(route === 'confirm' ? { approvalToken } : {}),
    };
  }

  async function expectRejectedJson(route: Route, raw: string) {
    const response = await post(route, raw);
    expect(response.status, `${route}: ${raw}`).toBe(400);
    // Check parser refusal specifically: schema validation alone would hide
    // constructor/prototype parser regressions behind another HTTP 400.
    expect(await response.json()).toEqual({ error: 'Invalid JSON.' });
    expect(deliver).not.toHaveBeenCalled();
    expect(resolveRecipient).not.toHaveBeenCalled();
    expect(readDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }

  async function expectUnchanged(route: Route, body: Record<string, unknown>) {
    if (route === 'draft') {
      expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toEqual([]);
    } else {
      const response = await post(
        'status',
        JSON.stringify({
          bridgeDraftId: body.bridgeDraftId,
          requestDigest: body.requestDigest,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'pending' });
      expect(
        listMessageActionsForGroup({ groupFolder: 'webbob' }),
      ).toHaveLength(1);
    }
  }

  it.each(routes)(
    'rejects forbidden object keys before dispatch on POST /web-bob/v1/%s',
    async (route) => {
      const body = await validBody(route);
      for (const key of [
        '__proto__',
        'constructor',
        'prototype',
        '\\u005f_proto__',
        '\\u0063onstructor',
        '\\u0070rototype',
      ]) {
        // Send literal JSON bytes; a JavaScript __proto__ object literal
        // would change its prototype and omit the attack from JSON.stringify.
        const raw =
          JSON.stringify(body).slice(0, -1) +
          `,"${key}":${JSON.stringify({
            requestDigest: body.requestDigest ?? 'a'.repeat(64),
          })}}`;
        await expectRejectedJson(route, raw);
      }
      await expectUnchanged(route, body);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects %s supplying inherited draft text',
    async (key) => {
      const { text: _text, ...body } = draft();
      const raw =
        JSON.stringify(body).slice(0, -1) + `,"${key}":{"text":"proto text"}}`;
      await expectRejectedJson('draft', raw);
      await expectUnchanged('draft', body);
    },
  );

  it.each(['confirm', 'cancel', 'status'] as const)(
    'rejects an inherited requestDigest on POST /web-bob/v1/%s',
    async (route) => {
      const body = await validBody(route);
      const { requestDigest, ...withoutDigest } = body;
      const raw =
        JSON.stringify(withoutDigest).slice(0, -1) +
        `,"__proto__":${JSON.stringify({ requestDigest })}}`;
      await expectRejectedJson(route, raw);
      await expectUnchanged(route, body);
    },
  );

  it.each(routes)(
    'rejects non-JSON whitespace on POST /web-bob/v1/%s',
    async (route) => {
      const body = await validBody(route);
      const raw = JSON.stringify(body);
      for (const whitespace of ['\u00a0', '\u2028', '\ufeff']) {
        for (const malformed of [
          whitespace + raw,
          raw.replace(',', ',' + whitespace),
          raw + whitespace,
        ]) {
          await expectRejectedJson(route, malformed);
        }
      }
      await expectUnchanged(route, body);
    },
  );

  it.each(['1.0', '1e0', '1E0', '1e+0'])(
    'rejects revision number spelling %s before delivering a challenge',
    async (revision) => {
      const raw = JSON.stringify(draft()).replace(
        '"revision":1',
        `"revision":${revision}`,
      );
      await expectRejectedJson('draft', raw);
      await expectUnchanged('draft', draft());
    },
  );

  it('preserves Unicode whitespace inside strings and permits JSON whitespace around values', async () => {
    const text = 'Exact\u00a0text\u2028with\ufeffcharacters.';
    const raw = JSON.stringify({ ...draft(), text });
    const response = await post(
      'draft',
      ` \t\r\n${raw.replace(',', ', \t\r\n')}\n\r\t `,
    );
    expect(response.status).toBe(200);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][1]).toMatchObject({ text, revision: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(readDelivery).not.toHaveBeenCalled();
  });
});
