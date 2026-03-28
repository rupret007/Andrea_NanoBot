import { describe, expect, it } from 'vitest';

import {
  buildTelegramHelpText,
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

    expect(help).toContain("Hi, I'm Andrea.");
    expect(help).toContain('/help');
    expect(help).toContain('/ping');
    expect(help).toContain('/chatid');
    expect(help).toContain('/registermain');
    expect(help).toContain('To-do lists, reminders, and recurring tasks');
  });
});
