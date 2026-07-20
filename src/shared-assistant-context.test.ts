import { describe, expect, it } from 'vitest';

import { shouldRetainSharedAssistantCapabilitySeed } from './shared-assistant-context.js';

const CREATED_AT = '2026-04-15T17:00:00.000Z';

function reviewSeed(
  reviewedAt?: unknown,
  options: { includeFreshnessSnapshot?: boolean } = {},
): string {
  const includeFreshnessSnapshot = options.includeFreshnessSnapshot !== false;
  return JSON.stringify({
    version: 1,
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    items: [
      {
        itemId: 'review-1',
        rank: 1,
        section: 'needs_reply',
        chatLabel: 'Candace',
        summaryText: 'Candace asked for a reply.',
        ...(includeFreshnessSnapshot
          ? {
              freshnessSnapshot: {
                latestMessageAt: CREATED_AT,
                latestInboundAt: CREATED_AT,
                latestOutboundAt: null,
                snapshotHash: 'snapshot-proof',
              },
            }
          : {}),
      },
    ],
  });
}

describe('shared assistant context retention', () => {
  it('keeps generic capability seeds for exactly ten minutes', () => {
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: CREATED_AT,
        now: new Date('2026-04-15T17:10:00.000Z'),
      }),
    ).toBe(true);
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: CREATED_AT,
        now: new Date('2026-04-15T17:10:00.001Z'),
      }),
    ).toBe(false);
  });

  it('retains a valid review-backed seed through its embedded 36-hour window', () => {
    const recentTextReviewJson = reviewSeed(CREATED_AT);

    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: CREATED_AT,
        recentTextReviewJson,
        now: new Date('2026-04-15T17:10:00.001Z'),
      }),
    ).toBe(true);
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: '2026-04-16T04:59:00.000Z',
        recentTextReviewJson,
        now: new Date('2026-04-17T05:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: '2026-04-17T04:59:00.000Z',
        recentTextReviewJson,
        now: new Date('2026-04-17T05:00:00.001Z'),
      }),
    ).toBe(false);
  });

  it('keeps a legacy review without freshness proof only for the generic ten-minute window', () => {
    const recentTextReviewJson = reviewSeed(CREATED_AT, {
      includeFreshnessSnapshot: false,
    });

    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: CREATED_AT,
        recentTextReviewJson,
        now: new Date('2026-04-15T17:10:00.000Z'),
      }),
    ).toBe(true);
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: '2026-04-15T17:09:59.000Z',
        recentTextReviewJson,
        now: new Date('2026-04-15T17:10:00.001Z'),
      }),
    ).toBe(false);
  });

  it('does not extend a review whose freshness snapshot is malformed', () => {
    const recentTextReviewJson = JSON.stringify({
      ...JSON.parse(reviewSeed(CREATED_AT)),
      items: [
        {
          itemId: 'review-1',
          rank: 1,
          section: 'needs_reply',
          chatLabel: 'Candace',
          summaryText: 'Candace asked for a reply.',
          freshnessSnapshot: {
            latestMessageAt: 'not-a-date',
            snapshotHash: 'snapshot-proof',
          },
        },
      ],
    });

    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: CREATED_AT,
        recentTextReviewJson,
        now: new Date('2026-04-15T17:10:00.001Z'),
      }),
    ).toBe(false);
  });

  it.each([
    ['missing reviewedAt', reviewSeed()],
    ['non-string reviewedAt', reviewSeed(null)],
    ['malformed reviewedAt', reviewSeed('not-a-date')],
    ['future reviewedAt', reviewSeed('2026-04-15T17:00:00.001Z')],
    ['malformed review JSON', '{not json'],
    [
      'review without a bindable item',
      JSON.stringify({ version: 1, reviewedAt: CREATED_AT, items: [] }),
    ],
  ])('fails closed for %s', (_label, recentTextReviewJson) => {
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: CREATED_AT,
        recentTextReviewJson,
        now: new Date(CREATED_AT),
      }),
    ).toBe(false);
  });

  it('fails closed for malformed shared-context timestamps', () => {
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: 'not-a-date',
        now: new Date(CREATED_AT),
      }),
    ).toBe(false);
    expect(
      shouldRetainSharedAssistantCapabilitySeed({
        createdAt: '2026-04-15T17:00:00.001Z',
        now: new Date(CREATED_AT),
      }),
    ).toBe(false);
  });
});
