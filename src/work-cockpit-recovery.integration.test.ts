import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANDREA_OPENAI_BACKEND_ID } from './andrea-openai-backend.js';
import { AndreaOpenAiRuntimeError } from './andrea-openai-runtime.js';
import type {
  BackendGetJobParams,
  BackendJobDetails,
} from './backend-lanes/types.js';
import {
  getActiveCursorOperatorContext,
  getSelectedLaneJobId,
  rememberCursorJobList,
  rememberCursorOperatorSelection,
} from './cursor-operator-context.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getCursorOperatorContext,
  getRuntimeBackendChatSelection,
  getRuntimeBackendJob,
  upsertRuntimeBackendChatSelection,
  upsertRuntimeBackendJob,
} from './db.js';
import { getRuntimeWorkCockpitSelection } from './index.js';
import type { RuntimeBackendJobCacheRecord } from './types.js';
import { createWorkCockpitReadGuard } from './work-cockpit-targets.js';

const CHAT = 'tg:900000000001';
const GROUP = 'main';
const RUNTIME_JOB = 'runtime-fixture-selected';
const CURSOR_JOB = 'bc-fixture-current-cursor';

function runtimeJob(
  jobId = RUNTIME_JOB,
  status = 'running',
): BackendJobDetails {
  return {
    handle: { laneId: 'andrea_runtime', jobId },
    title: 'Offline recovery fixture',
    status,
    summary: 'Inspect the fixture only.',
    updatedAt: '2026-09-04T12:00:00.000Z',
    createdAt: '2026-09-04T11:00:00.000Z',
    laneLabel: 'Codex/OpenAI Runtime',
    metadata: { groupFolder: GROUP, selectedRuntime: 'codex_local' },
    capabilities: {
      canCreateJob: true,
      canFollowUp: true,
      canGetLogs: true,
      canStop: true,
      canRefresh: true,
      canViewOutput: true,
      canViewFiles: false,
      actionIds: ['job.refresh', 'job.output', 'job.followup', 'job.stop'],
    },
  };
}

function rememberLegacy(jobId = RUNTIME_JOB): void {
  upsertRuntimeBackendChatSelection({
    backend_id: ANDREA_OPENAI_BACKEND_ID,
    chat_jid: CHAT,
    job_id: jobId,
    group_folder: GROUP,
    updated_at: new Date().toISOString(),
  });
}

function rememberRuntime(jobId = RUNTIME_JOB, threadId?: string): void {
  rememberCursorOperatorSelection({
    chatJid: CHAT,
    threadId,
    laneId: 'andrea_runtime',
    agentId: jobId,
  });
}

function rememberCursor(threadId?: string): void {
  rememberCursorOperatorSelection({
    chatJid: CHAT,
    threadId,
    laneId: 'cursor',
    agentId: CURSOR_JOB,
  });
}

function pointers(threadId?: string) {
  return {
    shared: getCursorOperatorContext(CHAT, threadId),
    legacy: getRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, CHAT),
  };
}

function cachedRuntime(): RuntimeBackendJobCacheRecord {
  return {
    backend_id: ANDREA_OPENAI_BACKEND_ID,
    job_id: RUNTIME_JOB,
    group_folder: GROUP,
    chat_jid: CHAT,
    thread_id: null,
    status: 'running',
    selected_runtime: 'codex_local',
    prompt_preview: 'Synthetic private fixture prompt must not be published.',
    latest_output_text:
      'Synthetic private fixture output must not be published.',
    error_text: 'Synthetic private fixture diagnostics must not be published.',
    log_file: '/synthetic/private-fixture.log',
    created_at: '2026-09-04T11:00:00.000Z',
    updated_at: '2026-09-04T12:00:00.000Z',
    raw_json: JSON.stringify({ syntheticPrivateFixture: true }),
  };
}

function deferredJobRead() {
  let complete!: (job: BackendJobDetails | null) => void;
  const promise = new Promise<BackendJobDetails | null>((resolve) => {
    complete = resolve;
  });
  return {
    getJob: vi.fn((_params: BackendGetJobParams) => promise),
    complete: (job: BackendJobDetails | null) => complete(job),
  };
}

beforeEach(() => {
  _initTestDatabase();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('The current-work integration fixture must never use fetch.'),
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  _closeDatabase();
  vi.restoreAllMocks();
});

