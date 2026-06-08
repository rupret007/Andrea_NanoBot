import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import {
  buildSessionGraphStatusText,
  isSessionGraphNaturalRequest,
} from '../src/session-graph.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

beginAgentRuntimeSpineRun({
  turnId: 'session-graph-turn',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'planning',
  goal: 'Show what Andrea is working on and what safe continuity action comes next.',
  generatedAt: '2026-06-06T23:59:40.000Z',
  mode: 'assistive',
});

assert.equal(isSessionGraphNaturalRequest('what sessions are connected?'), true);
assert.equal(isSessionGraphNaturalRequest('what belongs together?'), true);
assert.equal(isSessionGraphNaturalRequest('ordinary chat hello'), false);

const text = buildSessionGraphStatusText();

assert.match(text, /Session Graph/);
assert.match(text, /Continuity clusters/);
assert.match(text, /Suggested next safe actions/);
assert.match(text, /metadata-only graph/);
assert.doesNotMatch(text, /raw private body text|hidden reasoning text|provider debate text|sk-proj-/i);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      naturalControls: [
        'what sessions are connected?',
        'what belongs together?',
        'session graph status',
      ],
      preview: text.split('\n').slice(0, 6),
    },
    null,
    2,
  ),
);

_closeDatabase();
