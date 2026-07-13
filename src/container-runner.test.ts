import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  AGENT_RUNTIME_DEFAULT: 'codex_local',
  AGENT_RUNTIME_FALLBACK: 'openai_cloud',
  CODEX_LOCAL_ENABLED: true,
  CODEX_LOCAL_MODEL: '',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_INITIAL_OUTPUT_TIMEOUT: 300000, // 5min
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  OPENAI_MODEL_FALLBACK: 'gpt-5.4',
  RUNTIME_STATE_DIR: '/tmp/nanoclaw-test-runtime',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  isLogLevelEnabled: vi.fn(() => false),
  sanitizeLogString: (value: string) => value,
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      lstatSync: vi.fn(() => ({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        isFile: () => true,
        size: 0,
        mtimeMs: Date.now(),
      })),
      mkdtempSync: vi.fn((prefix: string) => `${prefix}test`),
      copyFileSync: vi.fn(),
      realpathSync: vi.fn((candidate: fs.PathLike) => String(candidate)),
      cpSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_RUNTIME_NAME: 'docker',
  hostGatewayArgs: () => [],
  normalizeRuntimeArgs: (args: string[]) => args,
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  writableMountArgs: (h: string, c: string) => ['-v', `${h}:${c}`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;
let stdinBuffer = '';

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  assertContainerRuntimeTrustBoundary,
  runContainerAgent,
  ContainerOutput,
  sanitizeContainerArgsForLogs,
  writeTasksSnapshot,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

describe('container task snapshots', () => {
  it('never serializes legacy task scripts supplied by an untyped caller', () => {
    writeTasksSnapshot('test-group', true, [
      {
        id: 'task-1',
        groupFolder: 'test-group',
        prompt: 'safe prompt',
        script: 'export SECRET=should-not-leak',
        schedule_type: 'once',
        schedule_value: '2030-01-01T00:00:00.000Z',
        status: 'active',
        next_run: '2030-01-01T00:00:00.000Z',
      },
    ] as unknown as Parameters<typeof writeTasksSnapshot>[2]);

    const write = vi.mocked(fs.writeFileSync).mock.calls.at(-1);
    expect(write?.[0]).toBe(
      '/tmp/nanoclaw-test-data/ipc/test-group/current_tasks.json',
    );
    const serialized = String(write?.[1]);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('should-not-leak');
    expect(JSON.parse(serialized)).toEqual([
      expect.objectContaining({ id: 'task-1', prompt: 'safe prompt' }),
    ]);
  });
});

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: unknown,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

function runtimeToolEvidence(
  evidenceId: string,
  outcome: 'succeeded' | 'failed',
): NonNullable<ContainerOutput['runtimeToolEvidence']> {
  const succeeded = outcome === 'succeeded' ? 1 : 0;
  const failed = outcome === 'failed' ? 1 : 0;
  return {
    version: 1,
    evidenceId,
    cumulative: true,
    attempts: 1,
    collectorStatus: 'complete',
    calls: { observed: 1, succeeded, failed, unresolved: 0 },
    actions: [
      {
        class: 'repository_read',
        observed: 1,
        succeeded,
        failed,
        unresolved: 0,
        succeededAfterLastRepositoryWrite: 0,
        lastOutcome: outcome,
        recovered: false,
      },
    ],
    state: {
      preStateFingerprint: null,
      postStateFingerprint: null,
      repositoryHeadFingerprint: null,
    },
    privacy: {
      metadataOnly: true,
      rawInputsStored: false,
      resultBodiesStored: false,
      toolUseIdsStored: false,
    },
  };
}

describe('container-runner timeout behavior', () => {
  it('fails closed for runtimes without verified nested read-only mounts', () => {
    expect(() =>
      assertContainerRuntimeTrustBoundary('apple-container'),
    ).toThrow(/nested read-only mount boundary/);
    expect(() => assertContainerRuntimeTrustBoundary('docker')).not.toThrow();
    expect(() => assertContainerRuntimeTrustBoundary('podman')).not.toThrow();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    stdinBuffer = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinBuffer += chunk.toString();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
      runtimeToolEvidence: runtimeToolEvidence('timeout-attempt', 'succeeded'),
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (clamped to container timeout = 1800000ms)
    await vi.advanceTimersByTimeAsync(1800000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(result.runtimeToolEvidence?.evidenceId).toBe('timeout-attempt');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('keeps streamed query evidence scoped while retaining a final diagnostic aggregate', async () => {
    const onOutput = vi.fn(async (_output: ContainerOutput) => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      runtimeToolEvidence: runtimeToolEvidence('attempt-a', 'failed'),
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Recovered response',
      runtimeToolEvidence: runtimeToolEvidence('attempt-b', 'succeeded'),
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      runtimeToolEvidence: {
        ...runtimeToolEvidence('attempt-b', 'succeeded'),
        version: 2,
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    const firstStreamedOutput = onOutput.mock.calls[0]?.[0];
    const secondStreamedOutput = onOutput.mock.calls[1]?.[0];
    const lastStreamedOutput = onOutput.mock.calls.at(-1)?.[0];
    expect(onOutput).toHaveBeenCalledTimes(3);
    expect(firstStreamedOutput?.runtimeToolEvidence?.evidenceId).toBe(
      'attempt-a',
    );
    expect(secondStreamedOutput?.runtimeToolEvidence?.evidenceId).toBe(
      'attempt-b',
    );
    expect(lastStreamedOutput?.runtimeToolEvidence).toBeUndefined();
    expect(result.runtimeToolEvidence).toMatchObject({
      evidenceId: expect.stringMatching(/^composite:/),
      calls: { observed: 2, succeeded: 1, failed: 1, unresolved: 0 },
    });
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(300000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('produced no structured output');
    expect(result.failureKind).toBe('initial_output_timeout');
    expect(result.failureStage).toBe('startup');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('uses per-request idle timeout without inflating timeout windows beyond group config', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: { timeout: 40_000 },
      },
      {
        ...testInput,
        idleTimeoutMs: 5_000,
      },
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(40_000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain(
      'Container produced no structured output within 40000ms',
    );
    expect(result.failureKind).toBe('initial_output_timeout');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('nonzero post-output cleanup preserves a streamed assistant success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Assistant execution completed.',
      newSessionId: 'session-post-output-cleanup',
      firstResultSubtype: 'success',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'success',
      newSessionId: 'session-post-output-cleanup',
      firstResultSubtype: 'success',
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Assistant execution completed.' }),
    );
  });

  it('nonzero cleanup after lifecycle-only output remains a failure', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-lifecycle-failure',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('runtime_bootstrap_failed');
    expect(result.sawLifecycleOnlyOutput).toBe(true);
  });

  it('tracks lifecycle-only output without treating it as a user-visible result', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-lifecycle',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.sawLifecycleOnlyOutput).toBe(true);
    expect(result.firstResultSubtype).toBeNull();
  });

  it('returns a terminal direct-assistant error instead of idling after the error marker', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        requestPolicy: {
          route: 'direct_assistant',
          reason: 'test',
          builtinTools: [],
          mcpTools: [],
          guidance: 'reply directly',
        },
      },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'Gateway authentication failed because the API key is invalid.',
      failureKind: 'auth_failed',
      failureStage: 'runtime',
      diagnosticHint:
        'assistant runtime returned an authentication failure before producing a stable answer',
      recoveryAttempted: true,
      firstResultSubtype: 'error_auth',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('auth_failed');
    expect(result.recoveryAttempted).toBe(true);
    expect(result.firstResultSubtype).toBe('error_auth');
  });

  it('redacts sensitive env vars in logged container args', () => {
    const args = [
      'run',
      '-e',
      'OPENAI_API_KEY=sk-openai-secret',
      '-e',
      'ANTHROPIC_AUTH_TOKEN=secret-token',
      '-e',
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      '-e',
      'TZ=America/Chicago',
    ];

    expect(sanitizeContainerArgsForLogs(args)).toEqual([
      'run',
      '-e',
      'OPENAI_API_KEY=***',
      '-e',
      'ANTHROPIC_AUTH_TOKEN=***',
      '-e',
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      '-e',
      'TZ=America/Chicago',
    ]);
  });

  it('serializes request policy into container stdin for helper boundary enforcement', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        requestPolicy: {
          route: 'protected_assistant',
          reason: 'matched assistant scheduling or lookup intent',
          builtinTools: ['Read', 'WebSearch'],
          mcpTools: ['mcp__nanoclaw__schedule_task'],
          guidance: 'Keep Andrea as the only public identity.',
        },
      },
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(10);

    const serializedInput = JSON.parse(stdinBuffer);
    expect(serializedInput.requestPolicy).toMatchObject({
      route: 'protected_assistant',
      mcpTools: ['mcp__nanoclaw__schedule_task'],
      guidance: 'Keep Andrea as the only public identity.',
    });

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-policy',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  it('isolates direct assistant Claude home from heavier group lanes', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        requestPolicy: {
          route: 'direct_assistant',
          reason: 'defaulted to direct assistant handling',
          builtinTools: [],
          mcpTools: [],
          guidance: 'Answer clearly and directly.',
        },
      },
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(10);

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const lastArgs = spawnCalls.at(-1)?.[1] as string[] | undefined;
    const normalizedArgs = (lastArgs || []).join(' ').replace(/\\/g, '/');
    expect(lastArgs).toContain('-v');
    expect(normalizedArgs).toContain(
      '/tmp/nanoclaw-test-data/sessions/test-group/.claude-direct-assistant:/home/node/.claude',
    );
    expect(normalizedArgs).toContain(
      '/tmp/nanoclaw-test-data/sessions/test-group/direct-assistant-workspace:/workspace/group',
    );
    expect(normalizedArgs).not.toContain(
      '/tmp/nanoclaw-test-groups/test-group:/workspace/group',
    );
    expect(normalizedArgs).not.toContain('/workspace/project');
    expect(normalizedArgs).not.toContain('/workspace/global');
    expect(normalizedArgs).not.toContain('/workspace/extra/');
    expect(normalizedArgs).toContain('/workspace/group/CLAUDE.md:ro');
    expect(normalizedArgs).toContain('/home/node/.claude/settings.json:ro');
    expect(normalizedArgs).toContain('/home/node/.claude/skills:ro');
    expect(normalizedArgs).toContain(
      '/nanoclaw-test-runtime/container-controls/test-group/direct-assistant/generation-',
    );
    expect(normalizedArgs).not.toContain(
      '.claude-direct-assistant/skills:/home/node/.claude/skills',
    );
    expect(normalizedArgs).toContain('/home/node/.claude/plugins:ro');
    expect(normalizedArgs).toContain('/home/node/.claude/agents:ro');
    expect(normalizedArgs).toContain('/home/node/.claude/commands:ro');
    expect(normalizedArgs).toContain('/home/node/.claude/rules:ro');
    expect(normalizedArgs).not.toContain('/home/node/.codex');
    expect(normalizedArgs).not.toContain('CODEX_HOME');
    expect(normalizedArgs).not.toContain(
      'direct-assistant-workspace/CLAUDE.md:/workspace/group/CLAUDE.md',
    );
    const mountSpecs = (lastArgs || []).filter((arg) => arg.includes(':'));
    const sessionParentIndex = mountSpecs.findIndex((arg) =>
      arg.includes('.claude-direct-assistant:/home/node/.claude'),
    );
    const groupGuidanceIndex = mountSpecs.findIndex((arg) =>
      arg.includes(':/workspace/group/CLAUDE.md:ro'),
    );
    const settingsOverlayIndex = mountSpecs.findIndex((arg) =>
      arg.includes(':/home/node/.claude/settings.json:ro'),
    );
    const skillsOverlayIndex = mountSpecs.findIndex((arg) =>
      arg.includes(':/home/node/.claude/skills:ro'),
    );
    expect(sessionParentIndex).toBeGreaterThanOrEqual(0);
    expect(groupGuidanceIndex).toBeGreaterThan(sessionParentIndex);
    expect(settingsOverlayIndex).toBeGreaterThan(sessionParentIndex);
    expect(skillsOverlayIndex).toBeGreaterThan(sessionParentIndex);

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-direct-home',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'success',
    });
  });

  it('uses the minimal direct mount profile when request policy is missing', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, isMain: true },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    const lastArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const normalizedArgs = lastArgs.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).toContain(
      'direct-assistant-workspace:/workspace/group',
    );
    expect(normalizedArgs).not.toContain('/workspace/project');
    expect(normalizedArgs).not.toContain('/home/node/.codex');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-missing-policy',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
  });

  it('normalizes a tampered direct policy before selecting writable IPC or context mounts', async () => {
    const onProcess = vi.fn();
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        isMain: true,
        requestPolicy: {
          route: 'direct_assistant',
          reason: 'tampered direct policy',
          builtinTools: ['Read'],
          mcpTools: ['mcp__nanoclaw__schedule_task'],
          guidance: 'untrusted',
        },
      },
      onProcess,
    );

    await vi.advanceTimersByTimeAsync(10);
    const lastArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const normalizedArgs = lastArgs.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).toMatch(
      /\/ipc\/test-group\/input\/direct-assistant\/[^ ]+:\/workspace\/ipc\/input:ro/,
    );
    expect(normalizedArgs).not.toContain('/ipc/test-group:/workspace/ipc');
    expect(normalizedArgs).not.toContain('/workspace/project');
    expect(normalizedArgs).toContain('.claude-direct-assistant');
    const serializedInput = JSON.parse(stdinBuffer);
    expect(serializedInput.requestPolicy).toMatchObject({
      route: 'direct_assistant',
      builtinTools: [],
      mcpTools: [],
    });
    const ipcContext = onProcess.mock.calls[0]?.[2];
    expect(serializedInput.ipcRunId).toBe(ipcContext.runId);
    expect(serializedInput.ipcAuthToken).toBe(ipcContext.authToken);
    expect(normalizedArgs).not.toContain(ipcContext.authToken);
    expect(ipcContext.inputDir.replace(/\\/g, '/')).toContain(
      '/ipc/test-group/input/direct-assistant/',
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-tampered-direct',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
  });

  it('fails an over-wide advanced policy into the minimal direct host boundary', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        isMain: true,
        requestPolicy: {
          route: 'advanced_helper',
          reason: 'tampered mixed policy',
          builtinTools: ['Bash'],
          mcpTools: ['mcp__nanoclaw__create_cursor_agent'],
          guidance: 'untrusted',
        },
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    const lastArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const normalizedArgs = lastArgs.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).toMatch(
      /\/ipc\/test-group\/input\/direct-assistant\/[^ ]+:\/workspace\/ipc\/input:ro/,
    );
    expect(normalizedArgs).not.toContain('/ipc/test-group:/workspace/ipc');
    expect(normalizedArgs).not.toContain('/workspace/project');
    expect(normalizedArgs).not.toContain('/home/node/.claude/skills:rw');
    expect(normalizedArgs).toContain('.claude-direct-assistant');
    expect(JSON.parse(stdinBuffer).requestPolicy).toMatchObject({
      route: 'direct_assistant',
      builtinTools: [],
      mcpTools: [],
    });

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-tampered-advanced',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
  });

  it('uses the isolated protected home for protected routes', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        requestPolicy: {
          route: 'protected_assistant',
          reason: 'explicit read-only lookup',
          builtinTools: ['Read'],
          mcpTools: [],
          guidance: 'Inspect only the requested file.',
        },
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    const lastArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const normalizedArgs = lastArgs.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).toContain(
      '/sessions/test-group/.claude-protected:/home/node/.claude',
    );
    expect(normalizedArgs).not.toContain('.claude-direct-assistant');
    expect(normalizedArgs).not.toContain('.claude-execution');
    expect(normalizedArgs).toMatch(
      /\/ipc\/test-group\/input\/protected\/[^ ]+:\/workspace\/ipc\/input:ro/,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-tool-bearing-home',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
  });

  it('mounts only canonical agent-runner source read-only and leaves legacy caches inert', async () => {
    const projectRoot = process.cwd();
    const sourceDir = path.join(
      projectRoot,
      'container',
      'agent-runner',
      'src',
    );
    const cacheDir = path.join(
      '/tmp/nanoclaw-test-data',
      'sessions',
      'test-group',
      'agent-runner-src',
    );
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'started',
      newSessionId: 'session-canonical-runner',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    const lastArgs = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const normalizedArgs = lastArgs.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).toContain(
      `${sourceDir.replace(/\\/g, '/')}:/app/src:ro`,
    );
    expect(normalizedArgs).not.toContain(
      `${cacheDir.replace(/\\/g, '/')}:/app/src`,
    );
    expect(fs.cpSync).not.toHaveBeenCalled();
  });
});
