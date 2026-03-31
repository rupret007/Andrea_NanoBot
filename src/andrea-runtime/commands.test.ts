import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BackendJobDetails,
  BackendJobSummary,
} from '../backend-lanes/types.js';
import {
  dispatchRuntimeCommand,
  formatRuntimeJobsMessage,
  readLatestRuntimeLog,
  type RuntimeCommandContext,
  type RuntimeCommandDependencies,
} from './commands.js';

function makeSummary(
  overrides: Partial<BackendJobSummary> = {},
): BackendJobSummary {
  return {
    handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1' },
    title: 'Codex/OpenAI task',
    status: 'running',
    summary: 'Keep shipping',
    updatedAt: '2026-03-30T00:02:00.000Z',
    createdAt: '2026-03-30T00:00:00.000Z',
    sourceRepository: null,
    targetUrl: null,
    laneLabel: 'Codex/OpenAI Runtime',
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
    ...overrides,
  };
}

function makeDetails(
  overrides: Partial<BackendJobDetails> = {},
): BackendJobDetails {
  return {
    ...makeSummary(),
    metadata: {
      groupFolder: 'main',
      threadId: 'thread-1',
      selectedRuntime: 'codex_local',
      logFile: 'C:\\logs\\runtime.log',
      latestOutputText: 'latest output',
      finalOutputText: 'final output',
      ...((overrides.metadata as Record<string, unknown> | null) || {}),
    },
    ...overrides,
  };
}

