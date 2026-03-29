/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_INITIAL_OUTPUT_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  RUNTIME_STATE_DIR,
  TIMEZONE,
} from './config.js';
import { listEnabledCommunitySkillsForGroup } from './db.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  CONTAINER_RUNTIME_NAME,
  getContainerRuntimeHostAlias,
  hostGatewayArgs,
  normalizeRuntimeArgs,
  readonlyMountArgs,
  stopContainer,
  writableMountArgs,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { OPENCLAW_MARKET_MANIFEST_FILENAME } from './openclaw-market.js';
import { RegisteredGroup } from './types.js';
import type { AssistantRequestPolicy } from './assistant-routing.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  requestPolicy?: AssistantRequestPolicy;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

const FALLBACK_CREDENTIAL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;

const RUNTIME_ENDPOINT_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
] as const;
const MODEL_OVERRIDE_ENV_KEYS = [
  'NANOCLAW_AGENT_MODEL',
  'CLAUDE_CODE_MODEL',
  'CLAUDE_MODEL',
] as const;

interface LocalOpenAiGatewayState {
  runtime?: string;
  network?: string;
  endpoint?: string;
  container_name?: string;
}

const ONECLI_AUTH_PLACEHOLDER = 'onecli-placeholder';
const LOCAL_OPENAI_GATEWAY_STATE_PATH = path.join(
  RUNTIME_STATE_DIR,
  'openai-gateway-state.json',
);
const LOCAL_ENDPOINT_REWRITE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.containers.internal',
  'host.docker.internal',
  'api.openai.com',
]);
const LOOPBACK_ENDPOINT_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CONTAINER_HOST_ALIAS_HOSTS = new Set([
  'host.containers.internal',
  'host.docker.internal',
]);
const NINE_ROUTER_DEFAULT_PORT = '20128';
const LOG_SAFE_ENV_KEYS = new Set([
  'TZ',
  'HOME',
  'NANOCLAW_CONTAINER_RUNTIME',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'ONECLI_URL',
]);

function shouldRedactEnvKey(key: string): boolean {
  if (LOG_SAFE_ENV_KEYS.has(key)) return false;
  return (
    /TOKEN/i.test(key) ||
    /API_KEY/i.test(key) ||
    /SECRET/i.test(key) ||
    /PASSWORD/i.test(key) ||
    /AUTH/i.test(key)
  );
}

export function sanitizeContainerArgsForLogs(args: string[]): string[] {
  const sanitized = [...args];
  for (let i = 0; i < sanitized.length - 1; i++) {
    if (sanitized[i] !== '-e') continue;
    const envArg = sanitized[i + 1];
    const separator = envArg.indexOf('=');
    if (separator <= 0) continue;
    const key = envArg.slice(0, separator);
    if (shouldRedactEnvKey(key)) {
      sanitized[i + 1] = `${key}=***`;
    }
  }
  return sanitized;
}

function hasContainerEnvArg(args: string[], key: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-e') continue;
    if (args[i + 1]?.startsWith(`${key}=`)) {
      return true;
    }
  }
  return false;
}

function hasAnthropicAuthEnvArg(args: string[]): boolean {
  return (
    hasContainerEnvArg(args, 'CLAUDE_CODE_OAUTH_TOKEN') ||
    hasContainerEnvArg(args, 'ANTHROPIC_API_KEY') ||
    hasContainerEnvArg(args, 'ANTHROPIC_AUTH_TOKEN')
  );
}

function collectRuntimeEndpointEnv(): Record<string, string> {
  const fromEnvFile = readEnvFile([...RUNTIME_ENDPOINT_ENV_KEYS]);
  const env: Record<string, string> = {};

  for (const key of RUNTIME_ENDPOINT_ENV_KEYS) {
    const value = process.env[key] || fromEnvFile[key];
    if (value) env[key] = value;
  }

  // Claude SDK expects ANTHROPIC_BASE_URL for endpoint overrides. If users
  // provide OPENAI_BASE_URL only, mirror it so OpenAI-compatible gateways work
  // without requiring duplicate environment keys.
  if (!env.ANTHROPIC_BASE_URL && env.OPENAI_BASE_URL) {
    env.ANTHROPIC_BASE_URL = env.OPENAI_BASE_URL;
  }

  return env;
}

