import { describe, expect, it } from 'vitest';

import { buildSilentSuccessFallback } from './user-facing-fallback.js';

describe('buildSilentSuccessFallback', () => {
  it('reuses the direct rescue reply for direct assistant turns', () => {
    const reply = buildSilentSuccessFallback('direct_assistant', [
      { content: 'Do you have a personality?' },
    ]);

    expect(reply).toContain("I'm Andrea");
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
});
