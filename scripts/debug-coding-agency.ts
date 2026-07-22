import {
  formatCodingCapabilityRegistry,
  inspectCodingCapabilities,
} from '../src/coding-capability-registry.js';

async function main(): Promise<void> {
  const probe = process.argv.includes('--probe');
  const requireReady = process.argv.includes('--require-ready');
  const registry = await inspectCodingCapabilities({ probe });
  process.stdout.write(`${formatCodingCapabilityRegistry(registry)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        registryVersion: 1,
        probe,
        entries: registry.list().map((entry) => ({
          id: entry.id,
          state: entry.state,
          operations: entry.operations,
          locality: entry.locality,
          mutability: entry.mutability,
          proof: entry.proof.map((proof) => ({
            source: proof.source,
            observedAt: proof.observedAt,
            summary: proof.summary,
            identity: proof.identity,
          })),
          blocker: entry.blocker,
          nextAction: entry.nextAction,
        })),
      },
      null,
      2,
    )}\n`,
  );
  if (
    requireReady &&
    registry.readyFor('cursor', ['code_edit']).length === 0 &&
    registry.readyFor('codex', ['code_edit']).length === 0
  ) {
    process.exitCode = 2;
  }
}

void main().catch((error) => {
  process.stderr.write(
    `coding_diagnostics=failed error=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
