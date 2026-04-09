import { initDatabase } from '../src/db.js';
import { runGoogleCalendarProof } from '../src/google-calendar-proof.js';
import { emitStatus } from '../setup/status.js';

function parseArgs(args: string[]): {
  calendarId: string | null;
  cleanup: boolean;
} {
  let calendarId: string | null = null;
  let cleanup = true;

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value) continue;
    if (value === '--calendar' && args[i + 1]) {
      calendarId = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (value === '--keep' || value === '--no-cleanup') {
      cleanup = false;
    }
  }

  return { calendarId, cleanup };
}

async function main(): Promise<void> {
  initDatabase();
  const { calendarId, cleanup } = parseArgs(process.argv.slice(2));
  const result = await runGoogleCalendarProof({
    projectRoot: process.cwd(),
    calendarId,
    cleanup,
    source: 'debug_google_calendar',
  });

  emitStatus('GOOGLE_CALENDAR_PROOF', {
    STATUS: result.surface.proofState === 'live_proven' ? 'success' : 'failed',
    PROOF_STATE: result.surface.proofState,
    TARGET_CALENDAR_ID: result.targetCalendarId || 'none',
    TARGET_CALENDAR_NAME: result.targetCalendarName || 'none',
    VALIDATED_CALENDARS: result.validation?.validatedCalendars.length || 0,
    READ_HEALTH: result.readHealthy,
    WRITE_HEALTH: result.writeHealthy,
    VERIFIED_BY_READ_BACK: result.verifiedByReadBack,
    CLEANUP_STATUS: result.cleanupStatus,
    CREATED_EVENT_ID: result.createdEvent?.id || 'none',
    CREATED_EVENT_TITLE: result.createdEvent?.title || 'none',
    CREATED_EVENT_START: result.createdEvent?.startIso || 'none',
    CREATED_EVENT_END: result.createdEvent?.endIso || 'none',
    FAILURE_KIND: result.failureKind || 'none',
    DETAIL: result.surface.detail || 'none',
    BLOCKER: result.surface.blocker || 'none',
    NEXT_ACTION: result.surface.nextAction || 'none',
  });

  if (result.surface.proofState !== 'live_proven') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  emitStatus('GOOGLE_CALENDAR_PROOF', {
    STATUS: 'failed',
    PROOF_STATE: 'near_live_only',
    FAILURE_KIND: 'unknown',
    DETAIL: error instanceof Error ? error.message : String(error),
    BLOCKER:
      'Google Calendar proof harness failed before it could complete read/write verification.',
    NEXT_ACTION:
      'Inspect the proof harness error and rerun `npm run debug:google-calendar`.',
  });
  process.exitCode = 1;
});
