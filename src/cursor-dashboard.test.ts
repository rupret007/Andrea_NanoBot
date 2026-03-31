import { describe, expect, it } from 'vitest';

import {
  buildCursorDashboardCurrentJob,
  buildCursorDashboardCurrentJobEmpty,
  buildCursorDashboardHelp,
  buildCursorDashboardHome,
  buildCursorDashboardJobs,
  buildCursorDashboardWizardConfirm,
  formatCursorDashboardState,
  parseCursorDashboardState,
} from './cursor-dashboard.js';
import type { FlattenedCursorJobEntry } from './cursor-operator-context.js';

const cloudJob: FlattenedCursorJobEntry = {
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

  it('builds cloud current-job controls around sync, text, files, and follow-up', () => {
    const render = buildCursorDashboardCurrentJob(cloudJob, 3);
    const labels = render.inlineActionRows.flat().map((action) => action.label);

    expect(render.text).toContain('reply to this dashboard with plain text');
    expect(labels).toContain('Sync');
    expect(labels).toContain('Text');
    expect(labels).toContain('Files');
    expect(labels).toContain('Follow Up');
    expect(labels).toContain('Stop');
  });

  it('builds desktop current-job controls around messages and terminal actions', () => {
    const render = buildCursorDashboardCurrentJob(desktopJob, 0);
    const labels = render.inlineActionRows.flat().map((action) => action.label);

    expect(labels).toContain('Messages');
    expect(labels).toContain('Terminal Status');
    expect(labels).toContain('Terminal Log');
    expect(labels).toContain('Terminal Help');
  });

  it('provides a friendly empty current-job state and compact home/help tiles', () => {
    expect(buildCursorDashboardCurrentJobEmpty().text).toContain(
      'No Cursor job is selected',
    );
    expect(
      buildCursorDashboardHome({
        cloudLine: 'ready',
        desktopLine: 'optional and unavailable',
        runtimeLine: 'optional and off',
      }).inlineActionRows,
    ).toHaveLength(3);
    expect(buildCursorDashboardHelp().text).toContain(
      'Slash commands still work',
    );
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
