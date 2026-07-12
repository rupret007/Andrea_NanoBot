import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginAgentRuntimeSpineRun,
  finalizeAgentRuntimeSpineOutcome,
  reconcileInterruptedAgentRuntimeRuns,
  recordAgentRuntimeTruthAudit,
} from './agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getAgentOSEpisode,
  getAgentRuntimeRun,
  listAgentOSEpisodeSteps,
  listAgentOSTrajectoryEvals,
} from './db.js';
import { runTruthEngine } from './truth-engine.js';

describe('agent runtime spine lifecycle', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('closes the linked Agent OS episode without promoting an unreviewed runtime trajectory', () => {
    const generatedAt = '2026-07-12T12:00:00.000Z';
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-lifecycle-complete',
      channel: 'telegram',
      groupFolder: 'main',
      goal: 'Summarize the verified local status.',
      generatedAt,
      mode: 'assistive',
    });
    expect(runtime).not.toBeNull();

    const truth = runTruthEngine({
      text: `Runtime evidence ${runtime?.run.worldSnapshotId}.`,
      subject: runtime?.run.goalSummary || 'runtime status',
      generatedAt,
    });
    recordAgentRuntimeTruthAudit({
      runtime,
      truthVerdict: truth,
      generatedAt,
    });
    const completedAt = '2026-07-12T12:00:01.000Z';
    const finalized = finalizeAgentRuntimeSpineOutcome({
      runtime,
      generatedAt: completedAt,
      evaluationStatus: 'pass',
      routeUsed: 'local_status',
      answerClass: 'handled',
    });

    expect(finalized?.status).toBe('completed');
    const episode = getAgentOSEpisode(
      runtime?.run.agentOSEpisodeId || 'missing',
    );
    expect(episode).toMatchObject({
      status: 'completed',
      completedAt,
    });
    expect(JSON.parse(episode?.linkedRunIdsJson || '[]')).toContain(
      runtime?.run.runtimeRunId,
    );
    expect(
      listAgentOSEpisodeSteps({ episodeId: episode?.episodeId }).at(-1),
    ).toMatchObject({ stepKind: 'outcome', status: 'completed' });
    const trajectory = listAgentOSTrajectoryEvals({
      episodeId: episode?.episodeId,
    })[0];
    expect(trajectory).toMatchObject({
      promotionEligible: false,
      verificationStrength: 0.86,
    });
    expect(trajectory.nextAction).toMatch(/owner-reviewed outcome/i);
  });

  it('marks prior-process active runs interrupted instead of inferring success', () => {
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-lifecycle-interrupted',
      channel: 'bluebubbles',
      groupFolder: 'main',
      goal: 'Show the current deferred message action.',
      generatedAt: '2026-07-12T12:10:00.000Z',
      mode: 'assistive',
    });
    expect(runtime?.run.status).toBe('active');

    const result = reconcileInterruptedAgentRuntimeRuns({
      generatedAt: '2026-07-12T12:11:00.000Z',
    });

    expect(result).toMatchObject({ interrupted: 1, episodeSynced: 1 });
    const storedRun = getAgentRuntimeRun(
      runtime?.run.runtimeRunId || 'missing',
    );
    expect(storedRun?.status).toBe('interrupted');
    expect(storedRun?.outcomeJson).toContain(
      'prior_process_ended_before_outcome_verification',
    );
    const episode = getAgentOSEpisode(
      runtime?.run.agentOSEpisodeId || 'missing',
    );
    expect(episode).toMatchObject({
      status: 'interrupted',
      completedAt: null,
    });
    const trajectory = listAgentOSTrajectoryEvals({
      episodeId: episode?.episodeId,
    })[0];
    expect(trajectory).toMatchObject({
      status: 'fail',
      promotionEligible: false,
    });
    expect(trajectory.demotionSignalsJson).toContain(
      'interrupted_before_outcome_verification',
    );
  });

  it('preserves fresh approval boundaries as nonterminal', () => {
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-lifecycle-approval',
      channel: 'telegram',
      groupFolder: 'main',
      goal: 'Send this external message now.',
      generatedAt: '2026-07-12T12:20:00.000Z',
      mode: 'assistive',
    });
    expect(runtime?.run.status).toBe('awaiting_approval');

    const finalized = finalizeAgentRuntimeSpineOutcome({
      runtime,
      generatedAt: '2026-07-12T12:20:01.000Z',
      evaluationStatus: 'pass',
      routeUsed: 'message_action',
      answerClass: 'handled',
    });

    expect(finalized?.status).toBe('awaiting_approval');
    const episode = getAgentOSEpisode(
      runtime?.run.agentOSEpisodeId || 'missing',
    );
    expect(episode?.status).toBe('awaiting_approval');
    expect(
      listAgentOSTrajectoryEvals({ episodeId: episode?.episodeId }),
    ).toEqual([]);
  });
});
