import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import {
  _closeDatabase,
  _initTestDatabase,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import {
  isAuthorizedBlueBubblesSendCallerJid,
  isAuthorizedTelegramSendCallerJid,
  isNeverAuthorizeSendCaller,
  isNeverAuthorizeSendSurface,
  isRegisteredTelegramFrontDoorJid,
  isTrustedOwnerReviewSurface,
  resolveRegisteredTelegramFrontDoorJid,
} from './trusted-owner-review-surface.js';
import type { RegisteredGroup } from './types.js';

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-15T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const companionGroup: RegisteredGroup = {
  ...mainGroup,
  name: 'BlueBubbles (Main)',
  isMain: false,
};

describe('trusted owner review surface', () => {
  const originalDisable = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
  const originalCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const originalAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

  afterEach(() => {
    if (originalDisable == null) {
      delete process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
    } else {
      process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = originalDisable;
    }
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

  it('trusts only the registered main Telegram group', () => {
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:other',
        group: { ...mainGroup, isMain: false },
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:-100123456789',
        group: mainGroup,
      }),
    ).toBe(false);
  });

  it('rejects cross-channel identifiers and status-like channel names', () => {
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        group: mainGroup,
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram_status',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(false);

    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'iMessage;-;owner@example.invalid',
        group: companionGroup,
        ownerAuthored: true,
      }),
    ).toBe(false);
  });

  it('does not trust reserved BlueBubbles fallback aliases', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

    expect(
      isConfiguredBlueBubblesSelfThreadAliasJid('bb:iMessage;-;+12025550101'),
    ).toBe(false);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;+12025550101',
        group: companionGroup,
        ownerAuthored: true,
      }),
    ).toBe(false);

    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;+12025550101';
    expect(
      isConfiguredBlueBubblesSelfThreadAliasJid('bb:iMessage;-;+12025550101'),
    ).toBe(false);
  });

  it('trusts the explicitly configured BlueBubbles self-thread and aliases', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'SMS;-;+12025550109,iMessage;-;owner@example.invalid';

    for (const chatJid of [
      'bb:iMessage;-;owner@example.invalid',
      'bb:SMS;-;+12025550109',
    ]) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid,
          group: companionGroup,
          ownerAuthored: true,
        }),
      ).toBe(true);
    }
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;someone-else@example.invalid',
        group: companionGroup,
        ownerAuthored: true,
      }),
    ).toBe(false);
  });

  it('requires the exact current BlueBubbles message to be owner-authored', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';

    for (const ownerAuthored of [undefined, false] as const) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid: 'bb:iMessage;-;owner@example.invalid',
          group: companionGroup,
          ownerAuthored,
        }),
      ).toBe(false);
    }
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        group: companionGroup,
        ownerAuthored: true,
      }),
    ).toBe(true);
  });

  it('rejects an owner-looking surface without a resolved group scope', () => {
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: null,
      }),
    ).toBe(false);
  });

  it('never treats QA or Karen as send-authorization surfaces', () => {
    for (const group of [
      { ...mainGroup, name: 'QA', folder: 'qa', isMain: true },
      { ...mainGroup, name: 'Karen', folder: 'karen', isMain: true },
      { ...mainGroup, name: 'Andrea QA', folder: 'andrea_qa', isMain: true },
      { ...mainGroup, name: 'QA Bot', folder: 'telegram_qa', isMain: true },
    ]) {
      expect(isNeverAuthorizeSendSurface(group)).toBe(true);
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid: 'tg:main',
          group,
        }),
      ).toBe(false);
    }

    expect(isNeverAuthorizeSendSurface(mainGroup)).toBe(false);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(true);
  });

  it('never lets a QA or Karen Telegram JID borrow the main group record', () => {
    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:andrea-qa', 'tg:qa_bot']) {
      expect(isNeverAuthorizeSendSurface(mainGroup, { chatJid })).toBe(true);
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);
    }
  });

  it('does not treat a numeric Telegram JID as a canary by itself', () => {
    expect(
      isNeverAuthorizeSendSurface(mainGroup, { chatJid: 'tg:847392018' }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'tg:847392018',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:847392018',
        group: mainGroup,
      }),
    ).toBe(false);
  });

  it('never authorizes from stored QA or Karen titles while ignoring email local-parts', () => {
    expect(isNeverAuthorizeSendSurface(mainGroup, { chatTitle: 'Karen' })).toBe(
      true,
    );
    expect(
      isNeverAuthorizeSendSurface(mainGroup, { surfaceLabels: ['QA'] }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        chatTitle: 'Andrea QA',
      }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendSurface(mainGroup, {
        chatJid: 'bb:iMessage;-;karen@example.invalid',
      }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'bb:iMessage;-;karen@example.invalid',
      }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendSurface(mainGroup, { chatTitle: 'quality' }),
    ).toBe(false);
    expect(isNeverAuthorizeSendSurface(mainGroup, { chatJid: 'tg:main' })).toBe(
      false,
    );
  });

  it('fails closed for provider JIDs while retaining an explicit hermetic fixture', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

    expect(isAuthorizedBlueBubblesSendCallerJid('bb:chat-1')).toBe(true);
    expect(isAuthorizedBlueBubblesSendCallerJid('bb:')).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: companionGroup,
        chatJid: 'bb:',
      }),
    ).toBe(true);
    expect(
      isAuthorizedBlueBubblesSendCallerJid('bb:iMessage;-;+12025550123'),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: companionGroup,
        chatJid: 'bb:iMessage;-;+12025550123',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;+12025550123',
        group: companionGroup,
        ownerAuthored: true,
      }),
    ).toBe(false);
  });
});

