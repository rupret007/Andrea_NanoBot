import crypto from 'crypto';
import http from 'http';

import {
  consumeAlexaOAuthAuthorizationCode,
  disableAlexaOAuthRefreshToken,
  getAlexaOAuthAuthorizationCode,
  getAlexaOAuthRefreshToken,
  insertAlexaOAuthAuthorizationCode,
  insertAlexaOAuthRefreshToken,
  purgeExpiredAlexaOAuthAuthorizationCodes,
  purgeExpiredAlexaOAuthRefreshTokens,
  upsertAlexaLinkedAccount,
} from './db.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { type AlexaLinkedAccount } from './types.js';

const DEFAULT_OAUTH_SCOPE = 'andrea.alexa.link';
const DEFAULT_CODE_TTL_SEC = 300;
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;
const OAUTH_REALM = 'Andrea Alexa OAuth';

const OFFICIAL_ALEXA_REDIRECT_ORIGINS = [
  'https://layla.amazon.com',
  'https://pitangui.amazon.com',
  'https://alexa.amazon.co.jp',
] as const;

export interface AlexaOAuthConfig {
  clientId: string;
  clientSecret: string;
  scope: string;
  allowedRedirectUris: string[];
  oauthBasePath: string;
  authorizationPath: string;
  approvalPath: string;
  tokenPath: string;
  healthPath: string;
  codeTtlSec: number;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  groupFolder: string;
  displayName: string;
}

export interface AlexaOAuthStatus {
  enabled: boolean;
  authorizationPath?: string;
  tokenPath?: string;
  healthPath?: string;
  scope?: string;
  groupFolder?: string;
  allowedRedirectUrisCount?: number;
}

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'plain' | 'S256';
}

interface ApprovalPayload extends AuthorizeRequest {
  displayName: string;
  groupFolder: string;
  expiresAt: string;
}

interface OAuthClientAuth {
  clientId: string;
  clientSecret: string;
}

function normalizePath(value: string): string {
  if (value.endsWith('/')) return value.slice(0, -1);
  return value;
}

function buildOAuthBasePath(alexaPath: string): string {
  return `${normalizePath(alexaPath)}/oauth`;
}

function pathFor(basePath: string, suffix: string): string {
  return `${normalizePath(basePath)}${suffix}`;
}

function normalizeScope(value: string | undefined, fallback: string): string {
  const normalized = (value || fallback)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return normalized || fallback;
}

