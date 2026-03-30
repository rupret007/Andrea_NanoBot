import {
  CursorAgentRecord as CursorDbAgentRecord,
  CursorAgentArtifactRecord,
  getCursorAgentById,
  listAllCursorAgents,
  listCursorAgentsForChat,
  listCursorAgentArtifacts,
  listCursorAgentsForGroup,
  replaceCursorAgentArtifacts,
  upsertCursorAgent,
} from './db.js';
import {
  CursorAgentRecord as CursorApiAgentRecord,
  CursorArtifactRecord as CursorApiArtifactRecord,
  CursorModelRecord,
  CursorCloudApiError,
  CursorCloudClient,
  CursorCreateAgentRequest,
  resolveCursorCloudConfig,
} from './cursor-cloud.js';
import {
  CursorDesktopClient,
  CursorDesktopConversationMessage,
  CursorDesktopSession,
  CursorDesktopTerminalOutputLine,
  CursorDesktopTerminalStatus,
  resolveCursorDesktopConfig,
} from './cursor-desktop.js';
import { normalizeCursorAgentId } from './cursor-agent-id.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';

const CURSOR_GUARDRAIL_ENV_KEYS = ['CURSOR_MAX_ACTIVE_JOBS_PER_CHAT'] as const;
const DEFAULT_CURSOR_MAX_ACTIVE_JOBS_PER_CHAT = 4;
const CURSOR_NOT_CONFIGURED_MESSAGE =
  'Cursor is not configured. Either set CURSOR_DESKTOP_BRIDGE_URL + CURSOR_DESKTOP_BRIDGE_TOKEN for your normal machine, or set CURSOR_API_KEY for Cursor Cloud Agents.';
const CURSOR_CLOUD_REQUIRED_FOR_JOBS_MESSAGE =
  'Cursor Cloud is required for queued coding jobs in the current product. Set CURSOR_API_KEY before using /cursor-create.';
const CURSOR_CLOUD_ONLY_FOLLOWUP_MESSAGE =
  'Desktop bridge sessions are not part of the queued Cloud follow-up flow in the current product. Use /cursor-sync to refresh the session, /cursor-conversation to inspect it, and /cursor-terminal for machine-side actions.';
const CURSOR_CLOUD_ONLY_STOP_MESSAGE =
  'Desktop bridge sessions are not part of the queued Cloud stop flow in the current product. Use /cursor-terminal-stop for a bridge-managed shell command, or stop the session on the bridged machine.';
const CURSOR_CLOUD_ONLY_ARTIFACTS_MESSAGE =
  'Cursor results are only available for Cursor Cloud jobs in the current product. Use /cursor-conversation for text output from desktop bridge sessions, and /cursor-terminal* for machine-side actions.';
const CURSOR_CLOUD_ONLY_ARTIFACT_LINK_MESSAGE =
  'Cursor download links are only available for Cursor Cloud jobs in the current product. Desktop bridge sessions do not expose downloadable result files through this path.';

