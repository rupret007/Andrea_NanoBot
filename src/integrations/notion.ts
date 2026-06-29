/**
 * Notion integration. Read pages, search, create/update notes.
 * Uses the official Notion REST API; auth via integration token.
 */

import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool } from './types.js';

export const NotionIntegration: Integration = {
  id: 'notion',
  displayName: 'Notion',
  enabled: true,

  async init(ctx) {
    const token = await ctx.secrets.get('NOTION_TOKEN');
    if (!token) throw new Error('Missing NOTION_TOKEN');
  },

  async register(ctx): Promise<RegisteredTool[]> {
    return [
      {
        integrationId: 'notion',
        name: 'search_pages',
        description:
          'Search Notion workspace by query string. Returns page IDs and titles.',
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            pageSize: { type: 'number' },
          },
          required: ['query'],
        },
        handler: async (args) => {
          const token = await ctx.secrets.get('NOTION_TOKEN');
          const r = await fetch('https://api.notion.com/v1/search', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: args.query,
              page_size: args.pageSize ?? 10,
            }),
          });
          if (!r.ok)
            throw new Error(
              `Notion ${r.status}: ${redactForError(await r.text())}`,
            );
          const data: any = await r.json();
          return (data.results ?? []).map((p: any) => ({
            id: p.id,
            title:
              Object.values(p.properties ?? {})
                .flatMap(
                  (prop: any) =>
                    prop?.title?.map((t: any) => t.plain_text) ?? [],
                )
                .join('') ||
              p.url ||
              p.id,
            url: p.url,
            type: p.object,
          }));
        },
      },
      {
        integrationId: 'notion',
        name: 'read_page',
        description: 'Read the full contents of a Notion page given its id.',
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: { pageId: { type: 'string' } },
          required: ['pageId'],
        },
        handler: async (args) => {
          const token = await ctx.secrets.get('NOTION_TOKEN');
          const r = await fetch(
            `https://api.notion.com/v1/blocks/${args.pageId}/children?page_size=100`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Notion-Version': '2022-06-28',
              },
            },
          );
          if (!r.ok)
            throw new Error(
              `Notion ${r.status}: ${redactForError(await r.text())}`,
            );
          const data: any = await r.json();
          return (data.results ?? []).map(stripBlock);
        },
      },
      {
        integrationId: 'notion',
        name: 'create_page',
        description:
          'Create a new Notion page in a parent page or database. Use sparingly; prefer asking the user before writing.',
        effect: 'write',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: {
            parentId: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['parentId', 'title'],
        },
        handler: async (args) => {
          const token = await ctx.secrets.get('NOTION_TOKEN');
          const r = await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              parent: { page_id: args.parentId },
              properties: {
                title: { title: [{ text: { content: args.title } }] },
              },
              children: args.body
                ? [
                    {
                      object: 'block',
                      type: 'paragraph',
                      paragraph: {
                        rich_text: [{ text: { content: String(args.body) } }],
                      },
                    },
                  ]
                : [],
            }),
          });
          if (!r.ok)
            throw new Error(
              `Notion ${r.status}: ${redactForError(await r.text())}`,
            );
          const created: any = await r.json();
          return { id: created.id, url: created.url };
        },
      },
    ];
  },

  async health(ctx) {
    const token = await ctx.secrets.get('NOTION_TOKEN');
    if (!token) return { ok: false, detail: 'missing token' };
    const r = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    });
    return { ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}` };
  },
};

function stripBlock(b: any) {
  if (!b) return null;
  const type = b.type;
  const value = b[type];
  const rich = value?.rich_text ?? value?.text ?? [];
  return {
    id: b.id,
    type,
    text: rich.map((t: any) => t.plain_text ?? t.text?.content ?? '').join(''),
  };
}
