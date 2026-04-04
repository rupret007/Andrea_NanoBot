import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assessAssistantHealthState,
  clearAssistantHealthState,
  clearAssistantReadyState,
  detectWindowsInstallArtifacts,
  detectWindowsInstallMode,
  determineWindowsHostServiceState,
  getAssistantHealthStatePath,
  getHostStatePath,
  getReadyStatePath,
  persistNanoclawHostState,
  readAssistantHealthState,
  readHostControlSnapshot,
  reconcileWindowsHostState,
  type NanoclawHostState,
  writeAssistantHealthState,
  writeAssistantReadyState,
} from './host-control.js';

describe('host control state', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-'));
    fs.mkdirSync(path.join(tempDir, 'data', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    clearAssistantHealthState();
    clearAssistantReadyState();
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a ready marker using the active host boot id', () => {
    const hostState: NanoclawHostState = {
      bootId: 'boot-123',
      phase: 'starting',
      pid: process.pid,
      installMode: 'manual_host_control',
      nodePath: 'C:\\node.exe',
      nodeVersion: '22.22.2',
      startedAt: '2026-04-02T00:00:00.000Z',
      readyAt: null,
      lastError: '',
      dependencyState: 'unknown',
      dependencyError: '',
      stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
      stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
    };
    persistNanoclawHostState(hostState);

    const ready = writeAssistantReadyState('1.2.42');
    expect(ready.bootId).toBe('boot-123');
    expect(ready.pid).toBe(process.pid);
    expect(fs.existsSync(getReadyStatePath())).toBe(true);
  });

  it('reads host snapshots from runtime state files', () => {
    persistNanoclawHostState({
      bootId: 'boot-456',
      phase: 'running_ready',
      pid: 1234,
      installMode: 'scheduled_task',
      nodePath: 'C:\\node.exe',
      nodeVersion: '22.22.2',
      startedAt: '2026-04-02T00:00:00.000Z',
      readyAt: '2026-04-02T00:00:05.000Z',
      lastError: '',
      dependencyState: 'ok',
      dependencyError: '',
      stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
      stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
    });
    fs.writeFileSync(
      getReadyStatePath(),
      JSON.stringify({
        bootId: 'boot-456',
        pid: 1234,
        readyAt: '2026-04-02T00:00:05.000Z',
        appVersion: '1.2.42',
      }),
    );

    const snapshot = readHostControlSnapshot();
    expect(snapshot.hostState?.phase).toBe('running_ready');
    expect(snapshot.readyState?.bootId).toBe('boot-456');
  });

  it('writes host state into the active cwd runtime directory', () => {
    persistNanoclawHostState({
      bootId: 'boot-789',
      phase: 'stopped',
      pid: null,
      installMode: 'manual_host_control',
      nodePath: '',
      nodeVersion: '',
      startedAt: '',
      readyAt: null,
      lastError: '',
      dependencyState: 'unknown',
      dependencyError: '',
      stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
      stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
    });

    expect(getHostStatePath()).toBe(
      path.join(tempDir, 'data', 'runtime', 'nanoclaw-host-state.json'),
    );
    expect(fs.existsSync(getHostStatePath())).toBe(true);
  });

  it('writes and reads assistant health markers', () => {
    persistNanoclawHostState({
      bootId: 'boot-health',
      phase: 'running_ready',
      pid: process.pid,
      installMode: 'manual_host_control',
      nodePath: 'C:\\node.exe',
      nodeVersion: '22.22.2',
      startedAt: '2026-04-02T00:00:00.000Z',
      readyAt: '2026-04-02T00:00:05.000Z',
      lastError: '',
      dependencyState: 'ok',
      dependencyError: '',
      stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
      stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
    });

    const health = writeAssistantHealthState({
      appVersion: '1.2.42',
      channelHealth: [
        {
          name: 'telegram',
          configured: true,
          state: 'ready',
          updatedAt: '2026-04-02T00:00:10.000Z',
          lastReadyAt: '2026-04-02T00:00:10.000Z',
          detail: 'Telegram polling connected.',
        },
      ],
    });

    expect(health.bootId).toBe('boot-health');
    expect(fs.existsSync(getAssistantHealthStatePath())).toBe(true);
    expect(readAssistantHealthState()?.channels).toEqual([
      expect.objectContaining({
        name: 'telegram',
        configured: true,
        state: 'ready',
        detail: 'Telegram polling connected.',
      }),
    ]);
  });
});

