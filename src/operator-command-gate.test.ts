import { describe, expect, it } from 'vitest';

import {
  getCommandAccessDecision,
  isMainControlChat,
  normalizeCommandToken,
} from './operator-command-gate.js';

describe('operator command gate', () => {
  it('allows public-safe commands without a registered main chat', () => {
    const decision = getCommandAccessDecision('/cursor_status', undefined);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('public');
  });

  it('blocks advanced cursor job commands before a main chat exists', () => {
    const decision = getCommandAccessDecision('/cursor_create', undefined);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
    expect(decision.message).toContain('/registermain');
  });

  it('treats /cursor as an operator-only dashboard entrypoint', () => {
    const decision = getCommandAccessDecision('/cursor', undefined);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
  });

  it('treats /cursor-results as an operator-only alias', () => {
    const decision = getCommandAccessDecision('/cursor-results', undefined);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
  });

  it('keeps temporary runtime scaffolding operator-only', () => {
    const blocked = getCommandAccessDecision('/runtime-status', undefined);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('main_control_only');

    const allowed = getCommandAccessDecision('/runtime-jobs', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('keeps debug troubleshooting commands main-control-only', () => {
    const blocked = getCommandAccessDecision('/debug-status', undefined);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('main_control_only');

    const allowed = getCommandAccessDecision('/debug-level', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('blocks advanced commands in non-main chats', () => {
    const decision = getCommandAccessDecision('/amazon_status', {
      name: 'Family',
      folder: 'family',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
    expect(decision.message).toContain('main control chat');
  });

  it('blocks optional operator commands in non-main chats across hyphen aliases too', () => {
    const decision = getCommandAccessDecision('/alexa-status', {
      name: 'Family',
      folder: 'family',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
    expect(decision.message).toContain('main control chat');
  });

  it('allows advanced commands from the main control chat', () => {
    const decision = getCommandAccessDecision('/cursor_test', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });

    expect(decision.allowed).toBe(true);
  });

  it('allows the preferred /cursor-download alias from the main control chat', () => {
    const decision = getCommandAccessDecision('/cursor-download', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });

    expect(decision.allowed).toBe(true);
  });

  it('keeps hidden cursor selector helpers restricted to the main control chat', () => {
    const blocked = getCommandAccessDecision('/cursor-select', undefined);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('main_control_only');

    const hiddenUiBlocked = getCommandAccessDecision('/cursor-ui', undefined);
    expect(hiddenUiBlocked.allowed).toBe(false);
    expect(hiddenUiBlocked.reason).toBe('main_control_only');

    const allowed = getCommandAccessDecision('/cursor-terminal-help', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('keeps remote control disabled even in the main chat', () => {
    const decision = getCommandAccessDecision('/remote_control', {
      name: 'Andrea Main',
      folder: 'main',
      trigger: '@andrea',
      added_at: '2026-03-29T00:00:00.000Z',
      isMain: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('disabled');
    expect(decision.message).toContain('disabled');
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
    expect(normalizeCommandToken('/cursor_create@andrea_nanobot')).toBe(
      '/cursor_create',
    );
    expect(normalizeCommandToken('/cursor_create?!')).toBe('/cursor_create');
    expect(normalizeCommandToken('/amazon_status.')).toBe('/amazon_status');
    expect(normalizeCommandToken('/amazon-search?!')).toBe('/amazon-search');
    expect(normalizeCommandToken('/purchase-approve@andrea_nanobot')).toBe(
      '/purchase-approve',
    );
  });

  it('keeps operator-only commands blocked after token normalization', () => {
    const decision = getCommandAccessDecision('/cursor_create?!', undefined);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
  });

  it('treats terminal control commands as main-control-only', () => {
    const decision = getCommandAccessDecision(
      '/cursor_terminal@andrea_nanobot',
      undefined,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('main_control_only');
  });
});
