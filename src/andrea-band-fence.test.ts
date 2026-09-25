/**
 * @andrea Band Privacy Fence Tests
 *
 * These tests prove that band-mates using @andrea stay in-thread only.
 * No bridge to other Jeff chats or Instinct without explicit allowlist path.
 *
 * Architecture note: NanoBot is the thin send/receive wire only. Band group
 * chats are companion data, not control surfaces. @Andrea mentions in band
 * threads are processed locally within that thread context and never bridge
 * to external contacts or Instinct threads.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  hasBlueBubblesAndreaMention,
  isBlueBubblesExplicitAsk,
  stripBlueBubblesAndreaMention,
} from './bluebubbles-companion.js';
import {
  isNeverAuthorizeSendCaller,
  isNeverAuthorizeSendSurface,
  isTrustedOwnerReviewSurface,
} from './trusted-owner-review-surface.js';
import type { RegisteredGroup } from './types.js';

const bandGroup: RegisteredGroup = {
  name: 'Band Chat',
  folder: 'band',
  trigger: '@Andrea',
  added_at: '2026-08-23T00:00:00.000Z',
  requiresTrigger: true,
  isMain: false,
};

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-08-23T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const BAND_CHAT_JIDS = [
  'bb:iMessage;+;chat-band-group-123',
  'bb:iMessage;+;chat-band-group-456',
  'bb:SMS;+;chat-band-practice',
];

const BAND_MEMBER_HANDLES = [
  '+15551111111',
  '+15552222222',
  '+15553333333',
  'bandmate1@example.com',
  'bandmate2@example.com',
];

const INSTINCT_JIDS = [
  'bb:iMessage;-;+15559999999',
  'bb:iMessage;-;instinct@partner.com',
];

describe('@andrea band privacy fence - in-thread only', () => {
  beforeEach(() => {
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;owner@example.invalid',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('detects @Andrea mentions in band chat messages', () => {
    expect(hasBlueBubblesAndreaMention('@Andrea what time is practice')).toBe(
      true,
    );
    expect(
      hasBlueBubblesAndreaMention('hey @Andrea can you check the schedule'),
    ).toBe(true);
    expect(hasBlueBubblesAndreaMention('@openclaw search setlist')).toBe(true);
    expect(hasBlueBubblesAndreaMention('practice at 8pm tonight')).toBe(false);
  });

  it('strips @Andrea mention for local processing within thread', () => {
    expect(stripBlueBubblesAndreaMention('@Andrea what time is practice')).toBe(
      'what time is practice',
    );
    expect(stripBlueBubblesAndreaMention('@Andrea, check the schedule')).toBe(
      'check the schedule',
    );
    expect(stripBlueBubblesAndreaMention('hey @Andrea can you help')).toBe(
      'hey can you help',
    );
  });

  it('band chat JIDs are NOT explicit ask surfaces (data_only mode)', () => {
    for (const chatJid of BAND_CHAT_JIDS) {
      expect(
        isBlueBubblesExplicitAsk('@Andrea what time is practice', { chatJid }),
      ).toBe(false);
    }
  });

  it('band chat JIDs are never trusted owner review surfaces', () => {
    for (const chatJid of BAND_CHAT_JIDS) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid,
          group: bandGroup,
        }),
      ).toBe(false);

      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);
    }
  });

  it('band chat JIDs cannot authorize sends to external contacts', () => {
    for (const chatJid of BAND_CHAT_JIDS) {
      expect(
        isNeverAuthorizeSendCaller({
          group: bandGroup,
          chatJid,
        }),
      ).toBe(true);

      expect(
        isNeverAuthorizeSendCaller({
          group: mainGroup,
          chatJid,
        }),
      ).toBe(true);
    }
  });

  it('band group cannot authorize sends even with isMain flag', () => {
    const bandAsMain: RegisteredGroup = {
      ...bandGroup,
      isMain: true,
    };

    for (const chatJid of BAND_CHAT_JIDS) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid,
          group: bandAsMain,
        }),
      ).toBe(false);
    }
  });
});

describe('@andrea band fence - no bridge to Instinct', () => {
  it('band chat mentions cannot bridge to Instinct JIDs', () => {
    for (const instinctJid of INSTINCT_JIDS) {
      expect(
        isNeverAuthorizeSendCaller({
          group: bandGroup,
          chatJid: instinctJid,
        }),
      ).toBe(true);

      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid: instinctJid,
          group: bandGroup,
        }),
      ).toBe(false);
    }
  });

  it('band group surface stays isolated from Instinct', () => {
    expect(
      isNeverAuthorizeSendSurface(bandGroup, {
        chatJid: 'bb:iMessage;+;chat-band-group-123',
      }),
    ).toBe(false);

    for (const instinctJid of INSTINCT_JIDS) {
      expect(
        isNeverAuthorizeSendCaller({
          group: bandGroup,
          chatJid: instinctJid,
        }),
      ).toBe(true);
    }
  });
});

describe('@andrea band fence - no bridge to other Jeff chats', () => {
  const otherJeffChats = [
    'bb:iMessage;-;jeff-work@company.com',
    'bb:iMessage;-;+15550000001',
    'tg:12345678',
  ];

  it('band chat mentions cannot bridge to other Jeff contact threads', () => {
    for (const jeffChatJid of otherJeffChats) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid: jeffChatJid,
          group: bandGroup,
        }),
      ).toBe(false);

      expect(
        isNeverAuthorizeSendCaller({
          group: bandGroup,
          chatJid: jeffChatJid,
        }),
      ).toBe(true);
    }
  });

  it('band chat context stays within band thread', () => {
    const bandChatJid = 'bb:iMessage;+;chat-band-group-123';

    expect(
      isNeverAuthorizeSendCaller({
        group: bandGroup,
        chatJid: bandChatJid,
      }),
    ).toBe(true);
  });
});

describe('@andrea band fence - explicit allowlist required', () => {
  beforeEach(() => {
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;owner@example.invalid',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('owner self-thread is the only BlueBubbles send authorization surface', () => {
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        group: mainGroup,
        ownerAuthored: true,
      }),
    ).toBe(true);

    for (const bandChatJid of BAND_CHAT_JIDS) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid: bandChatJid,
          group: mainGroup,
        }),
      ).toBe(false);
    }
  });

  it('band members cannot borrow owner authority via @Andrea mention', () => {
    for (const member of BAND_MEMBER_HANDLES) {
      expect(
        isNeverAuthorizeSendCaller({
          group: bandGroup,
          chatJid: `bb:iMessage;-;${member}`,
        }),
      ).toBe(true);
    }
  });
});
