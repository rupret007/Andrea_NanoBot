import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

interface CollectorSnapshot {
  actions: Array<{
    class: string;
    succeeded: number;
    succeededAfterLastRepositoryWrite: number;
    lastOutcome: string;
  }>;
  [key: string]: unknown;
}

interface CollectorInstance {
  beginAttempt(): void;
  observeSdkMessage(message: unknown): void;
  snapshot(): CollectorSnapshot;
}

interface CollectorConstructor {
  new (evidenceId?: string): CollectorInstance;
}

const collectorModulePath: string =
  '../container/agent-runner/src/runtime-tool-evidence.ts';
const { RuntimeToolEvidenceCollector } = (await import(
  collectorModulePath
)) as { RuntimeToolEvidenceCollector: CollectorConstructor };

function toolUse(id: string, name: string, input: unknown = {}) {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name, input }],
    },
  };
}

function toolResult(id: string, isError = false, content: unknown = 'done') {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: isError,
          content,
        },
      ],
    },
  };
}

function fingerprint(normalized: string): string {
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

describe('container runtime tool evidence collector', () => {
  it('captures successful metadata without retaining private tool material', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-private');
    const secret = 'sk-super-private-value-that-must-not-survive';
    const privatePath = '/Users/private/Project/customer-secret.ts';
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('sdk-private-id', 'Read', {
        file_path: privatePath,
        token: secret,
      }),
    );
    collector.observeSdkMessage(
      toolResult('sdk-private-id', false, `contents ${secret} ${privatePath}`),
    );

    const snapshot = collector.snapshot();
    expect(snapshot).toMatchObject({
      version: 1,
      evidenceId: 'evidence-private',
      cumulative: true,
      attempts: 1,
      collectorStatus: 'complete',
      calls: { observed: 1, succeeded: 1, failed: 0, unresolved: 0 },
      actions: [
        {
          class: 'repository_read',
          observed: 1,
          succeeded: 1,
          failed: 0,
          unresolved: 0,
          lastOutcome: 'succeeded',
          recovered: false,
        },
      ],
      privacy: {
        metadataOnly: true,
        rawInputsStored: false,
        resultBodiesStored: false,
        toolUseIdsStored: false,
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('sdk-private-id');
    expect(serialized).not.toContain('Read');
  });

  it('classifies bounded shell verification and repository operations', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-shell');
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('shell-1', 'Bash', {
        command:
          'git status --short && apply_patch < /tmp/change && npm run typecheck && npm test && npm run build',
      }),
    );
    collector.observeSdkMessage(toolResult('shell-1'));

    const snapshot = collector.snapshot();
    expect(snapshot.actions.map((action) => action.class)).toEqual([
      'repository_state',
      'repository_write',
      'verification_test',
      'verification_typecheck',
      'verification_build',
    ]);
    expect(
      snapshot.actions.every(
        (action) =>
          action.succeeded === 1 && action.lastOutcome === 'succeeded',
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('apply_patch');
    expect(snapshot).toMatchObject({
      state: {
        preStateFingerprint: null,
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
    });
  });

  it('binds separate pre, post, and repository-head state without raw output', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-state');
    const preState = ' M src/private-before.ts  \r\n';
    const headState = '0123456789abcdef-private-head\n';
    const postState = ' M src/private-after.ts\n';
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('state-before', 'Bash', {
        command: '  GIT\tSTATUS  --SHORT  ',
      }),
    );
    collector.observeSdkMessage(toolResult('state-before', false, preState));
    collector.observeSdkMessage(
      toolUse('head-before', 'Bash', {
        command: ' GIT  REV-PARSE\tHEAD ',
      }),
    );
    collector.observeSdkMessage(
      toolResult('head-before', false, [{ type: 'text', text: headState }]),
    );
    collector.observeSdkMessage(
      toolUse('write', 'Edit', { file_path: '/private/repository.ts' }),
    );
    collector.observeSdkMessage(toolResult('write'));
    collector.observeSdkMessage(
      toolUse('state-after', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(toolResult('state-after', false, postState));

    expect(collector.snapshot()).toMatchObject({
      state: {
        preStateFingerprint: fingerprint('M src/private-before.ts'),
        postStateFingerprint: fingerprint('M src/private-after.ts'),
        repositoryHeadFingerprint: fingerprint('0123456789abcdef-private-head'),
      },
    });
    const serialized = JSON.stringify(collector.snapshot());
    expect(serialized).not.toContain('private-before');
    expect(serialized).not.toContain('private-after');
    expect(serialized).not.toContain('private-head');
    expect(serialized).not.toContain('/private/repository.ts');
  });

  it.each([
    [
      'environment assignments',
      'GIT_DIR=/private/.git GIT_WORK_TREE=/private/work git status --short',
      'GIT_DIR=/private/.git git rev-parse HEAD',
    ],
    ['sudo preambles', 'sudo git status --short', 'sudo git rev-parse HEAD'],
    ['env preambles', 'env git status --short', 'env git rev-parse HEAD'],
    [
      'compound commands',
      'git status --short && true',
      'git rev-parse HEAD; true',
    ],
    [
      'shell preambles',
      'cd /private && git status --short',
      "bash -lc 'git rev-parse HEAD'",
    ],
  ])(
    'rejects %s around canonical repository probes',
    (_label, stateCommand, headCommand) => {
      const collector = new RuntimeToolEvidenceCollector(
        'evidence-adversarial-probe',
      );
      collector.beginAttempt();
      collector.observeSdkMessage(
        toolUse('invalid-state', 'Bash', { command: stateCommand }),
      );
      collector.observeSdkMessage(
        toolResult('invalid-state', false, 'private invalid state'),
      );
      collector.observeSdkMessage(
        toolUse('invalid-head', 'Bash', { command: headCommand }),
      );
      collector.observeSdkMessage(
        toolResult('invalid-head', false, 'private invalid head'),
      );
      collector.observeSdkMessage(toolUse('write', 'Edit', {}));
      collector.observeSdkMessage(toolResult('write'));
      collector.observeSdkMessage(
        toolUse('valid-post', 'Bash', { command: 'git status --short' }),
      );
      collector.observeSdkMessage(
        toolResult('valid-post', false, 'canonical post state'),
      );

      expect(collector.snapshot()).toMatchObject({
        state: {
          preStateFingerprint: null,
          postStateFingerprint: fingerprint('canonical post state'),
          repositoryHeadFingerprint: null,
        },
      });
    },
  );

  it('does not fingerprint general or mismatched repository reads as state', () => {
    const collector = new RuntimeToolEvidenceCollector(
      'evidence-canonical-state-only',
    );
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('general-before', 'Bash', {
        command: 'git diff --name-only',
      }),
    );
    collector.observeSdkMessage(
      toolResult('general-before', false, 'private-before-diff'),
    );
    collector.observeSdkMessage(toolUse('write', 'Edit', {}));
    collector.observeSdkMessage(toolResult('write'));
    collector.observeSdkMessage(
      toolUse('general-after', 'Bash', { command: 'ls -la' }),
    );
    collector.observeSdkMessage(
      toolResult('general-after', false, 'private-after-listing'),
    );

    expect(collector.snapshot()).toMatchObject({
      collectorStatus: 'complete',
      state: {
        preStateFingerprint: null,
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
    });
    const serialized = JSON.stringify(collector.snapshot());
    expect(serialized).not.toContain('private-before-diff');
    expect(serialized).not.toContain('private-after-listing');

    const mismatched = new RuntimeToolEvidenceCollector(
      'evidence-mismatched-state',
    );
    mismatched.beginAttempt();
    mismatched.observeSdkMessage(
      toolUse('canonical-before', 'Bash', {
        command: 'git status --short',
      }),
    );
    mismatched.observeSdkMessage(
      toolResult('canonical-before', false, 'canonical-before'),
    );
    mismatched.observeSdkMessage(toolUse('write', 'Edit', {}));
    mismatched.observeSdkMessage(toolResult('write'));
    mismatched.observeSdkMessage(
      toolUse('noncanonical-after', 'Bash', {
        command: 'git diff --name-only',
      }),
    );
    mismatched.observeSdkMessage(
      toolResult('noncanonical-after', false, 'noncanonical-after'),
    );

    expect(mismatched.snapshot()).toMatchObject({
      state: {
        preStateFingerprint: fingerprint('canonical-before'),
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
    });
  });

  it('does not treat a compound state-and-write call as pre-state proof', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-compound');
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('compound', 'Bash', {
        command: 'git status --short && apply_patch < /tmp/private.patch',
      }),
    );
    collector.observeSdkMessage(
      toolResult('compound', false, 'private compound output'),
    );
    collector.observeSdkMessage(
      toolUse('post', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(
      toolResult('post', false, 'private post output'),
    );

    expect(collector.snapshot()).toMatchObject({
      state: {
        preStateFingerprint: null,
        postStateFingerprint: fingerprint('private post output'),
        repositoryHeadFingerprint: null,
      },
    });
    expect(JSON.stringify(collector.snapshot())).not.toContain(
      'private compound output',
    );
  });

  it('requires HEAD before the first write and post-state after the final write', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-ordering');
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('pre', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(toolResult('pre', false, 'before'));
    collector.observeSdkMessage(toolUse('write-one', 'Edit', {}));
    collector.observeSdkMessage(toolResult('write-one'));
    collector.observeSdkMessage(
      toolUse('between', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(toolResult('between', false, 'between'));
    collector.observeSdkMessage(toolUse('write-two', 'Edit', {}));
    collector.observeSdkMessage(toolResult('write-two'));
    collector.observeSdkMessage(
      toolUse('late-head', 'Bash', { command: 'git rev-parse HEAD' }),
    );
    collector.observeSdkMessage(toolResult('late-head', false, 'late-head'));

    expect(collector.snapshot()).toMatchObject({
      state: {
        preStateFingerprint: fingerprint('before'),
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
    });

    collector.observeSdkMessage(
      toolUse('final', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(toolResult('final', false, 'after'));
    expect(collector.snapshot()).toMatchObject({
      state: {
        preStateFingerprint: fingerprint('before'),
        postStateFingerprint: fingerprint('after'),
        repositoryHeadFingerprint: null,
      },
    });
  });

  it('counts verification only when it starts after the final repository write', () => {
    const collector = new RuntimeToolEvidenceCollector(
      'evidence-verification-ordering',
    );
    collector.beginAttempt();
    collector.observeSdkMessage(toolUse('write-one', 'Edit', {}));
    collector.observeSdkMessage(toolResult('write-one'));
    collector.observeSdkMessage(
      toolUse('test-one', 'Bash', { command: 'npm test' }),
    );
    collector.observeSdkMessage(toolResult('test-one'));

    expect(
      collector
        .snapshot()
        .actions.find((action) => action.class === 'verification_test'),
    ).toMatchObject({ succeededAfterLastRepositoryWrite: 1 });

    collector.observeSdkMessage(toolUse('write-two', 'Edit', {}));
    collector.observeSdkMessage(toolResult('write-two'));
    expect(
      collector
        .snapshot()
        .actions.find((action) => action.class === 'verification_test'),
    ).toMatchObject({ succeededAfterLastRepositoryWrite: 0 });

    collector.observeSdkMessage(
      toolUse('test-two', 'Bash', { command: 'npm test' }),
    );
    collector.observeSdkMessage(toolResult('test-two'));
    expect(
      collector
        .snapshot()
        .actions.find((action) => action.class === 'verification_test'),
    ).toMatchObject({ succeededAfterLastRepositoryWrite: 1 });
  });

  it('classifies a direct Node syntax check as test verification', () => {
    const collector = new RuntimeToolEvidenceCollector(
      'evidence-node-syntax-check',
    );
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('syntax-check', 'Bash', {
        command: 'node --check fixture.js',
      }),
    );
    collector.observeSdkMessage(toolResult('syntax-check'));

    expect(
      collector
        .snapshot()
        .actions.find((action) => action.class === 'verification_test'),
    ).toMatchObject({ succeeded: 1, lastOutcome: 'succeeded' });
  });

  it('stops reading result arrays after the fingerprint input cap', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-result-cap');
    const content = ['x'.repeat(65_536)];
    let readPastCap = false;
    Object.defineProperty(content, 1, {
      configurable: true,
      enumerable: true,
      get() {
        readPastCap = true;
        return 'must-not-be-read';
      },
    });
    content.length = 2;

    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('state', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(toolResult('state', false, content));
    expect(collector.snapshot()).toMatchObject({ collectorStatus: 'complete' });
    expect(readPastCap).toBe(false);
  });

  it('preserves an unknown shell segment and classifies privileged mutations', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-unknown');
    collector.beginAttempt();
    collector.observeSdkMessage(
      toolUse('mixed', 'Bash', {
        command: 'cd /workspace && git status --short && opaque-cli mutate',
      }),
    );
    collector.observeSdkMessage(toolResult('mixed'));
    collector.observeSdkMessage(
      toolUse('commit', 'Bash', { command: 'git commit -m private-message' }),
    );
    collector.observeSdkMessage(toolResult('commit'));

    expect(collector.snapshot().actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: 'repository_state', succeeded: 1 }),
        expect.objectContaining({ class: 'repository_write', succeeded: 1 }),
        expect.objectContaining({
          class: 'external_side_effect',
          succeeded: 1,
        }),
        expect.objectContaining({ class: 'workflow_control', succeeded: 1 }),
        expect.objectContaining({ class: 'other', succeeded: 1 }),
      ]),
    );
    expect(JSON.stringify(collector.snapshot())).not.toContain(
      'private-message',
    );
  });

  it('distinguishes recovered failures from a later terminal failure', () => {
    const recovered = new RuntimeToolEvidenceCollector('recovered');
    recovered.beginAttempt();
    recovered.observeSdkMessage(
      toolUse('test-failed', 'Bash', { command: 'npm test' }),
    );
    recovered.observeSdkMessage(toolResult('test-failed', true));
    recovered.beginAttempt();
    recovered.observeSdkMessage(
      toolUse('test-retry', 'Bash', { command: 'npm test' }),
    );
    recovered.observeSdkMessage(toolResult('test-retry'));

    expect(recovered.snapshot()).toMatchObject({
      attempts: 2,
      calls: { observed: 2, succeeded: 1, failed: 1, unresolved: 0 },
      actions: [
        {
          class: 'verification_test',
          lastOutcome: 'succeeded',
          recovered: true,
        },
      ],
    });

    const regressed = new RuntimeToolEvidenceCollector('regressed');
    regressed.beginAttempt();
    regressed.observeSdkMessage(
      toolUse('test-passed', 'Bash', { command: 'npm test' }),
    );
    regressed.observeSdkMessage(toolResult('test-passed'));
    regressed.observeSdkMessage(
      toolUse('test-later-failed', 'Bash', { command: 'npm test' }),
    );
    regressed.observeSdkMessage(toolResult('test-later-failed', true));

    expect(regressed.snapshot().actions[0]).toMatchObject({
      lastOutcome: 'failed',
      recovered: false,
    });
  });

  it('fails closed for unresolved or malformed event correlation', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-partial');
    collector.beginAttempt();
    collector.observeSdkMessage(toolUse('pending-write', 'Edit', {}));
    collector.observeSdkMessage(toolResult('unknown-result'));
    collector.observeSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: '', name: 'Read' }] },
    });

    expect(collector.snapshot()).toMatchObject({
      collectorStatus: 'partial',
      calls: { observed: 1, succeeded: 0, failed: 0, unresolved: 1 },
      actions: [
        {
          class: 'repository_write',
          lastOutcome: 'unresolved',
          recovered: false,
        },
      ],
    });
  });

  it('ignores replayed and duplicate events without double counting', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-dedupe');
    collector.beginAttempt();
    collector.observeSdkMessage({
      ...toolUse('replayed', 'Write', {}),
      isReplay: true,
    });
    collector.observeSdkMessage(toolUse('current', 'Write', {}));
    collector.observeSdkMessage(toolUse('current', 'Write', {}));
    collector.observeSdkMessage(toolResult('current'));
    collector.observeSdkMessage(toolResult('current'));

    expect(collector.snapshot()).toMatchObject({
      collectorStatus: 'complete',
      calls: { observed: 1, succeeded: 1, failed: 0, unresolved: 0 },
    });
  });

  it('classifies external mutations separately from internal delegation', () => {
    const collector = new RuntimeToolEvidenceCollector('evidence-authority');
    collector.beginAttempt();
    collector.observeSdkMessage(toolUse('delegate', 'Task', {}));
    collector.observeSdkMessage(toolResult('delegate'));
    collector.observeSdkMessage(
      toolUse('send', 'mcp__nanoclaw__send_message', {
        text: 'private message body',
      }),
    );
    collector.observeSdkMessage(toolResult('send'));

    expect(collector.snapshot().actions).toEqual([
      expect.objectContaining({ class: 'delegation', succeeded: 1 }),
      expect.objectContaining({ class: 'external_side_effect', succeeded: 1 }),
    ]);
    expect(JSON.stringify(collector.snapshot())).not.toContain(
      'private message body',
    );
  });
});
