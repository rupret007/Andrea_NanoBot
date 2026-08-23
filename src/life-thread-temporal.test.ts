import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  getLifeThread,
  isDatabaseInitialized,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  upsertProfileFact,
  upsertProfileSubject,
} from './db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
} from './life-threads.js';
import {
  parseLifeThreadTemporalState,
  shiftLifeThreadLocalDate,
} from './life-thread-temporal.js';
import type { LifeThread } from './types.js';

const reference = new Date('2026-07-14T09:00:00-05:00');
let directory = '';
let databasePath = '';

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-temporal-test-'));
  databasePath = path.join(directory, 'messages.db');
  _initTestDatabaseAtPath(databasePath);
  const subjectId = 'temporal:self';
  upsertProfileSubject({
    id: subjectId,
    groupFolder: 'temporal',
    kind: 'self',
    canonicalName: 'self',
    displayName: 'Temporal Test User',
    createdAt: reference.toISOString(),
    updatedAt: reference.toISOString(),
    disabledAt: null,
  });
  upsertProfileFact({
    id: 'temporal:timezone',
    groupFolder: 'temporal',
    subjectId,
    category: 'routines',
    factKey: 'timezone',
    valueJson: JSON.stringify({ timezone: 'America/Chicago' }),
    state: 'accepted',
    sourceChannel: 'test',
    sourceSummary: 'Controlled test timezone.',
    createdAt: reference.toISOString(),
    updatedAt: reference.toISOString(),
    decidedAt: reference.toISOString(),
  });
}, 30_000);

afterEach(() => {
  if (isDatabaseInitialized()) {
    _closeDatabase();
  }
  if (directory) {
    // Windows can keep better-sqlite3 WAL/SHM files locked after close; the
    // connection busy timeout is 15s, longer than Vitest's default 10s hook.
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    directory = '';
  }
}, 30_000);

function save(title: string, summary: string, at = reference): LifeThread {
  const result = handleLifeThreadCommand({
    groupFolder: 'temporal',
    channel: 'telegram',
    chatJid: 'temporal-chat',
    text: `save this under the ${title} thread`,
    replyText: summary,
    now: at,
  });
  expect(result.handled).toBe(true);
  expect(result.referencedThread).toBeTruthy();
  return result.referencedThread!;
}

function contextFor(thread: LifeThread) {
  return {
    summaryText: thread.summary,
    usedThreadIds: [thread.id],
    usedThreadTitles: [thread.title],
    usedThreadReasons: ['the obligation was explicitly in context'],
    threadSummaryLines: [`${thread.title}: ${thread.nextAction}`],
  };
}

function correct(
  text: string,
  options: {
    at?: Date;
    context?: LifeThread;
    chatJid?: string;
    messageId?: string;
  } = {},
) {
  return handleLifeThreadCommand({
    groupFolder: 'temporal',
    channel: 'telegram',
    chatJid: options.chatJid,
    messageId: options.messageId,
    text,
    priorContext: options.context ? contextFor(options.context) : null,
    now: options.at || new Date('2026-07-14T10:00:00-05:00'),
  });
}

