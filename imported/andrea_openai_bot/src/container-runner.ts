/**
 * Container runner for Andrea.
 * Spawns agent execution in containers and handles IPC.
 */
import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AGENT_RUNTIME_DEFAULT,
  AGENT_RUNTIME_FALLBACK,
  CODEX_LOCAL_ENABLED,
  CODEX_LOCAL_MODEL,
  CONTAINER_IMAGE,
  CONTAINER_INITIAL_OUTPUT_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  OPENAI_MODEL_FALLBACK,
  RUNTIME_STATE_DIR,
  TIMEZONE,
} from './config.js';
import { seedCodexHomeFromHost } from './codex-home.js';
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
import { AgentRuntimeName, RegisteredGroup, RuntimeRoute } from './types.js';
import type { AssistantRequestPolicy } from './assistant-routing.js';
import {
  CONTAINER_CLOSE_GRACE_PERIOD_MS,
  resolveEffectiveIdleTimeout,
} from './runtime-timeout.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  preferredRuntime?: AgentRuntimeName;
  fallbackRuntime?: AgentRuntimeName;
  runtimeRoute?: RuntimeRoute;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  requestPolicy?: AssistantRequestPolicy;
  idleTimeoutMs?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  runtime?: AgentRuntimeName;
  error?: string;
  logFile?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

const FALLBACK_CREDENTIAL_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

