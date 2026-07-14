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

  it('uses only reserved non-personal fixtures when self-thread config is absent', () => {
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

    const config = resolveBlueBubblesSelfThreadConfig({});

    expect(config).toEqual({
      canonicalJid: 'bb:iMessage;-;+12025550101',
      aliasJids: [
        'bb:iMessage;-;+12025550101',
        'bb:iMessage;-;owner@example.com',
      ],
    });
  });

  it('lets environment configuration override the sentinel and canonicalizes aliases', () => {
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = 'SMS;-;+12025550109';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'SMS;-;+12025550109,iMessage;-;alias@example.invalid';

    expect(getBlueBubblesCanonicalSelfThreadJid()).toBe(
      'bb:SMS;-;+12025550109',
    );
    expect(
      isBlueBubblesSelfThreadAliasJid('bb:iMessage;-;alias@example.invalid'),
    ).toBe(true);
    expect(
      canonicalizeBlueBubblesSelfThreadJid('iMessage;-;alias@example.invalid'),
    ).toBe('bb:SMS;-;+12025550109');
    expect(
      expandBlueBubblesLogicalSelfThreadJids('bb:SMS;-;+12025550109'),
    ).toContain('bb:iMessage;-;alias@example.invalid');
    expect(
      expandBlueBubblesLogicalSelfThreadJids('bb:SMS;-;+12025550109'),
    ).not.toContain('bb:iMessage;-;+12025550101');
  });

  it('does not blend fallback aliases into a canonical-only environment override', () => {
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;configured@example.invalid';
    delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

    expect(resolveBlueBubblesSelfThreadConfig({})).toEqual({
      canonicalJid: 'bb:iMessage;-;configured@example.invalid',
      aliasJids: ['bb:iMessage;-;configured@example.invalid'],
    });
  });
});
