/**
 * Home Assistant integration - for Jeff's smart home, doubles as the
 * "physical world" hand of the assistant. Read state and call services.
 *
 * Uses a long-lived access token (Profile -> Long-Lived Access Tokens).
 */

import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool, ToolEffect } from './types.js';

/**
 * Service-call effect classifier. We default to `external` because most HA
 * services are reversible with a quick follow-up call (turning a light off
 * after turning it on, etc.). A small allowlist of irreversible or
 * high-risk actions is escalated to `destructive` so the policy gate
 * requires explicit confirmation.
 *
 * Conservative on purpose - if you are not sure, return `external`.
 */
export function classifyHaService(
  domain: string,
  service: string,
  data?: Record<string, unknown>,
): ToolEffect {
  const d = (domain ?? '').toLowerCase();
  const s = (service ?? '').toLowerCase();
  // Unlocking a lock is real-world destructive: it grants physical access.
  if (d === 'lock' && s === 'unlock') return 'destructive';
  // Vacuum.start commits to a cleaning cycle that is hard to interrupt
  // without physically getting up.
  if (d === 'vacuum' && s === 'start') return 'destructive';
  // Cover.open_cover is destructive ONLY when the cover is a garage door -
  // we treat unspecified covers as external. A user can tag the entity
  // with `dangerous: true` in `data` to force destructive.
  if (d === 'cover' && s === 'open_cover') {
    const id = String(
      (data as { entity_id?: unknown })?.entity_id ?? '',
    ).toLowerCase();
    if (id.includes('garage')) return 'destructive';
  }
  // Switch turn_on for entities tagged `dangerous` in their service data
  // (e.g. high-current breakers Jeff has marked).
  if (d === 'switch' && s === 'turn_on') {
    const dangerous = (data as { dangerous?: unknown })?.dangerous === true;
    if (dangerous) return 'destructive';
  }
  return 'external';
}

export const HomeAssistantIntegration: Integration = {
  id: 'homeassistant',
  displayName: 'Home Assistant',
  enabled: true,

  async init(ctx) {
    if (!(await ctx.secrets.get('HASS_URL')))
      throw new Error('Missing HASS_URL');
    if (!(await ctx.secrets.get('HASS_TOKEN')))
      throw new Error('Missing HASS_TOKEN');
  },

  async register(ctx): Promise<RegisteredTool[]> {
    const auth = async () => ({
      Authorization: `Bearer ${await ctx.secrets.get('HASS_TOKEN')}`,
      'Content-Type': 'application/json',
    });
    const baseUrl = async () => (await ctx.secrets.get('HASS_URL')) ?? '';
    return [
      {
        integrationId: 'homeassistant',
        name: 'get_state',
        description:
          'Get the current state of an entity by id (e.g. light.kitchen).',
        effect: 'read',
        cost: 'free',
        schema: {
          type: 'object',
          properties: { entity_id: { type: 'string' } },
          required: ['entity_id'],
        },
        handler: async (args) => {
          // URL-encode the entity_id - it can contain dots and rarely
          // characters that need escaping; safer to always encode.
          const eid = encodeURIComponent(String(args.entity_id));
          const r = await fetch(`${await baseUrl()}/api/states/${eid}`, {
            headers: await auth(),
          });
          if (!r.ok)
            throw new Error(
              `HA ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
      {
        integrationId: 'homeassistant',
        name: 'call_service',
        description:
          'Call a HA service (domain.service). Use cautiously - affects physical devices.',
        effect: 'external',
        cost: 'free',
        schema: {
          type: 'object',
          properties: {
            domain: { type: 'string' },
            service: { type: 'string' },
            data: { type: 'object' },
          },
          required: ['domain', 'service'],
        },
        handler: async (args) => {
          const r = await fetch(
            `${await baseUrl()}/api/services/${encodeURIComponent(String(args.domain))}/${encodeURIComponent(String(args.service))}`,
            {
              method: 'POST',
              headers: await auth(),
              body: JSON.stringify(args.data ?? {}),
            },
          );
          if (!r.ok)
            throw new Error(
              `HA ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
      {
        integrationId: 'homeassistant',
        name: 'list_entities',
        description: 'List all entities, optionally filtered by domain prefix.',
        effect: 'read',
        cost: 'free',
        schema: {
          type: 'object',
          properties: { domain: { type: 'string' } },
        },
        handler: async (args) => {
          const r = await fetch(`${await baseUrl()}/api/states`, {
            headers: await auth(),
          });
          if (!r.ok)
            throw new Error(
              `HA ${r.status}: ${redactForError(await r.text())}`,
            );
          const parsed = await r.json();
          if (!Array.isArray(parsed))
            throw new Error('HA states response was not an array');
          const all = parsed as Array<
            { entity_id?: string } & Record<string, unknown>
          >;
          const dom = (args.domain as string) ?? '';
          return dom
            ? all.filter((e) => e.entity_id?.startsWith(dom + '.'))
            : all;
        },
      },
    ];
  },
};
