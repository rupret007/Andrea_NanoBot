import { TIMEZONE } from './config.js';
import {
  classifyGoogleCalendarFailureDetail,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  listGoogleCalendarEvents,
  listGoogleCalendars,
  resolveGoogleCalendarConfig,
  validateGoogleCalendarConfig,
  type GoogleCalendarConfig,
  type GoogleCalendarEventRecord,
  type GoogleCalendarFailureKind,
  type GoogleCalendarMetadata,
  type GoogleCalendarValidationResult,
} from './google-calendar.js';
import {
  writeProviderProofSurface,
  type ProviderProofSource,
  type ProviderProofSurfaceState,
} from './provider-proof-state.js';

type FetchLike = typeof fetch;

export interface GoogleCalendarProofResult {
  surface: ProviderProofSurfaceState;
  failureKind: GoogleCalendarFailureKind | null;
  targetCalendarId: string | null;
  targetCalendarName: string | null;
  readHealthy: boolean;
  writeHealthy: boolean;
  verifiedByReadBack: boolean;
  cleanupStatus: 'deleted' | 'kept' | 'delete_failed' | 'not_applicable';
  createdEvent: GoogleCalendarEventRecord | null;
  validation: GoogleCalendarValidationResult | null;
}

export interface RunGoogleCalendarProofOptions {
  projectRoot?: string;
  config?: GoogleCalendarConfig;
  fetchImpl?: FetchLike;
  calendarId?: string | null;
  cleanup?: boolean;
  source?: ProviderProofSource;
  timeZone?: string;
}

function compactDetail(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() || '';
}

function describeCalendarList(
  calendars: GoogleCalendarMetadata[],
  max = 3,
): string {
  return calendars
    .slice(0, max)
    .map((calendar) =>
      calendar.primary ? `${calendar.summary} (primary)` : calendar.summary,
    )
    .join(', ');
}

export function hasGoogleCalendarCredentialMaterial(
  config: GoogleCalendarConfig,
): boolean {
  return Boolean(
    config.accessToken ||
    (config.refreshToken && config.clientId && config.clientSecret),
  );
}

export function buildGoogleCalendarBlockedProofSurface(
  detail: string,
  checkedAt: string,
  source: ProviderProofSource,
): ProviderProofSurfaceState {
  const kind = classifyGoogleCalendarFailureDetail(detail);
  const compact = compactDetail(detail);

  switch (kind) {
    case 'missing_config':
      return {
        proofState: 'externally_blocked',
        blocker:
          'Google Calendar is not connected in Andrea_NanoBot on this host.',
        detail:
          compact ||
          'Andrea_NanoBot does not currently have usable Google Calendar credentials in its own .env.',
        nextAction:
          'Run `npm run setup -- --step google-calendar auth --client-secret-json "<client-secret.json>"`, then `npm run setup -- --step google-calendar discover --select primary`, then `npm run setup -- --step google-calendar validate`.',
        checkedAt,
        source,
      };
    case 'invalid_refresh_token':
      return {
        proofState: 'externally_blocked',
        blocker:
          'Google Calendar is connected with a stale or revoked refresh token on this host.',
        detail:
          compact ||
          'Google rejected the stored refresh token with invalid_grant.',
        nextAction:
          'Re-run `npm run setup -- --step google-calendar auth --client-secret-json "<client-secret.json>"` and complete browser consent for the current repo.',
        checkedAt,
        source,
      };
    case 'token_refresh_failed':
      return {
        proofState: 'externally_blocked',
        blocker: 'Google Calendar token refresh is failing on this host.',
        detail: compact || 'Google Calendar token refresh failed.',
        nextAction:
          'Re-run the current-repo Google Calendar auth flow, then validate again.',
        checkedAt,
        source,
      };
    case 'calendar_access_denied':
      return {
        proofState: 'externally_blocked',
        blocker:
          'Google Calendar is connected, but the selected calendar does not allow the needed access on this host.',
        detail: compact || 'Google Calendar access was denied.',
        nextAction:
          'Run `npm run setup -- --step google-calendar discover --select primary` or choose a writable calendar, then validate again.',
        checkedAt,
        source,
      };
    case 'calendar_not_found':
      return {
        proofState: 'externally_blocked',
        blocker:
          'Andrea_NanoBot is pointed at a Google Calendar that is no longer available on this host.',
        detail: compact || 'The selected Google Calendar could not be found.',
        nextAction:
          'Run `npm run setup -- --step google-calendar discover --select primary` to reselect a readable writable calendar.',
        checkedAt,
        source,
      };
    case 'temporary_unavailable':
      return {
        proofState: 'near_live_only',
        blocker:
          'Google Calendar is configured, but the provider is temporarily unavailable right now.',
        detail:
          compact ||
          'Google Calendar did not respond cleanly during this proof attempt.',
        nextAction:
          'Retry the same validate or proof command once the network/provider issue clears.',
        checkedAt,
        source,
      };
    case 'calendar_conflict':
      return {
        proofState: 'near_live_only',
        blocker:
          'Google Calendar read is healthy, but the latest proof write hit a duplicate or conflict condition.',
        detail: compact || 'The proof write hit a conflict.',
        nextAction:
          'Retry the proof with a fresh disposable event title or a different proof slot.',
        checkedAt,
        source,
      };
    case 'calendar_write_failed':
      return {
        proofState: 'near_live_only',
        blocker:
          'Google Calendar read is healthy on this host, but the latest write proof failed.',
        detail: compact || 'Google Calendar event creation failed.',
        nextAction:
          'Inspect the exact write error, fix the smallest cause, and rerun `npm run debug:google-calendar`.',
        checkedAt,
        source,
      };
    default:
      return {
        proofState: 'near_live_only',
        blocker:
          'Google Calendar still needs a fresh successful read/write proof on this host.',
        detail: compact || 'Google Calendar proof did not complete cleanly.',
        nextAction:
          'Fix the exact blocker and rerun `npm run debug:google-calendar`.',
        checkedAt,
        source,
      };
  }
}

