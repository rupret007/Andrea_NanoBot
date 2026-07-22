import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CodexLocalJobService,
  type CodexLocalServiceConfig,
} from '../src/codex-local-service.js';

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  ).trim();
}

function createRepository(root: string): string {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.email', 'andrea-fixture@example.invalid');
  git(repository, 'config', 'user.name', 'Andrea Fixture');
  fs.writeFileSync(path.join(repository, 'README.md'), 'base-state\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '--quiet', '-m', 'fixture');
  return fs.realpathSync(repository);
}

function createFakeCodex(root: string): string {
  const target = path.join(root, 'fake-codex.mjs');
  fs.writeFileSync(
    target,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fixture-codex 1.0.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('authenticated'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk.toString('utf8');
const outputIndex = args.indexOf('-o');
if (/follow-up/i.test(input)) fs.writeFileSync('continued.txt', 'same-worktree continuation\\n');
else fs.writeFileSync('implemented.txt', 'isolated verified change\\n');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'I pushed and deployed everything; all tests passed.');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
console.log(JSON.stringify({ type: 'item.completed', text: 'provider assertion only' }));
`,
    { mode: 0o700 },
  );
  fs.chmodSync(target, 0o700);
  return target;
}

async function waitForTerminal(
  service: CodexLocalJobService,
  jobId: string,
): Promise<ReturnType<CodexLocalJobService['getJob']>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const stored = service.getJob(jobId);
    if (
      stored.publicJob.status === 'succeeded' ||
      stored.publicJob.status === 'failed'
    ) {
      return stored;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fixture job ${jobId} did not reach a terminal state`);
}

const root = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'andrea-coding-agency-real-git-'),
);
try {
  const repository = createRepository(root);
  const headBefore = git(repository, 'rev-parse', 'HEAD');
  fs.writeFileSync(
    path.join(repository, 'owner-dirty.txt'),
    'preserve-owner-state\n',
  );
  const config: CodexLocalServiceConfig = {
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
    buildIdentity: 'real-git-fixture',
    verificationCommands: [
      [process.execPath, '-e', "process.stdout.write('fixture-pass')"],
    ],
  };
  const service = new CodexLocalJobService(config, {
    ...process.env,
    HOME: process.env.HOME,
  });
  service.prepareStorage();
  service.registerGroup('main', { jid: 'fixture:owner', name: 'Fixture' });

  const created = service.createJob({
    groupFolder: 'main',
    prompt: 'Implement the fixture and test it',
    source: { system: 'real_git_fixture' },
  });
  const result = await waitForTerminal(service, created.jobId);
  assert.equal(result.publicJob.status, 'succeeded');
  assert.notEqual(result.worktreeRoot, repository);
  assert.equal(
    fs.existsSync(path.join(result.worktreeRoot, 'implemented.txt')),
    true,
  );
  assert.equal(fs.existsSync(path.join(repository, 'implemented.txt')), false);
  assert.equal(
    fs.readFileSync(path.join(repository, 'owner-dirty.txt'), 'utf8'),
    'preserve-owner-state\n',
  );
  assert.equal(git(repository, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repository, 'remote'), '');
  assert.equal(result.codingWorkResult?.agentOutputTrusted, false);
  assert.deepEqual(
    result.codingWorkResult?.claims.map((claim) => claim.kind).sort(),
    ['analysis_complete', 'files_changed', 'tests_passed'],
  );
  assert.doesNotMatch(
    result.codingWorkResult?.claims.map((claim) => claim.kind).join(' ') || '',
    /pushed|deployed/,
  );

  const followUp = service.followUpTarget({
    groupFolder: 'main',
    prompt: 'Apply the follow-up in the same worktree',
    source: { system: 'real_git_fixture' },
  });
  const continued = await waitForTerminal(service, followUp.jobId);
  assert.equal(continued.publicJob.parentJobId, created.jobId);
  assert.equal(continued.worktreeRoot, result.worktreeRoot);
  assert.equal(continued.threadId, result.threadId);
  assert.equal(
    fs.existsSync(path.join(continued.worktreeRoot, 'continued.txt')),
    true,
  );
  assert.throws(
    () => service.cleanupJob(continued.publicJob.jobId),
    /preserved/,
  );
  assert.equal(fs.existsSync(continued.worktreeRoot), true);

  assert.throws(
    () =>
      service.createJob({
        groupFolder: 'main',
        prompt: 'Push, deploy, and message the team',
        source: { system: 'real_git_fixture' },
      }),
    /separately gated operations/,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'pass',
        actualGitWorktree: true,
        dirtySourcePreserved: true,
        sourceHeadUnchanged: true,
        continuationPreserved: true,
        agentClaimsUntrusted: true,
        testsIndependentlyVerified: true,
        noRemoteConfigured: true,
        dirtyCleanupRefused: true,
        unauthorizedExternalWorkBlocked: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