function parseIntWithDefault(
  value: string | undefined,
  fallback: number,
  key: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${key} "${value}"`);
  }
  return parsed;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hashOpaqueValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomOpaqueValue(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signApprovalPayload(
  encodedPayload: string,
  config: AlexaOAuthConfig,
): string {
  return crypto
    .createHmac('sha256', `${config.clientSecret}:approval`)
    .update(encodedPayload)
    .digest('base64url');
}

function nowIso(): string {
  return new Date().toISOString();
}

function isOfficialAlexaRedirectUri(redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== 'https:') return false;
    return (
      OFFICIAL_ALEXA_REDIRECT_ORIGINS.includes(parsed.origin as never) &&
      parsed.pathname.startsWith('/api/skill/link/') &&
      parsed.pathname.length > '/api/skill/link/'.length
    );
  } catch {
    return false;
  }
}

function isAllowedRedirectUri(
  redirectUri: string,
  config: AlexaOAuthConfig,
): boolean {
  if (config.allowedRedirectUris.length > 0) {
    return config.allowedRedirectUris.includes(redirectUri);
  }
  return isOfficialAlexaRedirectUri(redirectUri);
}

function parseAuthorizeRequest(
  url: URL,
  config: AlexaOAuthConfig,
): AuthorizeRequest {
  const responseType = url.searchParams.get('response_type') || '';
  if (responseType !== 'code') {
    throw new Error('authorize_unsupported_response_type');
  }

  const clientId = (url.searchParams.get('client_id') || '').trim();
  if (!clientId || clientId !== config.clientId) {
    throw new Error('authorize_invalid_client');
  }

  const redirectUri = (url.searchParams.get('redirect_uri') || '').trim();
  if (!redirectUri || !isAllowedRedirectUri(redirectUri, config)) {
    throw new Error('authorize_invalid_redirect_uri');
  }

  const scope = normalizeScope(url.searchParams.get('scope') || '', config.scope);
  if (scope !== config.scope) {
    throw new Error('authorize_invalid_scope');
  }

  const codeChallenge = (url.searchParams.get('code_challenge') || '').trim();
  const rawMethod = (url.searchParams.get('code_challenge_method') || '').trim();
  let codeChallengeMethod: 'plain' | 'S256' | undefined;
  if (codeChallenge) {
    codeChallengeMethod = rawMethod === 'S256' ? 'S256' : 'plain';
    if (rawMethod && rawMethod !== 'plain' && rawMethod !== 'S256') {
      throw new Error('authorize_invalid_code_challenge_method');
    }
  } else if (rawMethod) {
    throw new Error('authorize_invalid_code_challenge');
  }

  return {
    clientId,
    redirectUri,
    state: (url.searchParams.get('state') || '').trim() || undefined,
    scope,
    codeChallenge: codeChallenge || undefined,
    codeChallengeMethod,
  };
}

function buildApprovalPayload(
  request: AuthorizeRequest,
  config: AlexaOAuthConfig,
  now = new Date(),
): ApprovalPayload {
  return {
    ...request,
    displayName: config.displayName,
    groupFolder: config.groupFolder,
    expiresAt: new Date(
      now.getTime() + config.codeTtlSec * 1000,
    ).toISOString(),
  };
}

function parseApprovalPayload(
  encodedPayload: string,
  signature: string,
  config: AlexaOAuthConfig,
  now = nowIso(),
): ApprovalPayload {
  const expected = signApprovalPayload(encodedPayload, config);
  const provided = Buffer.from(signature || '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    provided.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(provided, expectedBuffer)
  ) {
    throw new Error('approval_invalid_signature');
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as ApprovalPayload;
  if (payload.expiresAt <= now) {
    throw new Error('approval_expired_request');
  }
  assertValidGroupFolder(payload.groupFolder);
  if (payload.groupFolder !== config.groupFolder) {
    throw new Error('approval_invalid_group_folder');
  }
  if (payload.clientId !== config.clientId) {
    throw new Error('approval_invalid_client');
  }
  if (!isAllowedRedirectUri(payload.redirectUri, config)) {
    throw new Error('approval_invalid_redirect_uri');
  }
  if (normalizeScope(payload.scope, config.scope) !== config.scope) {
    throw new Error('approval_invalid_scope');
  }

  if (payload.codeChallengeMethod) {
    if (!payload.codeChallenge) {
      throw new Error('approval_invalid_code_challenge');
    }
    if (
      payload.codeChallengeMethod !== 'plain' &&
      payload.codeChallengeMethod !== 'S256'
    ) {
      throw new Error('approval_invalid_code_challenge_method');
    }
  }

  return payload;
}

function parseBasicAuth(
  authorizationHeader: string | undefined,
): OAuthClientAuth | null {
  if (!authorizationHeader?.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(
      authorizationHeader.slice('Basic '.length),
      'base64',
    ).toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function verifyPkce(
  verifier: string,
  challenge: string,
  method: 'plain' | 'S256',
): boolean {
  if (method === 'plain') {
    return verifier === challenge;
  }
  const hashed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return hashed === challenge;
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function writeHtml(
  response: http.ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-frame-options': 'DENY',
  });
  response.end(body);
}

function writeOAuthError(
  response: http.ServerResponse,
  status: number,
  title: string,
  detail: string,
): void {
  writeHtml(
    response,
    status,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${htmlEscape(title)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; color: #1f2937; }
      main { max-width: 42rem; }
      h1 { font-size: 1.4rem; }
      p, li { line-height: 1.5; }
      code { background: #f3f4f6; padding: 0.1rem 0.3rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${htmlEscape(title)}</h1>
      <p>${htmlEscape(detail)}</p>
    </main>
  </body>
</html>`,
  );
}

function buildRedirectLocation(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const location = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      location.searchParams.set(key, value);
    }
  }
  return location.toString();
}

async function readRawBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function issueAccessToken(
  config: AlexaOAuthConfig,
  displayName: string,
  groupFolder: string,
  createdAt: string,
): { token: string; record: AlexaLinkedAccount } {
  const accessToken = randomOpaqueValue(32);
  const record: AlexaLinkedAccount = {
    accessTokenHash: hashOpaqueValue(accessToken),
    displayName,
    groupFolder,
    allowedAlexaUserId: null,
    allowedAlexaPersonId: null,
    createdAt,
    updatedAt: createdAt,
    disabledAt: null,
  };
  upsertAlexaLinkedAccount(record);
  return { token: accessToken, record };
}

