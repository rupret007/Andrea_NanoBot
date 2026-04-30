/**
 * v14 Phase 1 — JobLaneAdapter implementations that wrap the real
 * cursor-jobs and andrea-openai-runtime APIs.
 *
 * Kept in its own module from the index.ts wire-up so the dispatcher
 * (job-dispatch.ts) can stay a pure flow operator with the heavy
 * dependencies (db.ts, runtime client, cursor cloud client) only loaded
 * here.
 *
 * Status normalisation: each backend has its own vocabulary (cursor
 * uses 'completed' / 'finished' / 'cancelled' / 'error' / 'failed' /
 * etc., runtime uses 'queued' / 'running' / 'succeeded' / 'failed').
 * The adapters collapse both onto the canonical JobStatus enum the
 * status card and dispatcher use.
 */

import type { JobStatus } from './job-status-card.js';
import type {
  JobLaneAdapter,
  JobDispatchAdapters,
  UnifiedJobView,
} from './job-dispatch.js';
import {
  createCursorAgent,
  syncCursorAgent,
  type CursorAgentView,
} from './cursor-jobs.js';
import {
  AndreaOpenAiRuntimeError,
  createAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJobLogs,
} from './andrea-openai-runtime.js';
import { AndreaOpenAiBackendClient } from './andrea-openai-backend.js';
import type { RegisteredGroup, RuntimeBackendJob } from './types.js';

function normaliseCursorStatus(raw: string | null | undefined): JobStatus {
  const lower = (raw || '').trim().toLowerCase();
  if (
    lower === 'completed' ||
    lower === 'finished' ||
    lower === 'succeeded' ||
    lower === 'success'
  )
    return 'completed';
  if (lower === 'failed' || lower === 'error' || lower === 'errored')
    return 'failed';
  if (lower === 'stopped' || lower === 'cancelled' || lower === 'canceled')
    return 'stopped';
  if (lower === 'queued' || lower === 'pending' || lower === 'waiting')
    return 'queued';
  return 'running';
}

function normaliseRuntimeStatus(
  raw: RuntimeBackendJob['status'] | string,
): JobStatus {
  switch (raw) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      // Unknown status from the backend — surface as running rather than
      // crash. The status card will keep polling until a recognised
      // terminal state arrives.
      return 'running';
  }
}

function cursorViewToUnified(view: CursorAgentView): UnifiedJobView {
  return {
    jobId: view.id,
    status: normaliseCursorStatus(view.status),
    lastUpdate: view.summary,
    outputTail: null, // Cursor's structured output flows via conversation/artifacts; we surface artifacts on completion via finalOutput.
    errorText: null,
    finalOutput: view.targetPrUrl || view.targetUrl || view.summary || null,
    pctComplete: null,
  };
}

function runtimeJobToUnified(job: RuntimeBackendJob): UnifiedJobView {
  // Find the last non-empty line — handles trailing newlines from
  // backends that always terminate output with \n (most do).
  let lastUpdate: string | null = null;
  if (job.latestOutputText) {
    const lines = job.latestOutputText.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const trimmed = lines[i].trim();
      if (trimmed) {
        lastUpdate = trimmed;
        break;
      }
    }
  }
  return {
    jobId: job.jobId,
    status: normaliseRuntimeStatus(job.status),
    lastUpdate,
    outputTail: job.latestOutputText || null,
    errorText: job.errorText || null,
    finalOutput: job.finalOutputText || null,
    pctComplete: null,
  };
}

export interface CursorAdapterOptions {
  resolveGroupFolder(chatJid: string): string | null;
  defaultModel?: string | null;
  defaultAutoCreatePr?: boolean;
}

