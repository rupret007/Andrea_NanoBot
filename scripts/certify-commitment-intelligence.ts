import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  applyLifeThreadCommitmentTransition,
  createLifeThreadWithInitialCommitment,
  deleteLifeThread,
  getLifeThread,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  listProfileSubjectsForGroup,
  updateLifeThread,
  upsertProfileFact,
  upsertProfileSubject,
} from '../src/db.js';
import {
  buildMatureDeferredCommitment,
  compareLifeThreadCommitmentPriority,
  getLifeThreadCommitment,
  interpretLifeThreadCommitment,
  isLifeThreadCommitmentState,
  projectLifeThreadCommitment,
  shouldProactivelySurfaceCommitment,
} from '../src/life-thread-commitment.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
} from '../src/life-threads.js';
import { buildHermeticTestEnv } from '../src/hermetic-test-env.js';
import type {
  LifeThread,
  LifeThreadCommitmentTransitionRecord,
  LifeThreadSignal,
  ProfileSubject,
} from '../src/types.js';

type Status = 'PASS' | 'FAIL';
type BaselineStatus = Status | 'PARTIAL' | 'NOT_CERTIFIED';

interface CertificationResult {
  id: number;
  name: string;
  baseline: BaselineStatus;
  status: Status;
  evidence: Record<string, unknown>;
}

interface HeldOutResult {
  id: number;
  name: string;
  status: Status;
  evidence: Record<string, unknown>;
}

interface InvariantResult {
  name: string;
  status: Status;
  evidence: Record<string, unknown>;
}

interface CleanupEntry {
  kind: string;
  id: string;
  cleanup: string;
  status: 'pending' | 'removed';
}

interface PreparedTransition {
  thread: LifeThread;
  state: NonNullable<LifeThread['commitment']>;
  transition: LifeThreadCommitmentTransitionRecord;
  signal: LifeThreadSignal & {
    commitmentTransition: LifeThreadCommitmentTransitionRecord;
  };
  text: string;
}

const PRIMARY_NAMES = [
  'Speculative idea remains non-actionable',
  'Tentative plan is remembered but not treated as firm',
  'Firm self-commitment becomes actionable',
  'Explicit reminder request receives strong follow-through',
  'Completed user action transitions into waiting',
  'Waiting thread does not repeat the completed action',
  'Waiting event resolution reactivates the correct downstream action',
  'Blocked obligation suppresses impossible next action',
  'Dependency satisfaction unblocks the obligation',
  'Delegation changes next-action ownership',
  'Delegated work remains open until completion evidence',
  'Ownership can return to the user',
  'Deferral suppresses premature recall',
  'Deferred thread reactivates at the correct time',
  'Tentative commitment can be strengthened',
  'Firm commitment can be weakened',
  'Completion suppresses all active follow-through',
  'Cancellation suppresses all active follow-through',
  'Deadline correction still supersedes stale values',
  'Restart preserves all state distinctions',
  'Duplicate ingestion is idempotent',
  'Ambiguous target does not mutate state',
  'Multi-obligation ranking favors actionable committed work',
  'Privacy and relevance remain intact',
] as const;

const BASELINE: BaselineStatus[] = [
  'FAIL',
  'FAIL',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'PARTIAL',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'PARTIAL',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'PASS',
  'PASS',
  'PASS',
  'PASS',
  'PASS',
  'NOT_CERTIFIED',
  'NOT_CERTIFIED',
  'PASS',
];

const HELD_OUT_NAMES = [
  'May get around to it this weekend remains speculative',
  'Definitely doing it Saturday is committed',
  'Already sent it leaves the ball in their court',
  'Permit-office response blocks forward progress',
  'Chris has this one transfers ownership',
  'Taking it back restores user ownership',
  'Shelving until after vacation defers without cancelling',
  'Five-business-day conditional follow-up is scheduled',
  'Only thinking about it weakens the commitment',
  'Either Luke or Tracey response satisfies an any dependency',
  'Similar Brandon tasks make a vague delegation ambiguous',
  'One statement completes, waits, and creates conditional follow-up',
  'Restart between every major transition preserves truth',
  'Replaying the same event twice is idempotent',
  'Out-of-order older evidence cannot reactivate superseded state',
] as const;

const REFERENCE = new Date('2026-07-14T09:00:00-05:00');
const TIME_ZONE = 'America/Chicago';
const EXPECTED_RESTARTS = 18;
const runId = `ANDREA-COMMITMENT-${randomUUID().toUpperCase()}`;
const namespace = runId.slice(-12).replace(/-/g, '').toLowerCase();
const groupFolder = `commitcert_${namespace}`;
const isolatedGroup = `commitcert_isolated_${namespace}`;
const directory = path.join(os.tmpdir(), runId);
const databasePath = path.join(directory, 'messages.db');
const manifestPath = path.join(os.tmpdir(), `${runId}-cleanup.json`);
const primary: CertificationResult[] = [];
const heldOut: HeldOutResult[] = [];
const invariants: InvariantResult[] = [];
const threadIds = new Set<string>();
let sequence = 0;
let restartCount = 0;
let networkGuardProof = false;
let hermeticParentProof = false;
let productionResidue = -1;
let isolatedResidue = -1;
let cleanupVerified = false;
let fatalError: string | null = null;
let finalStateSummary: Record<string, unknown> = {};
let isolatedInitialized = false;
const cleanupErrors: string[] = [];

const manifest: CleanupEntry[] = [
  {
    kind: 'disposable_sqlite_database',
    id: databasePath,
    cleanup:
      'close and remove the database, WAL, SHM, and containing directory',
    status: 'pending',
  },
  {
    kind: 'cleanup_manifest',
    id: manifestPath,
    cleanup: 'remove after independent datastore and production residue checks',
    status: 'pending',
  },
];

function persistManifest(): void {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

function tick(seconds = 1): Date {
  sequence += seconds;
  return new Date(REFERENCE.getTime() + sequence * 1_000);
}

function stableSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
}

function subjects(): ProfileSubject[] {
  return listProfileSubjectsForGroup(groupFolder);
}

function state(thread: LifeThread) {
  return getLifeThreadCommitment(thread);
}

function normalizedAction(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/^(?:i(?:\s+need to|\s+will|'ll)|i(?:'m| am) going to)\s+/i, '')
    .trim()
    .toLowerCase();
}

function current(threadId: string): LifeThread {
  const thread = getLifeThread(threadId);
  if (!thread) throw new Error(`Missing synthetic life thread ${threadId}.`);
  return thread;
}

function seedIdentity(): void {
  const at = REFERENCE.toISOString();
  const fixtures: Array<{
    id: string;
    kind: ProfileSubject['kind'];
    canonicalName: string;
    displayName: string;
  }> = [
    {
      id: `${runId}:subject:self`,
      kind: 'self',
      canonicalName: 'self',
      displayName: 'Maya Ellis',
    },
    ...['Brandon', 'Luke', 'Tracey', 'Chris'].map((name) => ({
      id: `${runId}:subject:${name.toLowerCase()}`,
      kind: 'person' as const,
      canonicalName: name.toLowerCase(),
      displayName: name,
    })),
  ];
  for (const fixture of fixtures) {
    upsertProfileSubject({
      ...fixture,
      groupFolder,
      createdAt: at,
      updatedAt: at,
      disabledAt: null,
    });
    manifest.push({
      kind: 'synthetic_profile_subject',
      id: fixture.id,
      cleanup: 'remove with disposable database',
      status: 'pending',
    });
  }
  upsertProfileFact({
    id: `${runId}:fact:timezone`,
    groupFolder,
    subjectId: `${runId}:subject:self`,
    category: 'routines',
    factKey: 'timezone',
    valueJson: JSON.stringify({ timezone: TIME_ZONE, syntheticRunId: runId }),
    state: 'accepted',
    sourceChannel: 'synthetic_offline_fixture',
    sourceSummary: `Controlled timezone for ${runId}`,
    createdAt: at,
    updatedAt: at,
    decidedAt: at,
  });
  manifest.push({
    kind: 'synthetic_profile_fact',
    id: `${runId}:fact:timezone`,
    cleanup: 'remove with disposable database',
    status: 'pending',
  });
  persistManifest();
}