function boolToInt(value: boolean | undefined): number {
  return value ? 1 : 0;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function parseRawJson(rawJson: string | null): Record<string, unknown> | null {
  if (!rawJson) return null;
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveCursorMaxActiveJobsPerChat(): number {
  const envFileValues = readEnvFile([...CURSOR_GUARDRAIL_ENV_KEYS]);
  return parsePositiveInt(
    process.env.CURSOR_MAX_ACTIVE_JOBS_PER_CHAT ||
      envFileValues.CURSOR_MAX_ACTIVE_JOBS_PER_CHAT,
    DEFAULT_CURSOR_MAX_ACTIVE_JOBS_PER_CHAT,
  );
}

function isTerminalCursorStatus(status: string | null | undefined): boolean {
  const normalized = (status || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'completed' ||
    normalized === 'finished' ||
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'stopped'
  );
}

function resolveCursorClient(): CursorCloudClient {
  const config = resolveCursorCloudConfig();
  if (!config) {
    throw new Error(
      'Cursor Cloud is not configured. Set CURSOR_API_KEY to enable Cursor agent control.',
    );
  }
  return new CursorCloudClient(config);
}

function resolveCursorDesktopClient(): CursorDesktopClient {
  const config = resolveCursorDesktopConfig();
  if (!config) {
    throw new Error(
      'Cursor desktop bridge is not configured. Set CURSOR_DESKTOP_BRIDGE_URL and CURSOR_DESKTOP_BRIDGE_TOKEN to reach your normal Cursor machine.',
    );
  }
  return new CursorDesktopClient(config);
}

type CursorExecutionBackend = 'desktop' | 'cloud';

function getConfiguredCursorExecutionBackends(): CursorExecutionBackend[] {
  const backends: CursorExecutionBackend[] = [];
  if (resolveCursorDesktopConfig()) backends.push('desktop');
  if (resolveCursorCloudConfig()) backends.push('cloud');
  return backends;
}

function recordUsesDesktop(record: CursorDbAgentRecord | undefined): boolean {
  const raw = parseRawJson(record?.raw_json || null);
  return raw?.provider === 'desktop';
}

function isDesktopLikeCursorAgentId(agentId: string): boolean {
  return agentId.trim().toLowerCase().startsWith('desk_');
}

function isCloudLikeCursorAgentId(agentId: string): boolean {
  return /^bc[-_]/i.test(agentId.trim());
}

function getCursorLookupBackends(agentId?: string): CursorExecutionBackend[] {
  const backends = getConfiguredCursorExecutionBackends();
  if (backends.length <= 1) return backends;

  if (agentId && isDesktopLikeCursorAgentId(agentId)) {
    return [
      ...backends.filter((backend) => backend === 'desktop'),
      ...backends.filter((backend) => backend !== 'desktop'),
    ];
  }

  if (agentId && isCloudLikeCursorAgentId(agentId)) {
    return [
      ...backends.filter((backend) => backend === 'cloud'),
      ...backends.filter((backend) => backend !== 'cloud'),
    ];
  }

  return backends;
}

function normalizeCursorLookupErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.trim().toLowerCase();
  return String(err).trim().toLowerCase();
}

function isCursorLookupNotFound(
  err: unknown,
  backend: CursorExecutionBackend,
): boolean {
  if (backend === 'cloud') {
    return err instanceof CursorCloudApiError && err.status === 404;
  }

  const message = normalizeCursorLookupErrorMessage(err);
  return message.includes('not found');
}

function mapApiAgentToDbRecord(
  apiAgent: CursorApiAgentRecord,
  context: {
    groupFolder: string;
    chatJid: string;
    promptText: string;
    createdBy?: string;
    existing?: CursorDbAgentRecord;
  },
): CursorDbAgentRecord {
  const nowIso = new Date().toISOString();
  const source = asRecord(apiAgent.source) || {};
  const target = asRecord(apiAgent.target) || {};

  return {
    id: apiAgent.id,
    group_folder: context.groupFolder,
    chat_jid: context.chatJid,
    status: toNullableString(apiAgent.status) || 'UNKNOWN',
    model: toNullableString(apiAgent.model) || context.existing?.model || null,
    prompt_text: context.promptText,
    source_repository: toNullableString(source.repository),
    source_ref: toNullableString(source.ref),
    source_pr_url: toNullableString(source.prUrl),
    target_url: toNullableString(target.url),
    target_pr_url: toNullableString(target.prUrl),
    target_branch_name: toNullableString(target.branchName),
    auto_create_pr: boolToInt(Boolean(target.autoCreatePr)),
    open_as_cursor_github_app: boolToInt(Boolean(target.openAsCursorGithubApp)),
    skip_reviewer_request: boolToInt(Boolean(target.skipReviewerRequest)),
    summary: toNullableString(apiAgent.summary),
    raw_json: JSON.stringify(apiAgent),
    created_by: context.createdBy || context.existing?.created_by || null,
    created_at:
      toNullableString(apiAgent.createdAt) ||
      context.existing?.created_at ||
      nowIso,
    updated_at:
      toNullableString(apiAgent.updatedAt) ||
      toNullableString(apiAgent.createdAt) ||
      nowIso,
    last_synced_at: nowIso,
  };
}

function mapDesktopSessionToDbRecord(
  session: CursorDesktopSession,
  context: {
    groupFolder: string;
    chatJid: string;
    promptText: string;
    createdBy?: string;
    existing?: CursorDbAgentRecord;
  },
): CursorDbAgentRecord {
  const nowIso = new Date().toISOString();

  return {
    id: session.id,
    group_folder: context.groupFolder,
    chat_jid: context.chatJid,
    status: toNullableString(session.status) || 'UNKNOWN',
    model: session.model,
    prompt_text: context.promptText || session.promptText,
    source_repository: session.sourceRepository,
    source_ref: session.sourceRef,
    source_pr_url: session.sourcePrUrl,
    target_url: session.targetUrl,
    target_pr_url: session.targetPrUrl,
    target_branch_name: session.targetBranchName,
    auto_create_pr: boolToInt(session.autoCreatePr),
    open_as_cursor_github_app: boolToInt(session.openAsCursorGithubApp),
    skip_reviewer_request: boolToInt(session.skipReviewerRequest),
    summary: session.summary,
    raw_json: JSON.stringify({
      provider: 'desktop',
      cursorSessionId: session.cursorSessionId,
      cwd: session.cwd,
      lastSyncedAt: session.lastSyncedAt,
    }),
    created_by: context.createdBy || context.existing?.created_by || null,
    created_at: session.createdAt || context.existing?.created_at || nowIso,
    updated_at: session.updatedAt || nowIso,
    last_synced_at: session.lastSyncedAt || nowIso,
  };
}

function mapApiArtifactToDbRecord(
  agentId: string,
  artifact: CursorApiArtifactRecord,
  syncedAt: string,
): CursorAgentArtifactRecord | null {
  const absolutePath = toNullableString(artifact.absolutePath);
  if (!absolutePath) return null;

  const sizeRaw = artifact.sizeBytes;
  const sizeBytes =
    typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw >= 0
      ? Math.floor(sizeRaw)
      : null;

  return {
    agent_id: agentId,
    absolute_path: absolutePath,
    size_bytes: sizeBytes,
    updated_at: toNullableString(artifact.updatedAt),
    download_url: null,
    download_url_expires_at: null,
    synced_at: syncedAt,
  };
}

export interface CursorAgentView {
  provider: CursorExecutionBackend;
  id: string;
  groupFolder: string;
  chatJid: string;
  status: string;
  model: string | null;
  promptText: string;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourcePrUrl: string | null;
  targetUrl: string | null;
  targetPrUrl: string | null;
  targetBranchName: string | null;
  autoCreatePr: boolean;
  openAsCursorGithubApp: boolean;
  skipReviewerRequest: boolean;
  summary: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
}

export interface CursorJobInventory {
  hasCloud: boolean;
  hasDesktop: boolean;
  cloudTracked: CursorAgentView[];
  desktopTracked: CursorAgentView[];
  cloudRecoverable: CursorAgentView[];
  desktopRecoverable: CursorAgentView[];
  warning: string | null;
}

export interface CursorArtifactView {
  agentId: string;
  absolutePath: string;
  sizeBytes: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  syncedAt: string;
}

export interface CursorArtifactDownloadLinkView {
  agentId: string;
  absolutePath: string;
  url: string;
  expiresAt: string | null;
}

function mapDbAgentToView(record: CursorDbAgentRecord): CursorAgentView {
  return {
    provider: recordUsesDesktop(record) ? 'desktop' : 'cloud',
    id: record.id,
    groupFolder: record.group_folder,
    chatJid: record.chat_jid,
    status: record.status,
    model: record.model,
    promptText: record.prompt_text,
    sourceRepository: record.source_repository,
    sourceRef: record.source_ref,
    sourcePrUrl: record.source_pr_url,
    targetUrl: record.target_url,
    targetPrUrl: record.target_pr_url,
    targetBranchName: record.target_branch_name,
    autoCreatePr: record.auto_create_pr === 1,
    openAsCursorGithubApp: record.open_as_cursor_github_app === 1,
    skipReviewerRequest: record.skip_reviewer_request === 1,
    summary: record.summary,
    createdBy: record.created_by,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    lastSyncedAt: record.last_synced_at,
  };
}

function mapDbArtifactToView(
  record: CursorAgentArtifactRecord,
): CursorArtifactView {
  return {
    agentId: record.agent_id,
    absolutePath: record.absolute_path,
    sizeBytes: record.size_bytes,
    updatedAt: record.updated_at,
    downloadUrl: record.download_url,
    downloadUrlExpiresAt: record.download_url_expires_at,
    syncedAt: record.synced_at,
  };
}

export interface CreateCursorAgentParams {
  groupFolder: string;
  chatJid: string;
  promptText: string;
  requestedBy?: string;
  model?: string;
  sourceRepository?: string;
  sourceRef?: string;
  sourcePrUrl?: string;
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
  branchName?: string;
}

export async function createCursorAgent(
  params: CreateCursorAgentParams,
): Promise<CursorAgentView> {
  assertValidGroupFolder(params.groupFolder);
  const maxActiveJobs = resolveCursorMaxActiveJobsPerChat();
  const activeJobs = listCursorAgentsForChat(params.chatJid, 500).filter(
    (agent) =>
      !recordUsesDesktop(agent) && !isTerminalCursorStatus(agent.status),
  );
  if (activeJobs.length >= maxActiveJobs) {
    throw new Error(
      `Cursor job limit reached for this chat (${activeJobs.length}/${maxActiveJobs} active). Stop or wait for existing jobs before creating a new one.`,
    );
  }

  if (!resolveCursorCloudConfig()) {
    throw new Error(CURSOR_CLOUD_REQUIRED_FOR_JOBS_MESSAGE);
  }

  const source: CursorCreateAgentRequest['source'] = {};
  const sourceRepository = toNullableString(params.sourceRepository);
  const sourceRef = toNullableString(params.sourceRef);
  const sourcePrUrl = toNullableString(params.sourcePrUrl);
  if (sourceRepository) source.repository = sourceRepository;
  if (sourceRef) source.ref = sourceRef;
  if (sourcePrUrl) source.prUrl = sourcePrUrl;

  const target: CursorCreateAgentRequest['target'] = {};
  if (params.autoCreatePr !== undefined)
    target.autoCreatePr = params.autoCreatePr;
  if (params.openAsCursorGithubApp !== undefined) {
    target.openAsCursorGithubApp = params.openAsCursorGithubApp;
  }
  if (params.skipReviewerRequest !== undefined) {
    target.skipReviewerRequest = params.skipReviewerRequest;
  }
  if (params.branchName) target.branchName = params.branchName;

  const request: CursorCreateAgentRequest = {
    prompt: {
      text: params.promptText,
    },
  };

  if (params.model) request.model = params.model;
  if (Object.keys(source).length > 0) request.source = source;
  if (Object.keys(target).length > 0) request.target = target;

  try {
    const client = resolveCursorClient();
    const created = await client.createAgent(request);
    const row = mapApiAgentToDbRecord(created, {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      promptText: params.promptText,
      createdBy: params.requestedBy,
    });
    upsertCursorAgent(row);
    return mapDbAgentToView(row);
  } catch (err) {
    if (err instanceof CursorCloudApiError) {
      logger.warn(
        {
          status: err.status,
          groupFolder: params.groupFolder,
          chatJid: params.chatJid,
        },
        'Cursor agent create failed',
      );
    }
    throw err;
  }
}

function mapRecoverableDesktopSessionToView(
  session: CursorDesktopSession,
  context: {
    groupFolder: string;
    chatJid: string;
  },
): CursorAgentView {
  const row = mapDesktopSessionToDbRecord(session, {
    groupFolder: session.groupFolder || context.groupFolder,
    chatJid: session.chatJid || context.chatJid,
    promptText: session.promptText,
  });
  return mapDbAgentToView(row);
}

function mapRecoverableCloudAgentToView(
  apiAgent: CursorApiAgentRecord,
  context: {
    groupFolder: string;
    chatJid: string;
  },
): CursorAgentView {
  const fallbackPrompt =
    toNullableString(apiAgent.name) || 'Recovered Cursor Cloud job';
  const row = mapApiAgentToDbRecord(apiAgent, {
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    promptText: fallbackPrompt,
  });
  return mapDbAgentToView(row);
}

async function recoverUntrackedCursorAgent(
  params: SyncCursorAgentParams,
  agentId: string,
): Promise<{ agent: CursorAgentView; artifacts: CursorArtifactView[] }> {
  const backends = getCursorLookupBackends(agentId);
  if (backends.length === 0) {
    throw new Error(CURSOR_NOT_CONFIGURED_MESSAGE);
  }

  let lastError: unknown = null;

  for (const backend of backends) {
    try {
      if (backend === 'desktop') {
        const client = resolveCursorDesktopClient();
        const session = await client.getSession(agentId);
        if (
          (session.groupFolder && session.groupFolder !== params.groupFolder) ||
          (session.chatJid && session.chatJid !== params.chatJid)
        ) {
          throw new Error(
            `Cursor desktop session ${agentId} belongs to another workspace.`,
          );
        }
        const row = mapDesktopSessionToDbRecord(session, {
          groupFolder: session.groupFolder || params.groupFolder,
          chatJid: session.chatJid || params.chatJid,
          promptText: session.promptText,
        });
        upsertCursorAgent(row);
        replaceCursorAgentArtifacts(agentId, []);
        return {
          agent: mapDbAgentToView(row),
          artifacts: [],
        };
      }

      const client = resolveCursorClient();
      const apiAgent = await client.getAgent(agentId);
      const row = mapApiAgentToDbRecord(apiAgent, {
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        promptText:
          toNullableString(apiAgent.name) || 'Recovered Cursor Cloud job',
      });
      upsertCursorAgent(row);

      let artifactViews: CursorArtifactView[] = [];
      try {
        const syncedAt = new Date().toISOString();
        const listed = await client.listArtifacts(agentId);
        const artifacts = listed.artifacts
          .map((artifact) =>
            mapApiArtifactToDbRecord(agentId, artifact, syncedAt),
          )
          .filter(
            (artifact): artifact is CursorAgentArtifactRecord =>
              artifact !== null,
          );
        replaceCursorAgentArtifacts(agentId, artifacts);
        artifactViews = artifacts.map(mapDbArtifactToView);
      } catch (err) {
        logger.debug(
          { err: String(err), agentId },
          'Recovered Cursor artifact sync skipped',
        );
      }

      return {
        agent: mapDbAgentToView(row),
        artifacts: artifactViews,
      };
    } catch (err) {
      lastError = err;
      if (!isCursorLookupNotFound(err, backend)) {
        throw err;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `Cursor agent ${agentId} was not found on the configured Cursor backend.`,
    )
  );
}

interface EnsureTrackedCursorAgentResult {
  record: CursorDbAgentRecord;
  recovered: boolean;
}

async function ensureTrackedCursorAgent(
  params: {
    groupFolder: string;
    chatJid: string;
  },
  agentId: string,
): Promise<EnsureTrackedCursorAgentResult> {
  const existing = getCursorAgentById(agentId);
  if (existing) {
    if (existing.group_folder !== params.groupFolder) {
      throw new Error('Cursor agent belongs to another group');
    }
    return {
      record: existing,
      recovered: false,
    };
  }

  await recoverUntrackedCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      agentId,
    },
    agentId,
  );

  const recovered = getCursorAgentById(agentId);
  if (!recovered) {
    throw new Error(
      `Cursor agent ${agentId} could not be attached to this workspace.`,
    );
  }
  if (recovered.group_folder !== params.groupFolder) {
    throw new Error('Cursor agent belongs to another group');
  }
  return {
    record: recovered,
    recovered: true,
  };
}

