import {
  buildIntegrationDoctorReport,
  buildIntegrationFixGuidance,
  formatIntegrationDoctorReport,
} from '../src/integration-doctor.js';
import { initDatabase } from '../src/db.js';

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  tsx scripts/integrations.ts status [--json]',
      '  tsx scripts/integrations.ts doctor [--json]',
      '  tsx scripts/integrations.ts fix --id <integration>',
      '',
      'Examples:',
      '  npm run integrations:status',
      '  npm run integrations:doctor',
      '  npm run integrations:fix -- --id google_calendar',
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

  if (command === 'status' || command === 'doctor') {
    const report = buildIntegrationDoctorReport();
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

  printUsage();
  process.exit(rawCommand ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
