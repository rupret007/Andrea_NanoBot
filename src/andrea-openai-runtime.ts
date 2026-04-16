import crypto from 'crypto';

import {
  ANDREA_OPENAI_BACKEND_ID,
  AndreaOpenAiBackendClient,
  AndreaOpenAiBackendHttpError,
  AndreaOpenAiBackendTransportError,
  type EnsureBackendGroupRequest,
} from './andrea-openai-backend.js';
import {
  getRuntimeBackendJob,
  upsertRuntimeBackendJob,
} from './db.js';
import type {
  AgentRuntimeName,
  CompanionRouteDecision,
  RegisteredGroup,
  RuntimeBackendJob,
  RuntimeBackendJobLogs,
  RuntimeBackendStatus,
  RuntimeBackendStopResult,
} from './types.js';

export type AndreaOpenAiRuntimeErrorKind =
  | 'not_enabled'
  | 'unavailable'
  | 'not_ready'
  | 'bootstrap_required'
  | 'bootstrap_failed'
  | 'not_found'
  | 'validation'
  | 'context_mismatch';

export class AndreaOpenAiRuntimeError extends Error {
  constructor(
    readonly kind: AndreaOpenAiRuntimeErrorKind,
    message: string,
    readonly detail: string | null = null,
    readonly groupFolder: string | null = null,
  ) {
    super(message);
    this.name = 'AndreaOpenAiRuntimeError';
  }
}

export interface RuntimeContextInput {
  chatJid: string;
  group: RegisteredGroup;
  actorId?: string | null;
}

export interface RuntimeJobsInput extends RuntimeContextInput {
  limit?: number;
  beforeJobId?: string;
}

export interface RuntimeCreateInput extends RuntimeContextInput {
  prompt: string;
  requestedRuntime?: AgentRuntimeName | null;
}

export interface RuntimeJobInput extends RuntimeContextInput {
  jobId: string;
}

export interface RuntimeFollowUpInput extends RuntimeJobInput {
  prompt: string;
}

export interface RuntimeLogsInput extends RuntimeJobInput {
  lines?: number;
}

type EnsureGroupResult = 'registered' | 'unsupported';

function trimDetail(message: string): string {
  return message.trim();
}

function buildSource(input: RuntimeContextInput) {
  return {
    system: 'andrea_nanobot',
    actorType: 'chat',
    actorId: input.actorId || input.chatJid,
    correlationId: crypto.randomUUID(),
  } as const;
}

function cacheJob(chatJid: string, job: RuntimeBackendJob): void {
  upsertRuntimeBackendJob({
    backend_id: job.backend,
    job_id: job.jobId,
    group_folder: job.groupFolder,
    chat_jid: chatJid,
    thread_id: job.threadId || null,
    status: job.status,
    selected_runtime: job.selectedRuntime || null,
    prompt_preview: job.promptPreview,
    latest_output_text: job.latestOutputText || null,
    error_text: job.errorText || null,
    log_file: job.logFile || null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    raw_json: JSON.stringify(job),
  });
}

function ensureContextMatches(
  chatJid: string,
  group: RegisteredGroup,
  job: RuntimeBackendJob,
): void {
  if (job.groupFolder !== group.folder) {
    throw new AndreaOpenAiRuntimeError(
      'context_mismatch',
      `Job ${job.jobId} belongs to backend group "${job.groupFolder}", not the current control context "${group.folder}".`,
      null,
      group.folder,
    );
  }

  const cached = getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, job.jobId);
  if (cached && cached.chat_jid !== chatJid) {
    throw new AndreaOpenAiRuntimeError(
      'context_mismatch',
      `Job ${job.jobId} is already associated with a different NanoBot control context.`,
      null,
      group.folder,
    );
  }
}

function isMissingGroupRegistrationError(
  err: unknown,
  groupFolder: string,
): boolean {
  return (
    err instanceof AndreaOpenAiBackendHttpError &&
    err.status === 404 &&
    err.message.includes(`No registered group found for folder "${groupFolder}"`)
  );
}