export function buildGoogleCalendarNearLiveSurface(input: {
  checkedAt: string;
  source: ProviderProofSource;
  validatedCalendars: GoogleCalendarMetadata[];
}): ProviderProofSurfaceState {
  const names = describeCalendarList(input.validatedCalendars);
  return {
    proofState: 'near_live_only',
    blocker: '',
    detail:
      input.validatedCalendars.length > 0
        ? `Google Calendar read is healthy on this host. Validated ${input.validatedCalendars.length} calendar(s): ${names}.`
        : 'Google Calendar credentials look healthy, but no writable calendar has been validated yet.',
    nextAction:
      'Run `npm run debug:google-calendar` to create and verify one disposable proof event on this host.',
    checkedAt: input.checkedAt,
    source: input.source,
  };
}

function resolveTargetCalendar(
  calendars: GoogleCalendarMetadata[],
  preferredCalendarId: string | null | undefined,
): GoogleCalendarMetadata | null {
  const writableCalendars = calendars.filter((calendar) => calendar.writable);
  if (writableCalendars.length === 0) return null;
  if (preferredCalendarId) {
    return (
      writableCalendars.find(
        (calendar) => calendar.id === preferredCalendarId,
      ) || null
    );
  }
  return (
    writableCalendars.find((calendar) => calendar.id === 'primary') ||
    writableCalendars.find((calendar) => calendar.primary) ||
    writableCalendars[0] ||
    null
  );
}

function buildProofEventWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(16, 0, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + 15);
  return { start, end };
}

function buildProofTitle(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `Andrea calendar proof ${stamp}`;
}

