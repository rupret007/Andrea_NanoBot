import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import {
  buildBlueBubblesChatJid,
  listCompanionConversationChatJids,
  resolveCompanionConversationBinding,
} from './companion-conversation-binding.js';

describe('companion conversation binding', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  const registeredGroups = {
    'tg:main': {
      name: 'Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-06T12:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
    },
  };

  it('builds a stable BlueBubbles jid from the allowed chat guid', () => {
    expect(buildBlueBubblesChatJid('chat-123')).toBe('bb:chat-123');
    expect(buildBlueBubblesChatJid('   ')).toBeNull();
  });

  it('returns direct bindings for registered chats', () => {
    const binding = resolveCompanionConversationBinding(
      'tg:main',
      registeredGroups,
    );

    expect(binding).toMatchObject({
      chatJid: 'tg:main',
      synthetic: false,
      channel: 'telegram',
      group: {
        folder: 'main',
        isMain: true,
      },
    });
  });

  it('maps all-synced BlueBubbles chats into the shared companion folder without making them main', () => {
    const binding = resolveCompanionConversationBinding(
      'bb:chat-123',
      registeredGroups,
      {
        bluebubbles: {
          enabled: true,
          chatScope: 'all_synced',
          groupFolder: 'main',
        },
      },
    );

    expect(binding).toMatchObject({
      chatJid: 'bb:chat-123',
      synthetic: true,
      channel: 'bluebubbles',
      group: {
        folder: 'main',
        requiresTrigger: false,
        isMain: false,
      },
    });
    expect(binding?.group.name).toContain('BlueBubbles');
  });

  it('keeps trigger behavior for synthetic BlueBubbles group chats', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-group',
      '2026-04-07T18:01:00.000Z',
      'Family',
      'bluebubbles',
      true,
    );

    const binding = resolveCompanionConversationBinding(
      'bb:iMessage;+;chat-group',
      registeredGroups,
      {
        bluebubbles: {
          enabled: true,
          chatScope: 'all_synced',
          groupFolder: 'main',
        },
      },
    );

    expect(binding?.group.requiresTrigger).toBe(true);
  });

  it('lists known all-synced BlueBubbles jids for companion polling when the shared folder exists', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-123',
      '2026-04-07T18:00:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;+;chat-456',
      '2026-04-07T18:01:00.000Z',
      'Family',
      'bluebubbles',
      true,
    );

    expect(
      listCompanionConversationChatJids(registeredGroups, {
        bluebubbles: {
          enabled: true,
          chatScope: 'all_synced',
          groupFolder: 'main',
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        'tg:main',
        'bb:iMessage;+;chat-123',
        'bb:iMessage;+;chat-456',
      ]),
    );
  });

  it('can scope BlueBubbles to contacts-only when chat metadata says the chat is 1:1', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-dm',
      '2026-04-07T18:00:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;+;chat-group',
      '2026-04-07T18:01:00.000Z',
      'Family',
      'bluebubbles',
      true,
    );

    expect(
      resolveCompanionConversationBinding(
        'bb:iMessage;+;chat-dm',
        registeredGroups,
        {
          bluebubbles: {
            enabled: true,
            chatScope: 'contacts_only',
            groupFolder: 'main',
          },
        },
      ),
    ).toBeTruthy();
    expect(
      resolveCompanionConversationBinding(
        'bb:iMessage;+;chat-group',
        registeredGroups,
        {
          bluebubbles: {
            enabled: true,
            chatScope: 'contacts_only',
            groupFolder: 'main',
          },
        },
      ),
    ).toBeUndefined();
  });

  it('supports allowlist mode through the new list field and the legacy single-chat field', () => {
    expect(
      resolveCompanionConversationBinding('bb:chat-a', registeredGroups, {
        bluebubbles: {
          enabled: true,
          chatScope: 'allowlist',
          allowedChatGuids: ['chat-a'],
          allowedChatGuid: 'chat-b',
          groupFolder: 'main',
        },
      }),
    ).toBeTruthy();
    expect(
      resolveCompanionConversationBinding('bb:chat-b', registeredGroups, {
        bluebubbles: {
          enabled: true,
          chatScope: 'allowlist',
          allowedChatGuids: ['chat-a'],
          allowedChatGuid: 'chat-b',
          groupFolder: 'main',
        },
      }),
    ).toBeTruthy();
    expect(
      resolveCompanionConversationBinding('bb:chat-c', registeredGroups, {
        bluebubbles: {
          enabled: true,
          chatScope: 'allowlist',
          allowedChatGuids: ['chat-a'],
          allowedChatGuid: 'chat-b',
          groupFolder: 'main',
        },
      }),
    ).toBeUndefined();
  });
});