describe('life-thread temporal truth', () => {
  it('uses calendar quarter boundaries and future month targets', () => {
    expect(
      shiftLifeThreadLocalDate({
        now: new Date('2026-11-15T09:00:00-06:00'),
        timeZone: 'America/Chicago',
        quarters: 1,
        day: 1,
        hour: 9,
      }),
    ).toBe('2027-01-01T15:00:00.000Z');
    expect(
      shiftLifeThreadLocalDate({
        now: reference,
        timeZone: 'America/Chicago',
        targetMonthName: 'July',
        day: 1,
        hour: 9,
      }),
    ).toBe('2027-07-01T14:00:00.000Z');
  });

  it('iterates local calendar days safely across daylight-saving changes', () => {
    expect(
      shiftLifeThreadLocalDate({
        now: new Date('2026-10-30T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        days: 3,
        hour: 9,
      }),
    ).toBe('2026-11-02T15:00:00.000Z');
  });
  it('gives this-Friday and next-Friday deterministic, distinct meanings', () => {
    expect(
      parseLifeThreadTemporalState({
        text: 'The deadline moved to this Friday at noon.',
        now: reference,
        timeZone: 'America/Chicago',
        requireCorrection: true,
      })?.activeAt,
    ).toBe('2026-07-17T17:00:00.000Z');
    expect(
      parseLifeThreadTemporalState({
        text: 'The deadline moved to next Friday at noon.',
        now: reference,
        timeZone: 'America/Chicago',
        requireCorrection: true,
      })?.activeAt,
    ).toBe('2026-07-24T17:00:00.000Z');
  });

  it('atomically supersedes the active deadline while retaining explicit provenance', () => {
    const permit = save(
      'permit application',
      'Maya needs to submit the permit application by Friday at 3:00 PM.',
    );
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-17T20:00:00.000Z',
    );

    const result = correct('Actually, the deadline moved to Monday at noon.', {
      context: permit,
    });
    const current = getLifeThread(permit.id)!;
    const signals = listLifeThreadSignals(permit.id, 10);

    expect(result.temporalResolution).toBe('applied');
    expect(current.nextFollowupAt).toBe('2026-07-20T17:00:00.000Z');
    expect(current.summary).toBe(
      'Permit Application is due Monday, July 20, 2026 at 12:00 PM CDT.',
    );
    expect(current.nextAction).toBe(current.summary);
    expect(current.nextAction).not.toMatch(/Friday|3:00 PM/);
    expect(signals[0]?.summaryText).toContain('commitment_transition:active');
    expect(signals[0]?.commitmentTransition?.reason).toContain(
      'corrected the active temporal truth',
    );
    expect(
      signals[0]?.commitmentTransition?.afterState?.evidence.at(-1)
        ?.reasonKinds,
    ).toEqual(
      expect.arrayContaining(['temporal', 'correction', 'state_transition']),
    );
    expect(listLifeThreadsForGroup('temporal')).toHaveLength(1);
  });

  it('handles weekday, relative, ordinal, time-only, date-only, and past corrections in the accepted timezone', () => {
    const permit = save(
      'permit application',
      'Submit the permit application by Thursday at 5:00 PM.',
    );

    expect(
      correct('Push that to Tuesday morning.', { context: permit })
        .temporalResolution,
    ).toBe('applied');
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-21T14:00:00.000Z',
    );

    expect(
      correct('Correction: it is due on the 19th, not the 16th.', {
        context: permit,
      }).temporalResolution,
    ).toBe('applied');
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-19T14:00:00.000Z',
    );

    expect(
      correct('They gave me another week.', { context: permit }),
    ).toMatchObject({ temporalResolution: 'applied' });
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-26T14:00:00.000Z',
    );

    expect(
      correct('Actually, make it 2:30 PM.', { context: permit })
        .temporalResolution,
    ).toBe('applied');
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-26T19:30:00.000Z',
    );

    expect(
      correct('The deadline moved to July 24.', { context: permit })
        .temporalResolution,
    ).toBe('applied');
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-24T19:30:00.000Z',
    );

    expect(
      correct('Correction: it is due July 10 at 4:00 PM.', {
        context: permit,
      }).temporalResolution,
    ).toBe('applied');
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-10T21:00:00.000Z',
    );
    expect(
      buildLifeThreadSnapshot({
        groupFolder: 'temporal',
        now: new Date('2026-07-14T10:01:00-05:00'),
      }).slippingThreads.map((thread) => thread.id),
    ).toContain(permit.id);
  });

  it('updates only the clearly named obligation when another temporal fact is present', () => {
    const meeting = save(
      'repair meeting',
      'The repair meeting is Friday at 10:00 AM.',
    );
    const permit = save(
      'permit application',
      'The permit application is due Friday at 3:00 PM.',
      new Date('2026-07-14T09:01:00-05:00'),
    );
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-17T20:00:00.000Z',
    );

    const result = correct(
      'The meeting stayed on Friday, but the application deadline moved to Monday.',
    );

    expect(result.temporalResolution).toBe('applied');
    expect(result.referencedThread?.id).toBe(permit.id);
    expect(getLifeThread(meeting.id)?.nextFollowupAt).toBe(
      '2026-07-17T15:00:00.000Z',
    );
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-20T20:00:00.000Z',
    );
  });

  it('refuses an ambiguous correction between similar active obligations', () => {
    const first = save(
      'city permit application',
      'The city permit application is due Friday at 3:00 PM.',
    );
    const second = save(
      'county permit application',
      'The county permit application is due Monday at noon.',
      new Date('2026-07-14T09:01:00-05:00'),
    );

    const result = correct('Move it to Tuesday.', { chatJid: undefined });

    expect(result.temporalResolution).toBe('ambiguous');
    expect(result.responseText).toMatch(/more than one|which one/i);
    expect(getLifeThread(first.id)?.nextFollowupAt).toBe(
      '2026-07-17T20:00:00.000Z',
    );
    expect(getLifeThread(second.id)?.nextFollowupAt).toBe(
      '2026-07-20T17:00:00.000Z',
    );
  });

  it('makes duplicate correction ingestion idempotent', () => {
    const permit = save(
      'permit application',
      'The permit application is due Thursday at 5:00 PM.',
    );
    const first = correct('The permit deadline moved to Friday at noon.', {
      messageId: 'correction-event-one',
    });
    const afterFirst = getLifeThread(permit.id)!;
    const signalCount = listLifeThreadSignals(permit.id, 20).length;
    const second = correct('The permit deadline moved to Friday at noon.', {
      messageId: 'correction-event-one',
      at: new Date('2026-07-14T10:01:00-05:00'),
    });

    expect(first.temporalResolution).toBe('applied');
    expect(second.temporalResolution).toBe('duplicate');
    expect(getLifeThread(permit.id)).toMatchObject({
      nextFollowupAt: '2026-07-17T17:00:00.000Z',
      lastUpdatedAt: afterFirst.lastUpdatedAt,
    });
    expect(listLifeThreadSignals(permit.id, 20)).toHaveLength(signalCount);
    const distinctOccurrence = correct(
      'The permit deadline moved to Friday at noon.',
      {
        messageId: 'correction-event-two',
        at: new Date('2026-07-14T10:02:00-05:00'),
      },
    );
    expect(distinctOccurrence.temporalResolution).toBe('applied');
    expect(listLifeThreadSignals(permit.id, 20)).toHaveLength(signalCount + 1);
  });

  it('deduplicates a semantic replay without a transport id but permits a later reversion', () => {
    const permit = save(
      'permit application',
      'The permit application is due Thursday at 5:00 PM.',
    );
    const fridayText = 'The permit deadline moved to Friday at noon.';
    const first = correct(fridayText, {
      context: permit,
      at: new Date('2026-07-14T10:00:00-05:00'),
    });
    const afterFirst = getLifeThread(permit.id)!;
    const afterFirstSignals = listLifeThreadSignals(permit.id, 20).length;
    const replay = correct(fridayText, {
      context: afterFirst,
      at: new Date('2026-07-14T10:01:00-05:00'),
    });

    expect(first.temporalResolution).toBe('applied');
    expect(replay.temporalResolution).toBe('duplicate');
    expect(getLifeThread(permit.id)?.lastUpdatedAt).toBe(
      afterFirst.lastUpdatedAt,
    );
    expect(listLifeThreadSignals(permit.id, 20)).toHaveLength(
      afterFirstSignals,
    );

    const monday = correct('Move the permit deadline to Monday at noon.', {
      context: getLifeThread(permit.id),
      at: new Date('2026-07-14T10:02:00-05:00'),
    });
    const revert = correct(fridayText, {
      context: getLifeThread(permit.id),
      at: new Date('2026-07-14T10:03:00-05:00'),
    });
    expect(monday.temporalResolution).toBe('applied');
    expect(revert.temporalResolution).toBe('applied');
    expect(getLifeThread(permit.id)?.nextFollowupAt).toBe(
      '2026-07-17T17:00:00.000Z',
    );
    expect(listLifeThreadSignals(permit.id, 20)).toHaveLength(
      afterFirstSignals + 2,
    );
  });

  it('survives two durable close/reopen cycles and accepts a newer correction after restart', () => {
    const permit = save(
      'permit application',
      'The permit application is due Thursday at 5:00 PM.',
    );
    correct('The permit deadline moved to Friday at noon.');

    _closeDatabase();
    _initTestDatabaseAtPath(databasePath);
    expect(getLifeThread(permit.id)).toMatchObject({
      nextFollowupAt: '2026-07-17T17:00:00.000Z',
      nextAction:
        'Permit Application is due Friday, July 17, 2026 at 12:00 PM CDT.',
    });

    const afterRestart = correct(
      'Push the permit application to Tuesday morning.',
      { at: new Date('2026-07-14T11:00:00-05:00') },
    );
    expect(afterRestart.temporalResolution).toBe('applied');

    _closeDatabase();
    _initTestDatabaseAtPath(databasePath);
    const recovered = getLifeThread(permit.id)!;
    const snapshot = buildLifeThreadSnapshot({
      groupFolder: 'temporal',
      now: new Date('2026-07-14T11:01:00-05:00'),
    });
    expect(recovered.nextFollowupAt).toBe('2026-07-21T14:00:00.000Z');
    expect(recovered.nextAction).not.toMatch(/Thursday|Friday|5:00 PM|noon/);
    expect(listLifeThreadsForGroup('temporal')).toHaveLength(1);
    expect(snapshot.activeThreads).toHaveLength(1);
    expect(snapshot.dueFollowups).toHaveLength(0);
    expect(listLifeThreadSignals(permit.id, 20)).toHaveLength(3);
  });
});
