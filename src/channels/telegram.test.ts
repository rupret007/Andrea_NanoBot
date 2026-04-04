import { describe, expect, it, vi } from 'vitest';

import {
  TelegramChannel,
  buildTelegramChatIdText,
  buildTelegramCommandsText,
  buildTelegramFeaturesText,
  buildTelegramHelpText,
  buildTelegramUnregisteredDmText,
  buildTelegramWelcomeText,
  extractTelegramReplyRef,
  extractTelegramLeadingCommand,
  splitTelegramMessage,
} from './telegram.js';

describe('extractTelegramLeadingCommand', () => {
  it('extracts plain slash commands', () => {
    expect(extractTelegramLeadingCommand('/registermain')).toBe('registermain');
  });

  it('extracts slash commands targeted to this bot', () => {
    expect(
      extractTelegramLeadingCommand(
        '/registermain@andrea_nanobot',
        'andrea_nanobot',
      ),
    ).toBe('registermain');
  });

  it('ignores slash commands targeted to another bot', () => {
    expect(
      extractTelegramLeadingCommand(
        '/registermain@other_bot',
        'andrea_nanobot',
      ),
    ).toBeNull();
  });

  it('extracts mention-prefixed slash commands', () => {
    expect(
      extractTelegramLeadingCommand(
        '@andrea_nanobot   /registermain',
        'andrea_nanobot',
      ),
    ).toBe('registermain');
  });

  it('returns null for non-command mention text', () => {
    expect(
      extractTelegramLeadingCommand(
        '@andrea_nanobot hello there',
        'andrea_nanobot',
      ),
    ).toBeNull();
  });
});

describe('buildTelegramHelpText', () => {
  it('includes key commands and capability guidance', () => {
    const help = buildTelegramHelpText('Andrea');

    expect(help).toContain('*Welcome to Andrea*');
    expect(help).toContain('/help');
    expect(help).toContain('/commands');
    expect(help).toContain('/features');
    expect(help).toContain('/ping');
    expect(help).toContain('/chatid');
    expect(help).toContain('/registermain');
    expect(help).toContain('/cursor_status');
    expect(help).toContain('To-do lists, reminders, and recurring tasks');
    expect(help).toContain('Fast replies for simple questions');
    expect(help).toContain('deeper operator work lanes');
    expect(help).not.toContain('/alexa_status');
    expect(help).not.toContain('/amazon_status');
    expect(help).not.toContain('/amazon_search');
  });
});

describe('extractTelegramReplyRef', () => {
  it('captures reply metadata from Telegram message payloads', () => {
    expect(
      extractTelegramReplyRef(
        {
          reply_to_message: {
            message_id: 55,
            text: 'Andrea OpenAI Runtime\n- Job ID: job_123',
            date: 1_775_200_000,
            from: {
              id: 777,
              first_name: 'Andrea',
              is_bot: true,
            },
          },
        },
        777,
      ),
    ).toEqual({
      message_id: '55',
      content: 'Andrea OpenAI Runtime\n- Job ID: job_123',
      sender: '777',
      sender_name: 'Andrea',
      is_from_me: true,
      is_bot_message: true,
      timestamp: '2026-04-03T07:06:40.000Z',
    });
  });
});

describe('buildTelegramWelcomeText', () => {
  it('shows quick-start instructions for new users', () => {
    const welcome = buildTelegramWelcomeText('Andrea');

    expect(welcome).toContain('*Welcome to Andrea*');
    expect(welcome).toContain('/registermain');
    expect(welcome).toContain('/commands');
    expect(welcome).toContain('/features');
    expect(welcome).toContain('mention my Telegram username');
    expect(welcome).not.toContain('@Andrea');
  });
});

