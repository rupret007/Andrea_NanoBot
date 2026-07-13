import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
function isLocalGatewayStatePath(candidatePath: unknown): boolean {
  return String(candidatePath)
    .replace(/\\/g, '/')
    .endsWith('/nanoclaw-test-runtime/openai-gateway-state.json');
}

const { spawnMock, applyContainerConfigMock, mockEnvStore } = vi.hoisted(
  () => ({
    spawnMock: vi.fn(),
    applyContainerConfigMock: vi.fn(),
    mockEnvStore: { values: {} as Record<string, string> },
  }),
);

// Mock config
vi.mock('./config.js', () => ({
  AGENT_RUNTIME_DEFAULT: 'codex_local',
  AGENT_RUNTIME_FALLBACK: 'openai_cloud',
  CODEX_LOCAL_ENABLED: true,
  CODEX_LOCAL_MODEL: '',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_INITIAL_OUTPUT_TIMEOUT: 300000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
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

// Mock env reader
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = mockEnvStore.values[key];
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
  getContainerRuntimeHostAlias: () => 'host.docker.internal',
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

import {
  buildContainerChildEnv,
  runContainerAgent,
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

function spawnedEnvironment(): NodeJS.ProcessEnv {
  return (
    (spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv })?.env || {}
  );
}

async function waitForSpawnCall(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (spawnMock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('spawn was not called');
}

// container-runner prefers process.env over the mocked env file, so ambient
// host credentials (e.g. ANTHROPIC_BASE_URL exported by an IDE or agent
// harness) must be cleared for these tests to stay hermetic.
const AMBIENT_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'MINIMAX_ENABLED',
  'MINIMAX_API_KEY',
  'MINIMAX_ANTHROPIC_BASE_URL',
  'MINIMAX_OPENAI_BASE_URL',
  'MINIMAX_MODEL_COMPLEX',
  'CURSOR_GATEWAY_HINT',
  'NANOCLAW_AGENT_MODEL',
  'CLAUDE_CODE_MODEL',
  'CLAUDE_MODEL',
] as const;

describe('container-runner credential env wiring', () => {
  beforeEach(() => {
    for (const key of AMBIENT_CREDENTIAL_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    mockEnvStore.values = {};
    fakeProc = createFakeProcess();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeProc);
    applyContainerConfigMock.mockReset();
    applyContainerConfigMock.mockResolvedValue(true);
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves only explicit cross-platform runtime discovery variables', () => {
    const child = buildContainerChildEnv({}, ['run'], {
      PATH: 'runtime-path',
      USERPROFILE: 'C:\\Users\\Andrea',
      APPDATA: 'C:\\Users\\Andrea\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Andrea\\AppData\\Local',
      DOCKER_CERT_PATH: 'C:\\docker-certs',
      DOCKER_TLS_VERIFY: '1',
      PODMAN_HOST: 'ssh://podman.example',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      OPENAI_API_KEY: 'must-not-leak',
    });

    expect(child).toMatchObject({
      PATH: 'runtime-path',
      USERPROFILE: 'C:\\Users\\Andrea',
      APPDATA: 'C:\\Users\\Andrea\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Andrea\\AppData\\Local',
      DOCKER_CERT_PATH: 'C:\\docker-certs',
      DOCKER_TLS_VERIFY: '1',
      PODMAN_HOST: 'ssh://podman.example',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(child.OPENAI_API_KEY).toBeUndefined();
  });

  it('passes ANTHROPIC_BASE_URL into container args when OneCLI is active', async () => {
    mockEnvStore.values = {
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
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    );
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe(
      'onecli-placeholder',
    );
  });

  it('rejects undocumented OneCLI environment controls before spawn', async () => {
    const opaqueSecret = 'onecli-opaque-runtime-secret';
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push('-e', `ONECLI_SESSION_SECRET=${opaqueSecret}`);
      return true;
    });

    await expect(
      runContainerAgent(testGroup, testInput, () => {}),
    ).rejects.toThrow(/unsupported environment key/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(
      JSON.stringify(vi.mocked(fs.writeFileSync).mock.calls),
    ).not.toContain(opaqueSecret);
  });

  it('rejects executable-control env returned by OneCLI', async () => {
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'NODE_OPTIONS=--import=/tmp/evil.mjs');
      return true;
    });

    await expect(
      runContainerAgent(testGroup, testInput, () => {}),
    ).rejects.toThrow(/unsupported environment key/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts only the documented OneCLI proxy environment surface', async () => {
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'HTTP_PROXY=http://host.docker.internal:10255');
      args.push('-e', 'HTTPS_PROXY=http://host.docker.internal:10255');
      args.push('-e', 'NO_PROXY=localhost,127.0.0.1');
      return true;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-e', 'HTTPS_PROXY']));
    expect(args.join(' ')).not.toContain('host.docker.internal:10255');
    expect(spawnedEnvironment().HTTPS_PROXY).toBe(
      'http://host.docker.internal:10255',
    );
  });

  it('rejects token-bearing OneCLI proxy URLs before spawn', async () => {
    applyContainerConfigMock.mockImplementation(async (args: string[]) => {
      args.push(
        '-e',
        'HTTPS_PROXY=http://host.docker.internal:10255/?token=opaque-secret',
      );
      return true;
    });

    await expect(
      runContainerAgent(testGroup, testInput, () => {}),
    ).rejects.toThrow(/unsafe proxy URL/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing runtime endpoint URLs before spawn', async () => {
    mockEnvStore.values = {
      ANTHROPIC_BASE_URL:
        'https://user:opaque-secret@compat.example.com/v1?token=opaque-secret',
    };

    await expect(
      runContainerAgent(testGroup, testInput, () => {}),
    ).rejects.toThrow(/Runtime endpoint URL is unsafe/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(
      JSON.stringify(vi.mocked(fs.writeFileSync).mock.calls),
    ).not.toContain('opaque-secret');
  });

  it('keeps MiniMax credentials behind OneCLI when the gateway is active', async () => {
    mockEnvStore.values = {
      MINIMAX_ENABLED: 'true',
      MINIMAX_API_KEY: 'sk-minimax-123',
      MINIMAX_ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      MINIMAX_OPENAI_BASE_URL: 'https://api.minimax.io/v1',
      MINIMAX_MODEL_COMPLEX: 'MiniMax-M3',
      ANTHROPIC_API_KEY: 'dummy-anthropic-key-should-not-be-used',
      OPENAI_API_KEY: 'dummy-openai-key-should-not-be-used',
    };

    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        preferredRuntime: 'minimax_cloud' as const,
      },
      () => {},
    );
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic',
        '-e',
        'OPENAI_BASE_URL=https://api.minimax.io/v1',
        '-e',
        'NANOCLAW_RUNTIME_PROVIDER=minimax',
        '-e',
        'NANOCLAW_AGENT_MODEL=MiniMax-M3',
        '-e',
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    );
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe(
      'onecli-placeholder',
    );
    expect(JSON.stringify(spawnMock.mock.calls)).not.toContain(
      'sk-minimax-123',
    );
    expect(args).not.toContain(
      'ANTHROPIC_API_KEY=dummy-anthropic-key-should-not-be-used',
    );
    expect(args).not.toContain(
      'OPENAI_API_KEY=dummy-openai-key-should-not-be-used',
    );
  });

  it('injects only the selected MiniMax credential in degraded fallback mode', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
      MINIMAX_ENABLED: 'true',
      MINIMAX_API_KEY: 'sk-minimax-fallback',
      MINIMAX_ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      MINIMAX_OPENAI_BASE_URL: 'https://api.minimax.io/v1',
      ANTHROPIC_API_KEY: 'unselected-anthropic-key',
      OPENAI_API_KEY: 'unselected-openai-key',
    };

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, preferredRuntime: 'minimax_cloud' as const },
      () => {},
    );
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'ANTHROPIC_AUTH_TOKEN']),
    );
    expect(args.join(' ')).not.toContain('sk-minimax-fallback');
    expect(spawnedEnvironment()).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'sk-minimax-fallback',
    });
    expect(spawnedEnvironment().ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnedEnvironment().OPENAI_API_KEY).toBeUndefined();
  });

  it('rewrites localhost Anthropic endpoint to runtime host alias when OneCLI is active', async () => {
    mockEnvStore.values = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'ANTHROPIC_BASE_URL=http://host.docker.internal:20128/v1',
        '-e',
        'NANOCLAW_AGENT_MODEL=cu/default',
        '-e',
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    );
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe(
      'onecli-placeholder',
    );
  });

  it('keeps explicit model override even when endpoint matches 9router', async () => {
    mockEnvStore.values = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
      NANOCLAW_AGENT_MODEL: 'cu/gpt-5',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'NANOCLAW_AGENT_MODEL=cu/gpt-5']),
    );
    expect(args).not.toContain('NANOCLAW_AGENT_MODEL=cu/default');
  });

  it('defaults model override when remote cursor gateway is explicitly hinted', async () => {
    mockEnvStore.values = {
      ANTHROPIC_BASE_URL: 'https://cursor-bridge.example.com/v1',
      CURSOR_GATEWAY_HINT: '9router',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'NANOCLAW_AGENT_MODEL=cu/default']),
    );
  });

  it('maps OPENAI_BASE_URL to ANTHROPIC_BASE_URL when OneCLI is active', async () => {
    mockEnvStore.values = {
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
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    );
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe(
      'onecli-placeholder',
    );
  });

  it('bridges OPENAI_API_KEY to ANTHROPIC_AUTH_TOKEN in fallback mode', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
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
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    );
    expect(args).not.toContain('OPENAI_API_KEY');
    expect(spawnedEnvironment().OPENAI_API_KEY).toBeUndefined();
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe('sk-openai-123');
  });

  it('keeps explicit ANTHROPIC_AUTH_TOKEN without overriding it from OPENAI_API_KEY', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
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
      expect.arrayContaining(['-e', 'ANTHROPIC_AUTH_TOKEN']),
    );
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe('token-explicit');
    expect(args).not.toContain('OPENAI_API_KEY');
    expect(spawnedEnvironment().OPENAI_API_KEY).toBeUndefined();
    expect(args).not.toContain('ANTHROPIC_AUTH_TOKEN=sk-openai-123');
  });

  it('bridges OPENAI_BASE_URL + OPENAI_API_KEY in fallback mode', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
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
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    );
    expect(args).not.toContain('OPENAI_API_KEY');
    expect(spawnedEnvironment().OPENAI_API_KEY).toBeUndefined();
    expect(spawnedEnvironment().ANTHROPIC_AUTH_TOKEN).toBe('sk-openai-123');
  });

  it('scrubs unrelated host secrets from the container runtime child process', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'brave-secret-must-not-pass');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret-must-not-pass');
    vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'internal-metadata');
    mockEnvStore.values = {
      ANTHROPIC_API_KEY: 'selected-anthropic-key',
    };
    applyContainerConfigMock.mockResolvedValue(false);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    expect(spawnedEnvironment().ANTHROPIC_API_KEY).toBe(
      'selected-anthropic-key',
    );
    expect(spawnedEnvironment().BRAVE_API_KEY).toBeUndefined();
    expect(spawnedEnvironment().TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(
      spawnedEnvironment().CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
    ).toBeUndefined();
  });

  it('redacts fallback secrets from error log output', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
      ANTHROPIC_BASE_URL: 'https://compat.example.com',
      OPENAI_API_KEY: 'sk-openai-123',
    };

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    fakeProc.stderr.write('opaque failure sk-openai-123\n');
    fakeProc.emit('close', 1);
    const result = await resultPromise;

    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('sk-openai-123');

    const writes = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) =>
        typeof call[1] === 'string' ? call[1] : String(call[1]),
      );

    expect(writes.some((content) => content.includes('sk-openai-123'))).toBe(
      false,
    );
    expect(
      writes.some((content) => content.includes('ANTHROPIC_AUTH_TOKEN')),
    ).toBe(true);
  });

  it('redacts selected credentials from structured container output', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = { ANTHROPIC_API_KEY: 'opaque-selected-secret' };
    const onOutput = vi.fn(async () => {});

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );
    await waitForSpawnCall();
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({
        status: 'success',
        result: 'tool echoed opaque-selected-secret',
        newSessionId: 'sess-redacted',
      })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    const result = await resultPromise;

    expect(JSON.stringify(onOutput.mock.calls)).not.toContain(
      'opaque-selected-secret',
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'tool echoed [REDACTED]' }),
    );
    expect(JSON.stringify(result)).not.toContain('opaque-selected-secret');
  });

  it('rewrites local host endpoint to local gateway container binding when state exists', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
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

  it('preserves explicit local custom endpoint port instead of forcing local gateway binding', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
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
    expect(args).not.toContain('nanoclaw-openai');
    expect(args).toEqual(
      expect.arrayContaining([
        '-e',
        'ANTHROPIC_BASE_URL=http://host.docker.internal:20128/v1',
      ]),
    );
  });

  it('does not force local gateway when Anthropic direct credentials are configured without endpoint override', async () => {
    applyContainerConfigMock.mockResolvedValue(false);
    mockEnvStore.values = {
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
    expect(args).toContain('ANTHROPIC_API_KEY');
    expect(args).not.toContain('OPENAI_API_KEY');
    expect(spawnedEnvironment().OPENAI_API_KEY).toBeUndefined();
  });

  it('does not copy or mount a per-group Codex home', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const normalizedArgs = args.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).not.toContain('/home/node/.codex');
    expect(normalizedArgs).not.toContain('/sessions/test-group/.codex');
    expect(normalizedArgs).not.toContain('CODEX_HOME');
    expect(vi.mocked(fs.writeFileSync).mock.calls).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.stringMatching(/\.codex\/auth\.json$/)]),
      ]),
    );
  });

  it('does not expose host Codex state to direct-assistant routes', async () => {
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
    );
    await waitForSpawnCall();
    emitSuccessfulExit(fakeProc);
    await resultPromise;

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const normalizedArgs = args.join(' ').replace(/\\/g, '/');
    expect(normalizedArgs).not.toContain('/home/node/.codex');
    expect(normalizedArgs).not.toContain('/.codex:');
    expect(normalizedArgs).not.toContain('CODEX_HOME');
  });
});
