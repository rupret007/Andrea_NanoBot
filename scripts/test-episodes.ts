import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveEpisodes,
  listStrategyLearningSignals,
} from '../src/db.js';
import {
  applyEpisodeRetention,
  buildEpisodeMemoryReport,
  formatEpisodeMemoryReport,
  formatEpisodeNaturalResponse,
  isEpisodeNaturalRequest,
  recordCognitiveEpisode,
} from '../src/cognitive-episodes.js';

_initTestDatabase();

// Plain episode.
const episode = recordCognitiveEpisode({
  askSummary: 'asked for tomorrow morning schedule overview',
  channel: 'telegram',
  reasoningMode: 'fast_direct',
  result: 'answered',
  confidence: 0.8,
  lesson: 'Morning overviews should lead with the first event.',
  now: '2026-06-09T14:00:00.000Z',
});
assert.equal(episode.sensitivity, 'normal');
assert.equal(episode.retentionPolicy, 'standard_90d');

// Sensitive episodes are flagged, truncated, and short-retained.
const sensitive = recordCognitiveEpisode({
  askSummary: 'question about medication schedule and health insurance details',
  channel: 'bluebubbles',
  reasoningMode: 'retrieve_grounded',
  result: 'answered',
  now: '2026-06-09T14:01:00.000Z',
});
assert.equal(sensitive.sensitivity, 'sensitive');
assert.equal(sensitive.retentionPolicy, 'short_7d');
assert.match(sensitive.askSummary, /\[sensitive topic redacted\]/);
assert.ok(!sensitive.askSummary.includes('medication'));

// Corrections create strategy learning signals.
recordCognitiveEpisode({
  askSummary: 'suggested a morning slot for band practice',
  channel: 'telegram',
  reasoningMode: 'plan_stepwise',
  result: 'answered',
  userCorrection: "don't suggest mornings anymore",
  now: '2026-06-09T14:02:00.000Z',
});
const signals = listStrategyLearningSignals({ limit: 5 });
assert.ok(
  signals.some((signal) => /corrected/i.test(signal.strategyAdjustment)),
);

// Sensitive corrections are stored as category markers, not raw text.
const sensitiveCorrection = recordCognitiveEpisode({
  askSummary: 'preference correction',
  channel: 'telegram',
  reasoningMode: 'unknown_future_mode',
  result: 'answered',
  userCorrection: 'my password is hunter2, do not store it',
  now: '2026-06-09T14:03:00.000Z',
});
assert.equal(sensitiveCorrection.userCorrection, '[sensitive correction redacted]');
assert.equal(sensitiveCorrection.reasoningMode, 'retrieve_grounded');

// Retention prunes old short-lived episodes but keeps recent ones.
recordCognitiveEpisode({
  askSummary: 'old sensitive health question',
  channel: 'telegram',
  reasoningMode: 'fast_direct',
  result: 'answered',
  sensitivity: 'sensitive',
  now: '2026-05-01T10:00:00.000Z',
});
const pruned = applyEpisodeRetention({ now: '2026-06-09T15:00:00.000Z' });
assert.ok(pruned >= 1);
const remaining = listCognitiveEpisodes({ limit: 50 });
assert.ok(
  remaining.every((item) => item.createdAt >= '2026-05-02T00:00:00.000Z'),
);

const report = buildEpisodeMemoryReport({ now: '2026-06-09T15:01:00.000Z' });
assert.ok(report.totalRecent >= 3);
assert.equal(report.corrections, 2);
assert.match(formatEpisodeMemoryReport(report), /Reflective Episodic Memory/);

assert.equal(isEpisodeNaturalRequest('what did you learn today?'), true);
assert.match(formatEpisodeNaturalResponse('what did you learn?'), /corrected/i);

_closeDatabase();
console.log('cognitive episodes tests passed');
