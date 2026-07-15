import { describe, expect, it } from 'vitest';

import { redactCouncilText } from './council-safety.js';

describe('council metadata redaction', () => {
  it.each([
    'api_key=secret-value',
    'token=secret-value',
    'Authorization: Bearer secret-value',
  ])('is idempotent for %s', (input) => {
    const once = redactCouncilText(input);
    expect(redactCouncilText(once)).toBe(once);
    expect(once).not.toContain('secret-value');
  });

  it.each([
    'api_key=[REDACTED_SECRET-attacker-controlled-value',
    'api_key=[REDACTED_SECRET]attacker-controlled-value',
    'api_key=[REDACTED_SECRET] attacker-controlled-value',
  ])('does not trust a redaction-marker prefix for %s', (input) => {
    const redacted = redactCouncilText(input);
    expect(redacted).toBe('api_key=[REDACTED_SECRET]');
    expect(redacted).not.toContain('attacker-controlled-value');
  });
});
