import { describe, expect, it } from 'vitest';

import { interpretMessageActionFollowup } from './message-actions.js';
import {
  appendGenericOpenLoopNoCrawlNotice,
  appendNamedOpenLoopDraftCreatedNotice,
  appendNamedOpenLoopRemindCreatedNotice,
  formatNamedMessagesOpenLoopReply,
  formatNamedOpenLoopDeniedReply,
  GENERIC_OPEN_LOOP_NAMED_HANDOFF,
  GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE,
  isNamedOpenLoopSoftYes,
  namedOpenLoopDraftWasOffered,
  namedOpenLoopHistoryQuery,
  NAMED_OPEN_LOOP_DRAFT_YES_NOTICE,
  NAMED_OPEN_LOOP_REMIND_LATER_PROMPT,
  namedOpenLoopRemindWasOffered,
  parseNamedOpenLoopRemindTiming,
  readNamedOpenLoopSeedQuery,
  resolveNamedOpenLoopBinding,
  resolveNamedOpenLoopDraftFollowup,
  resolveNamedOpenLoopRemindFollowup,
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
    expect(reply).toContain('or yes for an unsent draft');
    expect(reply).toContain(NAMED_OPEN_LOOP_REMIND_LATER_PROMPT);
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
    expect(reply).not.toContain(NAMED_OPEN_LOOP_REMIND_LATER_PROMPT);
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
    expect(reply).not.toContain(NAMED_OPEN_LOOP_REMIND_LATER_PROMPT);
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
    expect(reply).toContain(
      'Say draft Bob to create an unsent draft, or remind me later.',
    );
    expect(reply).toContain(NAMED_OPEN_LOOP_DRAFT_YES_NOTICE);
    expect(reply).not.toContain('or yes to create');
    expect(reply).not.toContain('or yes for an unsent draft');
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
    expect(interpretMessageActionFollowup('remind me later')).not.toEqual({
      kind: 'send',
    });
    expect(
      interpretMessageActionFollowup('remind me to reply later tonight'),
    ).not.toEqual({ kind: 'send' });
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

describe('named open-loop remind-me-later stays off the send fence', () => {
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

  it('offers remind-me-later on a named owed one-to-one, including withheld questions', () => {
    expect(
      namedOpenLoopRemindWasOffered({
        gist: owedGist,
        isGroup: false,
      }),
    ).toBe(true);
    expect(
      namedOpenLoopRemindWasOffered({
        gist: buildThreadGroundedSummaryGist({
          chatName: 'Bob',
          isGroup: false,
          turns: [
            {
              content: 'Can you make practice at seven tonight?',
              isFromMe: false,
              speakerLabel: 'Bob',
            },
          ],
        }),
        isGroup: false,
      }),
    ).toBe(true);
    expect(
      namedOpenLoopRemindWasOffered({
        gist: owedGist,
        isGroup: true,
      }),
    ).toBe(false);
    expect(parseNamedOpenLoopRemindTiming('remind me later')).toBe('tonight');
    expect(
      parseNamedOpenLoopRemindTiming('remind me to reply later tonight'),
    ).toBe('tonight');
    expect(parseNamedOpenLoopRemindTiming('remind me tomorrow')).toBe(
      'tomorrow',
    );
    expect(
      parseNamedOpenLoopRemindTiming('remind me to call Sam tomorrow at 3'),
    ).toBeNull();
    expect(parseNamedOpenLoopRemindTiming('send it')).toBeNull();
    expect(parseNamedOpenLoopRemindTiming('yes')).toBeNull();
  });

  it('binds remind-me-later to the named seed without leftover person titles', () => {
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me later',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        remindOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({
      kind: 'remind',
      query: 'Bob',
      timing: 'tonight',
      source: 'later',
    });
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me to reply later tonight',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        remindOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toMatchObject({
      kind: 'remind',
      query: 'Bob',
      timing: 'tonight',
    });
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me later',
        ownerReviewAllowed: true,
        remindOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me later',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        remindOffered: false,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me later',
        ownerReviewAllowed: true,
        priorNamedSeedJson: bobSeedJson,
        remindOffered: true,
        activeCapabilityId: 'communication.draft_reply',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('denies Karen a named remind-me-later', () => {
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me later',
        ownerReviewAllowed: false,
        priorNamedSeedJson: bobSeedJson,
        remindOffered: true,
        activeCapabilityId: 'communication.open_loops',
      }),
    ).toEqual({ kind: 'denied', reason: 'untrusted_named' });
    expect(
      resolveNamedOpenLoopRemindFollowup({
        text: 'remind me later',
        ownerReviewAllowed: false,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('keeps withheld named questions on remind-me-later, not yes-to-draft', () => {
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
    const reply = formatNamedMessagesOpenLoopReply({
      channel: 'telegram',
      personLabel: 'Bob',
      isGroup: false,
      gist,
      latestInboundText: 'Can you make practice at seven tonight?',
    });
    expect(reply).toContain("I won't guess your answer.");
    expect(reply).toContain(NAMED_OPEN_LOOP_REMIND_LATER_PROMPT);
    expect(reply).not.toContain('or yes for an unsent draft');
    expect(reply).not.toContain('send it');
  });

  it('makes the next step after a reminder the unsent draft, not a send', () => {
    const reply = appendNamedOpenLoopRemindCreatedNotice(
      'telegram',
      "Okay. I'll remind you tonight to reply to Bob.",
      'Bob',
    );
    expect(reply).toContain('I did not send anything');
    expect(reply).toContain('`draft Bob`');
    expect(reply).toContain('`send it`');
    expect(reply).toContain('`send it now`');
    expect(reply).toContain('`send now`');
    expect(
      appendNamedOpenLoopRemindCreatedNotice(
        'alexa',
        "Okay. I'll remind you tonight to reply to Bob.",
        'Bob',
      ),
    ).toBe(
      "Okay. I'll remind you tonight to reply to Bob. I did not send anything. Say draft Bob when you want an unsent draft.",
    );
  });
});