export interface SyncCursorAgentParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
}

export async function syncCursorAgent(
  params: SyncCursorAgentParams,
): Promise<{ agent: CursorAgentView; artifacts: CursorArtifactView[] }> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  const existing = getCursorAgentById(agentId);
  if (existing && existing.group_folder !== params.groupFolder) {
    throw new Error('Cursor agent belongs to another group');
  }

  if (!existing) {
    return recoverUntrackedCursorAgent(params, agentId);
  }

  if (recordUsesDesktop(existing)) {
    const client = resolveCursorDesktopClient();
    const session = await client.getSession(agentId);
    const row = mapDesktopSessionToDbRecord(session, {
      groupFolder: existing?.group_folder || params.groupFolder,
      chatJid: existing?.chat_jid || params.chatJid,
      promptText: existing?.prompt_text || session.promptText,
      existing,
    });
    upsertCursorAgent(row);
    replaceCursorAgentArtifacts(agentId, []);
    return {
      agent: mapDbAgentToView(row),
      artifacts: [],
    };
  }

  const client = resolveCursorClient();
  const apiAgent = await client.getAgent(agentId);

  const row = mapApiAgentToDbRecord(apiAgent, {
    groupFolder: existing?.group_folder || params.groupFolder,
    chatJid: existing?.chat_jid || params.chatJid,
    promptText: existing?.prompt_text || '',
    existing,
  });
  upsertCursorAgent(row);

  let artifactViews: CursorArtifactView[] = [];
  try {
    const syncedAt = new Date().toISOString();
    const listed = await client.listArtifacts(agentId);
    const artifacts = listed.artifacts
      .map((artifact) => mapApiArtifactToDbRecord(agentId, artifact, syncedAt))
      .filter(
        (artifact): artifact is CursorAgentArtifactRecord => artifact !== null,
      );
    replaceCursorAgentArtifacts(agentId, artifacts);
    artifactViews = artifacts.map(mapDbArtifactToView);
  } catch (err) {
    logger.debug(
      {
        err: String(err),
        agentId,
      },
      'Cursor artifact sync skipped',
    );
  }

  return {
    agent: mapDbAgentToView(row),
    artifacts: artifactViews,
  };
}

