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
  buildCursorDashboardRuntimeJobs,
  buildCursorDashboardWizardConfirm,
  formatCursorDashboardState,
  parseCursorDashboardState,
} from './cursor-dashboard.js';
import type {
  BackendJobDetails,
  BackendJobSummary,
} from './backend-lanes/types.js';
import type { FlattenedCursorJobEntry } from './cursor-operator-context.js';

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
    expect(cursorRender.inlineActionRows.flat().map((action) => action.label)).toContain(
      'Continue',
    );

    expect(runtimeRender.text).toContain('*Current Work*');
    expect(runtimeRender.text).toContain('Lane: Codex/OpenAI runtime');
    expect(runtimeRender.inlineActionRows.flat().map((action) => action.label)).toContain(
      'View Output',
    );

    expect(emptyRender.text).toContain('No current work is selected in this chat yet');
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
});
