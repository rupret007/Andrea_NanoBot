import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RequestEnvelope, type ResponseEnvelope } from 'ask-sdk-model';

import { runAlexaAssistantTurn } from './alexa-bridge.js';
import {
  formatAlexaStatusMessage,
  startAlexaServer,
  type AlexaConfig,
} from './alexa.js';
import {
  getAlexaLinkedAccountByAccessTokenHash,
  _initTestDatabase,
  setRegisteredGroup,
} from './db.js';
import { hashAlexaAccessToken } from './alexa-identity.js';

vi.mock('./alexa-bridge.js', async () => {
  const actual =
    await vi.importActual<typeof import('./alexa-bridge.js')>(
      './alexa-bridge.js',
    );
  return {
    ...actual,
    runAlexaAssistantTurn: vi.fn(),
  };
});

const mockedRunAlexaAssistantTurn = vi.mocked(runAlexaAssistantTurn);

function buildConfig(overrides: Partial<AlexaConfig> = {}): AlexaConfig {
  return {
    skillId: 'amzn1.ask.skill.test',
    host: '127.0.0.1',
    port: 0,
    path: '/alexa',
    healthPath: '/alexa/health',
    verifySignature: false,
    requireAccountLinking: true,
    allowedUserIds: [],
    targetGroupFolder: undefined,
    ...overrides,
  };
}

function buildIntentEnvelope(
  intentName: string,
  accessToken: string,
): RequestEnvelope {
  return {
    version: '1.0',
    session: {
      new: false,
      sessionId: 'SessionId.oauth',
      application: {
        applicationId: 'amzn1.ask.skill.test',
      },
      user: {
        userId: 'amzn1.ask.account.oauth-user',
        accessToken,
      },
    },
    context: {
      System: {
        application: {
          applicationId: 'amzn1.ask.skill.test',
        },
        user: {
          userId: 'amzn1.ask.account.oauth-user',
          accessToken,
        },
        person: {
          personId: 'amzn1.ask.person.oauth-person',
          accessToken,
        },
        device: {
          deviceId: 'device-1',
          supportedInterfaces: {},
        },
        apiEndpoint: 'https://api.amazonalexa.com',
        apiAccessToken: 'api-access-token',
      },
    },
    request: {
      requestId: `EdwRequestId.${intentName}`,
      locale: 'en-US',
      timestamp: '2026-04-03T08:00:00Z',
      type: 'IntentRequest',
      intent: {
        name: intentName,
        confirmationStatus: 'NONE',
        slots: {},
      },
    },
  } as unknown as RequestEnvelope;
}

function extractSpeechText(responseEnvelope: ResponseEnvelope): string {
  const outputSpeech = responseEnvelope.response?.outputSpeech;
  const ssml =
    outputSpeech && 'ssml' in outputSpeech ? outputSpeech.ssml || '' : '';
  return ssml.replace(/<\/?speak>/g, '').trim();
}

function extractHiddenInput(html: string, name: string): string {
  const regex = new RegExp(`name="${name}" value="([^"]+)"`);
  const match = html.match(regex);
  if (!match?.[1]) {
    throw new Error(`Missing hidden input ${name}`);
  }
  return match[1];
}

