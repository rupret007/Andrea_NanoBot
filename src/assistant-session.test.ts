import { describe, expect, it } from 'vitest';

import {
  getAssistantSessionStorageKey,
  isDeadAssistantSessionErrorText,
} from './assistant-session.js';

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

describe('isDeadAssistantSessionErrorText', () => {
  it('detects stale session text from assistant runtimes', () => {
    expect(
      isDeadAssistantSessionErrorText(
        'No conversation found with session ID: dead-session-123',
      ),
    ).toBe(true);
  });

  it('ignores ordinary assistant output', () => {
    expect(
      isDeadAssistantSessionErrorText(
        'Andrea: I drafted a reply you can send when you are ready.',
      ),
    ).toBe(false);
  });
});