function issueRefreshToken(
  config: AlexaOAuthConfig,
  clientId: string,
  scope: string,
  displayName: string,
  groupFolder: string,
  createdAt: string,
): { token: string } {
  const refreshToken = randomOpaqueValue(32);
  insertAlexaOAuthRefreshToken({
    refreshTokenHash: hashOpaqueValue(refreshToken),
    clientId,
    scope,
    groupFolder,
    displayName,
    createdAt,
    expiresAt: new Date(
      Date.parse(createdAt) + config.refreshTokenTtlSec * 1000,
    ).toISOString(),
    disabledAt: null,
  });
  return { token: refreshToken };
}

function renderApprovalPage(
  encodedPayload: string,
  signature: string,
  payload: ApprovalPayload,
): string {
  const redirectHost = new URL(payload.redirectUri).host;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Approve Andrea Alexa Link</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; color: #111827; background: #f9fafb; }
      main { max-width: 44rem; margin: 0 auto; background: white; padding: 1.5rem; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }
      h1 { font-size: 1.5rem; margin-top: 0; }
      dl { display: grid; grid-template-columns: 11rem 1fr; gap: 0.5rem 1rem; }
      dt { font-weight: 700; }
      dd { margin: 0; word-break: break-word; }
      .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
      button { font-size: 1rem; padding: 0.7rem 1.1rem; border-radius: 999px; border: 0; cursor: pointer; }
      .approve { background: #111827; color: white; }
      .deny { background: #e5e7eb; color: #111827; }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Link Alexa to Andrea</h1>
      <p>Alexa wants permission to use Andrea as your personal assistant for this private POC.</p>
      <dl>
        <dt>Account</dt>
        <dd>${htmlEscape(payload.displayName)}</dd>
        <dt>Group Folder</dt>
        <dd><code>${htmlEscape(payload.groupFolder)}</code></dd>
        <dt>Scope</dt>
        <dd><code>${htmlEscape(payload.scope)}</code></dd>
        <dt>Redirect Host</dt>
        <dd>${htmlEscape(redirectHost)}</dd>
      </dl>
      <form method="post" action="/alexa/oauth/approve">
        <input type="hidden" name="request" value="${htmlEscape(encodedPayload)}" />
        <input type="hidden" name="sig" value="${htmlEscape(signature)}" />
        <div class="actions">
          <button class="approve" type="submit" name="decision" value="approve">Approve</button>
          <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

export function resolveAlexaOAuthConfig(
  env = process.env,
  alexaPath = '/alexa',
): AlexaOAuthConfig | null {
  const envFile =
    env === process.env
      ? readEnvFile([
          'ALEXA_OAUTH_CLIENT_ID',
          'ALEXA_OAUTH_CLIENT_SECRET',
          'ALEXA_OAUTH_SCOPE',
          'ALEXA_OAUTH_ALLOWED_REDIRECT_URIS',
          'ALEXA_OAUTH_CODE_TTL_SEC',
          'ALEXA_OAUTH_ACCESS_TOKEN_TTL_SEC',
          'ALEXA_OAUTH_REFRESH_TOKEN_TTL_SEC',
          'ALEXA_LINKED_ACCOUNT_GROUP_FOLDER',
          'ALEXA_LINKED_ACCOUNT_NAME',
          'ALEXA_TARGET_GROUP_FOLDER',
        ])
      : {};

  const clientId = (
    env.ALEXA_OAUTH_CLIENT_ID ||
    envFile.ALEXA_OAUTH_CLIENT_ID ||
    ''
  ).trim();
  const clientSecret = (
    env.ALEXA_OAUTH_CLIENT_SECRET ||
    envFile.ALEXA_OAUTH_CLIENT_SECRET ||
    ''
  ).trim();
  const scope = normalizeScope(
    env.ALEXA_OAUTH_SCOPE || envFile.ALEXA_OAUTH_SCOPE,
    DEFAULT_OAUTH_SCOPE,
  );
  const allowedRedirectUris = (
    env.ALEXA_OAUTH_ALLOWED_REDIRECT_URIS ||
    envFile.ALEXA_OAUTH_ALLOWED_REDIRECT_URIS ||
    ''
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const groupFolder = (
    env.ALEXA_LINKED_ACCOUNT_GROUP_FOLDER ||
    envFile.ALEXA_LINKED_ACCOUNT_GROUP_FOLDER ||
    env.ALEXA_TARGET_GROUP_FOLDER ||
    envFile.ALEXA_TARGET_GROUP_FOLDER ||
    'main'
  ).trim();
  const displayName = (
    env.ALEXA_LINKED_ACCOUNT_NAME ||
    envFile.ALEXA_LINKED_ACCOUNT_NAME ||
    'Andrea Alexa'
  ).trim();

  const configuredValues = [
    clientId,
    clientSecret,
    scope !== DEFAULT_OAUTH_SCOPE ? scope : '',
    allowedRedirectUris.join(','),
  ].filter(Boolean);
  if (configuredValues.length === 0) return null;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Alexa OAuth configuration requires both ALEXA_OAUTH_CLIENT_ID and ALEXA_OAUTH_CLIENT_SECRET.',
    );
  }

  assertValidGroupFolder(groupFolder);
  const oauthBasePath = buildOAuthBasePath(alexaPath);
  return {
    clientId,
    clientSecret,
    scope,
    allowedRedirectUris,
    oauthBasePath,
    authorizationPath: pathFor(oauthBasePath, '/authorize'),
    approvalPath: pathFor(oauthBasePath, '/approve'),
    tokenPath: pathFor(oauthBasePath, '/token'),
    healthPath: pathFor(oauthBasePath, '/health'),
    codeTtlSec: parseIntWithDefault(
      env.ALEXA_OAUTH_CODE_TTL_SEC || envFile.ALEXA_OAUTH_CODE_TTL_SEC,
      DEFAULT_CODE_TTL_SEC,
      'ALEXA_OAUTH_CODE_TTL_SEC',
    ),
    accessTokenTtlSec: parseIntWithDefault(
      env.ALEXA_OAUTH_ACCESS_TOKEN_TTL_SEC ||
        envFile.ALEXA_OAUTH_ACCESS_TOKEN_TTL_SEC,
      DEFAULT_ACCESS_TOKEN_TTL_SEC,
      'ALEXA_OAUTH_ACCESS_TOKEN_TTL_SEC',
    ),
    refreshTokenTtlSec: parseIntWithDefault(
      env.ALEXA_OAUTH_REFRESH_TOKEN_TTL_SEC ||
        envFile.ALEXA_OAUTH_REFRESH_TOKEN_TTL_SEC,
      DEFAULT_REFRESH_TOKEN_TTL_SEC,
      'ALEXA_OAUTH_REFRESH_TOKEN_TTL_SEC',
    ),
    groupFolder,
    displayName,
  };
}

export function getAlexaOAuthStatus(
  config = resolveAlexaOAuthConfig(),
): AlexaOAuthStatus {
  if (!config) return { enabled: false };
  return {
    enabled: true,
    authorizationPath: config.authorizationPath,
    tokenPath: config.tokenPath,
    healthPath: config.healthPath,
    scope: config.scope,
    groupFolder: config.groupFolder,
    allowedRedirectUrisCount: config.allowedRedirectUris.length,
  };
}

function authenticateClient(
  request: http.IncomingMessage,
  config: AlexaOAuthConfig,
): OAuthClientAuth {
  const auth = parseBasicAuth(request.headers.authorization);
  if (!auth) {
    throw new Error('invalid_client');
  }
  if (auth.clientId !== config.clientId || auth.clientSecret !== config.clientSecret) {
    throw new Error('invalid_client');
  }
  return auth;
}

async function handleAuthorizeRequest(
  response: http.ServerResponse,
  url: URL,
  config: AlexaOAuthConfig,
): Promise<void> {
  const request = parseAuthorizeRequest(url, config);
  const payload = buildApprovalPayload(request, config);
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signApprovalPayload(encodedPayload, config);
  writeHtml(response, 200, renderApprovalPage(encodedPayload, signature, payload));
}

async function handleApprovalRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: AlexaOAuthConfig,
): Promise<void> {
  const rawBody = await readRawBody(request);
  const form = new URLSearchParams(rawBody);
  const decision = (form.get('decision') || '').trim();
  const encodedPayload = (form.get('request') || '').trim();
  const signature = (form.get('sig') || '').trim();
  if (!encodedPayload || !signature) {
    throw new Error('approval_invalid_request');
  }

  const payload = parseApprovalPayload(encodedPayload, signature, config);
  const location =
    decision === 'deny'
      ? buildRedirectLocation(payload.redirectUri, {
          error: 'access_denied',
          state: payload.state,
        })
      : buildRedirectLocation(payload.redirectUri, {
          code: (() => {
            const authorizationCode = randomOpaqueValue(24);
            const issuedAt = nowIso();
            insertAlexaOAuthAuthorizationCode({
              codeHash: hashOpaqueValue(authorizationCode),
              clientId: payload.clientId,
              redirectUri: payload.redirectUri,
              scope: payload.scope,
              codeChallenge: payload.codeChallenge || null,
              codeChallengeMethod: payload.codeChallengeMethod || null,
              groupFolder: payload.groupFolder,
              displayName: payload.displayName,
              createdAt: issuedAt,
              expiresAt: new Date(
                Date.parse(issuedAt) + config.codeTtlSec * 1000,
              ).toISOString(),
              usedAt: null,
            });
            return authorizationCode;
          })(),
          state: payload.state,
        });

  response.writeHead(303, {
    location,
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
  response.end();
}

async function handleTokenRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: AlexaOAuthConfig,
): Promise<void> {
  authenticateClient(request, config);
  purgeExpiredAlexaOAuthAuthorizationCodes();
  purgeExpiredAlexaOAuthRefreshTokens();

  const rawBody = await readRawBody(request);
  const form = new URLSearchParams(rawBody);
  const grantType = (form.get('grant_type') || '').trim();

  if (grantType === 'authorization_code') {
    const code = (form.get('code') || '').trim();
    const redirectUri = (form.get('redirect_uri') || '').trim();
    const codeVerifier = (form.get('code_verifier') || '').trim();
    if (!code || !redirectUri) {
      throw new Error('invalid_request');
    }

    const record = getAlexaOAuthAuthorizationCode(hashOpaqueValue(code));
    if (!record || record.usedAt || record.expiresAt <= nowIso()) {
      throw new Error('invalid_grant');
    }
    if (record.clientId !== config.clientId || record.redirectUri !== redirectUri) {
      throw new Error('invalid_grant');
    }
    if (record.codeChallenge) {
      if (!codeVerifier) {
        throw new Error('invalid_grant');
      }
      const method = record.codeChallengeMethod || 'plain';
      if (!verifyPkce(codeVerifier, record.codeChallenge, method)) {
        throw new Error('invalid_grant');
      }
    }
    const usedAt = nowIso();
    if (!consumeAlexaOAuthAuthorizationCode(record.codeHash, usedAt, usedAt)) {
      throw new Error('invalid_grant');
    }

    const access = issueAccessToken(
      config,
      record.displayName,
      record.groupFolder,
      usedAt,
    );
    const refresh = issueRefreshToken(
      config,
      config.clientId,
      record.scope,
      record.displayName,
      record.groupFolder,
      usedAt,
    );
    writeJson(response, 200, {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSec,
      refresh_token: refresh.token,
      scope: record.scope,
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = (form.get('refresh_token') || '').trim();
    const requestedScope = normalizeScope(
      form.get('scope') || '',
      config.scope,
    );
    if (!refreshToken) {
      throw new Error('invalid_request');
    }

    const record = getAlexaOAuthRefreshToken(hashOpaqueValue(refreshToken));
    const currentTime = nowIso();
    if (
      !record ||
      record.disabledAt ||
      record.expiresAt <= currentTime ||
      record.clientId !== config.clientId
    ) {
      throw new Error('invalid_grant');
    }
    if (requestedScope !== record.scope) {
      throw new Error('invalid_scope');
    }
    if (!disableAlexaOAuthRefreshToken(record.refreshTokenHash, currentTime)) {
      throw new Error('invalid_grant');
    }

    const access = issueAccessToken(
      config,
      record.displayName,
      record.groupFolder,
      currentTime,
    );
    const nextRefresh = issueRefreshToken(
      config,
      record.clientId,
      record.scope,
      record.displayName,
      record.groupFolder,
      currentTime,
    );
    writeJson(response, 200, {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSec,
      refresh_token: nextRefresh.token,
      scope: record.scope,
    });
    return;
  }

  throw new Error('unsupported_grant_type');
}

export async function handleAlexaOAuthRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  alexaPath = '/alexa',
  config = resolveAlexaOAuthConfig(process.env, alexaPath),
): Promise<boolean> {
  const pathname = new URL(
    request.url || '/',
    `http://${request.headers.host || '127.0.0.1'}`,
  ).pathname;
  const oauthBasePath = buildOAuthBasePath(alexaPath);
  if (!pathname.startsWith(oauthBasePath)) {
    return false;
  }

  if (!config) {
    if (request.method === 'GET' && pathname === pathFor(oauthBasePath, '/health')) {
      writeJson(response, 503, {
        ok: false,
        configured: false,
        reason: 'oauth_not_configured',
      });
      return true;
    }
    writeJson(response, 503, {
      error: 'OAuth not configured',
    });
    return true;
  }

  try {
    if (request.method === 'GET' && pathname === config.healthPath) {
      writeJson(response, 200, {
        ok: true,
        configured: true,
        authorizePath: config.authorizationPath,
        tokenPath: config.tokenPath,
        scope: config.scope,
        groupFolder: config.groupFolder,
      });
      return true;
    }

    if (request.method === 'GET' && pathname === config.authorizationPath) {
      const url = new URL(
        request.url || config.authorizationPath,
        `http://${request.headers.host || '127.0.0.1'}`,
      );
      await handleAuthorizeRequest(response, url, config);
      return true;
    }

    if (request.method === 'POST' && pathname === config.approvalPath) {
      await handleApprovalRequest(request, response, config);
      return true;
    }

    if (request.method === 'POST' && pathname === config.tokenPath) {
      await handleTokenRequest(request, response, config);
      return true;
    }

    writeJson(response, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    logger.warn({ err }, 'Alexa OAuth request failed');
    const message =
      err instanceof Error ? err.message : 'oauth_request_failed';
    switch (message) {
      case 'invalid_client':
        writeJson(
          response,
          401,
          {
            error: 'invalid_client',
            error_description: 'Client authentication failed.',
          },
          { 'www-authenticate': `Basic realm="${OAUTH_REALM}"` },
        );
        return true;
      case 'invalid_scope':
        writeJson(response, 400, {
          error: 'invalid_scope',
          error_description: 'The requested scope is not allowed.',
        });
        return true;
      case 'unsupported_grant_type':
        writeJson(response, 400, {
          error: 'unsupported_grant_type',
          error_description: 'This OAuth server only supports authorization_code and refresh_token.',
        });
        return true;
      case 'invalid_grant':
        writeJson(response, 400, {
          error: 'invalid_grant',
          error_description: 'The authorization code or refresh token is invalid.',
        });
        return true;
      case 'authorize_unsupported_response_type':
        writeOAuthError(
          response,
          400,
          'Unsupported response type',
          'Andrea only supports the OAuth authorization code flow for Alexa account linking.',
        );
        return true;
      case 'authorize_invalid_client':
        writeOAuthError(
          response,
          400,
          'Client rejected',
          'Andrea does not recognize this Alexa OAuth client ID.',
        );
        return true;
      case 'authorize_invalid_redirect_uri':
        writeOAuthError(
          response,
          400,
          'Redirect URI rejected',
          'This redirect URI is not allowed for the Andrea Alexa OAuth POC.',
        );
        return true;
      case 'authorize_invalid_scope':
        writeOAuthError(
          response,
          400,
          'Scope rejected',
          'This Alexa account-link request asked for a scope Andrea does not allow.',
        );
        return true;
      case 'authorize_invalid_code_challenge':
      case 'authorize_invalid_code_challenge_method':
        writeOAuthError(
          response,
          400,
          'PKCE request rejected',
          'The PKCE challenge on this request is incomplete or unsupported.',
        );
        return true;
      case 'approval_invalid_request':
      case 'approval_invalid_group_folder':
      case 'approval_expired_request':
      case 'approval_invalid_signature':
      case 'approval_invalid_client':
      case 'approval_invalid_redirect_uri':
      case 'approval_invalid_scope':
      case 'approval_invalid_code_challenge':
      case 'approval_invalid_code_challenge_method':
        writeOAuthError(
          response,
          400,
          'Authorization request rejected',
          'Andrea could not validate that approval request. Start account linking again from Alexa.',
        );
        return true;
      case 'invalid_request':
        writeJson(response, 400, {
          error: 'invalid_request',
          error_description: 'The token request is missing a required field.',
        });
        return true;
      default:
        writeJson(response, 500, {
          error: 'server_error',
          error_description: 'Andrea hit an OAuth server problem.',
        });
        return true;
    }
  }
}