describe('read-only job-list snapshots preserve canonical selection', () => {
  function selectedPointers() {
    const context = getActiveCursorOperatorContext(CHAT);
    return {
      laneId: context?.selectedLaneId ?? null,
      agentId: context?.selectedAgentId ?? null,
      selectedJobsByLane: context?.selectedJobsByLane ?? null,
      legacy: getRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, CHAT),
    };
  }

  function refreshList(selectedAgentId: string | null) {
    rememberCursorJobList({
      chatJid: CHAT,
      listMessageId: 'fixture-refreshed-list-message',
      items: [{ laneId: 'andrea_runtime', id: 'runtime-fixture-listed' }],
      selectedLaneId: 'andrea_runtime',
      selectedAgentId,
      preserveSelection: true,
    });
    expect(getActiveCursorOperatorContext(CHAT)).toMatchObject({
      lastListMessageId: 'fixture-refreshed-list-message',
      lastListSnapshotsByLane: {
        andrea_runtime: [
          {
            laneId: 'andrea_runtime',
            id: 'runtime-fixture-listed',
            provider: null,
          },
        ],
      },
    });
  }

  it('updates a fresh list without clearing a temporarily unavailable selected task', async () => {
    rememberRuntime();
    rememberLegacy();
    const result = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi.fn().mockRejectedValue(new Error('Fixture read outage')),
    });
    expect(result.recovery.kind).toBe('unavailable');
    const before = selectedPointers();
    refreshList(null);
    expect(selectedPointers()).toEqual(before);
  });

  it('updates a fresh list without resurrecting a confirmed missing selection from an older response', async () => {
    rememberRuntime();
    rememberLegacy();
    await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi.fn().mockResolvedValue(null),
    });
    const cleared = selectedPointers();
    expect(cleared.agentId).toBeNull();
    refreshList(RUNTIME_JOB);
    expect(selectedPointers()).toEqual(cleared);
  });

  it('updates a runtime list without switching the explicit current Cursor lane', () => {
    rememberRuntime();
    rememberLegacy();
    rememberCursor();
    const before = selectedPointers();
    refreshList(RUNTIME_JOB);
    expect(selectedPointers()).toEqual(before);
    expect(getActiveCursorOperatorContext(CHAT)?.selectedLaneId).toBe('cursor');
  });

  it('keeps a newer operator selection when an older list finally renders', () => {
    rememberRuntime();
    rememberLegacy();
    const oldRenderedSelection = RUNTIME_JOB;
    rememberRuntime('runtime-fixture-newer');
    rememberLegacy('runtime-fixture-newer');
    const newer = selectedPointers();
    refreshList(oldRenderedSelection);
    expect(selectedPointers()).toEqual(newer);
  });

  it('records a first list without selecting a listed task implicitly', () => {
    refreshList('runtime-fixture-listed');
    expect(getActiveCursorOperatorContext(CHAT)?.selectedLaneId).toBeNull();
    expect(getSelectedLaneJobId(CHAT, undefined, 'andrea_runtime')).toBeNull();
    expect(
      getRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, CHAT),
    ).toBeUndefined();
  });
});

