import { pathToFileURL } from 'node:url';

import {
  buildAgiReadinessReport,
  collectPublishStatus,
  formatAgiReadinessMarkdown,
  writeAgiReadinessArtifacts,
} from '../src/agi-readiness.js';
import { runAgiScorecard } from '../src/agi-scorecard.js';
import { initDatabase } from '../src/db.js';
import { buildIntegrationDoctorReport } from '../src/integration-doctor.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import { collectProviderHealthSnapshots } from '../src/provider-health.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from '../src/provider-live-probe.js';
import { runAgiDoctor } from './agi-doctor.js';

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
  const generatedAt = new Date().toISOString();
  const mode = hasFlag('--live') ? 'live' : 'deterministic';
  const json = hasFlag('--json');
  const noLiveProbe = hasFlag('--no-live-probe');
  const write = hasFlag('--write');
  const stateDir = readValue('--state-dir');

  const scorecard = await runAgiScorecard({
    mode,
    includeDogfood: !hasFlag('--no-dogfood'),
  });
  initDatabase();
  const doctor = await runAgiDoctor();
  const providers = noLiveProbe
    ? collectProviderHealthSnapshots(generatedAt)
    : await collectProviderHealthSnapshotsWithLiveProbe(generatedAt);
  const integrations = buildIntegrationDoctorReport({
    now: new Date(generatedAt),
    providers,
  });
  const liveProof = buildLiveProofGauntletReport({
    now: new Date(generatedAt),
  });
  const publishStatus = collectPublishStatus();
  const result = buildAgiReadinessReport({
    generatedAt,
    scorecard,
    doctor,
    integrations,
    liveProof,
    publishStatus,
  });
  const artifacts = write
    ? await writeAgiReadinessArtifacts(result, { stateDir })
    : undefined;
  const output = artifacts ? { ...result, artifactPaths: artifacts } : result;

  if (json) {
    console.log(JSON.stringify({ result: output, artifacts }, null, 2));
  } else {
    console.log(formatAgiReadinessMarkdown(output));
    if (artifacts) console.log(`Artifacts: ${artifacts.dir}`);
  }

  if (
    hasFlag('--fail-on-repo-blocker') &&
    result.blockers.some((blocker) => blocker.category === 'repo_fix_required')
  ) {
    process.exitCode = 1;
  }
  if (
    hasFlag('--fail-on-scorecard-regression') &&
    result.deterministicScorecard.regressions.length > 0
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
