import { describe, expect, it } from 'vitest';

import { hasMessagesGroundingPolarityConflict } from './messages-grounding-polarity.js';

describe('Messages provider polarity grounding', () => {
  it.each([
    ['Dinner is not confirmed.', 'Dinner is confirmed.'],
    ['The pickup was never canceled.', 'The pickup was canceled.'],
    ['No reply is needed about dinner.', 'A reply is needed about dinner.'],
    ["Friday doesn't work for Morgan.", 'Friday works for Morgan.'],
    ['The invoice remains unpaid.', 'The invoice was paid.'],
    ['The question is unanswered.', 'The question was answered.'],
  ])('detects a polarity inversion: %s -> %s', (evidenceText, claimText) => {
    expect(
      hasMessagesGroundingPolarityConflict({ claimText, evidenceText }),
    ).toBe(true);
  });

  it.each([
    ['Dinner is not confirmed.', 'Dinner remains unconfirmed.'],
    ['The pickup was not canceled.', 'The pickup was not canceled.'],
    ['No reply is needed about dinner.', 'Dinner does not need a reply.'],
    ['Friday works for Morgan.', 'Friday works for Morgan.'],
  ])(
    'allows matching evidence polarity: %s -> %s',
    (evidenceText, claimText) => {
      expect(
        hasMessagesGroundingPolarityConflict({ claimText, evidenceText }),
      ).toBe(false);
    },
  );

  it('binds polarity to the locally overlapping subject scope', () => {
    const evidenceText =
      'Dinner is not confirmed. The hotel reservation is confirmed.';

    expect(
      hasMessagesGroundingPolarityConflict({
        claimText: 'Dinner is confirmed.',
        evidenceText,
      }),
    ).toBe(true);
    expect(
      hasMessagesGroundingPolarityConflict({
        claimText: 'The hotel reservation is confirmed.',
        evidenceText,
      }),
    ).toBe(false);
  });
});
