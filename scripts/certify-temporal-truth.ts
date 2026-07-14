import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  getLifeThread,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  upsertProfileFact,
  upsertProfileSubject,
} from '../src/db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
} from '../src/life-threads.js';
import type { LifeThread } from '../src/types.js';

type Status = 'PASS' | 'FAIL';

interface Result {
  name: string;
  status: Status;
  evidence: string;
}

interface CleanupEntry {
  kind: string;
  id: string;
  cleanup: string;
  status: 'pending' | 'removed';
}

const runId =
  process.env.ANDREA_TEMPORAL_RUN_ID ||
  `ANDREA-TEMPORAL-${new Date().toISOString().replace(/[-:.]/g, '')}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
const namespace = runId.slice(-8).toLowerCase();
const groupFolder = `tempcert_${namespace}`;
const chatJid = `synthetic:${runId}`;
const directory = path.join(os.tmpdir(), runId);
const databasePath = path.join(directory, 'messages.db');
const manifestPath = path.join(os.tmpdir(), `${runId}-cleanup.json`);
const reference = new Date('2026-07-14T09:00:00-05:00');
const manifest: CleanupEntry[] = [
  {
    kind: 'isolated_sqlite_database',
    id: databasePath,
    cleanup: 'close and unlink database, WAL, and SHM',
    status: 'pending',
  },
  {
    kind: 'cleanup_manifest',
    id: manifestPath,
    cleanup: 'unlink after independent residue verification',
    status: 'pending',
  },
];

function persistManifest(): void {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

function track(kind: string, id: string, cleanup: string): void {
  if (manifest.some((entry) => entry.id === id)) return;
  manifest.push({ kind, id, cleanup, status: 'pending' });
  persistManifest();
}

function seedIdentity(): void {
  const at = reference.toISOString();
  const subjectId = `${runId}:profile:self`;
  upsertProfileSubject({
    id: subjectId,
    groupFolder,
    kind: 'self',
    canonicalName: 'self',
    displayName: `Synthetic Temporal Owner ${namespace}`,
    createdAt: at,
    updatedAt: at,
    disabledAt: null,
  });
  track('profile_subject', subjectId, 'unlink isolated database');
  const factId = `${runId}:profile:timezone`;
  upsertProfileFact({
    id: factId,
    groupFolder,
    subjectId,
    category: 'routines',
    factKey: 'timezone',
    valueJson: JSON.stringify({ timezone: 'America/Chicago', runId }),
    state: 'accepted',
    sourceChannel: 'synthetic_offline_fixture',
    sourceSummary: `Controlled timezone for ${runId}`,
    createdAt: at,
    updatedAt: at,
    decidedAt: at,
  });
  track('profile_fact', factId, 'unlink isolated database');
}

function save(title: string, summary: string, offsetMs: number): LifeThread {
  const result = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid,
    text: `save this under the ${title} thread`,
    replyText: `${summary} [${runId}]`,
    now: new Date(reference.getTime() + offsetMs),
  });
  if (!result.handled || !result.referencedThread) {
    throw new Error(`Could not seed ${title}.`);
  }
  track(
    'life_thread_with_signals',
    result.referencedThread.id,
    'unlink isolated database',
  );
  return result.referencedThread;
}

function contextFor(thread: LifeThread) {
  return {
    summaryText: thread.summary,
    usedThreadIds: [thread.id],
    usedThreadTitles: [thread.title],
    usedThreadReasons: ['the synthetic obligation was explicitly in context'],
    threadSummaryLines: [`${thread.title}: ${thread.nextAction}`],
  };
}

function correct(params: {
  text: string;
  offsetMs: number;
  context?: LifeThread;
  includeChat?: boolean;
}) {
  return handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid: params.includeChat === false ? undefined : chatJid,
    text: params.text,
    priorContext: params.context ? contextFor(params.context) : null,
    now: new Date(reference.getTime() + params.offsetMs),
  });
}

function result(
  results: Result[],
  name: string,
  pass: boolean,
  evidence: string,
): void {
  results.push({ name, status: pass ? 'PASS' : 'FAIL', evidence });
}

function durableCounts(): {
  threads: number;
  signals: number;
  scheduledTasks: number;
} {
  const reader = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const count = (table: string): number =>
      Number(
        (
          reader
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE group_folder = ?`,
            )
            .get(groupFolder) as { count: number }
        ).count,
      );
    return {
      threads: count('life_threads'),
      signals: count('life_thread_signals'),
      scheduledTasks: count('scheduled_tasks'),
    };
  } finally {
    reader.close();
  }
}