function collectFallbackCredentialEnv(
  endpointEnv: Record<string, string>,
): Record<string, string> {
  const fromEnvFile = readEnvFile([...FALLBACK_CREDENTIAL_KEYS]);
  const env: Record<string, string> = {};

  for (const key of FALLBACK_CREDENTIAL_KEYS) {
    const value = process.env[key] || fromEnvFile[key];
    if (value) env[key] = value;
  }

  // OpenAI-compatible bridge:
  // If the user configured an Anthropic-compatible base URL and only has an
  // OpenAI key, use that key as the auth token expected by the Claude SDK.
  const hasAnthropicAuth =
    !!env.CLAUDE_CODE_OAUTH_TOKEN ||
    !!env.ANTHROPIC_API_KEY ||
    !!env.ANTHROPIC_AUTH_TOKEN;
  if (
    !hasAnthropicAuth &&
    endpointEnv.ANTHROPIC_BASE_URL &&
    env.OPENAI_API_KEY
  ) {
    env.ANTHROPIC_AUTH_TOKEN = env.OPENAI_API_KEY;
  }

  return env;
}

function collectModelOverrideEnv(): Record<string, string> {
  const fromEnvFile = readEnvFile([...MODEL_OVERRIDE_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of MODEL_OVERRIDE_ENV_KEYS) {
    const value = process.env[key] || fromEnvFile[key];
    if (value) env[key] = value;
  }
  return env;
}

function hasContainerFlagValue(
  args: string[],
  flag: string,
  value: string,
): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) {
      return true;
    }
  }
  return false;
}

function parseEndpointHostname(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    );
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseEndpoint(value: string): URL | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function parseExplicitEndpointPort(value: string): string | null {
  const endpoint = parseEndpoint(value);
  if (!endpoint) return null;
  return endpoint.port || null;
}

function rewriteEndpointForContainer(endpointValue: string): string {
  const endpoint = parseEndpoint(endpointValue);
  if (!endpoint) return endpointValue;

  const host = endpoint.hostname.toLowerCase();
  if (
    !LOOPBACK_ENDPOINT_HOSTS.has(host) &&
    !CONTAINER_HOST_ALIAS_HOSTS.has(host)
  ) {
    return endpointValue;
  }

  const runtimeHostAlias = getContainerRuntimeHostAlias();
  endpoint.hostname = runtimeHostAlias;
  return endpoint.toString();
}

function rewriteRuntimeEndpointEnvForContainer(
  runtimeEndpointEnv: Record<string, string>,
): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEndpointEnv)) {
    rewritten[key] = rewriteEndpointForContainer(value);
  }
  return rewritten;
}

function endpointLooksLike9Router(endpointValue: string): boolean {
  const endpoint = parseEndpoint(endpointValue);
  if (!endpoint) return false;
  if (endpoint.port === NINE_ROUTER_DEFAULT_PORT) return true;
  return endpoint.hostname.toLowerCase().includes('9router');
}

function resolveModelOverridesForRuntime(
  runtimeEndpointEnv: Record<string, string>,
): Record<string, string> {
  const configured = collectModelOverrideEnv();
  if (
    configured.NANOCLAW_AGENT_MODEL ||
    configured.CLAUDE_CODE_MODEL ||
    configured.CLAUDE_MODEL
  ) {
    return configured;
  }

  const endpoint =
    runtimeEndpointEnv.ANTHROPIC_BASE_URL || runtimeEndpointEnv.OPENAI_BASE_URL;
  if (!endpoint || !endpointLooksLike9Router(endpoint)) {
    return configured;
  }

  return {
    ...configured,
    NANOCLAW_AGENT_MODEL: 'cu/default',
  };
}

