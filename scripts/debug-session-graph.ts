import {
  formatSessionContinuityCockpit,
  buildSessionGraphReport,
  formatSessionGraphReport,
  loadSessionGraphReport,
} from '../src/session-graph.js';
import {
  initDatabase,
  listSessionClusters,
  listSessionGraphNodes,
  listSessionGraphSuggestions,
} from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const suggestionsOnly = args.includes('--suggestions');
const cockpitOnly = args.includes('--cockpit');
const clusterIndex = args.indexOf('--cluster');
const snapshotIndex = args.indexOf('--snapshot');
const clusterId = clusterIndex >= 0 ? args[clusterIndex + 1] || null : null;
const snapshotId = snapshotIndex >= 0 ? args[snapshotIndex + 1] || null : null;

if (clusterId) {
  const report = snapshotId
    ? loadSessionGraphReport(snapshotId)
    : buildSessionGraphReport();
  const cluster =
    report.clusters.find((item) => item.clusterId === clusterId) ||
    listSessionClusters({ limit: 1000 }).find((item) => item.clusterId === clusterId) ||
    null;
  const nodes = cluster
    ? listSessionGraphNodes({ snapshotId: cluster.snapshotId, limit: 5000 }).filter(
        (node) => JSON.parse(cluster.nodeIdsJson).includes(node.nodeId),
      )
    : [];
  const suggestions = cluster
    ? listSessionGraphSuggestions({
        snapshotId: cluster.snapshotId,
        clusterId: cluster.clusterId,
        limit: 100,
      })
    : [];
  const output = {
    generatedAt: report.generatedAt,
    cluster,
    nodes,
    suggestions,
    nextAction: cluster?.bestNextAction || 'No Session Graph cluster matched that ID.',
    privacy: report.privacy,
  };
  console.log(
    json
      ? JSON.stringify(output, null, 2)
      : [
          'Session Graph Cluster',
          '',
          `Cluster: ${clusterId}`,
          `Status: ${cluster?.status || 'none'}`,
          `Theme: ${cluster?.currentTheme || 'none'}`,
          `Nodes: ${nodes.length}`,
          `Suggestions: ${suggestions.length}`,
          `Next: ${output.nextAction}`,
        ].join('\n'),
  );
  process.exit(0);
}

const report = buildSessionGraphReport();

if (cockpitOnly) {
  const output = {
    generatedAt: report.generatedAt,
    snapshotId: report.snapshot.snapshotId,
    cockpit: report.cockpit,
    nextAction: report.cockpit.nextAction,
    privacy: report.privacy,
  };
  console.log(
    json
      ? JSON.stringify(output, null, 2)
      : formatSessionContinuityCockpit(report.cockpit),
  );
  process.exit(0);
}

if (suggestionsOnly) {
  const output = {
    generatedAt: report.generatedAt,
    snapshotId: report.snapshot.snapshotId,
    suggestions: report.suggestions,
    actionQueue: report.cockpit.actionQueue,
    nextAction: report.cockpit.nextAction,
    privacy: report.privacy,
  };
  console.log(
    json
      ? JSON.stringify(output, null, 2)
      : [
          'Session Graph Suggestions',
          '',
          ...report.cockpit.actionQueue
            .slice(0, 12)
            .map(
              (action) =>
                `- ${action.kind}/${action.status}: ${action.nextAction}`,
            ),
        ].join('\n'),
  );
  process.exit(0);
}

console.log(json ? JSON.stringify(report, null, 2) : formatSessionGraphReport(report));
