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
  getCursorAgentArtifacts,
  getCursorAgentConversation,
  getCursorTerminalOutput,
  getCursorTerminalStatus,
  listCursorJobInventory,
  listCursorModels,
  listStoredCursorArtifacts,
  listStoredCursorAgentsForGroup,
  runCursorTerminalCommand,
  stopCursorTerminal,
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

  it('refreshes Cloud agent status when followup response omits it', async () => {
    upsertCursorAgent({
      id: 'bc_301',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'FINISHED',
      model: 'default',
      prompt_text: 'Initial prompt',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_301',
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

    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            id: 'bc_301',
            summary: 'Followup accepted',
            target: { url: 'https://cursor.com/agents?id=bc_301' },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'bc_301',
          status: 'RUNNING',
          summary: 'Followup accepted',
          target: { url: 'https://cursor.com/agents?id=bc_301' },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const followup = await followupCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_301',
      promptText: 'Continue with tests',
    });

    expect(followup.status).toBe('RUNNING');
    expect(requests).toEqual([
      'https://api.cursor.com/v0/agents/bc_301/followup',
      'https://api.cursor.com/v0/agents/bc_301',
    ]);
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

  it('uses text/type fallback when cloud conversation content is empty', async () => {
    upsertCursorAgent({
      id: 'bc_convo_text',
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
              type: 'user_message',
              text: 'First',
              role: 'assistant',
              content: '',
              createdAt: '2026-03-28T18:01:00.000Z',
            },
            {
              type: 'assistant_message',
              text: 'Second',
              content: '',
              createdAt: '2026-03-28T18:02:00.000Z',
            },
            {
              type: 'assistant_message',
              text: 'Third',
              content: '',
              createdAt: '2026-03-28T18:03:00.000Z',
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const messages = await getCursorAgentConversation({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_convo_text',
      limit: 3,
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'First',
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Third',
    });
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

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === 'https://api.cursor.com/v0/agents/bc_missing_artifact') {
        return new Response(
          JSON.stringify({
            id: 'bc_missing_artifact',
            status: 'FINISHED',
            target: { url: 'https://cursor.com/agents?id=bc_missing_artifact' },
            createdAt: '2026-03-28T18:00:00.000Z',
            updatedAt: '2026-03-28T18:01:00.000Z',
          }),
          { status: 200 },
        );
      }

      if (
        url === 'https://api.cursor.com/v0/agents/bc_missing_artifact/artifacts'
      ) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }

      throw new Error(`unexpected request for untracked artifact: ${url}`);
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

  it('requires Cursor Cloud for queued job creation even when only the desktop bridge is configured', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    globalThis.fetch = (async () => {
      throw new Error('desktop bridge should not be used for create');
    }) as typeof fetch;

    await expect(
      createCursorAgent({
        groupFolder: 'whatsapp_main',
        chatJid: 'tg:42',
        promptText: 'Implement the login fix',
      }),
    ).rejects.toThrow('Cursor Cloud is required for queued coding jobs');
  });

  it('creates Cursor Cloud jobs even when the desktop bridge is also configured', async () => {
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method || 'GET'} ${url}`);

      if (url === 'https://api.cursor.com/v0/agents') {
        return new Response(
          JSON.stringify({
            id: 'bc_create',
            status: 'CREATING',
            target: {
              url: 'https://cursor.com/agents?id=bc_create',
            },
            createdAt: '2026-03-29T20:24:00.000Z',
          }),
          { status: 200 },
        );
      }

      throw new Error(`unexpected fallback request: ${url}`);
    }) as typeof fetch;

    const created = await createCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      promptText: 'Create through Cloud even when desktop bridge exists',
      sourceRepository: 'https://github.com/example/repo',
    });

    expect(created.id).toBe('bc_create');
    expect(created.provider).toBe('cloud');
    expect(requests).toEqual(['POST https://api.cursor.com/v0/agents']);
  });

  it('reads desktop bridge conversation for tracked desktop sessions', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
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

  it('rejects Cloud follow-up and stop flows for tracked desktop sessions', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    upsertCursorAgent({
      id: 'desk_control',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'COMPLETED',
      model: null,
      prompt_text: 'Desktop-only work',
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

    await expect(
      followupCursorAgent({
        groupFolder: 'whatsapp_main',
        chatJid: 'tg:42',
        agentId: 'desk_control',
        promptText: 'Continue the desktop session',
      }),
    ).rejects.toThrow('queued Cloud follow-up flow');

    await expect(
      stopCursorAgent({
        groupFolder: 'whatsapp_main',
        chatJid: 'tg:42',
        agentId: 'desk_control',
      }),
    ).rejects.toThrow('queued Cloud stop flow');
  });

  it('recovers an existing untracked desktop session on sync', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(
        'https://cursor-bridge.example.com/v1/sessions/desk_recover',
      );
      return new Response(
        JSON.stringify({
          id: 'desk_recover',
          status: 'COMPLETED',
          promptText: 'Recover the current refactor',
          groupFolder: 'main',
          chatJid: 'tg:42',
          summary: 'Recovered from bridge state.',
          provider: 'desktop',
          cursorSessionId: 'cursor-session-recover',
          createdAt: '2026-03-29T20:30:00.000Z',
          updatedAt: '2026-03-29T20:31:00.000Z',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const synced = await syncCursorAgent({
      groupFolder: 'main',
      chatJid: 'tg:42',
      agentId: 'desk_recover',
    });

    expect(synced.agent.id).toBe('desk_recover');
    expect(synced.agent.provider).toBe('desktop');
    expect(synced.agent.summary).toContain('Recovered');

    const stored = listStoredCursorAgentsForGroup('main');
    expect(stored.some((agent) => agent.id === 'desk_recover')).toBe(true);
  });

  it('rejects recovering a desktop session that belongs to another workspace', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'desk_other',
          status: 'RUNNING',
          promptText: 'Other workspace work',
          groupFolder: 'ops',
          chatJid: 'tg:99',
          provider: 'desktop',
          createdAt: '2026-03-29T20:30:00.000Z',
          updatedAt: '2026-03-29T20:31:00.000Z',
        }),
        { status: 200 },
      )) as typeof fetch;

    await expect(
      syncCursorAgent({
        groupFolder: 'main',
        chatJid: 'tg:42',
        agentId: 'desk_other',
      }),
    ).rejects.toThrow('belongs to another workspace');
  });

  it('recovers an existing untracked cloud agent on sync', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === 'https://api.cursor.com/v0/agents/bc_recover') {
        return new Response(
          JSON.stringify({
            id: 'bc_recover',
            name: 'Recovered cloud job',
            status: 'RUNNING',
            target: { url: 'https://cursor.com/agents?id=bc_recover' },
            createdAt: '2026-03-29T20:40:00.000Z',
            updatedAt: '2026-03-29T20:41:00.000Z',
          }),
          { status: 200 },
        );
      }

      if (url === 'https://api.cursor.com/v0/agents/bc_recover/artifacts') {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }

      throw new Error(`unexpected cloud recovery request: ${url}`);
    }) as typeof fetch;

    const synced = await syncCursorAgent({
      groupFolder: 'whatsapp_main',
      chatJid: 'tg:42',
      agentId: 'bc_recover',
    });

    expect(synced.agent.id).toBe('bc_recover');
    expect(synced.agent.provider).toBe('cloud');
    expect(synced.agent.promptText).toContain('Recovered');
  });

  it('lists recoverable desktop sessions alongside tracked jobs', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    upsertCursorAgent({
      id: 'desk_tracked',
      group_folder: 'main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: null,
      prompt_text: 'Tracked work',
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
      raw_json: JSON.stringify({ provider: 'desktop' }),
      created_by: 'tg:user',
      created_at: '2026-03-29T20:00:00.000Z',
      updated_at: '2026-03-29T20:00:00.000Z',
      last_synced_at: null,
    });

    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(
        'https://cursor-bridge.example.com/v1/sessions?limit=20',
      );
      return new Response(
        JSON.stringify({
          sessions: [
            {
              id: 'desk_tracked',
              status: 'RUNNING',
              promptText: 'Tracked work',
              groupFolder: 'main',
              chatJid: 'tg:42',
              provider: 'desktop',
              createdAt: '2026-03-29T20:00:00.000Z',
              updatedAt: '2026-03-29T20:01:00.000Z',
            },
            {
              id: 'desk_recoverable',
              status: 'COMPLETED',
              promptText: 'Existing bridge session',
              groupFolder: 'main',
              chatJid: 'tg:42',
              provider: 'desktop',
              createdAt: '2026-03-29T20:02:00.000Z',
              updatedAt: '2026-03-29T20:03:00.000Z',
            },
            {
              id: 'desk_other_group',
              status: 'COMPLETED',
              promptText: 'Other group session',
              groupFolder: 'ops',
              chatJid: 'tg:99',
              provider: 'desktop',
              createdAt: '2026-03-29T20:04:00.000Z',
              updatedAt: '2026-03-29T20:05:00.000Z',
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const inventory = await listCursorJobInventory({
      groupFolder: 'main',
      chatJid: 'tg:42',
      limit: 20,
    });

    expect(inventory.hasDesktop).toBe(true);
    expect(inventory.hasCloud).toBe(false);
    expect(inventory.desktopTracked).toHaveLength(1);
    expect(inventory.desktopRecoverable).toHaveLength(1);
    expect(inventory.desktopRecoverable[0].id).toBe('desk_recoverable');
  });

  it('lists recoverable jobs from both desktop bridge and cloud when both are configured', async () => {
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === 'https://cursor-bridge.example.com/v1/sessions?limit=20') {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: 'desk_recoverable',
                status: 'COMPLETED',
                promptText: 'Existing bridge session',
                groupFolder: 'main',
                chatJid: 'tg:42',
                provider: 'desktop',
                createdAt: '2026-03-29T20:02:00.000Z',
                updatedAt: '2026-03-29T20:03:00.000Z',
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url === 'https://api.cursor.com/v0/agents?limit=20') {
        return new Response(
          JSON.stringify({
            agents: [
              {
                id: 'bc_recoverable',
                name: 'Recovered cloud job',
                status: 'RUNNING',
                target: { url: 'https://cursor.com/agents?id=bc_recoverable' },
                createdAt: '2026-03-29T20:40:00.000Z',
                updatedAt: '2026-03-29T20:41:00.000Z',
              },
            ],
          }),
          { status: 200 },
        );
      }

      throw new Error(`unexpected mixed inventory request: ${url}`);
    }) as typeof fetch;

    const inventory = await listCursorJobInventory({
      groupFolder: 'main',
      chatJid: 'tg:42',
      limit: 20,
    });

    expect(inventory.hasDesktop).toBe(true);
    expect(inventory.hasCloud).toBe(true);
    expect(inventory.desktopRecoverable).toHaveLength(1);
    expect(inventory.cloudRecoverable).toHaveLength(1);
    expect(inventory.desktopRecoverable[0].id).toBe('desk_recoverable');
    expect(inventory.cloudRecoverable[0].id).toBe('bc_recoverable');
  });

  it('rejects artifact listing for desktop sessions with a Cloud-only message', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    upsertCursorAgent({
      id: 'desk_artifacts',
      group_folder: 'main',
      chat_jid: 'tg:42',
      status: 'COMPLETED',
      model: null,
      prompt_text: 'Desktop artifact check',
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

    await expect(
      getCursorAgentArtifacts({
        groupFolder: 'main',
        chatJid: 'tg:42',
        agentId: 'desk_artifacts',
      }),
    ).rejects.toThrow('Cursor artifact listing is only available');
  });

  it('runs terminal commands for desktop sessions and reads terminal state', async () => {
    process.env.CURSOR_API_KEY = ' ';
    process.env.CURSOR_API_BASE_URL = ' ';
    process.env.CURSOR_DESKTOP_BRIDGE_URL = 'https://cursor-bridge.example.com';
    process.env.CURSOR_DESKTOP_BRIDGE_TOKEN = 'bridge-token';

    upsertCursorAgent({
      id: 'desk_term',
      group_folder: 'main',
      chat_jid: 'tg:42',
      status: 'COMPLETED',
      model: null,
      prompt_text: 'Desktop terminal work',
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
      raw_json: JSON.stringify({ provider: 'desktop', cwd: '/repo' }),
      created_by: 'tg:user',
      created_at: '2026-03-29T20:00:00.000Z',
      updated_at: '2026-03-29T20:00:00.000Z',
      last_synced_at: '2026-03-29T20:00:00.000Z',
    });

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (
        url ===
          'https://cursor-bridge.example.com/v1/sessions/desk_term/terminal/command' &&
        init?.method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            commandId: 'term_1',
            terminal: {
              available: true,
              status: 'RUNNING',
              shell: '/bin/zsh',
              cwd: '/repo',
              lastCommand: 'git status',
              activeCommandId: 'term_1',
              lastCompletedCommandId: null,
              lastExitCode: null,
              lastStartedAt: '2026-03-29T20:01:00.000Z',
              lastFinishedAt: null,
              activePid: 777,
              outputLineCount: 1,
            },
          }),
          { status: 200 },
        );
      }

      if (
        url ===
          'https://cursor-bridge.example.com/v1/sessions/desk_term/terminal' &&
        init?.method === 'GET'
      ) {
        return new Response(
          JSON.stringify({
            available: true,
            status: 'IDLE',
            shell: '/bin/zsh',
            cwd: '/repo',
            lastCommand: 'git status',
            activeCommandId: null,
            lastCompletedCommandId: 'term_1',
            lastExitCode: 0,
            lastStartedAt: '2026-03-29T20:01:00.000Z',
            lastFinishedAt: '2026-03-29T20:01:01.000Z',
            activePid: null,
            outputLineCount: 3,
          }),
          { status: 200 },
        );
      }

      if (
        url ===
          'https://cursor-bridge.example.com/v1/sessions/desk_term/terminal/output?limit=60&commandId=term_1' &&
        init?.method === 'GET'
      ) {
        return new Response(
          JSON.stringify({
            lines: [
              {
                commandId: 'term_1',
                stream: 'system',
                text: '$ git status',
                createdAt: '2026-03-29T20:01:00.000Z',
              },
              {
                commandId: 'term_1',
                stream: 'stdout',
                text: 'On branch main',
                createdAt: '2026-03-29T20:01:01.000Z',
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (
        url ===
          'https://cursor-bridge.example.com/v1/sessions/desk_term/terminal/output?limit=20' &&
        init?.method === 'GET'
      ) {
        return new Response(
          JSON.stringify({
            lines: [
              {
                commandId: 'term_1',
                stream: 'stdout',
                text: 'On branch main',
                createdAt: '2026-03-29T20:01:01.000Z',
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (
        url ===
          'https://cursor-bridge.example.com/v1/sessions/desk_term/terminal/stop' &&
        init?.method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            available: true,
            status: 'STOPPED',
            shell: '/bin/zsh',
            cwd: '/repo',
            lastCommand: 'npm test',
            activeCommandId: null,
            lastCompletedCommandId: 'term_2',
            lastExitCode: null,
            lastStartedAt: '2026-03-29T20:02:00.000Z',
            lastFinishedAt: '2026-03-29T20:02:05.000Z',
            activePid: null,
            outputLineCount: 5,
          }),
          { status: 200 },
        );
      }

      throw new Error(`unexpected desktop terminal request: ${url}`);
    }) as typeof fetch;

    const started = await runCursorTerminalCommand({
      groupFolder: 'main',
      chatJid: 'tg:42',
      agentId: 'desk_term',
      commandText: 'git status',
    });
    expect(started.commandId).toBe('term_1');
    expect(started.terminal.status).toBe('IDLE');
    expect(started.output[1].text).toContain('On branch main');

    const status = await getCursorTerminalStatus({
      groupFolder: 'main',
      chatJid: 'tg:42',
      agentId: 'desk_term',
    });
    expect(status.lastExitCode).toBe(0);

    const output = await getCursorTerminalOutput({
      groupFolder: 'main',
      chatJid: 'tg:42',
      agentId: 'desk_term',
      limit: 20,
    });
    expect(output).toHaveLength(1);

    const stopped = await stopCursorTerminal({
      groupFolder: 'main',
      chatJid: 'tg:42',
      agentId: 'desk_term',
    });
    expect(stopped.status).toBe('STOPPED');
  });

  it('rejects terminal control for cloud-backed agents', async () => {
    upsertCursorAgent({
      id: 'bc_term_cloud',
      group_folder: 'whatsapp_main',
      chat_jid: 'tg:42',
      status: 'RUNNING',
      model: 'default',
      prompt_text: 'Cloud job',
      source_repository: null,
      source_ref: null,
      source_pr_url: null,
      target_url: 'https://cursor.com/agents?id=bc_term_cloud',
      target_pr_url: null,
      target_branch_name: null,
      auto_create_pr: 0,
      open_as_cursor_github_app: 0,
      skip_reviewer_request: 0,
      summary: null,
      raw_json: JSON.stringify({ provider: 'cloud' }),
      created_by: 'tg:user',
      created_at: '2026-03-29T20:00:00.000Z',
      updated_at: '2026-03-29T20:00:00.000Z',
      last_synced_at: null,
    });

    await expect(
      runCursorTerminalCommand({
        groupFolder: 'whatsapp_main',
        chatJid: 'tg:42',
        agentId: 'bc_term_cloud',
        commandText: 'pwd',
      }),
    ).rejects.toThrow('desktop bridge sessions');
  });
});
