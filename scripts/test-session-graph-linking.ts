import assert from 'node:assert/strict';

import {
  buildSessionGraphReport,
} from '../src/session-graph.js';
import {
  _closeDatabase,
  _initTestDatabase,
  upsertCommunicationThread,
  upsertLifeThread,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:59:20.000Z';

upsertLifeThread({
  id: 'life:candace-open-loop',
  groupFolder: 'main',
  title: 'Candace follow-through',
  category: 'relationship',
  status: 'active',
  scope: 'personal',
  relatedSubjectIds: ['subject:candace'],
  contextTags: ['messages', 'followthrough'],
  summary: 'Track open communication loops and draft safe replies when asked.',
  nextAction: 'Review the latest Messages metadata before drafting.',
  sourceKind: 'explicit',
  confidenceKind: 'high',
  userConfirmed: true,
  sensitivity: 'normal',
  surfaceMode: 'default',
  followthroughMode: 'manual_only',
  createdAt: generatedAt,
  lastUpdatedAt: generatedAt,
});

upsertCommunicationThread({
  id: 'comm:candace-bluebubbles',
  groupFolder: 'main',
  title: 'Candace Messages thread',
  linkedSubjectIds: ['subject:candace'],
  linkedLifeThreadIds: ['life:candace-open-loop'],
  channel: 'bluebubbles',
  channelChatJid: 'bb:iMessage;-;+14695405551',
  lastInboundSummary: 'Asked for help deciding what to say back.',
  lastOutboundSummary: 'Andrea drafted a reply but held send approval.',
  followupState: 'reply_needed',
  urgency: 'soon',
  suggestedNextAction: 'draft_reply',
  toneStyleHints: ['warm', 'brief'],
  lastContactAt: generatedAt,
  lastMessageId: 'msg-1',
  inferenceState: 'user_confirmed',
  trackingMode: 'default',
  createdAt: generatedAt,
  updatedAt: generatedAt,
});

const report = buildSessionGraphReport({
  generatedAt: '2026-06-06T23:59:21.000Z',
});

const lifeNode = report.nodes.find((node) => node.nodeKind === 'life_thread');
const messageNode = report.nodes.find(
  (node) => node.nodeKind === 'bluebubbles_thread',
);

assert.ok(lifeNode, 'life thread should be represented');
assert.ok(messageNode, 'BlueBubbles thread should be represented');
assert.ok(
  report.edges.some(
    (edge) =>
      edge.status === 'accepted' &&
      [edge.fromNodeId, edge.toNodeId].includes(lifeNode.nodeId) &&
      [edge.fromNodeId, edge.toNodeId].includes(messageNode.nodeId),
  ),
  'linked life/communication threads should have deterministic accepted edge',
);
assert.ok(
  report.clusters.some((cluster) => {
    return (
      cluster.nodeIdsJson.includes(lifeNode.nodeId) &&
      cluster.nodeIdsJson.includes(messageNode.nodeId)
    );
  }),
  'linked threads should land in the same cluster',
);

const serialized = JSON.stringify(report);
assert.doesNotMatch(serialized, /\+14695405551/);
assert.match(serialized, /fp:/);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      lifeNode: lifeNode.nodeId,
      messageNode: messageNode.nodeId,
      clusters: report.clusters.length,
      reviewNeeded: report.reviewNeededCount,
      nextAction: report.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
