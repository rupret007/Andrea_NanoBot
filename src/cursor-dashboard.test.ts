import { describe, expect, it } from 'vitest';

import {
  buildCursorDashboardCurrentJob,
  buildCursorDashboardCurrentJobEmpty,
  buildCursorDashboardHelp,
  buildCursorDashboardHome,
  buildCursorDashboardJobs,
  buildCursorDashboardWorkCurrent,
  buildCursorDashboardRuntime,
  buildCursorDashboardRuntimeCurrent,
  buildCursorDashboardRuntimeCurrentEmpty,
  buildCursorDashboardRuntimeCurrentUnavailable,
  buildCursorDashboardRuntimeJobs,
  buildCursorDashboardRuntimeJobsUnavailable,
  buildCursorDashboardWizardConfirm,
  formatCursorDashboardState,
  parseCursorDashboardState,
} from './cursor-dashboard.js';
import type {
  BackendJobDetails,
  BackendJobSummary,
} from './backend-lanes/types.js';
import type { FlattenedCursorJobEntry } from './cursor-operator-context.js';
import type { RuntimeWorkRecovery } from './work-cockpit-recovery.js';

const cloudJob: FlattenedCursorJobEntry = {
  laneId: 'cursor',
  provider: 'cloud',
  id: 'bc-11111111-2222-3333-4444-555555555555',
  groupFolder: 'main',
  chatJid: 'tg:1',
  status: 'RUNNING',
  model: 'default',
  promptText: 'Ship docs',
  sourceRepository: 'https://github.com/example/repo',
  sourceRef: 'main',
  sourcePrUrl: null,
  targetUrl:
    'https://cursor.com/agents/bc-11111111-2222-3333-4444-555555555555',
  targetPrUrl: null,
  targetBranchName: null,
  autoCreatePr: false,
  openAsCursorGithubApp: false,
  skipReviewerRequest: false,
  summary: null,
  createdBy: 'tg:owner',
  createdAt: '2026-03-30T10:00:00.000Z',
  updatedAt: '2026-03-30T10:01:00.000Z',
  lastSyncedAt: '2026-03-30T10:01:00.000Z',
  bucket: 'cloudTracked',
  ordinal: 1,
};

const desktopJob: FlattenedCursorJobEntry = {
  ...cloudJob,
  provider: 'desktop',
  id: 'desk_local_123',
  targetUrl: null,
  bucket: 'desktopTracked',
  ordinal: 2,
};

const runtimeSummary: BackendJobSummary = {
  handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1234567890' },
  title: 'Codex/OpenAI task',
  status: 'running',
  summary: 'Continue the migration',
  updatedAt: '2026-03-30T12:03:00.000Z',
  createdAt: '2026-03-30T12:00:00.000Z',
  sourceRepository: null,
  targetUrl: null,
  laneLabel: 'Codex/OpenAI Runtime',
  capabilities: {
    canCreateJob: true,
    canFollowUp: true,
    canGetLogs: true,
    canStop: true,
    canRefresh: true,
    canViewOutput: true,
    canViewFiles: false,
    actionIds: ['job.refresh', 'job.output', 'job.followup', 'job.stop'],
  },
};

const runtimeJob: BackendJobDetails = {
  ...runtimeSummary,
  metadata: {
    selectedRuntime: 'codex_local',
    groupFolder: 'main',
  },
};

const runtimeUnavailable: Extract<
  RuntimeWorkRecovery,
  { kind: 'unavailable' }
> = {
  kind: 'unavailable',
  selectedJobId: runtimeJob.handle.jobId,
  reason: 'unavailable',
  cached: {
    jobId: runtimeJob.handle.jobId,
    status: 'running',
    updatedAt: '2026-03-30T12:03:00.000Z',
    freshness: 'stale',
  },
};