function classifyBackendError(
  err: unknown,
  groupFolder: string | null = null,
): AndreaOpenAiRuntimeError {
  if (err instanceof AndreaOpenAiRuntimeError) {
    return err;
  }

  if (err instanceof AndreaOpenAiBackendTransportError) {
    return new AndreaOpenAiRuntimeError(
      'unavailable',
      'Andrea OpenAI backend is unavailable on loopback.',
      trimDetail(err.message),
      groupFolder,
    );
  }

  if (err instanceof AndreaOpenAiBackendHttpError) {
    if (err.status === 404) {
      return new AndreaOpenAiRuntimeError(
        'not_found',
        trimDetail(err.message),
        null,
        groupFolder,
      );
    }

    if (err.status === 400) {
      return new AndreaOpenAiRuntimeError(
        'validation',
        trimDetail(err.message),
        null,
        groupFolder,
      );
    }

    return new AndreaOpenAiRuntimeError(
      'unavailable',
      'Andrea OpenAI backend returned an unexpected HTTP failure.',
      trimDetail(err.message),
      groupFolder,
    );
  }

  return new AndreaOpenAiRuntimeError(
    'unavailable',
    'Andrea OpenAI backend request failed.',
    trimDetail(err instanceof Error ? err.message : String(err)),
    groupFolder,
  );
}

async function ensureBackendGroup(
  client: AndreaOpenAiBackendClient,
  request: EnsureBackendGroupRequest,
): Promise<EnsureGroupResult> {
  try {
    await client.ensureGroupRegistration(request);
    return 'registered';
  } catch (err) {
    if (err instanceof AndreaOpenAiBackendHttpError && err.route.startsWith('/groups/')) {
      if (err.status === 404 || err.status === 405) {
        return 'unsupported';
      }

      throw new AndreaOpenAiRuntimeError(
        'bootstrap_failed',
        `Andrea OpenAI backend could not register backend group "${request.group.folder}" automatically.`,
        trimDetail(err.message),
        request.group.folder,
      );
    }
    throw classifyBackendError(err, request.group.folder);
  }
}

function buildBootstrapRequiredError(groupFolder: string): AndreaOpenAiRuntimeError {
  return new AndreaOpenAiRuntimeError(
    'bootstrap_required',
    `Andrea OpenAI backend is reachable, but backend group "${groupFolder}" is not registered yet.`,
    'This backend does not expose the local group registration route yet. Register the backend group first or enable PUT /groups/:groupFolder in Andrea_OpenAI_Bot.',
    groupFolder,
  );
}

function classifyCreateRetryFailure(
  err: unknown,
  groupFolder: string,
): AndreaOpenAiRuntimeError {
  const classified = classifyBackendError(err, groupFolder);
  if (classified.kind === 'unavailable') {
    return classified;
  }

  return new AndreaOpenAiRuntimeError(
    'bootstrap_failed',
    `Andrea OpenAI backend registered backend group "${groupFolder}", but job creation still failed on retry.`,
    classified.detail || classified.message,
    groupFolder,
  );
}

