import { describe, expect, it } from 'vitest';

import {
  buildTelegramCommandsText,
  buildTelegramFeaturesText,
  buildTelegramHelpText,
  buildTelegramWelcomeText,
  extractTelegramLeadingCommand,
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
    expect(commands).toContain(
      'Advanced operator workflows stay in the admin guide',
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

describe('buildTelegramFeaturesText', () => {
  it('keeps the feature list focused on the stable demo surface', () => {
    const features = buildTelegramFeaturesText('Andrea');

    expect(features).toContain('Secure per-chat isolation');
    expect(features).toContain('Fast replies for simple questions');
    expect(features).toContain('operator-safe status checks');
    expect(features).not.toContain('Amazon shopping search');
    expect(features).not.toContain('Apple Calendar');
  });
});
