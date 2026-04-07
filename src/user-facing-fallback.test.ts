import { describe, expect, it } from 'vitest';

import { buildSilentSuccessFallback } from './user-facing-fallback.js';

describe('buildSilentSuccessFallback', () => {
  it('reuses the direct rescue reply for direct assistant turns', () => {
    const reply = buildSilentSuccessFallback(
      'direct_assistant',
      [{ content: 'Do you have a personality?' }],
      'telegram',
    );

    expect(reply).toContain("I'm Andrea");
  });

  it('keeps direct capability fallbacks non-technical', () => {
    const reply = buildSilentSuccessFallback(
      'direct_assistant',
      [{ content: 'Can you use cursor and codex?' }],
      'telegram',
    );

    expect(reply).toContain('coding and repo work');
    expect(reply).not.toContain('runtime failed during startup or execution');
  });

  it('shapes direct fallback more concisely for Alexa ordinary chat', () => {
    const reply = buildSilentSuccessFallback(
      'direct_assistant',
      [{ content: "What's up?" }],
      'alexa',
    );

    expect(reply).toBeTruthy();
    expect(reply).not.toContain('operator');
  });

  it('uses reminder-specific wording for protected reminder requests', () => {
    const reply = buildSilentSuccessFallback('protected_assistant', [
      { content: 'Remind me tomorrow at 3pm to call Sam' },
    ]);

    expect(reply).toContain("couldn't confirm that reminder was saved");
    expect(reply).toContain("haven't assumed it went through");
  });

  it('uses generic protected-assistant wording for other protected tasks', () => {
    const reply = buildSilentSuccessFallback('protected_assistant', [
      { content: 'What is the weather tomorrow?' },
    ]);

    expect(reply).toContain("couldn't confirm that request completed");
  });

  it('uses control-plane wording for control actions', () => {
    const reply = buildSilentSuccessFallback('control_plane', [
      { content: 'stop that job' },
    ]);

    expect(reply).toContain('control action completed');
  });

  it('keeps generic fallback wording free of helper internals', () => {
    const reply = buildSilentSuccessFallback('advanced_helper', [
      { content: 'do the complicated thing' },
    ]);

    expect(reply).not.toContain('helper');
    expect(reply).toContain('usable final response');
  });
});
