import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  replaceCursorAgentArtifacts,
  upsertCursorAgent,
} from './db.js';
import {
  createCursorAgent,
  followupCursorAgent,
  getCursorArtifactDownloadLink,
  getCursorAgentConversation,
  listCursorModels,
  listStoredCursorArtifacts,
  listStoredCursorAgentsForGroup,
  stopCursorAgent,
  syncCursorAgent,
} from './cursor-jobs.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _initTestDatabase();
  process.env.CURSOR_API_KEY = 'cursor-test-key';
  process.env.CURSOR_API_BASE_URL = 'https://api.cursor.com';
  process.env.CURSOR_API_TIMEOUT_MS = '5000';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_BASE_URL;
  delete process.env.CURSOR_API_TIMEOUT_MS;
  delete process.env.CURSOR_MAX_ACTIVE_JOBS_PER_CHAT;
});

describe('cursor-jobs', () => {
  it('creates and stores a new cursor agent', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'bc_100',
          status: 'CREATING',
          source: {
            repository: 'https://github.com/example/repo',
            ref: 'main',
          },
          target: {
            url: 'https://cursor.com/agents?id=bc_100',
          },
          createdAt: '2026-03-28T18:10:00.000Z',
        }),
        { status: 200 },
      )) as typeof fetch;

    const created = await createCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      promptText: 'Add a README',
      requestedBy: 'tg:user',
      sourceRepository: 'https://github.com/example/repo',
      sourceRef: 'main',
    });

    expect(created.id).toBe('bc_100');
    expect(created.groupFolder).toBe('whatsapp_main');

    const stored = listStoredCursorAgentsForGroup('whatsapp_main');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('bc_100');
  });

  it('syncs cursor agent status and artifacts', async () => {
    upsertCursorAgent({
      id: 'bc_200',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: 'default',
      prompt_text: 'Do work',
      source_repository: 'https://github.com/example/repo',
      source_ref: 'main',
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_200',
      target_pr_url: null,
      target_branch_name: 'cursor/work',
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: null,
    });

    let callIndex = 0;
    globalThis.fetch = (async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            id: 'bc_200',
            status: 'FINISHED',
            summary: 'Completed',
            source: {
              repository: 'https://github.com/example/repo',
              ref: 'main',
            },
            target: {
              url: 'https://cursor.com/agents?id=bc_200',
            },
            createdAt: '2026-03-28T18:00:00.000Z',
            updatedAt: '2026-03-28T18:20:00.000Z',
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          artifacts: [
            {
              absolutePath: '/opt/cursor/artifacts/result.md',
              sizeBytes: 321,
              updatedAt: '2026-03-28T18:19:00.000Z',
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const synced = await syncCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_200',
    });

    expect(synced.agent.status).toBe('FINISHED');
    expect(synced.artifacts).toHaveLength(1);
    expect(synced.artifacts[0].absolutePath).toContain('result.md');
  });

  it('supports followup and stop for tracked agents', async () => {
    upsertCursorAgent({
      id: 'bc_300',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: 'default',
      prompt_text: 'Initial prompt',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_300',
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: null,
    });

    let phase: 'followup' | 'stop' = 'followup';
    globalThis.fetch = (async () => {
      if (phase === 'followup') {
        phase = 'stop';
        return new Response(
          JSON.stringify({
            id: 'bc_300',
            status: 'RUNNING',
            summary: 'Followup accepted',
            target: { url: 'https://cursor.com/agents?id=bc_300' },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'bc_300',
          status: 'STOPPED',
          summary: 'Stopped',
          target: { url: 'https://cursor.com/agents?id=bc_300' },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const followup = await followupCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_300',
      promptText: 'Continue with tests',
    });
    expect(followup.summary).toContain('Followup');

    const stopped = await stopCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_300',
    });
    expect(stopped.status).toBe('STOPPED');
  });

  it('enforces per-chat active job guardrail before creating new agent', async () => {
    process.env.CURSOR_MAX_ACTIVE_JOBS_PER_CHAT = '1';
    upsertCursorAgent({
      id: 'bc_guardrail',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: 'default',
      prompt_text: 'Existing active work',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: null,
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: null,
    });

    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called when guardrail blocks');
    }) as typeof fetch;

    await expect(
      createCursorAgent({
        groupFolder: 'whatsapp_main',
        chatJid: 'tg:42',
        promptText: 'Try to create one more',
      }),
    ).rejects.toThrow('Cursor job limit reached for this chat');
  });

  it('fetches cursor conversation for a tracked agent', async () => {
    upsertCursorAgent({
      id: 'bc_convo',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: 'default',
      prompt_text: 'Initial prompt',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: null,
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: null,
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              role: 'user',
              content: 'First',
              createdAt: '2026-03-28T18:01:00.000Z',
            },
            {
              role: 'assistant',
              content: 'Second',
              createdAt: '2026-03-28T18:02:00.000Z',
            },
            {
              role: 'user',
              content: 'Third',
              createdAt: '2026-03-28T18:03:00.000Z',
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const messages = await getCursorAgentConversation({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_convo',
      limit: 2,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Second');
    expect(messages[1].content).toBe('Third');
  });

  it('accepts cursor URL input when syncing tracked agents', async () => {
    upsertCursorAgent({
      id: 'bc_url',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: 'default',
      prompt_text: 'Do work',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_url',
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: null,
    });

    let callIndex = 0;
    globalThis.fetch = (async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            id: 'bc_url',
            status: 'FINISHED',
            target: { url: 'https://cursor.com/agents?id=bc_url' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
    }) as typeof fetch;

    const synced = await syncCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'https://cursor.com/agents?id=bc_url',
    });
    expect(synced.agent.id).toBe('bc_url');
  });

  it('lists Cursor models through the cloud client and dedupes ids', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'cu/default', name: 'Cursor Default' },
            { id: 'cu/default', name: 'Duplicate' },
            { id: 'cu/fast' },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const models = await listCursorModels(10);
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('cu/default');
    expect(models[1].id).toBe('cu/fast');
  });

  it('normalizes stored artifact lookups from cursor URLs', () => {
    expect(() =>
      listStoredCursorArtifacts('https://cursor.com/agents?id=bad id'),
    ).toThrow('Invalid Cursor agent id');
  });

  it('gets a cursor artifact download link for a tracked artifact', async () => {
    upsertCursorAgent({
      id: 'bc_artifact',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'FINISHED',
      model: 'default',
      prompt_text: 'Create release notes',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_artifact',
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: '2026-03-28T18:00:00.000Z',
    });
    replaceCursorAgentArtifacts('bc_artifact', [
      {
        agent_id: 'bc_artifact',
        absolute_path: '/opt/cursor/out/release-notes.md',
        size_bytes: 200,
        updated_at: '2026-03-28T18:20:00.000Z',
        download_url: null,
        download_url_expires_at: null,
        synced_at: '2026-03-28T18:20:00.000Z',
      },
    ]);

    let requestUrl = '';
    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return new Response(
        JSON.stringify({
          url: 'https://download.cursor.com/file?id=abc',
          expiresAt: '2026-03-28T19:20:00.000Z',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const link = await getCursorArtifactDownloadLink({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'https://cursor.com/agents?id=bc_artifact',
      absolutePath: '/opt/cursor/out/release-notes.md',
    });

    expect(link.agentId).toBe('bc_artifact');
    expect(link.url).toBe('https://download.cursor.com/file?id=abc');
    expect(link.expiresAt).toBe('2026-03-28T19:20:00.000Z');
    expect(requestUrl).toContain('/v0/agents/bc_artifact/artifacts/download');
    expect(requestUrl).toContain(
      'path=%2Fopt%2Fcursor%2Fout%2Frelease-notes.md',
    );
  });

  it('rejects artifact download links for untracked artifact paths', async () => {
    upsertCursorAgent({
      id: 'bc_missing_artifact',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'FINISHED',
      model: 'default',
      prompt_text: 'Build summary',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: null,
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: null,
      created_by: 'tg:user',
      created_at: '2026-03-28T18:00:00.000Z',
      updated_at: '2026-03-28T18:00:00.000Z',
      last_synced_at: null,
    });

    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called for untracked artifact');
    }) as typeof fetch;

    await expect(
      getCursorArtifactDownloadLink({
        groupFolder: 'whatsapp_main',
        chatJid: 'tg:42',
        agentId: 'bc_missing_artifact',
        absolutePath: '/opt/cursor/out/not-present.md',
      }),
    ).rejects.toThrow('is not tracked for Cursor agent');
  });
});
