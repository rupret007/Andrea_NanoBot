import {
  AGENT_RUNTIME_DEFAULT,
  AGENT_RUNTIME_FALLBACK,
  CODEX_LOCAL_ENABLED,
  CODEX_LOCAL_MODEL,
  OPENAI_MODEL_FALLBACK,
} from './config.js';
import { hasHostCodexAuthMaterial } from './codex-home.js';
import type { AssistantRequestPolicy } from './assistant-routing.js';
import type {
  AgentRuntimeName,
  AgentThreadState,
  RuntimeRoute,
} from './types.js';

const CLOUD_PREFERRED_MARKERS = [
  /\[runtime:\s*cloud\]/i,
  /\[cloud preferred\]/i,
  /\/runtime-cloud\b/i,
] as const;

const LOCAL_REQUIRED_MARKERS = [/\[runtime:\s*local\]/i] as const;

export interface AgentRuntimeStatusSnapshot {
  defaultRuntime: AgentRuntimeName;
  fallbackRuntime: AgentRuntimeName;
  codexLocalEnabled: boolean;
  codexLocalModel: string | null;
  codexLocalReady: boolean;
  hostCodexAuthPresent: boolean;
  openAiModelFallback: string;
  openAiApiKeyPresent: boolean;
  openAiCloudReady: boolean;
  openAiBaseUrl: string | null;
  activeThreadCount: number;
  activeJobCount: number;
  containerRuntimeName: string;
  containerRuntimeStatus: string;
}

export function canRouteToCloud(route: RuntimeRoute): boolean {
  return route !== 'local_required';
}

export function classifyRuntimeRoute(
  requestPolicy: Pick<AssistantRequestPolicy, 'route'>,
  prompt: string,
  options: { isScheduledTask?: boolean } = {},
): RuntimeRoute {
  const normalizedPrompt = prompt.trim();

  if (
    LOCAL_REQUIRED_MARKERS.some((pattern) => pattern.test(normalizedPrompt))
  ) {
    return 'local_required';
  }

  if (
    CLOUD_PREFERRED_MARKERS.some((pattern) => pattern.test(normalizedPrompt))
  ) {
    return 'cloud_preferred';
  }

  if (
    requestPolicy.route === 'direct_assistant' ||
    requestPolicy.route === 'protected_assistant'
  ) {
    return options.isScheduledTask ? 'cloud_allowed' : 'cloud_allowed';
  }

  return 'local_required';
}

export function selectPreferredRuntime(
  existingThread: AgentThreadState | undefined,
  runtimeRoute: RuntimeRoute,
): AgentRuntimeName {
  if (runtimeRoute === 'local_required') {
    return AGENT_RUNTIME_DEFAULT;
  }

  return existingThread?.runtime || AGENT_RUNTIME_DEFAULT;
}

export function shouldReuseExistingThread(
  existingThread: AgentThreadState | undefined,
  preferredRuntime: AgentRuntimeName,
): existingThread is AgentThreadState {
  return Boolean(existingThread && existingThread.runtime === preferredRuntime);
}

export function getAgentRuntimeStatusSnapshot(params: {
  activeThreads: Record<string, AgentThreadState>;
  activeJobs: number;
  containerRuntimeName: string;
  containerRuntimeStatus: string;
}): AgentRuntimeStatusSnapshot {
  const openAiApiKeyPresent = Boolean(process.env.OPENAI_API_KEY);
  const hostCodexAuthPresent = hasHostCodexAuthMaterial();

  return {
    defaultRuntime: AGENT_RUNTIME_DEFAULT,
    fallbackRuntime: AGENT_RUNTIME_FALLBACK,
    codexLocalEnabled: CODEX_LOCAL_ENABLED,
    codexLocalModel: CODEX_LOCAL_MODEL || null,
    codexLocalReady:
      CODEX_LOCAL_ENABLED && (openAiApiKeyPresent || hostCodexAuthPresent),
    hostCodexAuthPresent,
    openAiModelFallback: OPENAI_MODEL_FALLBACK,
    openAiApiKeyPresent,
    openAiCloudReady: openAiApiKeyPresent,
    openAiBaseUrl: process.env.OPENAI_BASE_URL || null,
    activeThreadCount: Object.keys(params.activeThreads).length,
    activeJobCount: params.activeJobs,
    containerRuntimeName: params.containerRuntimeName,
    containerRuntimeStatus: params.containerRuntimeStatus,
  };
}

export function formatAgentRuntimeStatusMessage(
  snapshot: AgentRuntimeStatusSnapshot,
): string {
  return [
    '*Andrea Runtime Status*',
    `- Local default: ${snapshot.defaultRuntime}`,
    `- Cloud fallback: ${snapshot.fallbackRuntime}`,
    `- Codex local enabled: ${snapshot.codexLocalEnabled ? 'yes' : 'no'}`,
    `- Codex local readiness: ${snapshot.codexLocalReady ? 'ready' : 'conditional'}`,
    `- Host Codex auth seed available: ${snapshot.hostCodexAuthPresent ? 'yes' : 'no'}`,
    snapshot.codexLocalModel
      ? `- Codex local model override: ${snapshot.codexLocalModel}`
      : null,
    `- OpenAI cloud model: ${snapshot.openAiModelFallback}`,
    `- OpenAI key present: ${snapshot.openAiApiKeyPresent ? 'yes' : 'no'}`,
    `- OpenAI cloud readiness: ${snapshot.openAiCloudReady ? 'ready' : 'missing credentials'}`,
    snapshot.openAiBaseUrl
      ? `- OpenAI base URL: ${snapshot.openAiBaseUrl}`
      : null,
    `- Container runtime: ${snapshot.containerRuntimeName} (${snapshot.containerRuntimeStatus})`,
    `- Active jobs: ${snapshot.activeJobCount}`,
    `- Stored runtime threads: ${snapshot.activeThreadCount}`,
    '- Note: openai_cloud is currently a limited text fallback, not full local tool parity.',
    '- Operator commands: /runtime-status, /runtime-jobs, /runtime-followup, /runtime-stop, /runtime-logs',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
