import { describe, expect, it } from "vitest";

import { runAndreaBench } from "../src/andrea-bench.js";

describe("AndreaBench external adapters", () => {
  it("emits stable dry-run scores for the unified external suite", () => {
    const report = runAndreaBench({
      suite: "external",
      dryRun: true,
      generatedAt: "2026-06-29T00:00:00.000Z",
    });
    expect(report.mode).toBe("dry-run");
    expect(report.scenarioResults.map((result) => result.suite).sort()).toEqual([
      "bfcl",
      "gaia",
      "swe-lite",
      "tau",
    ]);
    expect(report.overallScore).toBeGreaterThan(0.75);
    expect(report.note).toMatch(/not live benchmark performance/i);
  });

  it("can isolate a specific external benchmark family", () => {
    const report = runAndreaBench({
      suite: "bfcl",
      dryRun: true,
      generatedAt: "2026-06-29T00:00:00.000Z",
    });
    expect(report.scenarioResults).toHaveLength(1);
    expect(report.scenarioResults[0].metrics.toolArgumentExactness).toBe(
      report.scenarioResults[0].score,
    );
  });
});
