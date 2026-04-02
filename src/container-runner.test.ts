import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
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
  logger: {
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
  runContainerAgent,
  ContainerOutput,
  sanitizeContainerArgsForLogs,
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

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
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
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
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
    expect(result.error).toContain('produced no output');
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
      'Container produced no output within 40000ms',
    );
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

  it('refreshes stale per-group agent-runner cache even when cached file mtime is newer', async () => {
    const projectRoot = process.cwd();
    const sourceDir = path.join(
      projectRoot,
      'container',
      'agent-runner',
      'src',
    );
    const sourceIndex = path.join(sourceDir, 'index.ts');
    const cacheDir = path.join(
      '/tmp/nanoclaw-test-data',
      'sessions',
      'test-group',
      'agent-runner-src',
    );
    const cachedIndex = path.join(cacheDir, 'index.ts');
    const syncMetadata = path.join(cacheDir, '.nanoclaw-source-sync.json');

    const existsSyncMock = vi.mocked(fs.existsSync);
    const statSyncMock = vi.mocked(fs.statSync);
    const readFileSyncMock = vi.mocked(fs.readFileSync);

    existsSyncMock.mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/');
      if (normalized === sourceDir.replace(/\\/g, '/')) return true;
      if (normalized === sourceIndex.replace(/\\/g, '/')) return true;
      if (normalized === cacheDir.replace(/\\/g, '/')) return true;
      if (normalized === cachedIndex.replace(/\\/g, '/')) return true;
      if (normalized === syncMetadata.replace(/\\/g, '/')) return false;
      return false;
    });

    statSyncMock.mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/');
      if (
        normalized === sourceDir.replace(/\\/g, '/') ||
        normalized === cacheDir.replace(/\\/g, '/')
      ) {
        return {
          isDirectory: () => true,
          mtimeMs: 1,
        } as unknown as ReturnType<typeof fs.statSync>;
      }
      return {
        isDirectory: () => false,
        mtimeMs: normalized === cachedIndex.replace(/\\/g, '/') ? 999 : 1,
      } as unknown as ReturnType<typeof fs.statSync>;
    });

    readFileSyncMock.mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/');
      if (normalized === sourceIndex.replace(/\\/g, '/')) {
        return 'export const sourceVersion = "new";' as unknown as ReturnType<
          typeof fs.readFileSync
        >;
      }
      if (normalized === cachedIndex.replace(/\\/g, '/')) {
        return 'export const sourceVersion = "old";' as unknown as ReturnType<
          typeof fs.readFileSync
        >;
      }
      return '' as unknown as ReturnType<typeof fs.readFileSync>;
    });

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'synced',
      newSessionId: 'session-sync',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(fs.cpSync).toHaveBeenCalledWith(sourceDir, cacheDir, {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      syncMetadata,
      expect.stringContaining('"sourceIndexHash"'),
    );
  });
});
