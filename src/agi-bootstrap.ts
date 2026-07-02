/**
 * Bootstrap helper — read env, build the AgiRuntime with sensible defaults.
 *
 * Importable from the existing `src/index.ts`:
 *
 *   import { bootstrapAgi } from "./agi-bootstrap.js";
 *   const agi = await bootstrapAgi();
 *   // ... in your channel handler:
 *   const { reply } = await agi.ask({ scope: groupId, text, source: "telegram" });
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEnvFile } from './env.js';
import {
  AnthropicAdapter,
  DEFAULT_CATALOG,
  HashEmbedder,
  OllamaAdapter,
  discoverOllamaModels,
  OpenAIAdapter,
  VoyageEmbedder,
} from './models/index.js';
import {
  GitHubIntegration,
  GoogleDriveIntegration,
  HomeAssistantIntegration,
  LinearIntegration,
  NotionIntegration,
  SpotifyIntegration,
  WebResearchIntegration,
} from './integrations/index.js';
import { AgiRuntime } from './agi-runtime.js';
import { SkillsSubsystem } from './skills/index.js';

const AGI_ENV_KEYS = [
  'ANDREA_STATE_DIR',
  'ANDREA_SKILLS_AUTOSYNC',
  'ANDREA_PRIMARY_MODEL',
  'ANDREA_SMALL_MODEL',
  'ANDREA_PANEL_MODELS',
  'ANDREA_BUDGET_HOUR_USD',
  'ANDREA_BUDGET_DAY_USD',
  'ANDREA_BUDGET_MONTH_USD',
  'ANDREA_PERSONA',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'OLLAMA_BASE_URL',
  'NOTION_TOKEN',
  'LINEAR_API_KEY',
  'GITHUB_TOKEN',
  'SPOTIFY_ACCESS_TOKEN',
  'HASS_URL',
  'HASS_TOKEN',
  'GOOGLE_OAUTH_TOKEN',
  'EXA_API_KEY',
  'BRAVE_API_KEY',
  'TZ',
];

/**
 * Per-integration env-namespacing convention. The default policy: an
 * integration only sees env vars whose key (a) starts with `<INTEGRATION_ID>_`
 * (uppercased) or (b) is on the curated allow-list below. Without this scope,
 * every integration would have access to every other integration's
 * credentials, which is unnecessary blast radius for a misbehaving plugin.
 *
 * The allow-list keeps non-prefixed but commonly-used variables reachable
 * (e.g. `OPENAI_API_KEY` for an integration that does its own embeddings).
 * Add to `CURATED_PUBLIC_KEYS` rather than removing the prefix gate.
 */
const CURATED_PUBLIC_KEYS = new Set<string>([
  // Generic infra knobs that integrations may peek at.
  'ANDREA_STATE_DIR',
  'ANDREA_SKILLS_AUTOSYNC',
  'TZ',
  'NODE_ENV',
]);

const INTEGRATION_SECRET_KEYS: Record<string, readonly string[]> = {
  drive: ['GOOGLE_OAUTH_TOKEN'],
  github: ['GITHUB_TOKEN'],
  homeassistant: ['HASS_URL', 'HASS_TOKEN'],
  linear: ['LINEAR_API_KEY'],
  notion: ['NOTION_TOKEN'],
  spotify: ['SPOTIFY_ACCESS_TOKEN'],
  web: ['EXA_API_KEY', 'BRAVE_API_KEY'],
};