export interface FollowupCursorAgentParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
  promptText: string;
}

export async function followupCursorAgent(
  params: FollowupCursorAgentParams,
): Promise<CursorAgentView> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  const { record: existing } = await ensureTrackedCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );

  if (recordUsesDesktop(existing)) {
    throw new Error(CURSOR_CLOUD_ONLY_FOLLOWUP_MESSAGE);
  }

  const client = resolveCursorClient();
  let followed = await client.followupAgent(agentId, {
    prompt: { text: params.promptText },
  });
  if (!toNullableString(followed.status)) {
    try {
      followed = await client.getAgent(agentId);
    } catch (err) {
      logger.debug(
        { err: String(err), agentId },
        'Cursor follow-up status refresh skipped',
      );
    }
  }

  const row = mapApiAgentToDbRecord(followed, {
    groupFolder: existing.group_folder,
    chatJid: existing.chat_jid || params.chatJid,
    promptText: existing.prompt_text,
    existing,
  });
  upsertCursorAgent(row);
  return mapDbAgentToView(row);
}

export interface StopCursorAgentParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
}

export async function stopCursorAgent(
  params: StopCursorAgentParams,
): Promise<CursorAgentView> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  const { record: existing } = await ensureTrackedCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );

  if (recordUsesDesktop(existing)) {
    throw new Error(CURSOR_CLOUD_ONLY_STOP_MESSAGE);
  }

  const client = resolveCursorClient();
  const stopped = await client.stopAgent(agentId);

  const row = mapApiAgentToDbRecord(stopped, {
    groupFolder: existing.group_folder,
    chatJid: existing.chat_jid || params.chatJid,
    promptText: existing.prompt_text,
    existing,
  });
  upsertCursorAgent(row);
  return mapDbAgentToView(row);
}

