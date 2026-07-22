import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { writeJsonFileAtomic } from './atomic-json-file.js';
import {
  buildCodingDelegationPacket,
  verifyCodingWorkClaims,
  type CodingDelegationPacket,
  type CodingVerificationEvidence,
  type CodingWorkClaim,
  type CodingWorkResult,
} from './coding-work-contract.js';
import { findCodexBinary } from './coding-capability-registry.js';
import type {
  OrchestrationSource,
  RuntimeBackendJob,
  RuntimeBackendJobList,
  RuntimeBackendJobLogs,
  RuntimeBackendMeta,
  RuntimeBackendStopResult,
} from './types.js';

export const CODEX_LOCAL_SERVICE_VERSION = 'verified-coding-agency-v1';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const SAFE_GROUP_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_JOB_ID = /^codex_[a-f0-9-]{36}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key|keystore)$/i,
] as const;

interface RegisteredCodexGroup {
  folder: string;
  jid: string;
  name: string | null;
  registeredAt: string;
}

interface StoredCodexJob {
  publicJob: RuntimeBackendJob;
  packet: CodingDelegationPacket;
  sourceRepositoryRoot: string;
  worktreeRoot: string;
  threadId: string | null;
  logFile: string;
  outputFile: string;
  codingWorkResult: CodingWorkResult | null;
  worktreeCleanedAt?: string | null;
}

interface PendingInvocation {
  stored: StoredCodexJob;
  prompt: string;
  resumeThreadId: string | null;
}

export interface CodexLocalServiceConfig {
  host: string;
  port: number;
  stateDir: string;
  allowedRepositoryRoots: readonly string[];
  repositoryByGroup: Readonly<Record<string, string>>;
  defaultRepositoryRoot: string | null;
  codexBinary: string;
  codexArgsPrefix: readonly string[];
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  buildIdentity: string;
  verificationCommands: readonly (readonly string[])[];
}

export interface CodexLocalServiceStatus {
  meta: RuntimeBackendMeta;
  serviceIdentity: {
    pid: number;
    processStartedAt: string;
    buildIdentity: string;
    configFingerprint: string;
    codexVersion: string | null;
    statePermissions: number | null;
  };
  queue: {
    active: number;
    pending: number;
    limit: number;
  };
  dispatchSurface: {
    metaRoute: '/meta';
    statusRoute: '/status';
    jobsCollectionRoute: '/jobs';
    jobItemRoute: '/jobs/:jobId';
    jobFollowUpRoute: '/jobs/:jobId/followup';
    jobLogsRoute: '/jobs/:jobId/logs';
    jobStopRoute: '/jobs/:jobId/stop';
    jobCleanupRoute: '/jobs/:jobId/cleanup';
    followUpsCollectionRoute: '/followups';
    groupsCollectionRoute: '/groups/:groupFolder';
  };
  runtime: {
    defaultRuntime: 'codex_local';
    fallbackRuntime: 'openai_cloud';
    codexLocalEnabled: true;
    codexLocalModel: null;
    codexLocalReady: boolean;
    hostCodexAuthPresent: boolean;
    openAiModelFallback: string;
    openAiApiKeyPresent: false;
    openAiCloudReady: false;
    openAiBaseUrl: null;
    activeThreadCount: number;
    activeJobCount: number;
    containerRuntimeName: 'host_codex_supervisor';
    containerRuntimeStatus: string;
  };
}

export class CodexLocalServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'validation_error'
      | 'not_found'
      | 'conflict'
      | 'method_not_allowed'
      | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'CodexLocalServiceError';
  }
}

function fail(
  status: number,
  code: CodexLocalServiceError['code'],
  message: string,
): never {
  throw new CodexLocalServiceError(status, code, message);
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseStringMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANDREA_CODEX_GROUP_REPOSITORIES must be a JSON object.');
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      !SAFE_GROUP_FOLDER.test(key) ||
      typeof value !== 'string' ||
      !value.trim()
    ) {
      throw new Error(
        'ANDREA_CODEX_GROUP_REPOSITORIES contains an invalid entry.',
      );
    }
    result[key] = value.trim();
  }
  return result;
}

function parseVerificationCommands(raw: string | undefined): string[][] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length > 20 ||
    parsed.some(
      (command) =>
        !Array.isArray(command) ||
        command.length === 0 ||
        command.length > 30 ||
        command.some(
          (part) =>
            typeof part !== 'string' ||
            part.length === 0 ||
            part.length > 1_000,
        ),
    )
  ) {
    throw new Error(
      'ANDREA_CODEX_VERIFICATION_COMMANDS must be a JSON array of argv arrays.',
    );
  }
  return parsed as string[][];
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveCodexLocalServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): CodexLocalServiceConfig {
  const host = (env.ANDREA_CODEX_SERVICE_HOST || '127.0.0.1').trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('ANDREA_CODEX_SERVICE_HOST must be loopback-only.');
  }
  const codexBinary = findCodexBinary(env);
  if (!codexBinary)
    throw new Error('A verified executable Codex binary is required.');
  const defaultRepositoryRoot = env.ANDREA_CODEX_DEFAULT_REPOSITORY_ROOT?.trim()
    ? path.resolve(expandHome(env.ANDREA_CODEX_DEFAULT_REPOSITORY_ROOT.trim()))
    : null;
  const repositoryByGroup = parseStringMap(env.ANDREA_CODEX_GROUP_REPOSITORIES);
  const configuredRoots = (env.ANDREA_CODEX_ALLOWED_REPOSITORY_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(expandHome(entry)));
  const inferredRoots = [
    defaultRepositoryRoot,
    ...Object.values(repositoryByGroup).map((entry) =>
      path.resolve(expandHome(entry)),
    ),
  ].filter((entry): entry is string => Boolean(entry));
  const allowedRepositoryRoots = [
    ...new Set([...configuredRoots, ...inferredRoots]),
  ];
  if (allowedRepositoryRoots.length === 0) {
    throw new Error('At least one allowed Codex repository root is required.');
  }
  return {
    host,
    port: safeInteger(env.ANDREA_CODEX_SERVICE_PORT, 3210, 1, 65_535),
    stateDir: path.resolve(
      expandHome(env.ANDREA_CODEX_SERVICE_STATE_DIR || '~/.andrea/codex-local'),
    ),
    allowedRepositoryRoots,
    repositoryByGroup,
    defaultRepositoryRoot,
    codexBinary,
    codexArgsPrefix: [],
    maxConcurrentJobs: safeInteger(
      env.ANDREA_CODEX_MAX_CONCURRENT_JOBS,
      1,
      1,
      4,
    ),
    jobTimeoutMs: safeInteger(
      env.ANDREA_CODEX_JOB_TIMEOUT_MS,
      45 * 60 * 1000,
      60_000,
      4 * 60 * 60 * 1000,
    ),
    buildIdentity: (env.ANDREA_CODEX_BUILD_IDENTITY || 'development')
      .trim()
      .slice(0, 160),
    verificationCommands: parseVerificationCommands(
      env.ANDREA_CODEX_VERIFICATION_COMMANDS,
    ),
  };
}

function canonicalDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolved);
  } catch {
    fail(400, 'validation_error', `${label} is unavailable.`);
  }
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    fail(
      400,
      'validation_error',
      `${label} must be a real directory, not a symbolic link.`,
    );
  }
  return fs.realpathSync(resolved);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function assertSafeRepository(
  configuredPath: string,
  allowedRoots: readonly string[],
): { root: string; branch: string | null; head: string; dirty: boolean } {
  const root = canonicalDirectory(configuredPath, 'Repository root');
  const allowed = allowedRoots.map((entry) =>
    canonicalDirectory(entry, 'Allowed repository root'),
  );
  if (!allowed.some((allowedRoot) => isWithin(allowedRoot, root))) {
    fail(400, 'validation_error', 'Repository is outside every approved root.');
  }
  const gitRoot = fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  if (gitRoot !== root) {
    fail(
      400,
      'validation_error',
      'Repository path must be the canonical Git worktree root.',
    );
  }
  const gitDirectory = path.resolve(
    root,
    git(root, ['rev-parse', '--git-dir']),
  );
  if (fs.lstatSync(gitDirectory).isSymbolicLink()) {
    fail(400, 'validation_error', 'Git metadata may not be a symbolic link.');
  }
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const sensitive = tracked.find(
    (trackedPath) =>
      trackedPath !== '.env.example' &&
      SECRET_PATH_PATTERNS.some((pattern) => pattern.test(trackedPath)),
  );
  if (sensitive) {
    fail(
      409,
      'conflict',
      'Repository contains a tracked secret-sensitive path and cannot be delegated safely.',
    );
  }
  let branch: string | null = null;
  try {
    branch = git(root, ['symbolic-ref', '--short', 'HEAD']) || null;
  } catch {
    branch = null;
  }
  return {
    root,
    branch,
    head: git(root, ['rev-parse', 'HEAD']),
    dirty: Boolean(
      git(root, ['status', '--porcelain', '--untracked-files=all']),
    ),
  };
}

function chmodPrivate(target: string, mode: number): void {
  fs.chmodSync(target, mode);
}

