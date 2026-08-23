import { describe, expect, it } from 'vitest';

import { secureEqual } from './secure-equal.js';

describe('secureEqual', () => {
  it('accepts identical secrets', () => {
    expect(secureEqual('hook-secret', 'hook-secret')).toBe(true);
  });

  it('rejects mismatched secrets and empty presented values', () => {
    expect(secureEqual('hook-secret', 'nope')).toBe(false);
    expect(secureEqual('', 'hook-secret')).toBe(false);
    expect(secureEqual('hook-secret', '')).toBe(false);
  });
});
