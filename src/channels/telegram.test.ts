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
    expect(help).toContain('/cursor_models');
    expect(help).toContain('/cursor_test');
    expect(help).toContain('/alexa_status');
    expect(help).toContain('/amazon_status');
    expect(help).toContain('/amazon_search');
    expect(help).toContain('To-do lists, reminders, and recurring tasks');
  });
});

describe('buildTelegramWelcomeText', () => {
  it('shows quick-start instructions for new users', () => {
    const welcome = buildTelegramWelcomeText('Andrea');

    expect(welcome).toContain('*Welcome to Andrea*');
    expect(welcome).toContain('/registermain');
    expect(welcome).toContain('/commands');
    expect(welcome).toContain('/features');
  });
});

describe('buildTelegramCommandsText', () => {
  it('lists both chat and cursor control commands', () => {
    const commands = buildTelegramCommandsText();

    expect(commands).toContain('/start');
    expect(commands).toContain('/help');
    expect(commands).toContain('/commands');
    expect(commands).toContain('/features');
    expect(commands).toContain('/cursor_remote');
    expect(commands).toContain('/cursor_remote_end');
    expect(commands).toContain('/cursor_models [filter]');
    expect(commands).toContain('/cursor_create [options] <prompt>');
    expect(commands).toContain('/cursor_conversation <agent_id> [limit]');
    expect(commands).toContain('/cursor_artifacts <agent_id>');
    expect(commands).toContain(
      '/cursor_artifact_link <agent_id> <absolute_path>',
    );
    expect(commands).toContain('/alexa_status');
    expect(commands).toContain('/amazon_search <keywords>');
    expect(commands).toContain(
      '/purchase_request <asin> <offer_id> [quantity]',
    );
    expect(commands).toContain(
      '/purchase_approve <request_id> <approval_code>',
    );
  });
});

describe('buildTelegramFeaturesText', () => {
  it('includes calendar integrations and secure isolation guidance', () => {
    const features = buildTelegramFeaturesText('Andrea');

    expect(features).toContain('Apple Calendar');
    expect(features).toContain('Outlook/M365');
    expect(features).toContain('Secure per-chat isolation');
    expect(features).toContain('Amazon shopping search');
    expect(features).toContain('Alexa voice ingress');
  });
});
