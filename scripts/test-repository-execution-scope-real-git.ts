import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createRepositoryExecutionScope,
  RepositoryExecutionScopeError,
  type RepositoryExecutionContext,
} from '../src/repository-execution-scope.js';

const context: RepositoryExecutionContext = {
  invocationId: 'real-git-invocation',
  workId: 'real-git-work',
  checkpointId: 'real-git-checkpoint',
  planId: 'real-git-plan',
  planVersion: 1,
  turnId: 'real-git-turn',
};

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
    env: {
      ...process.env,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: 'ignore',
    timeout: 5_000,
  });
}

function realRepository(root: string): void {
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'andrea-fixture@example.invalid');
  git(root, 'config', 'user.name', 'Andrea Fixture');
  fs.writeFileSync(path.join(root, 'README.md'), 'base-state\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '--quiet', '-m', 'fixture');
}

function execution(root: string) {
  return createRepositoryExecutionScope({
    ...context,
    repositoryRoot: root,
    allowedRoot: path.dirname(root),
    allowedActionClasses: ['repository_write', 'verification_test'],
  });
}

const root = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'andrea-real-git-scope-'),
);
try {
  realRepository(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'dirty-one\n');
  const scope = execution(root);
  const preflight = scope.preflightAction({
    ...context,
    repositoryRoot: root,
    actionId: 'write-existing-dirty-path',
    actionClass: 'repository_write',
    targetPath: 'README.md',
  });
  fs.writeFileSync(path.join(root, 'README.md'), 'dirty-two\n');
  const receipt = scope.completeAction(preflight, {
    ...context,
    repositoryRoot: root,
    outcome: 'succeeded',
  });
  assert.equal(
    receipt.preState.dirtyPathsDigest,
    receipt.postState.dirtyPathsDigest,
  );
  assert.notEqual(
    receipt.preState.dirtyContentDigest,
    receipt.postState.dirtyContentDigest,
  );
  assert.equal(receipt.stateChanged, true);
  assert.equal(
    scope.verifyPostState({
      ...context,
      repositoryRoot: root,
      requireStateChangeFromBaseline: true,
      requireSuccessfulWriteReceipt: true,
    }).status,
    'passed',
  );

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  realRepository(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'dirty-one\n');
  const staleScope = execution(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'dirty-two\n');
  assert.throws(
    () =>
      staleScope.preflightAction({
        ...context,
        repositoryRoot: root,
        actionId: 'stale-write',
        actionClass: 'repository_write',
        targetPath: 'README.md',
      }),
    (error: unknown) =>
      error instanceof RepositoryExecutionScopeError &&
      error.code === 'repository_state_stale',
  );

  console.log(
    JSON.stringify(
      {
        status: 'pass',
        unchangedDirtyPathSetDetected: true,
        staleSamePathContentRejected: true,
        rawPathsStored: false,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
