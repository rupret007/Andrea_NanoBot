import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalizeBlueBubblesSelfThreadJid,
  expandBlueBubblesLogicalSelfThreadJids,
  getBlueBubblesCanonicalSelfThreadJid,
  isBlueBubblesSelfThreadAliasJid,
  resolveBlueBubblesSelfThreadConfig,
} from './bluebubbles-self-thread.js';

describe('BlueBubbles self-thread resolver', () => {
  const originalCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const originalAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

  afterEach(() => {
    if (originalCanonical == null) {
      delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    } else {
      process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = originalCanonical;
    }
    if (originalAliases == null) {
      delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    } else {
      process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = originalAliases;
    }
  });

  it('defaults to the Mac mini iMessage proof thread and account alias', () => {
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

    const config = resolveBlueBubblesSelfThreadConfig({});

    expect(config.canonicalJid).toBe('bb:iMessage;-;+14695405551');
    expect(config.aliasJids).toContain('bb:iMessage;-;+14695405551');
    expect(config.aliasJids).toContain('bb:iMessage;-;jeffstory007@gmail.com');
    expect(config.aliasJids).not.toContain('bb:SMS;-;+19128007274');
  });

  it('canonicalizes env aliases without requiring the bb: prefix', () => {
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = 'SMS;-;+15551234567';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'SMS;-;+15551234567,iMessage;-;jeff@example.com';

    expect(getBlueBubblesCanonicalSelfThreadJid()).toBe(
      'bb:SMS;-;+15551234567',
    );
    expect(
      isBlueBubblesSelfThreadAliasJid('bb:iMessage;-;jeff@example.com'),
    ).toBe(true);
    expect(
      canonicalizeBlueBubblesSelfThreadJid('iMessage;-;jeff@example.com'),
    ).toBe('bb:SMS;-;+15551234567');
    expect(
      expandBlueBubblesLogicalSelfThreadJids('bb:SMS;-;+15551234567'),
    ).toContain('bb:iMessage;-;jeff@example.com');
    expect(
      expandBlueBubblesLogicalSelfThreadJids('bb:SMS;-;+15551234567'),
    ).not.toContain('bb:iMessage;-;+14695405551');
  });
});
