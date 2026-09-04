import { describe, expect, it } from 'vitest';

import { interpretMessageActionFollowup } from './message-actions.js';
import {
  appendGenericOpenLoopNoCrawlNotice,
  formatNamedMessagesOpenLoopReply,
  formatNamedOpenLoopDeniedReply,
  GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE,
  namedOpenLoopHistoryQuery,
  readNamedOpenLoopSeedQuery,
  resolveNamedOpenLoopBinding,
} from './named-open-loop.js';
import { buildThreadGroundedSummaryGist } from './thread-grounded-wording.js';

const bobSeedJson = JSON.stringify({
  version: 2,
  query: 'Bob',
  target: {
    chatJid: 'bb:iMessage;-;+14695550199',
    displayName: 'Bob',
    isGroup: false,
  },
});

describe('named who-do-I-owe binding without sending', () => {
  it('grounds an explicit named ask on that thread', () => {
    const binding = resolveNamedOpenLoopBinding({
      text: "what's still open with Bob",
      ownerReviewAllowed: true,
    });

    expect(binding).toEqual({
      kind: 'named',
      query: 'Bob',
      source: 'explicit',
    });
    expect(namedOpenLoopHistoryQuery(binding)).toBe('Bob');
  });

  it('keeps generic what-do-I-owe from crawling unnamed inbox', () => {
    const binding = resolveNamedOpenLoopBinding({
      text: 'what do I owe people',
      canonicalText: 'what do I owe people',
      ownerReviewAllowed: true,
    });

    expect(binding).toEqual({ kind: 'generic' });
    expect(namedOpenLoopHistoryQuery(binding)).toBeNull();
    expect(readNamedOpenLoopSeedQuery(undefined)).toBeNull();
  });

  it('continues what-do-I-owe on a prior named-thread seed only', () => {
    expect(
      resolveNamedOpenLoopBinding({
        text: 'what do I owe people',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
      }),
    ).toEqual({
      kind: 'named',
      query: 'Bob',
      source: 'seed',
    });
    expect(readNamedOpenLoopSeedQuery(bobSeedJson)).toBe('Bob');
  });

  it('does not treat leftover person titles as a named Messages crawl', () => {
    const binding = resolveNamedOpenLoopBinding({
      text: 'what do I owe people',
      ownerReviewAllowed: true,
    });

    expect(binding.kind).toBe('generic');
    expect(namedOpenLoopHistoryQuery(binding)).toBeNull();
  });

  it('denies Karen a named ask without bodies, seed, or history refresh', () => {
    const binding = resolveNamedOpenLoopBinding({
      text: "what's still open with Bob",
      targetChatName: 'Bob',
      ownerReviewAllowed: false,
      priorNamedSeedJson: bobSeedJson,
    });

    expect(binding).toEqual({
      kind: 'denied',
      reason: 'untrusted_named',
    });
    expect(namedOpenLoopHistoryQuery(binding)).toBeNull();
    expect(formatNamedOpenLoopDeniedReply()).toContain(
      'registered owner control chat',
    );
    expect(formatNamedOpenLoopDeniedReply()).not.toContain(
      'Practice at eight tonight',
    );
    expect(formatNamedOpenLoopDeniedReply()).not.toContain('You owe Bob');
  });

  it('does not crawl Messages when owner trust is unasserted', () => {
    expect(
      resolveNamedOpenLoopBinding({
        text: "what's still open with Bob",
        targetChatName: 'Bob',
      }),
    ).toEqual({ kind: 'generic' });
  });
});

describe('named who-do-I-owe copy without sending', () => {
  it('keeps a named open loop thread-grounded and approval-gated', () => {
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
    const reply = formatNamedMessagesOpenLoopReply({
      channel: 'telegram',
      personLabel: 'Bob',
      isGroup: false,
      gist,
      latestInboundText:
        'Practice moved to eight tonight, just keeping you posted.',
    });

    expect(reply).toContain('You owe Bob a reply.');
    expect(reply).toContain('Bob told you: Practice at eight tonight.');
    expect(reply).toContain('draft Bob');
    expect(reply).toContain('stays unsent and requires approval');
    expect(reply).toContain('Saying yes or ok will not send');
    expect(reply).not.toMatch(/until you say send it/i);
    expect(reply).not.toMatch(/opened with|latest open turn/i);
  });

  it('says Nothing open when Jeff already replied', () => {
    const gist = buildThreadGroundedSummaryGist({
      chatName: 'Bob',
      isGroup: false,
      turns: [
        {
          content: 'Actually, parking is closed on that side.',
          isFromMe: false,
          speakerLabel: 'Bob',
        },
        {
          content: 'CURRENT STATE: use the east entrance instead.',
          isFromMe: true,
          speakerLabel: 'Jeff',
        },
      ],
    });
    const reply = formatNamedMessagesOpenLoopReply({
      channel: 'telegram',
      personLabel: 'Bob',
      isGroup: false,
      gist,
      latestInboundText: 'Actually, parking is closed on that side.',
    });

    expect(reply).toContain('Nothing open with Bob.');
    expect(reply).not.toContain('You owe Bob a reply.');
    expect(reply).not.toContain('draft Bob');
    expect(reply).not.toContain('send it');
  });

  it('marks generic companion open loops as no unnamed inbox crawl', () => {
    expect(
      appendGenericOpenLoopNoCrawlNotice(
        'telegram',
        'Nothing important is standing out as an owed reply right now.',
      ),
    ).toContain(GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE);
  });
});

describe('draft-for-Bob-yes stays off the send fence', () => {
  it('keeps the exact standalone Bob fence and leaves soft yes/ok null', () => {
    expect(interpretMessageActionFollowup('send it')).toEqual({ kind: 'send' });
    expect(interpretMessageActionFollowup('send it now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('send now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('yes')).toBeNull();
    expect(interpretMessageActionFollowup('ok')).toBeNull();
    expect(interpretMessageActionFollowup('draft Bob')).toBeNull();
  });
});
