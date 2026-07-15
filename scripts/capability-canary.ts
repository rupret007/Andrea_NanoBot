import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { initDatabase } from '../src/db.js';
import { capabilityCanaryCliDependencies } from '../src/capability-canary-runtime.js';
import {
  buildCapabilityCanaryUsage,
  formatCapabilityCanaryReport,
  parseCapabilityCanaryArgs,
  runCapabilityCanaryCli,
} from '../src/capability-canary-cli.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCapabilityCanaryArgs(args);
  if (options.help) {
    console.log(buildCapabilityCanaryUsage());
    return;
  }
  initDatabase();
  const report = await runCapabilityCanaryCli(
    options,
    capabilityCanaryCliDependencies(),
  );
  console.log(
    options.json
      ? JSON.stringify(report, null, 2)
      : formatCapabilityCanaryReport(report),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `Capability canary command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(buildCapabilityCanaryUsage());
    process.exitCode = 1;
  });
}
