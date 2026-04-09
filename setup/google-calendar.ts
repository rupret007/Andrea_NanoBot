import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import {
  classifyGoogleCalendarFailureDetail,
  listGoogleCalendars,
  resolveGoogleCalendarConfig,
  validateGoogleCalendarConfig,
} from '../src/google-calendar.js';
import {
  buildGoogleCalendarBlockedProofSurface,
  buildGoogleCalendarNearLiveSurface,
} from '../src/google-calendar-proof.js';
import { writeProviderProofSurface } from '../src/provider-proof-state.js';
import { upsertEnvFileValues } from '../src/env.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

const GOOGLE_NATIVE_AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST = '127.0.0.1';

interface InstalledGoogleClientSecret {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

interface GoogleCalendarSetupArgs {
  action: 'auth' | 'auth-complete' | 'discover' | 'validate' | '';
  clientSecretJsonPath: string | null;
  select: string | null;
  callbackUrl: string | null;
}

interface PendingGoogleCalendarAuthState {
  clientSecretJsonPath: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  createdAt: string;
}

function toErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitGoogleCalendarFailureStatus(
  action: GoogleCalendarSetupArgs['action'],
  error: unknown,
  extra: Record<string, string | number | boolean> = {},
): void {
  const detail = toErrorDetail(error);
  writeProviderProofSurface(
    'googleCalendar',
    buildGoogleCalendarBlockedProofSurface(
      detail,
      new Date().toISOString(),
      'verify',
    ),
    process.cwd(),
  );
  emitStatus('GOOGLE_CALENDAR', {
    ACTION: action || 'unknown',
    STATUS: 'failed',
    FAILURE_KIND: classifyGoogleCalendarFailureDetail(detail),
    ERROR: detail,
    ...extra,
  });
}

function parseArgs(args: string[]): GoogleCalendarSetupArgs {
  const result: GoogleCalendarSetupArgs = {
    action: (args[0] || '').toLowerCase() as GoogleCalendarSetupArgs['action'],
    clientSecretJsonPath: null,
    select: null,
    callbackUrl: null,
  };

  for (let i = 1; i < args.length; i += 1) {
    const current = args[i];
    if (current === '--client-secret-json') {
      result.clientSecretJsonPath = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (current === '--select') {
      result.select = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (current === '--callback-url') {
      result.callbackUrl = args[i + 1] || null;
      i += 1;
    }
  }

  return result;
}

export function parseGoogleInstalledClientSecretJson(
  raw: string,
): InstalledGoogleClientSecret {
  const parsed = JSON.parse(raw) as {
    installed?: {
      client_id?: string;
      client_secret?: string;
      auth_uri?: string;
      token_uri?: string;
    };
  };

  const installed = parsed.installed;
  if (
    !installed?.client_id ||
    !installed.client_secret ||
    !installed.auth_uri ||
    !installed.token_uri
  ) {
    throw new Error(
      'Google client secret JSON must contain an installed client with client_id, client_secret, auth_uri, and token_uri.',
    );
  }

  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    authUri: installed.auth_uri,
    tokenUri: installed.token_uri,
  };
}

function openUrl(url: string): void {
  if (process.platform === 'win32') {
    const escapedUrl = url.replace(/'/g, "''");
    spawn(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process -FilePath '${escapedUrl}'`],
      {
        detached: true,
        stdio: 'ignore',
      },
    ).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  spawn('xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_NATIVE_AUTH_URI);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

export function buildGoogleCalendarLoopbackRedirectUri(
  port: number,
  host = GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST,
): string {
  return `http://${host}:${port}`;
}

export function getGoogleCalendarPendingAuthStatePath(
  projectRoot = process.cwd(),
): string {
  return path.join(
    projectRoot,
    'data',
    'runtime',
    'google-calendar-auth-pending.json',
  );
}

function writeGoogleCalendarPendingAuthState(
  state: PendingGoogleCalendarAuthState,
  projectRoot = process.cwd(),
): void {
  const targetPath = getGoogleCalendarPendingAuthStatePath(projectRoot);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(`${targetPath}`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function readGoogleCalendarPendingAuthState(
  projectRoot = process.cwd(),
): PendingGoogleCalendarAuthState | null {
  const targetPath = getGoogleCalendarPendingAuthStatePath(projectRoot);
  if (!fs.existsSync(targetPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as PendingGoogleCalendarAuthState;
}

function clearGoogleCalendarPendingAuthState(projectRoot = process.cwd()): void {
  fs.rmSync(getGoogleCalendarPendingAuthStatePath(projectRoot), { force: true });
}

export function parseGoogleCalendarAuthCallbackUrl(input: string): {
  callbackUrl: string;
  state: string | null;
  code: string | null;
  error: string | null;
} {
  const parsed = new URL(input.trim());
  return {
    callbackUrl: parsed.toString(),
    state: parsed.searchParams.get('state'),
    code: parsed.searchParams.get('code'),
    error: parsed.searchParams.get('error'),
  };
}

function toBase64Url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createGooglePkcePair(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  const codeVerifier = toBase64Url(crypto.randomBytes(64));
  const codeChallenge = toBase64Url(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  );
  return {
    codeVerifier,
    codeChallenge,
  };
}

async function exchangeAuthCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUri: string;
  codeVerifier: string;
}): Promise<{ refreshToken: string }> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
  });

  const response = await fetch(input.tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Google OAuth token exchange ${response.status}: ${text.replace(/\s+/g, ' ').trim()}`,
    );
  }

  const payload = JSON.parse(text) as {
    refresh_token?: string;
  };

  if (!payload.refresh_token) {
    throw new Error(
      'Google OAuth token exchange did not return a refresh token. Make sure you approved consent and your account is allowed as a test user.',
    );
  }

  return {
    refreshToken: payload.refresh_token,
  };
}

export async function waitForAuthCode(
  server: http.Server,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for the Google OAuth callback.'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      try {
        const parsed = new URL(
          req.url || '/',
          buildGoogleCalendarLoopbackRedirectUri(80),
        );
        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        const error = parsed.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1>Google Calendar auth failed.</h1><p>You can close this window and return to Codex.</p>',
          );
          clearTimeout(timeout);
          reject(new Error(`Google OAuth returned error: ${error}`));
          return;
        }

        if (!code || !state || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1>Google Calendar auth failed.</h1><p>The callback was missing a valid code or state.</p>',
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Google Calendar connected.</h1><p>You can close this window and return to Codex.</p>',
        );
        clearTimeout(timeout);
        resolve(code);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function formatCalendarSummaryLine(
  calendar: {
    summary: string;
    id: string;
    primary: boolean;
    accessRole: string;
    writable: boolean;
    selected?: boolean;
  },
  index?: number,
): string {
  const parts = [
    index ? `${index}.` : '-',
    calendar.summary,
    calendar.primary ? '(primary)' : '',
    `[${calendar.accessRole}]`,
    calendar.writable ? '[writable]' : '[read-only]',
    calendar.selected ? '[selected]' : '',
  ].filter(Boolean);
  return `${parts.join(' ')}\n   id: ${calendar.id}`;
}

export function resolveCalendarSelection(
  selection: string,
  calendars: Array<{
    id: string;
    summary: string;
    primary: boolean;
    accessRole: string;
    writable: boolean;
  }>,
): string[] {
  const trimmed = selection.trim();
  if (!trimmed) return [];
  if (trimmed.toLowerCase() === 'all') {
    return calendars.map((calendar) => calendar.id);
  }

  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const ids: string[] = [];

  for (const part of parts) {
    if (part.toLowerCase() === 'primary') {
      const primaryCalendar = calendars.find((calendar) => calendar.primary);
      if (primaryCalendar) {
        ids.push(primaryCalendar.id);
      }
      continue;
    }

    if (/^\d+$/.test(part)) {
      const calendar = calendars[Number(part) - 1];
      if (calendar) {
        ids.push(calendar.id);
      }
      continue;
    }

    const byId = calendars.find((calendar) => calendar.id === part);
    if (byId) {
      ids.push(byId.id);
      continue;
    }

    const bySummary = calendars.find(
      (calendar) => calendar.summary.toLowerCase() === part.toLowerCase(),
    );
    if (bySummary) {
      ids.push(bySummary.id);
    }
  }

  return [...new Set(ids)];
}

async function runAuth(clientSecretJsonPath: string): Promise<void> {
  const absolutePath = path.resolve(clientSecretJsonPath);
  let server: http.Server | null = null;
  let redirectUri = '';
  try {
    const raw = fs.readFileSync(absolutePath, 'utf-8');
    const client = parseGoogleInstalledClientSecretJson(raw);
    const state = crypto.randomBytes(16).toString('hex');
    const pkce = createGooglePkcePair();
    server = http.createServer();

    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST, () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error(
        `Could not open a ${GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST} callback server for Google OAuth.`,
      );
    }

    redirectUri = buildGoogleCalendarLoopbackRedirectUri(address.port);
    writeGoogleCalendarPendingAuthState({
      clientSecretJsonPath: absolutePath,
      redirectUri,
      state,
      codeVerifier: pkce.codeVerifier,
      createdAt: new Date().toISOString(),
    });
    const authUrl = buildGoogleAuthUrl({
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: pkce.codeChallenge,
    });

    logger.info(
      { redirectUri, hostname: os.hostname() },
      'Starting Google Calendar OAuth bootstrap',
    );
    console.log(
      'Open this URL in your browser if it does not launch automatically:',
    );
    console.log(authUrl);
    openUrl(authUrl);

    const code = await waitForAuthCode(server, state);
    const token = await exchangeAuthCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri,
      tokenUri: client.tokenUri,
      codeVerifier: pkce.codeVerifier,
    });

    upsertEnvFileValues({
      GOOGLE_CALENDAR_CLIENT_ID: client.clientId,
      GOOGLE_CALENDAR_CLIENT_SECRET: client.clientSecret,
      GOOGLE_CALENDAR_REFRESH_TOKEN: token.refreshToken,
    });
    clearGoogleCalendarPendingAuthState();

    emitStatus('GOOGLE_CALENDAR', {
      ACTION: 'auth',
      STATUS: 'success',
      CLIENT_SECRET_JSON: absolutePath,
      STORED_CLIENT_ID: 'true',
      STORED_REFRESH_TOKEN: 'true',
      SCOPES: GOOGLE_CALENDAR_SCOPES.join(' '),
    });
  } catch (error) {
    emitGoogleCalendarFailureStatus('auth', error, {
      CLIENT_SECRET_JSON: absolutePath,
      CALLBACK_HOST: GOOGLE_CALENDAR_OAUTH_LOOPBACK_HOST,
      CALLBACK_URL:
        redirectUri ||
        `${buildGoogleCalendarLoopbackRedirectUri(0).replace(/:0$/, '')}:<port>`,
      CALLBACK_STATE_PATH: getGoogleCalendarPendingAuthStatePath(),
    });
    process.exit(1);
  } finally {
    server?.close();
  }
}

export async function completeGoogleCalendarAuthFromCallbackUrl(
  callbackUrl: string,
  projectRoot = process.cwd(),
): Promise<{
  clientSecretJsonPath: string;
  redirectUri: string;
}> {
  const pending = readGoogleCalendarPendingAuthState(projectRoot);
  if (!pending) {
    throw new Error(
      'No pending Google Calendar OAuth session was found. Run `npm run setup -- --step google-calendar auth --client-secret-json "<client-secret.json>"` first.',
    );
  }

  const parsed = parseGoogleCalendarAuthCallbackUrl(callbackUrl);
  if (parsed.error) {
    throw new Error(`Google OAuth returned error: ${parsed.error}`);
  }
  if (!parsed.code) {
    throw new Error('The callback URL is missing the Google OAuth code.');
  }
  if (!parsed.state || parsed.state !== pending.state) {
    throw new Error(
      'The callback URL state does not match the pending Google OAuth session.',
    );
  }

  const clientSecretJsonPath = path.resolve(
    projectRoot,
    pending.clientSecretJsonPath,
  );
  const raw = fs.readFileSync(clientSecretJsonPath, 'utf-8');
  const client = parseGoogleInstalledClientSecretJson(raw);
  const token = await exchangeAuthCode({
    code: parsed.code,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: pending.redirectUri,
    tokenUri: client.tokenUri,
    codeVerifier: pending.codeVerifier,
  });

  upsertEnvFileValues({
    GOOGLE_CALENDAR_CLIENT_ID: client.clientId,
    GOOGLE_CALENDAR_CLIENT_SECRET: client.clientSecret,
    GOOGLE_CALENDAR_REFRESH_TOKEN: token.refreshToken,
  });
  clearGoogleCalendarPendingAuthState(projectRoot);

  return {
    clientSecretJsonPath,
    redirectUri: pending.redirectUri,
  };
}

async function runAuthComplete(callbackUrl: string): Promise<void> {
  try {
    const completed = await completeGoogleCalendarAuthFromCallbackUrl(callbackUrl);

    emitStatus('GOOGLE_CALENDAR', {
      ACTION: 'auth-complete',
      STATUS: 'success',
      CLIENT_SECRET_JSON: completed.clientSecretJsonPath,
      CALLBACK_URL: completed.redirectUri,
      STORED_CLIENT_ID: 'true',
      STORED_REFRESH_TOKEN: 'true',
      SCOPES: GOOGLE_CALENDAR_SCOPES.join(' '),
    });
  } catch (error) {
    emitGoogleCalendarFailureStatus('auth-complete', error, {
      CALLBACK_URL: callbackUrl,
      CALLBACK_STATE_PATH: getGoogleCalendarPendingAuthStatePath(),
    });
    process.exit(1);
  }
}

async function runDiscover(selection: string | null): Promise<void> {
  try {
    const config = resolveGoogleCalendarConfig();
    const calendars = await listGoogleCalendars(config);
    if (calendars.length === 0) {
      emitStatus('GOOGLE_CALENDAR', {
        ACTION: 'discover',
        STATUS: 'failed',
        FAILURE_KIND: 'unknown',
        ERROR: 'no_calendars_found',
      });
      process.exit(1);
    }

    console.log('Readable Google calendars:');
    calendars.forEach((calendar, index) => {
      console.log(formatCalendarSummaryLine(calendar, index + 1));
    });

    const hasNonPrimary = calendars.some((calendar) => !calendar.primary);
    const selectedIds = selection
      ? resolveCalendarSelection(selection, calendars)
      : [];

    if (selection && selectedIds.length === 0) {
      emitStatus('GOOGLE_CALENDAR', {
        ACTION: 'discover',
        STATUS: 'failed',
        FAILURE_KIND: 'calendar_not_found',
        ERROR: 'selection_did_not_match_any_calendar',
      });
      process.exit(1);
    }

    if (selectedIds.length > 0) {
      upsertEnvFileValues({
        GOOGLE_CALENDAR_IDS: selectedIds.join(','),
      });
    }

    emitStatus('GOOGLE_CALENDAR', {
      ACTION: 'discover',
      STATUS: 'success',
      CALENDARS_FOUND: calendars.length,
      PRIMARY_PRESENT: calendars.some((calendar) => calendar.primary),
      NON_PRIMARY_PRESENT: hasNonPrimary,
      SELECTED_IDS:
        selectedIds.length > 0 ? selectedIds.join(',') : 'unchanged',
    });
  } catch (error) {
    emitGoogleCalendarFailureStatus('discover', error);
    process.exit(1);
  }
}

async function runValidate(): Promise<void> {
  try {
    const config = resolveGoogleCalendarConfig();
    const result = await validateGoogleCalendarConfig(config);
    console.log('Configured Google calendar validation:');
    result.validatedCalendars.forEach((calendar, index) => {
      console.log(formatCalendarSummaryLine(calendar, index + 1));
    });
    if (result.failures.length > 0) {
      console.log('Validation failures:');
      for (const failure of result.failures) {
        console.log(`- ${failure}`);
      }
    }

    emitStatus('GOOGLE_CALENDAR', {
      ACTION: 'validate',
      STATUS: result.complete ? 'success' : 'failed',
      FAILURE_KIND:
        result.failures.length > 0
          ? classifyGoogleCalendarFailureDetail(result.failures[0])
          : 'unknown',
      VALIDATED_CALENDARS: result.validatedCalendars.length,
      DISCOVERED_CALENDARS: result.discoveredCalendars.length,
      FAILURES:
        result.failures.length > 0 ? result.failures.join(' | ') : 'none',
    });

    if (result.complete) {
      writeProviderProofSurface(
        'googleCalendar',
        buildGoogleCalendarNearLiveSurface({
          checkedAt: new Date().toISOString(),
          source: 'verify',
          validatedCalendars: result.validatedCalendars,
        }),
        process.cwd(),
      );
    } else if (result.failures.length > 0) {
      writeProviderProofSurface(
        'googleCalendar',
        buildGoogleCalendarBlockedProofSurface(
          result.failures[0],
          new Date().toISOString(),
          'verify',
        ),
        process.cwd(),
      );
    }

    if (!result.complete) {
      process.exit(1);
    }
  } catch (error) {
    emitGoogleCalendarFailureStatus('validate', error);
    process.exit(1);
  }
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (
    !parsed.action ||
    !['auth', 'auth-complete', 'discover', 'validate'].includes(parsed.action)
  ) {
    emitStatus('GOOGLE_CALENDAR', {
      STATUS: 'failed',
      ERROR:
        'usage: setup --step google-calendar auth --client-secret-json <path> | auth-complete --callback-url <url> | discover [--select all|1,2|id,id] | validate',
    });
    process.exit(4);
  }

  if (parsed.action === 'auth') {
    if (!parsed.clientSecretJsonPath) {
      emitStatus('GOOGLE_CALENDAR', {
        ACTION: 'auth',
        STATUS: 'failed',
        ERROR: 'missing_client_secret_json_path',
      });
      process.exit(4);
    }
    await runAuth(parsed.clientSecretJsonPath);
    return;
  }

  if (parsed.action === 'auth-complete') {
    if (!parsed.callbackUrl) {
      emitStatus('GOOGLE_CALENDAR', {
        ACTION: 'auth-complete',
        STATUS: 'failed',
        ERROR: 'missing_callback_url',
      });
      process.exit(4);
    }
    await runAuthComplete(parsed.callbackUrl);
    return;
  }

  if (parsed.action === 'discover') {
    await runDiscover(parsed.select);
    return;
  }

  await runValidate();
}