function countProductionResidue(markers: string[]): number {
  const productionPath = path.resolve(process.cwd(), 'store/messages.db');
  if (!fs.existsSync(productionPath)) return 0;
  const reader = new Database(productionPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    let total = 0;
    for (const marker of markers) {
      const like = `%${marker}%`;
      for (const query of [
        `SELECT COUNT(*) AS count FROM life_threads WHERE group_folder = ? OR title LIKE ? OR summary LIKE ? OR COALESCE(next_action, '') LIKE ?`,
        `SELECT COUNT(*) AS count FROM life_thread_signals WHERE group_folder = ? OR summary_text LIKE ? OR COALESCE(chat_jid, '') LIKE ?`,
        `SELECT COUNT(*) AS count FROM profile_subjects WHERE group_folder = ? OR id LIKE ? OR display_name LIKE ?`,
        `SELECT COUNT(*) AS count FROM profile_facts WHERE group_folder = ? OR id LIKE ? OR value_json LIKE ?`,
        `SELECT COUNT(*) AS count FROM scheduled_tasks WHERE group_folder = ? OR COALESCE(chat_jid, '') LIKE ? OR prompt LIKE ?`,
      ]) {
        const placeholders = (query.match(/\?/g) || []).length;
        const args = [groupFolder, ...Array(placeholders - 1).fill(like)];
        total += Number(
          (reader.prepare(query).get(...args) as { count: number }).count,
        );
      }
    }
    return total;
  } finally {
    reader.close();
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  persistManifest();
  _initTestDatabaseAtPath(databasePath);
  seedIdentity();
  const results: Result[] = [];
  let lifecycle: Record<string, unknown> = {};
  let cleanupVerified = false;
  let productionResidue = -1;

  try {
    const permit = save(
      'permit application',
      'Maya needs to submit the permit application by Friday at 3:00 PM.',
      1_000,
    );
    result(
      results,
      'Initial active deadline',
      getLifeThread(permit.id)?.nextFollowupAt === '2026-07-17T20:00:00.000Z',
      `active=${getLifeThread(permit.id)?.nextFollowupAt}`,
    );

    const first = correct({
      text: 'Actually, the deadline moved to Monday at noon.',
      context: permit,
      offsetMs: 2_000,
    });
    const beforeRestart = getLifeThread(permit.id)!;
    const firstSignals = listLifeThreadSignals(permit.id, 20);
    result(
      results,
      'Deadline supersession before restart',
      first.temporalResolution === 'applied' &&
        beforeRestart.nextFollowupAt === '2026-07-20T17:00:00.000Z' &&
        !/Friday|3:00 PM/.test(beforeRestart.nextAction || '') &&
        firstSignals[0]?.summaryText.includes(
          'superseded=2026-07-17T20:00:00.000Z',
        ) === true,
      `resolution=${first.temporalResolution}; active=${beforeRestart.nextFollowupAt}; next=${beforeRestart.nextAction}; provenance=${firstSignals[0]?.summaryText}`,
    );

    _closeDatabase();
    const firstDurableCounts = durableCounts();
    _initTestDatabaseAtPath(databasePath);
    const firstRecovered = getLifeThread(permit.id)!;
    result(
      results,
      'First durable restart',
      firstRecovered.nextFollowupAt === '2026-07-20T17:00:00.000Z' &&
        !/Friday|3:00 PM/.test(firstRecovered.nextAction || '') &&
        firstDurableCounts.threads === 1 &&
        firstDurableCounts.scheduledTasks === 0,
      `active=${firstRecovered.nextFollowupAt}; threads=${firstDurableCounts.threads}; signals=${firstDurableCounts.signals}; scheduled_tasks=${firstDurableCounts.scheduledTasks}`,
    );

    const second = correct({
      text: 'Push the permit application to Tuesday morning.',
      offsetMs: 3_000,
    });
    result(
      results,
      'Sequential correction after restart',
      second.temporalResolution === 'applied' &&
        getLifeThread(permit.id)?.nextFollowupAt === '2026-07-21T14:00:00.000Z',
      `resolution=${second.temporalResolution}; active=${getLifeThread(permit.id)?.nextFollowupAt}`,
    );

    _closeDatabase();
    const secondDurableCounts = durableCounts();
    _initTestDatabaseAtPath(databasePath);
    const finalPermit = getLifeThread(permit.id)!;
    const finalSnapshot = buildLifeThreadSnapshot({
      groupFolder,
      now: new Date(reference.getTime() + 4_000),
    });
    result(
      results,
      'Second durable restart and convergence',
      finalPermit.nextFollowupAt === '2026-07-21T14:00:00.000Z' &&
        !/Thursday|Friday|Monday|3:00 PM|noon/.test(
          finalPermit.nextAction || '',
        ) &&
        secondDurableCounts.threads === 1 &&
        secondDurableCounts.signals === 3 &&
        secondDurableCounts.scheduledTasks === 0 &&
        finalSnapshot.activeThreads.filter((thread) => thread.id === permit.id)
          .length === 1,
      `active=${finalPermit.nextFollowupAt}; threads=${secondDurableCounts.threads}; signals=${secondDurableCounts.signals}; scheduled_tasks=${secondDurableCounts.scheduledTasks}; active_snapshot_matches=${finalSnapshot.activeThreads.filter((thread) => thread.id === permit.id).length}`,
    );

    const ordinal = save(
      'license renewal',
      'The license renewal is due July 16 at 4:00 PM.',
      5_000,
    );
    const ordinalResult = correct({
      text: 'Correction: it is due on the 19th, not the 16th.',
      context: ordinal,
      offsetMs: 6_000,
    });
    result(
      results,
      'Held-out ordinal correction',
      ordinalResult.temporalResolution === 'applied' &&
        getLifeThread(ordinal.id)?.nextFollowupAt ===
          '2026-07-19T21:00:00.000Z',
      `resolution=${ordinalResult.temporalResolution}; active=${getLifeThread(ordinal.id)?.nextFollowupAt}`,
    );

    const extension = correct({
      text: 'They gave me another week.',
      context: ordinal,
      offsetMs: 7_000,
    });
    result(
      results,
      'Held-out relative extension',
      extension.temporalResolution === 'applied' &&
        getLifeThread(ordinal.id)?.nextFollowupAt ===
          '2026-07-26T21:00:00.000Z',
      `resolution=${extension.temporalResolution}; active=${getLifeThread(ordinal.id)?.nextFollowupAt}`,
    );

    const meeting = save(
      'repair meeting',
      'The repair meeting is Friday at 10:00 AM.',
      8_000,
    );
    const application = save(
      'grant application',
      'The grant application deadline is Friday at 2:00 PM.',
      9_000,
    );
    const mixed = correct({
      text: 'The meeting stayed on Friday, but the application deadline moved to Monday.',
      includeChat: false,
      offsetMs: 10_000,
    });
    result(
      results,
      'Held-out unrelated temporal fact',
      mixed.referencedThread?.id === application.id &&
        getLifeThread(application.id)?.nextFollowupAt ===
          '2026-07-20T19:00:00.000Z' &&
        getLifeThread(meeting.id)?.nextFollowupAt ===
          '2026-07-17T15:00:00.000Z',
      `target=${mixed.referencedThread?.title}; application=${getLifeThread(application.id)?.nextFollowupAt}; meeting=${getLifeThread(meeting.id)?.nextFollowupAt}`,
    );

    const city = save(
      'city filing',
      'The city filing is due Friday at 1:00 PM.',
      11_000,
    );
    const county = save(
      'county filing',
      'The county filing is due Monday at 1:00 PM.',
      12_000,
    );
    const ambiguous = correct({
      text: 'Move it to Tuesday.',
      includeChat: false,
      offsetMs: 13_000,
    });
    result(
      results,
      'Held-out ambiguous target refusal',
      ambiguous.temporalResolution === 'ambiguous' &&
        getLifeThread(city.id)?.nextFollowupAt === '2026-07-17T18:00:00.000Z' &&
        getLifeThread(county.id)?.nextFollowupAt === '2026-07-20T18:00:00.000Z',
      `resolution=${ambiguous.temporalResolution}; city=${getLifeThread(city.id)?.nextFollowupAt}; county=${getLifeThread(county.id)?.nextFollowupAt}`,
    );

    const duplicate = save(
      'tax filing',
      'The tax filing is due Thursday at 5:00 PM.',
      14_000,
    );
    const duplicateText = 'The tax filing deadline moved to Friday at noon.';
    const duplicateFirst = correct({ text: duplicateText, offsetMs: 15_000 });
    const duplicateCount = listLifeThreadSignals(duplicate.id, 20).length;
    const duplicateUpdatedAt = getLifeThread(duplicate.id)?.lastUpdatedAt;
    const duplicateSecond = correct({ text: duplicateText, offsetMs: 16_000 });
    result(
      results,
      'Held-out duplicate ingestion',
      duplicateFirst.temporalResolution === 'applied' &&
        duplicateSecond.temporalResolution === 'duplicate' &&
        listLifeThreadSignals(duplicate.id, 20).length === duplicateCount &&
        getLifeThread(duplicate.id)?.lastUpdatedAt === duplicateUpdatedAt,
      `first=${duplicateFirst.temporalResolution}; replay=${duplicateSecond.temporalResolution}; signals=${listLifeThreadSignals(duplicate.id, 20).length}`,
    );

    const past = save(
      'audit response',
      'The audit response is due July 18 at 3:00 PM.',
      17_000,
    );
    const pastResult = correct({
      text: 'Correction: the audit response was due July 10 at 4:00 PM.',
      offsetMs: 18_000,
    });
    result(
      results,
      'Held-out correction into the past',
      pastResult.temporalResolution === 'applied' &&
        getLifeThread(past.id)?.nextFollowupAt === '2026-07-10T21:00:00.000Z' &&
        buildLifeThreadSnapshot({
          groupFolder,
          now: reference,
        }).slippingThreads.some((thread) => thread.id === past.id),
      `resolution=${pastResult.temporalResolution}; active=${getLifeThread(past.id)?.nextFollowupAt}; slipping=${buildLifeThreadSnapshot({ groupFolder, now: reference }).slippingThreads.some((thread) => thread.id === past.id)}`,
    );

    const timeOnly = save(
      'vendor call',
      'The vendor call is July 22 at 10:00 AM.',
      19_000,
    );
    const timeOnlyResult = correct({
      text: 'Actually, make the vendor call 2:30 PM.',
      offsetMs: 20_000,
    });
    result(
      results,
      'Held-out time-only correction',
      timeOnlyResult.temporalResolution === 'applied' &&
        getLifeThread(timeOnly.id)?.nextFollowupAt ===
          '2026-07-22T19:30:00.000Z',
      `resolution=${timeOnlyResult.temporalResolution}; active=${getLifeThread(timeOnly.id)?.nextFollowupAt}`,
    );

    const tomorrow = save(
      'briefing packet',
      'The briefing packet is due Friday at 11:00 AM.',
      21_000,
    );
    const tomorrowResult = correct({
      text: 'The briefing packet deadline moved to tomorrow.',
      offsetMs: 22_000,
    });
    result(
      results,
      'Held-out relative-date correction',
      tomorrowResult.temporalResolution === 'applied' &&
        getLifeThread(tomorrow.id)?.nextFollowupAt ===
          '2026-07-15T16:00:00.000Z',
      `resolution=${tomorrowResult.temporalResolution}; active=${getLifeThread(tomorrow.id)?.nextFollowupAt}`,
    );

    lifecycle = {
      firstCorrection: beforeRestart.nextFollowupAt,
      firstRestart: firstRecovered.nextFollowupAt,
      secondCorrection: finalPermit.nextFollowupAt,
      secondRestart: getLifeThread(permit.id)?.nextFollowupAt,
      permitThreadCount: listLifeThreadsForGroup(groupFolder).filter(
        (thread) => thread.id === permit.id,
      ).length,
      permitSignalCount: listLifeThreadSignals(permit.id, 20).length,
      totalSyntheticThreads: listLifeThreadsForGroup(groupFolder).length,
      allResultsPassed: results.every((entry) => entry.status === 'PASS'),
    };
  } finally {
    try {
      _closeDatabase();
    } catch {
      // The final cleanup still verifies all paths independently.
    }
    fs.rmSync(directory, { recursive: true, force: true });
    manifest[0]!.status = 'removed';
    for (const entry of manifest) {
      if (entry.kind !== 'cleanup_manifest') entry.status = 'removed';
    }
    persistManifest();
    productionResidue = countProductionResidue([
      runId,
      namespace,
      groupFolder,
      ...manifest.map((entry) => entry.id),
    ]);
    cleanupVerified =
      !fs.existsSync(databasePath) &&
      !fs.existsSync(`${databasePath}-wal`) &&
      !fs.existsSync(`${databasePath}-shm`) &&
      productionResidue === 0;
    manifest[1]!.status = cleanupVerified ? 'removed' : 'pending';
    persistManifest();
    if (cleanupVerified) fs.rmSync(manifestPath, { force: true });
  }

  const passed = results.filter((entry) => entry.status === 'PASS').length;
  const report = {
    certification: 'ANDREA TEMPORAL TRUTH AND DURABLE RESTART CERTIFICATION',
    runId,
    isolation:
      'disposable SQLite datastore through the production db initialization path; no provider, calendar, message, or production writes',
    referenceTime: reference.toISOString(),
    acceptedTimeZone: 'America/Chicago',
    results,
    counts: { PASS: passed, FAIL: results.length - passed },
    lifecycle,
    cleanup: {
      manifestEntries: manifest.length,
      cleanupVerified,
      productionResidue,
      isolatedDirectoryExists: fs.existsSync(directory),
      manifestExists: fs.existsSync(manifestPath),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!cleanupVerified || passed !== results.length) process.exitCode = 1;
}

await main();
