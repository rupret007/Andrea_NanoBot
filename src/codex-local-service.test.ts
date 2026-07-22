import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeRepositoryState {
  root: string;
  branch: string | null;
  head: string;
  tracked: Set<string>;
  baseline: Map<string, string>;
}

const { repositoryStates } = vi.hoisted(() => ({
  repositoryStates: new Map<string, FakeRepositoryState>(),
}));

function listFiles(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(root, absolute));
    else if (entry.isFile()) result.push(path.relative(root, absolute));
  }
  return result.sort();
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (
        executable: string,
        args: readonly string[],
        options?: unknown,
      ): string | Buffer => {
        if (executable !== 'git') {
          return actual.execFileSync(
            executable,
            [...args],
            options as Parameters<typeof actual.execFileSync>[2],
          );
        }
        if (args[0] !== '-C' || typeof args[1] !== 'string') {
          throw new Error('Unexpected fixture Git invocation.');
        }
        const root = fs.realpathSync(args[1]);
        const state = repositoryStates.get(root);
        if (!state) throw new Error(`Unknown fixture repository: ${root}`);
        const command = args.slice(2);
        const joined = command.join(' ');
        if (joined === 'rev-parse --show-toplevel') return root;
        if (joined === 'rev-parse --git-dir') return '.git';
        if (joined === 'rev-parse HEAD') return state.head;
        if (joined === 'symbolic-ref --short HEAD') {
          if (!state.branch) throw new Error('detached HEAD');
          return state.branch;
        }
        if (joined === 'ls-files -z') {
          return (
            [...state.tracked].sort().join('\0') +
            (state.tracked.size ? '\0' : '')
          );
        }
        if (joined === 'status --porcelain --untracked-files=all') {
          return listFiles(root)
            .filter((file) => {
              const content = fs.readFileSync(path.join(root, file), 'utf8');
              return (
                !state.tracked.has(file) || state.baseline.get(file) !== content
              );
            })
            .map((file) =>
              state.tracked.has(file) ? ` M ${file}` : `?? ${file}`,
            )
            .join('\n');
        }
        if (joined === 'diff --binary HEAD') {
          return listFiles(root)
            .filter((file) => {
              const content = fs.readFileSync(path.join(root, file), 'utf8');
              return (
                !state.tracked.has(file) || state.baseline.get(file) !== content
              );
            })
            .map(
              (file) =>
                `${file}\n${fs.readFileSync(path.join(root, file), 'utf8')}`,
            )
            .join('\n');
        }
        if (command[0] === 'worktree' && command[1] === 'add') {
          const target = path.resolve(String(command[3]));
          fs.mkdirSync(target, { recursive: true });
          fs.mkdirSync(path.join(target, '.git'));
          for (const file of state.tracked) {
            const destination = path.join(target, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(root, file), destination);
          }
          const canonicalTarget = fs.realpathSync(target);
          repositoryStates.set(canonicalTarget, {
            root: canonicalTarget,
            branch: null,
            head: state.head,
            tracked: new Set(state.tracked),
            baseline: new Map(state.baseline),
          });
          return '';
        }
        if (command[0] === 'worktree' && command[1] === 'remove') {
          const target = path.resolve(String(command.at(-1)));
          if (fs.existsSync(target)) {
            const canonicalTarget = fs.realpathSync(target);
            repositoryStates.delete(canonicalTarget);
            fs.rmSync(target, { recursive: true, force: true });
          }
          return '';
        }
        throw new Error(`Unexpected fixture Git query: ${joined}`);
      },
    ),
  };
});

import {
  CodexLocalJobService,
  CodexLocalServiceError,
  createCodexLocalHttpServer,
  type CodexLocalServiceConfig,
} from './codex-local-service.js';
import { AndreaOpenAiBackendClient } from './andrea-openai-backend.js';

const temporaryRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-codex-service-'));
  temporaryRoots.push(root);
  return root;
}

function createRepository(parent: string, name = 'repo'): string {
  const repository = path.join(parent, name);
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(path.join(repository, '.git'));
  fs.writeFileSync(path.join(repository, 'README.md'), '# Fixture\n');
  const canonical = fs.realpathSync(repository);
  repositoryStates.set(canonical, {
    root: canonical,
    branch: 'main',
    head: 'a'.repeat(40),
    tracked: new Set(['README.md']),
    baseline: new Map([['README.md', '# Fixture\n']]),
  });
  return canonical;
}

function trackFile(repository: string, relativePath: string): void {
  const state = repositoryStates.get(fs.realpathSync(repository));
  if (!state) throw new Error('Unknown fixture repository.');
  state.tracked.add(relativePath);
  state.baseline.set(
    relativePath,
    fs.readFileSync(path.join(repository, relativePath), 'utf8'),
  );
}

