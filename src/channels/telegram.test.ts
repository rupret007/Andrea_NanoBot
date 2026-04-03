import { describe, expect, it } from 'vitest';

import {
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
      'Deeper Cursor job and terminal commands are operator/admin-only',
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
    expect(features).toContain(
      'deeper Cursor controls kept in the operator/admin path',
    );
    expect(features).not.toContain('Amazon shopping search');
    expect(features).not.toContain('Apple Calendar');
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
