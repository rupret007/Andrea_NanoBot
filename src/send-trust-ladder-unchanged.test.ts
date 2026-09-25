/**
 * Send Trust Ladder Unchanged Tests
 *
 * These tests prove the send trust ladder remains unchanged:
 * - Only documented send phrases work
 * - No new aliases that weaken the fence
 * - AppleScript remains the only send method
 *
 * Architecture note: NanoBot is the thin send/receive wire only. The send
 * trust ladder is a critical safety boundary that must not be weakened.
 */

import { describe, expect, it } from 'vitest';

import { resolveBlueBubblesSendMethod } from './channels/bluebubbles.js';
import {
  interpretMessageActionFollowup,
  isBlueBubblesExplicitSendAlias,
} from './message-actions.js';
import {
  isNeverAuthorizeSendCaller,
  isNeverAuthorizeSendSurface,
} from './trusted-owner-review-surface.js';
import type { RegisteredGroup } from './types.js';

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-08-23T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

describe('documented send phrases are the only authorization', () => {
  it('accepts exactly: send it / send it now / send now', () => {
    expect(interpretMessageActionFollowup('send it')).toEqual({ kind: 'send' });
    expect(interpretMessageActionFollowup('Send it')).toEqual({ kind: 'send' });
    expect(interpretMessageActionFollowup('send it now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('Send it now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('send now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('Send now')).toEqual({
      kind: 'send',
    });
  });

  it('rejects yes / ok / y as send authorization', () => {
    expect(interpretMessageActionFollowup('yes')).toBeNull();
    expect(interpretMessageActionFollowup('Yes')).toBeNull();
    expect(interpretMessageActionFollowup('yes.')).toBeNull();
    expect(interpretMessageActionFollowup('ok')).toBeNull();
    expect(interpretMessageActionFollowup('okay')).toBeNull();
    expect(interpretMessageActionFollowup('y')).toBeNull();
    expect(interpretMessageActionFollowup('yep')).toBeNull();
    expect(interpretMessageActionFollowup('sure')).toBeNull();
    expect(interpretMessageActionFollowup('go ahead')).toBeNull();
    expect(interpretMessageActionFollowup('approved')).toBeNull();
    expect(interpretMessageActionFollowup('confirm')).toBeNull();
  });

  it('rejects variations that could weaken the fence', () => {
    const rejectedPhrases = [
      'send that',
      'send that reply',
      'send this reply',
      'send it again',
      'send using blue bubbles',
      'send that using blue bubbles',
      'send this to Candace',
      'send the shorter version',
      'send the warmer version to Candace',
      'send the more direct version',
      'approve and send',
      'approve and send now',
      'go ahead and send',
      'please send',
      'send please',
      'do send it',
      'just send it',
      'fire it off',
      'deliver it',
      'transmit it',
      'dispatch it',
    ];

    for (const phrase of rejectedPhrases) {
      expect(interpretMessageActionFollowup(phrase)).toBeNull();
    }
  });
});

describe('isBlueBubblesExplicitSendAlias matches exact fence', () => {
  it('accepts exactly: send it / send it now / send now', () => {
    expect(isBlueBubblesExplicitSendAlias('send it')).toBe(true);
    expect(isBlueBubblesExplicitSendAlias('Send it')).toBe(true);
    expect(isBlueBubblesExplicitSendAlias('send it now')).toBe(true);
    expect(isBlueBubblesExplicitSendAlias('Send it now')).toBe(true);
    expect(isBlueBubblesExplicitSendAlias('send now')).toBe(true);
    expect(isBlueBubblesExplicitSendAlias('Send now')).toBe(true);
  });

  it('rejects variations that could weaken the fence', () => {
    expect(isBlueBubblesExplicitSendAlias('yes')).toBe(false);
    expect(isBlueBubblesExplicitSendAlias('ok')).toBe(false);
    expect(isBlueBubblesExplicitSendAlias('send that')).toBe(false);
    expect(isBlueBubblesExplicitSendAlias('send it again')).toBe(false);
    expect(isBlueBubblesExplicitSendAlias('approve and send')).toBe(false);
  });
});

describe('AppleScript is the only outbound send method', () => {
  it('always resolves to apple-script', () => {
    expect(resolveBlueBubblesSendMethod()).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod(null)).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod(undefined)).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private-api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private_api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('PRIVATE-API')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('  private-api  ')).toBe(
      'apple-script',
    );
    expect(resolveBlueBubblesSendMethod('apple-script')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('anything-else')).toBe('apple-script');
  });
});

