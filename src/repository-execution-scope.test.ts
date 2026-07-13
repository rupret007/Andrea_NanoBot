import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RepositoryFixtureState {
  branch: string;
  head: string;
  dirtyPaths: string[];
}

const { repositoryStates } = vi.hoisted(() => ({
  repositoryStates: new Map<string, RepositoryFixtureState>(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((executable: string, args: string[]): string => {
    if (executable !== 'git' || args[0] !== '-C') {
      throw new Error('Unexpected fixture process invocation.');
    }
    const root = fs.realpathSync(args[1]!);
    const state = repositoryStates.get(root);
    if (!state) throw new Error('Unknown repository fixture.');
    const command = args.slice(2).join(' ');
    if (command === 'rev-parse --show-toplevel') return root;
    if (command === 'rev-parse --absolute-git-dir') {
      return path.join(root, '.git');
    }
    if (command === 'rev-parse --abbrev-ref HEAD') return state.branch;
    if (command === 'rev-parse HEAD') return state.head;
    if (command === 'status --porcelain=v1 -z --untracked-files=all --') {
      return state.dirtyPaths.map((entry) => `?? ${entry}\0`).join('');
    }
    if (command.startsWith('ls-files --stage -z -- ')) return '';
    throw new Error('Unexpected fixture Git query.');
  }),
}));

import {
  createRepositoryExecutionScope,
  persistRepositoryExecutionProof,
  repositoryExecutionTargetScopeKey,
  RepositoryExecutionScopeError,
  type RepositoryExecutionContext,
} from './repository-execution-scope.js';
import {
  _closeDatabase,
  _initTestDatabase,
  approveCognitiveApprovalPacketCAS,
  listCognitiveApprovalPackets,
  upsertCognitiveRun,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  issueDurableResumeGrant,
  stageDurableWorkApproval,
} from './durable-work-continuity.js';
import {
  beginVerifiedDeepWorkForTurn,
  reconcileVerifiedDeepWorkExecution,
} from './verified-deep-work.js';

const context: RepositoryExecutionContext = {
  invocationId: 'invocation-1',
  workId: 'work-1',
  checkpointId: 'checkpoint-1',
  planId: 'plan-1',
  planVersion: 3,
  turnId: 'turn-1',
};

const temporaryRoots: string[] = [];

beforeEach(() => _initTestDatabase());

function repository(): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'andrea-repository-scope-'),
  );
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  repositoryStates.set(root, {
    branch: 'main',
    head: 'a'.repeat(40),
    dirtyPaths: [],
  });
  return root;
}

function markDirty(root: string, ...dirtyPaths: string[]): void {
  const state = repositoryStates.get(fs.realpathSync(root));
  if (!state) throw new Error('Unknown repository fixture.');
  state.dirtyPaths = dirtyPaths;
}

function scope(root: string) {
  return createRepositoryExecutionScope({
    ...context,
    repositoryRoot: root,
    allowedRoot: path.dirname(root),
    allowedActionClasses: [
      'repository_read',
      'repository_state',
      'repository_write',
      'verification_test',
    ],
  });
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected repository execution scope error.');
    // This assertion helper intentionally captures the tested exception.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryExecutionScopeError);
    expect((error as RepositoryExecutionScopeError).code).toBe(code);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  repositoryStates.clear();
  _closeDatabase();
});

