import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchRuntimeCommand,
  formatRuntimeJobsMessage,
  readLatestRuntimeLog,
  type RuntimeCommandDependencies,
} from './runtime-commands.js';

describe('runtime commands', () => {
  let sentMessages: string[];
  let deps: RuntimeCommandDependencies;

  beforeEach(() => {
    sentMessages = [];
    deps = {
      async sendToChat(_chatJid, text) {
        sentMessages.push(text);
      },
      getStatusMessage() {
        return '*Andrea Runtime Status*\n- Container runtime: podman (running)';
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
      async queueFollowup() {},
    };
  });

  it('formats the empty jobs state clearly', () => {
    expect(formatRuntimeJobsMessage([])).toBe(
      'Andrea has no active or queued runtime jobs right now.',
    );
  });

  it('formats active jobs with operator-friendly details', () => {
    const message = formatRuntimeJobsMessage([
      {
        groupFolder: 'main',
        groupJid: 'tg:main',
        active: true,
        idleWaiting: false,
        pendingMessages: true,
        pendingTaskCount: 2,
        containerName: 'andrea-runtime-main',
      },
    ]);

    expect(message).toContain('*Andrea Runtime Jobs*');
    expect(message).toContain('main');
    expect(message).toContain('pending_tasks=2');
    expect(message).toContain('container=andrea-runtime-main');
  });

  it('dispatches /runtime-status', async () => {
    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-status',
      '/runtime-status',
    );

    expect(handled).toBe(true);
    expect(sentMessages).toEqual([
      '*Andrea Runtime Status*\n- Container runtime: podman (running)',
    ]);
  });

  it('dispatches /runtime-jobs', async () => {
    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-jobs',
      '/runtime-jobs',
    );

    expect(handled).toBe(true);
    expect(sentMessages).toEqual([
      'Andrea has no active or queued runtime jobs right now.',
    ]);
  });

  it('rejects follow-up usage without required args', async () => {
    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-followup',
      '/runtime-followup',
    );

    expect(handled).toBe(true);
    expect(sentMessages).toEqual([
      'Usage: /runtime-followup GROUP_FOLDER TEXT',
    ]);
  });

  it('queues a follow-up for a known group', async () => {
    const queueFollowup = vi.fn(async () => {});
    deps.queueFollowup = queueFollowup;

    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-followup main please continue',
      '/runtime-followup',
    );

    expect(handled).toBe(true);
    expect(queueFollowup).toHaveBeenCalledWith({
      operatorChatJid: 'tg:operator',
      targetGroupJid: 'tg:main',
      targetFolder: 'main',
      prompt: 'please continue',
    });
    expect(sentMessages).toEqual(['Queued runtime follow-up for main.']);
  });

  it('rejects stop for an unknown group', async () => {
    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-stop missing',
      '/runtime-stop',
    );

    expect(handled).toBe(true);
    expect(sentMessages).toEqual([
      'No registered group found for folder "missing".',
    ]);
  });

  it('reports when no active runtime job exists to stop', async () => {
    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-stop main',
      '/runtime-stop',
    );

    expect(handled).toBe(true);
    expect(sentMessages).toEqual(['No active runtime job found for main.']);
  });

  it('tails logs for a known group', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-logs-'));
    const groupDir = path.join(tempDir, 'main');
    const logsDir = path.join(groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'latest.log'),
      'line1\nline2\nline3\nline4\n',
    );

    const resolveSpy = vi.spyOn(
      await import('./group-folder.js'),
      'resolveGroupFolderPath',
    );
    resolveSpy.mockReturnValue(groupDir);

    const handled = await dispatchRuntimeCommand(
      deps,
      'tg:operator',
      '/runtime-logs main 2',
      '/runtime-logs',
    );

    expect(handled).toBe(true);
    expect(sentMessages[0]).toContain('Latest log: latest.log');
    expect(sentMessages[0]).toContain('line3');
    expect(sentMessages[0]).toContain('line4');

    resolveSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('readLatestRuntimeLog', () => {
  let tempDir: string;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-read-'));
    const groupFolderModule = await import('./group-folder.js');
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
