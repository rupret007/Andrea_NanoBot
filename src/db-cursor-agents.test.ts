import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getCursorAgentById,
  listCursorAgentArtifacts,
  listCursorAgentEvents,
  listCursorAgentsForGroup,
  recordCursorAgentEvent,
  replaceCursorAgentArtifacts,
  upsertCursorAgent,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

function seedCursorAgent(status = 'CREATING'): void {
  upsertCursorAgent({
    id: 'bc_123',
    group_folder: 'whatsapp_main',
    chat_jid: 'tg:1',
    status,
    model: 'default',
    prompt_text: 'Create docs',
    source_repository: 'https://github.com/example/repo',
    source_ref: 'main',
    source_pr_url: null,
    target_url: 'https://cursor.com/agents?id=bc_123',
    target_pr_url: null,
    target_branch_name: 'cursor/create-docs',
    auto_create_pr: 1,
    open_as_cursor_github_app: 0,
    skip_reviewer_request: 0,
    summary: null,
    raw_json: '{"id":"bc_123"}',
    created_by: 'tg:owner',
    created_at: '2026-03-28T18:00:00.000Z',
    updated_at: '2026-03-28T18:00:00.000Z',
    last_synced_at: '2026-03-28T18:00:01.000Z',
  });
}

describe('cursor agent accessors', () => {
  it('upserts and fetches cursor agents', () => {
    seedCursorAgent('RUNNING');

    const row = getCursorAgentById('bc_123');
    expect(row).toBeDefined();
    expect(row?.status).toBe('RUNNING');
    expect(row?.group_folder).toBe('whatsapp_main');
  });

  it('lists cursor agents by group newest-first', () => {
    seedCursorAgent('RUNNING');
    upsertCursorAgent({
      id: 'bc_456',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:1',
      status: 'FINISHED',
      model: 'default',
      prompt_text: 'Create changelog',
      source_repository: 'https://github.com/example/repo',
      source_ref: 'main',
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_456',
      target_pr_url: null,
      target_branch_name: 'cursor/changelog',
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: 'Completed',
      raw_json: '{"id":"bc_456"}',
      created_by: 'tg:owner',
      created_at: '2026-03-28T18:05:00.000Z',
      updated_at: '2026-03-28T18:05:00.000Z',
      last_synced_at: '2026-03-28T18:05:01.000Z',
    });

    const rows = listCursorAgentsForGroup('whatsapp_main');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('bc_456');
    expect(rows[1].id).toBe('bc_123');
  });
});

describe('cursor artifact accessors', () => {
  it('replaces artifacts for an agent atomically', () => {
    seedCursorAgent();

    replaceCursorAgentArtifacts('bc_123', [
      {
        agent_id: 'bc_123',
        absolute_path: '/opt/cursor/artifacts/screenshot.png',
        size_bytes: 12_345,
        updated_at: '2026-03-28T18:01:00.000Z',
        download_url: null,
        download_url_expires_at: null,
        synced_at: '2026-03-28T18:01:10.000Z',
      },
    ]);

    let artifacts = listCursorAgentArtifacts('bc_123');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].absolute_path).toContain('screenshot.png');

    replaceCursorAgentArtifacts('bc_123', [
      {
        agent_id: 'bc_123',
        absolute_path: '/opt/cursor/artifacts/output.md',
        size_bytes: 777,
        updated_at: '2026-03-28T18:02:00.000Z',
        download_url: null,
        download_url_expires_at: null,
        synced_at: '2026-03-28T18:02:10.000Z',
      },
    ]);

    artifacts = listCursorAgentArtifacts('bc_123');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].absolute_path).toContain('output.md');
  });
});

describe('cursor webhook/event accessors', () => {
  it('deduplicates events by webhook id', () => {
    seedCursorAgent();

    const first = recordCursorAgentEvent({
      agent_id: 'bc_123',
      event_type: 'statusChange',
      status: 'FINISHED',
      summary: 'Done',
      webhook_id: 'wh_abc',
      payload_json: '{"event":"statusChange"}',
      received_at: '2026-03-28T18:03:00.000Z',
    });
    const second = recordCursorAgentEvent({
      agent_id: 'bc_123',
      event_type: 'statusChange',
      status: 'FINISHED',
      summary: 'Done duplicate',
      webhook_id: 'wh_abc',
      payload_json: '{"event":"statusChange"}',
      received_at: '2026-03-28T18:03:01.000Z',
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(listCursorAgentEvents('bc_123')).toHaveLength(1);
  });
});
