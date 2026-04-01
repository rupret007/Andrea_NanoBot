import { readEnvFile } from './env.js';

const GOOGLE_CALENDAR_ENV_KEYS = [
  'GOOGLE_CALENDAR_ACCESS_TOKEN',
  'GOOGLE_CALENDAR_REFRESH_TOKEN',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'GOOGLE_CALENDAR_IDS',
] as const;

type FetchLike = typeof fetch;

export interface GoogleCalendarConfig {
  accessToken: string | null;
  refreshToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  calendarIds: string[];
}

export interface GoogleCalendarMetadata {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  writable: boolean;
  selected: boolean;
}

export interface GoogleCalendarEventRecord {
  id: string;
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  location?: string | null;
  calendarId: string;
  calendarName: string;
  htmlLink?: string | null;
}

export interface GoogleCalendarEventCreateInput {
  calendarId: string;
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  allDay: boolean;
  location?: string | null;
  description?: string | null;
}

export interface GoogleCalendarValidationResult {
  discoveredCalendars: GoogleCalendarMetadata[];
  validatedCalendars: GoogleCalendarMetadata[];
  failures: string[];
  complete: boolean;
}

function resolveConfigValue(
  key: (typeof GOOGLE_CALENDAR_ENV_KEYS)[number],
  envFile: Record<string, string>,
  env?: Record<string, string | undefined>,
): string | undefined {
  if (env) {
    return env[key];
  }
  return process.env[key] ?? envFile[key];
}

function resolveCsvList(
  value: string | null | undefined,
  fallback: string[] = [],
): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function truncateDetail(value: string, max = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function extractJsonErrorDetail(
  rawText: string,
  fallbackPrefix: string,
  status?: number,
): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return status ? `${fallbackPrefix} ${status}` : fallbackPrefix;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?:
        | string
        | {
            message?: string;
            error_description?: string;
            description?: string;
          };
      error_description?: string;
    };
    const nestedError =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ||
          parsed.error?.error_description ||
          parsed.error?.description;
    const detail = nestedError || parsed.error_description;
    if (detail) {
      return status
        ? `${fallbackPrefix} ${status}: ${truncateDetail(detail)}`
        : `${fallbackPrefix}: ${truncateDetail(detail)}`;
    }
  } catch {
    // Fall back to plain-text detail.
  }

  return status
    ? `${fallbackPrefix} ${status}: ${truncateDetail(trimmed)}`
    : `${fallbackPrefix}: ${truncateDetail(trimmed)}`;
}

function parseGoogleDate(
  value?: {
    date?: string;
    dateTime?: string;
  } | null,
): { iso: string | null; allDay: boolean } {
  if (!value) {
    return { iso: null, allDay: false };
  }

  if (value.date) {
    const parsed = new Date(`${value.date}T00:00:00`);
    return {
      iso: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
      allDay: true,
    };
  }

  if (value.dateTime) {
    const parsed = new Date(value.dateTime);
    return {
      iso: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
      allDay: false,
    };
  }

  return { iso: null, allDay: false };
}

function formatDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isWritableAccessRole(accessRole: string | null | undefined): boolean {
  if (!accessRole) return false;
  return accessRole === 'owner' || accessRole === 'writer';
}

export function resolveGoogleCalendarConfig(
  env?: Record<string, string | undefined>,
): GoogleCalendarConfig {
  const envFile = readEnvFile([...GOOGLE_CALENDAR_ENV_KEYS]);
  return {
    accessToken:
      resolveConfigValue('GOOGLE_CALENDAR_ACCESS_TOKEN', envFile, env) || null,
    refreshToken:
      resolveConfigValue('GOOGLE_CALENDAR_REFRESH_TOKEN', envFile, env) || null,
    clientId:
      resolveConfigValue('GOOGLE_CALENDAR_CLIENT_ID', envFile, env)?.trim() ||
      null,
    clientSecret:
      resolveConfigValue('GOOGLE_CALENDAR_CLIENT_SECRET', envFile, env) || null,
    calendarIds: resolveCsvList(
      resolveConfigValue('GOOGLE_CALENDAR_IDS', envFile, env),
      ['primary'],
    ),
  };
}