export async function runGoogleCalendarProof(
  options: RunGoogleCalendarProofOptions = {},
): Promise<GoogleCalendarProofResult> {
  const projectRoot = options.projectRoot || process.cwd();
  const checkedAt = new Date().toISOString();
  const source = options.source || 'debug_google_calendar';
  const config = options.config || resolveGoogleCalendarConfig();
  const cleanup = options.cleanup !== false;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!hasGoogleCalendarCredentialMaterial(config)) {
    const surface = buildGoogleCalendarBlockedProofSurface(
      'Set GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_CALENDAR_REFRESH_TOKEN plus GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET.',
      checkedAt,
      source,
    );
    writeProviderProofSurface('googleCalendar', surface, projectRoot);
    return {
      surface,
      failureKind: 'missing_config',
      targetCalendarId: null,
      targetCalendarName: null,
      readHealthy: false,
      writeHealthy: false,
      verifiedByReadBack: false,
      cleanupStatus: 'not_applicable',
      createdEvent: null,
      validation: null,
    };
  }

  let validation: GoogleCalendarValidationResult | null = null;
  try {
    validation = await validateGoogleCalendarConfig(config, fetchImpl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const surface = buildGoogleCalendarBlockedProofSurface(
      detail,
      checkedAt,
      source,
    );
    writeProviderProofSurface('googleCalendar', surface, projectRoot);
    return {
      surface,
      failureKind: classifyGoogleCalendarFailureDetail(detail),
      targetCalendarId: null,
      targetCalendarName: null,
      readHealthy: false,
      writeHealthy: false,
      verifiedByReadBack: false,
      cleanupStatus: 'not_applicable',
      createdEvent: null,
      validation: null,
    };
  }

  if (!validation.complete) {
    const detail =
      validation.failures[0] ||
      'Google Calendar validate did not complete successfully.';
    const surface = buildGoogleCalendarBlockedProofSurface(
      detail,
      checkedAt,
      source,
    );
    writeProviderProofSurface('googleCalendar', surface, projectRoot);
    return {
      surface,
      failureKind: classifyGoogleCalendarFailureDetail(detail),
      targetCalendarId: null,
      targetCalendarName: null,
      readHealthy: false,
      writeHealthy: false,
      verifiedByReadBack: false,
      cleanupStatus: 'not_applicable',
      createdEvent: null,
      validation,
    };
  }

  const discoveredCalendars =
    validation.discoveredCalendars.length > 0
      ? validation.discoveredCalendars
      : await listGoogleCalendars(config, fetchImpl);
  const targetCalendar = resolveTargetCalendar(
    discoveredCalendars,
    options.calendarId || null,
  );
  if (!targetCalendar) {
    const surface = buildGoogleCalendarBlockedProofSurface(
      'No writable Google calendar is currently available for Andrea_NanoBot.',
      checkedAt,
      source,
    );
    writeProviderProofSurface('googleCalendar', surface, projectRoot);
    return {
      surface,
      failureKind: 'calendar_access_denied',
      targetCalendarId: null,
      targetCalendarName: null,
      readHealthy: false,
      writeHealthy: false,
      verifiedByReadBack: false,
      cleanupStatus: 'not_applicable',
      createdEvent: null,
      validation,
    };
  }

  try {
    const readProof = await listGoogleCalendarEvents(
      {
        start: new Date(Date.now() - 60 * 60 * 1000),
        end: new Date(Date.now() + 48 * 60 * 60 * 1000),
        calendarIds: [targetCalendar.id],
      },
      config,
      fetchImpl,
    );
    if (readProof.successCount === 0 && readProof.failures.length > 0) {
      const detail = readProof.failures[0];
      const surface = buildGoogleCalendarBlockedProofSurface(
        detail,
        checkedAt,
        source,
      );
      writeProviderProofSurface('googleCalendar', surface, projectRoot);
      return {
        surface,
        failureKind: classifyGoogleCalendarFailureDetail(detail),
        targetCalendarId: targetCalendar.id,
        targetCalendarName: targetCalendar.summary,
        readHealthy: false,
        writeHealthy: false,
        verifiedByReadBack: false,
        cleanupStatus: 'not_applicable',
        createdEvent: null,
        validation,
      };
    }

    const proofWindow = buildProofEventWindow(new Date());
    const createdEvent = await createGoogleCalendarEvent(
      {
        calendarId: targetCalendar.id,
        title: buildProofTitle(new Date()),
        start: proofWindow.start,
        end: proofWindow.end,
        timeZone: options.timeZone || TIMEZONE,
        allDay: false,
        description:
          'Disposable Andrea Google Calendar live-proof event. Safe to delete after verification.',
      },
      config,
      fetchImpl,
    );

    const readBack = await listGoogleCalendarEvents(
      {
        start: new Date(proofWindow.start.getTime() - 5 * 60 * 1000),
        end: new Date(proofWindow.end.getTime() + 5 * 60 * 1000),
        calendarIds: [targetCalendar.id],
      },
      config,
      fetchImpl,
    );
    const verifiedByReadBack = readBack.events.some(
      (event) =>
        event.id === createdEvent.id ||
        (event.title === createdEvent.title &&
          event.startIso === createdEvent.startIso),
    );

    let cleanupStatus: GoogleCalendarProofResult['cleanupStatus'] =
      'not_applicable';
    if (cleanup) {
      try {
        await deleteGoogleCalendarEvent(
          {
            calendarId: createdEvent.calendarId,
            eventId: createdEvent.id,
          },
          config,
          fetchImpl,
        );
        cleanupStatus = 'deleted';
      } catch {
        cleanupStatus = 'delete_failed';
      }
    } else {
      cleanupStatus = 'kept';
    }

    const surface: ProviderProofSurfaceState = verifiedByReadBack
      ? {
          proofState: 'live_proven',
          blocker: '',
          detail:
            cleanupStatus === 'delete_failed'
              ? `Google Calendar read/write is live-proven on this host. Andrea created and verified "${createdEvent.title}" on ${targetCalendar.summary}, but the disposable cleanup delete failed.`
              : `Google Calendar read/write is live-proven on this host. Andrea created and verified "${createdEvent.title}" on ${targetCalendar.summary}${cleanupStatus === 'deleted' ? ', then cleaned up the disposable proof event' : ''}.`,
          nextAction: '',
          checkedAt,
          source,
        }
      : {
          proofState: 'near_live_only',
          blocker:
            'Google Calendar created the disposable proof event, but read-back did not confirm it yet on this host.',
          detail: `Andrea created "${createdEvent.title}" on ${targetCalendar.summary}, but the follow-up read-back did not confirm it cleanly.`,
          nextAction:
            'Open the calendar to confirm the event directly, then rerun `npm run debug:google-calendar` if another same-host proof is needed.',
          checkedAt,
          source,
        };
    writeProviderProofSurface('googleCalendar', surface, projectRoot);
    return {
      surface,
      failureKind: null,
      targetCalendarId: targetCalendar.id,
      targetCalendarName: targetCalendar.summary,
      readHealthy: true,
      writeHealthy: true,
      verifiedByReadBack,
      cleanupStatus,
      createdEvent,
      validation,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const surface = buildGoogleCalendarBlockedProofSurface(
      detail,
      checkedAt,
      source,
    );
    writeProviderProofSurface('googleCalendar', surface, projectRoot);
    return {
      surface,
      failureKind: classifyGoogleCalendarFailureDetail(detail),
      targetCalendarId: targetCalendar.id,
      targetCalendarName: targetCalendar.summary,
      readHealthy: true,
      writeHealthy: false,
      verifiedByReadBack: false,
      cleanupStatus: 'not_applicable',
      createdEvent: null,
      validation,
    };
  }
}
