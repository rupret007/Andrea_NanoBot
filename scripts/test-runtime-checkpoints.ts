import assert from 'node:assert/strict';

import {
  beginAgentRuntimeSpineRun,
  buildAgentRuntimeReplayPacket,
} from '../src/agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentRuntimeCheckpoints,
  listAgentRuntimeInterrupts,
  listAgentRuntimeResumeTokens,
  listAgentRuntimeWrites,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:50:00.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i;

const runtime = beginAgentRuntimeSpineRun({
  turnId: 'runtime-spine-checkpoint',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Send that message later tonight and push the current branch.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime, 'runtime spine should start for mutating goals');
assert.equal(runtime.run.status, 'awaiting_approval');

const checkpoints = listAgentRuntimeCheckpoints({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 20,
});
const writes = listAgentRuntimeWrites({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 20,
});
const interrupts = listAgentRuntimeInterrupts({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 20,
});
const tokens = listAgentRuntimeResumeTokens({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 20,
});
const replay = buildAgentRuntimeReplayPacket(runtime.run.runtimeRunId);

assert.ok(checkpoints.some((checkpoint) => checkpoint.status === 'interrupted'));
assert.ok(writes.some((write) => write.status === 'pending'));
assert.ok(writes.every((write) => write.appliedAt === null || write.status === 'applied'));
assert.ok(interrupts.some((interrupt) => interrupt.interruptKind === 'approval_required'));
assert.ok(tokens.some((token) => token.status === 'active'));
assert.ok(
  replay.runtimeWrites.some((write) => write.status === 'pending'),
  'replay packet should include pending writes',
);
assert.equal(replay.privacy.rawPromptsStored, false);
assert.equal(replay.privacy.rawPrivateBodiesStored, false);
assert.equal(replay.privacy.hiddenReasoningStored, false);

const serialized = JSON.stringify({ runtime, checkpoints, writes, interrupts, tokens, replay });
assert.doesNotMatch(serialized, SECRET_RE);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runtimeRunId: runtime.run.runtimeRunId,
      checkpointCount: checkpoints.length,
      pendingWrites: writes.filter((write) => write.status === 'pending').length,
      interruptCount: interrupts.length,
      resumeTokens: tokens.length,
      nextAction: runtime.report.nextAction,
      privacy: replay.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
