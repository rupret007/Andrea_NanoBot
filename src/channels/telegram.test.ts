import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';
import { Bot, GrammyError, HttpError } from 'grammy';

import {
  TelegramChannel,
  TELEGRAM_STATIC_BOT_COMMANDS,
  buildTelegramBlueBubblesStatusText,
  buildTelegramChatIdText,
  buildTelegramCognitionText,
  buildTelegramCouncilText,
  buildTelegramCommandsText,
  buildTelegramFeaturesText,
  buildTelegramForgetText,
  buildTelegramMainChatStatusText,
  buildTelegramHelpText,
  buildTelegramLearningText,
  buildTelegramMemoryText,
  buildTelegramPingText,
  buildTelegramThinkingText,
  buildTelegramUnregisteredDmText,
  buildTelegramWelcomeText,
  resolveTelegramMainChatStatus,
  extractTelegramReplyRef,
  extractTelegramLeadingCommand,
  splitTelegramMessage,
} from './telegram.js';
import type { RegisteredGroup } from '../types.js';
import {
  getTelegramBotGroupMenuCommands,
  getTelegramBotMenuCommands,
} from '../command-surface-registry.js';
import {
  persistNanoclawHostState,
  readTelegramTransportState,
  writeAssistantReadyState,
} from '../host-control.js';

function telegramApiError(description: string, errorCode = 400): GrammyError {
  return new GrammyError(
    'Telegram API rejected the request',
    {
      ok: false,
      error_code: errorCode,
      description,
    },
    'sendMessage',
    {},
  );
}

type TelegramInboundFixtureKind = 'text' | 'media' | 'callback';

const TELEGRAM_INBOUND_TEST_CHAT_ID = 4242;

function buildTelegramInboundFixture(
  kind: TelegramInboundFixtureKind,
): Parameters<Bot['handleUpdate']>[0] {
  const from = {
    id: 77,
    is_bot: false,
    first_name: 'Owner',
  };
  const chat = {
    id: TELEGRAM_INBOUND_TEST_CHAT_ID,
    type: 'private' as const,
    first_name: 'Owner',
  };
  const message = {
    message_id: 101,
    date: 1_776_000_000,
    chat,
    from,
  };

  if (kind === 'text') {
    return {
      update_id: 1,
      message: {
        ...message,
        text: 'Summarize my recent texts.',
      },
    };
  }
  if (kind === 'media') {
    return {
      update_id: 2,
      message: {
        ...message,
        voice: {
          file_id: 'voice-file-1',
          file_unique_id: 'voice-unique-1',
          duration: 1,
        },
      },
    };
  }
  return {
    update_id: 3,
    callback_query: {
      id: 'callback-1',
      from,
      chat_instance: 'callback-chat-instance-1',
      data: '/cursor-status',
      message: {
        ...message,
        text: 'Owner controls',
      },
    },
  };
}

const TELEGRAM_INBOUND_TEST_MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-16T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

async function createTelegramInboundTestBot(
  onMessage: ConstructorParameters<typeof TelegramChannel>[1]['onMessage'],
  options?: {
    registeredGroups?: () => Record<string, RegisteredGroup>;
  },
): Promise<Bot> {
  const channel = new TelegramChannel('test-token', {
    onMessage,
    onChatMetadata: vi.fn(),
    registeredGroups:
      options?.registeredGroups ??
      (() => ({
        [`tg:${TELEGRAM_INBOUND_TEST_CHAT_ID}`]:
          TELEGRAM_INBOUND_TEST_MAIN_GROUP,
      })),
  });
  (
    channel as unknown as {
      startPollingSession: () => Promise<void>;
    }
  ).startPollingSession = vi.fn().mockResolvedValue(undefined);
  await channel.connect();

  const bot = (channel as unknown as { bot: Bot }).bot;
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: 'Andrea',
    username: 'andrea_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };
  bot.api.config.use((previous, method, payload, signal) => {
    if (method === 'answerCallbackQuery') {
      return Promise.resolve({ ok: true, result: true }) as ReturnType<
        typeof previous
      >;
    }
    if (method === 'sendMessage') {
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 1,
          date: 1_776_000_000,
          chat: {
            id: TELEGRAM_INBOUND_TEST_CHAT_ID,
            type: 'private',
          },
          text: String((payload as { text?: string }).text || ''),
        },
      }) as ReturnType<typeof previous>;
    }
    return previous(method, payload, signal);
  });
  return bot;
}