describe('buildTelegramCommandsText', () => {
  it('keeps the public command list focused on the demo-safe surface', () => {
    const commands = buildTelegramCommandsText();

    expect(commands).toContain('/start');
    expect(commands).toContain('/help');
    expect(commands).toContain('/commands');
    expect(commands).toContain('/features');
    expect(commands).toContain('/cursor_status');
    expect(commands).toContain('safe readiness check');
    expect(commands).toContain(
      'Deeper operator work lanes stay operator/admin-only',
    );
    expect(commands).not.toContain('/cursor_models [filter]');
    expect(commands).not.toContain('/cursor_create [options] <prompt>');
    expect(commands).not.toContain('/alexa_status');
    expect(commands).not.toContain('/amazon_search <keywords>');
    expect(commands).not.toContain(
      '/purchase_request <asin> <offer_id> [quantity]',
    );
    expect(commands).not.toContain('/cursor_remote');
    expect(commands).not.toContain('/cursor_remote_end');
  });
});

describe('buildTelegramChatIdText', () => {
  it('renders chat info without markdown-sensitive formatting', () => {
    const text = buildTelegramChatIdText('123', 'Ops_[Alpha]*', 'supergroup');

    expect(text).toBe('Chat ID: tg:123\nName: Ops_[Alpha]*\nType: supergroup');
  });
});

describe('buildTelegramUnregisteredDmText', () => {
  it('guides first-contact DMs toward setup instead of staying silent', () => {
    const text = buildTelegramUnregisteredDmText('Andrea');

    expect(text).toContain('this chat is not set up yet');
    expect(text).toContain('/start');
    expect(text).toContain('/registermain');
  });
});

describe('buildTelegramFeaturesText', () => {
  it('keeps the feature list focused on the stable demo surface', () => {
    const features = buildTelegramFeaturesText('Andrea');

    expect(features).toContain('Secure per-chat isolation');
    expect(features).toContain('Conversation-first help');
    expect(features).toContain('Fast replies for simple questions');
    expect(features).toContain('deeper Cursor plus Codex/OpenAI operator work');
    expect(features).not.toContain('Amazon shopping search');
    expect(features).not.toContain('Apple Calendar');
    expect(features).not.toContain('/cursor-results');
  });
});

describe('splitTelegramMessage', () => {
  it('keeps long Telegram replies from splitting in the middle of command hints', () => {
    const prefix = 'A'.repeat(4070);
    const text = `${prefix}\n\nRun /cursor-sync AGENT_ID to attach one of these jobs to this workspace.`;

    const chunks = splitTelegramMessage(text, 4096);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).not.toContain('/cursor-sync AGENT_ID');
    expect(chunks[1]).toBe(
      'Run /cursor-sync AGENT_ID to attach one of these jobs to this workspace.',
    );
  });

  it('falls back to a hard split when there is no safe breakpoint', () => {
    const text = 'A'.repeat(5000);

    const chunks = splitTelegramMessage(text, 4096);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });
});

