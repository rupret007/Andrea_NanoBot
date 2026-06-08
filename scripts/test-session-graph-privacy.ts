import assert from 'node:assert/strict';

import { buildSessionGraphReport } from '../src/session-graph.js';
import {
  _closeDatabase,
  _initTestDatabase,
  upsertCommunicationThread,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:59:30.000Z';
const unsafeSecret =
  'sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

upsertCommunicationThread({
  id: 'comm:unsafe-raw-content',
  groupFolder: 'main',
  title: 'Unsafe raw message body test',
  linkedSubjectIds: [],
  linkedLifeThreadIds: [],
  channel: 'telegram',
  channelChatJid: 'tg:123456789',
  lastInboundSummary: `raw private body ${unsafeSecret} hidden reasoning`,
  lastOutboundSummary: 'provider debate should never persist',
  followupState: 'reply_needed',
  urgency: 'soon',
  suggestedNextAction: 'draft_reply',
  toneStyleHints: [],
  lastContactAt: generatedAt,
  lastMessageId: 'msg-secret',
  inferenceState: 'assistant_inferred',
  trackingMode: 'default',
  createdAt: generatedAt,
  updatedAt: generatedAt,
});

const report = buildSessionGraphReport({
  generatedAt: '2026-06-06T23:59:31.000Z',
});
const serialized = JSON.stringify(report);

assert.doesNotMatch(serialized, /sk-proj-/);
assert.doesNotMatch(serialized, /raw private body sk-proj/i);
assert.doesNotMatch(serialized, /hidden reasoning text/i);
assert.doesNotMatch(serialized, /provider debate should never persist/i);
assert.match(serialized, /\[redacted unsafe session metadata\]/);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.equal(report.privacy.secretsRedacted, true);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      snapshotId: report.snapshot.snapshotId,
      nodes: report.snapshot.nodeCount,
      redactionApplied: serialized.includes('[redacted unsafe session metadata]'),
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
