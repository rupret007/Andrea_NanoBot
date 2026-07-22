import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  ANDREA_OPENAI_BACKEND_ENABLED,
  ANDREA_OPENAI_BACKEND_TIMEOUT_MS,
  ANDREA_OPENAI_BACKEND_URL,
} from './config.js';
import { AndreaOpenAiBackendClient } from './andrea-openai-backend.js';
import { hasHostCodexAuthMaterial } from './andrea-runtime/codex-home.js';
import {
  CursorCloudClient,
  getCursorCloudStatus,
  resolveCursorCloudConfig,
} from './cursor-cloud.js';
import { getCursorDesktopStatus } from './cursor-desktop.js';
import { inspectCursorDesktopEntrypoints } from './cursor-desktop-entrypoints.js';
import { getOpenAiProviderStatus } from './openai-provider.js';
import type { CodingOperationClass } from './coding-work-contract.js';

const execFileAsync = promisify(execFile);

export const CODING_CAPABILITY_REGISTRY_VERSION = 1 as const;

export type CodingCapabilityId =
  | 'cursor_cloud'
  | 'cursor_desktop_terminal'
  | 'cursor_desktop_agent'
  | 'codex_cli'
  | 'codex_local_backend'
  | 'openai_fallback';

export type CodingCapabilityState =
  | 'disabled'
  | 'configured'
  | 'reachable'
  | 'authenticated'
  | 'ready'
  | 'degraded'
  | 'needs-proof'
  | 'external-block'
  | 'policy-block';

export type CodingLocality = 'local' | 'cloud' | 'hybrid';
export type CodingMutability =
  | 'read_only'
  | 'isolated_workspace'
  | 'remote_workspace'
  | 'operator_terminal';

