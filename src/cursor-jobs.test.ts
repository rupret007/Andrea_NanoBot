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
  delete process.env.CURSOR_DESKTOP_BRIDGE_URL;
  delete process.env.CURSOR_DESKTOP_BRIDGE_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_BASE_URL;
  delete process.env.CURSOR_API_TIMEOUT_MS;
  delete process.env.CURSOR_MAX_ACTIVE_JOBS_PER_CHAT;
  delete process.env.CURSOR_DESKTOP_BRIDGE_URL;
  delete process.env.CURSOR_DESKTOP_BRIDGE_TOKEN;
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

  it('uses the desktop bridge when configured for create/sync/followup/stop', async () => {
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_BASE_URL;
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(`${init?.method || 'GET'} ${String(input)}`);
      const url = String(input);

      if (url === 'https://cursor-bridge.example.com/v1/sessions') {
        return new Response(
          JSON.stringify({
            id: 'desk_900',
            status: 'RUNNING',
            promptText: 'Implement the login fix',
            provider: 'desktop',
            createdAt: '2026-03-29T20:20:00.000Z',
            updatedAt: '2026-03-29T20:20:00.000Z',
          }),
          { status: 200 },
        );
      }

      if (url === 'https://cursor-bridge.example.com/v1/sessions/desk_900') {
        return new Response(
          JSON.stringify({
            id: 'desk_900',
            status: 'COMPLETED',
            promptText: 'Implement the login fix',
            summary: 'Patched the login flow.',
            provider: 'desktop',
            cursorSessionId: 'cursor-session-900',
            createdAt: '2026-03-29T20:20:00.000Z',
            updatedAt: '2026-03-29T20:21:00.000Z',
          }),
          { status: 200 },
        );
      }

      if (
        url ===
        'https://cursor-bridge.example.com/v1/sessions/desk_900/followup'
      ) {
        return new Response(
          JSON.stringify({
            id: 'desk_900',
            status: 'RUNNING',
            promptText: 'Implement the login fix',
            summary: 'Follow-up queued.',
            provider: 'desktop',
            cursorSessionId: 'cursor-session-900',
            createdAt: '2026-03-29T20:20:00.000Z',
            updatedAt: '2026-03-29T20:22:00.000Z',
          }),
          { status: 200 },
        );
      }

      if (
        url === 'https://cursor-bridge.example.com/v1/sessions/desk_900/stop'
      ) {
        return new Response(
          JSON.stringify({
            id: 'desk_900',
            status: 'STOPPED',
            promptText: 'Implement the login fix',
            summary: 'Stopped.',
            provider: 'desktop',
            cursorSessionId: 'cursor-session-900',
            createdAt: '2026-03-29T20:20:00.000Z',
            updatedAt: '2026-03-29T20:23:00.000Z',
          }),
          { status: 200 },
        );
      }

      throw new Error(`unexpected desktop bridge request: ${url}`);
    }) as typeof fetch;

    const created = await createCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      promptText: 'Implement the login fix',
    });
    expect(created.id).toBe('desk_900');

    const synced = await syncCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'desk_900',
    });
    expect(synced.agent.summary).toContain('Patched');
    expect(synced.artifacts).toHaveLength(0);

    const followed = await followupCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'desk_900',
      promptText: 'Add tests too',
    });
    expect(followed.summary).toContain('Follow-up');

    const stopped = await stopCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'desk_900',
    });
    expect(stopped.status).toBe('STOPPED');

    expect(requests).toEqual([
      'POST https://cursor-bridge.example.com/v1/sessions',
      'GET https://cursor-bridge.example.com/v1/sessions/desk_900',
      'POST https://cursor-bridge.example.com/v1/sessions/desk_900/followup',
      'POST https://cursor-bridge.example.com/v1/sessions/desk_900/stop',
    ]);
  });

  it('reads desktop bridge conversation for tracked desktop sessions', async () => {
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_BASE_URL;
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    upsertCursorAgent({
      id: 'desk_convo',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'COMPLETED',
      model: null,
      prompt_text: 'Initial desktop prompt',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: null,
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: 'Done',
      raw_json: JSON.stringify({ provider: 'desktop' }),
      created_by: 'tg:user',
      created_at: '2026-03-29T20:00:00.000Z',
      updated_at: '2026-03-29T20:00:00.000Z',
      last_synced_at: '2026-03-29T20:00:00.000Z',
    });

    globalThis.fetch = (async (_input) =>
      new Response(
        JSON.stringify({
          messages: [
            {
              role: 'user',
              content: 'Initial desktop prompt',
              createdAt: '2026-03-29T20:00:00.000Z',
            },
            {
              role: 'assistant',
              content: 'Done',
              createdAt: '2026-03-29T20:01:00.000Z',
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const messages = await getCursorAgentConversation({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'desk_convo',
      limit: 10,
    });

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Done');
  });
});
