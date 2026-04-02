import { describe, expect, it } from 'vitest';

import { AndreaOpenAiRuntimeError } from './andrea-openai-runtime.js';
import {
  formatRuntimeBackendCreateAcceptedMessage,
  formatRuntimeBackendFailure,
  formatRuntimeBackendJobCard,
  formatRuntimeBackendLogsMessage,
  formatRuntimeBackendStatusSummary,
  formatRuntimeBackendStopMessage,
} from './runtime-shell.js';
import type {
  RegisteredGroup,
  RuntimeBackendJob,
  RuntimeBackendStatus,
  RuntimeBackendStopResult,
} from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Andrea Main',
  folder: 'main',
  trigger: '@andrea',
  added_at: '2026-04-02T20:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

function makeStatus(
  overrides: Partial<RuntimeBackendStatus> = {},
): RuntimeBackendStatus {
  return {
    state: 'available',
    backend: 'andrea_openai',
    version: '1.2.42',
    transport: 'http',
    detail: null,
    meta: {
      backend: 'andrea_openai',
      enabled: true,
      ready: true,
      transport: 'http',
      version: '1.2.42',
    },
    ...overrides,
  };
}

function makeJob(overrides: Partial<RuntimeBackendJob> = {}): RuntimeBackendJob {
  return {
    backend: 'andrea_openai',
    jobId: 'runtime-job-create-12345-abcd',
    kind: 'create',
    status: 'queued',
    stopRequested: false,
    groupFolder: 'main',
    groupJid: 'tg:1',
    threadId: 'thread-123456789012345678901234567890',
    runtimeRoute: 'local_required',
    requestedRuntime: 'codex_local',
    selectedRuntime: 'codex_local',
    promptPreview: 'Create the proof file.',
    latestOutputText: null,
    finalOutputText: null,
    errorText: null,
    logFile: null,
    sourceSystem: 'andrea_nanobot',
    actorType: 'chat',
    actorId: 'tg:1',
    correlationId: 'corr-1',
    createdAt: '2026-04-02T20:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-04-02T20:00:00.000Z',
    capabilities: {
      followUp: true,
      logs: true,
      stop: true,
    },
    ...overrides,
  };
}

describe('runtime-shell formatting', () => {
  it('renders concise backend status verdicts', () => {
    const available = formatRuntimeBackendStatusSummary(
      makeStatus(),
      MAIN_GROUP,
      'http://127.0.0.1:3210',
    );
    const notReady = formatRuntimeBackendStatusSummary(
      makeStatus({
        state: 'not_ready',
        detail: 'No local execution lane is ready right now.',
      }),
      MAIN_GROUP,
      'http://127.0.0.1:3210',
    );

    expect(available).toContain('Andrea OpenAI backend is ready.');
    expect(available).toContain('- Group folder: main');
    expect(notReady).toContain('Andrea OpenAI backend is not ready yet.');
    expect(notReady).toContain('No local execution lane is ready right now.');
    expect(
      formatRuntimeBackendStatusSummary(
        makeStatus({ state: 'unavailable', detail: 'connect ECONNREFUSED' }),
        MAIN_GROUP,
        'http://127.0.0.1:3210',
      ),
    ).toContain('Andrea OpenAI backend is unavailable on loopback.');
    expect(
      formatRuntimeBackendStatusSummary(
        makeStatus({
          state: 'not_enabled',
          detail: 'Set ANDREA_OPENAI_BACKEND_ENABLED=true.',
        }),
        MAIN_GROUP,
        'http://127.0.0.1:3210',
      ),
    ).toContain('Andrea OpenAI backend is not enabled in this NanoBot runtime.');
  });

  it('renders accepted create messages with the job card', () => {
    const text = formatRuntimeBackendCreateAcceptedMessage(makeJob());

    expect(text).toContain('Andrea OpenAI job accepted.');
    expect(text).toContain('- Job ID: runtime-job-create-12345-abcd');
    expect(text).toContain('- Selected runtime: codex_local');
  });

  it('renders job cards with visible thread metadata and output summary', () => {
    const text = formatRuntimeBackendJobCard(
      makeJob({
        status: 'running',
        latestOutputText: 'Created the file already.',
      }),
    );

    expect(text).toContain('- Status: running');
    expect(text).toContain('- Thread ID: thread-12345678901234567...');
    expect(text).toContain('- Output: Created the file already.');
  });

  it('renders honest empty-log messaging with live job state', () => {
    const text = formatRuntimeBackendLogsMessage(
      {
        jobId: 'runtime-job-follow_up-999',
        logFile: null,
        logText: null,
        lines: 40,
      },
      makeJob({
        jobId: 'runtime-job-follow_up-999',
        kind: 'follow_up',
        status: 'running',
        latestOutputText: 'Useful output is already here.',
      }),
    );

    expect(text).toContain(
      'Andrea OpenAI logs are not ready yet for job runtime-job-follow_up-999.',
    );
    expect(text).toContain('- Current status: running');
    expect(text).toContain('- Output: Useful output is already here.');
  });

  it('renders real log text cleanly when terminal output exists', () => {
    const text = formatRuntimeBackendLogsMessage({
      jobId: 'runtime-job-follow_up-999',
      logFile: 'container-followup.log',
      logText: 'line one\nline two',
      lines: 40,
    });

    expect(text).toContain('Andrea OpenAI logs for runtime-job-follow_up-999.');
    expect(text).toContain('- Log file: container-followup.log');
    expect(text).toContain('line one');
  });

  it('renders stop results differently for live and terminal jobs', () => {
    const live = formatRuntimeBackendStopMessage({
      job: makeJob({ status: 'running', stopRequested: true }),
      liveStopAccepted: true,
    } satisfies RuntimeBackendStopResult);
    const terminal = formatRuntimeBackendStopMessage({
      job: makeJob({ status: 'succeeded', stopRequested: false }),
      liveStopAccepted: false,
    } satisfies RuntimeBackendStopResult);

    expect(live).toContain(
      'Stop requested for Andrea OpenAI job runtime-job-create-12345-abcd.',
    );
    expect(terminal).toContain(
      'Andrea OpenAI job runtime-job-create-12345-abcd is already finished.',
    );
  });

  it('keeps bootstrap failures distinct from generic transport failures', () => {
    const bootstrap = formatRuntimeBackendFailure(
      new AndreaOpenAiRuntimeError(
        'bootstrap_failed',
        'Andrea OpenAI backend could not register backend group "main" automatically.',
        'Group "main" already exists with conflicting metadata.',
        'main',
      ),
      'tg:1',
      MAIN_GROUP,
    );
    const generic = formatRuntimeBackendFailure(
      new Error('socket hang up'),
      'tg:1',
      MAIN_GROUP,
    );

    expect(bootstrap).toContain('- Backend: andrea_openai');
    expect(bootstrap).toContain('- Source chat: tg:1');
    expect(bootstrap).toContain('conflicting metadata');
    expect(generic).toContain('Andrea OpenAI backend operation failed');
  });

  it('renders not-found failures as operator-actionable job misses', () => {
    const text = formatRuntimeBackendFailure(
      new AndreaOpenAiRuntimeError(
        'not_found',
        'No runtime job found for "missing-job".',
        null,
        'main',
      ),
      'tg:1',
      MAIN_GROUP,
    );

    expect(text).toContain('No runtime job found for "missing-job".');
    expect(text).toContain(
      '- Detail: Check the job ID or page anchor and try again.',
    );
  });
});
