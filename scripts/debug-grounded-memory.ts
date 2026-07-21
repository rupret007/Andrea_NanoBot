import { _closeDatabase, initDatabase } from '../src/db.js';
import {
  diffGroundedMemorySince,
  explainGroundedMemoryTopicDurably,
  groundedMemoryDurableDiagnostics,
  loadGroundedContextBundle,
} from '../src/grounded-memory-durable-adapter.js';
import { formatGroundedContextBundle } from '../src/grounded-memory.js';

/**
 * Read-only grounded memory and goal diagnostics.
 *
 * Usage:
 *   npm run debug:grounded-memory                     # counts overview
 *   npm run debug:grounded-memory -- --topic backup   # topic explanation
 *   npm run debug:grounded-memory -- --bundle backup  # retrieval preview
 *   npm run debug:grounded-memory -- --since 2026-07-20T00:00:00Z
 *
 * Prints bounded, redacted metadata only; never message bodies or secrets,
 * and never writes memory, goals, or any other state.
 */

const args = process.argv.slice(2);
const json = args.includes('--json');

function argValue(flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function main(): void {
  initDatabase();
  const now = new Date().toISOString();
  try {
    const topic = argValue('--topic');
    const bundleTopic = argValue('--bundle');
    const since = argValue('--since');
    if (topic) {
      const explanation = explainGroundedMemoryTopicDurably({ topic, now });
      if (json) {
        console.log(JSON.stringify(explanation, null, 2));
        return;
      }
      console.log(`Topic: ${explanation.subjectKey}`);
      console.log(`Active beliefs (${explanation.active.length}):`);
      for (const record of explanation.active) {
        console.log(
          `  [${record.effectiveState}/${record.sourceType} c=${record.confidence.toFixed(2)}] ${record.statement}`,
        );
        console.log(`    why: ${record.stateReason}`);
        if (record.provenanceRefs.length) {
          console.log(`    evidence: ${record.provenanceRefs.join(', ')}`);
        }
      }
      console.log(`History (${explanation.history.length}):`);
      for (const record of explanation.history) {
        console.log(
          `  [${record.state}] ${record.value} — ${record.stateReason}`,
        );
      }
      if (explanation.contradictions.length) {
        console.log(
          `Contradiction groups: ${explanation.contradictions
            .map((group) => group.join(' <-> '))
            .join('; ')}`,
        );
      }
      console.log(`Related goals (${explanation.goals.length}):`);
      for (const goal of explanation.goals) {
        console.log(
          `  [${goal.state}] ${goal.title}${goal.blockers.length ? ` (blockers: ${goal.blockers.join('; ')})` : ''}`,
        );
        if (goal.nextProposedStep) {
          console.log(`    next (informational): ${goal.nextProposedStep}`);
        }
      }
      return;
    }
    if (bundleTopic) {
      const bundle = loadGroundedContextBundle({
        topics: [bundleTopic],
        now,
      });
      console.log(
        json
          ? JSON.stringify(bundle, null, 2)
          : formatGroundedContextBundle(bundle),
      );
      return;
    }
    if (since) {
      const diff = diffGroundedMemorySince(since, {});
      if (json) {
        console.log(JSON.stringify(diff, null, 2));
        return;
      }
      console.log(`Memory changes since ${since} (${diff.memory.length}):`);
      for (const entry of diff.memory) {
        console.log(
          `  [${entry.state}] ${entry.subjectKey} — ${entry.stateReason}`,
        );
      }
      console.log(`Goal changes since ${since} (${diff.goals.length}):`);
      for (const goal of diff.goals) {
        console.log(`  [${goal.state}] ${goal.title} — ${goal.stateReason}`);
      }
      return;
    }
    const diagnostics = groundedMemoryDurableDiagnostics(now);
    if (json) {
      console.log(JSON.stringify(diagnostics, null, 2));
      return;
    }
    console.log('Grounded memory diagnostics (read-only)');
    console.log(
      `Memory: active=${diagnostics.memoryCounts.active} uncertain=${diagnostics.memoryCounts.uncertain} superseded=${diagnostics.memoryCounts.superseded} revoked=${diagnostics.memoryCounts.revoked}`,
    );
    console.log(
      `Goals: proposed=${diagnostics.goalCounts.proposed} active=${diagnostics.goalCounts.active} blocked=${diagnostics.goalCounts.blocked} completed=${diagnostics.goalCounts.completed} cancelled=${diagnostics.goalCounts.cancelled} stale=${diagnostics.goalCounts.stale}`,
    );
    console.log(
      `Contradicted subjects: ${diagnostics.contradictedSubjects.join(', ') || 'none'}`,
    );
    console.log(
      `Goals past review deadline: ${diagnostics.staleGoals.join(', ') || 'none'}`,
    );
    console.log(
      'Hint: --topic <topic>, --bundle <topic>, --since <iso>, --json',
    );
  } finally {
    _closeDatabase();
  }
}

main();