export function createCursorJobLaneAdapter(
  options: CursorAdapterOptions,
): JobLaneAdapter {
  function requireGroup(chatJid: string): string {
    const folder = options.resolveGroupFolder(chatJid);
    if (!folder) {
      throw new Error(
        'No registered group folder for this chat — register the chat before dispatching jobs.',
      );
    }
    return folder;
  }
  return {
    label: 'Cursor',
    async createJob(prompt, ctx) {
      const groupFolder = requireGroup(ctx.chatJid);
      const view = await createCursorAgent({
        groupFolder,
        chatJid: ctx.chatJid,
        promptText: prompt,
        requestedBy: ctx.actorId || ctx.chatJid,
        model: options.defaultModel || undefined,
        autoCreatePr: options.defaultAutoCreatePr,
      });
      return cursorViewToUnified(view);
    },
    async fetchJob(jobId, ctx) {
      const groupFolder = requireGroup(ctx.chatJid);
      const synced = await syncCursorAgent({
        groupFolder,
        chatJid: ctx.chatJid,
        agentId: jobId,
      });
      return cursorViewToUnified(synced.agent);
    },
  };
}

export interface CodexAdapterOptions {
  resolveGroup(chatJid: string): RegisteredGroup | null;
  client?: AndreaOpenAiBackendClient;
}

export function createCodexJobLaneAdapter(
  options: CodexAdapterOptions,
): JobLaneAdapter {
  const client = options.client || new AndreaOpenAiBackendClient();
  function requireGroup(chatJid: string): RegisteredGroup {
    const group = options.resolveGroup(chatJid);
    if (!group) {
      throw new Error(
        'No registered group for this chat — register the chat before dispatching jobs.',
      );
    }
    return group;
  }
  return {
    label: 'Codex',
    async createJob(prompt, ctx) {
      const group = requireGroup(ctx.chatJid);
      const job = await createAndreaOpenAiRuntimeJob(
        {
          chatJid: ctx.chatJid,
          group,
          prompt,
          actorId: ctx.actorId || ctx.chatJid,
        },
        client,
      );
      return runtimeJobToUnified(job);
    },
    async fetchJob(jobId, ctx) {
      const group = requireGroup(ctx.chatJid);
      try {
        const job = await getAndreaOpenAiRuntimeJob(
          {
            chatJid: ctx.chatJid,
            group,
            jobId,
          },
          client,
        );
        const unified = runtimeJobToUnified(job);
        // If the runtime didn't include latest_output text on the job
        // payload, opportunistically pull a few lines of logs to give
        // the user something to look at.
        if (!unified.outputTail && unified.status === 'running') {
          try {
            const logs = await getAndreaOpenAiRuntimeJobLogs(
              {
                chatJid: ctx.chatJid,
                group,
                jobId,
                lines: 8,
              },
              client,
            );
            return { ...unified, outputTail: logs.logText || null };
          } catch {
            // Logs are best-effort; ignore failures.
          }
        }
        return unified;
      } catch (err) {
        if (
          err instanceof AndreaOpenAiRuntimeError &&
          err.kind === 'not_found'
        ) {
          // Job vanished from the backend index — surface as failed so
          // the status card stops polling rather than hanging.
          return {
            jobId,
            status: 'failed',
            lastUpdate: 'job not found on backend',
            outputTail: null,
            errorText: 'Job no longer present on the runtime backend.',
            finalOutput: null,
            pctComplete: null,
          };
        }
        throw err;
      }
    },
  };
}

export function buildJobDispatchAdapters(args: {
  resolveGroup(chatJid: string): RegisteredGroup | null;
  cursorOptions?: Omit<CursorAdapterOptions, 'resolveGroupFolder'>;
  codexClient?: AndreaOpenAiBackendClient;
}): JobDispatchAdapters {
  return {
    cursor: createCursorJobLaneAdapter({
      resolveGroupFolder: (chatJid) =>
        args.resolveGroup(chatJid)?.folder ?? null,
      ...args.cursorOptions,
    }),
    codex: createCodexJobLaneAdapter({
      resolveGroup: args.resolveGroup,
      client: args.codexClient,
    }),
  };
}