export interface CodingCapabilityProof {
  source:
    | 'configuration'
    | 'filesystem'
    | 'process'
    | 'health_probe'
    | 'api_probe';
  observedAt: string;
  summary: string;
  identity: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CodingCapabilityRecord {
  registryVersion: typeof CODING_CAPABILITY_REGISTRY_VERSION;
  id: CodingCapabilityId;
  label: string;
  provider: 'cursor' | 'codex' | 'openai';
  surface: string;
  state: CodingCapabilityState;
  operations: readonly CodingOperationClass[];
  locality: CodingLocality;
  mutability: CodingMutability;
  approvals: readonly CodingOperationClass[];
  proof: readonly CodingCapabilityProof[];
  blocker: string | null;
  nextAction: string | null;
}

export interface CodingCapabilityEvidence {
  observedAt: string;
  cursorCloud: {
    configured: boolean;
    probed: boolean;
    reachable: boolean;
    authenticated: boolean;
    detail: string | null;
  };
  cursorDesktop: {
    appInstalled: boolean;
    configured: boolean;
    probed: boolean;
    reachable: boolean;
    terminalAvailable: boolean;
    agentCompatibility: 'validated' | 'failed' | 'unknown';
    agentCliDetected?: boolean;
    cliPath: string | null;
    detail: string | null;
  };
  codexCli: {
    installed: boolean;
    binaryPath: string | null;
    version: string | null;
    authMaterialPresent: boolean;
    authProbed: boolean;
    authenticated: boolean;
    detail: string | null;
  };
  codexBackend: {
    enabled: boolean;
    configured: boolean;
    probed: boolean;
    reachable: boolean;
    authenticated: boolean;
    executionReady: boolean;
    version: string | null;
    detail: string | null;
  };
  openAiFallback: {
    configured: boolean;
  };
}

export interface CodingLaneSelection {
  outcome: 'selected' | 'unavailable' | 'clarification_required';
  lane: 'cursor' | 'codex' | null;
  capabilityId: CodingCapabilityId | null;
  fallbackUsed: boolean;
  disclosure: string;
}

const READ_ONLY_OPERATIONS: readonly CodingOperationClass[] = [
  'analysis',
  'repository_read',
];
const WORKSPACE_OPERATIONS: readonly CodingOperationClass[] = [
  ...READ_ONLY_OPERATIONS,
  'code_edit',
  'test',
];
const SEPARATE_APPROVAL_OPERATIONS: readonly CodingOperationClass[] = [
  'dependency_install',
  'commit',
  'push',
  'pull_request',
  'merge',
  'deploy',
  'destructive_git',
  'production_change',
  'external_mutation',
  'message',
];

function proof(
  source: CodingCapabilityProof['source'],
  observedAt: string,
  summary: string,
  identity: CodingCapabilityProof['identity'] = {},
): CodingCapabilityProof {
  return { source, observedAt, summary, identity };
}

function record(
  input: Omit<CodingCapabilityRecord, 'registryVersion'>,
): CodingCapabilityRecord {
  return { registryVersion: CODING_CAPABILITY_REGISTRY_VERSION, ...input };
}

function deriveCursorCloud(
  evidence: CodingCapabilityEvidence,
): CodingCapabilityRecord {
  const item = evidence.cursorCloud;
  const state: CodingCapabilityState = !item.configured
    ? 'disabled'
    : !item.probed
      ? 'configured'
      : !item.reachable
        ? 'external-block'
        : !item.authenticated
          ? 'external-block'
          : 'ready';
  return record({
    id: 'cursor_cloud',
    label: 'Cursor Cloud coding agent',
    provider: 'cursor',
    surface: 'cloud_agent',
    state,
    operations: WORKSPACE_OPERATIONS,
    locality: 'cloud',
    mutability: 'remote_workspace',
    approvals: SEPARATE_APPROVAL_OPERATIONS,
    proof: [
      proof(
        'configuration',
        evidence.observedAt,
        item.configured
          ? 'API credential is configured.'
          : 'API credential is absent.',
      ),
      ...(item.probed
        ? [
            proof(
              'api_probe',
              evidence.observedAt,
              item.authenticated
                ? 'Authenticated read-only model probe passed.'
                : 'Read-only model probe did not prove readiness.',
            ),
          ]
        : []),
    ],
    blocker:
      state === 'disabled'
        ? 'Cursor Cloud API credentials are not configured.'
        : state === 'external-block'
          ? item.detail ||
            'Cursor Cloud did not pass its authenticated reachability probe.'
          : null,
    nextAction:
      state === 'disabled'
        ? 'Configure CURSOR_API_KEY without placing it in logs or chat.'
        : state === 'configured'
          ? 'Run the read-only coding capability probe before routing work here.'
          : state === 'external-block'
            ? 'Restore Cursor Cloud authentication or reachability, then rerun the probe.'
            : null,
  });
}

function deriveCursorDesktopTerminal(
  evidence: CodingCapabilityEvidence,
): CodingCapabilityRecord {
  const item = evidence.cursorDesktop;
  const state: CodingCapabilityState =
    !item.appInstalled && !item.configured
      ? 'disabled'
      : !item.configured
        ? 'needs-proof'
        : !item.probed
          ? 'configured'
          : !item.reachable
            ? 'external-block'
            : !item.terminalAvailable
              ? 'degraded'
              : 'ready';
  return record({
    id: 'cursor_desktop_terminal',
    label: 'Cursor desktop terminal/session bridge',
    provider: 'cursor',
    surface: 'desktop_terminal',
    state,
    operations: ['repository_read', 'test'],
    locality: 'local',
    mutability: 'operator_terminal',
    approvals: ['code_edit', ...SEPARATE_APPROVAL_OPERATIONS],
    proof: [
      proof(
        'filesystem',
        evidence.observedAt,
        item.agentCliDetected
          ? 'A standalone Cursor agent executable exists; execution proof remains separate.'
          : item.appInstalled
            ? 'Cursor.app is installed, but no standalone agent executable was detected.'
            : 'Cursor.app was not found.',
      ),
      proof(
        'configuration',
        evidence.observedAt,
        item.configured
          ? 'Desktop bridge endpoint and token are configured.'
          : 'Desktop bridge configuration is incomplete.',
      ),
      ...(item.probed
        ? [
            proof(
              'health_probe',
              evidence.observedAt,
              item.reachable
                ? 'Desktop bridge health probe passed.'
                : 'Desktop bridge health probe failed.',
              { cliDetected: Boolean(item.cliPath) },
            ),
          ]
        : []),
    ],
    blocker:
      state === 'needs-proof'
        ? 'Cursor.app presence does not prove a supervised desktop bridge.'
        : state === 'external-block' || state === 'degraded'
          ? item.detail || 'Cursor desktop bridge is not ready.'
          : null,
    nextAction:
      state === 'needs-proof'
        ? 'Install/configure the loopback desktop bridge service and prove terminal/session health.'
        : state === 'configured'
          ? 'Run the desktop bridge health probe.'
          : state === 'external-block' || state === 'degraded'
            ? 'Repair the desktop bridge service, then rerun the health probe.'
            : null,
  });
}

function deriveCursorDesktopAgent(
  evidence: CodingCapabilityEvidence,
): CodingCapabilityRecord {
  const item = evidence.cursorDesktop;
  const bridgeReady = item.configured && item.probed && item.reachable;
  const state: CodingCapabilityState = !item.appInstalled
    ? 'disabled'
    : !bridgeReady
      ? 'needs-proof'
      : item.agentCompatibility === 'failed'
        ? 'external-block'
        : item.agentCompatibility === 'unknown'
          ? 'needs-proof'
          : 'ready';
  return record({
    id: 'cursor_desktop_agent',
    label: 'Cursor desktop coding agent',
    provider: 'cursor',
    surface: 'desktop_agent',
    state,
    operations: WORKSPACE_OPERATIONS,
    locality: 'local',
    mutability: 'isolated_workspace',
    approvals: SEPARATE_APPROVAL_OPERATIONS,
    proof: [
      proof(
        'filesystem',
        evidence.observedAt,
        item.appInstalled
          ? 'Cursor.app is installed.'
          : 'Cursor.app was not found.',
      ),
      ...(bridgeReady
        ? [
            proof(
              'health_probe',
              evidence.observedAt,
              `Desktop agent compatibility: ${item.agentCompatibility}.`,
              { cliDetected: Boolean(item.cliPath) },
            ),
          ]
        : []),
    ],
    blocker:
      state === 'ready'
        ? null
        : item.agentCompatibility === 'failed'
          ? item.detail ||
            'Installed Cursor CLI does not provide proven agent execution.'
          : 'Cursor desktop agent execution has not been proven; app presence is insufficient.',
    nextAction:
      state === 'ready'
        ? null
        : 'Provide a supported non-GUI Cursor agent CLI and pass the isolated disposable-repository proof.',
  });
}

function deriveCodexCli(
  evidence: CodingCapabilityEvidence,
): CodingCapabilityRecord {
  const item = evidence.codexCli;
  const state: CodingCapabilityState = !item.installed
    ? 'disabled'
    : !item.authMaterialPresent
      ? 'external-block'
      : !item.authProbed
        ? 'configured'
        : !item.authenticated
          ? 'external-block'
          : 'ready';
  return record({
    id: 'codex_cli',
    label: 'Local Codex CLI',
    provider: 'codex',
    surface: 'host_cli',
    state,
    operations: WORKSPACE_OPERATIONS,
    locality: 'local',
    mutability: 'isolated_workspace',
    approvals: SEPARATE_APPROVAL_OPERATIONS,
    proof: [
      proof(
        'filesystem',
        evidence.observedAt,
        item.installed
          ? 'Executable Codex binary was found.'
          : 'Codex binary was not found.',
        {
          version: item.version,
        },
      ),
      proof(
        'configuration',
        evidence.observedAt,
        item.authMaterialPresent
          ? 'Host Codex authentication material is present; contents were not read or copied.'
          : 'Host Codex authentication material is absent.',
      ),
      ...(item.authProbed
        ? [
            proof(
              'process',
              evidence.observedAt,
              item.authenticated
                ? 'Codex login status passed without exposing credentials.'
                : 'Codex login status did not prove authentication.',
            ),
          ]
        : []),
    ],
    blocker:
      state === 'disabled'
        ? 'Codex CLI is not installed in an approved executable location.'
        : state === 'external-block'
          ? item.detail || 'Codex CLI authentication is unavailable.'
          : null,
    nextAction:
      state === 'configured'
        ? 'Run the non-mutating Codex login-status probe.'
        : state === 'external-block'
          ? 'Authenticate Codex on the host, then rerun the probe; do not copy credentials.'
          : state === 'disabled'
            ? 'Install Codex in an approved host location.'
            : null,
  });
}

function deriveCodexBackend(
  evidence: CodingCapabilityEvidence,
): CodingCapabilityRecord {
  const item = evidence.codexBackend;
  const state: CodingCapabilityState = !item.configured
    ? 'disabled'
    : !item.enabled
      ? 'policy-block'
      : !item.probed
        ? 'configured'
        : !item.reachable
          ? 'external-block'
          : !item.authenticated
            ? 'external-block'
            : !item.executionReady
              ? 'degraded'
              : 'ready';
  return record({
    id: 'codex_local_backend',
    label: 'Andrea supervised Codex backend',
    provider: 'codex',
    surface: 'loopback_service',
    state,
    operations: WORKSPACE_OPERATIONS,
    locality: 'local',
    mutability: 'isolated_workspace',
    approvals: SEPARATE_APPROVAL_OPERATIONS,
    proof: [
      proof(
        'configuration',
        evidence.observedAt,
        item.enabled
          ? 'Backend lane is enabled by policy.'
          : 'Backend lane is disabled by policy.',
        {
          loopbackConfigured: item.configured,
        },
      ),
      ...(item.probed
        ? [
            proof(
              'health_probe',
              evidence.observedAt,
              item.reachable
                ? 'Loopback backend health probe passed.'
                : 'Loopback backend health probe failed.',
              { version: item.version },
            ),
          ]
        : []),
    ],
    blocker:
      state === 'policy-block'
        ? 'Local Codex dispatch is disabled in Andrea configuration.'
        : state === 'external-block' || state === 'degraded'
          ? item.detail || 'Supervised Codex backend is not execution-ready.'
          : null,
    nextAction:
      state === 'policy-block'
        ? 'After owner review, enable the backend lane and restart separately; this task does not alter production configuration.'
        : state === 'configured'
          ? 'Run the loopback backend health probe.'
          : state === 'external-block' || state === 'degraded'
            ? 'Start or repair the supervised loopback backend, then rerun the probe.'
            : null,
  });
}

function deriveOpenAiFallback(
  evidence: CodingCapabilityEvidence,
): CodingCapabilityRecord {
  const configured = evidence.openAiFallback.configured;
  return record({
    id: 'openai_fallback',
    label: 'OpenAI text fallback',
    provider: 'openai',
    surface: 'text_model',
    state: configured ? 'configured' : 'disabled',
    operations: ['analysis'],
    locality: 'cloud',
    mutability: 'read_only',
    approvals: [],
    proof: [
      proof(
        'configuration',
        evidence.observedAt,
        configured
          ? 'OpenAI credentials are configured; no coding-tool parity is implied.'
          : 'OpenAI credentials are absent.',
      ),
    ],
    blocker: configured
      ? 'This surface has not proven filesystem or coding-agent authority.'
      : 'OpenAI credentials are not configured.',
    nextAction: configured
      ? 'Use only for bounded analysis; do not treat it as a code-editing fallback.'
      : 'Configure OpenAI only if a text-analysis fallback is desired.',
  });
}

function laneCapabilities(
  lane: 'cursor' | 'codex',
): readonly CodingCapabilityId[] {
  return lane === 'cursor'
    ? ['cursor_cloud', 'cursor_desktop_agent']
    : ['codex_local_backend'];
}

export class CodingCapabilityRegistry {
  private readonly entries = new Map<
    CodingCapabilityId,
    CodingCapabilityRecord
  >();

