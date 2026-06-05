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

    const snippet = sanitizeCouncilIntentSnippet(
      'Use key sk-proj-exampleSecretValue1234567890 for jeff@example.com and +1 469 540 5551',
    );

    expect(snippet).toContain('[REDACTED_SECRET]');
    expect(snippet).toContain('[redacted-email]');
    expect(snippet).toContain('[redacted-phone]');
    expect(snippet).not.toContain('sk-proj-exampleSecretValue1234567890');
    expect(snippet).not.toContain('jeff@example.com');
    expect(snippet).not.toContain('469 540 5551');
  });
});