function scopedEnv(
  env: Record<string, string | undefined>,
  integrationId: string,
): Record<string, string | undefined> {
  const prefix = integrationId.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_';
  const explicit = new Set(INTEGRATION_SECRET_KEYS[integrationId] ?? []);
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(prefix) || CURATED_PUBLIC_KEYS.has(k) || explicit.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

export interface BootstrapOptions {
  /** Skip wiring SIGTERM/SIGINT shutdown hooks. Tests should pass true. */
  skipSignalHooks?: boolean;
  /**
   * Forwarded to AgiRuntime — bypasses the singleton guard. Tests pass true.
   */
  force?: boolean;
}

export async function bootstrapAgi(
  envOverrides: Record<string, string | undefined> = {},
  bootstrapOpts: BootstrapOptions = {},
) {
  const envFile = readEnvFile(AGI_ENV_KEYS);
  const env = { ...envFile, ...process.env, ...envOverrides };

  // ---- Embeddings: prefer Voyage, fall back to hash for offline dev. -----
  const embed = env.VOYAGE_API_KEY
    ? new VoyageEmbedder(env.VOYAGE_API_KEY)
    : new HashEmbedder(256);

  // ---- Model providers ----------------------------------------------------
  const providers = [];
  if (env.ANTHROPIC_API_KEY) {
    providers.push(
      new AnthropicAdapter(env.ANTHROPIC_API_KEY, DEFAULT_CATALOG),
    );
  }
  if (env.OPENAI_API_KEY) {
    providers.push(new OpenAIAdapter(env.OPENAI_API_KEY, DEFAULT_CATALOG));
  }
  const ollamaBaseUrl = env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const ollamaModels = await discoverOllamaModels(ollamaBaseUrl).catch(
    () => [],
  );
  const ollama = new OllamaAdapter(ollamaModels, ollamaBaseUrl);
  if (ollamaModels.length > 0) {
    providers.push(ollama);
  }

  if (providers.length === 0) {
    throw new Error(
      'No model providers configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or run a local Ollama server.',
    );
  }

  // ---- Integrations: enable each one if its credentials are present ------
  const integrations = [];
  if (env.NOTION_TOKEN) integrations.push(NotionIntegration);
  if (env.LINEAR_API_KEY) integrations.push(LinearIntegration);
  if (env.GITHUB_TOKEN) integrations.push(GitHubIntegration);
  if (env.SPOTIFY_ACCESS_TOKEN) integrations.push(SpotifyIntegration);
  if (env.HASS_URL && env.HASS_TOKEN)
    integrations.push(HomeAssistantIntegration);
  if (env.GOOGLE_OAUTH_TOKEN) integrations.push(GoogleDriveIntegration);
  if (env.EXA_API_KEY || env.BRAVE_API_KEY)
    integrations.push(WebResearchIntegration);
  // Zero integrations is OK — they are optional.

  const stateDir = resolveStateDir(env.ANDREA_STATE_DIR);
  const skills = await SkillsSubsystem.create({
    cacheDir: join(stateDir, 'skills-cache'),
    autoSync: truthy(env.ANDREA_SKILLS_AUTOSYNC),
    onEpisode: async (episode) => {
      // Skill episodes are intentionally lightweight here; the runtime also
      // writes normal episodic memory for visible user/assistant turns. The
      // reflector can consume these from audit/trace tooling in follow-up work.
      void episode;
    },
  });

  const panelModelIds = (
    env.ANDREA_PANEL_MODELS ?? 'claude-opus-4-6,gpt-5,gemini-2.5-pro'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const budgets = {
    hour: {
      windowMs: 60 * 60 * 1000,
      maxUsd: numericEnv(env.ANDREA_BUDGET_HOUR_USD, 5),
      maxCalls: 200,
    },
    day: {
      windowMs: 24 * 60 * 60 * 1000,
      maxUsd: numericEnv(env.ANDREA_BUDGET_DAY_USD, 25),
      maxCalls: 2000,
    },
    month: {
      windowMs: 30 * 24 * 60 * 60 * 1000,
      maxUsd: numericEnv(env.ANDREA_BUDGET_MONTH_USD, 200),
    },
  };

  const rt = await AgiRuntime.create({
    embed,
    providers,
    integrations,
    primaryModelId: env.ANDREA_PRIMARY_MODEL ?? 'claude-sonnet-4-6',
    smallModelId: env.ANDREA_SMALL_MODEL ?? 'claude-haiku-4-5-20251001',
    panelModelIds,
    paths: {
      vector: join(stateDir, 'memory', 'vectors.jsonl'),
      graph: join(stateDir, 'memory', 'graph.json'),
      episodic: join(stateDir, 'memory', 'episodes.jsonl'),
      audit: join(stateDir, 'audit', 'audit.jsonl'),
      workdirRoot: join(stateDir, 'integrations'),
    },
    budgets,
    persona: env.ANDREA_PERSONA,
    skills,
    tz: env.TZ,
    force: bootstrapOpts.force,
    secretsFor: async (integrationId) => {
      // Scope env to the integration's own prefix + curated public keys.
      // Eliminates accidental cross-integration credential exposure.
      const scoped = scopedEnv(env, integrationId);
      return {
        get: async (k) => scoped[k],
      };
    },
  });

  if (!bootstrapOpts.skipSignalHooks) {
    const shutdown = () => {
      // Best-effort: flush memory + close MCP bridges, then exit.
      rt.shutdown()
        .catch((err) => console.error('[bootstrap] shutdown failed:', err))
        .finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  return rt;
}

function numericEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((v ?? '').toLowerCase());
}

function resolveStateDir(value: string | undefined): string {
  const raw = value && value.trim() ? value.trim() : join(homedir(), '.andrea');
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return resolve(join(homedir(), raw.slice(2)));
  return resolve(raw);
}