describe('TelegramChannel.sendMessage', () => {
  it('passes reply targets and inline actions through to Telegram and returns the sent message id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 321 });
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = {
      api: { sendMessage },
    };

    const result = await channel.sendMessage('tg:123', 'Hello operator', {
      threadId: '42',
      replyToMessageId: '9001',
      inlineActions: [
        { label: 'Sync', actionId: '/cursor-sync' },
        { label: 'Open', url: 'https://cursor.com' },
      ],
    });

    expect(result.platformMessageId).toBe('321');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      '123',
      'Hello operator',
      expect.objectContaining({
        parse_mode: 'Markdown',
        message_thread_id: 42,
        reply_to_message_id: 9001,
        reply_markup: expect.any(Object),
      }),
    );
  });

  it('supports row-based inline button layouts for dashboard tiles', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 654 });
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = {
      api: { sendMessage },
    };

    await channel.sendMessage('tg:123', 'Cursor dashboard', {
      inlineActionRows: [
        [
          { label: 'Status', actionId: '/cursor-ui status' },
          { label: 'Jobs', actionId: '/cursor-ui jobs' },
        ],
        [{ label: 'Back', actionId: '/cursor-ui home' }],
      ],
    });

    const replyMarkup = sendMessage.mock.calls[0][2].reply_markup;
    expect(replyMarkup.inline_keyboard).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[0]).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[1]).toHaveLength(1);
  });

  it('escapes markdown-sensitive underscores before sending', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 777 });
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = {
      api: { sendMessage },
    };

    await channel.sendMessage(
      'tg:123',
      'Runtime: codex_local\nRepo: Andrea_NanoBot',
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '123',
      'Runtime: codex\\_local\nRepo: Andrea\\_NanoBot',
      expect.objectContaining({
        parse_mode: 'Markdown',
      }),
    );
  });

  it('preserves inline code spans while escaping other underscores', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 778 });
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = {
      api: { sendMessage },
    };

    await channel.sendMessage(
      'tg:123',
      'Task: Andrea_NanoBot\nUse `/runtime-followup runtime-job-follow_up <text>` now.',
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '123',
      'Task: Andrea\\_NanoBot\nUse `/runtime-followup runtime-job-follow_up <text>` now.',
      expect.objectContaining({
        parse_mode: 'Markdown',
      }),
    );
  });

  it('reports organic roundtrip success after replying to a recent inbound Telegram message', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 779 });
    const onRoundtripActivity = vi.fn();
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
      onRoundtripActivity,
    });
    const internals = channel as unknown as {
      bot: { api: { sendMessage: typeof sendMessage } };
      rememberInbound: (chatJid: string, observedAt: string) => void;
    };

    internals.bot = {
      api: { sendMessage },
    };
    internals.rememberInbound('tg:123', new Date().toISOString());

    await channel.sendMessage('tg:123', 'Hello again');

    expect(onRoundtripActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'organic_success',
        chatJid: 'tg:123',
      }),
    );
  });
});

describe('TelegramChannel.editMessage', () => {
  it('edits an existing Telegram message and preserves inline button rows', async () => {
    const editMessageText = vi.fn().mockResolvedValue({});
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { editMessageText: typeof editMessageText } };
      }
    ).bot = {
      api: { editMessageText },
    };

    const result = await channel.editMessage?.(
      'tg:123',
      '9001',
      'Updated dashboard',
      {
        inlineActionRows: [
          [
            { label: 'Sync', actionId: '/cursor-ui sync' },
            { label: 'Text', actionId: '/cursor-ui text' },
          ],
        ],
      },
    );

    expect(result?.platformMessageId).toBe('9001');
    expect(editMessageText).toHaveBeenCalledWith(
      '123',
      9001,
      'Updated dashboard',
      expect.objectContaining({
        parse_mode: 'Markdown',
        reply_markup: expect.any(Object),
      }),
    );
  });

  it('escapes markdown-sensitive underscores before editing', async () => {
    const editMessageText = vi.fn().mockResolvedValue({});
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { editMessageText: typeof editMessageText } };
      }
    ).bot = {
      api: { editMessageText },
    };

    await channel.editMessage?.(
      'tg:123',
      '9001',
      'Task: Andrea_NanoBot\nRuntime: codex_local',
    );

    expect(editMessageText).toHaveBeenCalledWith(
      '123',
      9001,
      'Task: Andrea\\_NanoBot\nRuntime: codex\\_local',
      expect.objectContaining({
        parse_mode: 'Markdown',
      }),
    );
  });
});

describe('TelegramChannel health state', () => {
  it('treats readiness as a health-driven signal instead of bot existence alone', () => {
    const onHealthUpdate = vi.fn();
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
      onHealthUpdate,
    });
    const internals = channel as unknown as {
      bot: object | null;
      updateHealth: (patch: Record<string, unknown>) => void;
    };

    internals.bot = {};
    expect(channel.isConnected()).toBe(false);

    internals.updateHealth({
      state: 'ready',
      detail: 'Telegram long polling connected.',
      lastReadyAt: '2026-04-04T12:00:00.000Z',
      lastError: null,
    });
    expect(channel.isConnected()).toBe(true);

    internals.updateHealth({
      state: 'degraded',
      detail: 'Telegram long polling was interrupted by a webhook change.',
      lastError: 'Telegram long polling was interrupted by a webhook change.',
    });
    expect(channel.isConnected()).toBe(false);
    expect(onHealthUpdate).toHaveBeenCalled();
  });
});
