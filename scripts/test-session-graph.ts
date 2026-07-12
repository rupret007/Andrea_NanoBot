import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import { runCognitiveBenchmarkSuite } from '../src/cognitive-kernel.js';
import {
  buildSessionGraphReport,
  formatSessionGraphReport,
} from '../src/session-graph.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listSessionClusters,
  listSessionGraphEdges,
  listSessionGraphNodes,
  listSessionGraphSuggestions,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:59:10.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body text|raw message body text|chain-of-thought text|hidden reasoning text|provider debate text/i;

const runtime = beginAgentRuntimeSpineRun({
  turnId: 'session-graph-core',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Connect Andrea runtime, supervisor, world proof debt, and safe next action metadata.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime, 'runtime spine should seed session metadata');
runCognitiveBenchmarkSuite({
  generatedAt: '2026-06-06T23:59:10.500Z',
});

const report = buildSessionGraphReport({
  generatedAt: '2026-06-06T23:59:11.000Z',
});
const formatted = formatSessionGraphReport(report);

assert.equal(report.ok, true);
assert.ok(report.nodes.some((node) => node.nodeKind === 'runtime_run'));
assert.ok(report.nodes.some((node) => node.nodeKind === 'supervisor_run'));
assert.ok(report.nodes.some((node) => node.nodeKind === 'world_snapshot'));
assert.equal(
  report.nodes.some(
    (node) =>
      node.nodeKind.startsWith('cognitive_') &&
      /cog-bench/i.test(node.sourceId),
  ),
  false,
  'deterministic cognition replay must not enter the live continuity graph',
);
assert.ok(
  report.edges.some(
    (edge) =>
      edge.edgeKind === 'explicit_id' || edge.edgeKind === 'resume_checkpoint',
  ),
  'graph should contain deterministic links',
);
assert.ok(
  report.clusters.length >= 1,
  'graph should create continuity clusters',
);
assert.ok(
  report.suggestions.length >= 1,
  'graph should create safe suggestions',
);
assert.match(formatted, /Session Graph/);

const storedNodes = listSessionGraphNodes({
  snapshotId: report.snapshot.snapshotId,
  limit: 5000,
});
const storedEdges = listSessionGraphEdges({
  snapshotId: report.snapshot.snapshotId,
  limit: 5000,
});
const storedClusters = listSessionClusters({
  snapshotId: report.snapshot.snapshotId,
  limit: 5000,
});
const storedSuggestions = listSessionGraphSuggestions({
  snapshotId: report.snapshot.snapshotId,
  limit: 5000,
});

assert.equal(storedNodes.length, report.nodes.length);
assert.equal(storedEdges.length, report.edges.length);
assert.equal(storedClusters.length, report.clusters.length);
assert.equal(storedSuggestions.length, report.suggestions.length);
assert.doesNotMatch(JSON.stringify({ report, formatted }), SECRET_RE);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      snapshotId: report.snapshot.snapshotId,
      nodes: report.snapshot.nodeCount,
      edges: report.snapshot.edgeCount,
      clusters: report.snapshot.clusterCount,
      suggestions: report.snapshot.suggestionCount,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