describe('QA and Karen are never authorized callers', () => {
  it('rejects QA and Karen Telegram JIDs', () => {
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:qa' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:karen' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:andrea-qa' }),
    ).toBe(true);
  });

  it('rejects QA and Karen surface labels', () => {
    const qaGroup: RegisteredGroup = { ...mainGroup, name: 'QA' };
    const karenGroup: RegisteredGroup = { ...mainGroup, name: 'Karen' };

    expect(isNeverAuthorizeSendSurface(qaGroup, {})).toBe(true);
    expect(isNeverAuthorizeSendSurface(karenGroup, {})).toBe(true);
  });

  it('rejects QA and Karen BlueBubbles JIDs with matching titles', () => {
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'bb:iMessage;-;karen@example.invalid',
        chatTitle: 'Karen',
      }),
    ).toBe(true);

    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'bb:iMessage;-;qa@example.invalid',
        chatTitle: 'QA',
      }),
    ).toBe(true);
  });
});

describe('send trust ladder rejects Instinct callers', () => {
  const instinctJids = [
    'bb:iMessage;-;+15551234567',
    'bb:iMessage;-;instinct@partner.com',
    'bb:SMS;-;+15559876543',
  ];

  it('Instinct JIDs cannot authorize sends', () => {
    for (const chatJid of instinctJids) {
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
    }
  });

  it('Instinct-labeled surfaces cannot authorize sends', () => {
    const instinctGroup: RegisteredGroup = { ...mainGroup, name: 'Instinct' };

    for (const chatJid of instinctJids) {
      expect(
        isNeverAuthorizeSendCaller({ group: instinctGroup, chatJid }),
      ).toBe(true);
    }
  });
});

describe('empty and sentinel JIDs cannot authorize', () => {
  it('rejects empty JIDs', () => {
    expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: '' })).toBe(
      true,
    );
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: '   ' }),
    ).toBe(true);
  });

  it('rejects sentinel Telegram JIDs', () => {
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:undefined' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:null' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:NaN' }),
    ).toBe(true);
  });

  it('rejects sentinel BlueBubbles JIDs', () => {
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'bb:' }),
    ).toBe(true);
  });

  it('rejects unknown channel prefixes', () => {
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'slack:general',
      }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'unknown:chat' }),
    ).toBe(true);
  });
});

describe('defer uses documented phrases only', () => {
  it('accepts defer phrase: send it later', () => {
    const result = interpretMessageActionFollowup('send it later');
    expect(result?.kind).toBe('defer');
  });

  it('accepts defer with timing: send it later tonight', () => {
    const result = interpretMessageActionFollowup('send it later tonight');
    expect(result?.kind).toBe('defer');
    expect((result as { timingHint: string | null }).timingHint).toContain(
      'tonight',
    );
  });

  it('rejects "send later" and "later" as standalone defer (exact fence)', () => {
    expect(interpretMessageActionFollowup('send later')).toBeNull();
    expect(interpretMessageActionFollowup('later')).toBeNull();
  });
});

describe('skip and keep_draft use documented phrases only', () => {
  it('accepts skip phrases', () => {
    expect(interpretMessageActionFollowup('skip that')).toEqual({
      kind: 'skip',
    });
    expect(interpretMessageActionFollowup('not now')).toEqual({ kind: 'skip' });
  });

  it('accepts keep_draft phrases', () => {
    expect(interpretMessageActionFollowup('keep it as draft')).toEqual({
      kind: 'keep_draft',
    });
    expect(interpretMessageActionFollowup('keep that as a draft')).toEqual({
      kind: 'keep_draft',
    });
    expect(interpretMessageActionFollowup('keep as draft')).toEqual({
      kind: 'keep_draft',
    });
    expect(interpretMessageActionFollowup('leave it as draft')).toEqual({
      kind: 'keep_draft',
    });
  });

  it('rejects vague discard-like phrases (no implicit authority)', () => {
    expect(interpretMessageActionFollowup('discard')).toBeNull();
    expect(interpretMessageActionFollowup('delete it')).toBeNull();
    expect(interpretMessageActionFollowup('drop it')).toBeNull();
    expect(interpretMessageActionFollowup('cancel')).toBeNull();
    expect(interpretMessageActionFollowup('never mind')).toBeNull();
  });
});
