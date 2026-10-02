import { afterEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:1234',
  password: 'synthetic-read-password',
}));
vi.mock('./channels/bluebubbles.js', () => ({
  resolveBlueBubblesConfig: () => settings,
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

import {
  isWebBobReleaseAlertHold,
  readWebBobRecipient,
  startWebBobBridgeServer,
} from './web-bob-bridge-server.js';

describe('optional Web Bob bridge runtime boundary', () => {
  it('leaves automatic alerts unchanged without an operator hold', () => {
    vi.stubEnv('ANDREA_WEBBOB_RELEASE_ALERT_HOLD', '');
    expect(isWebBobReleaseAlertHold()).toBe(false);
  });

  it('suppresses automatic alerts only while a configured maintenance file exists', () => {
    vi.stubEnv(
      'ANDREA_WEBBOB_RELEASE_ALERT_HOLD',
      new URL(import.meta.url).pathname,
    );
    expect(isWebBobReleaseAlertHold()).toBe(true);
    vi.stubEnv(
      'ANDREA_WEBBOB_RELEASE_ALERT_HOLD',
      new URL(import.meta.url).pathname + '.absent',
    );
    expect(isWebBobReleaseAlertHold()).toBe(false);
    vi.stubEnv('ANDREA_WEBBOB_RELEASE_ALERT_HOLD', 'relative');
    expect(isWebBobReleaseAlertHold()).toBe(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    settings.baseUrl = 'http://127.0.0.1:1234';
  });

  it('defaults off without explicit configuration', () => {
    vi.stubEnv('ANDREA_WEBBOB_CONFIG_PATH', '');
    expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
  });

  it('reads only a bounded exact direct recipient, never a send endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          data: [
            {
              guid: 'iMessage;-;owner@example.invalid',
              participants: [{ address: 'owner@example.invalid' }],
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await readWebBobRecipient('iMessage;-;owner@example.invalid'),
    ).toEqual(['owner@example.invalid']);
    expect(fetcher.mock.calls[0][0].pathname).toBe('/api/v1/chat/query');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      guid: 'iMessage;-;owner@example.invalid',
      limit: 2,
      offset: 0,
      with: ['participants'],
    });
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });

  it('finds an older direct thread without scanning the recent window', async () => {
    const target = {
      guid: 'SMS;-;+15550101998',
      participants: [{ address: '+15550101998' }],
    };
    const recent = Array.from({ length: 200 }, (_, index) => ({
      guid: `SMS;-;+1555020${String(index).padStart(4, '0')}`,
      participants: [{ address: '+15550101000' }],
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const query = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            status: 200,
            data:
              query.guid === target.guid
                ? [target]
                : recent.slice(0, query.limit),
          }),
        );
      }),
    );
    expect(await readWebBobRecipient(target.guid)).toEqual(['+15550101998']);
  });

  it.each([
    { status: 500, data: [] },
    { data: 'invalid' },
    { data: [] },
    {
      data: [
        {
          guid: 'SMS;-;+15550101998',
          participants: [{ address: '+15550101998' }],
        },
      ],
    },
    {
      data: [
        {
          guid: 'iMessage;-;owner@example.invalid',
          participants: [{ address: 'owner@example.invalid' }],
        },
        {
          guid: 'SMS;-;+15550101998',
          participants: [{ address: '+15550101998' }],
        },
      ],
    },
    {
      data: Array(2).fill({
        guid: 'iMessage;-;owner@example.invalid',
        participants: [{ address: 'owner@example.invalid' }],
      }),
    },
    { data: [{ guid: 'iMessage;-;owner@example.invalid', participants: [] }] },
    {
      data: [
        {
          guid: 'iMessage;-;owner@example.invalid',
          participants: [
            { address: 'a@example.invalid' },
            { address: 'b@example.invalid' },
          ],
        },
      ],
    },
  ])('fails closed on invalid or nonunique membership', async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response))),
    );
    await expect(
      readWebBobRecipient('iMessage;-;owner@example.invalid'),
    ).rejects.toThrow();
  });

  it('rejects remote URLs before forwarding a credential and bounds the response', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    settings.baseUrl = 'https://example.invalid';
    await expect(
      readWebBobRecipient('iMessage;-;owner@example.invalid'),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    settings.baseUrl = 'http://127.0.0.1:1234';
    fetcher.mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(
      readWebBobRecipient('iMessage;-;owner@example.invalid'),
    ).rejects.toThrow();
  });
});
