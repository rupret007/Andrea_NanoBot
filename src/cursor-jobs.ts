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
  CursorCloudApiError,
  CursorCloudClient,
  CursorCreateAgentRequest,
  resolveCursorCloudConfig,
} from './cursor-cloud.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';

const CURSOR_GUARDRAIL_ENV_KEYS = ['CURSOR_MAX_ACTIVE_JOBS_PER_CHAT'] as const;
const DEFAULT_CURSOR_MAX_ACTIVE_JOBS_PER_CHAT = 4;

function boolToInt(value: boolean | undefined): number {
  return value ? 1 : 0;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
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

export interface CursorArtifactView {
  agentId: string;
  absolutePath: string;
  sizeBytes: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  syncedAt: string;
}

function mapDbAgentToView(record: CursorDbAgentRecord): CursorAgentView {
  return {
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

function mapDbArtifactToView(record: CursorAgentArtifactRecord): CursorArtifactView {
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
    (agent) => !isTerminalCursorStatus(agent.status),
  );
  if (activeJobs.length >= maxActiveJobs) {
    throw new Error(
      `Cursor job limit reached for this chat (${activeJobs.length}/${maxActiveJobs} active). Stop or wait for existing jobs before creating a new one.`,
    );
  }

  const client = resolveCursorClient();

  const source: CursorCreateAgentRequest['source'] = {};
  const sourceRepository = toNullableString(params.sourceRepository);
  const sourceRef = toNullableString(params.sourceRef);
  const sourcePrUrl = toNullableString(params.sourcePrUrl);
  if (sourceRepository) source.repository = sourceRepository;
  if (sourceRef) source.ref = sourceRef;
  if (sourcePrUrl) source.prUrl = sourcePrUrl;

  const target: CursorCreateAgentRequest['target'] = {};
  if (params.autoCreatePr !== undefined) target.autoCreatePr = params.autoCreatePr;
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

export interface SyncCursorAgentParams {
  groupFolder: string;
  chatJid: string;
  agentId: string;
}

export async function syncCursorAgent(
  params: SyncCursorAgentParams,
): Promise<{ agent: CursorAgentView; artifacts: CursorArtifactView[] }> {
  assertValidGroupFolder(params.groupFolder);
  const existing = getCursorAgentById(params.agentId);
  if (existing && existing.group_folder !== params.groupFolder) {
    throw new Error('Cursor agent belongs to another group');
  }

  const client = resolveCursorClient();
  const apiAgent = await client.getAgent(params.agentId);

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
    const listed = await client.listArtifacts(params.agentId);
    const artifacts = listed.artifacts
      .map((artifact) =>
        mapApiArtifactToDbRecord(params.agentId, artifact, syncedAt),
      )
      .filter((artifact): artifact is CursorAgentArtifactRecord => artifact !== null);
    replaceCursorAgentArtifacts(params.agentId, artifacts);
    artifactViews = artifacts.map(mapDbArtifactToView);
  } catch (err) {
    logger.debug(
      {
        err: String(err),
        agentId: params.agentId,
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
  const existing = getCursorAgentById(params.agentId);
  if (!existing) {
    throw new Error(`Cursor agent ${params.agentId} is not tracked in this workspace`);
  }
  if (existing.group_folder !== params.groupFolder) {
    throw new Error('Cursor agent belongs to another group');
  }

  const client = resolveCursorClient();
  const followed = await client.followupAgent(params.agentId, {
    prompt: { text: params.promptText },
  });

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
  const existing = getCursorAgentById(params.agentId);
  if (!existing) {
    throw new Error(`Cursor agent ${params.agentId} is not tracked in this workspace`);
  }
  if (existing.group_folder !== params.groupFolder) {
    throw new Error('Cursor agent belongs to another group');
  }

  const client = resolveCursorClient();
  const stopped = await client.stopAgent(params.agentId);

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

export function listAllStoredCursorAgents(limit = 200): CursorAgentView[] {
  return listAllCursorAgents(limit).map(mapDbAgentToView);
}

export function listStoredCursorArtifacts(agentId: string): CursorArtifactView[] {
  return listCursorAgentArtifacts(agentId).map(mapDbArtifactToView);
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
  const existing = getCursorAgentById(params.agentId);
  if (!existing) {
    throw new Error(`Cursor agent ${params.agentId} is not tracked in this workspace`);
  }
  if (existing.group_folder !== params.groupFolder || existing.chat_jid !== params.chatJid) {
    throw new Error('Cursor agent belongs to another group');
  }

  const client = resolveCursorClient();
  const conversation = await client.getConversation(params.agentId);
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