export async function getGoogleCalendarAccessToken(
  config: GoogleCalendarConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string> {
  if (config.accessToken) {
    return config.accessToken;
  }

  if (!config.refreshToken || !config.clientId || !config.clientSecret) {
    throw new Error(
      'Set GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_CALENDAR_REFRESH_TOKEN plus GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET.',
    );
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
  });

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      extractJsonErrorDetail(text, 'Google token refresh', response.status),
    );
  }

  const payload = JSON.parse(text) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Google token refresh did not return an access token.');
  }
  return payload.access_token;
}

export async function listGoogleCalendars(
  config: GoogleCalendarConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<GoogleCalendarMetadata[]> {
  const accessToken = await getGoogleCalendarAccessToken(config, fetchImpl);
  const selectedIds = new Set(config.calendarIds);
  const calendars: GoogleCalendarMetadata[] = [];
  let pageToken: string | null = null;

  do {
    const url = new URL(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    );
    url.searchParams.set('maxResults', '250');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        extractJsonErrorDetail(
          text,
          'Google calendar discovery',
          response.status,
        ),
      );
    }

    const payload = JSON.parse(text) as {
      items?: Array<{
        id?: string;
        summary?: string;
        primary?: boolean;
        accessRole?: string;
      }>;
      nextPageToken?: string;
    };
    if (!Array.isArray(payload.items)) {
      throw new Error(
        'Google Calendar returned an invalid calendar list payload.',
      );
    }

    for (const item of payload.items) {
      if (!item.id) continue;
      calendars.push({
        id: item.id,
        summary: item.summary || item.id,
        primary: Boolean(item.primary),
        accessRole: item.accessRole || 'unknown',
        writable: isWritableAccessRole(item.accessRole),
        selected: selectedIds.has(item.id),
      });
    }

    pageToken = payload.nextPageToken || null;
  } while (pageToken);

  return calendars.sort((left, right) => {
    if (left.primary !== right.primary) {
      return left.primary ? -1 : 1;
    }
    return left.summary.localeCompare(right.summary);
  });
}