function seedCommitment(params: {
  title: string;
  text: string;
  now?: Date;
  group?: string;
  explicitRequest?: boolean;
  surfaceMode?: LifeThread['surfaceMode'];
}): LifeThread {
  const now = params.now || tick();
  const targetGroup = params.group || groupFolder;
  const id = `${runId}:thread:${stableSlug(params.title)}:${sequence}`;
  const sourceRef = `${runId}:initial:${sequence}`;
  const interpretation = interpretLifeThreadCommitment({
    threadId: id,
    title: params.title,
    text: params.text,
    now,
    timeZone: TIME_ZONE,
    sourceKind: 'explicit',
    sourceRef,
    knownSubjects: targetGroup === groupFolder ? subjects() : [],
    explicitRequest: params.explicitRequest,
  });
  if (!interpretation) {
    throw new Error(`Synthetic fixture was not understood: ${params.title}.`);
  }
  const projection = projectLifeThreadCommitment(interpretation.state, now);
  const thread: LifeThread & {
    commitment: NonNullable<LifeThread['commitment']>;
  } = {
    id,
    groupFolder: targetGroup,
    title: params.title,
    category: 'personal',
    status: projection.status,
    scope: 'personal',
    relatedSubjectIds: [],
    contextTags: ['synthetic', 'commitment-certification'],
    summary: params.text,
    nextAction: projection.nextAction,
    nextFollowupAt: projection.nextFollowupAt,
    sourceKind: 'explicit',
    confidenceKind: interpretation.state.confidenceKind,
    commitment: interpretation.state,
    userConfirmed: true,
    sensitivity: 'normal',
    surfaceMode: params.surfaceMode || 'default',
    followthroughMode:
      params.surfaceMode === 'manual_only'
        ? 'manual_only'
        : projection.followthroughMode,
    lastSurfacedAt: null,
    snoozedUntil: projection.snoozedUntil,
    linkedTaskId: null,
    mergedIntoThreadId: null,
    createdAt: now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
  };
  const signal: LifeThreadSignal & {
    commitmentTransition: LifeThreadCommitmentTransitionRecord;
  } = {
    id: interpretation.eventId,
    threadId: id,
    groupFolder: targetGroup,
    sourceKind: 'explicit',
    summaryText: params.text,
    chatJid: `synthetic:${runId}`,
    confidenceKind: interpretation.state.confidenceKind,
    commitmentTransition: interpretation.transition,
    createdAt: now.toISOString(),
  };
  const created = createLifeThreadWithInitialCommitment({ thread, signal });
  if (created !== 'created') {
    throw new Error(`Synthetic commitment ${params.title} was not created.`);
  }
  threadIds.add(id);
  manifest.push({
    kind: 'life_thread_with_transition_provenance',
    id,
    cleanup:
      'delete thread and cascading signals, then remove disposable database',
    status: 'pending',
  });
  persistManifest();
  return current(id);
}

function prepareTransition(params: {
  thread: LifeThread;
  text: string;
  now?: Date;
  sourceRef?: string;
}): PreparedTransition {
  const now = params.now || tick();
  const sourceRef = params.sourceRef || `${runId}:transition:${sequence}`;
  const interpretation = interpretLifeThreadCommitment({
    threadId: params.thread.id,
    title: params.thread.title,
    text: params.text,
    now,
    timeZone: TIME_ZONE,
    sourceKind: 'explicit',
    sourceRef,
    current: state(params.thread),
    knownSubjects: subjects(),
  });
  if (!interpretation) {
    throw new Error(
      `Synthetic transition was not understood for ${params.thread.title}: ${params.text}`,
    );
  }
  return {
    thread: params.thread,
    state: interpretation.state,
    transition: interpretation.transition,
    text: params.text,
    signal: {
      id: interpretation.eventId,
      threadId: params.thread.id,
      groupFolder: params.thread.groupFolder,
      sourceKind: 'explicit',
      summaryText: params.text,
      chatJid: `synthetic:${runId}`,
      confidenceKind: interpretation.state.confidenceKind,
      commitmentTransition: interpretation.transition,
      createdAt: now.toISOString(),
    },
  };
}

function applyPrepared(prepared: PreparedTransition) {
  const result = applyLifeThreadCommitmentTransition({
    threadId: prepared.thread.id,
    groupFolder: prepared.thread.groupFolder,
    state: prepared.state,
    transition: prepared.transition,
    signal: prepared.signal,
    summary: prepared.text,
    sourceKind: 'explicit',
    confidenceKind: prepared.state.confidenceKind,
    userConfirmed: true,
  });
  return { result, thread: current(prepared.thread.id) };
}

function transition(params: {
  thread: LifeThread;
  text: string;
  now?: Date;
  sourceRef?: string;
}) {
  return applyPrepared(prepareTransition(params));
}

function restart(): void {
  _closeDatabase();
  const durable = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = durable.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    if (integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Disposable commitment database failed integrity check.');
    }
  } finally {
    durable.close();
  }
  _initTestDatabaseAtPath(databasePath);
  restartCount += 1;
}

function priorContext(thread: LifeThread) {
  return {
    summaryText: thread.summary,
    usedThreadIds: [thread.id],
    usedThreadTitles: [thread.title],
    usedThreadReasons: ['the synthetic commitment was explicitly selected'],
    threadSummaryLines: [
      `${thread.title}: ${thread.nextAction || thread.summary}`,
    ],
  };
}

function recordPrimary(
  id: number,
  pass: boolean,
  evidence: Record<string, unknown>,
): void {
  primary.push({
    id,
    name: PRIMARY_NAMES[id - 1],
    baseline: BASELINE[id - 1],
    status: pass ? 'PASS' : 'FAIL',
    evidence,
  });
}

function recordHeldOut(
  id: number,
  pass: boolean,
  evidence: Record<string, unknown>,
): void {
  heldOut.push({
    id,
    name: HELD_OUT_NAMES[id - 1],
    status: pass ? 'PASS' : 'FAIL',
    evidence,
  });
}

function recordInvariant(
  name: string,
  pass: boolean,
  evidence: Record<string, unknown>,
): void {
  invariants.push({ name, status: pass ? 'PASS' : 'FAIL', evidence });
}

function transitionCount(threadId: string): number {
  return listLifeThreadSignals(threadId, 100).filter(
    (signal) => signal.commitmentTransition,
  ).length;
}

function productionResidueCount(): number {
  const productionPath = path.resolve(process.cwd(), 'store/messages.db');
  if (!fs.existsSync(productionPath)) return 0;
  const reader = new Database(productionPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tableExists = (table: string): boolean =>
      Boolean(
        reader
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
          )
          .get(table),
      );
    const marker = `%${runId}%`;
    let total = 0;
    const count = (query: string, ...args: unknown[]): void => {
      total += Number(
        (reader.prepare(query).get(...args) as { count: number }).count,
      );
    };
    if (tableExists('life_threads')) {
      count(
        `SELECT COUNT(*) AS count FROM life_threads
         WHERE group_folder IN (?, ?) OR id LIKE ? OR title LIKE ? OR summary LIKE ?`,
        groupFolder,
        isolatedGroup,
        marker,
        marker,
        marker,
      );
    }
    if (tableExists('life_thread_signals')) {
      count(
        `SELECT COUNT(*) AS count FROM life_thread_signals
         WHERE group_folder IN (?, ?) OR id LIKE ? OR summary_text LIKE ? OR COALESCE(chat_jid, '') LIKE ?`,
        groupFolder,
        isolatedGroup,
        marker,
        marker,
        marker,
      );
    }
    if (tableExists('profile_subjects')) {
      count(
        `SELECT COUNT(*) AS count FROM profile_subjects
         WHERE group_folder IN (?, ?) OR id LIKE ? OR display_name LIKE ?`,
        groupFolder,
        isolatedGroup,
        marker,
        marker,
      );
    }
    if (tableExists('profile_facts')) {
      count(
        `SELECT COUNT(*) AS count FROM profile_facts
         WHERE group_folder IN (?, ?) OR id LIKE ? OR value_json LIKE ? OR source_summary LIKE ?`,
        groupFolder,
        isolatedGroup,
        marker,
        marker,
        marker,
      );
    }
    if (tableExists('messages')) {
      count(
        `SELECT COUNT(*) AS count FROM messages
         WHERE COALESCE(chat_jid, '') LIKE ? OR content LIKE ?`,
        marker,
        marker,
      );
    }
    if (tableExists('scheduled_tasks')) {
      count(
        `SELECT COUNT(*) AS count FROM scheduled_tasks
         WHERE group_folder IN (?, ?) OR COALESCE(chat_jid, '') LIKE ? OR prompt LIKE ?`,
        groupFolder,
        isolatedGroup,
        marker,
        marker,
      );
    }
    return total;
  } finally {
    reader.close();
  }
}

