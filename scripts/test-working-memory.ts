import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase, listMemoryItems, listWorkingMemoryFrames } from '../src/db.js';
import { analyzeMetacognitiveTurn, formatWorkingMemoryReport } from '../src/metacognition.js';

_initTestDatabase();

const analysis = analyzeMetacognitiveTurn({
  rawAsk: 'quick answer: what is 2+2?',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  threadId: 'thread:main',
  activeContextSummary: 'Current chat is a simple math ask.',
  now: '2026-06-09T20:00:00.000Z',
});

assert.equal(analysis.mode, 'fast_direct');
assert.ok(analysis.frame.frameId);
assert.ok(analysis.items.some((item) => item.itemKind === 'user_ask'));
assert.ok(analysis.items.some((item) => item.source === 'reality_grounding'));
assert.equal(analysis.deliberation.hiddenReasoningStored, false);

const storedFrames = listWorkingMemoryFrames({ limit: 3 });
assert.equal(storedFrames[0]?.frameId, analysis.frame.frameId);
const storedItems = listMemoryItems({ frameId: analysis.frame.frameId });
assert.ok(storedItems.length >= 2);

const formatted = formatWorkingMemoryReport();
assert.match(formatted, /Working Memory/);
assert.doesNotMatch(formatted, /sk-[A-Za-z0-9_-]{12,}/);
assert.doesNotMatch(formatted, /chain[- ]of[- ]thought/i);

_closeDatabase();
console.log('working memory tests passed');