describe('registered Telegram front-door send fence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('does not let an unregistered numeric JID borrow isMain', () => {
    expect(resolveRegisteredTelegramFrontDoorJid()).toBeNull();
    expect(isAuthorizedTelegramSendCallerJid('tg:main')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:100')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:owner')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:undefined')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:null')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:NaN')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:mai\nn')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:847392018')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:100000')).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'tg:847392018',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:847392018',
        group: mainGroup,
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(true);
  });

  it('does not let a stored sentinel or empty Telegram JID become the front-door', () => {
    for (const chatJid of ['tg:', 'tg:undefined', 'tg:null', 'tg:NaN']) {
      setRegisteredGroup(chatJid, mainGroup);
      expect(resolveRegisteredTelegramFrontDoorJid()).toBeNull();
      expect(isRegisteredTelegramFrontDoorJid(chatJid)).toBe(false);
      expect(isAuthorizedTelegramSendCallerJid(chatJid)).toBe(false);
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);
    }
  });

  it('does not let a numeric JID borrow the registered front-door', () => {
    setRegisteredGroup('tg:main', mainGroup);
    expect(resolveRegisteredTelegramFrontDoorJid()).toBe('tg:main');
    expect(isRegisteredTelegramFrontDoorJid('tg:main')).toBe(true);
    expect(
      isNeverAuthorizeSendSurface(mainGroup, { chatJid: 'tg:847392018' }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'tg:847392018',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:847392018',
        group: mainGroup,
      }),
    ).toBe(false);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(true);
  });

  it('still refuses a stored QA title when a benign chatTitle is provided', () => {
    storeChatMetadata(
      'tg:900100200',
      '2026-08-23T00:00:00.000Z',
      'QA',
      'telegram',
      false,
    );
    expect(
      isNeverAuthorizeSendSurface(mainGroup, {
        chatJid: 'tg:900100200',
        chatTitle: 'Main',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:900100200',
        group: mainGroup,
        chatTitle: 'Main',
      }),
    ).toBe(false);
  });

  it('still refuses a stored BlueBubbles QA title when the JID looks ordinary', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-08-23T00:00:00.000Z',
      'QA',
      'bluebubbles',
      false,
    );
    expect(
      isNeverAuthorizeSendSurface(mainGroup, {
        chatJid: 'bb:iMessage;-;+12025550123',
        chatTitle: 'Main',
      }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'bb:iMessage;-;+12025550123',
        chatTitle: 'Main',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;+12025550123',
        group: companionGroup,
        ownerAuthored: true,
        chatTitle: 'Main',
      }),
    ).toBe(false);
    delete process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  });
});