function createFakeCodex(root: string): string {
  const target = path.join(root, 'fake-codex.mjs');
  fs.writeFileSync(
    target,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-codex 1.0.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('authenticated'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk.toString('utf8');
const outputIndex = args.indexOf('-o');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
console.log(JSON.stringify({ type: 'thread.started', thread_id: '11111111-2222-4333-8444-555555555555' }));
if (/SLOW/.test(input)) await new Promise((resolve) => setTimeout(resolve, 600));
if (/edit/i.test(input)) fs.writeFileSync('changed.txt', 'verified fixture change\\n');
if (/UNAUTHORIZED_WRITE/.test(input)) fs.writeFileSync('escaped.txt', 'unexpected\\n');
const message = /FALSE_CLAIMS/.test(input) ? 'All tests passed, pushed, deployed, and messaged the team.' : 'Fake Codex completed.';
if (outputFile) fs.writeFileSync(outputFile, message);
console.log(JSON.stringify({ type: 'item.completed', text: message }));
process.exit(/FAIL/.test(input) ? 2 : 0);
`,
    { mode: 0o700 },
  );
  fs.chmodSync(target, 0o700);
  return target;
}

function config(root: string, repository: string): CodexLocalServiceConfig {
  return {
    host: '127.0.0.1',
    port: 3210,
    stateDir: path.join(root, 'state'),
    allowedRepositoryRoots: [root],
    repositoryByGroup: { main: repository },
    defaultRepositoryRoot: null,
    codexBinary: process.execPath,
    codexArgsPrefix: [createFakeCodex(root)],
    maxConcurrentJobs: 1,
    jobTimeoutMs: 5_000,
    buildIdentity: 'test-build',
    verificationCommands: [],
  };
}

function serviceWithRepository(
  options: {
    verificationCommands?: string[][];
    timeoutMs?: number;
  } = {},
): {
  root: string;
  repository: string;
  service: CodexLocalJobService;
} {
  const root = tempRoot();
  const repository = createRepository(root);
  const resolved = config(root, repository);
  if (options.verificationCommands) {
    resolved.verificationCommands = options.verificationCommands;
  }
  if (options.timeoutMs) resolved.jobTimeoutMs = options.timeoutMs;
  const service = new CodexLocalJobService(resolved, {
    ...process.env,
    HOME: process.env.HOME,
  });
  service.prepareStorage();
  service.registerGroup('main', { jid: 'tg:owner', name: 'Main' });
  return { root, repository, service };
}

async function waitForTerminal(
  service: CodexLocalJobService,
  jobId: string,
  timeoutMs = 5_000,
) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    const stored = service.getJob(jobId);
    if (
      stored.publicJob.status === 'succeeded' ||
      stored.publicJob.status === 'failed'
    ) {
      return stored;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} did not finish`);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  repositoryStates.clear();
});