async function authorizeAndApprove(
  baseUrl: string,
  query: URLSearchParams,
): Promise<{
  code: string;
  state?: string;
}> {
  const authorize = await fetch(
    `${baseUrl}/alexa/oauth/authorize?${query.toString()}`,
  );
  expect(authorize.status).toBe(200);
  const html = await authorize.text();
  const requestPayload = extractHiddenInput(html, 'request');
  const signature = extractHiddenInput(html, 'sig');

  const approve = await fetch(`${baseUrl}/alexa/oauth/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    redirect: 'manual',
    body: new URLSearchParams({
      request: requestPayload,
      sig: signature,
      decision: 'approve',
    }),
  });

  expect(approve.status).toBe(303);
  const location = approve.headers.get('location');
  expect(location).toBeTruthy();
  const redirectUrl = new URL(location!);
  const code = redirectUrl.searchParams.get('code');
  expect(code).toBeTruthy();
  return {
    code: code!,
    state: redirectUrl.searchParams.get('state') || undefined,
  };
}

async function exchangeCode(
  baseUrl: string,
  code: string,
  redirectUri: string,
  extras: Record<string, string> = {},
  clientSecret = 'client-secret-1',
): Promise<Response> {
  return fetch(`${baseUrl}/alexa/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`client-1:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      ...extras,
    }),
  });
}

describe('alexa oauth', () => {
  let runtime: Awaited<ReturnType<typeof startAlexaServer>> = null;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ALEXA_OAUTH_CLIENT_ID = 'client-1';
    process.env.ALEXA_OAUTH_CLIENT_SECRET = 'client-secret-1';
    process.env.ALEXA_OAUTH_SCOPE = 'andrea.alexa.link';
    process.env.ALEXA_LINKED_ACCOUNT_GROUP_FOLDER = 'main';
    process.env.ALEXA_LINKED_ACCOUNT_NAME = 'Andrea Alexa';
    delete process.env.ALEXA_LINKED_ACCOUNT_TOKEN;
    delete process.env.ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID;
    delete process.env.ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID;

    _initTestDatabase();
    mockedRunAlexaAssistantTurn.mockReset();
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'Tomorrow has one timed event at four PM.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:test',
      groupFolder: 'main',
    });
    setRegisteredGroup('tg:main', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-03T08:00:00Z',
      requiresTrigger: false,
      isMain: true,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
  });

  it('includes OAuth paths in the Alexa status view', () => {
    const status = {
      enabled: true,
      running: true,
      host: '127.0.0.1',
      port: 4300,
      path: '/alexa',
      healthPath: '/alexa/health',
      verifySignature: true,
      requireAccountLinking: true,
      allowedUserIdsCount: 0,
      oauthEnabled: true,
      oauthAuthorizationPath: '/alexa/oauth/authorize',
      oauthTokenPath: '/alexa/oauth/token',
      oauthHealthPath: '/alexa/oauth/health',
      oauthScope: 'andrea.alexa.link',
      oauthGroupFolder: 'main',
    };

    const rendered = formatAlexaStatusMessage(status);
    expect(rendered).toContain('OAuth account linking: configured');
    expect(rendered).toContain('/alexa/oauth/authorize');
    expect(rendered).toContain('/alexa/oauth/token');
  });

  it('includes wildcard tunnel guidance for ngrok public ingress', () => {
    const status = {
      enabled: true,
      running: true,
      host: '127.0.0.1',
      port: 4300,
      path: '/alexa',
      healthPath: '/alexa/health',
      verifySignature: true,
      requireAccountLinking: true,
      allowedUserIdsCount: 0,
      oauthEnabled: true,
      oauthAuthorizationPath: '/alexa/oauth/authorize',
      oauthTokenPath: '/alexa/oauth/token',
      oauthHealthPath: '/alexa/oauth/health',
      oauthScope: 'andrea.alexa.link',
      oauthGroupFolder: 'main',
      publicBaseUrl: 'https://example.ngrok-free.dev',
      publicEndpointUrl: 'https://example.ngrok-free.dev/alexa',
      publicOAuthHealthUrl: 'https://example.ngrok-free.dev/alexa/oauth/health',
      publicIngressKind: 'wildcard_certificate_domain',
      publicIngressHint:
        'Alexa Developer Console endpoint SSL type must be set to the wildcard certificate option for *.ngrok-free.dev.',
      publicBrowserHint:
        'Browser health checks against ngrok free tunnels can show the ngrok warning page unless you send the ngrok-skip-browser-warning header.',
    };

    const rendered = formatAlexaStatusMessage(status);
    expect(rendered).toContain('Public HTTPS base: https://example.ngrok-free.dev');
    expect(rendered).toContain('Public ingress type: wildcard_certificate_domain');
    expect(rendered).toContain('wildcard certificate option');
    expect(rendered).toContain('ngrok-skip-browser-warning');
  });

  it('rejects invalid authorization requests', async () => {
    runtime = await startAlexaServer(buildConfig());
    const baseUrl = `http://127.0.0.1:${runtime!.getStatus().port}`;

    const badResponseType = await fetch(
      `${baseUrl}/alexa/oauth/authorize?response_type=token&client_id=client-1&redirect_uri=${encodeURIComponent('https://layla.amazon.com/api/skill/link/test')}`,
    );
    expect(badResponseType.status).toBe(400);

    const badClient = await fetch(
      `${baseUrl}/alexa/oauth/authorize?response_type=code&client_id=wrong-client&redirect_uri=${encodeURIComponent('https://layla.amazon.com/api/skill/link/test')}`,
    );
    expect(badClient.status).toBe(400);

    const badScope = await fetch(
      `${baseUrl}/alexa/oauth/authorize?response_type=code&client_id=client-1&redirect_uri=${encodeURIComponent('https://layla.amazon.com/api/skill/link/test')}&scope=${encodeURIComponent('wrong.scope')}`,
    );
    expect(badScope.status).toBe(400);

    const badRedirect = await fetch(
      `${baseUrl}/alexa/oauth/authorize?response_type=code&client_id=client-1&redirect_uri=${encodeURIComponent('https://example.com/callback')}`,
    );
    expect(badRedirect.status).toBe(400);
  });

  it('preserves state and can deny approval cleanly', async () => {
    runtime = await startAlexaServer(buildConfig());
    const baseUrl = `http://127.0.0.1:${runtime!.getStatus().port}`;
    const redirectUri = 'https://layla.amazon.com/api/skill/link/test';

    const authorize = await fetch(
      `${baseUrl}/alexa/oauth/authorize?response_type=code&client_id=client-1&redirect_uri=${encodeURIComponent(redirectUri)}&state=state-123`,
    );
    const html = await authorize.text();
    const requestPayload = extractHiddenInput(html, 'request');
    const signature = extractHiddenInput(html, 'sig');

    const deny = await fetch(`${baseUrl}/alexa/oauth/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      redirect: 'manual',
      body: new URLSearchParams({
        request: requestPayload,
        sig: signature,
        decision: 'deny',
      }),
    });

    expect(deny.status).toBe(303);
    const location = new URL(deny.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-123');
  });

  it('issues one-time codes and exchanges them for access and refresh tokens', async () => {
    runtime = await startAlexaServer(buildConfig());
    const baseUrl = `http://127.0.0.1:${runtime!.getStatus().port}`;
    const redirectUri = 'https://layla.amazon.com/api/skill/link/test';

    const { code, state } = await authorizeAndApprove(
      baseUrl,
      new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: redirectUri,
        state: 'round-trip-state',
      }),
    );
    expect(state).toBe('round-trip-state');

    const tokenResponse = await exchangeCode(baseUrl, code, redirectUri);
    expect(tokenResponse.status).toBe(200);
    const payload = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(payload.access_token).toBeTruthy();
    expect(payload.refresh_token).toBeTruthy();
    expect(payload.scope).toBe('andrea.alexa.link');

    const linked = getAlexaLinkedAccountByAccessTokenHash(
      hashAlexaAccessToken(payload.access_token),
    );
    expect(linked).toMatchObject({
      groupFolder: 'main',
      displayName: 'Andrea Alexa',
    });

    const reused = await exchangeCode(baseUrl, code, redirectUri);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects token exchange failures for bad secret, redirect mismatch, and expired code', async () => {
    runtime = await startAlexaServer(buildConfig());
    const baseUrl = `http://127.0.0.1:${runtime!.getStatus().port}`;
    const redirectUri = 'https://layla.amazon.com/api/skill/link/test';

    const { code: badSecretCode } = await authorizeAndApprove(
      baseUrl,
      new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: redirectUri,
      }),
    );
    const badSecret = await exchangeCode(
      baseUrl,
      badSecretCode,
      redirectUri,
      {},
      'wrong-secret',
    );
    expect(badSecret.status).toBe(401);
    expect(await badSecret.json()).toMatchObject({ error: 'invalid_client' });

    const { code: mismatchCode } = await authorizeAndApprove(
      baseUrl,
      new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: redirectUri,
      }),
    );
    const mismatch = await exchangeCode(
      baseUrl,
      mismatchCode,
      'https://layla.amazon.com/api/skill/link/other',
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: 'invalid_grant' });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'));
    const { code: expiredCode } = await authorizeAndApprove(
      baseUrl,
      new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: redirectUri,
      }),
    );
    vi.setSystemTime(new Date('2026-04-03T00:06:00.000Z'));
    const expired = await exchangeCode(baseUrl, expiredCode, redirectUri);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('supports PKCE and refresh token rotation', async () => {
    runtime = await startAlexaServer(buildConfig());
    const baseUrl = `http://127.0.0.1:${runtime!.getStatus().port}`;
    const redirectUri = 'https://layla.amazon.com/api/skill/link/test';
    const verifier = 'pkce-verifier-123456789';
    const challenge = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier),
    ).then((buffer) => Buffer.from(buffer).toString('base64url'));

    const { code } = await authorizeAndApprove(
      baseUrl,
      new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );

    const tokenResponse = await exchangeCode(baseUrl, code, redirectUri, {
      code_verifier: verifier,
    });
    expect(tokenResponse.status).toBe(200);
    const payload = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const refresh = await fetch(`${baseUrl}/alexa/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('client-1:client-secret-1').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: payload.refresh_token,
      }),
    });

    expect(refresh.status).toBe(200);
    const refreshed = (await refresh.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).not.toBe(payload.access_token);
    expect(refreshed.refresh_token).not.toBe(payload.refresh_token);
  });

  it('uses an OAuth-issued access token for a linked Alexa personal request and binds the Alexa principal', async () => {
    runtime = await startAlexaServer(buildConfig());
    const status = runtime!.getStatus();
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const redirectUri = 'https://layla.amazon.com/api/skill/link/test';

    const { code } = await authorizeAndApprove(
      baseUrl,
      new URLSearchParams({
        response_type: 'code',
        client_id: 'client-1',
        redirect_uri: redirectUri,
      }),
    );
    const tokenResponse = await exchangeCode(baseUrl, code, redirectUri);
    const payload = (await tokenResponse.json()) as {
      access_token: string;
    };

    const intentResponse = await fetch(`${baseUrl}${status.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        buildIntentEnvelope('TomorrowCalendarIntent', payload.access_token),
      ),
    });
    expect(intentResponse.status).toBe(200);
    const responseEnvelope = (await intentResponse.json()) as ResponseEnvelope;
    expect(extractSpeechText(responseEnvelope).toLowerCase()).toContain('tomorrow');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();

    const bound = getAlexaLinkedAccountByAccessTokenHash(
      hashAlexaAccessToken(payload.access_token),
    );
    expect(bound).toMatchObject({
      allowedAlexaUserId: 'amzn1.ask.account.oauth-user',
      allowedAlexaPersonId: 'amzn1.ask.person.oauth-person',
      groupFolder: 'main',
    });
  });
});
