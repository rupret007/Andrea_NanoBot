import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
function isLocalGatewayStatePath(candidatePath: unknown): boolean {
  return String(candidatePath)
    .replace(/\\/g, '/')
    .endsWith('/nanoclaw-test-runtime/openai-gateway-state.json');
}

const { spawnMock, applyContainerConfigMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  applyContainerConfigMock: vi.fn(),
}));
let mockEnvValues: Record<string, string> = {};

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_INITIAL_OUTPUT_TIMEOUT: 300000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
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

// Mock env reader
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = mockEnvValues[key];
      if (value) result[key] = value;
    }
    return result;
  }),
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
    applyContainerConfig = applyContainerConfigMock;
  },
}));

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

let fakeProc = createFakeProcess();

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: Parameters<typeof spawnMock>) => spawnMock(...args),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent } from './container-runner.js';
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

function emitSuccessfulExit(proc: ReturnType<typeof createFakeProcess>): void {
  const payload = JSON.stringify({
    status: 'success',
    result: 'ok',
    newSessionId: 'sess-1',
  });
  proc.stdout.push(
    `${OUTPUT_START_MARKER}\n${payload}\n${OUTPUT_END_MARKER}\n`,
  );
  proc.emit('close', 0);
}

async function waitForSpawnCall(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (spawnMock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('spawn was not called');
}

describe('container-runner credential env wiring', () => {
  beforeEach(() => {
    mockEnvValues = {};
    fakeProc = createFakeProcess();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeProc);
    applyContainerConfigMock.mockReset();
    applyContainerConfigMock.mockResolvedValue(true);
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
  });

  it('passes ANTHROPIC_BASE_URL into container args when OneCLI is active', async () => {
    mockEnvValues = {
      ANTHROPIC_BASE_URL: 'https://compat.example.com',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'ANTHROPIC_BASE_URL=https://compat.example.com',
        '-e',
        'ANTHROPIC_AUTH_TOKEN=onecli-placeholder',
      ]),
    );
  });

  it('maps OPENAI_BASE_URL to ANTHROPIC_BASE_URL when OneCLI is active', async () => {
    mockEnvValues = {
      OPENAI_BASE_URL: 'https://openai-compat.example.com',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'OPENAI_BASE_URL=https://openai-compat.example.com',
        '-e',
        'ANTHROPIC_BASE_URL=https://openai-compat.example.com',
        '-e',
        'ANTHROPIC_AUTH_TOKEN=onecli-placeholder',
      ]),
    );
  });

  it('bridges OPENAI_API_KEY to ANTHROPIC_AUTH_TOKEN in fallback mode', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvValues = {
      ANTHROPIC_BASE_URL: 'https://compat.example.com',
      OPENAI_API_KEY: 'sk-openai-123',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'ANTHROPIC_BASE_URL=https://compat.example.com',
        '-e',
        'OPENAI_API_KEY=sk-openai-123',
        '-e',
        'ANTHROPIC_AUTH_TOKEN=sk-openai-123',
      ]),
    );
  });

  it('keeps explicit ANTHROPIC_AUTH_TOKEN without overriding it from OPENAI_API_KEY', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvValues = {
      ANTHROPIC_BASE_URL: 'https://compat.example.com',
      OPENAI_API_KEY: 'sk-openai-123',
      ANTHROPIC_AUTH_TOKEN: 'token-explicit',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'ANTHROPIC_AUTH_TOKEN=token-explicit']),
    );
    expect(args).not.toContain('ANTHROPIC_AUTH_TOKEN=sk-openai-123');
  });

  it('bridges OPENAI_BASE_URL + OPENAI_API_KEY in fallback mode', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvValues = {
      OPENAI_BASE_URL: 'https://openai-compat.example.com',
      OPENAI_API_KEY: 'sk-openai-123',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'OPENAI_BASE_URL=https://openai-compat.example.com',
        '-e',
        'ANTHROPIC_BASE_URL=https://openai-compat.example.com',
        '-e',
        'OPENAI_API_KEY=sk-openai-123',
        '-e',
        'ANTHROPIC_AUTH_TOKEN=sk-openai-123',
      ]),
    );
  });

  it('redacts fallback secrets from error log output', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvValues = {
      ANTHROPIC_BASE_URL: 'https://compat.example.com',
      OPENAI_API_KEY: 'sk-openai-123',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    fakeProc.emit('close', 1);
    const result = await resultPromise;

    expect(result.status).toBe('error');

    const writes = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) =>
        typeof call[1] === 'string' ? call[1] : String(call[1]),
      );

    expect(writes.some((content) => content.includes('sk-openai-123'))).toBe(
      false,
    );
    expect(
      writes.some((content) => content.includes('OPENAI_API_KEY=***')),
    ).toBe(true);
  });

  it('rewrites local host endpoint to local gateway container binding when state exists', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvValues = {
      ANTHROPIC_BASE_URL: 'http://host.containers.internal:4000',
      OPENAI_API_KEY: 'sk-openai-123',
    };
    vi.mocked(fs.existsSync).mockImplementation((candidatePath) =>
      isLocalGatewayStatePath(candidatePath),
    );
    vi.mocked(fs.readFileSync).mockImplementation((candidatePath) => {
      if (isLocalGatewayStatePath(candidatePath)) {
        return JSON.stringify({
          runtime: 'docker',
          network: 'nanoclaw-openai',
          endpoint: 'http://litellm-gateway:4000',
        });
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '--network',
        'nanoclaw-openai',
        '-e',
        'ANTHROPIC_BASE_URL=http://litellm-gateway:4000',
      ]),
    );
  });

  it('does not force local gateway when Anthropic direct credentials are configured without endpoint override', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvValues = {
      ANTHROPIC_API_KEY: 'sk-ant-123',
      OPENAI_API_KEY: 'sk-openai-123',
    };
    vi.mocked(fs.existsSync).mockImplementation((candidatePath) =>
      isLocalGatewayStatePath(candidatePath),
    );
    vi.mocked(fs.readFileSync).mockImplementation((candidatePath) => {
      if (isLocalGatewayStatePath(candidatePath)) {
        return JSON.stringify({
          runtime: 'docker',
          network: 'nanoclaw-openai',
          endpoint: 'http://litellm-gateway:4000',
        });
      }
      return '';
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--network');
    expect(args).not.toContain(
      'ANTHROPIC_BASE_URL=http://litellm-gateway:4000',
    );
  });
});
