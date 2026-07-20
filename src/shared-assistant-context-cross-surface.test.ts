import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssistantCapabilityConversationSeed } from './assistant-capabilities.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  _clearSharedAssistantCapabilitySeedForTests,
  _getSharedAssistantCapabilitySeedForTests,
  _setBlueBubblesConversationBindingForTests,
  _setRegisteredGroups,
  _setSharedAssistantCapabilitySeedForTests,
} from './index.js';

const TELEGRAM_OWNER_JID = 'tg:owner';
const BLUEBUBBLES_SELF_JID = 'bb:iMessage;-;+12025550199';
const NOW = new Date('2026-07-16T17:00:00.000Z');

function seed(summaryText: string): AssistantCapabilityConversationSeed {
  return {
    flowKey: 'communication_review_recent_texts',
    subjectKind: 'communication_thread',
    summaryText,
    guidanceGoal: 'open_conversation',
    subjectData: {
      activeCapabilityId: 'communication.review_recent_texts',
      lastCommunicationSummary: summaryText,
    },
  };
}

describe('owner cross-surface shared assistant context', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', BLUEBUBBLES_SELF_JID);
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      `${BLUEBUBBLES_SELF_JID},bb:iMessage;-;owner@example.invalid`,
    );
    _setRegisteredGroups({
      [TELEGRAM_OWNER_JID]: {
        name: 'Owner',
        folder: 'main',
        trigger: '@andrea',
        added_at: NOW.toISOString(),
        isMain: true,
        requiresTrigger: false,
      },
      'tg:other': {
        name: 'Other Telegram chat',
        folder: 'other',
        trigger: '@andrea',
        added_at: NOW.toISOString(),
        isMain: false,
        requiresTrigger: true,
      },
      'tg:-1000000000001': {
        name: 'Legacy main group',
        folder: 'main',
        trigger: '@andrea',
        added_at: NOW.toISOString(),
        isMain: true,
        requiresTrigger: false,
      },
    });
    _setBlueBubblesConversationBindingForTests({
      enabled: true,
      groupFolder: 'main',
    });
  });

  afterEach(() => {
    _setRegisteredGroups({});
    _setBlueBubblesConversationBindingForTests(undefined);
    _closeDatabase();
    vi.unstubAllEnvs();
  });

  it('continues a Telegram recent-summary seed in the configured Messages self-thread', () => {
    const expected = seed('Candace asked whether dinner still works.');
    _setSharedAssistantCapabilitySeedForTests(
      TELEGRAM_OWNER_JID,
      expected,
      NOW,
    );

    expect(
      _getSharedAssistantCapabilitySeedForTests(
        BLUEBUBBLES_SELF_JID,
        new Date('2026-07-16T17:01:00.000Z'),
      ),
    ).toEqual(expected);
  });

  it('continues a Messages self-thread seed in the registered Telegram owner chat', () => {
    const expected = seed('The school thread still needs a reply.');
    _setSharedAssistantCapabilitySeedForTests(
      'bb:iMessage;-;owner@example.invalid',
      expected,
      NOW,
    );

    expect(
      _getSharedAssistantCapabilitySeedForTests(
        TELEGRAM_OWNER_JID,
        new Date('2026-07-16T17:01:00.000Z'),
      ),
    ).toEqual(expected);
  });

  it('does not let contact, group, non-owner, or mismatched surfaces read, overwrite, or clear the owner seed', () => {
    const expected = seed('Owner-only summary context.');
    const unauthorized = seed('Untrusted replacement.');
    _setSharedAssistantCapabilitySeedForTests(
      TELEGRAM_OWNER_JID,
      expected,
      NOW,
    );

    for (const chatJid of [
      'bb:iMessage;-;+15551234567',
      'bb:iMessage;+;family-group',
      'tg:other',
      'tg:-1000000000001',
      'bb:iMessage;-;+12025550101',
    ]) {
      expect(
        _getSharedAssistantCapabilitySeedForTests(chatJid, NOW),
      ).toBeNull();
      _setSharedAssistantCapabilitySeedForTests(chatJid, unauthorized, NOW);
      _clearSharedAssistantCapabilitySeedForTests(chatJid);
    }

    _setBlueBubblesConversationBindingForTests({
      enabled: false,
      groupFolder: 'main',
    });
    expect(
      _getSharedAssistantCapabilitySeedForTests(BLUEBUBBLES_SELF_JID, NOW),
    ).toBeNull();

    _setBlueBubblesConversationBindingForTests({
      enabled: true,
      groupFolder: 'other',
    });
    expect(
      _getSharedAssistantCapabilitySeedForTests(BLUEBUBBLES_SELF_JID, NOW),
    ).toBeNull();

    _setBlueBubblesConversationBindingForTests({
      enabled: true,
      groupFolder: 'main',
    });
    expect(
      _getSharedAssistantCapabilitySeedForTests(TELEGRAM_OWNER_JID, NOW),
    ).toEqual(expected);
  });

  it('does not treat a legacy negative Telegram main-group id as an owner-private scope', () => {
    _setRegisteredGroups({
      'tg:-1000000000001': {
        name: 'Legacy main group',
        folder: 'main',
        trigger: '@andrea',
        added_at: NOW.toISOString(),
        isMain: true,
        requiresTrigger: false,
      },
    });

    _setSharedAssistantCapabilitySeedForTests(
      'tg:-1000000000001',
      seed('Private text context must not enter a group.'),
      NOW,
    );
    _setSharedAssistantCapabilitySeedForTests(
      BLUEBUBBLES_SELF_JID,
      seed('Private text context must not enter a group.'),
      NOW,
    );

    expect(
      _getSharedAssistantCapabilitySeedForTests('tg:-1000000000001', NOW),
    ).toBeNull();
    expect(
      _getSharedAssistantCapabilitySeedForTests(BLUEBUBBLES_SELF_JID, NOW),
    ).toBeNull();
  });

  it('expires a generic shared seed before either owner surface can continue it', () => {
    _setSharedAssistantCapabilitySeedForTests(
      TELEGRAM_OWNER_JID,
      seed('This summary is now stale.'),
      NOW,
    );
    const staleAt = new Date('2026-07-16T17:10:00.001Z');

    expect(
      _getSharedAssistantCapabilitySeedForTests(BLUEBUBBLES_SELF_JID, staleAt),
    ).toBeNull();
    expect(
      _getSharedAssistantCapabilitySeedForTests(TELEGRAM_OWNER_JID, staleAt),
    ).toBeNull();
  });
});
