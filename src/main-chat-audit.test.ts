import { describe, expect, it } from 'vitest';

import {
  auditRegisteredMainChat,
  isNumericTelegramChatJid,
  isSyntheticTelegramChatJid,
} from './main-chat-audit.js';

describe('main chat audit helpers', () => {
  it('recognizes numeric Telegram chat ids', () => {
    expect(isNumericTelegramChatJid('tg:8004355504')).toBe(true);
    expect(isNumericTelegramChatJid('tg:runtime-proof')).toBe(false);
  });

  it('recognizes synthetic Telegram chat ids', () => {
    expect(isSyntheticTelegramChatJid('tg:runtime-proof')).toBe(true);
    expect(isSyntheticTelegramChatJid('tg:8004355504')).toBe(false);
  });

  it('recommends repair when a stale synthetic main chat has one live Telegram DM candidate', () => {
    const result = auditRegisteredMainChat({
      registeredMainChat: {
        jid: 'tg:runtime-proof',
        name: 'Runtime Proof',
        folder: 'main',
        trigger: '@Andrea',
        added_at: '2026-04-02T20:45:00.000Z',
        requiresTrigger: false,
        isMain: true,
      },
      chats: [
        {
          jid: 'tg:8004355504',
          name: 'Jeff',
          last_message_time: '2026-04-04T18:37:12.000Z',
          channel: 'telegram',
          is_group: 0,
        },
      ],
    });

    expect(result.warning).toContain('looks stale');
    expect(result.repairTargetChat?.jid).toBe('tg:8004355504');
    expect(result.registeredMainChatPresentInChats).toBe(false);
  });

  it('does not recommend repair when the existing main chat is already valid', () => {
    const result = auditRegisteredMainChat({
      registeredMainChat: {
        jid: 'tg:8004355504',
        name: 'Jeff',
        folder: 'main',
        trigger: '@Andrea',
        added_at: '2026-04-04T18:00:00.000Z',
        requiresTrigger: false,
        isMain: true,
      },
      chats: [
        {
          jid: 'tg:8004355504',
          name: 'Jeff',
          last_message_time: '2026-04-04T18:37:12.000Z',
          channel: 'telegram',
          is_group: 0,
        },
      ],
    });

    expect(result.warning).toBeNull();
    expect(result.repairTargetChat).toBeNull();
    expect(result.registeredMainChatPresentInChats).toBe(true);
  });

  it('warns and does not repair when multiple Telegram DM candidates exist', () => {
    const result = auditRegisteredMainChat({
      registeredMainChat: {
        jid: 'tg:runtime-proof',
        name: 'Runtime Proof',
        folder: 'main',
        trigger: '@Andrea',
        added_at: '2026-04-02T20:45:00.000Z',
        requiresTrigger: false,
        isMain: true,
      },
      chats: [
        {
          jid: 'tg:8004355504',
          name: 'Jeff',
          last_message_time: '2026-04-04T18:37:12.000Z',
          channel: 'telegram',
          is_group: 0,
        },
        {
          jid: 'tg:999999999',
          name: 'Other',
          last_message_time: '2026-04-04T18:37:10.000Z',
          channel: 'telegram',
          is_group: 0,
        },
      ],
    });

    expect(result.warning).toContain('multiple Telegram DM candidates');
    expect(result.repairTargetChat).toBeNull();
  });
});
