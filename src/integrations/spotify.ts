/**
 * Spotify integration - playback, search, queue.
 * For Jeff's bands skill: build setlists from Spotify, queue practice tracks.
 */

import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool } from './types.js';

async function bearer(ctx: {
  secrets: { get(k: string): Promise<string | undefined> };
}) {
  const t = await ctx.secrets.get('SPOTIFY_ACCESS_TOKEN');
  if (!t) throw new Error('Missing SPOTIFY_ACCESS_TOKEN - run /auth-spotify');
  return t;
}

export const SpotifyIntegration: Integration = {
  id: 'spotify',
  displayName: 'Spotify',
  enabled: true,

  async init(ctx) {
    await bearer(ctx);
  },

  async register(ctx): Promise<RegisteredTool[]> {
    return [
      {
        integrationId: 'spotify',
        name: 'search',
        description:
          'Search Spotify catalog. Types: track, album, artist, playlist.',
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: { query: { type: 'string' }, type: { type: 'string' } },
          required: ['query'],
        },
        handler: async (args) => {
          const tok = await bearer(ctx);
          const q = encodeURIComponent(String(args.query));
          const t = String(args.type ?? 'track');
          const r = await fetch(
            `https://api.spotify.com/v1/search?q=${q}&type=${t}&limit=10`,
            { headers: { Authorization: `Bearer ${tok}` } },
          );
          if (!r.ok)
            throw new Error(
              `Spotify ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
      {
        integrationId: 'spotify',
        name: 'queue',
        description:
          'Add a track to the playback queue (uri or id). Controls a physical playback device.',
        // External: this controls a physical playback device the user (or
        // someone in their household) is listening to. Treat with the same
        // care as any other physical-world side-effect.
        effect: 'external',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: { trackUri: { type: 'string' } },
          required: ['trackUri'],
        },
        handler: async (args) => {
          const tok = await bearer(ctx);
          const r = await fetch(
            `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(String(args.trackUri))}`,
            { method: 'POST', headers: { Authorization: `Bearer ${tok}` } },
          );
          if (!r.ok)
            throw new Error(
              `Spotify ${r.status}: ${redactForError(await r.text())}`,
            );
          return { queued: true };
        },
      },
      {
        integrationId: 'spotify',
        name: 'now_playing',
        description: 'Return what the user is currently listening to.',
        effect: 'read',
        cost: 'cheap',
        schema: { type: 'object' },
        handler: async () => {
          const tok = await bearer(ctx);
          const r = await fetch(
            'https://api.spotify.com/v1/me/player/currently-playing',
            {
              headers: { Authorization: `Bearer ${tok}` },
            },
          );
          if (r.status === 204) return { playing: false };
          if (!r.ok)
            throw new Error(
              `Spotify ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
    ];
  },
};