function proveHermeticParent(): void {
  if (process.env.ANDREA_COMMITMENT_CERT_HERMETIC_PARENT !== '1') {
    throw new Error(
      'Commitment certification must be launched through its hermetic parent.',
    );
  }
  if (
    process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE !== '1' ||
    process.env.ANDREA_EVALUATION_ORIGIN !== 'synthetic'
  ) {
    throw new Error(
      'Commitment certification provider fallback suppression is inactive.',
    );
  }
  if (process.env.ANDREA_DETERMINISTIC_STORAGE_MODE !== undefined) {
    throw new Error(
      'Commitment certification must own its disposable durable storage path.',
    );
  }
  const resanitized = buildHermeticTestEnv(process.env, {
    isolateStorage: false,
  });
  const unsafeKeys = Object.keys(process.env).filter(
    (key) => resanitized[key] === undefined,
  );
  if (unsafeKeys.length > 0) {
    throw new Error(
      `Commitment certification inherited unsafe environment keys: ${unsafeKeys.sort().join(', ')}`,
    );
  }
  hermeticParentProof = true;
}

async function proveNetworkGuard(): Promise<void> {
  if (process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE !== '1') {
    throw new Error(
      'Commitment certification requires the deterministic network guard preload.',
    );
  }
  try {
    await fetch('https://commitment-certification.invalid/forbidden');
  } catch (error) {
    networkGuardProof =
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        'ANDREA_DETERMINISTIC_NETWORK_DENIED';
  }
  if (!networkGuardProof) {
    throw new Error(
      'External network denial was not proven before certification.',
    );
  }
}