describe('repository execution scope', () => {
  it('closes the positive deep-work proof only through an approved, leased, host-bound repository execution', () => {
    const root = repository();
    const now = '2026-07-13T12:00:00.000Z';
    const targetScopeKey = repositoryExecutionTargetScopeKey(root);
    const binding = {
      ownerId: 'owner-1',
      chatId: 'chat-1',
      groupId: 'main',
      channel: 'telegram',
      targetScopeKey,
    };
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: context.turnId,
      taskFamily: 'code',
      objective: 'Implement and verify one bounded repository fixture.',
      approvalRequired: false,
      repositorySnapshotProvider: () => ({
        root,
        branch: 'main',
        headSha: 'a'.repeat(40),
        dirtyPaths: [],
        capturedAt: now,
      }),
      now: new Date(now),
    });
    const created = createOrLoadDurableWork({
      originTurnId: context.turnId,
      authorizedSurface: 'telegram',
      binding,
      goalSummary: 'Implement and verify one bounded repository fixture.',
      status: 'ready',
      cognitiveRunId: 'cognitive:repository-proof',
      deepWorkPacketId: packet!.packetId,
      planId: context.planId,
      nextAction: 'Checkpoint before the approved write.',
      now,
    });
    const committed = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      completedNodeIds: ['inspect'],
      pendingNodeIds: ['write', 'verify'],
      executorScopeKey: 'host-repository-executor',
      targetScopeKey,
      preStateFingerprint: `sha256:${'1'.repeat(64)}`,
      verificationRequirementIds: ['test-pass'],
      stopConditionIds: ['terminal-error'],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Execute the approved write once, then verify it.',
      now,
    });
    upsertCognitiveRun({
      runId: 'cognitive:repository-proof',
      createdAt: now,
      updatedAt: now,
      groupFolder: 'main',
      channel: 'telegram',
      taskFamily: 'code',
      turnId: context.turnId,
      runOrigin: 'live',
      goalSummary: 'Approve one exact repository fixture write.',
      selectedSkillId: 'code.repair',
      status: 'awaiting_approval',
      autonomyLevel: 'plan_draft_only',
      cognitiveMode: 'approval_staged',
      taskGraphJson: '{}',
      evidenceContractJson: '{}',
      providerUsabilityJson: '{}',
      councilRunId: null,
      verificationJson: '{}',
      outcomeScore: 0,
      nextAction: 'Wait for exact owner approval.',
      privacyJson: '{"metadataOnly":true}',
      linkedSkillCardId: null,
    });
    const approvalSummary = 'Approve one exact repository fixture write.';
    const stagedResult = stageDurableWorkApproval({
      workId: committed.work.workId,
      expectedWorkVersion: committed.work.version,
      cognitiveRunId: 'cognitive:repository-proof',
      actionClass: 'repository_write',
      summary: approvalSummary,
      checkpointId: committed.checkpoint.durableCheckpointId,
      ttlMs: 2 * 60 * 60 * 1000,
      now,
    });
    const stagedApproval = listCognitiveApprovalPackets({
      groupFolder: 'main',
      status: 'staged',
    }).find(
      (candidate) =>
        candidate.approvalPacketId === stagedResult.packet.approvalPacketId,
    )!;
    const approval = approveCognitiveApprovalPacketCAS({
      approvalPacketId: stagedApproval.approvalPacketId,
      groupFolder: 'main',
      expectedSummary: approvalSummary,
      expectedApprovalVersion: stagedApproval.approvalVersion || 1,
      expectedScopeDigest: stagedApproval.scopeDigest || null,
      now: '2026-07-13T12:01:00.000Z',
      approvalChannel: 'owner_cockpit',
    });
    expect(approval.status).toBe('approved');
    const grant = issueDurableResumeGrant({
      workId: committed.work.workId,
      binding,
      actionClass: 'repository_write',
      approvalPacketId: stagedApproval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      now: '2026-07-13T12:02:00.000Z',
    });
    expect(
      consumeResumeGrantAndAcquireLease({
        token: grant.token,
        binding,
        actionClass: 'repository_write',
        workerId: 'repository-worker-1',
        leaseTtlMs: 5 * 60 * 1000,
        now: '2026-07-13T12:03:00.000Z',
      }).status,
    ).toBe('consumed');

    const executionContext: RepositoryExecutionContext = {
      ...context,
      workId: committed.work.workId,
      checkpointId: stagedResult.checkpoint.durableCheckpointId,
      planVersion: committed.work.planVersion,
    };
    const execution = createRepositoryExecutionScope({
      ...executionContext,
      repositoryRoot: root,
      allowedRoot: path.dirname(root),
      allowedActionClasses: ['repository_write', 'verification_test'],
      expectedBaseHeadSha: 'a'.repeat(40),
      now: () => new Date('2026-07-13T12:04:00.000Z'),
    });
    const write = execution.preflightAction({
      ...executionContext,
      repositoryRoot: root,
      actionId: 'write-1',
      actionClass: 'repository_write',
      targetPath: 'README.md',
    });
    fs.appendFileSync(path.join(root, 'README.md'), 'Verified change\n');
    markDirty(root, 'README.md');
    execution.completeAction(write, {
      ...executionContext,
      repositoryRoot: root,
      outcome: 'succeeded',
    });
    const check = execution.preflightAction({
      ...executionContext,
      repositoryRoot: root,
      actionId: 'test-1',
      actionClass: 'verification_test',
    });
    execution.completeAction(check, {
      ...executionContext,
      repositoryRoot: root,
      outcome: 'succeeded',
    });
    const verification = execution.verifyPostState({
      ...executionContext,
      repositoryRoot: root,
      expectedBranch: 'main',
      expectedHeadSha: 'a'.repeat(40),
      requireStateChangeFromBaseline: true,
      requireSuccessfulWriteReceipt: true,
      requireVerificationAfterLastWrite: true,
    });
    expect(verification.status).toBe('passed');
    const durableReceipts = persistRepositoryExecutionProof({
      execution,
      verification,
      targetScopeKey,
    });
    expect(durableReceipts).toHaveLength(2);
    expect(JSON.stringify(durableReceipts)).not.toContain(root);
    expect(JSON.stringify(durableReceipts)).not.toContain('README.md');

    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: context.turnId,
      durableWorkId: committed.work.workId,
      runtimeToolEvidence: {
        version: 1,
        evidenceId: 'evidence-host-bound-repository',
        cumulative: true,
        attempts: 4,
        collectorStatus: 'complete',
        calls: { observed: 4, succeeded: 4, failed: 0, unresolved: 0 },
        actions: [
          {
            class: 'repository_write',
            observed: 1,
            succeeded: 1,
            failed: 0,
            unresolved: 0,
            succeededAfterLastRepositoryWrite: 0,
            lastOutcome: 'succeeded',
            recovered: false,
          },
          {
            class: 'repository_state',
            observed: 2,
            succeeded: 2,
            failed: 0,
            unresolved: 0,
            succeededAfterLastRepositoryWrite: 0,
            lastOutcome: 'succeeded',
            recovered: false,
          },
          {
            class: 'verification_test',
            observed: 1,
            succeeded: 1,
            failed: 0,
            unresolved: 0,
            succeededAfterLastRepositoryWrite: 1,
            lastOutcome: 'succeeded',
            recovered: false,
          },
        ],
        state: {
          preStateFingerprint: `sha256:${'1'.repeat(64)}`,
          postStateFingerprint: `sha256:${'2'.repeat(64)}`,
          repositoryHeadFingerprint: `sha256:${createHash('sha256')
            .update('a'.repeat(40))
            .digest('hex')}`,
        },
        privacy: {
          metadataOnly: true,
          rawInputsStored: false,
          resultBodiesStored: false,
          toolUseIdsStored: false,
        },
      },
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The host-bound repository change passed its test.',
    });
    expect(reconciled).toMatchObject({
      status: 'completed',
      currentStage: 'record_outcome',
    });
    expect(reconciled.unresolvedRisks).not.toContain(
      'runtime_repository_scope_unbound',
    );
  });

  it('binds canonical repository identity and exports metadata without paths or commands', () => {
    const root = repository();
    const execution = scope(root);
    const serialized = JSON.stringify(execution);

    expect(execution.binding).toMatchObject({
      version: 1,
      ...context,
      branch: 'main',
      baseHeadSha: 'a'.repeat(40),
      currentHeadSha: 'a'.repeat(40),
      dirtyPathCount: 0,
      privacy: {
        metadataOnly: true,
        rawCommandsStored: false,
        rawPathsStored: false,
        resultBodiesStored: false,
      },
    });
    for (const value of [
      execution.binding.canonicalRootFingerprint,
      execution.binding.allowedRootFingerprint,
      execution.binding.gitDirectoryFingerprint,
      execution.binding.worktreeFingerprint,
      execution.binding.repositoryIdentityFingerprint,
      execution.binding.dirtyPathsDigest,
    ]) {
      expect(value).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('README.md');
    expect(serialized).not.toContain('rev-parse');
  });

  it('records scoped read, write, and post-write verification receipts', () => {
    const root = repository();
    const execution = scope(root);
    const read = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'read-1',
      actionClass: 'repository_read',
      targetPath: 'README.md',
    });
    const readReceipt = execution.completeAction(read, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });

    const write = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'write-1',
      actionClass: 'repository_write',
      targetPath: 'src/new-file.ts',
    });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src/new-file.ts'),
      'export const value = 1;\n',
    );
    markDirty(root, 'src/new-file.ts');
    const writeReceipt = execution.completeAction(write, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });

    const verification = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'test-1',
      actionClass: 'verification_test',
    });
    const verificationReceipt = execution.completeAction(verification, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });
    const result = execution.verifyPostState({
      ...context,
      repositoryRoot: root,
      expectedBranch: 'main',
      expectedHeadSha: execution.binding.baseHeadSha,
      requireStateChangeFromBaseline: true,
      requireSuccessfulWriteReceipt: true,
      requireVerificationAfterLastWrite: true,
    });

    expect(readReceipt.receiptKind).toBe('read');
    expect(readReceipt.stateChanged).toBe(false);
    expect(writeReceipt.receiptKind).toBe('write');
    expect(writeReceipt.stateChanged).toBe(true);
    expect(verificationReceipt.receiptKind).toBe('verification');
    expect(verificationReceipt.sequence).toBeGreaterThan(writeReceipt.sequence);
    expect(result.status).toBe('passed');
    expect(result.lastWriteReceiptId).toBe(writeReceipt.receiptId);
    expect(result.latestVerificationReceiptId).toBe(
      verificationReceipt.receiptId,
    );
    const serialized = JSON.stringify({
      read,
      readReceipt,
      writeReceipt,
      verificationReceipt,
      result,
    });
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('README.md');
    expect(serialized).not.toContain('new-file.ts');
  });

  it('detects content changes when the dirty path set stays the same', () => {
    const root = repository();
    fs.writeFileSync(path.join(root, 'README.md'), 'dirty-one\n');
    markDirty(root, 'README.md');
    const execution = scope(root);
    const write = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'same-path-write',
      actionClass: 'repository_write',
      targetPath: 'README.md',
    });
    fs.writeFileSync(path.join(root, 'README.md'), 'dirty-two\n');
    const receipt = execution.completeAction(write, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });

    expect(receipt.preState.dirtyPathsDigest).toBe(
      receipt.postState.dirtyPathsDigest,
    );
    expect(receipt.preState.dirtyContentDigest).not.toBe(
      receipt.postState.dirtyContentDigest,
    );
    expect(receipt.stateChanged).toBe(true);
  });

  it('rejects same-path content drift before a bound action starts', () => {
    const root = repository();
    fs.writeFileSync(path.join(root, 'README.md'), 'dirty-one\n');
    markDirty(root, 'README.md');
    const execution = scope(root);
    fs.writeFileSync(path.join(root, 'README.md'), 'dirty-two\n');

    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: root,
          actionId: 'stale-same-path-write',
          actionClass: 'repository_write',
          targetPath: 'README.md',
        }),
      'repository_state_stale',
    );
  });

  it('fails verification when a write has no later successful verification receipt', () => {
    const root = repository();
    const execution = scope(root);
    const write = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'write-1',
      actionClass: 'repository_write',
      targetPath: 'README.md',
    });
    fs.appendFileSync(path.join(root, 'README.md'), 'Changed\n');
    markDirty(root, 'README.md');
    execution.completeAction(write, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });

    const result = execution.verifyPostState({
      ...context,
      repositoryRoot: root,
      requireSuccessfulWriteReceipt: true,
      requireVerificationAfterLastWrite: true,
    });

    expect(result.status).toBe('failed');
    expect(result.checks).toContainEqual({
      check: 'successful_verification_after_last_write',
      passed: false,
    });
  });

  it('fails closed when a later verification supersedes an earlier success', () => {
    const root = repository();
    const execution = scope(root);
    const write = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'write-1',
      actionClass: 'repository_write',
      targetPath: 'README.md',
    });
    fs.appendFileSync(path.join(root, 'README.md'), 'Changed\n');
    markDirty(root, 'README.md');
    execution.completeAction(write, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });

    for (const [actionId, outcome] of [
      ['test-success', 'succeeded'],
      ['test-failure', 'failed'],
    ] as const) {
      const verification = execution.preflightAction({
        ...context,
        repositoryRoot: root,
        actionId,
        actionClass: 'verification_test',
      });
      execution.completeAction(verification, {
        ...context,
        repositoryRoot: root,
        outcome,
      });
    }

    const result = execution.verifyPostState({
      ...context,
      repositoryRoot: root,
      requireVerificationAfterLastWrite: true,
    });

    expect(result.status).toBe('failed');
    expect(result.checks).toContainEqual({
      check: 'successful_verification_after_last_write',
      passed: false,
    });
  });

  it('rejects symlink roots, path escapes, and target symlinks', () => {
    const root = repository();
    const linkedRoot = `${root}-link`;
    fs.symlinkSync(root, linkedRoot);
    temporaryRoots.push(linkedRoot);
    expectCode(
      () =>
        createRepositoryExecutionScope({
          ...context,
          repositoryRoot: linkedRoot,
          allowedRoot: path.dirname(root),
          allowedActionClasses: ['repository_read'],
        }),
      'repository_root_symlink',
    );

    const execution = scope(root);
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: root,
          actionId: 'escape-1',
          actionClass: 'repository_read',
          targetPath: '../outside.txt',
        }),
      'target_path_escape',
    );

    fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'linked.md'));
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: root,
          actionId: 'symlink-1',
          actionClass: 'repository_read',
          targetPath: 'linked.md',
        }),
      'target_symlink',
    );
  });

  it('rejects cross-repository and cross-turn use', () => {
    const root = repository();
    const otherRoot = repository();
    const execution = scope(root);

    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: otherRoot,
          actionId: 'read-other',
          actionClass: 'repository_read',
          targetPath: 'README.md',
        }),
      'repository_identity_mismatch',
    );
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: root,
          actionId: 'read-other-target',
          actionClass: 'repository_read',
          targetPath: path.join(otherRoot, 'README.md'),
        }),
      'target_path_escape',
    );
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          turnId: 'turn-2',
          repositoryRoot: root,
          actionId: 'read-wrong-turn',
          actionClass: 'repository_read',
          targetPath: 'README.md',
        }),
      'execution_context_mismatch',
    );
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          planVersion: context.planVersion + 1,
          repositoryRoot: root,
          actionId: 'read-wrong-plan',
          actionClass: 'repository_read',
          targetPath: 'README.md',
        }),
      'execution_context_mismatch',
    );
  });

  it('rejects cross-checkpoint completion, disallowed actions, and replayed preflights', () => {
    const root = repository();
    const execution = scope(root);
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: root,
          actionId: 'build-1',
          actionClass: 'verification_build',
        }),
      'action_not_allowed',
    );

    const preflight = execution.preflightAction({
      ...context,
      repositoryRoot: root,
      actionId: 'read-1',
      actionClass: 'repository_read',
      targetPath: 'README.md',
    });
    expectCode(
      () =>
        execution.completeAction(preflight, {
          ...context,
          checkpointId: 'checkpoint-2',
          repositoryRoot: root,
          outcome: 'succeeded',
        }),
      'execution_context_mismatch',
    );
    execution.completeAction(preflight, {
      ...context,
      repositoryRoot: root,
      outcome: 'succeeded',
    });
    expectCode(
      () =>
        execution.completeAction(preflight, {
          ...context,
          repositoryRoot: root,
          outcome: 'succeeded',
        }),
      'unknown_preflight',
    );
    expectCode(
      () =>
        execution.preflightAction({
          ...context,
          repositoryRoot: root,
          actionId: 'read-1',
          actionClass: 'repository_read',
          targetPath: 'README.md',
        }),
      'action_id_reused',
    );
  });
});
