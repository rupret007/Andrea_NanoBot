/**
 * Linear integration - issues, projects, status.
 * GraphQL API via single POST endpoint, OAuth token.
 */

import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool } from './types.js';

const LINEAR_GQL = 'https://api.linear.app/graphql';

async function gql(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const r = await fetch(LINEAR_GQL, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok)
    throw new Error(`Linear ${r.status}: ${redactForError(await r.text())}`);
  const data: any = await r.json();
  if (data.errors) throw new Error(redactForError(JSON.stringify(data.errors)));
  return data.data;
}

export const LinearIntegration: Integration = {
  id: 'linear',
  displayName: 'Linear',
  enabled: true,

  async init(ctx) {
    const token = await ctx.secrets.get('LINEAR_API_KEY');
    if (!token) throw new Error('Missing LINEAR_API_KEY');
  },

  async register(ctx): Promise<RegisteredTool[]> {
    return [
      {
        integrationId: 'linear',
        name: 'list_my_issues',
        description: "List the user's open assigned Linear issues.",
        effect: 'read',
        cost: 'cheap',
        schema: { type: 'object', properties: { limit: { type: 'number' } } },
        handler: async (args) => {
          const token = (await ctx.secrets.get('LINEAR_API_KEY')) ?? '';
          const limit = (args.limit as number) ?? 25;
          const data = await gql(
            token,
            `query Me($first: Int!) {
               viewer {
                 assignedIssues(first: $first, filter: { state: { type: { neq: "completed" } } }) {
                   nodes { id identifier title state { name } priority url updatedAt }
                 }
               }
             }`,
            { first: limit },
          );
          return data.viewer.assignedIssues.nodes;
        },
      },
      {
        integrationId: 'linear',
        name: 'create_issue',
        description:
          'Create a new Linear issue. Notifies workspace subscribers.',
        // External: creating an issue notifies the workspace and is world-visible
        // to teammates. Treat like sending a message, not a private write.
        effect: 'external',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: {
            teamId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'number' },
          },
          required: ['teamId', 'title'],
        },
        handler: async (args) => {
          const token = (await ctx.secrets.get('LINEAR_API_KEY')) ?? '';
          const data = await gql(
            token,
            `mutation Create($input: IssueCreateInput!) {
               issueCreate(input: $input) { success issue { id identifier url } }
             }`,
            { input: args },
          );
          return data.issueCreate;
        },
      },
    ];
  },

  async health(ctx) {
    const token = await ctx.secrets.get('LINEAR_API_KEY');
    if (!token) return { ok: false, detail: 'missing token' };
    try {
      await gql(token, `query { viewer { id } }`);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
