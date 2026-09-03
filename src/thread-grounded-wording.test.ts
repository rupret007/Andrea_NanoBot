import { describe, expect, it } from 'vitest';

import {
  buildThreadGroundedAcknowledgement,
  buildThreadGroundedSuggestedReplies,
  extractThreadUpdateAnchor,
  shouldWithholdThreadGroundedReply,
} from './thread-grounded-wording.js';

describe('thread-grounded wording', () => {
  it('grounds informational updates by thread content and withholds owner-answer asks', () => {
    expect(
      extractThreadUpdateAnchor(
        'Dinner moved to seven tonight, just keeping you posted.',
      ),
    ).toBe('Dinner at seven tonight');
    expect(
      extractThreadUpdateAnchor(
        'Load-in moved to six tonight, just sharing the update.',
      ),
    ).toBe('Load-in at six tonight');
    expect(
      extractThreadUpdateAnchor(
        'Yeah I like the Fallout story but I do not know too much about the world yet.',
      ),
    ).toBe('Fallout');
    expect(
      shouldWithholdThreadGroundedReply(
        'Can you confirm if dinner still works tonight?',
      ),
    ).toBe(true);
    expect(
      extractThreadUpdateAnchor('Can you confirm if dinner still works tonight?'),
    ).toBeNull();
    expect(
      shouldWithholdThreadGroundedReply('Please bring ice tonight.'),
    ).toBe(true);
    expect(
      buildThreadGroundedAcknowledgement({
        inboundText: 'The main thing still open with Candace is dinner plans.',
        style: 'warm',
        requireConcreteUpdate: true,
      }),
    ).toBeNull();
  });

  it('keeps Candace dinner and Alex load-in acknowledgements distinct', () => {
    const candace = buildThreadGroundedAcknowledgement({
      inboundText: 'Dinner moved to seven tonight, just keeping you posted.',
      style: 'warm',
    });
    const alex = buildThreadGroundedAcknowledgement({
      inboundText: 'Load-in moved to six tonight, just sharing the update.',
      style: 'timing',
    });
    expect(candace).toBe('Thanks for the heads-up — Dinner at seven tonight.');
    expect(alex).toBe(
      'Thanks for the timing update on Load-in at six tonight.',
    );
    expect(candace).not.toBe(alex);
  });

  it('does not invent an answer for a question and stays unsent-only wording', () => {
    expect(
      buildThreadGroundedSuggestedReplies({
        inboundText: 'Can you make practice at seven tonight?',
        isGroup: false,
      }),
    ).toEqual([]);
    const replies = buildThreadGroundedSuggestedReplies({
      inboundText: 'Dinner moved to seven tonight, just keeping you posted.',
      isGroup: false,
      toneStyleHints: ['warm', 'avoid_overcommitment'],
    });
    expect(replies.map((reply) => reply.text)).toEqual([
      'Thanks for the heads-up — Dinner at seven tonight.',
      'Dinner at seven tonight. Thanks.',
      'Got it—Dinner at seven tonight.',
    ]);
    expect(replies.join(' ')).not.toMatch(
      /\b(?:checking|will confirm|will get back|yes I can)\b/i,
    );
  });
});
