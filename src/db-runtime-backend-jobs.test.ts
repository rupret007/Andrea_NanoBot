import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  deleteRuntimeBackendCardContext,
  deleteRuntimeBackendChatSelection,
  getRuntimeBackendCardContext,
  getRuntimeBackendChatSelection,
  getRuntimeBackendJob,
  listRuntimeBackendJobsForGroup,
  pruneExpiredRuntimeBackendCardContexts,
  upsertRuntimeBackendCardContext,
  upsertRuntimeBackendChatSelection,
  upsertRuntimeBackendJob,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('runtime backend job cache accessors', () => {
  it('upserts and fetches backend jobs', () => {
    upsertRuntimeBackendJob({
      backend_id: 'andrea_openai',
      job_id: 'job_001',
      group_folder: 'main',
      chat_jid: 'tg:1',
      thread_id: 'thread_001',
      status: 'running',
      selected_runtime: 'codex_local',
      prompt_preview: 'Ship the docs patch',
      latest_output_text: 'Working...',
      error_text: null,
      log_file: 'container-job_001.log',
      created_at: '2026-04-02T20:00:00.000Z',
      updated_at: '2026-04-02T20:05:00.000Z',
      raw_json: '{"jobId":"job_001"}',
    });

    const row = getRuntimeBackendJob('andrea_openai', 'job_001');
    expect(row).toBeDefined();
    expect(row?.group_folder).toBe('main');
    expect(row?.thread_id).toBe('thread_001');
  });

  it('lists backend jobs newest-first within a group', () => {
    upsertRuntimeBackendJob({
      backend_id: 'andrea_openai',
      job_id: 'job_001',
      group_folder: 'main',
      chat_jid: 'tg:1',
      thread_id: null,
      status: 'succeeded',
      selected_runtime: 'codex_local',
      prompt_preview: 'First',
      latest_output_text: null,
      error_text: null,
      log_file: null,
      created_at: '2026-04-02T20:00:00.000Z',
      updated_at: '2026-04-02T20:00:00.000Z',
      raw_json: '{"jobId":"job_001"}',
    });
    upsertRuntimeBackendJob({
      backend_id: 'andrea_openai',
      job_id: 'job_002',
      group_folder: 'main',
      chat_jid: 'tg:1',
      thread_id: null,
      status: 'running',
      selected_runtime: 'openai_cloud',
      prompt_preview: 'Second',
      latest_output_text: null,
      error_text: null,
      log_file: null,
      created_at: '2026-04-02T20:10:00.000Z',
      updated_at: '2026-04-02T20:11:00.000Z',
      raw_json: '{"jobId":"job_002"}',
    });

    const rows = listRuntimeBackendJobsForGroup('andrea_openai', 'main');
    expect(rows).toHaveLength(2);
    expect(rows[0].job_id).toBe('job_002');
    expect(rows[1].job_id).toBe('job_001');
  });

  it('stores and prunes runtime card reply contexts', () => {
    upsertRuntimeBackendCardContext({
      backend_id: 'andrea_openai',
      chat_jid: 'tg:1',
      message_id: '500',
      job_id: 'job_001',
      group_folder: 'main',
      thread_id: 'topic_1',
      created_at: '2026-04-03T10:00:00.000Z',
      expires_at: '2026-04-04T10:00:00.000Z',
    });

    expect(
      getRuntimeBackendCardContext('andrea_openai', 'tg:1', '500'),
    ).toMatchObject({
      job_id: 'job_001',
      thread_id: 'topic_1',
    });

    expect(
      pruneExpiredRuntimeBackendCardContexts('2026-04-04T10:00:00.000Z'),
    ).toBe(1);
    expect(
      getRuntimeBackendCardContext('andrea_openai', 'tg:1', '500'),
    ).toBeUndefined();
  });

  it('tracks current runtime selection per chat', () => {
    upsertRuntimeBackendChatSelection({
      backend_id: 'andrea_openai',
      chat_jid: 'tg:1',
      job_id: 'job_001',
      group_folder: 'main',
      updated_at: '2026-04-03T10:00:00.000Z',
    });

    expect(getRuntimeBackendChatSelection('andrea_openai', 'tg:1')).toMatchObject({
      job_id: 'job_001',
      group_folder: 'main',
    });

    upsertRuntimeBackendChatSelection({
      backend_id: 'andrea_openai',
      chat_jid: 'tg:1',
      job_id: 'job_002',
      group_folder: 'main',
      updated_at: '2026-04-03T11:00:00.000Z',
    });

    expect(getRuntimeBackendChatSelection('andrea_openai', 'tg:1')?.job_id).toBe(
      'job_002',
    );

    deleteRuntimeBackendChatSelection('andrea_openai', 'tg:1');
    expect(getRuntimeBackendChatSelection('andrea_openai', 'tg:1')).toBeUndefined();
  });

  it('deletes individual runtime card contexts when a specific card becomes stale', () => {
    upsertRuntimeBackendCardContext({
      backend_id: 'andrea_openai',
      chat_jid: 'tg:1',
      message_id: '501',
      job_id: 'job_003',
      group_folder: 'main',
      thread_id: null,
      created_at: '2026-04-03T10:00:00.000Z',
      expires_at: '2026-04-04T10:00:00.000Z',
    });

    deleteRuntimeBackendCardContext('andrea_openai', 'tg:1', '501');
    expect(
      getRuntimeBackendCardContext('andrea_openai', 'tg:1', '501'),
    ).toBeUndefined();
  });
});
