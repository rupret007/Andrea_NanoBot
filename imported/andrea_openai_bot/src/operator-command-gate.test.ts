import { describe, expect, it } from 'vitest';

import {
  getCommandAccessDecision,
  isKnownOperatorCommand,
  isMainControlChat,
  normalizeCommandToken,
} from './operator-command-gate.js';

describe('operator command gate', () => {
  it('allows normal messages without a registered main chat', () => {
    const decision = getCommandAccessDecision('hello', undefined);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('public');
  });

  it('blocks runtime commands before a main chat exists', () => {
    const decision = getCommandAccessDecision('/runtime-jobs', undefined);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
  });

  it('blocks runtime commands in non-main chats', () => {
    const decision = getCommandAccessDecision('/runtime-status', {
      name: 'Family',
      folder: 'family',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
  });

  it('allows runtime commands from the main control chat', () => {
    const decision = getCommandAccessDecision('/runtime-status', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });

    expect(decision.allowed).toBe(true);
  });

  it('treats legacy operator commands as unsupported', () => {
    const decision = getCommandAccessDecision('/remote_control', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unsupported_legacy');
    expect(isKnownOperatorCommand('/remote_control')).toBe(true);
  });

  it('detects main control chats explicitly', () => {
    expect(
      isMainControlChat({
        name: 'Andrea Main',
        folder: 'main',
        trigger: '@andrea',
        added_at: '2026-03-29T00:00:00.000Z',
        isMain: true,
      }),
    ).toBe(true);
    expect(isMainControlChat(undefined)).toBe(false);
  });

  it('normalizes Telegram command suffixes and trailing punctuation', () => {
    expect(normalizeCommandToken('/runtime-status@andrea_openai_bot')).toBe(
      '/runtime-status',
    );
    expect(normalizeCommandToken('/runtime-status?!')).toBe('/runtime-status');
  });
});