const LOOPBACK_ENDPOINT_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CONTAINER_HOST_ALIAS_HOSTS = new Set([
  'host.containers.internal',
  'host.docker.internal',
]);
const LOG_SAFE_ENV_KEYS = new Set([
  'TZ',
  'HOME',
  'CODEX_HOME',
  'AGENT_RUNTIME_DEFAULT',
  'AGENT_RUNTIME_FALLBACK',
  'CODEX_LOCAL_ENABLED',
  'CODEX_LOCAL_MODEL',
  'OPENAI_MODEL_FALLBACK',
  'NANOCLAW_CONTAINER_RUNTIME',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
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

function parseStructuredContainerOutput(
  stdout: string,
): ContainerOutput | null {
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

  let jsonLine: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonLine = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines.at(-1);
    if (!lastLine) return null;
    jsonLine = lastLine;
  }

  try {
    return JSON.parse(jsonLine) as ContainerOutput;
  } catch {
    return null;
  }
}

function buildOutputTail(text: string, label: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const tail = lines.slice(-8).join(' | ');
  const normalizedTail = tail.length > 400 ? `${tail.slice(0, 397)}...` : tail;
  return `${label}: ${normalizedTail}`;
}

function buildRuntimeOutputHint(stdout: string, stderr: string): string | null {
  return (
    buildOutputTail(stderr, 'Last stderr') ||
    buildOutputTail(stdout, 'Last stdout')
  );
}

function ensureSecretShadowFile(): string {
  const shadowFile = path.join(RUNTIME_STATE_DIR, 'secret-shadow-empty');
  fs.mkdirSync(path.dirname(shadowFile), { recursive: true });
  if (!fs.existsSync(shadowFile)) {
    fs.writeFileSync(shadowFile, '');
  }
  return shadowFile;
}

function collectContainerCredentialEnv(): Record<string, string> {
  const fromEnvFile = readEnvFile(FALLBACK_CREDENTIAL_KEYS);
  const env: Record<string, string> = {};

  for (const key of FALLBACK_CREDENTIAL_KEYS) {
    const value = process.env[key] || fromEnvFile[key];
    if (value) {
      env[key] = value;
    }
  }

  if (!env.ANTHROPIC_BASE_URL && env.OPENAI_BASE_URL) {
    env.ANTHROPIC_BASE_URL = env.OPENAI_BASE_URL;
  }

  if (
    !env.ANTHROPIC_AUTH_TOKEN &&
    !env.ANTHROPIC_API_KEY &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    env.OPENAI_API_KEY &&
    env.ANTHROPIC_BASE_URL
  ) {
    env.ANTHROPIC_AUTH_TOKEN = env.OPENAI_API_KEY;
  }

  return env;
}

function rewriteEndpointForContainer(endpointValue: string): string {
  try {
    const endpoint = new URL(endpointValue);
    const host = endpoint.hostname.toLowerCase();
    if (
      LOOPBACK_ENDPOINT_HOSTS.has(host) ||
      CONTAINER_HOST_ALIAS_HOSTS.has(host)
    ) {
      endpoint.hostname = getContainerRuntimeHostAlias();
      return endpoint.toString();
    }
    return endpointValue;
  } catch {
    return endpointValue;
  }
}

function rewriteRuntimeEnvForContainer(
  input: Record<string, string>,
): Record<string, string> {
  const rewritten = { ...input };
  if (rewritten.OPENAI_BASE_URL) {
    rewritten.OPENAI_BASE_URL = rewriteEndpointForContainer(
      rewritten.OPENAI_BASE_URL,
    );
  }
  if (rewritten.ANTHROPIC_BASE_URL) {
    rewritten.ANTHROPIC_BASE_URL = rewriteEndpointForContainer(
      rewritten.ANTHROPIC_BASE_URL,
    );
  }
  return rewritten;
}

interface AgentRunnerSyncMetadata {
  sourceIndexHash: string;
  cachedIndexHash: string;
}

function hashText(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function tryReadTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readAgentRunnerSyncMetadata(
  metadataPath: string,
): AgentRunnerSyncMetadata | null {
  const raw = tryReadTextFile(metadataPath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentRunnerSyncMetadata>;
    if (
      typeof parsed.sourceIndexHash !== 'string' ||
      typeof parsed.cachedIndexHash !== 'string'
    ) {
      return null;
    }
    return {
      sourceIndexHash: parsed.sourceIndexHash,
      cachedIndexHash: parsed.cachedIndexHash,
    };
  } catch {
    return null;
  }
}

function writeAgentRunnerSyncMetadata(
  metadataPath: string,
  metadata: AgentRunnerSyncMetadata,
): void {
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
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

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  const groupCodexDir = path.join(DATA_DIR, 'sessions', group.folder, '.codex');
  fs.mkdirSync(groupCodexDir, { recursive: true });
  const copiedCodexSeedFiles = seedCodexHomeFromHost(groupCodexDir);
  if (copiedCodexSeedFiles.length > 0) {
    logger.info(
      { group: group.name, copiedCodexSeedFiles },
      'Seeded per-group Codex home from host auth state',
    );
  }
  mounts.push({
    hostPath: groupCodexDir,
    containerPath: '/home/node/.codex',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'rpc_requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'rpc_responses'), { recursive: true });
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
    const syncMetadataPath = path.join(
      groupAgentRunnerDir,
      '.andrea-source-sync.json',
    );
    const sourceIndex = tryReadTextFile(srcIndex);
    const cachedIndexContent = tryReadTextFile(cachedIndex);
    const syncMetadata = readAgentRunnerSyncMetadata(syncMetadataPath);
    const sourceIndexHash = sourceIndex ? hashText(sourceIndex) : null;
    const cachedIndexHash = cachedIndexContent
      ? hashText(cachedIndexContent)
      : null;
    const needsInitialContentSync =
      !syncMetadata &&
      Boolean(
        sourceIndexHash &&
        cachedIndexHash &&
        sourceIndexHash !== cachedIndexHash,
      );
    const cacheMissingOrIncomplete =
      !fs.existsSync(groupAgentRunnerDir) || !cachedIndexHash;
    const cacheMatchesLastSync = Boolean(
      syncMetadata &&
      cachedIndexHash &&
      syncMetadata.cachedIndexHash === cachedIndexHash,
    );
    const sourceChangedSinceLastSync = Boolean(
      syncMetadata &&
      sourceIndexHash &&
      syncMetadata.sourceIndexHash !== sourceIndexHash,
    );
    const needsCopy =
      cacheMissingOrIncomplete ||
      needsInitialContentSync ||
      (sourceChangedSinceLastSync && cacheMatchesLastSync);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
      const copiedIndex = tryReadTextFile(cachedIndex);
      if (sourceIndexHash && copiedIndex) {
        writeAgentRunnerSyncMetadata(syncMetadataPath, {
          sourceIndexHash,
          cachedIndexHash: hashText(copiedIndex),
        });
      }
    } else if (!syncMetadata && sourceIndexHash && cachedIndexHash) {
      writeAgentRunnerSyncMetadata(syncMetadataPath, {
        sourceIndexHash,
        cachedIndexHash,
      });
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
  const credentialEnv = rewriteRuntimeEnvForContainer(
    collectContainerCredentialEnv(),
  );

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', 'CODEX_HOME=/home/node/.codex');
  args.push('-e', `AGENT_RUNTIME_DEFAULT=${AGENT_RUNTIME_DEFAULT}`);
  args.push('-e', `AGENT_RUNTIME_FALLBACK=${AGENT_RUNTIME_FALLBACK}`);
  args.push(
    '-e',
    `CODEX_LOCAL_ENABLED=${CODEX_LOCAL_ENABLED ? 'true' : 'false'}`,
  );
  args.push('-e', `OPENAI_MODEL_FALLBACK=${OPENAI_MODEL_FALLBACK}`);
  args.push('-e', `NANOCLAW_CONTAINER_RUNTIME=${CONTAINER_RUNTIME_NAME}`);
  if (CODEX_LOCAL_MODEL) {
    args.push('-e', `CODEX_LOCAL_MODEL=${CODEX_LOCAL_MODEL}`);
  }
  for (const [key, value] of Object.entries(credentialEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
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
  const containerName = `andrea-runtime-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: sanitizeContainerArgsForLogs(containerArgs).join(' '),
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

      // Parse structured output markers as they arrive.
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
          hadStructuredOutput = true;
          clearTimeout(initialOutputTimeout);
          if (onOutput) {
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } else if (
            parsed.status === 'success' &&
            !requestedNonStreamingStop
          ) {
            requestedNonStreamingStop = true;
            stopContainerGracefully('non_streaming_output_complete');
          }
        } catch (err) {
          logger.warn(
            { group: group.name, error: err },
            'Failed to parse streamed output chunk',
          );
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

    let timedOut = false;
    let timeoutReason: 'hard' | 'no_output' | null = null;
    let hadStreamingOutput = false;
    let hadStructuredOutput = false;
    let requestedNonStreamingStop = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const effectiveIdleTimeout = resolveEffectiveIdleTimeout(
      input.idleTimeoutMs ?? IDLE_TIMEOUT,
      configTimeout,
    );
    const timeoutMs = Math.max(
      configTimeout,
      effectiveIdleTimeout + CONTAINER_CLOSE_GRACE_PERIOD_MS,
    );
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

    container.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(initialOutputTimeout);
      const duration = Date.now() - startTime;
      const runtimeOutputHint = buildRuntimeOutputHint(stdout, stderr);

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
            '',
            '--- STDOUT ---',
            stdout || '(empty)',
            '',
            '--- STDERR ---',
            stderr || '(empty)',
          ].join('\n'),
        );

        if (!onOutput) {
          const structuredOutputOnTimeout =
            parseStructuredContainerOutput(stdout);
          if (structuredOutputOnTimeout) {
            logger.warn(
              {
                group: group.name,
                containerName,
                duration,
                code,
                timeoutReason,
                runtime: structuredOutputOnTimeout.runtime,
              },
              'Container timed out after structured output in one-shot mode',
            );
            resolve({
              ...structuredOutputOnTimeout,
              logFile: timeoutLog,
            });
            return;
          }
        }

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
              logFile: timeoutLog,
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
              runtimeOutputHint,
            },
            'Container timed out waiting for initial structured output',
          );

          resolve({
            status: 'error',
            result: null,
            error: runtimeOutputHint
              ? `Container produced no structured output within ${initialOutputTimeoutMs}ms. ${runtimeOutputHint}`
              : `Container produced no structured output within ${initialOutputTimeoutMs}ms. Check credentials or runtime setup.`,
            logFile: timeoutLog,
          });
          return;
        }

        logger.error(
          {
            group: group.name,
            containerName,
            duration,
            code,
            configTimeout,
            runtimeOutputHint,
          },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: runtimeOutputHint
            ? `Container timed out after ${configTimeout}ms. ${runtimeOutputHint}`
            : `Container timed out after ${configTimeout}ms`,
          logFile: timeoutLog,
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
          sanitizeContainerArgsForLogs(containerArgs).join(' '),
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

      const structuredOutput = parseStructuredContainerOutput(stdout);

      if (code !== 0) {
        if (structuredOutput) {
          logger.warn(
            {
              group: group.name,
              code,
              duration,
              runtime: structuredOutput.runtime,
              structuredError: structuredOutput.error,
            },
            'Container exited non-zero but returned structured output',
          );
          resolve({
            ...structuredOutput,
            logFile,
          });
          return;
        }

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
          logFile,
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
            logFile,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        if (!structuredOutput) {
          throw new Error('No structured output markers found');
        }

        logger.info(
          {
            group: group.name,
            duration,
            status: structuredOutput.status,
            hasResult: !!structuredOutput.result,
          },
          'Container completed',
        );

        resolve({
          ...structuredOutput,
          logFile,
        });
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
          logFile,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      clearTimeout(initialOutputTimeout);
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
