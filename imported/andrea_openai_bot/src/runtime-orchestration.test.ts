import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createRuntimeOrchestrationJob,
} from './db.js';
import {
  createRuntimeOrchestrationService,
  type RuntimeOrchestrationServiceDependencies,
} from './runtime-orchestration.js';
import type {
  AgentThreadState,
  RegisteredGroup,
  RuntimeOrchestrationJob,
} from './types.js';

interface TestHarness {
  service: ReturnType<typeof createRuntimeOrchestrationService>;
  queuedTasks: Map<string, () => Promise<void>>;
  runContainerAgent: ReturnType<typeof vi.fn>;
  persistAgentThread: ReturnType<typeof vi.fn>;
  requestStop: ReturnType<typeof vi.fn>;
  notifyIdle: ReturnType<typeof vi.fn>;
  runtimeJobs: Array<{
    groupJid: string;
    active: boolean;
    idleWaiting: boolean;
    isTaskContainer: boolean;
    runningTaskId: string | null;
    pendingMessages: boolean;
    pendingTaskCount: number;
    containerName: string | null;
    groupFolder: string | null;
    retryCount: number;
  }>;
  sessions: Record<string, string | undefined>;
  storedThreads: Record<string, AgentThreadState | undefined>;
}

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-03-30T00:00:00.000Z',
  isMain: true,
};

const otherGroup: RegisteredGroup = {
  name: 'Other',
  folder: 'other',
  trigger: '@Andrea',
  added_at: '2026-03-30T00:00:00.000Z',
};

function buildHarness(
  overrides: Partial<RuntimeOrchestrationServiceDependencies> = {},
): TestHarness {
  const queuedTasks = new Map<string, () => Promise<void>>();
  const sessions: Record<string, string | undefined> = {};
  const storedThreads: Record<string, AgentThreadState | undefined> = {};
  const runtimeJobs: TestHarness['runtimeJobs'] = [];
  const persistAgentThread = vi.fn(
    (
      groupFolder: string,
      threadId: string,
      runtime: RuntimeOrchestrationJob['selectedRuntime'],
    ) => {
      if (!runtime) {
        throw new Error('persistAgentThread requires a runtime in tests.');
      }
      sessions[groupFolder] = threadId;
      storedThreads[groupFolder] = {
        group_folder: groupFolder,
        runtime,
        thread_id: threadId,
        last_response_id: threadId,
        updated_at: '2026-03-30T00:00:00.000Z',
      };
    },
  );
  const runContainerAgent = vi.fn(async () => ({
    status: 'success' as const,
    result: null,
    newSessionId: 'thread-default',
    runtime: 'codex_local' as const,
  }));
  const requestStop = vi.fn(() => true);
  const notifyIdle = vi.fn();

  const deps: RuntimeOrchestrationServiceDependencies = {
    assistantName: 'Andrea',
    enqueueJob(groupJid, jobId, fn) {
      queuedTasks.set(jobId, fn);
    },
    getAvailableGroups() {
      return [];
    },
    getRegisteredGroupJids() {
      return new Set(['tg:main', 'tg:other']);
    },
    getRuntimeJobs() {
      return runtimeJobs;
    },
    getSession(groupFolder) {
      return sessions[groupFolder];
    },
    getStoredThread(groupFolder) {
      return storedThreads[groupFolder];
    },
    notifyIdle,
    persistAgentThread,
    refreshTaskSnapshots() {},
    registerProcess() {},
    requestStop,
    resolveGroupByFolder(folder) {
      if (folder === mainGroup.folder) {
        return { jid: 'tg:main', group: mainGroup };
      }
      if (folder === otherGroup.folder) {
        return { jid: 'tg:other', group: otherGroup };
      }
      return null;
    },
    runContainerAgent,
    writeGroupsSnapshot() {},
    ...overrides,
  };

  return {
    service: createRuntimeOrchestrationService(deps),
    queuedTasks,
    runContainerAgent,
    persistAgentThread,
    requestStop,
    notifyIdle,
    runtimeJobs,
    sessions,
    storedThreads,
  };
}

