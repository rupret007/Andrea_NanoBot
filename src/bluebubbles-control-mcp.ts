import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { readEnvFile } from './env.js';
import type {
  BlueBubblesControlMcpConfig,
  BlueBubblesExecuteMessageActionRequest,
} from './types.js';

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function toNullableString(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function resolveMcpMessageActionOperation(
  value: unknown,
): BlueBubblesExecuteMessageActionRequest['operation'] {
  if (
    value === 'defer' ||
    value === 'remind_instead' ||
    value === 'save_to_thread'
  ) {
    return value;
  }
  throw new Error(
    'BlueBubbles MCP cannot execute send or send_again. Use a fresh owner-authored approval in Telegram or the configured Messages self-thread.',
  );
}

function toTextResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function resolveBlueBubblesControlMcpConfig(
  env = readEnvFile([
    'BLUEBUBBLES_CONTROL_BASE_URL',
    'BLUEBUBBLES_CONTROL_TOKEN',
  ]),
): BlueBubblesControlMcpConfig {
  const baseUrl = normalizeBaseUrl(
    process.env.BLUEBUBBLES_CONTROL_BASE_URL ||
      env.BLUEBUBBLES_CONTROL_BASE_URL,
  );
  const token =
    process.env.BLUEBUBBLES_CONTROL_TOKEN ||
    env.BLUEBUBBLES_CONTROL_TOKEN ||
    '';
  if (!baseUrl) {
    throw new Error(
      'BLUEBUBBLES_CONTROL_BASE_URL is required to start the BlueBubbles MCP bridge.',
    );
  }
  if (!token.trim()) {
    throw new Error(
      'BLUEBUBBLES_CONTROL_TOKEN is required to start the BlueBubbles MCP bridge.',
    );
  }
  return {
    baseUrl,
    token,
  };
}

export class BlueBubblesControlClient {
  constructor(private readonly config: BlueBubblesControlMcpConfig) {}

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${this.config.baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const error =
        payload &&
        typeof payload === 'object' &&
        'error' in (payload as Record<string, unknown>)
          ? String((payload as Record<string, unknown>).error)
          : `BlueBubbles control request failed with ${response.status}`;
      throw new Error(error);
    }
    return payload;
  }

  async health(): Promise<unknown> {
    return this.request('GET', '/health');
  }

  async status(): Promise<unknown> {
    return this.request('GET', '/v1/bluebubbles/status');
  }

  async proof(): Promise<unknown> {
    return this.request('GET', '/v1/bluebubbles/proof');
  }

  async doctor(): Promise<unknown> {
    return this.request('GET', '/v1/bluebubbles/doctor');
  }

  async listChats(limit?: number): Promise<unknown> {
    const query = limit ? `?limit=${Math.max(1, Math.floor(limit))}` : '';
    return this.request('GET', `/v1/bluebubbles/chats${query}`);
  }

  async getMessages(chatJid: string, limit?: number): Promise<unknown> {
    const query = limit ? `?limit=${Math.max(1, Math.floor(limit))}` : '';
    return this.request(
      'GET',
      `/v1/bluebubbles/chats/${encodeURIComponent(chatJid)}/messages${query}`,
    );
  }

  async getMediaMetadata(attachmentId: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v1/bluebubbles/media/${encodeURIComponent(attachmentId)}/metadata`,
    );
  }

  async analyzeMedia(
    attachmentId: string,
    prompt?: string | null,
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/bluebubbles/media/${encodeURIComponent(attachmentId)}/analyze`,
      {
        prompt: toNullableString(prompt),
      },
    );
  }

  async openMessageActions(chatJid?: string | null): Promise<unknown> {
    const query = toNullableString(chatJid)
      ? `?chatJid=${encodeURIComponent(chatJid!.trim())}`
      : '';
    return this.request('GET', `/v1/bluebubbles/message-actions/open${query}`);
  }

  async refresh(
    mode?: 'transport' | 'webhook' | 'shadow' | 'all',
  ): Promise<unknown> {
    return this.request('POST', '/v1/bluebubbles/refresh', {
      mode: mode || 'all',
    });
  }

  async startProofDrill(chatJid?: string | null): Promise<unknown> {
    return this.request('POST', '/v1/bluebubbles/proof-drill/start', {
      chatJid: toNullableString(chatJid),
    });
  }

  async executeMessageAction(
    actionId: string,
    request: BlueBubblesExecuteMessageActionRequest,
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/bluebubbles/message-actions/${encodeURIComponent(actionId)}/execute`,
      request,
    );
  }
}

export function createBlueBubblesMcpToolHandlers(
  client: BlueBubblesControlClient,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    bluebubbles_status: async () => client.status(),
    bluebubbles_proof: async () => client.proof(),
    bluebubbles_doctor: async () => client.doctor(),
    bluebubbles_list_chats: async (args) =>
      client.listChats(typeof args.limit === 'number' ? args.limit : undefined),
    bluebubbles_get_messages: async (args) =>
      client.getMessages(
        String(args.chatJid || ''),
        typeof args.limit === 'number' ? args.limit : undefined,
      ),
    bluebubbles_get_media_metadata: async (args) =>
      client.getMediaMetadata(String(args.attachmentId || '')),
    bluebubbles_analyze_media: async (args) =>
      client.analyzeMedia(
        String(args.attachmentId || ''),
        typeof args.prompt === 'string' ? args.prompt : null,
      ),
    bluebubbles_open_message_actions: async (args) =>
      client.openMessageActions(
        typeof args.chatJid === 'string' ? args.chatJid : null,
      ),
    bluebubbles_refresh: async (args) =>
      client.refresh(
        args.mode === 'transport' ||
          args.mode === 'webhook' ||
          args.mode === 'shadow'
          ? args.mode
          : 'all',
      ),
    bluebubbles_start_proof_drill: async (args) =>
      client.startProofDrill(
        typeof args.chatJid === 'string' ? args.chatJid : null,
      ),
    bluebubbles_execute_message_action: async (args) =>
      client.executeMessageAction(String(args.actionId || ''), {
        operation: resolveMcpMessageActionOperation(args.operation),
        timingHint:
          typeof args.timingHint === 'string' ? args.timingHint : null,
      }),
  };
}

export async function startBlueBubblesControlMcpServer(): Promise<void> {
  const client = new BlueBubblesControlClient(
    resolveBlueBubblesControlMcpConfig(),
  );
  const handlers = createBlueBubblesMcpToolHandlers(client);

  const server = new McpServer({
    name: 'andrea-bluebubbles',
    version: '1.0.0',
  });

  server.tool(
    'bluebubbles_status',
    'Return the BlueBubbles control status for this host.',
    {},
    async () => toTextResult(await handlers.bluebubbles_status({})),
  );

  server.tool(
    'bluebubbles_proof',
    'Return the current BlueBubbles proof report and exact blocker.',
    {},
    async () => toTextResult(await handlers.bluebubbles_proof({})),
  );

  server.tool(
    'bluebubbles_doctor',
    'Return BlueBubbles blocker category, proof state, and exact next action.',
    {},
    async () => toTextResult(await handlers.bluebubbles_doctor({})),
  );

  server.tool(
    'bluebubbles_list_chats',
    'List recent BlueBubbles chats with reply-gate and activity context.',
    {
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => toTextResult(await handlers.bluebubbles_list_chats(args)),
  );

  server.tool(
    'bluebubbles_get_messages',
    'List recent messages for one BlueBubbles chat, including safe attachment metadata when present.',
    {
      chatJid: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => toTextResult(await handlers.bluebubbles_get_messages(args)),
  );

  server.tool(
    'bluebubbles_get_media_metadata',
    'Return safe metadata for one BlueBubbles media attachment without exposing raw bytes or local paths.',
    {
      attachmentId: z.string(),
    },
    async (args) =>
      toTextResult(await handlers.bluebubbles_get_media_metadata(args)),
  );

  server.tool(
    'bluebubbles_analyze_media',
    'Analyze one BlueBubbles image or video attachment through Andrea media analysis.',
    {
      attachmentId: z.string(),
      prompt: z.string().optional(),
    },
    async (args) =>
      toTextResult(await handlers.bluebubbles_analyze_media(args)),
  );

  server.tool(
    'bluebubbles_open_message_actions',
    'List open BlueBubbles message actions, with the active self-thread or recent direct 1:1 actions first.',
    {
      chatJid: z.string().optional(),
    },
    async (args) =>
      toTextResult(await handlers.bluebubbles_open_message_actions(args)),
  );

  server.tool(
    'bluebubbles_refresh',
    'Refresh BlueBubbles transport, webhook, and shadow truth.',
    {
      mode: z.enum(['transport', 'webhook', 'shadow', 'all']).optional(),
    },
    async (args) => toTextResult(await handlers.bluebubbles_refresh(args)),
  );

  server.tool(
    'bluebubbles_start_proof_drill',
    'Start the safe BlueBubbles same-thread proof drill and return the active message action.',
    {
      chatJid: z.string().optional(),
    },
    async (args) =>
      toTextResult(await handlers.bluebubbles_start_proof_drill(args)),
  );

  server.tool(
    'bluebubbles_execute_message_action',
    'Apply a non-send BlueBubbles message-action operation. Ordinary recipient actions allow remind_instead or save_to_thread; defer is reserved for the no-send proof drill. Sending requires a fresh owner-authored approval in Telegram or the configured Messages self-thread.',
    {
      actionId: z.string(),
      operation: z.enum(['defer', 'remind_instead', 'save_to_thread']),
      timingHint: z.string().optional(),
    },
    async (args) =>
      toTextResult(await handlers.bluebubbles_execute_message_action(args)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  startBlueBubblesControlMcpServer().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
