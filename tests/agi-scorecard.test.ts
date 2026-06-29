import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGI_SCORECARD_DIMENSIONS,
  formatAgiScorecardMarkdown,
  runAgiScorecard,
  writeAgiScorecardArtifacts,
} from "../src/agi-scorecard.js";

describe("AGI scorecard", () => {
  it("builds a deterministic intelligence scorecard", async () => {
    const result = await runAgiScorecard({
      generatedAt: "2026-06-29T12:00:00.000Z",
      includeDogfood: false,
    });

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
      "not a claim of general intelligence",
    );
  });

  it("writes JSON and Markdown artifacts under the configured state dir", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agi-scorecard-test-"));
    try {
      const result = await runAgiScorecard({
        generatedAt: "2026-06-29T12:05:00.000Z",
        includeDogfood: false,
      });
      const artifacts = await writeAgiScorecardArtifacts(result, { stateDir });
      const json = JSON.parse(await readFile(artifacts.jsonPath, "utf8")) as {
        runId: string;
      };
      const markdown = await readFile(artifacts.markdownPath, "utf8");

      expect(json.runId).toBe(result.runId);
      expect(markdown).toContain("# Andrea AGI Scorecard");
      expect(artifacts.dir).toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