export async function getAndreaOpenAiBackendStatus(
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendStatus> {
  return client.getStatus();
}

export async function routeAndreaOpenAiCompanionPrompt(
  input: {
    channel: 'telegram' | 'bluebubbles';
    text: string;
    requestRoute: 'direct_assistant' | 'protected_assistant';
    conversationSummary?: string | null;
    replyText?: string | null;
    priorPersonName?: string | null;
    priorThreadTitle?: string | null;
    priorLastAnswerSummary?: string | null;
  },
  client = new AndreaOpenAiBackendClient(),
): Promise<CompanionRouteDecision> {
  ensureBackendEnabled(client);
  try {
    return await client.routePrompt(input);
  } catch (err) {
    throw classifyBackendError(err, null);
  }
}

function ensureBackendEnabled(client: AndreaOpenAiBackendClient): void {
  if (!client.enabled) {
    throw new AndreaOpenAiRuntimeError(
      'not_enabled',
      'Andrea OpenAI backend is not enabled in this NanoBot runtime.',
      'Set ANDREA_OPENAI_BACKEND_ENABLED=true to enable the loopback backend lane.',
      null,
    );
  }
}

export async function createAndreaOpenAiRuntimeJob(
  input: RuntimeCreateInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendJob> {
  ensureBackendEnabled(client);

  try {
    const job = await client.createJob({
      groupFolder: input.group.folder,
      prompt: input.prompt,
      requestedRuntime: input.requestedRuntime || null,
      source: buildSource(input),
    });
    cacheJob(input.chatJid, job);
    return job;
  } catch (err) {
    if (isMissingGroupRegistrationError(err, input.group.folder)) {
      const ensureResult = await ensureBackendGroup(client, {
        jid: input.chatJid,
        group: input.group,
      });
      if (ensureResult === 'registered') {
        try {
          const job = await client.createJob({
            groupFolder: input.group.folder,
            prompt: input.prompt,
            requestedRuntime: input.requestedRuntime || null,
            source: buildSource(input),
          });
          cacheJob(input.chatJid, job);
          return job;
        } catch (retryErr) {
          throw classifyCreateRetryFailure(retryErr, input.group.folder);
        }
      }

      throw buildBootstrapRequiredError(input.group.folder);
    }

    throw classifyBackendError(err, input.group.folder);
  }
}

export async function listAndreaOpenAiRuntimeJobs(
  input: RuntimeJobsInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<{
  jobs: RuntimeBackendJob[];
  nextBeforeJobId?: string | null;
}> {
  ensureBackendEnabled(client);

  try {
    const result = await client.listJobs({
      groupFolder: input.group.folder,
      limit: input.limit,
      beforeJobId: input.beforeJobId,
    });
    for (const job of result.jobs) {
      cacheJob(input.chatJid, job);
    }
    return result;
  } catch (err) {
    if (isMissingGroupRegistrationError(err, input.group.folder)) {
      const ensureResult = await ensureBackendGroup(client, {
        jid: input.chatJid,
        group: input.group,
      });
      if (ensureResult === 'registered') {
        try {
          const result = await client.listJobs({
            groupFolder: input.group.folder,
            limit: input.limit,
            beforeJobId: input.beforeJobId,
          });
          for (const job of result.jobs) {
            cacheJob(input.chatJid, job);
          }
          return result;
        } catch (retryErr) {
          throw classifyBackendError(retryErr, input.group.folder);
        }
      }

      throw buildBootstrapRequiredError(input.group.folder);
    }

    throw classifyBackendError(err, input.group.folder);
  }
}

export async function getAndreaOpenAiRuntimeJob(
  input: RuntimeJobInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendJob> {
  ensureBackendEnabled(client);
  try {
    const job = await client.getJob(input.jobId);
    ensureContextMatches(input.chatJid, input.group, job);
    cacheJob(input.chatJid, job);
    return job;
  } catch (err) {
    throw classifyBackendError(err, input.group.folder);
  }
}

export async function followUpAndreaOpenAiRuntimeJob(
  input: RuntimeFollowUpInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendJob> {
  ensureBackendEnabled(client);

  await getAndreaOpenAiRuntimeJob(
    {
      chatJid: input.chatJid,
      group: input.group,
      jobId: input.jobId,
      actorId: input.actorId,
    },
    client,
  );

  try {
    const job = await client.followUp({
      jobId: input.jobId,
      prompt: input.prompt,
      source: buildSource(input),
    });
    ensureContextMatches(input.chatJid, input.group, job);
    cacheJob(input.chatJid, job);
    return job;
  } catch (err) {
    throw classifyBackendError(err, input.group.folder);
  }
}

export async function followUpAndreaOpenAiRuntimeGroup(
  input: RuntimeCreateInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendJob> {
  ensureBackendEnabled(client);

  try {
    const job = await client.followUpTarget({
      groupFolder: input.group.folder,
      prompt: input.prompt,
      source: buildSource(input),
    });
    ensureContextMatches(input.chatJid, input.group, job);
    cacheJob(input.chatJid, job);
    return job;
  } catch (err) {
    throw classifyBackendError(err, input.group.folder);
  }
}

export async function getAndreaOpenAiRuntimeJobLogs(
  input: RuntimeLogsInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendJobLogs> {
  ensureBackendEnabled(client);

  await getAndreaOpenAiRuntimeJob(
    {
      chatJid: input.chatJid,
      group: input.group,
      jobId: input.jobId,
      actorId: input.actorId,
    },
    client,
  );

  try {
    return await client.getJobLogs({
      jobId: input.jobId,
      lines: input.lines,
    });
  } catch (err) {
    throw classifyBackendError(err, input.group.folder);
  }
}

export async function stopAndreaOpenAiRuntimeJob(
  input: RuntimeJobInput,
  client = new AndreaOpenAiBackendClient(),
): Promise<RuntimeBackendStopResult> {
  ensureBackendEnabled(client);

  await getAndreaOpenAiRuntimeJob(
    {
      chatJid: input.chatJid,
      group: input.group,
      jobId: input.jobId,
      actorId: input.actorId,
    },
    client,
  );

  try {
    const result = await client.stopJob({
      jobId: input.jobId,
      source: buildSource(input),
    });
    ensureContextMatches(input.chatJid, input.group, result.job);
    cacheJob(input.chatJid, result.job);
    return result;
  } catch (err) {
    throw classifyBackendError(err, input.group.folder);
  }
}
