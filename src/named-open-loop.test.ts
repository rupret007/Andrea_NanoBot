import { describe, expect, it } from 'vitest';

import { interpretMessageActionFollowup } from './message-actions.js';
import {
  appendGenericOpenLoopNoCrawlNotice,
  appendNamedOpenLoopDraftCreatedNotice,
  formatNamedMessagesOpenLoopReply,
  formatNamedOpenLoopDeniedReply,
  GENERIC_OPEN_LOOP_NAMED_HANDOFF,
  GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE,
  isNamedOpenLoopSoftYes,
  namedOpenLoopDraftWasOffered,
  namedOpenLoopHistoryQuery,
  NAMED_OPEN_LOOP_DRAFT_YES_NOTICE,
  readNamedOpenLoopSeedQuery,
  resolveNamedOpenLoopBinding,
  resolveNamedOpenLoopDraftFollowup,
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
    expect(reply).toContain('or yes to create an unsent draft');
    expect(reply).toContain('stays unsent and requires approval');
    expect(reply).toContain(NAMED_OPEN_LOOP_DRAFT_YES_NOTICE);
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

  it('turns an empty generic result into one named, privacy-safe next step', () => {
    const reply = appendGenericOpenLoopNoCrawlNotice(
      'telegram',
      'Nothing important is standing out as an owed reply right now.',
      true,
    );
    expect(reply).toContain(GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE);
    expect(reply).toContain(GENERIC_OPEN_LOOP_NAMED_HANDOFF);
    expect(reply).toContain("what's still open with Bob?");
    expect(reply).not.toContain('send it');
    expect(reply).not.toContain('draft Bob');
  });

  it('keeps Alexa concise and does not add the handoff after real tracked items', () => {
    expect(
      appendGenericOpenLoopNoCrawlNotice('alexa', 'Nothing is open.', true),
    ).toBe(
      "Nothing is open. I did not crawl unnamed inbox threads. Name one person and ask what's still open with them.",
    );
    const withTrackedItems = appendGenericOpenLoopNoCrawlNotice(
      'bluebubbles',
      'You still owe one reply.',
      false,
    );
    expect(withTrackedItems).toContain(GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE);
    expect(withTrackedItems).not.toContain('Next: name one person');
  });

  it('keeps Alexa named-open-loop next step off yes-to-draft', () => {
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
      channel: 'alexa',
      personLabel: 'Bob',
      isGroup: false,
      gist,
      latestInboundText:
        'Practice moved to eight tonight, just keeping you posted.',
    });
    expect(reply).toContain('Say draft Bob to create an unsent draft.');
    expect(reply).toContain(NAMED_OPEN_LOOP_DRAFT_YES_NOTICE);
    expect(reply).not.toContain('or yes to create');
    expect(reply).not.toContain('send it');
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

describe('draft-for-Bob-yes creates an unsent draft, not a send', () => {
  const owedGist = buildThreadGroundedSummaryGist({
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

  it('offers draft Bob or yes only when a named one-to-one reply is owed', () => {
    expect(
      namedOpenLoopDraftWasOffered({
        gist: owedGist,
        latestInboundText:
          'Practice moved to eight tonight, just keeping you posted.',
        isGroup: false,
      }),
    ).toBe(true);
    expect(
      namedOpenLoopDraftWasOffered({
        gist: owedGist,
        latestInboundText: 'Can you make practice at seven tonight?',
        isGroup: false,
      }),
    ).toBe(false);
    expect(isNamedOpenLoopSoftYes('yes')).toBe(true);
    expect(isNamedOpenLoopSoftYes('ok')).toBe(true);
    expect(isNamedOpenLoopSoftYes('send it')).toBe(false);
    expect(isNamedOpenLoopSoftYes('yes send it')).toBe(false);
  });

  it('binds draft Bob or yes to the named seed without leftover person titles', () => {
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'draft Bob',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        draftOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({
      kind: 'draft',
      query: 'Bob',
      source: 'named_command',
    });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        draftOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({
      kind: 'draft',
      query: 'Bob',
      source: 'soft_yes',
    });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        ownerReviewAllowed: true,
        draftOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        draftOffered: false,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        draftOffered: true,
        activeCapabilityId: 'communication.draft_reply',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        priorNamedSeedJson: bobSeedJson,
        draftOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({
      kind: 'draft',
      query: 'Bob',
      source: 'soft_yes',
    });
  });

  it('denies Karen a named draft or seed-bound yes', () => {
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'draft Bob',
        ownerReviewAllowed: false,
        priorNamedSeedJson: bobSeedJson,
        draftOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'denied', reason: 'untrusted_named' });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        ownerReviewAllowed: false,
        priorNamedSeedJson: bobSeedJson,
        draftOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'denied', reason: 'untrusted_named' });
    expect(
      resolveNamedOpenLoopDraftFollowup({
        text: 'yes',
        ownerReviewAllowed: false,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('makes the next step after an unsent draft the exact send fence', () => {
    const reply = appendNamedOpenLoopDraftCreatedNotice(
      'telegram',
      'Draft: Thanks for the heads-up — Practice at eight tonight.',
      'Bob',
    );
    expect(reply).toContain('this draft for Bob stays unsent');
    expect(reply).toContain('`send it`');
    expect(reply).toContain('`send it now`');
    expect(reply).toContain('`send now`');
    expect(reply).toContain('Yes still will not send');
    expect(
      appendNamedOpenLoopDraftCreatedNotice(
        'alexa',
        'I drafted a reply.',
        'Bob',
      ),
    ).toBe(
      'I drafted a reply. This draft for Bob stays unsent. Yes will not send.',
    );
  });
});