  constructor(readonly evidence: CodingCapabilityEvidence) {
    for (const entry of [
      deriveCursorCloud(evidence),
      deriveCursorDesktopTerminal(evidence),
      deriveCursorDesktopAgent(evidence),
      deriveCodexCli(evidence),
      deriveCodexBackend(evidence),
      deriveOpenAiFallback(evidence),
    ]) {
      this.entries.set(entry.id, entry);
    }
  }

  get(id: CodingCapabilityId): CodingCapabilityRecord {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown coding capability: ${id}`);
    return entry;
  }

  list(): CodingCapabilityRecord[] {
    return [...this.entries.values()];
  }

  readyFor(
    lane: 'cursor' | 'codex',
    operations: readonly CodingOperationClass[],
  ): CodingCapabilityRecord[] {
    return laneCapabilities(lane)
      .map((id) => this.get(id))
      .filter(
        (entry) =>
          entry.state === 'ready' &&
          operations.every((operation) => entry.operations.includes(operation)),
      );
  }

  selectLane(input: {
    requestedLane: 'auto' | 'cursor' | 'codex';
    preferredLane?: 'cursor' | 'codex' | null;
    operations: readonly CodingOperationClass[];
  }): CodingLaneSelection {
    const lanes: readonly ('cursor' | 'codex')[] = input.preferredLane
      ? [
          input.preferredLane,
          input.preferredLane === 'cursor' ? 'codex' : 'cursor',
        ]
      : ['codex', 'cursor'];
    if (input.requestedLane !== 'auto') {
      const available = this.readyFor(input.requestedLane, input.operations)[0];
      return available
        ? {
            outcome: 'selected',
            lane: input.requestedLane,
            capabilityId: available.id,
            fallbackUsed: false,
            disclosure: `Using explicitly requested ${input.requestedLane} lane via ${available.label}.`,
          }
        : {
            outcome: 'unavailable',
            lane: null,
            capabilityId: null,
            fallbackUsed: false,
            disclosure: `The explicitly requested ${input.requestedLane} lane is not ready for every requested operation; no lane was substituted.`,
          };
    }

    for (const [index, lane] of lanes.entries()) {
      const available = this.readyFor(lane, input.operations)[0];
      if (available) {
        const fallbackUsed = index > 0;
        return {
          outcome: 'selected',
          lane,
          capabilityId: available.id,
          fallbackUsed,
          disclosure: fallbackUsed
            ? `Auto routing used ${lane} because the preferred ${lanes[0]} lane was not ready for the requested operations.`
            : `Auto routing selected ready ${lane} capability ${available.label}.`,
        };
      }
    }
    return {
      outcome: 'unavailable',
      lane: null,
      capabilityId: null,
      fallbackUsed: false,
      disclosure:
        'No ready coding lane supports every requested operation. No job was started.',
    };
  }
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.ANDREA_CODEX_BINARY?.trim();
  const candidates = [
    explicit,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...(env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, 'codex')),
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !isExecutable(candidate)) continue;
    try {
      return fs.realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(sk-[A-Za-z0-9_-]{8,}|bearer\s+\S+|token[=:]\s*\S+)/gi,
      '[redacted]',
    )
    .slice(0, 300);
}

export async function inspectCodingCapabilities(
  options: {
    probe?: boolean;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<CodingCapabilityRegistry> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const observedAt = now.toISOString();
  const cursorCloudStatus = getCursorCloudStatus({ env });
  const cursorDesktopStatus = await getCursorDesktopStatus({
    env,
    probe: options.probe,
  });
  const cursorEntrypoints = inspectCursorDesktopEntrypoints(env);
  const codexBinary = findCodexBinary(env);
  const authMaterialPresent = hasHostCodexAuthMaterial(env);

  let cursorCloudProbe = {
    probed: false,
    reachable: false,
    authenticated: false,
    detail: null as string | null,
  };
  if (options.probe && cursorCloudStatus.enabled) {
    cursorCloudProbe.probed = true;
    try {
      const config = resolveCursorCloudConfig({ env });
      if (!config) throw new Error('Cursor Cloud configuration is incomplete.');
      await new CursorCloudClient(config).listModels();
      cursorCloudProbe = {
        probed: true,
        reachable: true,
        authenticated: true,
        detail: null,
      };
    } catch (error) {
      cursorCloudProbe.detail = safeDetail(error);
    }
  }

  let codexVersion: string | null = null;
  let codexAuthProbed = false;
  let codexAuthenticated = false;
  let codexDetail: string | null = null;
  if (codexBinary) {
    try {
      const result = await execFileAsync(codexBinary, ['--version'], {
        timeout: 5_000,
        env: { ...env },
      });
      codexVersion = result.stdout.trim().slice(0, 120) || null;
    } catch (error) {
      codexDetail = safeDetail(error);
    }
    if (options.probe && authMaterialPresent) {
      codexAuthProbed = true;
      try {
        await execFileAsync(codexBinary, ['login', 'status'], {
          timeout: 10_000,
          env: { ...env },
        });
        codexAuthenticated = true;
      } catch (error) {
        codexDetail = safeDetail(error);
      }
    }
  }

  let backendProbe = {
    probed: false,
    reachable: false,
    authenticated: false,
    executionReady: false,
    version: null as string | null,
    detail: null as string | null,
  };
  if (options.probe) {
    backendProbe.probed = true;
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      baseUrl: ANDREA_OPENAI_BACKEND_URL,
      timeoutMs: Math.min(ANDREA_OPENAI_BACKEND_TIMEOUT_MS, 5_000),
    });
    const status = await client.getStatus();
    backendProbe = {
      probed: true,
      reachable: status.state !== 'unavailable',
      authenticated:
        status.state === 'available' || status.state === 'not_ready',
      executionReady: status.state === 'available',
      version: status.version,
      detail: status.detail,
    };
  }

  const openAi = getOpenAiProviderStatus();
  return new CodingCapabilityRegistry({
    observedAt,
    cursorCloud: {
      configured: cursorCloudStatus.enabled,
      ...cursorCloudProbe,
    },
    cursorDesktop: {
      appInstalled: cursorEntrypoints.appInstalled,
      configured: cursorDesktopStatus.enabled,
      probed: cursorDesktopStatus.probeStatus !== 'skipped',
      reachable: cursorDesktopStatus.probeStatus === 'ok',
      terminalAvailable: cursorDesktopStatus.terminalAvailable,
      agentCompatibility: cursorDesktopStatus.agentJobCompatibility,
      agentCliDetected: Boolean(cursorEntrypoints.agentCliPath),
      cliPath: cursorDesktopStatus.cliPath,
      detail:
        cursorDesktopStatus.probeDetail ||
        cursorDesktopStatus.agentJobDetail ||
        cursorEntrypoints.detail,
    },
    codexCli: {
      installed: Boolean(codexBinary),
      binaryPath: codexBinary,
      version: codexVersion,
      authMaterialPresent,
      authProbed: codexAuthProbed,
      authenticated: codexAuthenticated,
      detail: codexDetail,
    },
    codexBackend: {
      enabled: ANDREA_OPENAI_BACKEND_ENABLED,
      configured:
        ANDREA_OPENAI_BACKEND_URL.startsWith('http://127.0.0.1:') ||
        ANDREA_OPENAI_BACKEND_URL.startsWith('http://localhost:'),
      ...backendProbe,
    },
    openAiFallback: { configured: openAi.configured },
  });
}

export function formatCodingCapabilityRegistry(
  registry: CodingCapabilityRegistry,
): string {
  const lines = ['*Verified Coding Capabilities*'];
  for (const entry of registry.list()) {
    lines.push(
      `- ${entry.label}: ${entry.state} [${entry.locality}; ${entry.mutability}]`,
    );
    if (entry.blocker) lines.push(`  blocker: ${entry.blocker}`);
    if (entry.nextAction) lines.push(`  next: ${entry.nextAction}`);
  }
  lines.push(
    '- Authority: coding access never implies push, merge, deploy, destructive Git, production changes, messaging, or other external mutation.',
  );
  return lines.join('\n');
}

export function isCodingCapabilityQuestion(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\bcan you (?:code|program|use (?:cursor|codex)|build (?:me )?(?:a |an )?(?:game|app|website|tool|program))\b/.test(
      normalized,
    ) ||
    /\bdo you (?:have|still have) (?:access to |the ability to use )?(?:cursor|codex)\b/.test(
      normalized,
    ) ||
    /\b(?:is|are) (?:cursor|codex|your coding tools?) (?:available|working|ready|connected)\b/.test(
      normalized,
    ) ||
    /^(?:please )?build (?:me )?(?:a |an )?(?:game|app|website|tool|program)\b/.test(
      normalized,
    )
  );
}

export function formatCodingCapabilityAnswer(
  registry: CodingCapabilityRegistry,
  question: string,
): string {
  const cursor = registry.get('cursor_cloud');
  const cursorDesktop = registry.get('cursor_desktop_agent');
  const codexCli = registry.get('codex_cli');
  const codexBackend = registry.get('codex_local_backend');
  const asksToBuild = /\bbuild\b/i.test(question);
  const readyLanes = [
    cursor.state === 'ready' ? 'Cursor Cloud' : null,
    cursorDesktop.state === 'ready' ? 'Cursor desktop agent' : null,
    codexBackend.state === 'ready' ? 'supervised local Codex' : null,
  ].filter((entry): entry is string => Boolean(entry));
  const lines = [
    readyLanes.length > 0
      ? `Yes—I can do supervised coding work through ${readyLanes.join(' and ')}.`
      : 'I can analyze and plan coding work, but I do not currently have a proven execution-ready coding lane.',
    `Cursor Cloud: ${cursor.state}. Cursor desktop agent: ${cursorDesktop.state}. Local Codex CLI: ${codexCli.state}. Andrea Codex dispatch: ${codexBackend.state}.`,
    codexCli.state === 'ready' && codexBackend.state !== 'ready'
      ? 'Codex itself is installed and authenticated, but Andrea cannot start it until the supervised loopback backend is enabled and healthy.'
      : null,
    asksToBuild
      ? 'I have not started a job from this ordinary chat request. Give me the repository, the exact outcome, and any constraints; then use `/job` or `/work` with an explicit lane, or let auto routing disclose which ready lane it selects.'
      : 'Checking capability does not start a job. Use `/job` or `/work` when you want explicit delegated coding work.',
    'Coding authority covers only the approved repository task; it never silently includes installing dependencies, committing, pushing, opening or merging a PR, deploying, changing production, or messaging anyone.',
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}
