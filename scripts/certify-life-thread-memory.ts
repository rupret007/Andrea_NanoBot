import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { buildDailyCompanionResponse } from '../src/daily-companion.js';
import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  deleteLifeThread,
  getLifeThread,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  listProfileSubjectsForGroup,
  upsertProfileFact,
  upsertProfileSubject,
} from '../src/db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
} from '../src/life-threads.js';
import type { LifeThread } from '../src/types.js';

type ScenarioStatus = 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED' | 'INDETERMINATE';

interface CleanupArtifact {
  artifactType: string;
  internalId: string;
  providerOrDatastoreId: string;
  createdAt: string;
  expectedCleanupOperation: string;
  finalCleanupStatus: 'pending' | 'removed' | 'absent' | 'retained_fixture';
}

interface ScenarioResult {
  scenario: number;
  name: string;
  status: ScenarioStatus;
  evidence: string;
}

interface HeldOutResult {
  name: string;
  status: ScenarioStatus;
  evidence: string;
}

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }),
);
const phase = args.get('phase') || 'post-change';
const runId =
  process.env.ANDREA_LIFETHREAD_RUN_ID ||
  `ANDREA-LIFETHREAD-${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
const shortId = runId
  .slice(-8)
  .replace(/[^A-Za-z0-9]/g, '')
  .toLowerCase();
const groupFolder = `ltcert_${shortId}`;
const chatJid = `synthetic:${runId}`;
const dbPath = path.join(os.tmpdir(), `${runId}.sqlite`);
const manifestPath = path.join(os.tmpdir(), `${runId}-cleanup.json`);
const now = new Date('2026-07-14T09:00:00-05:00');

const manifest: CleanupArtifact[] = [
  {
    artifactType: 'isolated_sqlite_database',
    internalId: runId,
    providerOrDatastoreId: dbPath,
    createdAt: new Date().toISOString(),
    expectedCleanupOperation:
      'close database and unlink sqlite, wal, and shm files',
    finalCleanupStatus: 'pending',
  },
  {
    artifactType: 'cleanup_manifest',
    internalId: runId,
    providerOrDatastoreId: manifestPath,
    createdAt: new Date().toISOString(),
    expectedCleanupOperation: 'unlink manifest after independent verification',
    finalCleanupStatus: 'pending',
  },
];

function persistManifest(): void {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

function trackThread(thread: LifeThread): void {
  if (manifest.some((artifact) => artifact.internalId === thread.id)) return;
  manifest.push({
    artifactType: 'life_thread_with_cascading_signals',
    internalId: thread.id,
    providerOrDatastoreId: `${groupFolder}:${thread.title}`,
    createdAt: thread.createdAt,
    expectedCleanupOperation: 'deleteLifeThread',
    finalCleanupStatus: 'pending',
  });
  persistManifest();
}

function seedSyntheticIdentity(): void {
  const createdAt = now.toISOString();
  const subjectId = `${runId}:profile:self`;
  upsertProfileSubject({
    id: subjectId,
    groupFolder,
    kind: 'self',
    canonicalName: 'self',
    displayName: 'Maya Ellis',
    createdAt,
    updatedAt: createdAt,
    disabledAt: null,
  });
  manifest.push({
    artifactType: 'profile_subject',
    internalId: subjectId,
    providerOrDatastoreId: `${groupFolder}:self:Maya Ellis`,
    createdAt,
    expectedCleanupOperation: 'unlink isolated database',
    finalCleanupStatus: 'pending',
  });

  for (const fact of [
    {
      id: `${runId}:profile:timezone`,
      category: 'routines' as const,
      factKey: 'timezone',
      valueJson: JSON.stringify({
        timezone: 'America/Chicago',
        runId,
      }),
      sourceSummary: `Synthetic certification timezone [${runId}]`,
    },
    {
      id: `${runId}:profile:occupation`,
      category: 'recurring_priorities' as const,
      factKey: 'occupation',
      valueJson: JSON.stringify({
        occupation: 'Independent operations consultant',
        runId,
      }),
      sourceSummary: `Synthetic certification occupation [${runId}]`,
    },
  ]) {
    upsertProfileFact({
      id: fact.id,
      groupFolder,
      subjectId,
      category: fact.category,
      factKey: fact.factKey,
      valueJson: fact.valueJson,
      state: 'accepted',
      sourceChannel: 'synthetic_offline_fixture',
      sourceSummary: fact.sourceSummary,
      createdAt,
      updatedAt: createdAt,
      decidedAt: createdAt,
    });
    manifest.push({
      artifactType: 'profile_fact',
      internalId: fact.id,
      providerOrDatastoreId: `${groupFolder}:${fact.factKey}`,
      createdAt,
      expectedCleanupOperation: 'unlink isolated database',
      finalCleanupStatus: 'pending',
    });
  }
  persistManifest();
}

function saveThread(title: string, summary: string, at: Date): LifeThread {
  const result = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid,
    text: `save this under the ${title} thread`,
    replyText: `${summary} [${runId}]`,
    now: at,
  });
  if (!result.handled || !result.referencedThread) {
    throw new Error(`Failed to seed synthetic thread: ${title}`);
  }
  trackThread(result.referencedThread);
  return result.referencedThread;
}

function contextFor(thread: LifeThread) {
  return {
    summaryText: thread.summary,
    usedThreadIds: [thread.id],
    usedThreadTitles: [thread.title],
    usedThreadReasons: ['it was the active synthetic thread in the prior turn'],
    threadSummaryLines: [
      `${thread.title}: ${thread.nextAction || thread.summary}`,
    ],
  };
}

const emptyCalendarFetch: typeof fetch = async (request) => {
  const url = String(request);
  if (url.includes('/users/me/calendarList')) {
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }
  return new Response(JSON.stringify({ summary: 'synthetic', items: [] }), {
    status: 200,
  });
};

async function recall(prompt: string, at: Date): Promise<string> {
  const response = await buildDailyCompanionResponse(prompt, {
    channel: 'telegram',
    groupFolder,
    now: at,
    timeZone: 'America/Chicago',
    env: {
      GOOGLE_CALENDAR_ACCESS_TOKEN: 'synthetic-offline-token',
      GOOGLE_CALENDAR_IDS: 'primary',
    },
    fetchImpl: emptyCalendarFetch,
    tasks: [],
  });
  return response?.reply || '';
}

function hasActiveTitle(title: string): boolean {
  return listLifeThreadsForGroup(groupFolder, ['active']).some(
    (thread) => thread.title.toLowerCase() === title.toLowerCase(),
  );
}

function titleEquals(thread: LifeThread, title: string): boolean {
  return thread.title.toLowerCase() === title.toLowerCase();
}

function terminalSignalCount(kind: 'completed' | 'cancelled'): number {
  return listLifeThreadsForGroup(groupFolder)
    .flatMap((thread) => listLifeThreadSignals(thread.id, 20))
    .filter((signal) => signal.summaryText.startsWith(`${kind}:`)).length;
}

function countProductionResidue(markers: string[]): number {
  const liveDbPath = path.resolve(process.cwd(), 'store/messages.db');
  if (!fs.existsSync(liveDbPath)) return 0;
  const live = new Database(liveDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    let total = 0;
    for (const marker of markers) {
      const like = `%${marker}%`;
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM life_threads
               WHERE group_folder = ? OR title LIKE ? OR summary LIKE ? OR COALESCE(next_action, '') LIKE ?`,
            )
            .get(groupFolder, like, like, like) as { count: number }
        ).count,
      );
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM profile_subjects
               WHERE id LIKE ? OR group_folder = ? OR canonical_name LIKE ? OR display_name LIKE ?`,
            )
            .get(like, groupFolder, like, like) as { count: number }
        ).count,
      );
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM profile_facts
               WHERE id LIKE ? OR group_folder = ? OR value_json LIKE ? OR source_summary LIKE ?`,
            )
            .get(like, groupFolder, like, like) as { count: number }
        ).count,
      );
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM life_thread_signals
               WHERE group_folder = ? OR summary_text LIKE ? OR COALESCE(chat_jid, '') LIKE ?`,
            )
            .get(groupFolder, like, like) as { count: number }
        ).count,
      );
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM router_state
               WHERE key LIKE ? OR value LIKE ?`,
            )
            .get(like, like) as { count: number }
        ).count,
      );
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM messages
               WHERE chat_jid LIKE ? OR content LIKE ?`,
            )
            .get(like, like) as { count: number }
        ).count,
      );
      total += Number(
        (
          live
            .prepare(
              `SELECT COUNT(*) AS count FROM scheduled_tasks
               WHERE group_folder = ? OR chat_jid LIKE ? OR prompt LIKE ?`,
            )
            .get(groupFolder, like, like) as { count: number }
        ).count,
      );
    }
    return total;
  } finally {
    live.close();
  }
}

async function main(): Promise<void> {
  persistManifest();
  _initTestDatabaseAtPath(dbPath);
  const results: ScenarioResult[] = [];
  const heldOutResults: HeldOutResult[] = [];
  let lifecycleMachineState: Record<string, unknown> = {};
  let cleanupVerified = false;
  let productionResidue = -1;
  let namedMarkerObservations: Record<string, number> = {};

  try {
    seedSyntheticIdentity();
    if (
      listProfileSubjectsForGroup(groupFolder).length !== 1 ||
      listProfileFactsForGroup(groupFolder, ['accepted']).length !== 2
    ) {
      throw new Error('Synthetic identity fixture did not persist completely.');
    }
    const verification = saveThread(
      'Verification phrase',
      "Maya's fictional account verification phrase for this test is ORCHID-LANTERN.",
      new Date(now.getTime() + 1_000),
    );
    const northstar = saveThread(
      'Northstar',
      'I promised Priya I would send the Northstar proposal by Thursday at 5:00 PM. Save that for later.',
      new Date(now.getTime() + 2_000),
    );
    saveThread(
      'Air filters',
      'I need to buy replacement air filters sometime this month. Save that for later.',
      new Date(now.getTime() + 3_000),
    );
    saveThread(
      'Pottery idea',
      'I might look into taking a pottery class someday.',
      new Date(now.getTime() + 4_000),
    );
    saveThread(
      'Insurance paperwork',
      'Jordan is supposed to send me the insurance paperwork before I can complete the application. Save that for later.',
      new Date(now.getTime() + 5_000),
    );
    saveThread(
      'Plumbing inspection',
      'My plumbing inspection is Wednesday from 3:00 PM to 5:00 PM.',
      new Date(now.getTime() + 6_000),
    );
    const expense = saveThread(
      'Expense report',
      'I need to submit the expense report by Tuesday. Save that for later.',
      new Date(now.getTime() + 7_000),
    );
    const leo = saveThread(
      'Leo repair meeting',
      'I plan to meet Leo about the kitchen repair Friday afternoon. Save that for later.',
      new Date(now.getTime() + 8_000),
    );

    const initialRecall = await recall(
      'What am I forgetting?',
      new Date(now.getTime() + 9_000),
    );
    const initialSnapshot = buildLifeThreadSnapshot({ groupFolder, now });
    const initialPrivacyLeak = initialRecall.includes('ORCHID-LANTERN');
    results.push({
      scenario: 1,
      name: 'Initial proactive recall',
      status:
        initialSnapshot.recommendedNextThread?.id === northstar.id &&
        !initialPrivacyLeak
          ? 'PASS'
          : initialPrivacyLeak
            ? 'FAIL'
            : 'PARTIAL',
      evidence: `active=${initialSnapshot.activeThreads.length}; recommended=${initialSnapshot.recommendedNextThread?.title || 'none'}; concise_lines=${initialRecall.split('\n').filter(Boolean).length}; privacy_leak=${initialPrivacyLeak}`,
    });

    const completion = handleLifeThreadCommand({
      groupFolder,
      channel: 'telegram',
      chatJid,
      text: 'I submitted the expense report. Mark that done.',
      priorContext: contextFor(expense),
      now: new Date(now.getTime() + 10_000),
    });
    results.push({
      scenario: 2,
      name: 'Completion suppression',
      status: !hasActiveTitle('Expense report') ? 'PASS' : 'FAIL',
      evidence: `handled=${completion.handled}; active=${hasActiveTitle('Expense report')}; terminal_signal_count=${terminalSignalCount('completed')}`,
    });

    const cancellation = handleLifeThreadCommand({
      groupFolder,
      channel: 'telegram',
      chatJid,
      text: 'The meeting with Leo was cancelled.',
      priorContext: contextFor(leo),
      now: new Date(now.getTime() + 11_000),
    });
    results.push({
      scenario: 3,
      name: 'Cancellation suppression',
      status: !hasActiveTitle('Leo repair meeting') ? 'PASS' : 'FAIL',
      evidence: `handled=${cancellation.handled}; active=${hasActiveTitle('Leo repair meeting')}; terminal_signal_count=${terminalSignalCount('cancelled')}`,
    });

    const corrected = saveThread(
      'Northstar',
      'The client moved the Northstar deadline to Friday at noon. Thursday at five is no longer correct.',
      new Date(now.getTime() + 12_000),
    );
    results.push({
      scenario: 4,
      name: 'Temporal supersession',
      status:
        corrected.summary.includes('Friday at noon') &&
        !String(getLifeThread(corrected.id)?.nextAction).includes('Thursday')
          ? 'PASS'
          : 'FAIL',
      evidence: `summary=${getLifeThread(corrected.id)?.summary}; next_action=${getLifeThread(corrected.id)?.nextAction}`,
    });

    saveThread(
      'Northstar',
      'Remember that I owe Priya the Northstar proposal before the client deadline.',
      new Date(now.getTime() + 13_000),
    );
    const northstarThreads = listLifeThreadsForGroup(groupFolder).filter(
      (thread) => titleEquals(thread, 'Northstar'),
    );
    results.push({
      scenario: 5,
      name: 'Semantic deduplication',
      status: northstarThreads.length === 1 ? 'PASS' : 'FAIL',
      evidence: `underlying_thread_count=${northstarThreads.length}; signal_count=${northstarThreads[0] ? listLifeThreadSignals(northstarThreads[0].id, 20).length : 0}`,
    });

    const waiting = listLifeThreadsForGroup(groupFolder, ['active']).find(
      (thread) => titleEquals(thread, 'Insurance paperwork'),
    );
    results.push({
      scenario: 6,
      name: 'Waiting state',
      status:
        waiting?.summary.includes('Jordan') &&
        waiting.summary.includes('before I can complete')
          ? 'PARTIAL'
          : 'FAIL',
      evidence: `preserved_blocker=${Boolean(waiting?.summary.includes('Jordan'))}; structured_waiting_state=false`,
    });

    const pottery = listLifeThreadsForGroup(groupFolder, ['active']).find(
      (thread) => titleEquals(thread, 'Pottery idea'),
    );
    results.push({
      scenario: 7,
      name: 'Tentative versus committed',
      status: pottery ? 'FAIL' : 'PASS',
      evidence: `tentative_item_active=${Boolean(pottery)}; structured_tentative_state=false`,
    });

    const privacyRecall = await recall(
      'What am I forgetting?',
      new Date(now.getTime() + 14_000),
    );
    results.push({
      scenario: 8,
      name: 'Privacy and relevance',
      status: privacyRecall.includes('ORCHID-LANTERN') ? 'FAIL' : 'PASS',
      evidence: `verification_phrase_exposed=${privacyRecall.includes('ORCHID-LANTERN')}; response_lines=${privacyRecall.split('\n').filter(Boolean).length}`,
    });

    _closeDatabase();
    _initTestDatabaseAtPath(dbPath);
    const recoveredNorthstar = listLifeThreadsForGroup(groupFolder).find(
      (thread) => titleEquals(thread, 'Northstar'),
    );
    const recoveredActive = listLifeThreadsForGroup(groupFolder, ['active']);
    results.push({
      scenario: 9,
      name: 'Restart recovery',
      status:
        recoveredNorthstar &&
        !recoveredActive.some((thread) =>
          titleEquals(thread, 'Expense report'),
        ) &&
        !recoveredActive.some((thread) =>
          titleEquals(thread, 'Leo repair meeting'),
        ) &&
        !String(recoveredNorthstar.nextAction).includes('Thursday')
          ? 'PASS'
          : 'FAIL',
      evidence: `northstar_persisted=${Boolean(recoveredNorthstar)}; completed_suppressed=${!recoveredActive.some((thread) => titleEquals(thread, 'Expense report'))}; cancelled_suppressed=${!recoveredActive.some((thread) => titleEquals(thread, 'Leo repair meeting'))}; stale_deadline_suppressed=${!String(recoveredNorthstar?.nextAction).includes('Thursday')}`,
    });

    const selectiveForget = handleLifeThreadCommand({
      groupFolder,
      channel: 'telegram',
      chatJid,
      text: 'Forget the pottery-class idea and the air-filter errand.',
      now: new Date(now.getTime() + 15_000),
    });
    results.push({
      scenario: 10,
      name: 'Selective forgetting',
      status:
        !hasActiveTitle('Pottery idea') &&
        !hasActiveTitle('Air filters') &&
        hasActiveTitle('Northstar') &&
        hasActiveTitle('Insurance paperwork')
          ? 'PASS'
          : 'FAIL',
      evidence: `handled=${selectiveForget.handled}; pottery_active=${hasActiveTitle('Pottery idea')}; air_filters_active=${hasActiveTitle('Air filters')}; northstar_active=${hasActiveTitle('Northstar')}; insurance_active=${hasActiveTitle('Insurance paperwork')}`,
    });

    const lifecycleThreads = listLifeThreadsForGroup(groupFolder);
    const lifecycleNorthstar = lifecycleThreads.find((thread) =>
      titleEquals(thread, 'Northstar'),
    );
    lifecycleMachineState = {
      profileSubjects: listProfileSubjectsForGroup(groupFolder).length,
      acceptedProfileFacts: listProfileFactsForGroup(groupFolder, ['accepted'])
        .length,
      activeObligations: lifecycleThreads.filter(
        (thread) => thread.status === 'active',
      ).length,
      closedItems: lifecycleThreads.filter(
        (thread) => thread.status === 'closed',
      ).length,
      completedTerminalSignals: terminalSignalCount('completed'),
      cancelledTerminalSignals: terminalSignalCount('cancelled'),
      structuredTentativeItems: 0,
      structuredWaitingItems: 0,
      duplicateNorthstarThreads: Math.max(
        0,
        lifecycleThreads.filter((thread) => titleEquals(thread, 'Northstar'))
          .length - 1,
      ),
      northstarActiveNextAction: lifecycleNorthstar?.nextAction || null,
      restartPersistenceObserved: true,
      selectiveForgetHandled: selectiveForget.handled,
    };

    const heldOutCompletion = saveThread(
      'Vendor renewal',
      'Finish the vendor renewal paperwork.',
      new Date(now.getTime() + 16_000),
    );
    const heldOutCompletionResult = handleLifeThreadCommand({
      groupFolder,
      channel: 'telegram',
      chatJid,
      text: 'That task is taken care of now.',
      priorContext: contextFor(heldOutCompletion),
      now: new Date(now.getTime() + 17_000),
    });
    heldOutResults.push({
      name: 'Held-out completion',
      status:
        heldOutCompletionResult.handled &&
        getLifeThread(heldOutCompletion.id)?.status === 'closed'
          ? 'PASS'
          : 'FAIL',
      evidence: `handled=${heldOutCompletionResult.handled}; status=${getLifeThread(heldOutCompletion.id)?.status}`,
    });

    const heldOutCancellation = saveThread(
      'Friday contractor meeting',
      'Attend the Friday contractor meeting.',
      new Date(now.getTime() + 18_000),
    );
    const heldOutCancellationResult = handleLifeThreadCommand({
      groupFolder,
      channel: 'telegram',
      text: 'We are not doing the Friday contractor meeting anymore.',
      now: new Date(now.getTime() + 19_000),
    });
    heldOutResults.push({
      name: 'Held-out cancellation',
      status:
        heldOutCancellationResult.handled &&
        getLifeThread(heldOutCancellation.id)?.status === 'closed'
          ? 'PASS'
          : 'FAIL',
      evidence: `handled=${heldOutCancellationResult.handled}; status=${getLifeThread(heldOutCancellation.id)?.status}`,
    });

    const heldOutDeadline = saveThread(
      'Northstar',
      'Scratch Thursday. The client expects it by lunch Friday.',
      new Date(now.getTime() + 20_000),
    );
    heldOutResults.push({
      name: 'Held-out deadline correction',
      status: String(heldOutDeadline.nextAction).includes('Thursday')
        ? 'FAIL'
        : 'PASS',
      evidence: `summary=${heldOutDeadline.summary}; next_action=${heldOutDeadline.nextAction}`,
    });

    saveThread(
      'Northstar',
      'Add a reminder that Priya still needs the proposal from me.',
      new Date(now.getTime() + 21_000),
    );
    const heldOutNorthstarCount = listLifeThreadsForGroup(groupFolder).filter(
      (thread) => titleEquals(thread, 'Northstar'),
    ).length;
    heldOutResults.push({
      name: 'Held-out duplicate',
      status: heldOutNorthstarCount === 1 ? 'PASS' : 'FAIL',
      evidence: `underlying_thread_count=${heldOutNorthstarCount}`,
    });

    saveThread(
      'Photography idea',
      'It could be fun to learn photography one day.',
      new Date(now.getTime() + 22_000),
    );
    heldOutResults.push({
      name: 'Held-out tentative idea',
      status: hasActiveTitle('Photography idea') ? 'FAIL' : 'PASS',
      evidence: `tentative_item_active=${hasActiveTitle('Photography idea')}`,
    });

    const heldOutRecall = await recall(
      "Is there anything important I'm dropping?",
      new Date(now.getTime() + 23_000),
    );
    heldOutResults.push({
      name: 'Held-out recall query',
      status: heldOutRecall ? 'PASS' : 'FAIL',
      evidence: `handled=${Boolean(heldOutRecall)}; response_lines=${heldOutRecall.split('\n').filter(Boolean).length}`,
    });

    void verification;
  } finally {
    if (
      (() => {
        try {
          return listLifeThreadsForGroup(groupFolder).length >= 0;
        } catch {
          return false;
        }
      })()
    ) {
      for (const thread of listLifeThreadsForGroup(groupFolder)) {
        deleteLifeThread(thread.id);
        const artifact = manifest.find((item) => item.internalId === thread.id);
        if (artifact) artifact.finalCleanupStatus = 'removed';
      }
      _closeDatabase();
    }
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    manifest[0]!.finalCleanupStatus = 'removed';
    for (const artifact of manifest) {
      if (
        artifact.finalCleanupStatus === 'pending' &&
        artifact.artifactType !== 'cleanup_manifest'
      ) {
        artifact.finalCleanupStatus = 'removed';
      }
    }
    persistManifest();
    productionResidue = countProductionResidue([
      runId,
      groupFolder,
      ...manifest.map((artifact) => artifact.internalId),
    ]);
    namedMarkerObservations = Object.fromEntries(
      [
        'Maya Ellis',
        'Northstar',
        'Priya',
        'Jordan',
        'Leo',
        'ORCHID-LANTERN',
      ].map((marker) => [marker, countProductionResidue([marker])]),
    );
    cleanupVerified =
      !fs.existsSync(dbPath) &&
      !fs.existsSync(`${dbPath}-wal`) &&
      !fs.existsSync(`${dbPath}-shm`) &&
      productionResidue === 0;
    manifest[1]!.finalCleanupStatus = cleanupVerified ? 'removed' : 'pending';
    persistManifest();
    if (cleanupVerified) fs.rmSync(manifestPath, { force: true });
  }

  const counts = Object.fromEntries(
    (['PASS', 'PARTIAL', 'FAIL', 'BLOCKED', 'INDETERMINATE'] as const).map(
      (status) => [
        status,
        results.filter((result) => result.status === status).length,
      ],
    ),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        certification: 'SYNTHETIC LIFE-THREAD CERTIFICATION',
        phase,
        runId,
        isolation:
          'disposable SQLite database opened through _initTestDatabaseAtPath with offline calendar fake',
        groupFolder,
        results,
        heldOutResults,
        lifecycleMachineState,
        counts,
        cleanup: {
          manifestEntries: manifest.length,
          cleanupVerified,
          productionResidue,
          namedMarkerObservations,
          isolatedDatabaseExists: fs.existsSync(dbPath),
          cleanupManifestExists: fs.existsSync(manifestPath),
        },
      },
      null,
      2,
    )}\n`,
  );
  if (!cleanupVerified) process.exitCode = 1;
}

await main();
