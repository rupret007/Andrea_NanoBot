import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';
import type { AgentRuntimeName } from './types.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'AGENT_RUNTIME_DEFAULT',
  'AGENT_RUNTIME_FALLBACK',
  'ANDREA_OPENAI_BACKEND_ENABLED',
  'ANDREA_OPENAI_BACKEND_URL',
  'ANDREA_OPENAI_BACKEND_TIMEOUT_MS',
  'ANDREA_PLATFORM_COORDINATOR_ENABLED',
  'ANDREA_PLATFORM_COORDINATOR_URL',
  'ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME',
  'ANDREA_PLATFORM_SHELL_GATEWAY_URL',
  'ANDREA_RUNTIME_EXECUTION_ENABLED',
  'CODEX_LOCAL_ENABLED',
  'CODEX_LOCAL_MODEL',
  'CONTAINER_RUNTIME',
  'OPENAI_MODEL_COMPLEX',
  'OPENAI_MODEL_FALLBACK',
  'OPENAI_MODEL_SIMPLE',
  'OPENAI_MODEL_STANDARD',
  'ONECLI_URL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andrea';
export const ASSISTANT_NAME_SOURCE =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME ? 'env' : 'default';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const RUNTIME_STATE_DIR = path.resolve(DATA_DIR, 'runtime');

function normalizeConfiguredContainerRuntime(
  value: string | undefined,
): 'podman' | 'docker' | 'apple-container' | undefined {
  if (!value) return undefined;
  if (value === 'podman' || value === 'docker' || value === 'apple-container') {
    return value;
  }
  throw new Error(
    `Unsupported CONTAINER_RUNTIME "${value}". Expected podman, docker, or apple-container.`,
  );
}

function normalizeConfiguredAgentRuntime(
  value: string | undefined,
): AgentRuntimeName | undefined {
  if (!value) return undefined;
  if (
    value === 'codex_local' ||
    value === 'openai_cloud' ||
    value === 'claude_legacy'
  ) {
    return value;
  }
  throw new Error(
    `Unsupported agent runtime "${value}". Expected codex_local, openai_cloud, or claude_legacy.`,
  );
}

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const AGENT_RUNTIME_DEFAULT =
  normalizeConfiguredAgentRuntime(
    process.env.AGENT_RUNTIME_DEFAULT || envConfig.AGENT_RUNTIME_DEFAULT,
  ) || 'codex_local';
export const AGENT_RUNTIME_FALLBACK =
  normalizeConfiguredAgentRuntime(
    process.env.AGENT_RUNTIME_FALLBACK || envConfig.AGENT_RUNTIME_FALLBACK,
  ) || 'openai_cloud';
export const ANDREA_OPENAI_BACKEND_ENABLED =
  (process.env.ANDREA_OPENAI_BACKEND_ENABLED ||
    envConfig.ANDREA_OPENAI_BACKEND_ENABLED ||
    process.env.ANDREA_RUNTIME_EXECUTION_ENABLED ||
    envConfig.ANDREA_RUNTIME_EXECUTION_ENABLED ||
    'false') === 'true';
export const ANDREA_OPENAI_BACKEND_URL =
  process.env.ANDREA_OPENAI_BACKEND_URL ||
  envConfig.ANDREA_OPENAI_BACKEND_URL ||
  'http://127.0.0.1:3210';
export const ANDREA_OPENAI_BACKEND_TIMEOUT_MS = parseInt(
  process.env.ANDREA_OPENAI_BACKEND_TIMEOUT_MS ||
    envConfig.ANDREA_OPENAI_BACKEND_TIMEOUT_MS ||
    '15000',
  10,
);
export const ANDREA_PLATFORM_COORDINATOR_ENABLED =
  (process.env.ANDREA_PLATFORM_COORDINATOR_ENABLED ||
    envConfig.ANDREA_PLATFORM_COORDINATOR_ENABLED ||
    'false') === 'true';
export const ANDREA_PLATFORM_COORDINATOR_URL =
  process.env.ANDREA_PLATFORM_COORDINATOR_URL ||
  envConfig.ANDREA_PLATFORM_COORDINATOR_URL ||
  'http://127.0.0.1:4400';
export const ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME =
  (process.env.ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME ||
    envConfig.ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME ||
    'false') === 'true';
export const ANDREA_PLATFORM_SHELL_GATEWAY_URL =
  process.env.ANDREA_PLATFORM_SHELL_GATEWAY_URL ||
  envConfig.ANDREA_PLATFORM_SHELL_GATEWAY_URL ||
  '';
export const CODEX_LOCAL_ENABLED =
  (process.env.CODEX_LOCAL_ENABLED || envConfig.CODEX_LOCAL_ENABLED || 'true') !==
  'false';
export const CODEX_LOCAL_MODEL =
  process.env.CODEX_LOCAL_MODEL || envConfig.CODEX_LOCAL_MODEL || '';
export const CONTAINER_RUNTIME = normalizeConfiguredContainerRuntime(
  process.env.CONTAINER_RUNTIME || envConfig.CONTAINER_RUNTIME,
);
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_INITIAL_OUTPUT_TIMEOUT = parseInt(
  process.env.CONTAINER_INITIAL_OUTPUT_TIMEOUT || '300000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const OPENAI_MODEL_SIMPLE =
  process.env.OPENAI_MODEL_SIMPLE || envConfig.OPENAI_MODEL_SIMPLE || '';
export const OPENAI_MODEL_STANDARD =
  process.env.OPENAI_MODEL_STANDARD || envConfig.OPENAI_MODEL_STANDARD || '';
export const OPENAI_MODEL_COMPLEX =
  process.env.OPENAI_MODEL_COMPLEX || envConfig.OPENAI_MODEL_COMPLEX || '';
export const OPENAI_MODEL_FALLBACK =
  process.env.OPENAI_MODEL_FALLBACK ||
  envConfig.OPENAI_MODEL_FALLBACK ||
  OPENAI_MODEL_COMPLEX ||
  'gpt-5.4';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '300000', 10); // 5min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
