import { pathToFileURL } from "node:url";

import {
  formatAgiScorecardMarkdown,
  runAgiScorecard,
  writeAgiScorecardArtifacts,
} from "../src/agi-scorecard.js";

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

async function main(): Promise<void> {
  const mode = hasFlag("--live") ? "live" : "deterministic";
  const minScore = Number(readValue("--min-score") ?? "0.8");
  const result = await runAgiScorecard({
    mode,
    includeDogfood: !hasFlag("--no-dogfood"),
  });
  const artifacts = hasFlag("--no-write")
    ? undefined
    : await writeAgiScorecardArtifacts(result, {
        stateDir: readValue("--state-dir"),
      });

  if (hasFlag("--json")) {
    console.log(JSON.stringify({ result, artifacts }, null, 2));
  } else {
    console.log(formatAgiScorecardMarkdown(result));
    if (artifacts) {
      console.log(`Artifacts: ${artifacts.dir}`);
    }
  }

  if (result.overallScore < minScore || result.regressions.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