export async function validateGoogleCalendarConfig(
  config: GoogleCalendarConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<GoogleCalendarValidationResult> {
  const discoveredCalendars = await listGoogleCalendars(config, fetchImpl);
  const discoveredById = new Map(
    discoveredCalendars.map((calendar) => [calendar.id, calendar]),
  );
  const accessToken = await getGoogleCalendarAccessToken(config, fetchImpl);
  const failures: string[] = [];
  const validatedCalendars: GoogleCalendarMetadata[] = [];
  const calendarIds =
    config.calendarIds.length > 0 ? config.calendarIds : ['primary'];

  for (const calendarId of calendarIds) {
    const metadata = discoveredById.get(calendarId);
    if (!metadata) {
      failures.push(`${calendarId}: not found in Google calendar list.`);
      continue;
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('timeMin', new Date().toISOString());
    url.searchParams.set(
      'timeMax',
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      failures.push(
        `${calendarId}: ${extractJsonErrorDetail(
          text,
          'Google Calendar',
          response.status,
        )}`,
      );
      continue;
    }

    try {
      const payload = JSON.parse(text) as { items?: unknown[] };
      if (!Array.isArray(payload.items)) {
        throw new Error('Google Calendar returned an invalid events payload.');
      }
      validatedCalendars.push(metadata);
    } catch (error) {
      failures.push(
        `${calendarId}: ${truncateDetail(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }

  return {
    discoveredCalendars,
    validatedCalendars,
    failures,
    complete: failures.length === 0 && validatedCalendars.length > 0,
  };
}

export async function listGoogleCalendarEvents(
  input: {
    start: Date;
    end: Date;
    calendarIds?: string[];
  },
  config: GoogleCalendarConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<{
  events: GoogleCalendarEventRecord[];
  failures: string[];
  successCount: number;
}> {
  const accessToken = await getGoogleCalendarAccessToken(config, fetchImpl);
  const calendarIds = input.calendarIds?.length
    ? input.calendarIds
    : config.calendarIds;
  const events: GoogleCalendarEventRecord[] = [];
  const failures: string[] = [];
  let successCount = 0;

  for (const calendarId of calendarIds) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('timeMin', input.start.toISOString());
    url.searchParams.set('timeMax', input.end.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');

    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          extractJsonErrorDetail(text, 'Google Calendar', response.status),
        );
      }

      const payload = JSON.parse(text) as {
        summary?: string;
        items?: Array<{
          id?: string;
          summary?: string;
          location?: string;
          status?: string;
          htmlLink?: string;
          start?: { date?: string; dateTime?: string };
          end?: { date?: string; dateTime?: string };
        }>;
      };
      if (!Array.isArray(payload.items)) {
        throw new Error('Google Calendar returned an invalid events payload.');
      }

      successCount += 1;
      const calendarName = payload.summary || calendarId;
      for (const item of payload.items) {
        if (item.status === 'cancelled') continue;
        const parsedStart = parseGoogleDate(item.start);
        const parsedEnd = parseGoogleDate(item.end);
        if (!parsedStart.iso || !parsedEnd.iso) continue;
        events.push({
          id:
            item.id ||
            `google_calendar:${calendarId}:${parsedStart.iso}:${item.summary || 'event'}`,
          title: item.summary || 'Untitled event',
          startIso: parsedStart.iso,
          endIso: parsedEnd.iso,
          allDay: parsedStart.allDay,
          location: item.location || null,
          calendarId,
          calendarName,
          htmlLink: item.htmlLink || null,
        });
      }
    } catch (error) {
      failures.push(
        `${calendarId}: ${truncateDetail(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }

  return {
    events,
    failures,
    successCount,
  };
}

export async function createGoogleCalendarEvent(
  input: GoogleCalendarEventCreateInput,
  config: GoogleCalendarConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<GoogleCalendarEventRecord> {
  const accessToken = await getGoogleCalendarAccessToken(config, fetchImpl);
  const body = input.allDay
    ? {
        summary: input.title,
        location: input.location || undefined,
        description: input.description || undefined,
        start: {
          date: formatDateOnly(input.start),
        },
        end: {
          date: formatDateOnly(input.end),
        },
      }
    : {
        summary: input.title,
        location: input.location || undefined,
        description: input.description || undefined,
        start: {
          dateTime: input.start.toISOString(),
          timeZone: input.timeZone,
        },
        end: {
          dateTime: input.end.toISOString(),
          timeZone: input.timeZone,
        },
      };

  const response = await fetchImpl(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      extractJsonErrorDetail(
        text,
        'Google Calendar event create',
        response.status,
      ),
    );
  }

  const payload = JSON.parse(text) as {
    id?: string;
    summary?: string;
    location?: string;
    htmlLink?: string;
    start?: { date?: string; dateTime?: string };
    end?: { date?: string; dateTime?: string };
    organizer?: { displayName?: string; email?: string };
  };
  const parsedStart = parseGoogleDate(payload.start);
  const parsedEnd = parseGoogleDate(payload.end);
  if (!parsedStart.iso || !parsedEnd.iso) {
    throw new Error(
      'Google Calendar returned an invalid create response payload.',
    );
  }

  return {
    id:
      payload.id ||
      `google_calendar:${input.calendarId}:${parsedStart.iso}:${payload.summary || input.title}`,
    title: payload.summary || input.title,
    startIso: parsedStart.iso,
    endIso: parsedEnd.iso,
    allDay: parsedStart.allDay,
    location: payload.location || input.location || null,
    calendarId: input.calendarId,
    calendarName: payload.organizer?.displayName || input.calendarId,
    htmlLink: payload.htmlLink || null,
  };
}
