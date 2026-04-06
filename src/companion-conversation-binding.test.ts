import { describe, expect, it } from 'vitest';

import {
  buildBlueBubblesChatJid,
  listCompanionConversationChatJids,
  resolveCompanionConversationBinding,
} from './companion-conversation-binding.js';

describe('companion conversation binding', () => {
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

  it('maps the linked BlueBubbles chat into the shared companion folder without making it main', () => {
    const binding = resolveCompanionConversationBinding('bb:chat-123', registeredGroups, {
      bluebubbles: {
        enabled: true,
        allowedChatGuid: 'chat-123',
        groupFolder: 'main',
      },
    });

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

  it('lists the linked BlueBubbles jid for companion polling when the shared folder exists', () => {
    expect(
      listCompanionConversationChatJids(registeredGroups, {
        bluebubbles: {
          enabled: true,
          allowedChatGuid: 'chat-123',
          groupFolder: 'main',
        },
      }),
    ).toEqual(expect.arrayContaining(['tg:main', 'bb:chat-123']));
  });
});