describe('runtime commands', () => {
  let sentMessages: string[];
  let runtimeMessages: Array<{ jobId: string; text: string }>;
  let rememberedLists: Array<{
    jobs: BackendJobSummary[];
    listMessageId?: string;
  }>;
  let deps: RuntimeCommandDependencies;
  let context: RuntimeCommandContext;

  beforeEach(() => {
    sentMessages = [];
    runtimeMessages = [];
    rememberedLists = [];
    context = {
      operatorChatJid: 'tg:operator',
      groupFolder: 'main',
      rawTrimmed: '/runtime-status',
      commandToken: '/runtime-status',
      threadId: '42',
      replyToMessageId: undefined,
    };
    deps = {
      async sendToChat(_chatJid, text) {
        sentMessages.push(text);
        return 'msg-1';
      },
      async sendRuntimeJobMessage(args) {
        runtimeMessages.push({ jobId: args.jobId, text: args.text });
        return 'msg-job';
      },
      rememberRuntimeJobList(args) {
        rememberedLists.push({
          jobs: args.jobs,
          listMessageId: args.listMessageId,
        });
      },
      getStatusMessage() {
        return '*Codex/OpenAI Runtime Status*\n- Container runtime: podman (running)';
      },
      canExecute: true,
      getExecutionDisabledMessage() {
        return "Andrea's Codex/OpenAI runtime lane is integrated, but execution is still turned off on this host.\nKeep using /cursor as the main operator shell today. You can still review existing runtime work where it is available.\nEnable ANDREA_RUNTIME_EXECUTION_ENABLED=true only after validating the Codex/OpenAI runtime container and credentials on this machine.";
      },
      getRuntimeJobs() {
        return [];
      },
      findGroupByFolder(folder) {
        if (folder === 'main') {
          return { jid: 'tg:main', folder: 'main' };
        }
        return null;
      },
      requestStop() {
        return false;
      },
      async listJobs() {
        return [];
      },
      resolveTarget() {
        return { target: null, failureMessage: 'Run `/runtime-jobs`.' };
      },
      async refreshJob() {
        return makeDetails();
      },
      async getPrimaryOutput() {
        return {
          handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1' },
          text: 'final output',
          source: 'final_output',
          lineCount: 1,
        };
      },
      async getJobLogs() {
        return {
          handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1' },
          logText: 'tail',
          lines: 1,
          logFile: 'C:\\logs\\runtime.log',
        };
      },
      async stopJob() {
        return makeDetails({ status: 'failed' });
      },
      async followUpJob() {
        return makeDetails({
          handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-2' },
          status: 'queued',
        });
      },
      async followUpLegacyGroup() {
        return makeDetails({
          handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-legacy' },
          status: 'queued',
        });
      },
      formatFailure({ operation, targetDisplay }) {
        return `${operation}: ${targetDisplay || 'n/a'}`;
      },
    };
  });

  it('formats the empty jobs state clearly', () => {
    expect(formatRuntimeJobsMessage([])).toBe(
      'Andrea has no recent Codex/OpenAI tasks in this workspace right now.',
    );
  });

  it('formats job lists with ordinals and next-step guidance', () => {
    const message = formatRuntimeJobsMessage([
      makeSummary(),
      makeSummary({
        handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-2' },
        status: 'queued',
      }),
    ]);

    expect(message).toContain('*Codex/OpenAI Work*');
    expect(message).toContain('1. runtime-job-1 [Working]');
    expect(message).toContain('2. runtime-job-2 [Queued]');
    expect(message).toContain(
      'Open `/cursor` -> `Codex/OpenAI` -> `Recent Work`',
    );
    expect(message).toContain('/runtime-followup');
  });

  it('dispatches /runtime-status', async () => {
    const handled = await dispatchRuntimeCommand(deps, context);

    expect(handled).toBe(true);
    expect(sentMessages).toEqual([
      '*Codex/OpenAI Runtime Status*\n- Container runtime: podman (running)',
    ]);
  });

  it('stores a lane-aware runtime jobs snapshot', async () => {
    deps.listJobs = vi.fn(async () => [
      makeSummary(),
      makeSummary({
        handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-2' },
      }),
    ]);
    context = {
      ...context,
      rawTrimmed: '/runtime-jobs',
      commandToken: '/runtime-jobs',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(rememberedLists).toHaveLength(1);
    expect(rememberedLists[0].jobs.map((job) => job.handle.jobId)).toEqual([
      'runtime-job-1',
      'runtime-job-2',
    ]);
  });

  it('uses reply/current context for follow-up before legacy group-folder fallback', async () => {
    deps.resolveTarget = vi.fn(() => ({
      target: {
        handle: {
          laneId: 'andrea_runtime' as const,
          jobId: 'runtime-job-reply',
        },
        jobId: 'runtime-job-reply',
        via: 'reply' as const,
      },
      failureMessage: null,
    }));
    const followUpJob = vi.fn(deps.followUpJob);
    const followUpLegacyGroup = vi.fn(deps.followUpLegacyGroup);
    deps.followUpJob = followUpJob;
    deps.followUpLegacyGroup = followUpLegacyGroup;
    context = {
      ...context,
      rawTrimmed: '/runtime-followup continue with the fix',
      commandToken: '/runtime-followup',
      replyToMessageId: '9001',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(followUpJob).toHaveBeenCalledWith({
      handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-reply' },
      groupFolder: 'main',
      chatJid: 'tg:operator',
      promptText: 'continue with the fix',
    });
    expect(followUpLegacyGroup).not.toHaveBeenCalled();
    expect(runtimeMessages[0].jobId).toBe('runtime-job-2');
    expect(runtimeMessages[0].text).toContain(
      'Andrea sent your next instruction to this task.',
    );
    expect(runtimeMessages[0].text).toContain(
      'Task: Codex/OpenAI runtime runtime-job-2.',
    );
  });

  it('falls back to legacy group folders for follow-up when no job context exists', async () => {
    deps.resolveTarget = vi.fn(() => ({
      target: null,
      failureMessage: 'Run `/runtime-jobs`.',
    }));
    const followUpLegacyGroup = vi.fn(deps.followUpLegacyGroup);
    deps.followUpLegacyGroup = followUpLegacyGroup;
    context = {
      ...context,
      rawTrimmed: '/runtime-followup main please continue',
      commandToken: '/runtime-followup',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(followUpLegacyGroup).toHaveBeenCalledWith({
      groupFolder: 'main',
      chatJid: 'tg:operator',
      promptText: 'please continue',
    });
  });

  it('resolves explicit job ids for stop', async () => {
    deps.resolveTarget = vi.fn(() => ({
      target: {
        handle: { laneId: 'andrea_runtime' as const, jobId: 'runtime-job-9' },
        jobId: 'runtime-job-9',
        via: 'explicit' as const,
      },
      failureMessage: null,
    }));
    const stopJob = vi.fn(deps.stopJob);
    deps.stopJob = stopJob;
    context = {
      ...context,
      rawTrimmed: '/runtime-stop runtime-job-9',
      commandToken: '/runtime-stop',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(stopJob).toHaveBeenCalledWith({
      handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-9' },
      groupFolder: 'main',
      chatJid: 'tg:operator',
    });
  });

  it('uses the primary output path for runtime logs', async () => {
    deps.resolveTarget = vi.fn(() => ({
      target: {
        handle: { laneId: 'andrea_runtime' as const, jobId: 'runtime-job-1' },
        jobId: 'runtime-job-1',
        via: 'current' as const,
      },
      failureMessage: null,
    }));
    context = {
      ...context,
      rawTrimmed: '/runtime-logs current 10',
      commandToken: '/runtime-logs',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(runtimeMessages[0].jobId).toBe('runtime-job-1');
    expect(runtimeMessages[0].text).toContain('Lane: Codex/OpenAI runtime');
    expect(runtimeMessages[0].text).toContain('Current output:');
    expect(runtimeMessages[0].text).toContain('final output');
  });

  it('falls back to legacy file logs when no runtime job exists for a folder', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-logs-'));
    const groupDir = path.join(tempDir, 'main');
    const logsDir = path.join(groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'latest.log'), 'line1\nline2\nline3\n');

    const groupFolderModule = await import('../group-folder.js');
    const resolveSpy = vi.spyOn(groupFolderModule, 'resolveGroupFolderPath');
    resolveSpy.mockReturnValue(groupDir);

    deps.resolveTarget = vi.fn(() => ({
      target: null,
      failureMessage: 'Run `/runtime-jobs`.',
    }));
    deps.listJobs = vi.fn(async () => []);
    context = {
      ...context,
      rawTrimmed: '/runtime-logs main 2',
      commandToken: '/runtime-logs',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(sentMessages[0]).toContain('Latest log: latest.log');
    expect(sentMessages[0]).toContain('line2');
    expect(sentMessages[0]).toContain('line3');

    resolveSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('blocks follow-up when runtime execution is disabled but still allows status/list commands', async () => {
    deps.canExecute = false;
    context = {
      ...context,
      rawTrimmed: '/runtime-followup main continue',
      commandToken: '/runtime-followup',
    };

    await dispatchRuntimeCommand(deps, context);

    expect(sentMessages).toEqual([
      "Andrea's Codex/OpenAI runtime lane is integrated, but execution is still turned off on this host.\nKeep using /cursor as the main operator shell today. You can still review existing runtime work where it is available.\nEnable ANDREA_RUNTIME_EXECUTION_ENABLED=true only after validating the Codex/OpenAI runtime container and credentials on this machine.",
    ]);
  });
});

describe('readLatestRuntimeLog', () => {
  let tempDir: string;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-read-'));
    const groupFolderModule = await import('../group-folder.js');
    resolveSpy = vi.spyOn(groupFolderModule, 'resolveGroupFolderPath');
    resolveSpy.mockImplementation((groupFolder: string) =>
      path.join(tempDir, groupFolder),
    );
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no log directory exists', () => {
    expect(readLatestRuntimeLog('main', 10)).toBeNull();
  });

  it('returns the tail of the latest log file', () => {
    const logsDir = path.join(tempDir, 'main', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'a.log'), 'a1\na2\n');
    fs.writeFileSync(path.join(logsDir, 'b.log'), 'b1\nb2\nb3\n');

    const result = readLatestRuntimeLog('main', 2);

    expect(result).toContain('Latest log: b.log');
    expect(result).toContain('b2');
    expect(result).toContain('b3');
  });
});
