import { describe, expect, it } from 'vitest';

import {
  buildThreadGroundedAcknowledgement,
  buildThreadGroundedSuggestedReplies,
  buildThreadGroundedSummaryGist,
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
      extractThreadUpdateAnchor(
        'Can you confirm if dinner still works tonight?',
      ),
    ).toBeNull();
    expect(shouldWithholdThreadGroundedReply('Please bring ice tonight.')).toBe(
      true,
    );
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

  it('builds a Jeff-facing Bob gist instead of a quote dump', () => {
    const gist = buildThreadGroundedSummaryGist({
      chatName: 'Bob',
      isGroup: false,
      turns: [
        {
          content: 'Practice moved to eight tonight, just keeping you posted.',
          isFromMe: false,
          speakerLabel: 'Bob',
        },
      ],
    });
    expect(gist.ownerOwesReply).toBe(true);
    expect(gist.digestSentences.join(' ')).toContain(
      'Bob told you: Practice at eight tonight.',
    );
    expect(gist.digestSentences.join(' ')).toContain(
      "You haven't replied yet.",
    );
    expect(gist.digestSentences.join(' ')).not.toMatch(
      /opened with|latest open turn|By the end/i,
    );
  });

  it('keeps a short Jeff/Bob logistics arc without inventing an answer', () => {
    const gist = buildThreadGroundedSummaryGist({
      chatName: 'Bob',
      isGroup: false,
      turns: [
        { content: '7 works.', isFromMe: false, speakerLabel: 'Bob' },
        { content: 'No.', isFromMe: true, speakerLabel: 'You' },
        { content: '8 instead.', isFromMe: false, speakerLabel: 'Bob' },
        { content: 'Done.', isFromMe: true, speakerLabel: 'You' },
      ],
    });
    expect(gist.ownerOwesReply).toBe(false);
    expect(gist.digestSentences.join(' ')).toContain('7 works.');
    expect(gist.digestSentences.join(' ')).toContain('8 instead.');
    expect(gist.digestSentences.join(' ')).toContain('Done.');
    expect(gist.digestSentences.join(' ')).not.toMatch(/opened with/i);
  });

  it('withholds a canned gist answer when Bob asked a question', () => {
    const gist = buildThreadGroundedSummaryGist({
      chatName: 'Bob',
      isGroup: false,
      turns: [
        {
          content: 'Can you make practice at seven tonight?',
          isFromMe: false,
          speakerLabel: 'Bob',
        },
      ],
    });
    expect(gist.digestSentences.join(' ')).toContain(
      'Bob asked you: Can you make practice at seven tonight',
    );
    expect(gist.digestSentences.join(' ')).not.toMatch(
      /\b(?:yes I can|I will be there)\b/i,
    );
  });
});
