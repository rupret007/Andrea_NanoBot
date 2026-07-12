import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AGI_SCORECARD_DIMENSIONS,
  formatAgiScorecardMarkdown,
  runAgiScorecard,
  writeAgiScorecardArtifacts,
} from '../src/agi-scorecard.js';

describe('AGI scorecard', () => {
  let result: Awaited<ReturnType<typeof runAgiScorecard>>;

  beforeAll(async () => {
    result = await runAgiScorecard({
      generatedAt: '2026-06-29T12:00:00.000Z',
      includeDogfood: false,
    });
  }, 180_000);

  it('builds a deterministic intelligence scorecard', () => {
    expect(result.overallScore).toBeGreaterThan(0.8);
    expect(result.grade).toMatch(/^[ABC][+-]?$/);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.pendingActions).toEqual([]);
    expect(result.regressions).toEqual([]);
    expect(result.weaknesses).toEqual([]);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.scenarioResults.length).toBeGreaterThan(20);
    for (const dimension of AGI_SCORECARD_DIMENSIONS) {
      expect(result.dimensionScores[dimension]).toBeGreaterThanOrEqual(0);
      expect(result.dimensionScores[dimension]).toBeLessThanOrEqual(1);
    }
    expect(formatAgiScorecardMarkdown(result)).toContain(
      'not a claim of general intelligence',
    );
    const routeOnly = result.scenarioResults.filter((scenario) =>
      scenario.detail.includes('evidence_scope=route_contract_only'),
    );
    expect(routeOnly).toHaveLength(5);
    expect(
      routeOnly.every(
        (scenario) =>
          scenario.dimension === 'providerRouting' && scenario.score === 1,
      ),
    ).toBe(true);
    expect(
      result.scenarioResults.find(
        (scenario) =>
          scenario.suite === 'synthetic-executed' &&
          scenario.scenarioId === 'messaging_followthrough',
      ),
    ).toMatchObject({ dimension: 'taskCompletion', score: 1, passed: true });
    expect(result.recommendations).toContain(
      'The deterministic suite is saturated; prioritize genuine reviewed outcomes and fresh live evidence instead of adding score-only fixtures.',
    );
    expect(result.recommendations.join('\n')).not.toMatch(
      /Raise .*current score 100%/,
    );
  });

  it('writes JSON and Markdown artifacts under the configured state dir', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'agi-scorecard-test-'));
    try {
      const artifacts = await writeAgiScorecardArtifacts(result, { stateDir });
      const json = JSON.parse(await readFile(artifacts.jsonPath, 'utf8')) as {
        runId: string;
      };
      const markdown = await readFile(artifacts.markdownPath, 'utf8');

      expect(json.runId).toBe(result.runId);
      expect(markdown).toContain('# Andrea AGI Scorecard');
      expect(artifacts.dir).toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
