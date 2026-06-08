import { initDatabase } from '../src/db.js';
import {
  buildRepairDoctorReport,
  formatRepairDoctorReport,
  runIntegrationRepair,
} from '../src/integration-healer.js';

function readArgValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || null : null;
}

async function main(): Promise<void> {
  initDatabase();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const id = readArgValue(args, '--id');
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run') || !apply;
  if (id) {
    const attempt = await runIntegrationRepair({ id, dryRun, apply });
    if (json) {
      console.log(JSON.stringify({ attempt, report: buildRepairDoctorReport() }, null, 2));
      return;
    }
    console.log(formatRepairDoctorReport(buildRepairDoctorReport()));
    return;
  }
  const report = buildRepairDoctorReport();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatRepairDoctorReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