describe('assistant health assessment', () => {
  it('reports degraded configured channels', () => {
    const assessment = assessAssistantHealthState({
      assistantHealthState: {
        bootId: 'boot-1',
        pid: 2000,
        appVersion: '1.2.42',
        updatedAt: '2026-04-02T00:00:30.000Z',
        channels: [
          {
            name: 'telegram',
            configured: true,
            state: 'degraded',
            updatedAt: '2026-04-02T00:00:30.000Z',
            lastError:
              'Telegram long polling was interrupted by a webhook change.',
          },
        ],
      },
      hostState: {
        bootId: 'boot-1',
        phase: 'running_ready',
        pid: 2000,
        installMode: 'manual_host_control',
        nodePath: 'C:\\node.exe',
        nodeVersion: '22.22.2',
        startedAt: '2026-04-02T00:00:00.000Z',
        readyAt: '2026-04-02T00:00:05.000Z',
        lastError: '',
        dependencyState: 'ok',
        dependencyError: '',
        stdoutLogPath: 'out',
        stderrLogPath: 'err',
        hostLogPath: 'host',
      },
      readyState: {
        bootId: 'boot-1',
        pid: 2000,
        readyAt: '2026-04-02T00:00:05.000Z',
        appVersion: '1.2.42',
      },
      processRunning: true,
      runtimePid: 2000,
      now: new Date('2026-04-02T00:01:00.000Z'),
    });

    expect(assessment.status).toBe('degraded');
    expect(assessment.detail).toContain('telegram');
  });

  it('reports stale assistant heartbeats', () => {
    const assessment = assessAssistantHealthState({
      assistantHealthState: {
        bootId: 'boot-2',
        pid: 2001,
        appVersion: '1.2.42',
        updatedAt: '2026-04-02T00:00:00.000Z',
        channels: [],
      },
      processRunning: true,
      runtimePid: 2001,
      now: new Date('2026-04-02T00:05:00.000Z'),
      staleAfterMs: 60_000,
    });

    expect(assessment.status).toBe('stale');
    expect(assessment.detail).toContain('stale');
  });
});

describe('Windows host service classification', () => {
  it('marks a matching host and ready state as running_ready', () => {
    expect(
      determineWindowsHostServiceState({
        hostState: {
          bootId: 'boot-1',
          phase: 'running_ready',
          pid: 2000,
          installMode: 'scheduled_task',
          nodePath: 'C:\\node.exe',
          nodeVersion: '22.22.2',
          startedAt: '2026-04-02T00:00:00.000Z',
          readyAt: '2026-04-02T00:00:05.000Z',
          lastError: '',
          dependencyState: 'ok',
          dependencyError: '',
          stdoutLogPath: 'out',
          stderrLogPath: 'err',
          hostLogPath: 'host',
        },
        readyState: {
          bootId: 'boot-1',
          pid: 2000,
          readyAt: '2026-04-02T00:00:05.000Z',
          appVersion: '1.2.42',
        },
        processRunning: true,
      }),
    ).toBe('running_ready');
  });

  it('marks a running pid without a matching ready marker as process_stale', () => {
    expect(
      determineWindowsHostServiceState({
        hostState: {
          bootId: 'boot-1',
          phase: 'stopped',
          pid: 2000,
          installMode: 'manual_host_control',
          nodePath: 'C:\\node.exe',
          nodeVersion: '22.22.2',
          startedAt: '2026-04-02T00:00:00.000Z',
          readyAt: null,
          lastError: '',
          dependencyState: 'unknown',
          dependencyError: '',
          stdoutLogPath: 'out',
          stderrLogPath: 'err',
          hostLogPath: 'host',
        },
        readyState: null,
        processRunning: true,
      }),
    ).toBe('process_stale');
  });

  it('marks a dead process with stale ready state as process_stale', () => {
    expect(
      determineWindowsHostServiceState({
        hostState: {
          bootId: 'boot-2',
          phase: 'running_ready',
          pid: 2222,
          installMode: 'manual_host_control',
          nodePath: 'C:\\node.exe',
          nodeVersion: '22.22.2',
          startedAt: '2026-04-02T00:00:00.000Z',
          readyAt: '2026-04-02T00:00:05.000Z',
          lastError: '',
          dependencyState: 'ok',
          dependencyError: '',
          stdoutLogPath: 'out',
          stderrLogPath: 'err',
          hostLogPath: 'host',
        },
        readyState: {
          bootId: 'boot-2',
          pid: 2222,
          readyAt: '2026-04-02T00:00:05.000Z',
          appVersion: '1.2.42',
        },
        processRunning: false,
      }),
    ).toBe('process_stale');
  });

  it('treats a ready config_failed legacy state as running_ready', () => {
    expect(
      determineWindowsHostServiceState({
        hostState: {
          bootId: 'boot-3',
          phase: 'config_failed',
          pid: 3333,
          installMode: 'manual_host_control',
          nodePath: 'C:\\node.exe',
          nodeVersion: '22.22.2',
          startedAt: '2026-04-02T00:00:00.000Z',
          readyAt: '2026-04-02T00:00:05.000Z',
          lastError:
            'Local gateway is unhealthy: OpenAI key is out of quota/billing.',
          dependencyState: 'degraded',
          dependencyError:
            'Local gateway is unhealthy: OpenAI key is out of quota/billing.',
          stdoutLogPath: 'out',
          stderrLogPath: 'err',
          hostLogPath: 'host',
        },
        readyState: {
          bootId: 'boot-3',
          pid: 3333,
          readyAt: '2026-04-02T00:00:05.000Z',
          appVersion: '1.2.42',
        },
        processRunning: true,
      }),
    ).toBe('running_ready');
  });

  it('prefers scheduled_task over startup_folder when both signals exist', () => {
    expect(
      detectWindowsInstallMode({
        hasScheduledTask: true,
        hasStartupFolder: true,
      }),
    ).toBe('scheduled_task');
  });
});