async function runCertification(): Promise<void> {
  proveHermeticParent();
  await proveNetworkGuard();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  persistManifest();
  _initTestDatabaseAtPath(databasePath);
  isolatedInitialized = true;
  seedIdentity();

  const speculative = seedCommitment({
    title: 'Pottery possibility',
    text: 'I might take a pottery class Friday.',
  });
  const speculativeState = state(speculative);
  recordPrimary(
    1,
    speculativeState.strength === 'speculative' &&
      speculativeState.operationalState === 'proposed' &&
      speculativeState.readiness === 'non_actionable' &&
      !shouldProactivelySurfaceCommitment(speculative, tick(0)),
    {
      strength: speculativeState.strength,
      state: speculativeState.operationalState,
      readiness: speculativeState.readiness,
      proactive: shouldProactivelySurfaceCommitment(speculative, tick(0)),
    },
  );

  const tentative = seedCommitment({
    title: 'Tentative report',
    text: 'I am planning to draft the report Friday.',
  });
  const tentativeState = state(tentative);
  recordPrimary(
    2,
    tentativeState.strength === 'tentative' &&
      tentativeState.operationalState === 'proposed' &&
      tentativeState.currentAction === null &&
      !shouldProactivelySurfaceCommitment(tentative, tick(0)),
    {
      strength: tentativeState.strength,
      state: tentativeState.operationalState,
      currentAction: tentativeState.currentAction,
    },
  );

  const committed = seedCommitment({
    title: 'Committed filing',
    text: "I'll submit the permit Friday.",
  });
  const committedState = state(committed);
  recordPrimary(
    3,
    committedState.strength === 'committed' &&
      committedState.owner.kind === 'self' &&
      committedState.operationalState === 'active' &&
      Boolean(committedState.currentAction),
    {
      strength: committedState.strength,
      owner: committedState.owner,
      state: committedState.operationalState,
      action: committedState.currentAction,
    },
  );

  const reminder = seedCommitment({
    title: 'Reminder filing',
    text: 'Remind me Friday to submit the licensing form.',
    explicitRequest: true,
  });
  const reminderState = state(reminder);
  const reminderProvenance = reminderState.evidence.find(
    (item) =>
      item.kind === 'state_transition' &&
      item.sourceRef?.startsWith('commitment-source:'),
  );
  recordPrimary(
    4,
    reminderState.strength === 'explicitly_requested' &&
      reminderState.owner.kind === 'andrea' &&
      reminder.followthroughMode === 'scheduled' &&
      Boolean(reminderState.dueAt) &&
      Boolean(reminderProvenance) &&
      !reminderProvenance?.sourceRef?.includes(runId),
    {
      strength: reminderState.strength,
      owner: reminderState.owner,
      dueAt: reminderState.dueAt,
      followthroughMode: reminder.followthroughMode,
      provenance: reminderProvenance || null,
    },
  );

  let waiting = seedCommitment({
    title: 'Brandon estimate',
    text: "I'll send Brandon the estimate today.",
  });
  waiting = transition({
    thread: waiting,
    text: 'I sent Brandon the estimate and I am waiting for his response. Once he replies, I need to review the approved estimate. If I do not hear back by Friday, I need to follow up.',
  }).thread;
  const waitingState = state(waiting);
  recordPrimary(
    5,
    waitingState.operationalState === 'waiting' &&
      waitingState.owner.kind === 'subject' &&
      waitingState.owner.displayNames.includes('Brandon') &&
      waitingState.dependencies.length === 1 &&
      normalizedAction(waitingState.downstreamAction) ===
        'review the approved estimate' &&
      waitingState.dueAt === null &&
      Boolean(waitingState.followUp?.dueAt),
    {
      state: waitingState.operationalState,
      owner: waitingState.owner,
      dependencies: waitingState.dependencies,
      downstreamAction: waitingState.downstreamAction,
      dueAt: waitingState.dueAt,
      followUp: waitingState.followUp,
    },
  );
  recordPrimary(
    6,
    waitingState.currentAction === null &&
      waiting.nextAction === null &&
      normalizedAction(waitingState.downstreamAction) ===
        'review the approved estimate' &&
      !/\b(?:send|sent)\b.*\bestimate\b/i.test(
        waitingState.downstreamAction || '',
      ) &&
      !shouldProactivelySurfaceCommitment(waiting, tick(0)) &&
      !String(waiting.nextAction || '')
        .toLowerCase()
        .includes('send'),
    {
      canonicalAction: waitingState.currentAction,
      projectedAction: waiting.nextAction,
      proactive: shouldProactivelySurfaceCommitment(waiting, tick(0)),
    },
  );

  restart();
  waiting = transition({
    thread: current(waiting.id),
    text: 'Brandon replied with the approved estimate.',
  }).thread;
  const reactivatedWaiting = state(waiting);
  recordPrimary(
    7,
    reactivatedWaiting.operationalState === 'active' &&
      reactivatedWaiting.owner.kind === 'self' &&
      reactivatedWaiting.readiness === 'actionable_now' &&
      normalizedAction(reactivatedWaiting.currentAction) ===
        'review the approved estimate' &&
      !/\b(?:send|sent)\b.*\bestimate\b/i.test(
        reactivatedWaiting.currentAction || '',
      ) &&
      reactivatedWaiting.dueAt === null &&
      reactivatedWaiting.followUp === null &&
      reactivatedWaiting.dependencies.every(
        (dependency) => dependency.satisfied,
      ),
    {
      state: reactivatedWaiting.operationalState,
      owner: reactivatedWaiting.owner,
      action: reactivatedWaiting.currentAction,
      dueAt: reactivatedWaiting.dueAt,
      followUp: reactivatedWaiting.followUp,
      dependencies: reactivatedWaiting.dependencies,
      restartCount,
    },
  );

  let blocked = seedCommitment({
    title: 'Deck numbers',
    text: "I'll finish the deck today.",
  });
  blocked = transition({
    thread: blocked,
    text: "I can't finish the deck until Luke sends the numbers.",
  }).thread;
  const blockedState = state(blocked);
  recordPrimary(
    8,
    blockedState.operationalState === 'blocked' &&
      blockedState.readiness === 'blocked_known_dependency' &&
      blockedState.currentAction === null &&
      Boolean(blockedState.downstreamAction) &&
      !shouldProactivelySurfaceCommitment(blocked, tick(0)),
    {
      state: blockedState.operationalState,
      readiness: blockedState.readiness,
      currentAction: blockedState.currentAction,
      downstreamAction: blockedState.downstreamAction,
    },
  );
  restart();
  blocked = transition({
    thread: current(blocked.id),
    text: 'Luke sent the numbers.',
  }).thread;
  const unblockedState = state(blocked);
  recordPrimary(
    9,
    unblockedState.operationalState === 'active' &&
      unblockedState.owner.kind === 'self' &&
      unblockedState.readiness === 'actionable_now' &&
      normalizedAction(unblockedState.currentAction) === 'finish the deck' &&
      unblockedState.dependencies.every((dependency) => dependency.satisfied),
    {
      state: unblockedState.operationalState,
      owner: unblockedState.owner,
      action: unblockedState.currentAction,
      dependencies: unblockedState.dependencies,
      restartCount,
    },
  );

  let delegated = seedCommitment({
    title: 'Farmers follow-up',
    text: "I'll handle the Farmers follow-up today.",
  });
  delegated = transition({
    thread: delegated,
    text: 'Brandon is taking care of Farmers today.',
  }).thread;
  const delegatedState = state(delegated);
  recordPrimary(
    10,
    delegatedState.operationalState === 'delegated' &&
      delegatedState.owner.kind === 'subject' &&
      delegatedState.owner.displayNames.includes('Brandon') &&
      delegatedState.currentAction === null,
    {
      state: delegatedState.operationalState,
      owner: delegatedState.owner,
      downstreamAction: delegatedState.downstreamAction,
    },
  );
  recordPrimary(
    11,
    delegated.status === 'active' &&
      delegatedState.operationalState === 'delegated' &&
      delegatedState.readiness === 'waiting_on_person' &&
      !shouldProactivelySurfaceCommitment(delegated, tick(0)),
    {
      legacyStatus: delegated.status,
      canonicalState: delegatedState.operationalState,
      readiness: delegatedState.readiness,
      proactive: shouldProactivelySurfaceCommitment(delegated, tick(0)),
    },
  );
  restart();
  delegated = transition({
    thread: current(delegated.id),
    text: "Actually, I'll handle it myself.",
  }).thread;
  const returnedState = state(delegated);
  recordPrimary(
    12,
    returnedState.operationalState === 'active' &&
      returnedState.owner.kind === 'self' &&
      returnedState.readiness === 'actionable_now' &&
      normalizedAction(returnedState.currentAction) ===
        'take care of farmers today',
    {
      state: returnedState.operationalState,
      owner: returnedState.owner,
      action: returnedState.currentAction,
      restartCount,
    },
  );

  let deferred = seedCommitment({
    title: 'Vendor review',
    text: "I'll review the vendor contract this month.",
  });
  deferred = transition({
    thread: deferred,
    text: "Let's revisit this in August.",
  }).thread;
  const deferredState = state(deferred);
  const beforeDeferral = new Date('2026-07-31T12:00:00-05:00');
  recordPrimary(
    13,
    deferredState.operationalState === 'deferred' &&
      deferred.status === 'paused' &&
      Boolean(deferredState.reactivateAt) &&
      !shouldProactivelySurfaceCommitment(deferred, beforeDeferral),
    {
      state: deferredState.operationalState,
      legacyStatus: deferred.status,
      reactivateAt: deferredState.reactivateAt,
      proactiveBefore: shouldProactivelySurfaceCommitment(
        deferred,
        beforeDeferral,
      ),
    },
  );
  restart();
  const deferredMaturity = new Date('2026-08-01T09:01:00-05:00');
  const matured = buildMatureDeferredCommitment({
    thread: current(deferred.id),
    now: deferredMaturity,
    sourceKind: 'daily_companion',
  });
  if (!matured) throw new Error('Deferred commitment did not mature on time.');
  deferred = applyPrepared({
    thread: current(deferred.id),
    state: matured.state,
    transition: matured.transition,
    text: 'The deterministic deferral horizon elapsed.',
    signal: {
      id: matured.eventId,
      threadId: deferred.id,
      groupFolder,
      sourceKind: 'daily_companion',
      summaryText: 'The deterministic deferral horizon elapsed.',
      chatJid: `synthetic:${runId}`,
      confidenceKind: matured.state.confidenceKind,
      commitmentTransition: matured.transition,
      createdAt: matured.state.updatedAt,
    },
  }).thread;
  const maturedState = state(deferred);
  recordPrimary(
    14,
    maturedState.operationalState === 'active' &&
      maturedState.readiness === 'actionable_now' &&
      normalizedAction(maturedState.currentAction) ===
        'review the vendor contract this month' &&
      maturedState.reactivateAt === null &&
      maturedState.reactivateCondition === null &&
      maturedState.deferredFrom === null,
    {
      state: maturedState.operationalState,
      readiness: maturedState.readiness,
      action: maturedState.currentAction,
      reactivateAt: maturedState.reactivateAt,
      reactivateCondition: maturedState.reactivateCondition,
      deferredFrom: maturedState.deferredFrom,
      restartCount,
    },
  );

  let strengthened = transition({
    thread: tentative,
    text: "Actually, yes, I'm going to do it.",
  }).thread;
  const strengthenedState = state(strengthened);
  recordPrimary(
    15,
    strengthenedState.strength === 'committed' &&
      strengthenedState.operationalState === 'active' &&
      strengthenedState.owner.kind === 'self' &&
      normalizedAction(strengthenedState.currentAction) ===
        'draft the report friday' &&
      !/\b(?:planning|tentative|might|maybe)\b/i.test(
        strengthenedState.currentAction || '',
      ) &&
      strengthenedState.dueAt === tentativeState.dueAt,
    {
      strength: strengthenedState.strength,
      state: strengthenedState.operationalState,
      action: strengthenedState.currentAction,
      dueAt: strengthenedState.dueAt,
    },
  );

  let weakened = seedCommitment({
    title: 'Workshop commitment',
    text: "I'll organize the workshop Friday.",
  });
  weakened = transition({
    thread: weakened,
    text: "That's only an idea. Don't treat that as a task.",
  }).thread;
  const weakenedState = state(weakened);
  recordPrimary(
    16,
    weakenedState.strength === 'speculative' &&
      weakenedState.operationalState === 'proposed' &&
      weakenedState.readiness === 'non_actionable' &&
      weakenedState.currentAction === null,
    {
      strength: weakenedState.strength,
      state: weakenedState.operationalState,
      readiness: weakenedState.readiness,
    },
  );

  let completed = seedCommitment({
    title: 'Expense report',
    text: "I'll submit the expense report today.",
  });
  completed = transition({
    thread: completed,
    text: 'I completed the expense report.',
  }).thread;
  const completedState = state(completed);
  recordPrimary(
    17,
    completedState.operationalState === 'completed' &&
      completedState.currentAction === null &&
      completedState.dueAt === null &&
      completedState.followUp === null &&
      completed.status === 'closed' &&
      completed.followthroughMode === 'off' &&
      !shouldProactivelySurfaceCommitment(completed, tick(0)),
    {
      state: completedState.operationalState,
      legacyStatus: completed.status,
      followthroughMode: completed.followthroughMode,
      transitionCount: transitionCount(completed.id),
    },
  );

  let cancelled = seedCommitment({
    title: 'Cabin booking',
    text: "I'll book the cabin Friday.",
  });
  cancelled = transition({
    thread: cancelled,
    text: 'We are not doing the cabin booking anymore. Never mind.',
  }).thread;
  const cancelledState = state(cancelled);
  recordPrimary(
    18,
    cancelledState.operationalState === 'cancelled' &&
      cancelledState.currentAction === null &&
      cancelledState.dueAt === null &&
      cancelledState.followUp === null &&
      cancelled.status === 'closed' &&
      cancelled.followthroughMode === 'off' &&
      !shouldProactivelySurfaceCommitment(cancelled, tick(0)),
    {
      state: cancelledState.operationalState,
      legacyStatus: cancelled.status,
      followthroughMode: cancelled.followthroughMode,
      transitionCount: transitionCount(cancelled.id),
    },
  );

  let corrected = seedCommitment({
    title: 'Northstar proposal',
    text: "I'll send the Northstar proposal by Thursday at 5:00 PM.",
  });
  const staleDeadline = state(corrected).dueAt;
  const correction = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    text: 'Actually, the Northstar deadline moved to Friday at noon. Thursday at five is no longer correct.',
    priorContext: priorContext(corrected),
    now: tick(),
  });
  corrected = current(corrected.id);
  const correctedState = state(corrected);
  const correctionSignal = listLifeThreadSignals(corrected.id, 10).find(
    (signal) =>
      signal.commitmentTransition?.toRevision === correctedState.revision,
  );
  recordPrimary(
    19,
    correction.handled &&
      correction.temporalResolution === 'applied' &&
      Boolean(correctedState.dueAt) &&
      correctedState.dueAt !== staleDeadline &&
      !/Thursday|five/i.test(corrected.nextAction || '') &&
      correctionSignal?.commitmentTransition?.disposition === 'applied' &&
      /corrected the active temporal truth/i.test(
        correctionSignal.commitmentTransition.reason,
      ) &&
      correctedState.evidence.some(
        (item) =>
          item.eventId === correctionSignal.id &&
          item.kind === 'state_transition' &&
          item.sourceRef?.startsWith('commitment-source:'),
      ),
    {
      resolution: correction.temporalResolution,
      supersededDeadline: staleDeadline,
      activeDeadline: correctedState.dueAt,
      nextAction: corrected.nextAction,
      revision: correctedState.revision,
      transition: correctionSignal?.commitmentTransition || null,
    },
  );

  restart();
  const recoveredStates = [
    current(speculative.id),
    current(committed.id),
    current(waiting.id),
    current(blocked.id),
    current(delegated.id),
    current(deferred.id),
    current(completed.id),
    current(cancelled.id),
    current(corrected.id),
  ].map((thread) => ({
    id: thread.id,
    state: state(thread).operationalState,
    strength: state(thread).strength,
    owner: state(thread).owner.kind,
    valid: isLifeThreadCommitmentState(state(thread)),
  }));
  recordPrimary(
    20,
    recoveredStates.every((item) => item.valid) &&
      state(current(speculative.id)).strength === 'speculative' &&
      state(current(waiting.id)).operationalState === 'active' &&
      state(current(completed.id)).operationalState === 'completed' &&
      state(current(cancelled.id)).operationalState === 'cancelled' &&
      state(current(corrected.id)).dueAt === correctedState.dueAt,
    { restartCount, recoveredStates },
  );

  const duplicateBase = seedCommitment({
    title: 'Duplicate ingestion',
    text: "I'll prepare the briefing Friday.",
  });
  const duplicatePrepared = prepareTransition({
    thread: duplicateBase,
    text: 'I completed the briefing.',
    sourceRef: `${runId}:duplicate-event`,
  });
  const duplicateFirst = applyPrepared(duplicatePrepared);
  const revisionAfterFirst = state(duplicateFirst.thread).revision;
  const signalsAfterFirst = transitionCount(duplicateBase.id);
  const duplicateSecond = applyPrepared(duplicatePrepared);
  recordPrimary(
    21,
    duplicateFirst.result === 'applied' &&
      duplicateSecond.result === 'duplicate' &&
      state(duplicateSecond.thread).revision === revisionAfterFirst &&
      transitionCount(duplicateBase.id) === signalsAfterFirst,
    {
      first: duplicateFirst.result,
      replay: duplicateSecond.result,
      revision: state(duplicateSecond.thread).revision,
      transitionCount: transitionCount(duplicateBase.id),
    },
  );

  const ambiguousEast = seedCommitment({
    title: 'Brandon renewal east',
    text: "I'll finish the Brandon renewal east paperwork.",
  });
  const ambiguousWest = seedCommitment({
    title: 'Brandon renewal west',
    text: "I'll finish the Brandon renewal west paperwork.",
  });
  const beforeAmbiguity = [ambiguousEast, ambiguousWest].map((thread) => ({
    id: thread.id,
    revision: state(thread).revision,
    owner: state(thread).owner.kind,
  }));
  const threadCountBeforeAmbiguity =
    listLifeThreadsForGroup(groupFolder).length;
  const ambiguity = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    text: 'Brandon is handling that.',
    now: tick(),
  });
  const afterAmbiguity = [ambiguousEast, ambiguousWest].map((thread) => ({
    id: thread.id,
    revision: state(current(thread.id)).revision,
    owner: state(current(thread.id)).owner.kind,
  }));
  const threadCountAfterAmbiguity = listLifeThreadsForGroup(groupFolder).length;
  recordPrimary(
    22,
    ambiguity.handled &&
      !ambiguity.referencedThread &&
      /which|cannot safely/i.test(ambiguity.responseText || '') &&
      threadCountAfterAmbiguity === threadCountBeforeAmbiguity &&
      JSON.stringify(beforeAmbiguity) === JSON.stringify(afterAmbiguity),
    {
      response: ambiguity.responseText,
      before: beforeAmbiguity,
      after: afterAmbiguity,
      threadCountBefore: threadCountBeforeAmbiguity,
      threadCountAfter: threadCountAfterAmbiguity,
    },
  );

  const lowConfidenceIdea = seedCommitment({
    title: 'Maybe someday idea',
    text: 'I might get around to this today.',
  });
  const actionablePriority = seedCommitment({
    title: 'Current explicit filing',
    text: 'Remind me today to file the signed permit.',
    explicitRequest: true,
  });
  const blockedUrgentBase = seedCommitment({
    title: 'Blocked urgent deck',
    text: "I'll finish the urgent deck today.",
  });
  const blockedUrgent = transition({
    thread: blockedUrgentBase,
    text: "I can't finish the urgent deck until Luke sends the numbers.",
  }).thread;
  restart();
  const ranked = [
    current(lowConfidenceIdea.id),
    current(blockedUrgent.id),
    current(actionablePriority.id),
  ].sort((left, right) =>
    compareLifeThreadCommitmentPriority(left, right, tick(0)),
  );
  const snapshot = buildLifeThreadSnapshot({
    groupFolder,
    now: tick(0),
  });
  recordPrimary(
    23,
    ranked[0]?.id === actionablePriority.id &&
      snapshot.recommendedNextThread?.id === actionablePriority.id &&
      !snapshot.dueFollowups.some((thread) => thread.id === blockedUrgent.id) &&
      !snapshot.dueFollowups.some(
        (thread) => thread.id === lowConfidenceIdea.id,
      ),
    {
      deterministicOrder: ranked.map((thread) => thread.title),
      recommended: snapshot.recommendedNextThread?.title || null,
      dueFollowups: snapshot.dueFollowups.map((thread) => thread.title),
      rankingAfterDurableRestart: true,
      restartCount,
    },
  );

  const privateThread = seedCommitment({
    title: `Private ${runId}`,
    text: "I'll review the private verification phrase today.",
    surfaceMode: 'manual_only',
  });
  updateLifeThread(privateThread.id, {
    surfaceMode: 'manual_only',
    followthroughMode: 'manual_only',
  });
  const privateCommitment = state(current(privateThread.id));
  const isolatedSnapshot = buildLifeThreadSnapshot({
    groupFolder: isolatedGroup,
    now: tick(0),
  });
  const relevantSnapshot = buildLifeThreadSnapshot({
    groupFolder,
    now: tick(0),
  });
  recordPrimary(
    24,
    isolatedSnapshot.activeThreads.length === 0 &&
      !relevantSnapshot.activeThreads.some(
        (thread) => thread.id === privateThread.id,
      ) &&
      !relevantSnapshot.dueFollowups.some(
        (thread) => thread.id === privateThread.id,
      ) &&
      !relevantSnapshot.slippingThreads.some(
        (thread) => thread.id === privateThread.id,
      ) &&
      privateCommitment.evidence.every(
        (item) =>
          item.sourceRef?.startsWith('commitment-source:') === true &&
          !item.sourceRef.includes(runId),
      ),
    {
      isolatedGroupThreads: isolatedSnapshot.activeThreads.length,
      privateInActive: relevantSnapshot.activeThreads.some(
        (thread) => thread.id === privateThread.id,
      ),
      privateInDue: relevantSnapshot.dueFollowups.some(
        (thread) => thread.id === privateThread.id,
      ),
      hashedProvenanceOnly: privateCommitment.evidence.every(
        (item) => item.sourceRef?.startsWith('commitment-source:') === true,
      ),
    },
  );

  const mayWeekend = seedCommitment({
    title: 'Heldout weekend',
    text: 'I may get around to that this weekend.',
  });
  recordHeldOut(
    1,
    state(mayWeekend).strength === 'speculative' &&
      state(mayWeekend).readiness === 'non_actionable',
    { state: state(mayWeekend) },
  );

  const definiteSaturday = seedCommitment({
    title: 'Heldout Saturday',
    text: "I'm definitely doing it Saturday.",
  });
  recordHeldOut(
    2,
    state(definiteSaturday).strength === 'committed' &&
      state(definiteSaturday).operationalState === 'active' &&
      Boolean(state(definiteSaturday).dueAt),
    { state: state(definiteSaturday) },
  );

  const ballInCourt = seedCommitment({
    title: 'Heldout reply',
    text: 'I already sent it, so now the ball is in their court.',
  });
  const resolvedBallInCourt = transition({
    thread: ballInCourt,
    text: 'They replied.',
  }).thread;
  recordHeldOut(
    3,
    state(ballInCourt).operationalState === 'waiting' &&
      state(ballInCourt).currentAction === null &&
      state(ballInCourt).readiness === 'waiting_on_external_event' &&
      state(resolvedBallInCourt).operationalState === 'completed' &&
      state(resolvedBallInCourt).currentAction === null &&
      state(resolvedBallInCourt).downstreamAction === null &&
      resolvedBallInCourt.nextAction === null &&
      !/\b(?:send|sent)\b/i.test(resolvedBallInCourt.nextAction || ''),
    { before: state(ballInCourt), after: state(resolvedBallInCourt) },
  );

  const permitBlocked = seedCommitment({
    title: 'Heldout permit office',
    text: "I can't move forward until the permit office responds.",
  });
  recordHeldOut(
    4,
    state(permitBlocked).operationalState === 'blocked' &&
      state(permitBlocked).dependencies.length === 1 &&
      state(permitBlocked).currentAction === null,
    { state: state(permitBlocked) },
  );

  let chris = seedCommitment({
    title: 'Heldout handoff',
    text: "I'll complete the handoff.",
  });
  chris = transition({ thread: chris, text: 'Chris has this one.' }).thread;
  recordHeldOut(
    5,
    state(chris).operationalState === 'delegated' &&
      state(chris).owner.displayNames.includes('Chris'),
    { state: state(chris) },
  );
  chris = transition({
    thread: chris,
    text: 'Actually, I need to take it back over.',
  }).thread;
  recordHeldOut(
    6,
    state(chris).operationalState === 'active' &&
      state(chris).owner.kind === 'self' &&
      Boolean(state(chris).currentAction),
    { state: state(chris) },
  );

  let vacation = seedCommitment({
    title: 'Heldout vacation',
    text: "I'll review the policy.",
  });
  vacation = transition({
    thread: vacation,
    text: 'Shelve that until after vacation.',
  }).thread;
  recordHeldOut(
    7,
    state(vacation).operationalState === 'deferred' &&
      state(vacation).reactivateCondition?.includes('vacation') === true &&
      vacation.status === 'paused',
    { state: state(vacation), legacyStatus: vacation.status },
  );

  let businessDays = seedCommitment({
    title: 'Heldout business-day reply',
    text: "I'll email the vendor today.",
  });
  businessDays = transition({
    thread: businessDays,
    text: "I sent it. If they haven't replied in five business days, ping me.",
  }).thread;
  recordHeldOut(
    8,
    state(businessDays).operationalState === 'waiting' &&
      state(businessDays).followUp?.dueAt === '2026-07-21T14:00:00.000Z',
    { followUp: state(businessDays).followUp },
  );

  let onlyThinking = seedCommitment({
    title: 'Heldout weak idea',
    text: "I'll explore the new project.",
  });
  onlyThinking = transition({
    thread: onlyThinking,
    text: 'That was only something I was thinking about.',
  }).thread;
  recordHeldOut(
    9,
    state(onlyThinking).strength === 'speculative' &&
      state(onlyThinking).operationalState === 'proposed' &&
      state(onlyThinking).currentAction === null,
    { state: state(onlyThinking) },
  );

  let eitherResponse = seedCommitment({
    title: 'Heldout either response',
    text: "I'll finalize the totals.",
  });
  eitherResponse = transition({
    thread: eitherResponse,
    text: "I'm waiting on both Luke and Tracey, but either response is enough.",
  }).thread;
  const eitherBefore = state(eitherResponse);
  eitherResponse = transition({
    thread: eitherResponse,
    text: 'Luke replied with the totals.',
  }).thread;
  const eitherResolutionSignal = listLifeThreadSignals(
    eitherResponse.id,
    10,
  ).find((signal) => signal.id === state(eitherResponse).lastTransitionId);
  recordHeldOut(
    10,
    eitherBefore.dependencies.length === 2 &&
      eitherBefore.dependencyResolution === 'any' &&
      state(eitherResponse).operationalState === 'completed' &&
      state(eitherResponse).currentAction === null &&
      state(eitherResponse).downstreamAction === null &&
      state(eitherResponse).dependencies.length === 0 &&
      eitherResolutionSignal?.commitmentTransition?.disposition === 'applied' &&
      eitherResolutionSignal.commitmentTransition.fromState === 'waiting' &&
      eitherResolutionSignal.commitmentTransition.toState === 'completed',
    {
      before: eitherBefore,
      after: state(eitherResponse),
      resolutionTransition:
        eitherResolutionSignal?.commitmentTransition || null,
    },
  );

  recordHeldOut(
    11,
    ambiguity.handled &&
      !ambiguity.referencedThread &&
      threadCountAfterAmbiguity === threadCountBeforeAmbiguity &&
      JSON.stringify(beforeAmbiguity) === JSON.stringify(afterAmbiguity),
    {
      response: ambiguity.responseText,
      before: beforeAmbiguity,
      after: afterAmbiguity,
      threadCountBefore: threadCountBeforeAmbiguity,
      threadCountAfter: threadCountAfterAmbiguity,
    },
  );

  let combined = seedCommitment({
    title: 'Heldout combined transition',
    text: "I'll email the application.",
  });
  combined = transition({
    thread: combined,
    text: 'I emailed the application today and I am waiting for approval. Once it is approved, I need to archive the approval. If I do not hear back by Friday, I need to follow up.',
  }).thread;
  const combinedWaiting = state(combined);
  const combinedResolved = transition({
    thread: combined,
    text: 'It was approved.',
  }).thread;
  recordHeldOut(
    12,
    combinedWaiting.operationalState === 'waiting' &&
      combinedWaiting.currentAction === null &&
      normalizedAction(combinedWaiting.downstreamAction) ===
        'archive the approval' &&
      !/\b(?:email|emailed)\b.*\bapplication\b/i.test(
        combinedWaiting.downstreamAction || '',
      ) &&
      Boolean(combinedWaiting.followUp?.dueAt) &&
      state(combinedResolved).operationalState === 'active' &&
      normalizedAction(state(combinedResolved).currentAction) ===
        'archive the approval' &&
      state(combinedResolved).followUp === null &&
      !/\b(?:email|emailed)\b.*\bapplication\b/i.test(
        state(combinedResolved).currentAction || '',
      ),
    { before: combinedWaiting, after: state(combinedResolved) },
  );

  let restartLane = seedCommitment({
    title: 'Heldout restart lane',
    text: "I'll finish the restart proof.",
  });
  const restartLaneObservations: Array<{
    expected: string;
    actual: string;
    revision: number;
  }> = [];
  const recoverRestartLane = (expected: string): void => {
    restart();
    restartLane = current(restartLane.id);
    const recovered = state(restartLane);
    restartLaneObservations.push({
      expected,
      actual: recovered.operationalState,
      revision: recovered.revision,
    });
    if (recovered.operationalState !== expected) {
      throw new Error(
        `Restart lane expected ${expected} but recovered ${recovered.operationalState}.`,
      );
    }
  };
  recoverRestartLane('active');
  restartLane = transition({
    thread: restartLane,
    text: 'I sent Luke the proof and I am waiting for his response. Once he replies, I need to verify the proof.',
  }).thread;
  recoverRestartLane('waiting');
  restartLane = transition({
    thread: restartLane,
    text: 'Luke replied with the proof.',
  }).thread;
  recoverRestartLane('active');
  restartLane = transition({
    thread: restartLane,
    text: "I can't verify the proof until Tracey sends approval.",
  }).thread;
  recoverRestartLane('blocked');
  restartLane = transition({
    thread: restartLane,
    text: 'Tracey sent the approval.',
  }).thread;
  recoverRestartLane('active');
  restartLane = transition({
    thread: restartLane,
    text: 'Chris has this one.',
  }).thread;
  recoverRestartLane('delegated');
  restartLane = transition({
    thread: restartLane,
    text: 'Actually, I need to take it back over.',
  }).thread;
  recoverRestartLane('active');
  restartLane = transition({
    thread: restartLane,
    text: 'Not now. Shelve that until after vacation.',
  }).thread;
  recoverRestartLane('deferred');
  restartLane = transition({
    thread: restartLane,
    text: "Actually, yes, I'm going to do it.",
  }).thread;
  recoverRestartLane('active');
  const resumedRestartLaneAction = normalizedAction(
    state(restartLane).currentAction,
  );
  if (resumedRestartLaneAction !== 'verify the proof') {
    throw new Error(
      `Deferred restart lane recovered the wrong action: ${resumedRestartLaneAction || 'none'}.`,
    );
  }
  restartLane = transition({
    thread: restartLane,
    text: 'I completed the restart proof.',
  }).thread;
  recoverRestartLane('completed');
  recordHeldOut(
    13,
    restartCount >= 13 &&
      restartLaneObservations.length === 10 &&
      restartLaneObservations.every(
        (observation) => observation.actual === observation.expected,
      ) &&
      resumedRestartLaneAction === 'verify the proof' &&
      state(current(restartLane.id)).operationalState === 'completed' &&
      transitionCount(restartLane.id) === 10 &&
      isLifeThreadCommitmentState(state(current(restartLane.id))),
    {
      restartCount,
      restartLaneObservations,
      resumedRestartLaneAction,
      finalState: state(current(restartLane.id)),
      transitionCount: transitionCount(restartLane.id),
    },
  );

  recordHeldOut(
    14,
    duplicateFirst.result === 'applied' &&
      duplicateSecond.result === 'duplicate' &&
      transitionCount(duplicateBase.id) === signalsAfterFirst,
    {
      first: duplicateFirst.result,
      replay: duplicateSecond.result,
      transitionCount: transitionCount(duplicateBase.id),
    },
  );

  const staleBase = seedCommitment({
    title: 'Heldout stale replay',
    text: "I'll prepare the stale replay proof.",
  });
  const older = prepareTransition({
    thread: staleBase,
    text: 'Chris has this one.',
    now: new Date('2026-07-14T10:00:00-05:00'),
    sourceRef: `${runId}:older-delegation`,
  });
  const newer = prepareTransition({
    thread: staleBase,
    text: 'I completed the stale replay proof.',
    now: new Date('2026-07-14T11:00:00-05:00'),
    sourceRef: `${runId}:newer-completion`,
  });
  const newerResult = applyPrepared(newer);
  const newerRevision = state(newerResult.thread).revision;
  restart();
  const staleResult = applyPrepared(older);
  const staleSignal = listLifeThreadSignals(staleBase.id, 100).find(
    (signal) => signal.id === older.signal.id,
  );
  recordHeldOut(
    15,
    newerResult.result === 'applied' &&
      staleResult.result === 'stale' &&
      state(staleResult.thread).revision === newerRevision &&
      state(staleResult.thread).operationalState === 'completed' &&
      staleSignal?.commitmentTransition?.disposition === 'stale',
    {
      newer: newerResult.result,
      outOfOrder: staleResult.result,
      revisionAfterNewer: newerRevision,
      revisionAfterStaleReplay: state(staleResult.thread).revision,
      finalState: state(staleResult.thread).operationalState,
      recordedDisposition:
        staleSignal?.commitmentTransition?.disposition || null,
    },
  );

  const handlerReplayBase = seedCommitment({
    title: 'Handler replay boundary',
    text: 'I am planning to prepare the handler replay brief.',
  });
  const handlerReplayText = "Actually, yes, I'm going to do it.";
  const handlerStableSource = `${runId}:handler-stable-source`;
  const handlerRevisionBefore = state(handlerReplayBase).revision;
  const handlerSignalsBefore = transitionCount(handlerReplayBase.id);
  const handlerFirst = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    text: handlerReplayText,
    sourceRef: handlerStableSource,
    priorContext: priorContext(handlerReplayBase),
    now: tick(),
  });
  const handlerAfterFirst = current(handlerReplayBase.id);
  const handlerFirstRevision = state(handlerAfterFirst).revision;
  const handlerFirstSignals = transitionCount(handlerReplayBase.id);
  restart();
  const handlerAfterFirstRestart = current(handlerReplayBase.id);
  const handlerReplay = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    text: handlerReplayText,
    sourceRef: handlerStableSource,
    priorContext: priorContext(handlerAfterFirstRestart),
    now: tick(60),
  });
  const handlerAfterReplay = current(handlerReplayBase.id);
  const handlerReplayEvidenceRefs = new Set(
    state(handlerAfterReplay)
      .evidence.map((item) => item.sourceRef)
      .filter((value): value is string => Boolean(value)),
  );
  recordInvariant(
    'Stable source replay through production handler is idempotent',
    handlerFirst.handled &&
      handlerReplay.handled &&
      handlerFirstRevision === handlerRevisionBefore + 1 &&
      handlerFirstSignals === handlerSignalsBefore + 1 &&
      state(handlerAfterReplay).revision === handlerFirstRevision &&
      transitionCount(handlerReplayBase.id) === handlerFirstSignals &&
      handlerReplayEvidenceRefs.size ===
        state(handlerAfterFirst).evidence.filter((item) => item.sourceRef)
          .length &&
      /already recorded/i.test(handlerReplay.responseText || ''),
    {
      firstRevision: handlerFirstRevision,
      replayRevision: state(handlerAfterReplay).revision,
      firstSignalCount: handlerFirstSignals,
      replaySignalCount: transitionCount(handlerReplayBase.id),
      replayEvidenceRefs: [...handlerReplayEvidenceRefs],
      replayResponse: handlerReplay.responseText,
      replayAfterDurableRestart: true,
      restartCount,
    },
  );

  const handlerDistinctSource = `${runId}:handler-distinct-source`;
  const handlerDistinct = handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    text: handlerReplayText,
    sourceRef: handlerDistinctSource,
    priorContext: priorContext(handlerAfterReplay),
    now: tick(60),
  });
  const handlerAfterDistinct = current(handlerReplayBase.id);
  const retainedSourceRefs = new Set(
    state(handlerAfterDistinct)
      .evidence.map((item) => item.sourceRef)
      .filter((value): value is string => Boolean(value)),
  );
  const newlyRetainedSourceRefs = [...retainedSourceRefs].filter(
    (value) => !handlerReplayEvidenceRefs.has(value),
  );
  recordInvariant(
    'Same wording with different source identity remains distinct evidence',
    handlerDistinct.handled &&
      state(handlerAfterDistinct).revision === handlerFirstRevision + 1 &&
      transitionCount(handlerReplayBase.id) === handlerFirstSignals + 1 &&
      retainedSourceRefs.size === handlerReplayEvidenceRefs.size + 1 &&
      newlyRetainedSourceRefs.length === 1 &&
      [...retainedSourceRefs].every((value) =>
        value.startsWith('commitment-source:'),
      ) &&
      ![...retainedSourceRefs].some(
        (value) =>
          value.includes(handlerStableSource) ||
          value.includes(handlerDistinctSource),
      ),
    {
      revisionBeforeDistinct: handlerFirstRevision,
      revisionAfterDistinct: state(handlerAfterDistinct).revision,
      transitionCount: transitionCount(handlerReplayBase.id),
      retainedSourceRefs: [...retainedSourceRefs],
      newlyRetainedSourceRefs,
    },
  );

  const wrongGroupBase = seedCommitment({
    title: 'Wrong-group boundary',
    text: "I'll prepare the group-boundary proof.",
  });
  const wrongGroupPrepared = prepareTransition({
    thread: wrongGroupBase,
    text: 'I completed the group-boundary proof.',
    sourceRef: `${runId}:wrong-group`,
  });
  const wrongGroupRevision = state(wrongGroupBase).revision;
  const wrongGroupSignalCount = transitionCount(wrongGroupBase.id);
  const wrongGroupResult = applyLifeThreadCommitmentTransition({
    threadId: wrongGroupBase.id,
    groupFolder: isolatedGroup,
    state: wrongGroupPrepared.state,
    transition: wrongGroupPrepared.transition,
    signal: {
      ...wrongGroupPrepared.signal,
      groupFolder: isolatedGroup,
    },
    summary: wrongGroupPrepared.text,
    sourceKind: 'explicit',
    confidenceKind: wrongGroupPrepared.state.confidenceKind,
    userConfirmed: true,
  });
  recordInvariant(
    'Wrong-group transition helper refuses mutation',
    wrongGroupResult === 'missing' &&
      state(current(wrongGroupBase.id)).revision === wrongGroupRevision &&
      transitionCount(wrongGroupBase.id) === wrongGroupSignalCount,
    {
      result: wrongGroupResult,
      revisionBefore: wrongGroupRevision,
      revisionAfter: state(current(wrongGroupBase.id)).revision,
      transitionCountBefore: wrongGroupSignalCount,
      transitionCountAfter: transitionCount(wrongGroupBase.id),
    },
  );

  const allThreads = listLifeThreadsForGroup(groupFolder);
  finalStateSummary = {
    threadCount: allThreads.length,
    transitionCount: allThreads.reduce(
      (total, thread) => total + transitionCount(thread.id),
      0,
    ),
    restartCount,
    operationalStates: allThreads.reduce<Record<string, number>>(
      (counts, thread) => {
        const key = state(thread).operationalState;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      },
      {},
    ),
    canonicalStatesValid: allThreads.every((thread) =>
      isLifeThreadCommitmentState(state(thread)),
    ),
  };
}