describe('runtime orchestration service', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useRealTimers();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('createJob creates a durable queued job record', async () => {
    const harness = buildHarness();

    const job = await harness.service.createJob({
      groupFolder: 'main',
      prompt: 'Please summarize the latest project state.',
      source: { system: 'nanoclaw', actorRef: 'tg:operator' },
    });

    expect(job.status).toBe('queued');
    expect(job.groupFolder).toBe('main');
    expect(job.sourceSystem).toBe('nanoclaw');
    expect(job.promptPreview).toContain('Please summarize');
    expect(harness.queuedTasks.has(job.jobId)).toBe(true);
    expect(harness.service.getJob(job.jobId)?.status).toBe('queued');
  });

  it('transitions a queued job through running to succeeded', async () => {
    let releaseRun: (() => void) | undefined;
    const runBlocked = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let markRunning: (() => void) | undefined;
    const runningPromise = new Promise<void>((resolve) => {
      markRunning = resolve;
    });

    const logFile = 'C:\\logs\\runtime-job.log';
    const harness = buildHarness({
      runContainerAgent: vi.fn(async (_group, input, _onProcess, onOutput) => {
        markRunning?.();
        await onOutput?.({
          status: 'success' as const,
          result: 'All done',
          newSessionId: 'thread-123',
          runtime: 'codex_local' as const,
          logFile,
        });
        await runBlocked;
        return {
          status: 'success' as const,
          result: null,
          newSessionId: 'thread-123',
          runtime: 'codex_local' as const,
          logFile,
        };
      }),
    });

    const job = await harness.service.createJob({
      groupFolder: 'main',
      prompt: 'Implement the refactor.',
      source: { system: 'nanoclaw' },
    });

    const runPromise = harness.queuedTasks.get(job.jobId)!();
    await runningPromise;

    expect(harness.service.getJob(job.jobId)?.status).toBe('running');

    releaseRun?.();
    await runPromise;

    const updated = harness.service.getJob(job.jobId);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.threadId).toBe('thread-123');
    expect(updated?.selectedRuntime).toBe('codex_local');
    expect(updated?.latestOutputText).toBe('All done');
    expect(updated?.finalOutputText).toBe('All done');
    expect(updated?.logFile).toBe(logFile);
    expect(harness.persistAgentThread).toHaveBeenCalledWith(
      'main',
      'thread-123',
      'codex_local',
    );
    expect(harness.notifyIdle).toHaveBeenCalledWith('tg:main');
  });

  it('records honest runtime failures including openai_cloud credential errors', async () => {
    const harness = buildHarness({
      runContainerAgent: vi.fn(async () => ({
        status: 'error' as const,
        result: null,
        runtime: 'openai_cloud' as const,
        error:
          'openai_cloud requires OPENAI_API_KEY or a compatible gateway token.',
        logFile: 'C:\\logs\\openai-failure.log',
      })),
    });

    const job = await harness.service.createJob({
      groupFolder: 'main',
      prompt: 'Give me a short cloud-only summary.',
      source: { system: 'nanoclaw' },
      routeHint: 'cloud_allowed',
      requestedRuntime: 'openai_cloud',
    });

    await harness.queuedTasks.get(job.jobId)!();

    const failed = harness.service.getJob(job.jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.selectedRuntime).toBe('openai_cloud');
    expect(failed?.errorText).toContain('OPENAI_API_KEY');
  });

  it('followUp(jobId) reuses the referenced thread when available', async () => {
    createRuntimeOrchestrationJob({
      jobId: 'job-parent',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-parent',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'Parent job',
      latestOutputText: 'done',
      finalOutputText: 'done',
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: 'tg:operator',
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:00.000Z',
      startedAt: '2026-03-30T00:00:01.000Z',
      finishedAt: '2026-03-30T00:00:02.000Z',
      updatedAt: '2026-03-30T00:00:02.000Z',
    });

    const harness = buildHarness({
      runContainerAgent: vi.fn(async (_group, input) => {
        expect(input.sessionId).toBe('thread-parent');
        return {
          status: 'success' as const,
          result: null,
          newSessionId: 'thread-parent',
          runtime: 'codex_local' as const,
        };
      }),
    });

    const job = await harness.service.followUp({
      jobId: 'job-parent',
      prompt: 'Keep going.',
      source: { system: 'nanoclaw' },
    });

    expect(job.parentJobId).toBe('job-parent');
    await harness.queuedTasks.get(job.jobId)!();
  });

  it('followUp(threadId) resolves correctly', async () => {
    createRuntimeOrchestrationJob({
      jobId: 'job-thread',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-xyz',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'Thread job',
      latestOutputText: 'done',
      finalOutputText: 'done',
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:00.000Z',
      startedAt: '2026-03-30T00:00:01.000Z',
      finishedAt: '2026-03-30T00:00:02.000Z',
      updatedAt: '2026-03-30T00:00:02.000Z',
    });

    const harness = buildHarness({
      runContainerAgent: vi.fn(async (_group, input) => {
        expect(input.sessionId).toBe('thread-xyz');
        return {
          status: 'success' as const,
          result: null,
          newSessionId: 'thread-xyz',
          runtime: 'codex_local' as const,
        };
      }),
    });

    const job = await harness.service.followUp({
      threadId: 'thread-xyz',
      prompt: 'Continue this thread.',
      source: { system: 'nanoclaw' },
    });

    await harness.queuedTasks.get(job.jobId)!();
  });

  it('followUp(groupFolder) uses the current stored thread when available', async () => {
    const harness = buildHarness({
      runContainerAgent: vi.fn(async (_group, input) => {
        expect(input.sessionId).toBe('thread-current');
        return {
          status: 'success' as const,
          result: null,
          newSessionId: 'thread-current',
          runtime: 'codex_local' as const,
        };
      }),
    });
    harness.storedThreads.main = {
      group_folder: 'main',
      runtime: 'codex_local',
      thread_id: 'thread-current',
      last_response_id: 'thread-current',
      updated_at: '2026-03-30T00:00:00.000Z',
    };
    harness.sessions.main = 'thread-current';

    const job = await harness.service.followUp({
      groupFolder: 'main',
      prompt: 'Use the active thread.',
      source: { system: 'nanoclaw' },
    });

    await harness.queuedTasks.get(job.jobId)!();
  });

  it('rejects invalid follow-up targets cleanly', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.followUp({
        threadId: 'missing-thread',
        prompt: 'Continue this.',
        source: { system: 'nanoclaw' },
      }),
    ).rejects.toThrow('No runtime thread found for "missing-thread".');
  });

  it('listJobs paginates and filters by group and thread', async () => {
    createRuntimeOrchestrationJob({
      jobId: 'job-1',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-a',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'one',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:01.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-03-30T00:00:01.000Z',
    });
    createRuntimeOrchestrationJob({
      jobId: 'job-2',
      kind: 'follow_up',
      status: 'running',
      stopRequested: false,
      groupFolder: 'other',
      groupJid: 'tg:other',
      parentJobId: null,
      threadId: 'thread-b',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'openai_cloud',
      promptPreview: 'two',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:02.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-03-30T00:00:02.000Z',
    });
    createRuntimeOrchestrationJob({
      jobId: 'job-3',
      kind: 'create',
      status: 'queued',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-a',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'three',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:03.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-03-30T00:00:03.000Z',
    });

    const harness = buildHarness();

    const firstPage = harness.service.listJobs({ limit: 2 });
    expect(firstPage.jobs.map((job) => job.jobId)).toEqual(['job-3', 'job-2']);
    expect(firstPage.nextBeforeJobId).toBe('job-2');

    const secondPage = harness.service.listJobs({
      limit: 2,
      beforeJobId: firstPage.nextBeforeJobId || undefined,
    });
    expect(secondPage.jobs.map((job) => job.jobId)).toEqual(['job-1']);

    const byGroup = harness.service.listJobs({
      groupFolder: 'main',
      limit: 10,
    });
    expect(byGroup.jobs.map((job) => job.jobId)).toEqual(['job-3', 'job-1']);

    const byThread = harness.service.listJobs({
      threadId: 'thread-a',
      limit: 10,
    });
    expect(byThread.jobs.map((job) => job.jobId)).toEqual(['job-3', 'job-1']);
  });

  it('getJobLogs returns the specific stored job log tail', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-job-logs-'));
    const logFile = path.join(tempDir, 'job.log');
    fs.writeFileSync(logFile, 'line1\nline2\nline3\n');

    createRuntimeOrchestrationJob({
      jobId: 'job-log',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-log',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'logs',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-03-30T00:00:00.000Z',
    });

    const harness = buildHarness();
    const result = harness.service.getJobLogs({ jobId: 'job-log', lines: 2 });

    expect(result.jobId).toBe('job-log');
    expect(result.logText).toBe('line2\nline3');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stopJob marks stopRequested and reports live stop acceptance', async () => {
    createRuntimeOrchestrationJob({
      jobId: 'job-running',
      kind: 'create',
      status: 'running',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-stop',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'running',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:00.000Z',
      startedAt: '2026-03-30T00:00:01.000Z',
      finishedAt: null,
      updatedAt: '2026-03-30T00:00:01.000Z',
    });

    const harness = buildHarness();
    harness.runtimeJobs.push({
      groupJid: 'tg:main',
      active: true,
      idleWaiting: false,
      isTaskContainer: true,
      runningTaskId: 'job-running',
      pendingMessages: false,
      pendingTaskCount: 0,
      containerName: 'andrea-runtime-main',
      groupFolder: 'main',
      retryCount: 0,
    });

    const result = await harness.service.stopJob({
      jobId: 'job-running',
      source: { system: 'nanoclaw', actorRef: 'tg:operator' },
    });

    expect(result.liveStopAccepted).toBe(true);
    expect(result.job.stopRequested).toBe(true);
    expect(harness.requestStop).toHaveBeenCalledWith('tg:main');
  });

  it('stopJob fails a queued job before it starts', async () => {
    createRuntimeOrchestrationJob({
      jobId: 'job-queued',
      kind: 'create',
      status: 'queued',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: null,
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: null,
      selectedRuntime: null,
      promptPreview: 'queued',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanoclaw',
      actorRef: null,
      correlationId: null,
      replyRef: null,
      createdAt: '2026-03-30T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-03-30T00:00:00.000Z',
    });

    const harness = buildHarness();
    const result = await harness.service.stopJob({
      jobId: 'job-queued',
      source: { system: 'nanoclaw' },
    });

    expect(result.liveStopAccepted).toBe(false);
    expect(result.job.status).toBe('failed');
    expect(result.job.stopRequested).toBe(true);
    expect(result.job.errorText).toContain('before execution started');
  });
});
