import { describe, expect, it } from 'vitest';

import {
  ALL_SYNCED_MESSAGES_TARGET,
  parseAllSyncedMessagesSummaryIntent,
  parseNamedOpenLoopIntent,
  parseRecentTextReviewIntent,
  parseThreadSummaryIntent,
} from './thread-summary-routing.js';

describe('thread summary routing', () => {
  it('recognizes all-synced Messages summary phrasing with a time window', () => {
    expect(
      parseAllSyncedMessagesSummaryIntent('yeah all text messages for today'),
    ).toMatchObject({
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });
    expect(
      parseAllSyncedMessagesSummaryIntent(
        'Ok Andrea can you use blue bubbles and provide a summary of my texts for the past 48 hours',
      ),
    ).toMatchObject({
      canonicalText:
        'summarize all synced text messages from the last 48 hours',
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'last_hours',
        timeWindowValue: 48,
      },
    });
    expect(
      parseAllSyncedMessagesSummaryIntent(
        'Summarize my text messages for today',
      ),
    ).toMatchObject({
      canonicalText: 'summarize all synced text messages from today',
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });
    expect(
      parseAllSyncedMessagesSummaryIntent(
        'Summarize my text messages in Pops of Punk from today',
      ),
    ).toBeNull();
    expect(
      parseThreadSummaryIntent(
        'Summarize my text messages in Pops of Punk from today',
      ),
    ).toMatchObject({
      arguments: {
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'today',
      },
    });
  });

  it('honors documented named-person summarize phrasing without requiring texts/thread', () => {
    expect(
      parseThreadSummaryIntent('summarize Candace from the last 2 days'),
    ).toMatchObject({
      canonicalText:
        'summarize my text messages in Candace from the last 2 days',
      arguments: {
        targetChatName: 'Candace',
        timeWindowKind: 'last_days',
        timeWindowValue: 2,
      },
    });
    expect(
      parseThreadSummaryIntent('summarize Pops of Punk from the last 2 days'),
    ).toMatchObject({
      arguments: {
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'last_days',
        timeWindowValue: 2,
      },
    });
    expect(
      parseThreadSummaryIntent(
        'Summarize my text messages in Pops of Punk from the last 2 days',
      ),
    ).toMatchObject({
      arguments: {
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'last_days',
        timeWindowValue: 2,
      },
    });
    expect(parseThreadSummaryIntent('summarize Candace')).toMatchObject({
      arguments: {
        targetChatName: 'Candace',
        timeWindowKind: 'default_24h',
      },
    });
    expect(parseThreadSummaryIntent('summarize my day')).toBeNull();
    expect(
      parseThreadSummaryIntent('summarize that we need to leave by 5'),
    ).toBeNull();
    expect(parseThreadSummaryIntent('summarize this')).toBeNull();
    expect(parseAllSyncedMessagesSummaryIntent('summarize Candace')).toBeNull();
  });

  it('recognizes recent text review phrasing with a time window', () => {
    expect(
      parseRecentTextReviewIntent(
        'review my recent texts from the last 6 hours',
      ),
    ).toMatchObject({
      canonicalText: 'review recent text messages from the last 6 hours',
      arguments: {
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'last_hours',
        timeWindowValue: 6,
      },
    });
    expect(
      parseRecentTextReviewIntent('summarize the latest news today'),
    ).toBeNull();
  });

  it('honors named who-do-I-owe phrasing without crawling collective asks', () => {
    expect(
      parseNamedOpenLoopIntent("what's still open with Bob"),
    ).toMatchObject({
      canonicalText: "what's still open with Bob",
      arguments: {
        targetChatName: 'Bob',
        personName: 'Bob',
      },
    });
    expect(
      parseNamedOpenLoopIntent("what's still open with Bob today"),
    ).toMatchObject({
      arguments: {
        targetChatName: 'Bob',
        timeWindowKind: 'today',
      },
    });
    expect(parseNamedOpenLoopIntent('what do I owe Bob')).toMatchObject({
      arguments: { targetChatName: 'Bob' },
    });
    expect(parseNamedOpenLoopIntent('do I owe Bob a reply')).toMatchObject({
      arguments: { targetChatName: 'Bob' },
    });
    expect(parseNamedOpenLoopIntent('what do I owe people')).toBeNull();
    expect(
      parseNamedOpenLoopIntent("what's still open with my family"),
    ).toBeNull();
    expect(
      parseNamedOpenLoopIntent('what do I owe people right now'),
    ).toBeNull();
  });
});