function readLocalOpenAiGatewayState(): LocalOpenAiGatewayState | null {
  if (!fs.existsSync(LOCAL_OPENAI_GATEWAY_STATE_PATH)) {
    return null;
  }
  try {
    const raw = fs
      .readFileSync(LOCAL_OPENAI_GATEWAY_STATE_PATH, 'utf-8')
      .replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as LocalOpenAiGatewayState;
    if (
      !parsed ||
      typeof parsed.network !== 'string' ||
      !parsed.network ||
      typeof parsed.endpoint !== 'string' ||
      !parsed.endpoint
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveLocalOpenAiGatewayBinding(
  runtimeEndpointEnv: Record<string, string>,
): { endpoint: string; network: string } | null {
  const state = readLocalOpenAiGatewayState();
  if (!state) return null;
  if (state.runtime && state.runtime !== CONTAINER_RUNTIME_NAME) return null;

  const envFileCreds = readEnvFile([...FALLBACK_CREDENTIAL_KEYS]);
  const hasOpenAiApiKey = Boolean(
    process.env.OPENAI_API_KEY || envFileCreds.OPENAI_API_KEY,
  );
  if (!hasOpenAiApiKey) return null;

  const hasAnthropicDirectCreds = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    envFileCreds.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    envFileCreds.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    envFileCreds.ANTHROPIC_AUTH_TOKEN,
  );

  const configuredEndpoint =
    runtimeEndpointEnv.ANTHROPIC_BASE_URL || runtimeEndpointEnv.OPENAI_BASE_URL;

  if (configuredEndpoint) {
    const host = parseEndpointHostname(configuredEndpoint);
    if (!host || !LOCAL_ENDPOINT_REWRITE_HOSTS.has(host)) {
      return null;
    }

    // If users explicitly point to a local endpoint on a different port
    // (for example 9router on :20128), preserve that endpoint instead of
    // rewriting to the local OpenAI gateway container binding.
    if (
      LOOPBACK_ENDPOINT_HOSTS.has(host) ||
      CONTAINER_HOST_ALIAS_HOSTS.has(host)
    ) {
      const configuredPort = parseExplicitEndpointPort(configuredEndpoint);
      const statePort = parseExplicitEndpointPort(state.endpoint ?? '');
      if (configuredPort && statePort && configuredPort !== statePort) {
        return null;
      }
    }
  } else if (hasAnthropicDirectCreds) {
    return null;
  }

  return {
    endpoint: state.endpoint!,
    network: state.network!,
  };
}

function ensureSecretShadowFile(): string {
  const shadowFile = path.join(RUNTIME_STATE_DIR, 'secret-shadow-empty');
  fs.mkdirSync(path.dirname(shadowFile), { recursive: true });
  if (!fs.existsSync(shadowFile)) {
    fs.writeFileSync(shadowFile, '');
  }
  return shadowFile;
}

function syncSkillsForGroup(
  groupFolder: string,
  groupSessionsDir: string,
): void {
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  fs.mkdirSync(skillsDst, { recursive: true });

  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
    }
  }

  let enabledCommunitySkills: ReturnType<
    typeof listEnabledCommunitySkillsForGroup
  > = [];
  try {
    enabledCommunitySkills = listEnabledCommunitySkillsForGroup(groupFolder);
  } catch (err) {
    logger.debug(
      { groupFolder, err },
      'Skipping community skill sync because the marketplace DB is unavailable',
    );
  }
  const enabledCommunityDirs = new Set<string>();
  for (const skill of enabledCommunitySkills) {
    if (!fs.existsSync(skill.cache_path)) {
      logger.warn(
        {
          groupFolder,
          skillId: skill.skill_id,
          cachePath: skill.cache_path,
        },
        'Enabled community skill cache missing; skipping sync',
      );
      continue;
    }
    enabledCommunityDirs.add(skill.cache_dir_name);
  }

  for (const entry of fs.readdirSync(skillsDst)) {
    const candidateDir = path.join(skillsDst, entry);
    if (
      !fs.existsSync(candidateDir) ||
      !fs.statSync(candidateDir).isDirectory()
    ) {
      continue;
    }

    const manifestPath = path.join(
      candidateDir,
      OPENCLAW_MARKET_MANIFEST_FILENAME,
    );
    if (
      fs.existsSync(manifestPath) &&
      !enabledCommunityDirs.has(path.basename(candidateDir))
    ) {
      fs.rmSync(candidateDir, { recursive: true, force: true });
    }
  }

  for (const skill of enabledCommunitySkills) {
    if (!enabledCommunityDirs.has(skill.cache_dir_name)) continue;

    const destinationDir = path.join(skillsDst, skill.cache_dir_name);
    fs.rmSync(destinationDir, { recursive: true, force: true });
    fs.cpSync(skill.cache_path, destinationDir, {
      recursive: true,
      force: true,
    });
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: ensureSecretShadowFile(),
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  syncSkillsForGroup(group.folder, groupSessionsDir);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const runtimeEndpointEnv = collectRuntimeEndpointEnv();
  const localOpenAiGatewayBinding =
    resolveLocalOpenAiGatewayBinding(runtimeEndpointEnv);

  if (localOpenAiGatewayBinding) {
    runtimeEndpointEnv.ANTHROPIC_BASE_URL = localOpenAiGatewayBinding.endpoint;
    runtimeEndpointEnv.OPENAI_BASE_URL = localOpenAiGatewayBinding.endpoint;
    if (
      !hasContainerFlagValue(
        args,
        '--network',
        localOpenAiGatewayBinding.network,
      )
    ) {
      args.push('--network', localOpenAiGatewayBinding.network);
    }
    logger.info(
      {
        containerName,
        network: localOpenAiGatewayBinding.network,
        endpoint: localOpenAiGatewayBinding.endpoint,
      },
      'Using local OpenAI gateway container binding',
    );
  }

  const runtimeEndpointEnvForContainer =
    rewriteRuntimeEndpointEnvForContainer(runtimeEndpointEnv);
  const modelOverrides = resolveModelOverridesForRuntime(
    runtimeEndpointEnvForContainer,
  );

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_CONTAINER_RUNTIME=${CONTAINER_RUNTIME_NAME}`);

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    for (const [key, value] of Object.entries(runtimeEndpointEnvForContainer)) {
      args.push('-e', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(modelOverrides)) {
      args.push('-e', `${key}=${value}`);
    }
    if (
      runtimeEndpointEnvForContainer.ANTHROPIC_BASE_URL &&
      !hasAnthropicAuthEnvArg(args)
    ) {
      // Claude SDK expects an auth token env var to be present. When OneCLI
      // handles real credential injection, this placeholder is replaced at the
      // gateway layer and the real secret never enters the container.
      args.push('-e', `ANTHROPIC_AUTH_TOKEN=${ONECLI_AUTH_PLACEHOLDER}`);
    }
    if (modelOverrides.NANOCLAW_AGENT_MODEL === 'cu/default') {
      logger.info(
        { containerName },
        'Detected 9router endpoint; defaulting model override to cu/default',
      );
    }
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    const fallbackCredentials = collectFallbackCredentialEnv(
      runtimeEndpointEnvForContainer,
    );
    const passthroughEnv = {
      ...runtimeEndpointEnvForContainer,
      ...fallbackCredentials,
      ...modelOverrides,
    };

    for (const [key, value] of Object.entries(passthroughEnv)) {
      args.push('-e', `${key}=${value}`);
    }

    if (Object.keys(passthroughEnv).length > 0) {
      logger.warn(
        {
          containerName,
          fallbackKeys: Object.keys(passthroughEnv),
        },
        'OneCLI gateway not reachable — using .env credential passthrough fallback',
      );
    } else {
      logger.warn(
        { containerName },
        'OneCLI gateway not reachable and no fallback credentials found',
      );
    }
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push(...writableMountArgs(mount.hostPath, mount.containerPath));
    }
  }

  args.push(CONTAINER_IMAGE);

  return normalizeRuntimeArgs(args);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
  );
  const containerArgsForLogs = sanitizeContainerArgsForLogs(containerArgs);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgsForLogs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let timeoutReason: 'hard' | 'no_output' | null = null;
    let hadStreamingOutput = false;
    let hadStructuredOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
    const initialOutputTimeoutMs = Math.max(
      1_000,
      Math.min(timeoutMs, CONTAINER_INITIAL_OUTPUT_TIMEOUT),
    );

    const stopContainerGracefully = (reason: string) => {
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err, reason },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    const killOnTimeout = () => {
      timedOut = true;
      timeoutReason = 'hard';
      logger.error(
        { group: group.name, containerName, timeoutMs },
        'Container timeout, stopping gracefully',
      );
      stopContainerGracefully('hard_timeout');
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the hard timeout whenever there's structured output activity
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    const killOnInitialOutputTimeout = () => {
      if (hadStructuredOutput) return;
      timedOut = true;
      timeoutReason = 'no_output';
      logger.error(
        { group: group.name, containerName, initialOutputTimeoutMs },
        'Container produced no structured output before initial timeout',
      );
      stopContainerGracefully('initial_output_timeout');
    };

    const initialOutputTimeout = setTimeout(
      killOnInitialOutputTimeout,
      initialOutputTimeoutMs,
    );

    const clearInitialOutputTimeout = () => {
      clearTimeout(initialOutputTimeout);
    };

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (
        chunk.includes(OUTPUT_START_MARKER) ||
        chunk.includes(OUTPUT_END_MARKER)
      ) {
        hadStructuredOutput = true;
        clearInitialOutputTimeout();
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      clearTimeout(timeout);
      clearInitialOutputTimeout();
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Timeout Reason: ${timeoutReason || 'unknown'}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        if (timeoutReason === 'no_output') {
          logger.error(
            {
              group: group.name,
              containerName,
              duration,
              code,
              initialOutputTimeoutMs,
            },
            'Container timed out waiting for initial structured output',
          );
          resolve({
            status: 'error',
            result: null,
            error: `Container produced no output within ${initialOutputTimeoutMs}ms. Check credentials/channel setup.`,
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code, configTimeout },
          'Container timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgsForLogs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      clearInitialOutputTimeout();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableOpenClawSkill {
  chatJid: string;
  groupFolder: string;
  groupName: string;
  skillId: string;
  displayName: string;
  sourceUrl: string;
  canonicalClawHubUrl: string | null;
  githubTreeUrl: string;
  installDirName: string;
  enabledAt: string;
  security: {
    virusTotalStatus: string | null;
    openClawStatus: string | null;
    openClawSummary: string | null;
  };
}

export function writeOpenClawSkillsSnapshot(
  groupFolder: string,
  isMain: boolean,
  skills: AvailableOpenClawSkill[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleSkills = isMain
    ? skills
    : skills.filter((skill) => skill.groupFolder === groupFolder);

  const skillsFile = path.join(groupIpcDir, 'current_openclaw_skills.json');
  fs.writeFileSync(
    skillsFile,
    JSON.stringify(
      {
        skills: visibleSkills,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export interface AvailableCursorArtifact {
  absolutePath: string;
  sizeBytes: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  syncedAt: string;
}

export interface AvailableCursorAgent {
  id: string;
  chatJid: string;
  groupFolder: string;
  groupName: string;
  status: string;
  model: string | null;
  promptText: string;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourcePrUrl: string | null;
  targetUrl: string | null;
  targetPrUrl: string | null;
  targetBranchName: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  artifacts: AvailableCursorArtifact[];
}

export function writeCursorAgentsSnapshot(
  groupFolder: string,
  isMain: boolean,
  agents: AvailableCursorAgent[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleAgents = isMain
    ? agents
    : agents.filter((agent) => agent.groupFolder === groupFolder);

  const cursorFile = path.join(groupIpcDir, 'current_cursor_agents.json');
  fs.writeFileSync(
    cursorFile,
    JSON.stringify(
      {
        agents: visibleAgents,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
