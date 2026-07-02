/**
 * GitHub integration - read repos, issues, PRs; create/comment.
 */

import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool } from './types.js';

const API = 'https://api.github.com';
const USER_AGENT = 'andrea-nanobot/2.0';

export const GitHubIntegration: Integration = {
  id: 'github',
  displayName: 'GitHub',
  enabled: true,

  async init(ctx) {
    const t = await ctx.secrets.get('GITHUB_TOKEN');
    if (!t) throw new Error('Missing GITHUB_TOKEN');
  },

  async register(ctx): Promise<RegisteredTool[]> {
    const headers = async () => ({
      Authorization: `Bearer ${await ctx.secrets.get('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects requests without User-Agent.
      'User-Agent': USER_AGENT,
    });
    return [
      {
        integrationId: 'github',
        name: 'list_my_prs',
        description: 'List authored or assigned pull requests across repos.',
        effect: 'read',
        cost: 'cheap',
        schema: { type: 'object' },
        handler: async () => {
          const r = await fetch(
            `${API}/search/issues?q=is:open+is:pr+author:@me&per_page=30`,
            { headers: await headers() },
          );
          if (!r.ok)
            throw new Error(
              `GitHub ${r.status}: ${redactForError(await r.text())}`,
            );
          const data: any = await r.json();
          return data.items.map((i: any) => ({
            number: i.number,
            title: i.title,
            url: i.html_url,
            state: i.state,
            updatedAt: i.updated_at,
          }));
        },
      },
      {
        integrationId: 'github',
        name: 'read_issue',
        description: 'Read an issue or PR by owner/repo/number.',
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
            number: { type: 'number' },
          },
          required: ['owner', 'repo', 'number'],
        },
        handler: async (args) => {
          const r = await fetch(
            `${API}/repos/${args.owner}/${args.repo}/issues/${args.number}`,
            { headers: await headers() },
          );
          if (!r.ok)
            throw new Error(
              `GitHub ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
      {
        integrationId: 'github',
        name: 'comment_issue',
        description:
          'Post a comment on an issue or PR. Notifies subscribers; world-visible on public repos.',
        // External (not just write): GitHub fans out a notification to every
        // subscriber and the comment is world-visible on public repos.
        effect: 'external',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
            number: { type: 'number' },
            body: { type: 'string' },
          },
          required: ['owner', 'repo', 'number', 'body'],
        },
        handler: async (args) => {
          const r = await fetch(
            `${API}/repos/${args.owner}/${args.repo}/issues/${args.number}/comments`,
            {
              method: 'POST',
              headers: {
                ...(await headers()),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body: args.body }),
            },
          );
          if (!r.ok)
            throw new Error(
              `GitHub ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
    ];
  },
};