function cleanup(): void {
  if (isolatedInitialized) {
    try {
      for (const threadId of threadIds) {
        deleteLifeThread(threadId);
      }
      isolatedResidue = listLifeThreadsForGroup(groupFolder).length;
      _closeDatabase();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
      try {
        _closeDatabase();
      } catch (closeError) {
        cleanupErrors.push(
          closeError instanceof Error ? closeError.message : String(closeError),
        );
      }
    }
  } else {
    try {
      _closeDatabase();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try {
    productionResidue = productionResidueCount();
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    for (const entry of manifest) entry.status = 'removed';
    persistManifest();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  const databaseArtifactsGone = ['', '-wal', '-shm'].every(
    (suffix) => !fs.existsSync(`${databasePath}${suffix}`),
  );
  try {
    fs.rmSync(manifestPath, { force: true });
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  cleanupVerified =
    isolatedInitialized &&
    isolatedResidue === 0 &&
    productionResidue === 0 &&
    databaseArtifactsGone &&
    !fs.existsSync(directory) &&
    !fs.existsSync(manifestPath) &&
    cleanupErrors.length === 0;
}

function report(): void {
  const primaryFailures = primary.filter((result) => result.status !== 'PASS');
  const heldOutFailures = heldOut.filter((result) => result.status !== 'PASS');
  const invariantFailures = invariants.filter(
    (result) => result.status !== 'PASS',
  );
  const baselineCounts = BASELINE.reduce<Record<string, number>>(
    (counts, status) => {
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    },
    {},
  );
  const completeMatrix =
    primary.length === PRIMARY_NAMES.length &&
    primary.every((result, index) => result.name === PRIMARY_NAMES[index]);
  const completeHeldOut =
    heldOut.length === HELD_OUT_NAMES.length &&
    heldOut.every((result, index) => result.name === HELD_OUT_NAMES[index]);
  const passed =
    !fatalError &&
    completeMatrix &&
    completeHeldOut &&
    primaryFailures.length === 0 &&
    heldOutFailures.length === 0 &&
    invariants.length === 3 &&
    invariantFailures.length === 0 &&
    restartCount === EXPECTED_RESTARTS &&
    networkGuardProof &&
    hermeticParentProof &&
    cleanupVerified;
  const evidence = {
    schemaVersion: 1,
    certification: 'Andrea Commitment Intelligence',
    mode: 'deterministic_offline',
    runId,
    referenceTime: REFERENCE.toISOString(),
    timeZone: TIME_ZONE,
    disposableDatabase: true,
    syntheticIdentitiesOnly: true,
    providerCalls: 0,
    externalWrites: 0,
    networkGuardProof,
    hermeticParentProof,
    baseline: {
      releaseSha: '0a71d4bcb4308d49ae057473356af03c0d0465fb',
      source: 'pre-change life-thread certification',
      knownScenarioCounts: baselineCounts,
      note: 'NOT_CERTIFIED means the earlier 10-case harness had no equivalent assertion.',
    },
    primary,
    heldOut,
    invariants,
    durability: {
      restartCount,
      expectedRestarts: EXPECTED_RESTARTS,
      passed: restartCount === EXPECTED_RESTARTS,
    },
    replay: {
      duplicateCovered: heldOut[13]?.status === 'PASS',
      outOfOrderCovered: heldOut[14]?.status === 'PASS',
    },
    finalStateSummary,
    cleanup: {
      manifestUsed: true,
      isolatedThreadResidue: isolatedResidue,
      productionResidue,
      databaseArtifactsRemoved: !fs.existsSync(directory),
      manifestRemoved: !fs.existsSync(manifestPath),
      errors: cleanupErrors,
      passed: cleanupVerified,
    },
    fatalError,
    summary: {
      primaryPassed: primary.length - primaryFailures.length,
      primaryTotal: PRIMARY_NAMES.length,
      heldOutPassed: heldOut.length - heldOutFailures.length,
      heldOutTotal: HELD_OUT_NAMES.length,
      invariantsPassed: invariants.length - invariantFailures.length,
      invariantsTotal: 3,
      passed,
    },
  };

  console.log('Andrea Commitment Intelligence certification');
  console.log(
    `Mode: deterministic/offline | network denied: ${networkGuardProof ? 'yes' : 'no'} | restarts: ${restartCount}`,
  );
  console.log('Before -> after scenario matrix:');
  for (const result of primary) {
    console.log(
      `${String(result.id).padStart(2, '0')}. ${result.name}: ${result.baseline} -> ${result.status}`,
    );
  }
  console.log('Held-out matrix:');
  for (const result of heldOut) {
    console.log(
      `${String(result.id).padStart(2, '0')}. ${result.name}: ${result.status}`,
    );
  }
  console.log('Boundary invariants:');
  for (const result of invariants)
    console.log(`${result.name}: ${result.status}`);
  console.log(
    `Cleanup: ${cleanupVerified ? 'PASS' : 'FAIL'} (isolated=${isolatedResidue}, production=${productionResidue})`,
  );
  if (fatalError) console.error(`Fatal certification error: ${fatalError}`);
  console.log(`COMMITMENT_CERTIFICATION_JSON=${JSON.stringify(evidence)}`);
  process.exitCode = passed ? 0 : 1;
}

async function main(): Promise<void> {
  try {
    await runCertification();
  } catch (error) {
    fatalError =
      error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    cleanup();
    report();
  }
}

await main();