describe('current-work recovery through the actual index selection boundary', () => {
  it('keeps both pointers during an outage and retries only the same exact read', async () => {
    rememberRuntime();
    rememberLegacy();
    const before = pointers();
    const getJob = vi
      .fn<(params: BackendGetJobParams) => Promise<BackendJobDetails | null>>()
      .mockRejectedValueOnce(
        new AndreaOpenAiRuntimeError(
          'unavailable',
          'Fixture transport offline',
        ),
      )
      .mockResolvedValueOnce(runtimeJob());

    const unavailable = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob,
    });
    expect(unavailable).toMatchObject({
      selected: null,
      recovery: { kind: 'unavailable', selectedJobId: RUNTIME_JOB },
      superseded: false,
    });
    expect(pointers()).toEqual(before);

    const recovered = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob,
    });
    expect(recovered).toMatchObject({
      selected: runtimeJob(),
      recovery: { kind: 'available', selectedJobId: RUNTIME_JOB },
      superseded: false,
    });
    expect(pointers()).toEqual(before);
    expect(getJob.mock.calls).toEqual([
      [
        {
          handle: { laneId: 'andrea_runtime', jobId: RUNTIME_JOB },
          groupFolder: GROUP,
          chatJid: CHAT,
        },
      ],
      [
        {
          handle: { laneId: 'andrea_runtime', jobId: RUNTIME_JOB },
          groupFolder: GROUP,
          chatJid: CHAT,
        },
      ],
    ]);
  });

  it('reads the existing cache as stale metadata without turning it into a current task', async () => {
    rememberRuntime();
    rememberLegacy();
    const cached = cachedRuntime();
    upsertRuntimeBackendJob(cached);
    const before = pointers();
    const result = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi
        .fn()
        .mockRejectedValue(new Error('Fixture status read failed')),
    });

    expect(result.selected).toBeNull();
    expect(result.recovery).toMatchObject({
      kind: 'unavailable',
      selectedJobId: RUNTIME_JOB,
      cached: {
        jobId: RUNTIME_JOB,
        status: 'running',
        updatedAt: cached.updated_at,
        freshness: 'stale',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private.fixture|syntheticPrivateFixture/i,
    );
    expect(pointers()).toEqual(before);
    expect(getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, RUNTIME_JOB)).toEqual(
      cached,
    );
  });

  it('clears only a confirmed absent runtime task, without selecting Cursor automatically', async () => {
    rememberCursor();
    rememberRuntime();
    rememberLegacy();
    const result = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi.fn().mockResolvedValue(null),
    });

    expect(result).toMatchObject({
      selected: null,
      recovery: {
        kind: 'missing',
        reason: 'not-found',
        selectedJobId: RUNTIME_JOB,
      },
      superseded: false,
    });
    expect(getSelectedLaneJobId(CHAT, undefined, 'andrea_runtime')).toBeNull();
    expect(
      getRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, CHAT),
    ).toBeUndefined();
    expect(getSelectedLaneJobId(CHAT, undefined, 'cursor')).toBe(CURSOR_JOB);
    expect(getActiveCursorOperatorContext(CHAT)?.selectedLaneId).toBeNull();
  });

  it.each([
    'not_enabled',
    'not_ready',
    'bootstrap_required',
    'validation',
    'context_mismatch',
  ] as const)(
    'preserves selection when the exact read fails with %s',
    async (kind) => {
      rememberRuntime();
      rememberLegacy();
      const before = pointers();
      const result = await getRuntimeWorkCockpitSelection({
        chatJid: CHAT,
        groupFolder: GROUP,
        getJob: vi
          .fn()
          .mockRejectedValue(
            new AndreaOpenAiRuntimeError(kind, 'Fixture status error'),
          ),
      });
      expect(result.selected).toBeNull();
      expect(result.recovery.kind).toBe('unavailable');
      expect(pointers()).toEqual(before);
    },
  );

  it('does not treat a failed task as a missing task', async () => {
    rememberRuntime();
    rememberLegacy();
    const before = pointers();
    const result = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi.fn().mockResolvedValue(runtimeJob(RUNTIME_JOB, 'failed')),
    });
    expect(result.recovery.kind).toBe('available');
    expect(result.selected?.status).toBe('failed');
    expect(pointers()).toEqual(before);
  });

  it('retains the task when a response contains an unsupported status instead of treating it as absent', async () => {
    rememberRuntime();
    rememberLegacy();
    const before = pointers();
    const result = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi.fn().mockResolvedValue(runtimeJob(RUNTIME_JOB, 'error')),
    });
    expect(result.selected).toBeNull();
    expect(result.recovery).toMatchObject({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    expect(pointers()).toEqual(before);
  });

  it.each(['available', 'unavailable'] as const)(
    'does not replace explicit Cursor focus when a legacy runtime read is %s',
    async (outcome) => {
      rememberCursor();
      rememberLegacy();
      const before = pointers();
      const getJob =
        vi.fn<
          (params: BackendGetJobParams) => Promise<BackendJobDetails | null>
        >();
      if (outcome === 'available') getJob.mockResolvedValue(runtimeJob());
      else getJob.mockRejectedValue(new Error('Fixture runtime offline'));
      const result = await getRuntimeWorkCockpitSelection({
        chatJid: CHAT,
        groupFolder: GROUP,
        getJob,
      });
      expect(result.recovery.kind).toBe(outcome);
      expect(getActiveCursorOperatorContext(CHAT)).toMatchObject({
        selectedLaneId: 'cursor',
        selectedAgentId: CURSOR_JOB,
      });
      expect(
        getSelectedLaneJobId(CHAT, undefined, 'andrea_runtime'),
      ).toBeNull();
      expect(pointers()).toEqual(before);
    },
  );

  it('ignores a late not-found receipt after the operator selects a newer runtime task', async () => {
    rememberRuntime();
    rememberLegacy();
    const deferred = deferredJobRead();
    const pending = getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: deferred.getJob,
    });
    expect(deferred.getJob).toHaveBeenCalledOnce();
    rememberRuntime('runtime-fixture-newer');
    rememberLegacy('runtime-fixture-newer');
    const newerPointers = pointers();
    deferred.complete(null);

    expect(await pending).toMatchObject({ selected: null, superseded: true });
    expect(pointers()).toEqual(newerPointers);
  });

  it('ignores an older not-found receipt after a newer healthy read of the same selected task', async () => {
    rememberRuntime();
    rememberLegacy();
    const before = pointers();
    const guard = createWorkCockpitReadGuard();
    const key = `${CHAT}/fixture-current-work`;
    const older = deferredJobRead();
    const pending = getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: older.getJob,
      isCurrentRead: guard.begin(key),
    });
    expect(older.getJob).toHaveBeenCalledOnce();

    const recovered = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: vi.fn().mockResolvedValue(runtimeJob()),
      isCurrentRead: guard.begin(key),
    });
    expect(recovered).toMatchObject({
      selected: runtimeJob(),
      recovery: { kind: 'available', selectedJobId: RUNTIME_JOB },
      superseded: false,
    });
    expect(pointers()).toEqual(before);

    older.complete(null);
    expect(await pending).toMatchObject({
      selected: null,
      recovery: {
        kind: 'missing',
        selectedJobId: RUNTIME_JOB,
        reason: 'not-found',
      },
      superseded: true,
    });
    expect(pointers()).toEqual(before);
  });

  it('does not clear a newer legacy pointer when only the shared task is confirmed missing', async () => {
    rememberRuntime();
    rememberLegacy();
    const deferred = deferredJobRead();
    const pending = getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: deferred.getJob,
    });
    rememberLegacy('runtime-fixture-newer-legacy');
    deferred.complete(null);
    await pending;

    expect(getSelectedLaneJobId(CHAT, undefined, 'andrea_runtime')).toBeNull();
    expect(
      getRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, CHAT)?.job_id,
    ).toBe('runtime-fixture-newer-legacy');
  });

  it('does not clear or replace Cursor focus chosen while a runtime read was pending', async () => {
    rememberRuntime();
    rememberLegacy();
    const deferred = deferredJobRead();
    const pending = getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: deferred.getJob,
    });
    rememberCursor();
    const newerPointers = pointers();
    deferred.complete(null);

    expect(await pending).toMatchObject({ selected: null, superseded: true });
    expect(pointers()).toEqual(newerPointers);
    expect(getActiveCursorOperatorContext(CHAT)?.selectedAgentId).toBe(
      CURSOR_JOB,
    );
  });

  it('suppresses a late successful card after its selected task changed', async () => {
    rememberRuntime();
    const deferred = deferredJobRead();
    const pending = getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob: deferred.getJob,
    });
    rememberRuntime('runtime-fixture-newer');
    const newerPointers = pointers();
    deferred.complete(runtimeJob());

    expect(await pending).toMatchObject({ selected: null, superseded: true });
    expect(pointers()).toEqual(newerPointers);
  });

  it('keeps a different thread selection intact when this thread task is absent', async () => {
    rememberRuntime(RUNTIME_JOB, 'fixture-thread-one');
    rememberRuntime('runtime-fixture-other-thread', 'fixture-thread-two');
    const otherThread = pointers('fixture-thread-two');
    await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      threadId: 'fixture-thread-one',
      getJob: vi.fn().mockResolvedValue(null),
    });

    expect(
      getSelectedLaneJobId(CHAT, 'fixture-thread-one', 'andrea_runtime'),
    ).toBeNull();
    expect(pointers('fixture-thread-two')).toEqual(otherThread);
  });

  it('does not read, create, or pick a task when no runtime selection exists', async () => {
    rememberCursor();
    const before = pointers();
    const getJob = vi.fn();
    const getCachedJob = vi.fn();
    const result = await getRuntimeWorkCockpitSelection({
      chatJid: CHAT,
      groupFolder: GROUP,
      getJob,
      getCachedJob,
    });

    expect(result).toMatchObject({
      selected: null,
      recovery: {
        kind: 'missing',
        reason: 'not-selected',
        selectedJobId: null,
      },
      superseded: false,
    });
    expect(getJob).not.toHaveBeenCalled();
    expect(getCachedJob).not.toHaveBeenCalled();
    expect(pointers()).toEqual(before);
  });
});
