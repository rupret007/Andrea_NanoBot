import {
  buildIntegrationDoctorReport,
  buildIntegrationFixGuidance,
  formatIntegrationDoctorReport,
} from '../src/integration-doctor.js';
import { initDatabase } from '../src/db.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from '../src/provider-live-probe.js';
import {
  buildRepairDoctorReport,
  formatRepairDoctorReport,
  runIntegrationRepair,
} from '../src/integration-healer.js';

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  tsx scripts/integrations.ts status [--json] [--config-only]',
      '  tsx scripts/integrations.ts doctor [--json] [--config-only]',
      '  tsx scripts/integrations.ts fix --id <integration>',
      '  tsx scripts/integrations.ts heal --id <integration> [--dry-run|--apply] [--json]',
      '',
      'Examples:',
      '  npm run integrations:status',
      '  npm run integrations:doctor',
      '  npm run integrations:fix -- --id google_calendar',
      '  npm run integrations:heal -- --id bluebubbles --dry-run',
    ].join('\n'),
  );
}

function readArgValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] || null;
}

async function main(): Promise<void> {
  initDatabase();
  const [rawCommand, ...args] = process.argv.slice(2);
  const command = (rawCommand || 'status').toLowerCase();
  const json = args.includes('--json');
  const configOnly = args.includes('--config-only');

  if (command === 'status' || command === 'doctor') {
    const now = new Date();
    const providers = configOnly
      ? undefined
      : await collectProviderHealthSnapshotsWithLiveProbe(now.toISOString());
    const report = buildIntegrationDoctorReport({ now, providers });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatIntegrationDoctorReport(report, command));
    return;
  }

  if (command === 'fix') {
    const id = readArgValue(args, '--id') || args[0];
    if (!id) {
      printUsage();
      process.exit(1);
    }
    console.log(buildIntegrationFixGuidance(id));
    return;
  }

  if (command === 'heal') {
    const id = readArgValue(args, '--id') || args[0];
    if (!id) {
      printUsage();
      process.exit(1);
    }
    const attempt = await runIntegrationRepair({
      id,
      dryRun: args.includes('--dry-run') || !args.includes('--apply'),
      apply: args.includes('--apply'),
    });
    const report = buildRepairDoctorReport();
    if (json) {
      console.log(JSON.stringify({ attempt, report }, null, 2));
      return;
    }
    console.log(formatRepairDoctorReport(report));
    return;
  }

  printUsage();
  process.exit(rawCommand ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
