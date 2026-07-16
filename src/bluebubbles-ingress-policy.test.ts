import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getActionableMessagesSince,
  getMessagesSince,
  listRecentMessagesForChat,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { applyBlueBubblesIngressPolicy } from './bluebubbles-ingress-policy.js';

describe('BlueBubbles ingress policy', () => {
  const canonicalEnv = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const aliasesEnv = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

  beforeEach(() => {
    _initTestDatabase();
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;owner@example.invalid,iMessage;-;+15550009999';
  });

  afterEach(() => {
    if (canonicalEnv == null) {
      delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    } else {
      process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = canonicalEnv;
    }
    if (aliasesEnv == null) {
      delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    } else {
      process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = aliasesEnv;
    }
  });

  it.each([
    {
      label: 'incoming @Andrea mention',
      id: 'bb:contact-mention',
      content: '@Andrea answer me here',
      isFromMe: false,
    },
    {
      label: 'owner-authored contact text',
      id: 'bb:owner-contact-text',
      content: 'Thanks brother, hoping soon.',
      isFromMe: true,
    },
  ])(
    'stores $label passively and never reaches queue/send routing',
    (input) => {
      const chatJid = 'bb:iMessage;-;+15550001111';
      storeChatMetadata(
        chatJid,
        '2026-07-16T19:00:00.000Z',
        'Contact',
        'bluebubbles',
        false,
      );
      const enqueue = vi.fn();
      const send = vi.fn();
      const result = applyBlueBubblesIngressPolicy({
        channelName: 'bluebubbles',
        chatJid,
        message: {
          id: input.id,
          chat_jid: chatJid,
          sender: input.isFromMe ? 'bb:owner' : 'bb:+15550001111',
          sender_name: input.isFromMe ? 'Owner' : 'Contact',
          content: input.content,
          timestamp: '2026-07-16T19:00:00.000Z',
          is_from_me: input.isFromMe,
        },
      });

      if (result.kind === 'continue_control_routing') {
        enqueue();
        send();
      }

      expect(result).toEqual({
        kind: 'stored_contact_data_only',
        stored: true,
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(getActionableMessagesSince(chatJid, '', 'Andrea')).toEqual([]);
      expect(
        listRecentMessagesForChat(chatJid, 10).map((message) => message.id),
      ).toContain(input.id);
      expect(
        getMessagesSince(chatJid, '', 'Andrea').map((message) => message.id),
      ).toContain(input.id);
    },
  );

  it('keeps a configured owner self-thread live and actionable', () => {
    const chatJid = 'bb:iMessage;-;owner@example.invalid';
    storeChatMetadata(
      chatJid,
      '2026-07-16T19:05:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    const message = {
      id: 'bb:self-thread-live',
      chat_jid: chatJid,
      sender: 'bb:owner',
      sender_name: 'Owner',
      content: '@Andrea summarize my recent texts',
      timestamp: '2026-07-16T19:05:00.000Z',
      is_from_me: true,
    };

    expect(
      applyBlueBubblesIngressPolicy({
        channelName: 'bluebubbles',
        chatJid,
        message,
      }),
    ).toEqual({ kind: 'continue_control_routing' });
    storeMessage(message);
    expect(
      getActionableMessagesSince(chatJid, '', 'Andrea').map(
        (stored) => stored.id,
      ),
    ).toEqual(['bb:self-thread-live']);
  });
});