describe('CodexLocalJobService', () => {
  it('proves binary, authentication, private state, and loopback service identity', () => {
    const { service } = serviceWithRepository();
    const status = service.getStatus();

    expect(status.meta).toMatchObject({
      backend: 'andrea_openai',
      ready: true,
      authState: 'authenticated',
      localExecutionState: 'available_authenticated',
    });
    expect(status.serviceIdentity).toMatchObject({
      buildIdentity: 'test-build',
      statePermissions: 0o700,
    });
    expect(status.serviceIdentity.configFingerprint).toMatch(/^sha256:/);
  });

  it('creates an isolated worktree and preserves a dirty serving checkout', async () => {
    const { repository, service } = serviceWithRepository();
    fs.writeFileSync(
      path.join(repository, 'owner-uncommitted.txt'),
      'preserve me\n',
    );
    const job = service.createJob({
      groupFolder: 'main',
      prompt: 'Implement an edit in the repository',
      requestedRuntime: 'codex_local',
      source: { system: 'test' },
    });
    const stored = await waitForTerminal(service, job.jobId);

    expect(stored.publicJob.status).toBe('succeeded');
    expect(stored.worktreeRoot).not.toBe(repository);
    expect(stored.worktreeRoot).toContain(
      `${path.sep}state${path.sep}worktrees${path.sep}`,
    );
    expect(fs.existsSync(path.join(stored.worktreeRoot, 'changed.txt'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(repository, 'changed.txt'))).toBe(false);
    expect(
      fs.readFileSync(path.join(repository, 'owner-uncommitted.txt'), 'utf8'),
    ).toBe('preserve me\n');
    expect(stored.codingWorkResult).toMatchObject({
      agentOutputTrusted: false,
      verification: { status: 'verified' },
    });
  });

  it('keeps agent completion language untrusted and records only independently proven claims', async () => {
    const { service } = serviceWithRepository();
    const job = service.createJob({
      groupFolder: 'main',
      prompt: 'Implement an edit FALSE_CLAIMS',
      source: { system: 'test' },
    });
    const stored = await waitForTerminal(service, job.jobId);
    const claimKinds = stored.codingWorkResult?.claims.map(
      (claim) => claim.kind,
    );

    expect(stored.publicJob.finalOutputText).toContain('claims remain bounded');
    expect(claimKinds).toContain('files_changed');
    expect(claimKinds).not.toContain('tests_passed');
    expect(claimKinds).not.toContain('pushed');
    expect(claimKinds).not.toContain('deployed');
  });

  it('rejects separately gated external operations before starting Codex', () => {
    const { service } = serviceWithRepository();
    expect(() =>
      service.createJob({
        groupFolder: 'main',
        prompt: 'Implement this, push it, deploy it, and message the team',
        source: { system: 'test' },
      }),
    ).toThrowError(/separately gated operations/);
    expect(service.getStatus().queue).toMatchObject({ active: 0, pending: 0 });
  });

  it('rejects repositories outside the allowlist and repository-root symlinks', () => {
    const root = tempRoot();
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    const outsideRepository = createRepository(outside);
    const linkedRepository = path.join(allowed, 'linked-repo');
    fs.symlinkSync(outsideRepository, linkedRepository);
    const base = config(root, outsideRepository);
    base.allowedRepositoryRoots = [allowed];
    const outsideService = new CodexLocalJobService(base);
    outsideService.prepareStorage();
    outsideService.registerGroup('main', { jid: 'tg:owner' });
    expect(() =>
      outsideService.createJob({
        groupFolder: 'main',
        prompt: 'Analyze the repository',
        source: { system: 'test' },
      }),
    ).toThrowError(/outside every approved root/);

    const symlinkConfig = {
      ...base,
      repositoryByGroup: { main: linkedRepository },
    };
    const symlinkService = new CodexLocalJobService(symlinkConfig);
    symlinkService.prepareStorage();
    symlinkService.registerGroup('main', { jid: 'tg:owner' });
    expect(() =>
      symlinkService.createJob({
        groupFolder: 'main',
        prompt: 'Analyze the repository',
        source: { system: 'test' },
      }),
    ).toThrowError(/symbolic link/);
  });

  it('blocks a tracked secret-sensitive path from the delegated worktree', () => {
    const root = tempRoot();
    const repository = createRepository(root);
    fs.writeFileSync(path.join(repository, '.env'), 'SECRET=fixture\n');
    trackFile(repository, '.env');
    const service = new CodexLocalJobService(config(root, repository));
    service.prepareStorage();
    service.registerGroup('main', { jid: 'tg:owner' });

    expect(() =>
      service.createJob({
        groupFolder: 'main',
        prompt: 'Analyze the repository',
        source: { system: 'test' },
      }),
    ).toThrowError(/secret-sensitive path/);
  });

  it('enforces concurrency and supports cancellation without losing the queued job', async () => {
    const { service } = serviceWithRepository();
    const first = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze SLOW',
      source: { system: 'test' },
    });
    const second = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze the second task',
      source: { system: 'test' },
    });

    expect(service.getStatus().queue).toMatchObject({
      active: 1,
      pending: 1,
      limit: 1,
    });
    expect(service.getJob(second.jobId).publicJob.status).toBe('queued');
    const stopped = service.stopJob(first.jobId);
    expect(stopped.liveStopAccepted).toBe(true);
    expect(
      (await waitForTerminal(service, first.jobId)).publicJob.errorText,
    ).toMatch(/cancelled/i);
    expect(
      (await waitForTerminal(service, second.jobId)).publicJob.status,
    ).toBe('succeeded');
  });

  it('times out a stuck invocation and preserves truthful failure', async () => {
    const { service } = serviceWithRepository({ timeoutMs: 80 });
    const job = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze SLOW',
      source: { system: 'test' },
    });
    const stored = await waitForTerminal(service, job.jobId);
    expect(stored.publicJob.status).toBe('failed');
    expect(stored.publicJob.errorText).toMatch(/timed out/);
  });

  it('cancels queued and active work during bounded service shutdown', async () => {
    const { service } = serviceWithRepository();
    const active = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze SLOW',
      source: { system: 'test' },
    });
    const queued = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze the queued task',
      source: { system: 'test' },
    });

    await service.shutdown(500);

    expect(service.getStatus().queue).toMatchObject({ active: 0, pending: 0 });
    expect(service.getJob(active.jobId).publicJob.errorText).toMatch(
      /cancelled/i,
    );
    expect(service.getJob(queued.jobId).publicJob.errorText).toMatch(
      /cancelled/i,
    );
  });

  it('resumes the exact proven thread and same isolated worktree', async () => {
    const { service } = serviceWithRepository();
    const parent = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze the implementation',
      source: { system: 'test' },
    });
    const parentStored = await waitForTerminal(service, parent.jobId);
    expect(parentStored.threadId).toBe('11111111-2222-4333-8444-555555555555');

    const followUp = service.followUp(parent.jobId, {
      prompt: 'Implement an edit from the analysis',
      source: { system: 'test' },
    });
    const followUpStored = await waitForTerminal(service, followUp.jobId);
    expect(followUpStored.publicJob.parentJobId).toBe(parent.jobId);
    expect(followUpStored.threadId).toBe(parentStored.threadId);
    expect(followUpStored.worktreeRoot).toBe(parentStored.worktreeRoot);
    expect(
      fs.existsSync(path.join(followUpStored.worktreeRoot, 'changed.txt')),
    ).toBe(true);
  });

  it('supports the collection follow-up contract by exact group continuity', async () => {
    const { service } = serviceWithRepository();
    const parent = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze the implementation',
      source: { system: 'test' },
    });
    await waitForTerminal(service, parent.jobId);

    const followUp = service.followUpTarget({
      groupFolder: 'main',
      prompt: 'Continue the exact proven thread',
      source: { system: 'test' },
    });
    const stored = await waitForTerminal(service, followUp.jobId);
    expect(stored.publicJob.parentJobId).toBe(parent.jobId);
    expect(stored.threadId).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('cleans only terminal clean worktrees and preserves work products', async () => {
    const { service } = serviceWithRepository();
    const clean = service.createJob({
      groupFolder: 'main',
      prompt: 'Analyze the implementation',
      source: { system: 'test' },
    });
    const cleanStored = await waitForTerminal(service, clean.jobId);
    expect(service.cleanupJob(clean.jobId)).toMatchObject({ cleaned: true });
    expect(fs.existsSync(cleanStored.worktreeRoot)).toBe(false);

    const dirty = service.createJob({
      groupFolder: 'main',
      prompt: 'Implement an edit',
      source: { system: 'test' },
    });
    const dirtyStored = await waitForTerminal(service, dirty.jobId);
    expect(() => service.cleanupJob(dirty.jobId)).toThrowError(/preserved/);
    expect(fs.existsSync(dirtyStored.worktreeRoot)).toBe(true);
  });

  it('preserves the existing loopback HTTP client contract end to end', async () => {
    const { service } = serviceWithRepository();
    const server = createCodexLocalHttpServer(service);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Fixture server did not expose a TCP address.');
      }
      const client = new AndreaOpenAiBackendClient({
        enabled: true,
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 5_000,
      });
      const status = await client.getStatus();
      expect(status.state).toBe('available');
      const job = await client.createJob({
        groupFolder: 'main',
        prompt: 'Analyze through the HTTP contract',
        requestedRuntime: 'codex_local',
        source: { system: 'test' },
      });
      await waitForTerminal(service, job.jobId);
      expect((await client.getJob(job.jobId)).codingWorkResult).not.toBeNull();
      expect((await client.getJobLogs({ jobId: job.jobId })).jobId).toBe(
        job.jobId,
      );
      const followUp = await client.followUpTarget({
        groupFolder: 'main',
        prompt: 'Continue through the collection route',
        source: { system: 'test' },
      });
      expect(followUp.parentJobId).toBe(job.jobId);
      await waitForTerminal(service, followUp.jobId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails independent verification and never creates a tests-passed claim', async () => {
    const { service } = serviceWithRepository({
      verificationCommands: [[process.execPath, '-e', 'process.exit(1)']],
    });
    const job = service.createJob({
      groupFolder: 'main',
      prompt: 'Implement an edit and test it',
      source: { system: 'test' },
    });
    const stored = await waitForTerminal(service, job.jobId);
    expect(stored.codingWorkResult?.testSummaries).toEqual([
      'verification command 1: failed',
    ]);
    expect(
      stored.codingWorkResult?.claims.map((claim) => claim.kind),
    ).not.toContain('tests_passed');
  });

  it('returns typed validation errors without leaking configured paths', () => {
    const { service } = serviceWithRepository();
    let thrown: unknown;
    try {
      service.createJob({
        groupFolder: '../escape',
        prompt: 'Analyze this',
        source: { system: 'test' },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexLocalServiceError);
    expect(thrown).toMatchObject({ status: 400, code: 'validation_error' });
    expect(String(thrown)).not.toContain(service.config.stateDir);
  });
});