describe('extractTelegramLeadingCommand', () => {
  it('extracts plain slash commands', () => {
    expect(extractTelegramLeadingCommand('/registermain')).toBe('registermain');
  });

  it('extracts /mainchat as a plain slash command', () => {
    expect(extractTelegramLeadingCommand('/mainchat')).toBe('mainchat');
  });

  it('extracts /bluebubbles as a plain slash command', () => {
    expect(extractTelegramLeadingCommand('/bluebubbles')).toBe('bluebubbles');
  });

  it('extracts /council and /cognition as static bot commands', () => {
    expect(extractTelegramLeadingCommand('/council')).toBe('council');
    expect(extractTelegramLeadingCommand('/cognition')).toBe('cognition');
    expect(
      extractTelegramLeadingCommand(
        '@andrea_test_bot /council',
        'andrea_test_bot',
      ),
    ).toBe('council');
    expect(TELEGRAM_STATIC_BOT_COMMANDS.has('council')).toBe(true);
    expect(TELEGRAM_STATIC_BOT_COMMANDS.has('cognition')).toBe(true);
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

  it('ignores /mainchat when it targets another bot', () => {
    expect(
      extractTelegramLeadingCommand('/mainchat@other_bot', 'andrea_nanobot'),
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
  it('keeps help short and focused on how to use Telegram well', () => {
    const help = buildTelegramHelpText('Andrea');

    expect(help).toContain('*How Andrea Works Here*');
    expect(help).toContain('/registermain');
    expect(help).toContain('/commands');
    expect(help).toContain('/features');
    expect(help).toContain('Most people should just send a normal message.');
    expect(help).toContain("what's on my calendar tomorrow");
    expect(help).toContain('what bills do I need to pay this week');
    expect(help).toContain('send it');
    expect(help).toContain('QA, Karen');
    expect(help).not.toContain('Benchmark-Guided Packs');
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
    expect(welcome).toContain('Just send a normal message');
    expect(welcome).toContain("what's on my calendar tomorrow");
    expect(welcome).toContain('remind me to take my pills at 9');
    expect(welcome).toContain('send it');
    expect(welcome).not.toContain('Benchmark-Guided Packs');
    expect(welcome).not.toContain('Candace');
    expect(welcome).not.toContain('@Andrea');
  });
});

describe('buildTelegramCommandsText', () => {
  it('groups the public command list around setup and status instead of a flat dump', () => {
    const commands = buildTelegramCommandsText();

    expect(commands).toContain('*Telegram Commands*');
    expect(commands).toContain('*Start Here*');
    expect(commands).toContain('*Useful Checks*');
    expect(commands).toContain('*Thinking and Memory*');
    expect(commands).toContain('*In Groups*');
    expect(commands).toContain('/cursor_status');
    expect(commands).toContain('/bluebubbles');
    expect(commands).toContain('/thinking');
    expect(commands).toContain('/council');
    expect(commands).toContain('/cognition');
    expect(commands).toContain('/memory');
    expect(commands).toContain('/learning');
    expect(commands).toContain('/forget');
    expect(commands).toContain(
      'Most people can ignore commands and just type normally.',
    );
    expect(commands).toContain(
      'Deeper operator/admin controls stay out of normal help',
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

describe('buildTelegramBlueBubblesStatusText', () => {
  it('returns the operator-safe BlueBubbles proof summary', () => {
    const text = buildTelegramBlueBubblesStatusText();

    expect(text).toContain('BlueBubbles Status');
    expect(text).toContain('Proof:');
    expect(text).toContain('Message-action proof:');
    expect(text).not.toContain('secret=');
  });
});

describe('Telegram thinking, council, and memory command text', () => {
  it('explains deep/quick thinking controls and learning safety rails', () => {
    const thinking = buildTelegramThinkingText('Andrea');
    const council = buildTelegramCouncilText();
    const cognition = buildTelegramCognitionText();
    const memory = buildTelegramMemoryText('Andrea');
    const learning = buildTelegramLearningText('Andrea');
    const forget = buildTelegramForgetText();

    expect(thinking).toContain('Smart auto is on');
    expect(thinking).toContain('ultrathink');
    expect(thinking).toContain('think harder');
    expect(thinking).toContain('quick answer');
    expect(council).toContain('Council Status');
    expect(council).toContain('Privacy:');
    expect(council).not.toMatch(/sk-(?:proj|ant|api)|AIza|Bearer\s+/);
    expect(cognition).toContain('Cognition Status');
    expect(cognition).toContain('metadata-only');
    expect(cognition).not.toMatch(/sk-(?:proj|ant|api)|AIza|Bearer\s+/);
    expect(memory).toContain('working context');
    expect(memory).toContain('what did you learn?');
    expect(learning).toContain('Aggressive learning is on');
    expect(learning).toContain('raw hidden reasoning');
    expect(forget).toContain('forget that');
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
    expect(text).toContain('/registermain');
    expect(text).toContain('/mainchat');
    expect(text).not.toContain('/start for the quick guide');
  });
});

describe('buildTelegramMainChatStatusText', () => {
  const registeredGroups = {
    'tg:100': {
      name: 'Jeff Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-01T10:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
    },
  };

  it('reports the registered main chat and gives non-main recovery steps', () => {
    const text = buildTelegramMainChatStatusText(registeredGroups, 'tg:200');

    expect(text).toContain('Main Control Chat Status');
    expect(text).toContain('Registered main control chat: Jeff Main (tg:100)');
    expect(text).toContain(
      'This chat is not the registered main control chat.',
    );
    expect(text).toContain('/registermain');
    expect(text).toContain('/mainchat');
  });

  it('marks the current DM as main when it matches the registered main chat', () => {
    const status = resolveTelegramMainChatStatus(registeredGroups, 'tg:100');

    expect(status).toEqual({
      hasMainChat: true,
      mainChatJid: 'tg:100',
      mainChatName: 'Jeff Main',
      isCurrentChatMain: true,
    });
  });

  it('gives deterministic first-registration guidance when no main exists', () => {
    const text = buildTelegramMainChatStatusText({}, 'tg:200');

    expect(text).toContain('No main control chat is currently registered');
    expect(text).toContain('/registermain');
  });
});

describe('buildTelegramFeaturesText', () => {
  it('keeps the feature list focused on the stable demo surface', () => {
    const features = buildTelegramFeaturesText('Andrea');

    expect(features).toContain('*Best Here*');
    expect(features).toContain('calendar');
    expect(features).toContain('does not auto-reply to contacts');
    expect(features).toContain(
      'ordinary contact and group threads remain data-only',
    );
    expect(features).toContain('configured owner Messages self-thread');
    expect(features).toContain(
      'Alexa is concise voice help for schedule, reminders, list capture and readout, planning, and quick reply help',
    );
    expect(features).not.toContain('Amazon shopping search');
    expect(features).not.toContain('Apple Calendar');
    expect(features).not.toContain('/cursor-results');
  });
});

describe('buildTelegramPingText', () => {
  it('returns the shared two-line witty ping response', () => {
    const text = buildTelegramPingText(
      'Andrea',
      new Date('2026-04-07T20:05:00.000Z'),
    );

    expect(text).toContain('Andrea is online.');
    expect(text.split('\n')).toHaveLength(2);
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

describe('TelegramChannel inbound acceptance', () => {
  it('does not ingest mention-prefixed /council or /cognition as agent turns', async () => {
    const onMessage = vi.fn<
      ConstructorParameters<typeof TelegramChannel>[1]['onMessage']
    >(async () => undefined);
    const bot = await createTelegramInboundTestBot(onMessage);

    const updates = [
      '@andrea_test_bot /council',
      '@andrea_test_bot /cognition',
      '/council',
      '/cognition',
    ];
    for (const [index, text] of updates.entries()) {
      await bot.handleUpdate({
        update_id: 10 + index,
        message: {
          message_id: 201 + index,
          date: 1_776_000_000,
          chat: {
            id: TELEGRAM_INBOUND_TEST_CHAT_ID,
            type: 'private',
            first_name: 'Owner',
          },
          from: {
            id: 77,
            is_bot: false,
            first_name: 'Owner',
          },
          text,
        },
      });
    }

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('drops callbacks from unregistered Telegram chats before onMessage', async () => {
    const onMessage = vi.fn<
      ConstructorParameters<typeof TelegramChannel>[1]['onMessage']
    >(async () => undefined);
    const bot = await createTelegramInboundTestBot(onMessage, {
      registeredGroups: () => ({}),
    });

    await bot.handleUpdate(buildTelegramInboundFixture('callback'));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('uses the original Telegram card time as callback authorization time', async () => {
    const onMessage = vi.fn<
      ConstructorParameters<typeof TelegramChannel>[1]['onMessage']
    >(async () => undefined);
    const bot = await createTelegramInboundTestBot(onMessage);

    await bot.handleUpdate(buildTelegramInboundFixture('callback'));

    expect(onMessage).toHaveBeenCalledWith(
      `tg:${TELEGRAM_INBOUND_TEST_CHAT_ID}`,
      expect.objectContaining({
        id: 'callback:callback-1',
        timestamp: '2026-04-12T13:20:00.000Z',
        ingress_received_at: '2026-04-12T13:20:00.000Z',
      }),
    );
  });

  it('retains the Telegram server time on a delayed typed update', async () => {
    const onMessage = vi.fn<
      ConstructorParameters<typeof TelegramChannel>[1]['onMessage']
    >(async () => undefined);
    const bot = await createTelegramInboundTestBot(onMessage);

    await bot.handleUpdate(buildTelegramInboundFixture('text'));

    expect(onMessage).toHaveBeenCalledWith(
      `tg:${TELEGRAM_INBOUND_TEST_CHAT_ID}`,
      expect.objectContaining({
        id: '101',
        timestamp: '2026-04-12T13:20:00.000Z',
      }),
    );
    expect(onMessage.mock.calls[0]?.[1].ingress_received_at).toBeUndefined();
  });

  it.each(['text', 'media', 'callback'] as const)(
    'waits for async onMessage acceptance for %s updates',
    async (kind) => {
      let releaseAcceptance: (() => void) | undefined;
      const acceptance = new Promise<void>((resolve) => {
        releaseAcceptance = resolve;
      });
      const onMessage = vi.fn(() => acceptance);
      const bot = await createTelegramInboundTestBot(onMessage);
      const settled = vi.fn();

      const handling = bot
        .handleUpdate(buildTelegramInboundFixture(kind))
        .then(() => settled());

      await vi.waitFor(() => {
        expect(onMessage).toHaveBeenCalledTimes(1);
      });
      expect(settled).not.toHaveBeenCalled();

      releaseAcceptance?.();
      await handling;
      expect(settled).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['text', 'media', 'callback'] as const)(
    'propagates onMessage rejection for %s updates',
    async (kind) => {
      const failure = new Error(`inbound ${kind} acceptance failed`);
      const onMessage = vi.fn(async () => {
        throw failure;
      });
      const bot = await createTelegramInboundTestBot(onMessage);

      await expect(
        bot.handleUpdate(buildTelegramInboundFixture(kind)),
      ).rejects.toMatchObject({ error: failure });
      expect(onMessage).toHaveBeenCalledTimes(1);
    },
  );
});

describe('TelegramChannel polling hardening', () => {
  it('registers bot metadata only once per boot even if reconnect logic calls it twice', async () => {
    const setMyDescription = vi.fn().mockResolvedValue(undefined);
    const setMyShortDescription = vi.fn().mockResolvedValue(undefined);
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: {
          api: {
            setMyDescription: typeof setMyDescription;
            setMyShortDescription: typeof setMyShortDescription;
            setMyCommands: typeof setMyCommands;
          };
        };
        configureBotMetadataOnce: () => Promise<void>;
      }
    ).bot = {
      api: {
        setMyDescription,
        setMyShortDescription,
        setMyCommands,
      },
    };

    await (
      channel as unknown as {
        configureBotMetadataOnce: () => Promise<void>;
      }
    ).configureBotMetadataOnce();
    await (
      channel as unknown as {
        configureBotMetadataOnce: () => Promise<void>;
      }
    ).configureBotMetadataOnce();

    expect(setMyDescription).toHaveBeenCalledTimes(1);
    expect(setMyShortDescription).toHaveBeenCalledTimes(1);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
    expect(setMyCommands).toHaveBeenNthCalledWith(
      1,
      getTelegramBotGroupMenuCommands(),
    );
    expect(setMyCommands).toHaveBeenNthCalledWith(
      2,
      getTelegramBotMenuCommands(),
      {
        scope: { type: 'all_private_chats' },
      },
    );
  });

  it('registers a small chat-first Telegram DM menu from the shared public registry', async () => {
    expect(getTelegramBotMenuCommands().map((entry) => entry.command)).toEqual([
      'help',
      'registermain',
      'mainchat',
      'features',
      'ping',
    ]);
    expect(
      getTelegramBotMenuCommands().some((entry) => entry.command === 'start'),
    ).toBe(false);
    expect(
      getTelegramBotMenuCommands().some(
        (entry) => entry.command === 'cognition',
      ),
    ).toBe(false);
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

  it('keeps the Markdown-to-plain-text fallback but rejects a terminal double failure', async () => {
    const fallbackSend = vi
      .fn()
      .mockRejectedValueOnce(
        telegramApiError("Bad Request: can't parse entities"),
      )
      .mockResolvedValueOnce({ message_id: 322 });
    const failedSend = vi
      .fn()
      .mockRejectedValueOnce(
        telegramApiError("Bad Request: can't parse entities"),
      )
      .mockRejectedValueOnce(
        telegramApiError('Bad Request: message text is empty'),
      );
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    const internals = channel as unknown as {
      bot: { api: { sendMessage: typeof fallbackSend } } | null;
    };
    internals.bot = { api: { sendMessage: fallbackSend } };

    await expect(
      channel.sendMessage('tg:123', 'Fallback'),
    ).resolves.toMatchObject({ platformMessageId: '322' });
    expect(fallbackSend).toHaveBeenCalledTimes(2);

    internals.bot = { api: { sendMessage: failedSend } };
    await expect(channel.sendMessage('tg:123', 'Fail')).rejects.toThrow(
      'Telegram message delivery failed.',
    );
    expect(failedSend).toHaveBeenCalledTimes(2);

    internals.bot = null;
    await expect(channel.sendMessage('tg:123', 'Unavailable')).rejects.toThrow(
      'Telegram message delivery is unavailable.',
    );
  });

  it('returns all chunk receipts and attaches feedback actions only to the final chunk', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 700 })
      .mockResolvedValueOnce({ message_id: 701 });
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = { api: { sendMessage } };

    const result = await channel.sendMessage('tg:123', `${'a'.repeat(4096)}b`, {
      inlineActions: [{ label: 'Helpful', actionId: 'feedback:accepted' }],
    });

    expect(result).toMatchObject({
      platformMessageId: '700',
      platformMessageIds: ['700', '701'],
      deliveryState: 'complete',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('reply_markup');
    expect(sendMessage.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
  });

  it('reports a confirmed partial chunk delivery without replaying prior chunks', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 710 })
      .mockRejectedValueOnce(
        telegramApiError('Bad Request: message is too long'),
      );
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = { api: { sendMessage } };

    await expect(
      channel.sendMessage('tg:123', `${'a'.repeat(4096)}b`),
    ).resolves.toMatchObject({
      platformMessageId: '710',
      platformMessageIds: ['710'],
      deliveryState: 'partial',
      nextUnconfirmedChunkIndex: 1,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown transport outcome instead of blindly retrying it', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new HttpError('Telegram request timed out', new Error('timeout')),
      );
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    (
      channel as unknown as {
        bot: { api: { sendMessage: typeof sendMessage } };
      }
    ).bot = { api: { sendMessage } };

    await expect(channel.sendMessage('tg:123', 'uncertain')).resolves.toEqual({
      platformMessageId: undefined,
      platformMessageIds: [],
      threadId: null,
      deliveryState: 'unknown',
      nextUnconfirmedChunkIndex: 0,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

  it('drops oversized callback buttons instead of failing the whole send', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 655 });
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

    await channel.sendMessage('tg:123', 'Follow-through review', {
      inlineActionRows: [
        [
          { label: 'Open', actionId: '/review-open ok' },
          {
            label: 'Too long',
            actionId: `/review-open ${'x'.repeat(80)}`,
          },
        ],
      ],
    });

    const replyMarkup = sendMessage.mock.calls[0][2].reply_markup;
    expect(replyMarkup.inline_keyboard).toHaveLength(1);
    expect(replyMarkup.inline_keyboard[0]).toHaveLength(1);
    expect(replyMarkup.inline_keyboard[0][0]).toMatchObject({
      text: 'Open',
      callback_data: '/review-open ok',
    });
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

describe('TelegramChannel.sendArtifact', () => {
  it('sends image artifacts with a bounded caption through Telegram', async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 880 });
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });

    (
      channel as unknown as {
        bot: { api: { sendPhoto: typeof sendPhoto } };
      }
    ).bot = {
      api: { sendPhoto },
    };

    const result = await channel.sendArtifact?.(
      'tg:123',
      {
        kind: 'image',
        filename: 'andrea-image.png',
        mimeType: 'image/png',
        bytesBase64: Buffer.from('png-bytes').toString('base64'),
      },
      {
        caption: 'Here is a first pass.',
        threadId: '42',
        replyToMessageId: '9001',
      },
    );

    expect(result?.platformMessageId).toBe('880');
    expect(sendPhoto).toHaveBeenCalledWith(
      '123',
      expect.anything(),
      expect.objectContaining({
        caption: 'Here is a first pass.',
        message_thread_id: 42,
        reply_to_message_id: 9001,
      }),
    );
  });

  it('rejects terminal artifact failures instead of returning an empty receipt', async () => {
    const sendPhoto = vi
      .fn()
      .mockRejectedValue(new Error('artifact transport unavailable'));
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    (
      channel as unknown as {
        bot: { api: { sendPhoto: typeof sendPhoto } };
      }
    ).bot = { api: { sendPhoto } };

    await expect(
      channel.sendArtifact?.('tg:123', {
        kind: 'image',
        filename: 'failed.png',
        mimeType: 'image/png',
        bytesBase64: Buffer.from('png-bytes').toString('base64'),
      }),
    ).rejects.toThrow('Telegram artifact delivery failed.');
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

  it('rejects invalid targets and terminal edit failures instead of returning an empty receipt', async () => {
    const editMessageText = vi
      .fn()
      .mockRejectedValue(new Error('edit transport unavailable'));
    const channel = new TelegramChannel('test-token', {
      onMessage: () => undefined,
      onChatMetadata: () => undefined,
      registeredGroups: () => ({}),
    });
    (
      channel as unknown as {
        bot: { api: { editMessageText: typeof editMessageText } };
      }
    ).bot = { api: { editMessageText } };

    await expect(
      channel.editMessage?.('tg:123', 'not-a-message-id', 'No target'),
    ).rejects.toThrow('Telegram message edit target is invalid.');
    expect(editMessageText).not.toHaveBeenCalled();

    await expect(
      channel.editMessage?.('tg:123', '9001', 'Will fail'),
    ).rejects.toThrow('Telegram message editing failed.');
    expect(editMessageText).toHaveBeenCalledTimes(2);
  });
});

describe('TelegramChannel health state', () => {
  it('uses the current process boot identity before the ready marker rotates stale host state', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'telegram-boot-identity-'),
    );
    const projectAlias = `${projectRoot}-alias`;
    const previousCwd = process.cwd();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_776_000_000_000)
      .mockReturnValue(1_776_000_000_001);
    fs.mkdirSync(path.join(projectRoot, 'data', 'runtime'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
    fs.symlinkSync(
      projectRoot,
      projectAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    persistNanoclawHostState(
      {
        bootId: 'boot-prior-process',
        phase: 'running_ready',
        pid: process.pid + 1,
        installMode: 'manual_host_control',
        nodePath: process.execPath,
        nodeVersion: process.version,
        startedAt: '2026-07-15T12:00:00.000Z',
        readyAt: '2026-07-15T12:00:05.000Z',
        lastError: '',
        dependencyState: 'ok',
        dependencyError: '',
        stdoutLogPath: path.join(projectRoot, 'logs', 'nanoclaw.log'),
        stderrLogPath: path.join(projectRoot, 'logs', 'nanoclaw.error.log'),
        hostLogPath: path.join(projectRoot, 'logs', 'nanoclaw.host.log'),
      },
      projectRoot,
    );

    try {
      process.chdir(projectRoot);
      const channel = new TelegramChannel('test-token', {
        onMessage: () => undefined,
        onChatMetadata: () => undefined,
        registeredGroups: () => ({}),
      });
      const internals = channel as unknown as {
        persistTransportState: (patch: {
          status: 'starting';
          detail: string;
        }) => void;
      };

      internals.persistTransportState({
        status: 'starting',
        detail: 'Starting Telegram long polling.',
      });
      const preReadyTransport = readTelegramTransportState(projectRoot);
      const ready = writeAssistantReadyState('1.2.42', projectAlias);

      expect(preReadyTransport?.bootId).toBe(ready.bootId);
      expect(preReadyTransport?.bootId).not.toBe('boot-prior-process');
      expect(preReadyTransport?.pid).toBe(process.pid);
      expect(nowSpy).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
      process.chdir(previousCwd);
      fs.rmSync(projectAlias, { force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

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
