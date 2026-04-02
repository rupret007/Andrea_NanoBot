import {
  formatDebugStatus,
  loadLogControlFromPersistence,
  readDebugLogs,
  resetDebugLevel,
  setDebugLevel,
} from '../src/debug-control.js';
import { initDatabase } from '../src/db.js';

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  tsx scripts/debug-control.ts status',
      '  tsx scripts/debug-control.ts level <normal|debug|verbose> [scope] [duration]',
      '  tsx scripts/debug-control.ts reset [scope|all]',
      '  tsx scripts/debug-control.ts logs [service|stderr|host|current|cursor|runtime] [lines]',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  initDatabase();
  loadLogControlFromPersistence();

  const [command, ...args] = process.argv.slice(2);

  switch ((command || '').toLowerCase()) {
    case 'status':
      console.log(formatDebugStatus());
      return;
    case 'level': {
      const level = args[0];
      if (!level) {
        printUsage();
        process.exit(1);
      }
      const result = setDebugLevel({
        level,
        scopeToken: args[1],
        durationToken: args[2],
        updatedBy: 'host',
        defaultDurationMs: 60 * 60 * 1000,
      });
      console.log(
        [
          'Debug level updated.',
          `Scope: ${result.resolvedScope.label}`,
          `Level: ${result.level}`,
          `Expires: ${result.expiresAt || 'persistent'}`,
        ].join('\n'),
      );
      return;
    }
    case 'reset': {
      const result = resetDebugLevel({
        scopeToken: args[0] || 'all',
        updatedBy: 'host',
      });
      console.log(`Debug logging reset for ${result.resetScope}.`);
      return;
    }
    case 'logs': {
      const parsedLines = Number.parseInt(args[1] || '', 10);
      const payload = readDebugLogs({
        target: args[0] || 'service',
        lines: Number.isFinite(parsedLines) ? parsedLines : 80,
      });
      console.log(`Debug logs: ${payload.title}\n${payload.body}`);
      return;
    }
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
