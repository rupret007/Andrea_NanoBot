import { describe, expect, it } from 'vitest';

import {
  buildThinkingStatusText,
  detectThinkingControlPreference,
  sanitizeCouncilIntentSnippet,
} from './thinking-controls.js';

describe('thinking controls', () => {
  it('treats ultrathink as a deep council control', () => {
    expect(
      detectThinkingControlPreference('ultrathink this before answering'),
    ).toBe('deep');
    expect(
      detectThinkingControlPreference('ultra-think through the tradeoffs'),
    ).toBe('deep');
  });

  it('documents ultrathink and keeps intent snippets redacted', () => {
    expect(buildThinkingStatusText()).toContain('ultrathink');

    const syntheticApiKey = ['sk', 'proj', 'exampleSecretValue1234567890'].join(
      '-',
    );
    const snippet = sanitizeCouncilIntentSnippet(
      `Use key ${syntheticApiKey} for jeff@example.com and +1 202 555 0101`,
    );

    expect(snippet).toContain('[REDACTED_SECRET]');
    expect(snippet).toContain('[redacted-email]');
    expect(snippet).toContain('[redacted-phone]');
    expect(snippet).not.toContain(syntheticApiKey);
    expect(snippet).not.toContain('jeff@example.com');
    expect(snippet).not.toContain('202 555 0101');
  });
});
