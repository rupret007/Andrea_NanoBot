import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  completeGoogleCalendarAuthFromCallbackUrl,
  GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST,
  buildGoogleCalendarLoopbackRedirectUri,
  getGoogleCalendarPendingAuthStatePath,
  parseGoogleInstalledClientSecretJson,
  parseGoogleCalendarAuthCallbackUrl,
  resolveCalendarSelection,
  waitForAuthCode,
} from './google-calendar.js';

describe('parseGoogleInstalledClientSecretJson', () => {
  it('reads an installed-app Google OAuth client secret file', () => {
    const parsed = parseGoogleInstalledClientSecretJson(
      JSON.stringify({
        installed: {
          client_id: 'client-id',
          client_secret: 'client-secret',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      }),
    );

    expect(parsed.clientId).toBe('client-id');
    expect(parsed.clientSecret).toBe('client-secret');
    expect(parsed.authUri).toContain('accounts.google.com');
    expect(parsed.tokenUri).toContain('oauth2.googleapis.com/token');
  });
});

describe('resolveCalendarSelection', () => {
  const calendars = [
    {
      id: 'primary',
      summary: 'Jeff',
      primary: true,
      accessRole: 'owner',
      writable: true,
    },
    {
      id: 'family@group.calendar.google.com',
      summary: 'Family',
      primary: false,
      accessRole: 'writer',
      writable: true,
    },
  ];

  it('supports selecting all readable calendars', () => {
    expect(resolveCalendarSelection('all', calendars)).toEqual([
      'primary',
      'family@group.calendar.google.com',
    ]);
  });

  it('supports numbered selection', () => {
    expect(resolveCalendarSelection('2', calendars)).toEqual([
      'family@group.calendar.google.com',
    ]);
  });

  it('supports summary-name selection', () => {
    expect(resolveCalendarSelection('Family', calendars)).toEqual([
      'family@group.calendar.google.com',
    ]);
  });

  it('supports selecting the concrete primary calendar by the primary alias', () => {
    expect(resolveCalendarSelection('primary', calendars)).toEqual([
      'primary',
    ]);
  });
});

describe('Google Calendar OAuth loopback callback handling', () => {
  it('uses a single explicit loopback host for auth callbacks', () => {
    expect(GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST).toBe('127.0.0.1');
    expect(buildGoogleCalendarLoopbackRedirectUri(56603)).toBe(
      'http://127.0.0.1:56603',
    );
  });

  it('accepts a callback with a matching state and code', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST, () => resolve());
    });

    try {
      const address = server.address();
      expect(address).toBeTruthy();
      expect(typeof address).not.toBe('string');
      const port = typeof address === 'string' ? 0 : address!.port;

      const callbackPromise = waitForAuthCode(server, 'state-123', 1000);
      const response = await fetch(
        `${buildGoogleCalendarLoopbackRedirectUri(port)}/?state=state-123&code=code-abc`,
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('Google Calendar connected.');
      await expect(callbackPromise).resolves.toBe('code-abc');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('times out cleanly when no callback arrives', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST, () => resolve());
    });

    try {
      await expect(waitForAuthCode(server, 'state-123', 20)).rejects.toThrow(
        'Timed out waiting for the Google OAuth callback.',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe('Google Calendar OAuth callback recovery', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-google-auth-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('parses a redirected callback URL into state and code', () => {
    expect(
      parseGoogleCalendarAuthCallbackUrl(
        'http://127.0.0.1:60954/?state=state-123&code=code-abc&scope=one%20two',
      ),
    ).toEqual({
      callbackUrl:
        'http://127.0.0.1:60954/?state=state-123&code=code-abc&scope=one%20two',
      state: 'state-123',
      code: 'code-abc',
      error: null,
    });
  });

  it('completes auth from a pasted callback URL using the pending session state', async () => {
    const clientSecretJsonPath = path.join(tempDir, 'client-secret.json');
    fs.writeFileSync(
      clientSecretJsonPath,
      JSON.stringify({
        installed: {
          client_id: 'client-id',
          client_secret: 'client-secret',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      }),
      'utf8',
    );
    fs.mkdirSync(path.dirname(getGoogleCalendarPendingAuthStatePath(tempDir)), {
      recursive: true,
    });
    fs.writeFileSync(
      getGoogleCalendarPendingAuthStatePath(tempDir),
      JSON.stringify({
        clientSecretJsonPath,
        redirectUri: 'http://127.0.0.1:60954',
        state: 'state-123',
        codeVerifier: 'verifier-123',
        createdAt: '2026-04-09T14:00:00.000Z',
      }),
      'utf8',
    );

    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      expect(url).toBe('https://oauth2.googleapis.com/token');
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
        }),
        { status: 200 },
      );
    });

    const result = await completeGoogleCalendarAuthFromCallbackUrl(
      'http://127.0.0.1:60954/?state=state-123&code=code-abc',
      tempDir,
    );

    expect(result.clientSecretJsonPath).toBe(clientSecretJsonPath);
    expect(result.redirectUri).toBe('http://127.0.0.1:60954');

    const envContents = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
    expect(envContents).toContain('GOOGLE_CALENDAR_CLIENT_ID="client-id"');
    expect(envContents).toContain('GOOGLE_CALENDAR_CLIENT_SECRET="client-secret"');
    expect(envContents).toContain('GOOGLE_CALENDAR_REFRESH_TOKEN="refresh-token"');
    expect(fs.existsSync(getGoogleCalendarPendingAuthStatePath(tempDir))).toBe(
      false,
    );
  });
});
