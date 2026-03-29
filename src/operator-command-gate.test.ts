import { describe, expect, it } from 'vitest';

import {
  getCommandAccessDecision,
  isMainControlChat,
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
});
