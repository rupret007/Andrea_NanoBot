/**
 * Google Drive - list, search, read docs.
 * Existing repo already auths Google for Calendar; this rides on the same
 * OAuth tokens (drive.readonly + drive.file scopes).
 */

import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool } from './types.js';

const API = 'https://www.googleapis.com/drive/v3';

export const GoogleDriveIntegration: Integration = {
  id: 'drive',
  displayName: 'Google Drive',
  enabled: true,

  async init(ctx) {
    if (!(await ctx.secrets.get('GOOGLE_OAUTH_TOKEN'))) {
      throw new Error('Missing GOOGLE_OAUTH_TOKEN - share with Calendar');
    }
  },

  async register(ctx): Promise<RegisteredTool[]> {
    const auth = async () => ({
      Authorization: `Bearer ${await ctx.secrets.get('GOOGLE_OAUTH_TOKEN')}`,
    });
    return [
      {
        integrationId: 'drive',
        name: 'search',
        description: "Search Drive by query (Google's q syntax).",
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: { q: { type: 'string' }, pageSize: { type: 'number' } },
          required: ['q'],
        },
        handler: async (args) => {
          const r = await fetch(
            `${API}/files?q=${encodeURIComponent(String(args.q))}&pageSize=${args.pageSize ?? 10}&fields=files(id,name,mimeType,modifiedTime,owners,webViewLink)`,
            { headers: await auth() },
          );
          if (!r.ok)
            throw new Error(
              `Drive ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
      {
        integrationId: 'drive',
        name: 'read_doc',
        description: 'Read the text content of a Google Doc by id.',
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: { fileId: { type: 'string' } },
          required: ['fileId'],
        },
        handler: async (args) => {
          const r = await fetch(
            `https://docs.googleapis.com/v1/documents/${args.fileId}`,
            { headers: await auth() },
          );
          if (!r.ok)
            throw new Error(
              `Docs ${r.status}: ${redactForError(await r.text())}`,
            );
          const data: any = await r.json();
          const text = (data.body?.content ?? [])
            .flatMap((b: any) =>
              (b.paragraph?.elements ?? []).map(
                (e: any) => e.textRun?.content ?? '',
              ),
            )
            .join('');
          return { id: args.fileId, title: data.title, text };
        },
      },
    ];
  },
};