describe('Windows host reconciliation', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-reconcile-'));
    fs.mkdirSync(path.join(tempDir, 'data', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps legacy config_failed ready states to running_ready plus degraded dependency', () => {
    fs.writeFileSync(
      getHostStatePath(),
      JSON.stringify({
        bootId: 'boot-legacy',
        phase: 'config_failed',
        pid: 4321,
        installMode: 'manual_host_control',
        nodePath: 'C:\\node.exe',
        nodeVersion: '22.22.2',
        startedAt: '2026-04-02T00:00:00.000Z',
        readyAt: '2026-04-02T00:00:05.000Z',
        lastError:
          'Local gateway is unhealthy: OpenAI key is out of quota/billing.',
        stdoutLogPath: 'out',
        stderrLogPath: 'err',
        hostLogPath: 'host',
      }),
    );
    fs.writeFileSync(
      getReadyStatePath(),
      JSON.stringify({
        bootId: 'boot-legacy',
        pid: 4321,
        readyAt: '2026-04-02T00:00:05.000Z',
        appVersion: '1.2.42',
      }),
    );

    const reconciliation = reconcileWindowsHostState({
      processValidator: () => true,
    });

    expect(reconciliation.serviceState).toBe('running_ready');
    expect(reconciliation.dependencyState).toBe('degraded');
    expect(reconciliation.dependencyError).toContain('out of quota');
    expect(reconciliation.launcherError).toBe('');
  });

  it('flags dead processes with leftover ready state as process_stale', () => {
    persistNanoclawHostState({
      bootId: 'boot-stale',
      phase: 'running_ready',
      pid: 9999,
      installMode: 'manual_host_control',
      nodePath: 'C:\\node.exe',
      nodeVersion: '22.22.2',
      startedAt: '2026-04-02T00:00:00.000Z',
      readyAt: '2026-04-02T00:00:05.000Z',
      lastError: '',
      dependencyState: 'ok',
      dependencyError: '',
      stdoutLogPath: 'out',
      stderrLogPath: 'err',
      hostLogPath: 'host',
    });
    fs.writeFileSync(
      getReadyStatePath(),
      JSON.stringify({
        bootId: 'boot-stale',
        pid: 9999,
        readyAt: '2026-04-02T00:00:05.000Z',
        appVersion: '1.2.42',
      }),
    );

    const reconciliation = reconcileWindowsHostState({
      processValidator: () => false,
    });

    expect(reconciliation.serviceState).toBe('process_stale');
    expect(reconciliation.processRunning).toBe(false);
  });

  it('detects legacy startup-folder scripts separately from install mode', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-appdata-'));
    const startupPath = path.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
    );
    fs.mkdirSync(startupPath, { recursive: true });
    fs.writeFileSync(
      path.join(startupPath, 'nanoclaw-start.cmd'),
      '@echo off\r\npowershell.exe -File "C:\\NanoClaw\\start-nanoclaw.ps1"\r\n',
    );

    const artifacts = detectWindowsInstallArtifacts({
      projectRoot: tempDir,
      appData,
      hasScheduledTask: false,
    });

    expect(artifacts.hasStartupFolder).toBe(true);
    expect(artifacts.startupFolderScriptIsLegacy).toBe(true);

    fs.rmSync(appData, { recursive: true, force: true });
  });
});
