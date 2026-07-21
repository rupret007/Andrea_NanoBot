import { _closeDatabase, initDatabase } from '../src/db.js';
import { loadGroundedContextBundle } from '../src/grounded-memory-durable-adapter.js';
import {
  buildUnifiedGroundedCognitiveFrame,
  resolveUnifiedGroundedCognitionMode,
  unifiedGroundedCognitionDiagnostics,
} from '../src/unified-grounded-cognition.js';

/**
 * Read-only local diagnostics. This command retrieves bounded context and builds
 * a transient frame; it never journals, calls tools, consumes approvals, or sends.
 *
 * npm run debug:unified-grounded-cognition -- --request "..."
 */
const args = process.argv.slice(2);

function value(flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function main(): void {
  const request = value('--request');
  if (!request) throw new Error('--request <text> is required.');

  initDatabase();
  try {
    const now = new Date().toISOString();
    const memoryBundle = loadGroundedContextBundle({
      topics: [request],
      now,
      maxItems: 10,
      maxChars: 5_000,
    });
    const frame = buildUnifiedGroundedCognitiveFrame({
      turnId: `diagnostic:${Date.now()}`,
      conversationId: 'local-diagnostic',
      channel: 'system',
      actorId: 'owner',
      groupFolder: 'main',
      text: request,
      now,
      runOrigin: 'live',
      taskFamily: 'diagnostic',
      mode: resolveUnifiedGroundedCognitionMode(),
      memoryBundle,
    });
    console.log(
      JSON.stringify(unifiedGroundedCognitionDiagnostics(frame), null, 2),
    );
  } finally {
    _closeDatabase();
  }
}

main();
