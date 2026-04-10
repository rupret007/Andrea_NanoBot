import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  deleteSessionStorageKey,
  getAgentThread,
  getAllAgentThreads,
  getSession,
  setAgentThread,
  setSession,
} from './db.js';

describe('db agent thread persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores and retrieves provider-neutral thread metadata', () => {
    setAgentThread({
      group_folder: 'main',
      runtime: 'codex_local',
      thread_id: 'thread_123',
      last_response_id: 'thread_123',
      updated_at: '2026-03-30T00:00:00.000Z',
    });

    expect(getAgentThread('main')).toEqual({
      group_folder: 'main',
      runtime: 'codex_local',
      thread_id: 'thread_123',
      last_response_id: 'thread_123',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
  });

  it('hydrates a legacy session into a claude_legacy runtime record', () => {
    setSession('legacy', 'sess_456');

    expect(getAgentThread('legacy')).toEqual({
      group_folder: 'legacy',
      runtime: 'claude_legacy',
      thread_id: 'sess_456',
      last_response_id: null,
      updated_at: '',
    });
    expect(getAllAgentThreads().legacy?.runtime).toBe('claude_legacy');
  });

  it('can clear assistant session storage keys without treating them as group folders', () => {
    setSession('main::direct_assistant', 'sess_789');

    deleteSessionStorageKey('main::direct_assistant');

    expect(getSession('main::direct_assistant')).toBeUndefined();
  });
});