describe('cursor dashboard helpers', () => {
  it('round-trips dashboard payload state', () => {
    const state = parseCursorDashboardState(
      formatCursorDashboardState({
        kind: 'wizard_confirm',
        page: 2,
        wizard: {
          sourceRepository: 'owner/repo',
          promptText: 'Ship it',
        },
      }),
    );

    expect(state).toEqual({
      kind: 'wizard_confirm',
      page: 2,
      wizard: {
        sourceRepository: 'owner/repo',
        promptText: 'Ship it',
      },
    });
  });

  it('builds a job browser with one full-width selection tile per visible job', () => {
    const render = buildCursorDashboardJobs({
      entries: [cloudJob, desktopJob],
      page: 0,
      selectedAgentId: cloudJob.id,
    });

    expect(render.text).toContain('*Cursor Jobs*');
    expect(render.inlineActionRows[0][0].label).toContain('1. Cloud');
    expect(render.inlineActionRows[1][0].label).toContain('2. Desktop');
    expect(render.inlineActionRows.at(-1)?.[0].label).toBe('Back');
  });

  it('builds cloud current-job controls around refresh, output, results, and continue', () => {
    const render = buildCursorDashboardCurrentJob(cloudJob, 3);
    const labels = render.inlineActionRows.flat().map((action) => action.label);

    expect(render.text).toContain('*Current Task*');
    expect(render.text).toContain('Lane: Cursor Cloud');
    expect(render.text).toContain(
      'Reply with plain text to continue this task',
    );
    expect(labels).toContain('Refresh');
    expect(labels).toContain('View Output');
    expect(labels).toContain('Results');
    expect(labels).toContain('Continue');
    expect(labels).toContain('Stop Run');
  });

  it('builds desktop current-job controls around output and terminal actions', () => {
    const render = buildCursorDashboardCurrentJob(desktopJob, 0);
    const labels = render.inlineActionRows.flat().map((action) => action.label);

    expect(render.text).toContain('*Current Session*');
    expect(render.text).toContain('Lane: Cursor Desktop');
    expect(labels).toContain('Refresh');
    expect(labels).toContain('View Output');
    expect(labels).toContain('Terminal Status');
    expect(labels).toContain('Terminal Log');
    expect(labels).toContain('Terminal Help');
  });

  it('provides a friendly empty current-job state and compact home/help tiles', () => {
    expect(buildCursorDashboardCurrentJobEmpty().text).toContain(
      'No current task is selected in the Cursor lane',
    );
    expect(
      buildCursorDashboardHome({
        cloudLine: 'ready',
        desktopLine: 'optional and unavailable',
        runtimeRouteLine: 'optional and off',
        codexRuntimeLine: 'integrated and conditional',
        currentRuntimeTask: runtimeJob,
        currentFocusLaneId: 'andrea_runtime',
      }).inlineActionRows,
    ).toHaveLength(4);
    expect(
      buildCursorDashboardHome({
        cloudLine: 'ready',
        desktopLine: 'optional and unavailable',
        runtimeRouteLine: 'optional and off',
        codexRuntimeLine: 'integrated and conditional',
        currentRuntimeTask: runtimeJob,
        currentFocusLaneId: 'andrea_runtime',
      }).text,
    ).toContain('Current Codex/OpenAI task');
    expect(
      buildCursorDashboardHome({
        cloudLine: 'ready',
        desktopLine: 'optional and unavailable',
        runtimeRouteLine: 'optional and off',
        codexRuntimeLine: 'integrated and conditional',
        currentRuntimeTask: runtimeJob,
        currentFocusLaneId: 'andrea_runtime',
      }).text,
    ).toContain('Current focus: Codex/OpenAI runtime');
    expect(
      buildCursorDashboardHome({
        cloudLine: 'ready',
        desktopLine: 'optional and unavailable',
        runtimeRouteLine: 'optional and off',
        codexRuntimeLine: 'integrated and conditional',
        currentRuntimeTask: runtimeJob,
        currentFocusLaneId: 'andrea_runtime',
      }).text,
    ).toContain('Current work: Codex/OpenAI runtime');
    expect(buildCursorDashboardHelp().text).toContain(
      'Replying to a task card always continues that exact task',
    );
    expect(buildCursorDashboardHelp().text).toContain(
      'Slash commands still work',
    );
    expect(buildCursorDashboardHelp().text).toContain('Codex/OpenAI');
  });

  it('renders runtime overview, browser, and current-task views inside the same dashboard family', () => {
    const overview = buildCursorDashboardRuntime({
      executionEnabled: false,
      readinessLine: 'integrated and conditional',
      currentTask: runtimeJob,
    });
    const jobs = buildCursorDashboardRuntimeJobs({
      jobs: [runtimeSummary],
      page: 0,
      selectedJobId: runtimeSummary.handle.jobId,
    });
    const current = buildCursorDashboardRuntimeCurrent(runtimeJob, false);
    const currentLabels = current.inlineActionRows
      .flat()
      .map((action) => action.label);

    expect(overview.text).toContain("Andrea's Codex/OpenAI runtime lane");
    expect(overview.inlineActionRows[0].map((action) => action.label)).toEqual([
      'Recent Work',
      'Current Task',
    ]);
    expect(jobs.text).toContain('*Codex/OpenAI Work*');
    expect(jobs.inlineActionRows[0][0].label).toContain('1.');
    expect(current.text).toContain('*Current Task*');
    expect(current.text).toContain('Lane: Codex/OpenAI runtime');
    expect(currentLabels).toContain('Refresh');
    expect(currentLabels).toContain('View Output');
    expect(currentLabels).not.toContain('Results');
    expect(currentLabels).not.toContain('Continue');
    expect(buildCursorDashboardRuntimeCurrentEmpty().text).toContain(
      'No current task is selected in the Codex/OpenAI lane',
    );
  });

  it('renders a unified current-work view for whichever lane is selected', () => {
    const cursorRender = buildCursorDashboardWorkCurrent({
      currentFocusLaneId: 'cursor',
      currentJob: cloudJob,
      executionEnabled: true,
      currentJobResultCount: 3,
    });
    const runtimeRender = buildCursorDashboardWorkCurrent({
      currentFocusLaneId: 'andrea_runtime',
      currentRuntimeTask: runtimeJob,
      executionEnabled: true,
    });
    const emptyRender = buildCursorDashboardWorkCurrent({
      currentFocusLaneId: null,
      executionEnabled: false,
    });

    expect(cursorRender.text).toContain('*Current Work*');
    expect(cursorRender.text).toContain('Lane: Cursor Cloud');
    expect(
      cursorRender.inlineActionRows.flat().map((action) => action.label),
    ).toContain('Continue');

    expect(runtimeRender.text).toContain('*Current Work*');
    expect(runtimeRender.text).toContain('Lane: Codex/OpenAI runtime');
    expect(
      runtimeRender.inlineActionRows.flat().map((action) => action.label),
    ).toContain('View Output');

    expect(emptyRender.text).toContain(
      'No current work is selected in this chat yet',
    );
  });

  it('distinguishes an unavailable runtime list from a successfully empty list', () => {
    const unavailable = buildCursorDashboardRuntimeJobsUnavailable();
    const empty = buildCursorDashboardRuntimeJobs({ jobs: [], page: 0 });

    expect(unavailable.text).toContain(
      'Recent work is temporarily unavailable',
    );
    expect(unavailable.text).toContain('This is not an empty work list');
    expect(unavailable.text).not.toContain(
      'No recent Codex/OpenAI tasks were found',
    );
    expect(unavailable.text).toContain(
      'will not start, continue, or stop any task',
    );
    expect(unavailable.inlineActionRows).toEqual([
      [{ label: 'Check again', actionId: '/cursor-ui runtime-jobs' }],
      [{ label: 'Back', actionId: '/cursor-ui runtime' }],
    ]);
    expect(unavailable.selectedAgentId).toBeUndefined();
    expect(empty.text).toContain('No recent Codex/OpenAI tasks were found');
  });

  it('retains the exact selected runtime task during an outage without stale execution controls', () => {
    const render = buildCursorDashboardWorkCurrent({
      currentFocusLaneId: 'andrea_runtime',
      currentRuntimeRecovery: runtimeUnavailable,
      executionEnabled: true,
    });

    expect(render.text).toContain('*Current Work*');
    expect(render.text).toContain('Selected task temporarily unavailable.');
    expect(render.text).toContain(`Job ID: ${runtimeJob.handle.jobId}`);
    expect(render.text).toContain('Execution status: unknown');
    expect(render.text).toContain('Your selection is retained.');
    expect(render.text).toContain(
      'Last recorded task update: 2026-03-30T12:03:00.000Z (cached, not current)',
    );
    expect(render.text).not.toMatch(
      /last checked|Status: Working|System status: running|No current work|Reply with plain text/,
    );
    expect(render.selectedAgentId).toBe(runtimeJob.handle.jobId);
    expect(render.inlineActionRows).toEqual([
      [{ label: 'Check again', actionId: '/cursor-ui work-current' }],
      [{ label: 'Back', actionId: '/cursor-ui home' }],
    ]);
  });

  it('prefers outage truth over an accidentally supplied stale runtime card', () => {
    const staleTask = {
      ...runtimeJob,
      status: 'succeeded',
      title: 'PRIVATE_CACHED_PROMPT',
      summary: 'PRIVATE_CACHED_SUMMARY',
      metadata: { finalOutputText: 'PRIVATE_CACHED_OUTPUT' },
    };
    const render = buildCursorDashboardWorkCurrent({
      currentFocusLaneId: 'andrea_runtime',
      currentRuntimeTask: staleTask,
      currentRuntimeRecovery: runtimeUnavailable,
      executionEnabled: true,
    });

    expect(render.text).toContain('Execution status: unknown');
    expect(render.text).not.toContain('PRIVATE_CACHED');
    expect(render.text).not.toContain('Status: Done');
    expect(
      render.inlineActionRows.flat().map((action) => action.label),
    ).toEqual(['Check again', 'Back']);
  });

  it('does not invent task history when no matching cache is available', () => {
    for (const cached of [
      null,
      { ...runtimeUnavailable.cached!, jobId: 'another-task' },
    ]) {
      const render = buildCursorDashboardRuntimeCurrentUnavailable({
        ...runtimeUnavailable,
        cached,
      });

      expect(render.text).toContain('*Current Task*');
      expect(render.text).toContain(`Job ID: ${runtimeJob.handle.jobId}`);
      expect(render.text).not.toContain('Last recorded task update');
      expect(render.text).not.toContain('another-task');
      expect(render.inlineActionRows).toEqual([
        [{ label: 'Check again', actionId: '/cursor-ui work-current' }],
        [{ label: 'Back', actionId: '/cursor-ui runtime' }],
      ]);
    }
  });

  it('labels recovery on the home and runtime overview without replacing a Cursor focus', () => {
    const homeParams = {
      cloudLine: 'ready',
      desktopLine: 'optional and unavailable',
      runtimeRouteLine: 'optional and off',
      codexRuntimeLine: 'temporarily unavailable',
      currentJob: cloudJob,
      currentRuntimeTask: runtimeJob,
      currentRuntimeRecovery: runtimeUnavailable,
    };
    const runtimeHome = buildCursorDashboardHome({
      ...homeParams,
      currentFocusLaneId: 'andrea_runtime',
    });
    const cursorHome = buildCursorDashboardHome({
      ...homeParams,
      currentFocusLaneId: 'cursor',
    });
    const overview = buildCursorDashboardRuntime({
      executionEnabled: true,
      readinessLine: 'temporarily unavailable',
      currentTask: runtimeJob,
      currentTaskRecovery: runtimeUnavailable,
    });

    expect(runtimeHome.text).toContain(
      `Current work: Codex/OpenAI runtime ${runtimeJob.handle.jobId} — temporarily unavailable`,
    );
    expect(runtimeHome.text).toContain(
      'Check again; that only reads the backend.',
    );
    expect(runtimeHome.text).not.toContain(
      'Current Codex/OpenAI task: none selected yet',
    );
    expect(runtimeHome.text).not.toContain(
      'Replying to a task card always continues',
    );
    expect(cursorHome.text).toContain('Current work: Cursor Cloud');
    expect(cursorHome.text).toContain('Current focus: Cursor');
    expect(cursorHome.text).not.toContain('Current work: Codex/OpenAI runtime');
    expect(overview.text).toContain(
      `Current task: Codex/OpenAI runtime ${runtimeJob.handle.jobId} — temporarily unavailable`,
    );
    expect(overview.text).toContain(
      'enabled locally; backend state unverified',
    );
    expect(overview.text).not.toContain('ready on this host');
    expect(overview.text).not.toContain('Current task: none selected yet');
  });

  it('does not hide an available Cursor card when another lane is unavailable', () => {
    const params = {
      currentFocusLaneId: 'cursor' as const,
      currentJob: cloudJob,
      executionEnabled: true,
      currentJobResultCount: 3,
    };
    expect(
      buildCursorDashboardWorkCurrent({
        ...params,
        currentRuntimeRecovery: runtimeUnavailable,
      }),
    ).toEqual(buildCursorDashboardWorkCurrent(params));
  });

  it('preserves unusual opaque handles without injecting card content or commands', () => {
    const selectedJobId =
      'runtime_[x](https://invalid.example)\\odd`*\nStop Run\u202e';
    const render = buildCursorDashboardRuntimeCurrentUnavailable({
      ...runtimeUnavailable,
      selectedJobId,
      cached: null,
    });
    const idLine = render.text
      .split('\n')
      .find((line) => line.startsWith('Job ID: '))!;
    const encoded = idLine
      .slice('Job ID: '.length)
      .replace(/ \(JSON-escaped\)$/, '');

    expect(JSON.parse(encoded)).toBe(selectedJobId);
    expect(render.selectedAgentId).toBe(selectedJobId);
    expect(idLine).not.toMatch(/[`*[\]\u202e]/);
    expect(render.text).not.toContain('\nStop Run');
    expect(
      render.inlineActionRows.flat().map((action) => action.actionId),
    ).toEqual(['/cursor-ui work-current', '/cursor-ui runtime']);
  });

  it('shows repo and prompt preview in the create confirmation view', () => {
    const render = buildCursorDashboardWizardConfirm({
      sourceRepository: 'owner/repo',
      promptText: 'Reply with exactly: ok',
    });

    expect(render.text).toContain('owner/repo');
    expect(render.text).toContain('Reply with exactly: ok');
    expect(render.inlineActionRows[0].map((action) => action.label)).toEqual([
      'Create',
      'Edit Repo',
    ]);
  });

  it('shows a full safe 512-character handle without shortening it', () => {
    const selectedJobId = 'runtime-'.padEnd(512, 'x');
    const render = buildCursorDashboardRuntimeCurrentUnavailable({
      ...runtimeUnavailable,
      selectedJobId,
      cached: null,
    });

    expect(render.text).toContain(`Job ID: ${selectedJobId}\n`);
    expect(render.text).not.toContain('omitted');
    expect(render.selectedAgentId).toBe(selectedJobId);
    expect(render.text.length).toBeLessThan(4096);
  });

  it.each([
    'runtime-'.padEnd(513, 'x'),
    'runtime-'.padEnd(4097, 'x'),
    '`'.repeat(512),
    '',
    '   ',
  ])(
    'keeps an oversized or invalid reference bound without breaking the recovery card',
    (selectedJobId) => {
      const recovery = { ...runtimeUnavailable, selectedJobId, cached: null };
      const current = buildCursorDashboardRuntimeCurrentUnavailable(recovery);
      const home = buildCursorDashboardHome({
        cloudLine: 'ready',
        desktopLine: 'optional',
        runtimeRouteLine: 'off',
        codexRuntimeLine: 'unavailable',
        currentFocusLaneId: 'andrea_runtime',
        currentRuntimeRecovery: recovery,
      });

      expect(current.text).toContain('omitted; selection retained');
      expect(current.selectedAgentId).toBe(selectedJobId);
      expect(current.text.length).toBeLessThan(4096);
      expect(home.text.length).toBeLessThan(4096);
      expect(current.text).not.toContain(`Job ID: ${selectedJobId}\n`);
      expect(current.inlineActionRows[0]).toEqual([
        { label: 'Check again', actionId: '/cursor-ui work-current' },
      ]);
    },
  );
});