function safeJsonRead<T>(target: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sanitizeText(value: string, maxBytes = MAX_RESULT_BYTES): string {
  const redacted = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[redacted]')
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi,
      '$1[redacted]',
    );
  const buffer = Buffer.from(redacted, 'utf8');
  return buffer.length <= maxBytes
    ? redacted
    : buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

function promptPreview(prompt: string): string {
  return sanitizeText(prompt.replace(/\s+/g, ' ').trim(), 240);
}

function codexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'LANG',
    'LC_ALL',
    'SHELL',
    'TMPDIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CODEX_HOME',
  ] as const;
  return Object.fromEntries(
    allowed
      .map((key) => [key, env[key]])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function supervisoryPrompt(
  packet: CodingDelegationPacket,
  prompt: string,
): string {
  const granted = packet.operations
    .filter((entry) => entry.authority !== 'prohibited')
    .map((entry) => `${entry.operation}:${entry.authority}`)
    .join(', ');
  return [
    "You are running inside Andrea's supervised isolated coding worktree.",
    `Delegation packet: ${packet.packetId}.`,
    `Granted operations: ${granted || 'none'}.`,
    'Do not push, open or merge a PR, deploy, message anyone, alter production, use destructive Git, read credentials, inspect auth storage, or access paths outside this worktree.',
    'Do not claim tests, artifacts, commits, pushes, deployments, or goal completion unless the supervising service independently verifies them.',
    'Preserve existing changes. Work only on the objective below and leave the worktree inspectable.',
    '',
    prompt,
  ].join('\n');
}

function parseThreadId(line: string): string | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const direct = value.thread_id || value.threadId || value.session_id;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const nested = value.thread;
    if (nested && typeof nested === 'object') {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function isTerminal(status: RuntimeBackendJob['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

export class CodexLocalJobService {
  private readonly jobs = new Map<string, StoredCodexJob>();
  private readonly groups = new Map<string, RegisteredCodexGroup>();
  private readonly pending: PendingInvocation[] = [];
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly startedAt = new Date().toISOString();
  private codexVersion: string | null = null;
  private codexAuthenticated = false;

  constructor(
    readonly config: CodexLocalServiceConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  prepareStorage(): void {
    fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
    chmodPrivate(this.config.stateDir, 0o700);
    for (const child of ['jobs', 'logs', 'outputs', 'worktrees']) {
      const target = path.join(this.config.stateDir, child);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      chmodPrivate(target, 0o700);
    }
    const groups = safeJsonRead<RegisteredCodexGroup[]>(
      path.join(this.config.stateDir, 'groups.json'),
    );
    for (const group of groups || []) {
      if (SAFE_GROUP_FOLDER.test(group.folder))
        this.groups.set(group.folder, group);
    }
    for (const filename of fs.readdirSync(
      path.join(this.config.stateDir, 'jobs'),
    )) {
      if (!filename.endsWith('.json')) continue;
      const stored = safeJsonRead<StoredCodexJob>(
        path.join(this.config.stateDir, 'jobs', filename),
      );
      if (!stored || !SAFE_JOB_ID.test(stored.publicJob.jobId)) continue;
      if (!isTerminal(stored.publicJob.status)) {
        const now = new Date().toISOString();
        stored.publicJob = {
          ...stored.publicJob,
          status: 'failed',
          errorText:
            'The supervising service restarted before this invocation reached a verified terminal state. The isolated worktree was preserved for inspection or follow-up.',
          finishedAt: now,
          updatedAt: now,
        };
        this.persist(stored);
      }
      this.jobs.set(stored.publicJob.jobId, stored);
    }
    try {
      this.codexVersion = execFileSync(
        this.config.codexBinary,
        [...this.config.codexArgsPrefix, '--version'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        },
      )
        .trim()
        .slice(0, 120);
    } catch {
      this.codexVersion = null;
    }
    if (this.codexVersion) {
      try {
        execFileSync(
          this.config.codexBinary,
          [...this.config.codexArgsPrefix, 'login', 'status'],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
            env: codexEnvironment(this.env),
          },
        );
        this.codexAuthenticated = true;
      } catch {
        this.codexAuthenticated = false;
      }
    }
  }

  getStatus(): CodexLocalServiceStatus {
    const binaryReady = Boolean(this.codexVersion);
    const executionReady = binaryReady && this.codexAuthenticated;
    const meta: RuntimeBackendMeta = {
      backend: 'andrea_openai',
      transport: 'http',
      enabled: true,
      version: CODEX_LOCAL_SERVICE_VERSION,
      ready: executionReady,
      localExecutionState: executionReady
        ? 'available_authenticated'
        : binaryReady
          ? 'available_auth_required'
          : 'not_ready',
      authState: this.codexAuthenticated ? 'authenticated' : 'auth_required',
      localExecutionDetail: executionReady
        ? 'Supervised host Codex is available through an isolated-worktree loopback service.'
        : binaryReady
          ? 'Codex is installed, but login status did not prove host authentication.'
          : 'Codex binary identity could not be verified.',
      operatorGuidance: executionReady
        ? null
        : binaryReady
          ? 'Run codex login on this host; the service will use host auth in place and will not copy it.'
          : 'Repair the configured Codex binary and run the service dry-run before activation.',
    };
    const stat = fs.existsSync(this.config.stateDir)
      ? fs.statSync(this.config.stateDir)
      : null;
    const activeThreadCount = new Set(
      [...this.jobs.values()].map((entry) => entry.threadId).filter(Boolean),
    ).size;
    return {
      meta,
      serviceIdentity: {
        pid: process.pid,
        processStartedAt: this.startedAt,
        buildIdentity: this.config.buildIdentity,
        configFingerprint: fingerprint(
          JSON.stringify({
            host: this.config.host,
            port: this.config.port,
            stateDir: this.config.stateDir,
            allowedRepositoryRoots: this.config.allowedRepositoryRoots,
            repositoryByGroup: this.config.repositoryByGroup,
            codexArgsPrefixCount: this.config.codexArgsPrefix.length,
            maxConcurrentJobs: this.config.maxConcurrentJobs,
            jobTimeoutMs: this.config.jobTimeoutMs,
          }),
        ),
        codexVersion: this.codexVersion,
        statePermissions: stat ? stat.mode & 0o777 : null,
      },
      queue: {
        active: this.active.size,
        pending: this.pending.length,
        limit: this.config.maxConcurrentJobs,
      },
      dispatchSurface: {
        metaRoute: '/meta',
        statusRoute: '/status',
        jobsCollectionRoute: '/jobs',
        jobItemRoute: '/jobs/:jobId',
        jobFollowUpRoute: '/jobs/:jobId/followup',
        jobLogsRoute: '/jobs/:jobId/logs',
        jobStopRoute: '/jobs/:jobId/stop',
        jobCleanupRoute: '/jobs/:jobId/cleanup',
        followUpsCollectionRoute: '/followups',
        groupsCollectionRoute: '/groups/:groupFolder',
      },
      runtime: {
        defaultRuntime: 'codex_local',
        fallbackRuntime: 'openai_cloud',
        codexLocalEnabled: true,
        codexLocalModel: null,
        codexLocalReady: executionReady,
        hostCodexAuthPresent: this.codexAuthenticated,
        openAiModelFallback: 'not_configured_here',
        openAiApiKeyPresent: false,
        openAiCloudReady: false,
        openAiBaseUrl: null,
        activeThreadCount,
        activeJobCount: this.active.size,
        containerRuntimeName: 'host_codex_supervisor',
        containerRuntimeStatus: executionReady ? 'ready' : 'not_ready',
      },
    };
  }

  registerGroup(
    folder: string,
    input: Record<string, unknown>,
  ): RegisteredCodexGroup {
    if (!SAFE_GROUP_FOLDER.test(folder)) {
      fail(400, 'validation_error', 'Group folder is invalid.');
    }
    const jid = typeof input.jid === 'string' ? input.jid.trim() : '';
    if (!jid || jid.length > 300)
      fail(400, 'validation_error', 'Group jid is required.');
    const group: RegisteredCodexGroup = {
      folder,
      jid,
      name:
        typeof input.name === 'string' && input.name.trim()
          ? input.name.trim().slice(0, 200)
          : null,
      registeredAt: new Date().toISOString(),
    };
    this.groups.set(folder, group);
    writeJsonFileAtomic(path.join(this.config.stateDir, 'groups.json'), [
      ...this.groups.values(),
    ]);
    chmodPrivate(path.join(this.config.stateDir, 'groups.json'), 0o600);
    return group;
  }

  private repositoryForGroup(groupFolder: string): string {
    const configured =
      this.config.repositoryByGroup[groupFolder] ||
      this.config.defaultRepositoryRoot;
    if (!configured) {
      fail(
        409,
        'conflict',
        `No approved repository mapping is configured for backend group "${groupFolder}".`,
      );
    }
    return configured;
  }

  private createIsolatedWorktree(
    jobId: string,
    sourceRoot: string,
    head: string,
  ): string {
    const worktreeRoot = path.join(this.config.stateDir, 'worktrees', jobId);
    if (fs.existsSync(worktreeRoot)) {
      fail(409, 'conflict', 'Isolated worktree path already exists.');
    }
    execFileSync(
      'git',
      ['-C', sourceRoot, 'worktree', 'add', '--detach', worktreeRoot, head],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const canonical = fs.realpathSync(worktreeRoot);
    const canonicalParent = fs.realpathSync(
      path.join(this.config.stateDir, 'worktrees'),
    );
    if (!isWithin(canonicalParent, canonical)) {
      fail(
        500,
        'internal_error',
        'Created worktree escaped private service storage.',
      );
    }
    return canonical;
  }

  private buildJob(input: {
    kind: 'create' | 'follow_up';
    groupFolder: string;
    prompt: string;
    source: OrchestrationSource;
    parent?: StoredCodexJob;
    requestedRuntime?: RuntimeBackendJob['requestedRuntime'];
  }): PendingInvocation {
    if (!SAFE_GROUP_FOLDER.test(input.groupFolder)) {
      fail(400, 'validation_error', 'Group folder is invalid.');
    }
    if (!this.groups.has(input.groupFolder)) {
      fail(
        404,
        'not_found',
        `No registered group found for folder "${input.groupFolder}"`,
      );
    }
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 20_000) {
      fail(
        400,
        'validation_error',
        'Prompt must contain 1 to 20,000 characters.',
      );
    }
    const now = new Date().toISOString();
    const jobId = `codex_${randomUUID()}`;
    let repository;
    let worktreeRoot: string;
    let sourceRepositoryRoot: string;
    let branch: string | null;
    let head: string;
    let dirty: boolean;
    if (input.parent) {
      sourceRepositoryRoot = input.parent.sourceRepositoryRoot;
      worktreeRoot = canonicalDirectory(
        input.parent.worktreeRoot,
        'Continuation worktree',
      );
      repository = assertSafeRepository(
        sourceRepositoryRoot,
        this.config.allowedRepositoryRoots,
      );
      try {
        branch = git(worktreeRoot, ['symbolic-ref', '--short', 'HEAD']) || null;
      } catch {
        branch = null;
      }
      head = git(worktreeRoot, ['rev-parse', 'HEAD']);
      dirty = Boolean(
        git(worktreeRoot, ['status', '--porcelain', '--untracked-files=all']),
      );
    } else {
      repository = assertSafeRepository(
        this.repositoryForGroup(input.groupFolder),
        this.config.allowedRepositoryRoots,
      );
      sourceRepositoryRoot = repository.root;
      branch = repository.branch;
      head = repository.head;
      dirty = repository.dirty;
      worktreeRoot = this.createIsolatedWorktree(
        jobId,
        repository.root,
        repository.head,
      );
    }
    const packet = buildCodingDelegationPacket({
      objective: prompt,
      requestedLane: 'codex',
      repository: {
        canonicalRoot: sourceRepositoryRoot,
        worktreeRoot,
        branch,
        headSha: head,
        dirty,
        isolatedWorktree: true,
      },
      continuationId: input.parent?.threadId || null,
    });
    const deniedRequested = packet.operations.filter(
      (entry) => entry.authority === 'prohibited',
    );
    if (deniedRequested.length > 0) {
      if (!input.parent) {
        try {
          execFileSync(
            'git',
            [
              '-C',
              sourceRepositoryRoot,
              'worktree',
              'remove',
              '--force',
              worktreeRoot,
            ],
            {
              stdio: 'ignore',
              timeout: 30_000,
            },
          );
        } catch {
          // A failed cleanup is preserved inside private storage for operator inspection.
        }
      }
      fail(
        409,
        'conflict',
        `Delegation requests separately gated operations: ${deniedRequested.map((entry) => entry.operation).join(', ')}. No job was started.`,
      );
    }
    const logFile = path.join(this.config.stateDir, 'logs', `${jobId}.jsonl`);
    const outputFile = path.join(
      this.config.stateDir,
      'outputs',
      `${jobId}.txt`,
    );
    fs.writeFileSync(logFile, '', { mode: 0o600 });
    const publicJob: RuntimeBackendJob = {
      backend: 'andrea_openai',
      jobId,
      kind: input.kind,
      status: 'queued',
      stopRequested: false,
      groupFolder: input.groupFolder,
      groupJid: this.groups.get(input.groupFolder)!.jid,
      parentJobId: input.parent?.publicJob.jobId || null,
      threadId: input.parent?.threadId || null,
      runtimeRoute: 'local_required',
      requestedRuntime: input.requestedRuntime || 'codex_local',
      selectedRuntime: 'codex_local',
      promptPreview: promptPreview(prompt),
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile,
      sourceSystem: input.source.system,
      actorType: input.source.actorType || null,
      actorId: input.source.actorId || null,
      correlationId: input.source.correlationId || null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      capabilities: { followUp: true, logs: true, stop: true },
    };
    const stored: StoredCodexJob = {
      publicJob,
      packet,
      sourceRepositoryRoot,
      worktreeRoot,
      threadId: input.parent?.threadId || null,
      logFile,
      outputFile,
      codingWorkResult: null,
    };
    this.jobs.set(jobId, stored);
    this.persist(stored);
    return {
      stored,
      prompt,
      resumeThreadId: input.parent?.threadId || null,
    };
  }

  createJob(input: {
    groupFolder: string;
    prompt: string;
    requestedRuntime?: RuntimeBackendJob['requestedRuntime'];
    source: OrchestrationSource;
  }): RuntimeBackendJob {
    if (input.requestedRuntime && input.requestedRuntime !== 'codex_local') {
      fail(
        400,
        'validation_error',
        'This backend accepts codex_local work only.',
      );
    }
    const pending = this.buildJob({ kind: 'create', ...input });
    this.pending.push(pending);
    this.drain();
    return pending.stored.publicJob;
  }

  followUp(
    jobId: string,
    input: { prompt: string; source: OrchestrationSource },
  ): RuntimeBackendJob {
    const parent = this.requireJob(jobId);
    if (!isTerminal(parent.publicJob.status) || this.active.has(jobId)) {
      fail(409, 'conflict', 'Parent job must be terminal before follow-up.');
    }
    if (!parent.threadId) {
      fail(
        409,
        'conflict',
        'Parent job has no proven Codex continuation thread.',
      );
    }
    const pending = this.buildJob({
      kind: 'follow_up',
      groupFolder: parent.publicJob.groupFolder,
      prompt: input.prompt,
      source: input.source,
      parent,
      requestedRuntime: 'codex_local',
    });
    this.pending.push(pending);
    this.drain();
    return pending.stored.publicJob;
  }

  followUpTarget(input: {
    prompt: string;
    source: OrchestrationSource;
    jobId?: string;
    threadId?: string;
    groupFolder?: string;
  }): RuntimeBackendJob {
    const selectors = [input.jobId, input.threadId, input.groupFolder].filter(
      (value): value is string => Boolean(value?.trim()),
    );
    if (selectors.length !== 1) {
      fail(
        400,
        'validation_error',
        'Exactly one follow-up selector is required: jobId, threadId, or groupFolder.',
      );
    }
    if (input.jobId) {
      return this.followUp(input.jobId, {
        prompt: input.prompt,
        source: input.source,
      });
    }
    let candidates = [...this.jobs.values()].filter((stored) =>
      isTerminal(stored.publicJob.status),
    );
    candidates = input.threadId
      ? candidates.filter((stored) => stored.threadId === input.threadId)
      : candidates.filter(
          (stored) => stored.publicJob.groupFolder === input.groupFolder,
        );
    candidates.sort((left, right) =>
      right.publicJob.updatedAt.localeCompare(left.publicJob.updatedAt),
    );
    const parent = candidates[0];
    if (!parent) {
      fail(404, 'not_found', 'No terminal continuation target was found.');
    }
    return this.followUp(parent.publicJob.jobId, {
      prompt: input.prompt,
      source: input.source,
    });
  }

  getJob(jobId: string): StoredCodexJob {
    return this.requireJob(jobId);
  }

  listJobs(groupFolder: string, limit = 50): RuntimeBackendJobList {
    const jobs = [...this.jobs.values()]
      .map((entry) => entry.publicJob)
      .filter((job) => job.groupFolder === groupFolder)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(200, limit)));
    return { jobs, nextBeforeJobId: null };
  }

  getLogs(jobId: string, lines = 100): RuntimeBackendJobLogs {
    const stored = this.requireJob(jobId);
    const rows = fs.existsSync(stored.logFile)
      ? fs.readFileSync(stored.logFile, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
    const selected = rows.slice(-Math.max(1, Math.min(1_000, lines)));
    return {
      jobId,
      logFile: stored.logFile,
      logText: selected.join('\n') || null,
      lines: selected.length,
    };
  }

  stopJob(jobId: string): RuntimeBackendStopResult {
    const stored = this.requireJob(jobId);
    stored.publicJob.stopRequested = true;
    stored.publicJob.updatedAt = new Date().toISOString();
    const pendingIndex = this.pending.findIndex(
      (entry) => entry.stored.publicJob.jobId === jobId,
    );
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      stored.publicJob.status = 'failed';
      stored.publicJob.errorText = 'Job was cancelled before execution.';
      stored.publicJob.finishedAt = stored.publicJob.updatedAt;
      this.persist(stored);
      return { job: stored.publicJob, liveStopAccepted: true };
    }
    const child = this.active.get(jobId);
    if (child) child.kill('SIGTERM');
    this.persist(stored);
    return { job: stored.publicJob, liveStopAccepted: Boolean(child) };
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    const pendingJobIds = this.pending.map(
      (entry) => entry.stored.publicJob.jobId,
    );
    for (const jobId of pendingJobIds) this.stopJob(jobId);

    const activeEntries = [...this.active.entries()];
    const closed = activeEntries.map(
      ([jobId, child]) =>
        new Promise<void>((resolve) => {
          if (!this.active.has(jobId)) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
        }),
    );
    for (const [jobId] of activeEntries) this.stopJob(jobId);
    if (closed.length === 0) return;

    let allClosed = false;
    const completion = Promise.all(closed).then(() => {
      allClosed = true;
    });
    await Promise.race([
      completion,
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
    if (allClosed) return;

    for (const [jobId, child] of activeEntries) {
      if (this.active.get(jobId) === child) child.kill('SIGKILL');
    }
    await Promise.race([
      completion,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  cleanupJob(jobId: string): {
    jobId: string;
    cleaned: boolean;
    cleanedAt: string | null;
  } {
    const stored = this.requireJob(jobId);
    if (!isTerminal(stored.publicJob.status) || this.active.has(jobId)) {
      fail(
        409,
        'conflict',
        'Only a terminal inactive worktree may be cleaned.',
      );
    }
    if (stored.worktreeCleanedAt || !fs.existsSync(stored.worktreeRoot)) {
      return {
        jobId,
        cleaned: true,
        cleanedAt: stored.worktreeCleanedAt || stored.publicJob.updatedAt,
      };
    }
    const dirty = git(stored.worktreeRoot, [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (dirty) {
      fail(
        409,
        'conflict',
        'The isolated worktree contains results and was preserved; cleanup requires a clean worktree.',
      );
    }
    execFileSync(
      'git',
      [
        '-C',
        stored.sourceRepositoryRoot,
        'worktree',
        'remove',
        stored.worktreeRoot,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    );
    stored.worktreeCleanedAt = new Date().toISOString();
    this.persist(stored);
    return { jobId, cleaned: true, cleanedAt: stored.worktreeCleanedAt };
  }

  private requireJob(jobId: string): StoredCodexJob {
    if (!SAFE_JOB_ID.test(jobId))
      fail(400, 'validation_error', 'Job id is invalid.');
    const stored = this.jobs.get(jobId);
    if (!stored) fail(404, 'not_found', `Codex job ${jobId} was not found.`);
    return stored;
  }

  private persist(stored: StoredCodexJob): void {
    const target = path.join(
      this.config.stateDir,
      'jobs',
      `${stored.publicJob.jobId}.json`,
    );
    writeJsonFileAtomic(target, stored);
    chmodPrivate(target, 0o600);
  }

  private appendLog(stored: StoredCodexJob, text: string): void {
    const sanitized = sanitizeText(text, MAX_LOG_BYTES);
    fs.appendFileSync(
      stored.logFile,
      sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    const stat = fs.statSync(stored.logFile);
    if (stat.size > MAX_LOG_BYTES) {
      const content = fs.readFileSync(stored.logFile);
      fs.writeFileSync(
        stored.logFile,
        content.subarray(content.length - MAX_LOG_BYTES),
        {
          mode: 0o600,
        },
      );
    }
  }

  private drain(): void {
    while (
      this.active.size < this.config.maxConcurrentJobs &&
      this.pending.length > 0
    ) {
      const next = this.pending.shift()!;
      this.run(next);
    }
  }

  private run(invocation: PendingInvocation): void {
    const { stored } = invocation;
    const jobId = stored.publicJob.jobId;
    const now = new Date().toISOString();
    stored.publicJob.status = 'running';
    stored.publicJob.startedAt = now;
    stored.publicJob.updatedAt = now;
    this.persist(stored);
    const args = invocation.resumeThreadId
      ? [
          'exec',
          'resume',
          '--json',
          '--ignore-user-config',
          '-o',
          stored.outputFile,
          invocation.resumeThreadId,
          '-',
        ]
      : [
          'exec',
          '--json',
          '--color',
          'never',
          '--ignore-user-config',
          '-C',
          stored.worktreeRoot,
          '-s',
          'workspace-write',
          '-o',
          stored.outputFile,
          '-',
        ];
    const child = spawn(
      this.config.codexBinary,
      [...this.config.codexArgsPrefix, ...args],
      {
        cwd: stored.worktreeRoot,
        env: codexEnvironment(this.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        shell: false,
      },
    );
    this.active.set(jobId, child);
    let stdoutBuffer = '';
    let stderrTail = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (this.active.get(jobId) === child) child.kill('SIGKILL');
      }, 5_000).unref();
    }, this.config.jobTimeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const threadId = parseThreadId(line);
        if (threadId) {
          stored.threadId = threadId;
          stored.publicJob.threadId = threadId;
        }
        this.appendLog(stored, line);
        stored.publicJob.latestOutputText = sanitizeText(line, 8_000);
        stored.publicJob.updatedAt = new Date().toISOString();
      }
      this.persist(stored);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = sanitizeText(chunk.toString('utf8'), 16_000);
      stderrTail = sanitizeText(`${stderrTail}${text}`, 16_000);
      this.appendLog(
        stored,
        JSON.stringify({ type: 'supervisor.stderr', text }),
      );
    });
    child.on('error', (error) => {
      stderrTail = sanitizeText(error.message, 16_000);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (stdoutBuffer) this.appendLog(stored, stdoutBuffer);
      this.active.delete(jobId);
      const completedAt = new Date().toISOString();
      const cancelled = stored.publicJob.stopRequested;
      const exitCode = typeof code === 'number' ? code : null;
      const output = fs.existsSync(stored.outputFile)
        ? sanitizeText(fs.readFileSync(stored.outputFile, 'utf8'))
        : null;
      const workResult = this.verifyResult(stored, exitCode, completedAt);
      stored.codingWorkResult = workResult;
      stored.publicJob.codingWorkResult = workResult;
      stored.publicJob.status =
        exitCode === 0 &&
        !timedOut &&
        !cancelled &&
        workResult.verification.status !== 'rejected'
          ? 'succeeded'
          : 'failed';
      stored.publicJob.finalOutputText = output
        ? `Agent output (claims remain bounded by independent verification):\n\n${output}`
        : null;
      stored.publicJob.errorText =
        stored.publicJob.status === 'succeeded'
          ? workResult.verification.unsupportedClaimIds.length > 0
            ? `Execution finished, but ${workResult.verification.unsupportedClaimIds.length} completion claim(s) remain unverified.`
            : null
          : workResult.verification.status === 'rejected'
            ? `Independent verification rejected the result: ${workResult.verification.invariantFailures.join(', ') || 'authority invariant failed'}.`
            : timedOut
              ? `Codex invocation timed out after ${this.config.jobTimeoutMs} ms.`
              : cancelled
                ? 'Codex invocation was cancelled by the operator.'
                : `Codex exited without verified success (exit=${exitCode ?? 'none'}, signal=${signal || 'none'}). ${stderrTail}`.trim();
      stored.publicJob.finishedAt = completedAt;
      stored.publicJob.updatedAt = completedAt;
      this.persist(stored);
      this.drain();
    });
    child.stdin.end(supervisoryPrompt(stored.packet, invocation.prompt));
  }

  private verifyResult(
    stored: StoredCodexJob,
    exitCode: number | null,
    completedAt: string,
  ): CodingWorkResult {
    const evidence: CodingVerificationEvidence[] = [];
    const claims: CodingWorkClaim[] = [];
    const processPassed = exitCode === 0;
    evidence.push({
      evidenceId: 'process_exit',
      kind: 'process_exit',
      outcome: processPassed ? 'passed' : 'failed',
      operation: stored.packet.operations.some(
        (entry) => entry.operation === 'analysis',
      )
        ? 'analysis'
        : stored.packet.operations[0]?.operation || 'repository_read',
      exitCode,
      fingerprint: null,
      observedAt: completedAt,
      metadata: {},
    });
    if (processPassed) {
      claims.push({
        claimId: 'analysis_complete',
        kind: 'analysis_complete',
        text: 'The supervised Codex process reached a successful exit.',
        evidenceIds: ['process_exit'],
      });
    }
    let statusOutput = '';
    try {
      statusOutput = git(stored.worktreeRoot, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
    } catch {
      statusOutput = '';
    }
    const changedPaths = statusOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (changedPaths.length > 0) {
      evidence.push(
        {
          evidenceId: 'filesystem_state',
          kind: 'filesystem_state',
          outcome: 'passed',
          operation: 'code_edit',
          exitCode: 0,
          fingerprint: fingerprint(changedPaths.sort().join('\n')),
          observedAt: completedAt,
          metadata: { changedPathCount: changedPaths.length },
        },
        {
          evidenceId: 'git_diff',
          kind: 'git_diff',
          outcome: 'passed',
          operation: 'code_edit',
          exitCode: 0,
          fingerprint: fingerprint(
            git(stored.worktreeRoot, ['diff', '--binary', 'HEAD']),
          ),
          observedAt: completedAt,
          metadata: { changedPathCount: changedPaths.length },
        },
      );
      claims.push({
        claimId: 'files_changed',
        kind: 'files_changed',
        text: `${changedPaths.length} changed path(s) were independently observed in the isolated worktree.`,
        evidenceIds: ['filesystem_state', 'git_diff'],
      });
    }
    const testSummaries: string[] = [];
    const shouldRunVerification = stored.packet.operations.some(
      (entry) => entry.operation === 'test' && entry.authority !== 'prohibited',
    );
    for (const [index, command] of (shouldRunVerification
      ? this.config.verificationCommands
      : []
    ).entries()) {
      const [binary, ...args] = command;
      try {
        const stdout = execFileSync(binary, args, {
          cwd: stored.worktreeRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: Math.min(this.config.jobTimeoutMs, 15 * 60 * 1000),
          maxBuffer: 8 * 1024 * 1024,
          env: codexEnvironment(this.env),
        });
        const evidenceId = `test_result_${index}`;
        evidence.push({
          evidenceId,
          kind: 'test_result',
          outcome: 'passed',
          operation: 'test',
          exitCode: 0,
          fingerprint: fingerprint(stdout),
          observedAt: completedAt,
          metadata: { commandIndex: index },
        });
        testSummaries.push(`verification command ${index + 1}: passed`);
      } catch {
        const evidenceId = `test_result_${index}`;
        evidence.push({
          evidenceId,
          kind: 'test_result',
          outcome: 'failed',
          operation: 'test',
          exitCode: 1,
          fingerprint: null,
          observedAt: completedAt,
          metadata: { commandIndex: index },
        });
        testSummaries.push(`verification command ${index + 1}: failed`);
      }
    }
    if (
      shouldRunVerification &&
      this.config.verificationCommands.length > 0 &&
      testSummaries.every((summary) => summary.endsWith('passed'))
    ) {
      claims.push({
        claimId: 'tests_passed',
        kind: 'tests_passed',
        text: 'Every supervisor-configured verification command passed.',
        evidenceIds: [
          'process_exit',
          ...this.config.verificationCommands.map(
            (_, index) => `test_result_${index}`,
          ),
        ],
      });
    }
    const verification = verifyCodingWorkClaims({
      packet: stored.packet,
      claims,
      evidence,
      now: new Date(completedAt),
    });
    return {
      version: 1,
      resultId: `result_${randomUUID()}`,
      packetId: stored.packet.packetId,
      jobId: stored.publicJob.jobId,
      lane: 'codex',
      status: stored.publicJob.stopRequested
        ? 'cancelled'
        : processPassed
          ? verification.status === 'verified'
            ? 'succeeded'
            : 'partial'
          : 'failed',
      startedAt: stored.publicJob.startedAt || stored.publicJob.createdAt,
      completedAt,
      changedPathFingerprints: changedPaths.map((changedPath) =>
        fingerprint(changedPath),
      ),
      testSummaries,
      artifactFingerprints: [],
      failures: evidence
        .filter((entry) => entry.outcome === 'failed')
        .map((entry) => `${entry.kind}:${entry.evidenceId}`),
      claims,
      evidence,
      verification,
      agentOutputTrusted: false,
    };
  }
}

function isLoopbackRemote(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      fail(400, 'validation_error', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(400, 'validation_error', 'JSON object body is required.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CodexLocalServiceError) throw error;
    fail(400, 'validation_error', 'Request body contains invalid JSON.');
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function sourceFromBody(body: Record<string, unknown>): OrchestrationSource {
  const raw = body.source;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { system: 'andrea_nanobot' };
  }
  const record = raw as Record<string, unknown>;
  return {
    system:
      typeof record.system === 'string'
        ? record.system.slice(0, 120)
        : 'andrea_nanobot',
    actorType:
      typeof record.actorType === 'string'
        ? record.actorType.slice(0, 80)
        : null,
    actorId:
      typeof record.actorId === 'string' ? record.actorId.slice(0, 300) : null,
    correlationId:
      typeof record.correlationId === 'string'
        ? record.correlationId.slice(0, 160)
        : null,
  };
}

export function createCodexLocalHttpServer(
  service: CodexLocalJobService,
): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (!isLoopbackRemote(request.socket.remoteAddress)) {
        fail(403, 'validation_error', 'Loopback clients only.');
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const method = request.method || 'GET';
      if (method === 'GET' && url.pathname === '/meta') {
        sendJson(response, 200, service.getStatus().meta);
        return;
      }
      if (method === 'GET' && url.pathname === '/status') {
        const status = service.getStatus();
        sendJson(response, 200, { ...status.meta, ...status });
        return;
      }
      const groupMatch = /^\/groups\/([^/]+)$/.exec(url.pathname);
      if (method === 'PUT' && groupMatch) {
        const body = await readJsonBody(request);
        sendJson(response, 200, {
          group: service.registerGroup(decodeURIComponent(groupMatch[1]), body),
        });
        return;
      }
      if (url.pathname === '/jobs' && method === 'POST') {
        const body = await readJsonBody(request);
        const groupFolder =
          typeof body.groupFolder === 'string' ? body.groupFolder : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        const requestedRuntime =
          typeof body.requestedRuntime === 'string'
            ? (body.requestedRuntime as RuntimeBackendJob['requestedRuntime'])
            : null;
        sendJson(response, 202, {
          job: service.createJob({
            groupFolder,
            prompt,
            requestedRuntime,
            source: sourceFromBody(body),
          }),
        });
        return;
      }
      if (url.pathname === '/jobs' && method === 'GET') {
        sendJson(
          response,
          200,
          service.listJobs(
            url.searchParams.get('groupFolder') || '',
            safeInteger(url.searchParams.get('limit') || undefined, 50, 1, 200),
          ),
        );
        return;
      }
      if (url.pathname === '/followups' && method === 'POST') {
        const body = await readJsonBody(request);
        sendJson(response, 202, {
          job: service.followUpTarget({
            prompt: typeof body.prompt === 'string' ? body.prompt : '',
            source: sourceFromBody(body),
            jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
            threadId:
              typeof body.threadId === 'string' ? body.threadId : undefined,
            groupFolder:
              typeof body.groupFolder === 'string'
                ? body.groupFolder
                : undefined,
          }),
        });
        return;
      }
      const jobMatch =
        /^\/jobs\/([^/]+)(?:\/(followup|logs|stop|cleanup))?$/.exec(
          url.pathname,
        );
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const action = jobMatch[2] || null;
        if (method === 'GET' && action === null) {
          const stored = service.getJob(jobId);
          sendJson(response, 200, {
            job: stored.publicJob,
            codingWorkResult: stored.codingWorkResult,
          });
          return;
        }
        if (method === 'GET' && action === 'logs') {
          sendJson(
            response,
            200,
            service.getLogs(
              jobId,
              safeInteger(
                url.searchParams.get('lines') || undefined,
                100,
                1,
                1_000,
              ),
            ),
          );
          return;
        }
        if (method === 'POST' && action === 'followup') {
          const body = await readJsonBody(request);
          sendJson(response, 202, {
            job: service.followUp(jobId, {
              prompt: typeof body.prompt === 'string' ? body.prompt : '',
              source: sourceFromBody(body),
            }),
          });
          return;
        }
        if (method === 'POST' && action === 'stop') {
          sendJson(response, 200, service.stopJob(jobId));
          return;
        }
        if (method === 'POST' && action === 'cleanup') {
          sendJson(response, 200, service.cleanupJob(jobId));
          return;
        }
      }
      fail(404, 'not_found', 'Route was not found.');
    } catch (error) {
      const serviceError =
        error instanceof CodexLocalServiceError
          ? error
          : new CodexLocalServiceError(
              500,
              'internal_error',
              error instanceof Error
                ? error.message
                : 'Internal service error.',
            );
      sendJson(response, serviceError.status, {
        error: {
          code: serviceError.code,
          message: sanitizeText(serviceError.message, 1_000),
        },
      });
    }
  });
}
