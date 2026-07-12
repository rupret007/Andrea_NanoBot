import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { runExecutedSyntheticCapabilityGauntlet } from './shadow-improvement-runner.js';

describe('executed synthetic capability gauntlet', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('executes safe local and saved-only handlers against bounded synthetic grounding', async () => {
    const report = await runExecutedSyntheticCapabilityGauntlet({
      now: new Date('2026-06-09T10:00:00.000Z'),
      isolatedStorage: true,
    });

    expect(report.passed).toBe(true);
    expect(report.averageScore).toBe(1);
    expect(report.results).toHaveLength(5);
    expect(
      report.results.map((result) => [
        result.scenarioId,
        result.capabilityId,
        result.status,
      ]),
    ).toEqual([
      ['busy_household_night', 'staff.prioritize', 'passed'],
      ['messaging_followthrough', 'communication.draft_reply', 'passed'],
      ['household_command_center', 'household.family_open_loops', 'passed'],
      ['research_provider_blocked', 'knowledge.summarize_saved', 'passed'],
      ['alexa_concise_voice_flow', 'daily.loose_ends', 'passed'],
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /prepare dinner plan|replace kitchen filter|saved decision note|pickup timing/i,
    );
  });

  it('fails closed without isolated storage', async () => {
    await expect(
      runExecutedSyntheticCapabilityGauntlet({
        now: new Date('2026-06-09T10:00:00.000Z'),
        isolatedStorage: false,
      }),
    ).rejects.toThrow(/requires isolated test storage/);
  });
});