export function listStoredCursorAgentsForGroup(
  groupFolder: string,
  limit = 50,
): CursorAgentView[] {
  assertValidGroupFolder(groupFolder);
  return listCursorAgentsForGroup(groupFolder, limit).map(mapDbAgentToView);
}

export async function listCursorJobInventory(params: {
  groupFolder: string;
  chatJid: string;
  limit?: number;
}): Promise<CursorJobInventory> {
  assertValidGroupFolder(params.groupFolder);
  const safeLimit =
    params.limit && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 20;
  const tracked = listStoredCursorAgentsForGroup(params.groupFolder, safeLimit);
  const cloudTracked = tracked.filter((agent) => agent.provider === 'cloud');
  const desktopTracked = tracked.filter(
    (agent) => agent.provider === 'desktop',
  );
  const trackedIds = new Set(tracked.map((agent) => agent.id));
  const backends = getConfiguredCursorExecutionBackends();
  if (backends.length === 0) {
    return {
      hasCloud: false,
      hasDesktop: false,
      cloudTracked,
      desktopTracked,
      cloudRecoverable: [],
      desktopRecoverable: [],
      warning: null,
    };
  }
  const cloudRecoverable: CursorAgentView[] = [];
  const desktopRecoverable: CursorAgentView[] = [];
  const warnings: string[] = [];
  const recoverableIds = new Set<string>();

  for (const backend of backends) {
    try {
      if (backend === 'desktop') {
        const client = resolveCursorDesktopClient();
        const sessions = await client.listSessions(safeLimit);
        for (const session of sessions) {
          if (trackedIds.has(session.id) || recoverableIds.has(session.id)) {
            continue;
          }
          const existing = getCursorAgentById(session.id);
          if (existing && existing.group_folder !== params.groupFolder) {
            continue;
          }
          if (
            session.groupFolder &&
            session.groupFolder !== params.groupFolder
          ) {
            continue;
          }
          if (session.chatJid && session.chatJid !== params.chatJid) {
            continue;
          }
          desktopRecoverable.push(
            mapRecoverableDesktopSessionToView(session, {
              groupFolder: params.groupFolder,
              chatJid: params.chatJid,
            }),
          );
          recoverableIds.add(session.id);
        }
        continue;
      }

      const client = resolveCursorClient();
      const listed = await client.listAgents({ limit: safeLimit });
      for (const agent of listed.agents || []) {
        const normalizedId = normalizeCursorAgentId(agent.id);
        if (trackedIds.has(normalizedId) || recoverableIds.has(normalizedId)) {
          continue;
        }
        const existing = getCursorAgentById(normalizedId);
        if (existing && existing.group_folder !== params.groupFolder) {
          continue;
        }
        cloudRecoverable.push(
          mapRecoverableCloudAgentToView(agent, {
            groupFolder: params.groupFolder,
            chatJid: params.chatJid,
          }),
        );
        recoverableIds.add(normalizedId);
      }
    } catch (err) {
      warnings.push(
        `${backend === 'desktop' ? 'Desktop bridge' : 'Cursor Cloud'}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    hasCloud: backends.includes('cloud'),
    hasDesktop: backends.includes('desktop'),
    cloudTracked,
    desktopTracked,
    cloudRecoverable,
    desktopRecoverable,
    warning: warnings.length > 0 ? warnings.join(' | ') : null,
  };
}

export function listAllStoredCursorAgents(limit = 200): CursorAgentView[] {
  return listAllCursorAgents(limit).map(mapDbAgentToView);
}

export function listStoredCursorArtifacts(
  agentId: string,
): CursorArtifactView[] {
  const normalizedId = normalizeCursorAgentId(agentId);
  return listCursorAgentArtifacts(normalizedId).map(mapDbArtifactToView);
}

export interface GetCursorArtifactDownloadLinkParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
  absolutePath: string;
}

export interface GetCursorAgentArtifactsParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
}

function normalizeArtifactAbsolutePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Artifact path is required');
  }
  if (trimmed.length > 4096) {
    throw new Error('Artifact path is too long');
  }
  return trimmed;
}

function normalizeArtifactDownloadUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new Error('Cursor returned an invalid artifact download URL', {
      cause: err,
    });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Cursor returned an unsupported artifact download URL');
  }

  return parsed.toString();
}

export async function getCursorArtifactDownloadLink(
  params: GetCursorArtifactDownloadLinkParams,
): Promise<CursorArtifactDownloadLinkView> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  const absolutePath = normalizeArtifactAbsolutePath(params.absolutePath);
  const { record: existing } = await ensureTrackedCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  if (
    existing.group_folder !== params.groupFolder ||
    existing.chat_jid !== params.chatJid
  ) {
    throw new Error('Cursor agent belongs to another group');
  }
  if (recordUsesDesktop(existing)) {
    throw new Error(CURSOR_CLOUD_ONLY_ARTIFACT_LINK_MESSAGE);
  }

  const artifacts = listCursorAgentArtifacts(agentId);
  let tracked = artifacts.some(
    (artifact) => artifact.absolute_path === absolutePath,
  );
  if (!tracked) {
    const synced = await syncCursorAgent({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      agentId,
    });
    tracked = synced.artifacts.some(
      (artifact) => artifact.absolutePath === absolutePath,
    );
  }
  if (!tracked) {
    throw new Error(
      `Artifact path "${absolutePath}" is not tracked for Cursor agent ${agentId}. Run /cursor-sync ${agentId} first.`,
    );
  }

  const client = resolveCursorClient();
  const response = await client.getArtifactDownloadLink(agentId, absolutePath);
  const url = toNullableString(response.url);
  if (!url) {
    throw new Error('Cursor did not return an artifact download URL');
  }

  return {
    agentId,
    absolutePath,
    url: normalizeArtifactDownloadUrl(url),
    expiresAt: toNullableString(response.expiresAt),
  };
}

export interface CursorConversationMessageView {
  role: string;
  content: string;
  createdAt: string | null;
}

export interface GetCursorAgentConversationParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
  limit?: number;
}

export async function getCursorAgentConversation(
  params: GetCursorAgentConversationParams,
): Promise<CursorConversationMessageView[]> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  const { record: existing } = await ensureTrackedCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  if (
    existing.group_folder !== params.groupFolder ||
    existing.chat_jid !== params.chatJid
  ) {
    throw new Error('Cursor agent belongs to another group');
  }

  if (recordUsesDesktop(existing)) {
    const client = resolveCursorDesktopClient();
    const conversation = await client.getConversation(agentId, params.limit);
    return conversation.map((message: CursorDesktopConversationMessage) => ({
      role: toNullableString(message.role) || 'assistant',
      content: message.content,
      createdAt: message.createdAt,
    }));
  }

  const client = resolveCursorClient();
  const conversation = await client.getConversation(agentId);
  const limit =
    params.limit && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 20;
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
        .map((message) => ({
          role: toNullableString(message.role) || 'unknown',
          content:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content ?? ''),
          createdAt: toNullableString(message.createdAt),
        }))
        .slice(-limit)
    : [];

  return messages;
}

export interface CursorTerminalStatusView {
  available: boolean;
  status: string;
  shell: string | null;
  cwd: string | null;
  lastCommand: string | null;
  activeCommandId: string | null;
  lastCompletedCommandId: string | null;
  lastExitCode: number | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  activePid: number | null;
  outputLineCount: number;
}

export interface CursorTerminalOutputLineView {
  commandId: string | null;
  stream: string;
  text: string;
  createdAt: string | null;
}

export interface RunCursorTerminalCommandParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
  commandText: string;
}

export interface GetCursorTerminalStatusParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
}

export interface GetCursorTerminalOutputParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
  limit?: number;
  commandId?: string | null;
}

export interface StopCursorTerminalParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
}

export interface CursorTerminalCommandRunView {
  commandId: string;
  terminal: CursorTerminalStatusView;
  output: CursorTerminalOutputLineView[];
}

function mapTerminalStatusToView(
  status: CursorDesktopTerminalStatus,
): CursorTerminalStatusView {
  return {
    available: status.available,
    status: status.status,
    shell: status.shell,
    cwd: status.cwd,
    lastCommand: status.lastCommand,
    activeCommandId: status.activeCommandId,
    lastCompletedCommandId: status.lastCompletedCommandId,
    lastExitCode: status.lastExitCode,
    lastStartedAt: status.lastStartedAt,
    lastFinishedAt: status.lastFinishedAt,
    activePid: status.activePid,
    outputLineCount: status.outputLineCount,
  };
}

function mapTerminalOutputToView(
  line: CursorDesktopTerminalOutputLine,
): CursorTerminalOutputLineView {
  return {
    commandId: line.commandId,
    stream: line.stream,
    text: line.text,
    createdAt: line.createdAt,
  };
}

function assertDesktopBridgeConfigured(): void {
  if (!resolveCursorDesktopConfig()) {
    throw new Error(
      'Cursor desktop bridge is not configured. Set CURSOR_DESKTOP_BRIDGE_URL and CURSOR_DESKTOP_BRIDGE_TOKEN to reach your normal machine.',
    );
  }
}

async function ensureTrackedDesktopCursorAgent(
  params: {
    groupFolder: string;
    chatJid: string;
  },
  agentId: string,
): Promise<CursorDbAgentRecord> {
  assertDesktopBridgeConfigured();
  const { record } = await ensureTrackedCursorAgent(params, agentId);
  if (
    record.group_folder !== params.groupFolder ||
    record.chat_jid !== params.chatJid
  ) {
    throw new Error('Cursor agent belongs to another group');
  }
  if (!recordUsesDesktop(record)) {
    throw new Error(
      'Cursor terminal control is only available for desktop bridge sessions on your own machine.',
    );
  }
  return record;
}

function normalizeTerminalOutputLimit(raw: number | undefined): number {
  return raw && Number.isFinite(raw)
    ? Math.max(1, Math.min(200, Math.floor(raw)))
    : 40;
}

export async function getCursorTerminalStatus(
  params: GetCursorTerminalStatusParams,
): Promise<CursorTerminalStatusView> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  await ensureTrackedDesktopCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  const client = resolveCursorDesktopClient();
  const status = await client.getTerminalStatus(agentId);
  return mapTerminalStatusToView(status);
}

export async function getCursorTerminalOutput(
  params: GetCursorTerminalOutputParams,
): Promise<CursorTerminalOutputLineView[]> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  await ensureTrackedDesktopCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  const client = resolveCursorDesktopClient();
  const lines = await client.listTerminalOutput(agentId, {
    limit: normalizeTerminalOutputLimit(params.limit),
    commandId: params.commandId,
  });
  return lines.map(mapTerminalOutputToView);
}

export async function runCursorTerminalCommand(
  params: RunCursorTerminalCommandParams,
): Promise<CursorTerminalCommandRunView> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  await ensureTrackedDesktopCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  const client = resolveCursorDesktopClient();
  const started = await client.startTerminalCommand(agentId, {
    commandText: params.commandText,
  });
  const [terminal, output] = await Promise.all([
    client.getTerminalStatus(agentId),
    client.listTerminalOutput(agentId, {
      limit: 60,
      commandId: started.commandId,
    }),
  ]);

  return {
    commandId: started.commandId,
    terminal: mapTerminalStatusToView(terminal),
    output: output.map(mapTerminalOutputToView),
  };
}

export async function stopCursorTerminal(
  params: StopCursorTerminalParams,
): Promise<CursorTerminalStatusView> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  await ensureTrackedDesktopCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  const client = resolveCursorDesktopClient();
  const status = await client.stopTerminalCommand(agentId);
  return mapTerminalStatusToView(status);
}

export async function getCursorAgentArtifacts(
  params: GetCursorAgentArtifactsParams,
): Promise<CursorArtifactView[]> {
  assertValidGroupFolder(params.groupFolder);
  const agentId = normalizeCursorAgentId(params.agentId);
  const { record: existing, recovered } = await ensureTrackedCursorAgent(
    {
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    },
    agentId,
  );
  if (
    existing.group_folder !== params.groupFolder ||
    existing.chat_jid !== params.chatJid
  ) {
    throw new Error('Cursor agent belongs to another group');
  }
  if (recordUsesDesktop(existing)) {
    throw new Error(CURSOR_CLOUD_ONLY_ARTIFACTS_MESSAGE);
  }

  const stored = listCursorAgentArtifacts(agentId).map(mapDbArtifactToView);
  if (stored.length > 0 && !recovered) {
    return stored;
  }

  try {
    const synced = await syncCursorAgent({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      agentId,
    });
    if (synced.artifacts.length > 0 || recovered) {
      return synced.artifacts;
    }
  } catch (err) {
    if (stored.length > 0) {
      logger.debug(
        { err: String(err), agentId },
        'Returning stored Cursor artifacts after live refresh failed',
      );
      return stored;
    }
    throw err;
  }

  return stored;
}

function toCursorModelView(record: CursorModelRecord): CursorModelView {
  return {
    id: toNullableString(record.id) || 'unknown',
    name: toNullableString(record.name),
  };
}

export interface CursorModelView {
  id: string;
  name: string | null;
}

export async function listCursorModels(limit = 50): Promise<CursorModelView[]> {
  if (!resolveCursorCloudConfig()) {
    if (resolveCursorDesktopConfig()) {
      throw new Error(
        'Cursor model listing is only available through the Cursor Cloud API right now. The desktop bridge remains useful for session recovery and terminal control, but queued heavy work stays on Cursor Cloud in the current product.',
      );
    }
  }
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : 50;
  const client = resolveCursorClient();
  const listed = await client.listModels();
  const seen = new Set<string>();
  const models = (listed.models || [])
    .map(toCursorModelView)
    .filter((model) => {
      const dedupeKey = model.id.toLowerCase();
      if (!dedupeKey || seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .slice(0, safeLimit);

  return models;
}
