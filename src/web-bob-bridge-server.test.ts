import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:1234',
  password: 'synthetic-read-password',
}));
vi.mock('./channels/bluebubbles.js', () => ({
  resolveBlueBubblesConfig: () => settings,
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./build-provenance.js', () => ({
  readCurrentGitCommit: vi.fn(),
  requireVerifiedRuntimeBuild: vi.fn(),
  resolveRuntimeArtifactContext: vi.fn(),
}));
const bridgeStub = vi.hoisted(() => ({
  close: vi.fn(),
  handleRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./web-bob-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./web-bob-bridge.js')>()),
  WebBobBridge: vi.fn(function () {
    return bridgeStub;
  }),
}));

import {
  readCurrentGitCommit,
  requireVerifiedRuntimeBuild,
  resolveRuntimeArtifactContext,
} from './build-provenance.js';
import { WebBobBridge } from './web-bob-bridge.js';

import {
  isWebBobReleaseAlertHold,
  readWebBobRecipient,
  readWebBobDelivery,
  startWebBobBridgeServer,
} from './web-bob-bridge-server.js';

describe('optional Web Bob bridge runtime boundary', () => {
  const target = {
    messageGuid: 'bb:receipt-123',
    chatGuid: 'SMS;-;+12025550102',
    address: '+12025550102',
    text: 'Synthetic exact test.',
  };
  function messageFixture(
    fields: Record<string, unknown> = {},
    wrongRecipient = false,
  ) {
    const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
      if (url.pathname === '/api/v1/message/receipt-123') {
        expect(options.method).toBe('GET');
        expect(url.searchParams.get('with')).toBe('chats');
        return new Response(
          JSON.stringify({
            status: 200,
            data: {
              guid: 'receipt-123',
              text: target.text,
              isFromMe: true,
              error: 0,
              isDelivered: false,
              dateDelivered: null,
              chats: [
                { guid: target.chatGuid },
                { guid: 'RCS;-;+12025550102' },
              ],
              ...fields,
            },
          }),
        );
      }
      expect(url.pathname).toBe('/api/v1/chat/query');
      const query = JSON.parse(options.body as string);
      return new Response(
        JSON.stringify({
          status: 200,
          data: [
            {
              guid: query.guid,
              participants: [
                { address: wrongRecipient ? '+12025550103' : target.address },
              ],
            },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('reports acceptance without inventing isSent, and verifies every migrated direct alias', async () => {
    const fetcher = messageFixture();
    expect(await readWebBobDelivery(target)).toEqual({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ error: 4, isDelivered: true }, 'delivery_failed'],
    [{ isDelivered: true }, 'delivered'],
    [{ isSent: true }, 'sent'],
    [{ error: null }, 'delivery_unconfirmed'],
  ])(
    'uses explicit status fields without treating row existence as delivery',
    async (fields, state) => {
      messageFixture(fields);
      expect((await readWebBobDelivery(target)).state).toBe(state);
    },
  );

  it.each([
    { guid: 'other-guid' },
    { text: 'Other text' },
    { isFromMe: false },
    { chats: [] },
    { chats: [{ guid: 'iMessage;+;group' }] },
    { chats: [{ guid: 'SMS;-;+12025550103' }] },
  ])('rejects uncorrelated message evidence', async (fields) => {
    messageFixture(fields);
    await expect(readWebBobDelivery(target)).rejects.toThrow();
  });

  it('rejects wrong verified membership and unavailable reads without a send', async () => {
    messageFixture({}, true);
    await expect(readWebBobDelivery(target)).rejects.toThrow();
    const fetcher = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', fetcher);
    await expect(readWebBobDelivery(target)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('leaves automatic alerts unchanged without an operator hold', () => {
    vi.stubEnv('ANDREA_WEBBOB_RELEASE_ALERT_HOLD', '');
    expect(isWebBobReleaseAlertHold()).toBe(false);
  });

  it('suppresses automatic alerts only while a configured maintenance file exists', () => {
    vi.stubEnv(
      'ANDREA_WEBBOB_RELEASE_ALERT_HOLD',
      fileURLToPath(import.meta.url),
    );
    expect(isWebBobReleaseAlertHold()).toBe(true);
    vi.stubEnv(
      'ANDREA_WEBBOB_RELEASE_ALERT_HOLD',
      fileURLToPath(import.meta.url) + '.absent',
    );
    expect(isWebBobReleaseAlertHold()).toBe(false);
    vi.stubEnv('ANDREA_WEBBOB_RELEASE_ALERT_HOLD', 'relative');
    expect(isWebBobReleaseAlertHold()).toBe(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
    settings.baseUrl = 'http://[::1]:1234';
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

  describe('explicit owner surface activation', () => {
    const buildSha = 'a'.repeat(40);
    let directory: string;
    let configPath: string;
    let configMode: number;
    let server: http.Server;

    function writeConfig(overrides: Record<string, unknown> = {}) {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          port: 43210,
          token: 'synthetic-dedicated-bridge-token-12345',
          denyAddresses: ['+12025550199'],
          denyChatGuids: ['SMS;-;+12025550199'],
          ...overrides,
        }),
        { mode: 0o600 },
      );
    }

    beforeEach(() => {
      vi.clearAllMocks();
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webbob-startup-'));
      configPath = path.join(directory, 'bridge.json');
      writeConfig();
      // Keep reading real fixture bytes while testing POSIX permission/type
      // metadata explicitly, including on Windows hosts without chmod support.
      configMode = fs.constants.S_IFREG | 0o600;
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
        const stat = realLstat(file, options);
        if (file === configPath && stat) {
          stat.mode =
            typeof stat.mode === 'bigint' ? BigInt(configMode) : configMode;
        }
        return stat;
      });
      vi.stubEnv('ANDREA_WEBBOB_CONFIG_PATH', configPath);
      vi.stubEnv('BLUEBUBBLES_CONTROL_TOKEN', 'synthetic-control-token');
      vi.stubEnv('ANDREA_BUILD_ID', buildSha);
      vi.mocked(resolveRuntimeArtifactContext).mockReturnValue({
        modulePath: '/synthetic/dist/web-bob-bridge-server.js',
        projectRoot: '/synthetic',
        compiledEntryPath: '/synthetic/dist/web-bob-bridge-server.js',
        isCompiledArtifact: true,
      });
      vi.mocked(readCurrentGitCommit).mockReturnValue(buildSha);
      vi.mocked(requireVerifiedRuntimeBuild).mockReset();
      server = Object.assign(new EventEmitter(), {
        listen: vi.fn(),
        close: vi.fn(),
      }) as unknown as http.Server;
      vi.spyOn(http, 'createServer').mockReturnValue(server);
    });

    afterEach(() => {
      fs.rmSync(directory, { recursive: true, force: true });
    });

    it.each([false, undefined, 'true', 1])(
      'requires literal enabled=true, received %s',
      (enabled) => {
        writeConfig({ enabled });
        expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
        expect(requireVerifiedRuntimeBuild).not.toHaveBeenCalled();
        expect(WebBobBridge).not.toHaveBeenCalled();
        expect(http.createServer).not.toHaveBeenCalled();
      },
    );

    it('rejects public or linked configuration before creating any listener', () => {
      configMode = fs.constants.S_IFREG | 0o644;
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
      configMode = fs.constants.S_IFLNK | 0o600;
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
      expect(WebBobBridge).not.toHaveBeenCalled();
      expect(http.createServer).not.toHaveBeenCalled();
    });

    it('rejects source execution and unverified builds before opening state', () => {
      vi.mocked(resolveRuntimeArtifactContext).mockReturnValueOnce({
        modulePath: '/synthetic/src/web-bob-bridge-server.ts',
        projectRoot: '/synthetic',
        compiledEntryPath: '/synthetic/dist/web-bob-bridge-server.js',
        isCompiledArtifact: false,
      });
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
      expect(requireVerifiedRuntimeBuild).not.toHaveBeenCalled();
      vi.mocked(requireVerifiedRuntimeBuild).mockImplementationOnce(() => {
        throw new Error('Synthetic artifact mismatch');
      });
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
      expect(WebBobBridge).not.toHaveBeenCalled();
      expect(http.createServer).not.toHaveBeenCalled();
    });

    it('rejects reuse of the existing control credential', () => {
      writeConfig({ token: 'synthetic-control-token' });
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
      expect(WebBobBridge).not.toHaveBeenCalled();
      expect(http.createServer).not.toHaveBeenCalled();
    });

    it.each([1023, 65536, 43210.5, '43210'])('rejects port %s', (port) => {
      writeConfig({ port });
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBeNull();
      expect(WebBobBridge).not.toHaveBeenCalled();
      expect(http.createServer).not.toHaveBeenCalled();
    });

    it('binds a verified runtime only to loopback and closes its challenge store', () => {
      expect(startWebBobBridgeServer({ getChannel: () => null })).toBe(server);
      expect(requireVerifiedRuntimeBuild).toHaveBeenCalledWith({
        projectRoot: '/synthetic',
        expectedGitCommit: buildSha,
        runnerBuildId: buildSha,
        runtimeName: 'Web Bob bridge',
      });
      expect(server.listen).toHaveBeenCalledWith(43210, '127.0.0.1');
      expect(server.requestTimeout).toBe(20_000);
      expect(server.headersTimeout).toBe(5_000);
      expect(bridgeStub.close).not.toHaveBeenCalled();
      server.emit('close');
      expect(bridgeStub.close).toHaveBeenCalledOnce();
    });

    it('closes the listener after a bind error', () => {
      startWebBobBridgeServer({ getChannel: () => null });
      server.emit('error', new Error('Synthetic address in use'));
      expect(server.close).toHaveBeenCalledOnce();
    });
  });
});
