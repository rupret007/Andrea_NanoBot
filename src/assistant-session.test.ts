import { describe, expect, it } from 'vitest';

import { getAssistantSessionStorageKey } from './assistant-session.js';

describe('getAssistantSessionStorageKey', () => {
  it('isolates direct assistant sessions', () => {
    expect(getAssistantSessionStorageKey('main', 'direct_assistant')).toBe(
      'main::direct_assistant',
    );
  });

  it('isolates protected assistant sessions', () => {
    expect(getAssistantSessionStorageKey('main', 'protected_assistant')).toBe(
      'main::protected_assistant',
    );
  });

  it('leaves other lanes on the legacy shared key', () => {
    expect(getAssistantSessionStorageKey('main', 'code_plane')).toBe('main');
    expect(getAssistantSessionStorageKey('main')).toBe('main');
  });
});
