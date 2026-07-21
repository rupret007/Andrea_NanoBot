import { _closeDatabase, initDatabase } from '../src/db.js';
import { loadGroundedContextBundle } from '../src/grounded-memory-durable-adapter.js';
import {
  buildGroundedDeliberationPacket,
  evaluateGroundedResponse,
  groundedResponseDiagnostics,
  resolveGroundedAdvisoryMode,
} from '../src/grounded-response-intelligence.js';

/**
 * Read-only local diagnostics. It builds a transient packet and optionally
 * evaluates a supplied draft; it never journals, calls tools, or sends data.
 *
 * npm run debug:grounded-response-intelligence -- --request "..." [--reply "..."]
 */
const args = process.argv.slice(2);

function value(flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function main(): void {
  const request = value('--request');
  if (!request) {
    throw new Error(
      '--request <text> is required; --reply <draft> is optional.',
    );
  }
  initDatabase();
  try {
    const now = new Date().toISOString();
    const memoryBundle = loadGroundedContextBundle({
      topics: [request],
      now,
      maxItems: 8,
      maxChars: 4_000,
    });
    const packet = buildGroundedDeliberationPacket({
      turnId: `diagnostic:${Date.now()}`,
      text: request,
      mode: resolveGroundedAdvisoryMode(),
      now,
      memoryBundle,
    });
    const reply = value('--reply');
    const evaluation = reply ? evaluateGroundedResponse(packet, reply) : null;
    console.log(
      JSON.stringify(groundedResponseDiagnostics(packet, evaluation), null, 2),
    );
  } finally {
    _closeDatabase();
  }
}

main();
