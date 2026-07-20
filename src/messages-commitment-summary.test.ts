import { describe, expect, it } from 'vitest';

import {
  extractGroundedMessagesPlanFacts,
  formatGroundedMessagesPlanFact,
  formatGroundedMessagesPlanTimestamp,
} from './messages-commitment-summary.js';
import type { NewMessage } from './types.js';

function message(input: {
  id: string;
  content: string;
  timestamp: string;
  isFromMe?: boolean;
  senderName?: string;
}): NewMessage {
  return {
    id: input.id,
    chat_jid: 'bb:iMessage;-;fixture',
    sender: input.isFromMe
      ? 'owner'
      : (input.senderName || 'avery').toLowerCase(),
    sender_name: input.isFromMe ? 'Owner' : input.senderName || 'Avery',
    content: input.content,
    timestamp: input.timestamp,
    is_from_me: Boolean(input.isFromMe),
  };
}

function extract(messages: NewMessage[]) {
  return extractGroundedMessagesPlanFacts({
    messages,
    getSpeakerLabel: (candidate) =>
      candidate.is_from_me ? 'You' : candidate.sender_name,
    getSecondPersonLabel: (candidate) =>
      candidate.is_from_me ? 'Avery' : 'You',
  });
}

describe('grounded Messages commitments and decisions', () => {
  it('extracts an explicit person, action, and stated deadline', () => {
    const facts = extract([
      message({
        id: 'explicit-commitment',
        content: "I'll bring the folding chairs by Friday.",
        timestamp: '2026-07-16T10:00:00.000Z',
      }),
    ]);

    expect(facts).toEqual([
      expect.objectContaining({
        kind: 'commitment',
        actor: 'Avery',
        action: 'bring the folding chairs',
        deadline: 'by Friday',
      }),
    ]);
  });

  it('states when an explicit commitment has no deadline instead of inventing one', () => {
    const [fact] = extract([
      message({
        id: 'no-deadline',
        content: "I'll call the venue.",
        timestamp: '2026-07-16T10:01:00.000Z',
        isFromMe: true,
      }),
    ]);

    expect(fact).toMatchObject({
      kind: 'commitment',
      actor: 'You',
      action: 'call the venue',
      deadline: null,
    });
    expect(formatGroundedMessagesPlanFact(fact!)).toContain(
      'Deadline: not stated.',
    );
    expect(
      formatGroundedMessagesPlanFact(fact!, {
        timeZone: 'America/Chicago',
      }),
    ).toContain('Stated: Jul 16, 2026, 5:01 AM CDT.');
    expect(
      formatGroundedMessagesPlanTimestamp(fact!.timestamp, 'America/Chicago'),
    ).toBe('Jul 16, 2026, 5:01 AM CDT');
  });

  it.each([
    ["I'll send the address tomorrow.", 'send the address', 'tomorrow'],
    ["I'll call the venue Friday.", 'call the venue', 'Friday'],
    ["I'll bring the forms on July 20.", 'bring the forms', 'on July 20'],
    ["I'll share the update at 3:30 pm.", 'share the update', 'at 3:30 pm'],
    [
      "I'll finish the notes next Tuesday at 9 am.",
      'finish the notes',
      'next Tuesday at 9 am',
    ],
    ["I'll file it on 7/20/2026.", 'file it', 'on 7/20/2026'],
  ])(
    'extracts a common explicit deadline from %s',
    (content, expectedAction, expectedDeadline) => {
      const [fact] = extract([
        message({
          id: `deadline-${expectedDeadline}`,
          content,
          timestamp: '2026-07-16T10:01:00.000Z',
          isFromMe: true,
        }),
      ]);

      expect(fact).toMatchObject({
        action: expectedAction,
        deadline: expectedDeadline,
      });
    },
  );

  it('keeps a proposal and a question pending while recognizing an explicit decision', () => {
    const facts = extract([
      message({
        id: 'proposal',
        content: 'Should we move dinner to Saturday?',
        timestamp: '2026-07-16T10:02:00.000Z',
      }),
      message({
        id: 'request',
        content: 'Could you bring ice by Friday?',
        timestamp: '2026-07-16T10:03:00.000Z',
      }),
      message({
        id: 'decision',
        content: 'We decided to use the east entrance.',
        timestamp: '2026-07-16T10:04:00.000Z',
        isFromMe: true,
      }),
    ]);

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'pending_proposal',
          actor: 'Shared plan',
          action: 'move dinner to Saturday',
        }),
        expect.objectContaining({
          kind: 'pending_request',
          actor: 'You',
          action: 'bring ice',
          deadline: 'by Friday',
        }),
        expect.objectContaining({
          kind: 'decision',
          actor: 'Shared plan',
          action: 'use the east entrance',
        }),
      ]),
    );
  });

  it.each([
    ["I'll try to send the address tomorrow.", 'Avery'],
    ["I'm going to maybe call the venue Friday.", 'Avery'],
    ['We decided to perhaps move dinner to Saturday.', 'Shared plan'],
    ['The plan is to hopefully finish the notes tonight.', 'Shared plan'],
    ["I'll bring the folding chairs?", 'Avery'],
    ['We agreed to use the east entrance?', 'Shared plan'],
  ])(
    'keeps tentative or interrogative asserted-plan wording pending: %s',
    (content, actor) => {
      const facts = extract([
        message({
          id: `tentative-${content}`,
          content,
          timestamp: '2026-07-16T10:04:30.000Z',
        }),
      ]);

      expect(facts).toEqual([
        expect.objectContaining({
          kind: 'pending_proposal',
          actor,
        }),
      ]);
      expect(facts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'commitment' }),
          expect.objectContaining({ kind: 'decision' }),
        ]),
      );
    },
  );

  it.each([
    'I might send the address tomorrow.',
    'I hope to call the venue Friday.',
    'We may move dinner to Saturday.',
  ])(
    'retains an explicit tentative statement as a pending proposal: %s',
    (content) => {
      const facts = extract([
        message({
          id: `pending-${content}`,
          content,
          timestamp: '2026-07-16T10:04:45.000Z',
        }),
      ]);

      expect(facts).toEqual([
        expect.objectContaining({ kind: 'pending_proposal' }),
      ]);
    },
  );

  it('lets a later explicit replacement supersede an earlier plan for the same person', () => {
    const facts = extract([
      message({
        id: 'old-plan',
        content: "I'll bring salad by Friday.",
        timestamp: '2026-07-16T10:05:00.000Z',
      }),
      message({
        id: 'replacement-plan',
        content: "Actually, I'll bring dessert instead by Friday.",
        timestamp: '2026-07-16T10:06:00.000Z',
      }),
    ]);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      messageId: 'replacement-plan',
      actor: 'Avery',
      action: 'bring dessert',
      deadline: 'by Friday',
    });
    expect(facts[0]?.evidence).not.toContain('salad');
  });

  it("does not let one person's vague plan change erase another person's commitment", () => {
    const facts = extract([
      message({
        id: 'avery-commitment',
        content: "I'll bring the chairs by Friday.",
        timestamp: '2026-07-16T10:07:00.000Z',
        senderName: 'Avery',
      }),
      message({
        id: 'morgan-vague-change',
        content: 'Change of plans — Saturday instead.',
        timestamp: '2026-07-16T10:08:00.000Z',
        senderName: 'Morgan',
      }),
    ]);

    expect(facts).toEqual([
      expect.objectContaining({
        messageId: 'avery-commitment',
        actor: 'Avery',
        action: 'bring the chairs',
      }),
    ]);
  });
});
