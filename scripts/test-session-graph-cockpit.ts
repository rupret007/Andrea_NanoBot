import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import {
  buildSessionGraphReport,
  formatSessionContinuityCockpit,
  formatSessionGraphReport,
} from '../src/session-graph.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-07T00:12:00.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|raw private body text|hidden reasoning text|provider debate text/i;

beginAgentRuntimeSpineRun({
  turnId: 'session-graph-cockpit-one',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Connect active runtime proof debt and approval checkpoints into one useful next-action cockpit.',
  generatedAt,
  mode: 'assistive',
});

beginAgentRuntimeSpineRun({
  turnId: 'session-graph-cockpit-two',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Connect active runtime proof debt and approval checkpoints into one useful next-action cockpit.',
  generatedAt: '2026-06-07T00:12:01.000Z',
  mode: 'assistive',
});

const report = buildSessionGraphReport({
  generatedAt: '2026-06-07T00:12:02.000Z',
});
const cockpit = report.cockpit;
const cockpitText = formatSessionContinuityCockpit(cockpit);
const fullText = formatSessionGraphReport(report);

assert.equal(cockpit.privacy.metadataOnly, true);
assert.equal(cockpit.privacy.rawPrivateBodiesStored, false);
assert.equal(cockpit.privacy.hiddenReasoningStored, false);
assert.equal(cockpit.privacy.secretsRedacted, true);
assert.ok(cockpit.focusCount >= 1, 'cockpit should include at least one focus');
assert.ok(cockpit.actionCount >= 1, 'cockpit should include at least one action');
assert.ok(
  cockpit.actionCount <= report.suggestions.length,
  'cockpit should dedupe or preserve suggestions, never expand noise',
);
assert.equal(
  new Set(cockpit.actionQueue.map((item) => item.actionId)).size,
  cockpit.actionQueue.length,
  'action queue should use stable unique action ids',
);
assert.ok(cockpit.nextAction.length > 0, 'cockpit should choose a best next action');
assert.match(cockpitText, /Continuity Cockpit/);
assert.match(fullText, /Cockpit:/);
assert.doesNotMatch(JSON.stringify({ report, cockpitText, fullText }), SECRET_RE);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      cockpitStatus: cockpit.status,
      focusCount: cockpit.focusCount,
      actionCount: cockpit.actionCount,
      rawSuggestionCount: report.suggestions.length,
      firstAction: cockpit.actionQueue[0]?.kind || 'none',
      nextAction: cockpit.nextAction,
      privacy: cockpit.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
