/**
 * v14 Phase 1 — unified ``/job`` dispatch.
 *
 * Two existing lanes (Cursor cloud, Andrea OpenAI/Codex runtime) had
 * separate command surfaces (``/cursor-create``, ``/runtime-create``) and
 * one-shot reply UX (post a card, user polls for updates). This module
 * gives both a single entry point with auto lane-selection and streaming
 * progress updates via ``JobStatusCard``.
 *
 * The dispatch is split from the actual lane-call helpers so it stays
 * testable: we inject the lane callbacks rather than importing the
 * heavyweight modules. This lets the unit tests run the whole flow with
 * fake lanes and a fake channel.
 */

import {
  formatLaneClarificationPrompt,
  pickLaneForPrompt,
  type LanePick,
} from './lane-picker.js';
import {
  JobStatusCard,
  type JobLane,
  type JobStatus,
  type JobStatusCardChannel,
  type JobStatusCardState,
} from './job-status-card.js';

export interface UnifiedJobView {
  jobId: string;
  status: JobStatus;
  lastUpdate: string | null;
  outputTail: string | null;
  errorText: string | null;
  finalOutput: string | null;
  pctComplete: number | null;
}

export interface JobDispatchInput {
  chatJid: string;
  prompt: string;
  // Explicit lane override from the user (e.g. ``--lane=cursor``). When
  // ``null``, dispatch falls through to the auto heuristic.
  laneOverride: LanePick | null;
  actorId?: string | null;
}

export interface JobDispatchResult {
  outcome: 'dispatched' | 'clarification_required' | 'failed';
  lane: JobLane | null;
  jobId: string | null;
  // Human-readable summary for callers that want to log the outcome
  // (e.g. the index.ts wiring that records the command in the message
  // bus or operator log).
  summary: string;
}

export interface JobLaneAdapter {
  /** Display label shown in the status card ("Cursor", "Codex"). */
  label: string;
  /** Create a new job. Throws on failure; the dispatcher catches and
   * surfaces a failed status to the user. */
  createJob(prompt: string, ctx: { chatJid: string; actorId?: string | null }): Promise<UnifiedJobView>;
  /** Re-fetch the current state of an in-flight job. */
  fetchJob(jobId: string, ctx: { chatJid: string }): Promise<UnifiedJobView>;
}

export interface JobDispatchAdapters {
  cursor: JobLaneAdapter;
  codex: JobLaneAdapter;
}

export interface JobDispatchConfig {
  pollIntervalMs?: number;
  maxPollMs?: number;
  cardConfig?: ConstructorParameters<typeof JobStatusCard>[0]['config'];
  now?: () => number;
  // Hook for tests / index.ts to schedule a delay between polls without
  // forcing real ``setTimeout``.
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_MS = 30 * 60 * 1000; // 30 min ceiling per job watch.

const TERMINAL: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'stopped',
]);

function snippet(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Dispatch a unified job. Posts the status card, polls the lane,
 * streams updates, sends final output. Returns when the job reaches a
 * terminal state, the poll budget is exhausted, or the user clarifies
 * an ambiguous lane (in which case the dispatcher posts a clarification
 * message and returns ``clarification_required`` without creating a
 * job).
 */
export async function dispatchUnifiedJob(args: {
  channel: JobStatusCardChannel;
  input: JobDispatchInput;
  adapters: JobDispatchAdapters;
  config?: JobDispatchConfig;
}): Promise<JobDispatchResult> {
  const { channel, input, adapters } = args;
  const config = args.config ?? {};
  const sleep =
    config.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = config.now ?? (() => Date.now());

  const lanePick = input.laneOverride
    ? { lane: input.laneOverride, reason: 'override', matchedTokens: [] as string[] }
    : pickLaneForPrompt(input.prompt);

  if (lanePick.lane === 'ambiguous') {
    const message = formatLaneClarificationPrompt(input.prompt, lanePick);
    await channel.sendMessage(input.chatJid, message);
    return {
      outcome: 'clarification_required',
      lane: null,
      jobId: null,
      summary: `lane:ambiguous reason:${lanePick.reason}`,
    };
  }

  const lane: JobLane = lanePick.lane;
  const adapter = adapters[lane];

  let initialJob: UnifiedJobView;
  try {
    initialJob = await adapter.createJob(input.prompt, {
      chatJid: input.chatJid,
      actorId: input.actorId,
    });
  } catch (err) {
    await channel.sendMessage(
      input.chatJid,
      `Could not start ${adapter.label} job: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      outcome: 'failed',
      lane,
      jobId: null,
      summary: `lane:${lane} failure:create`,
    };
  }

  const startedAt = now();
  const initialState: JobStatusCardState = {
    jobId: initialJob.jobId,
    lane,
    laneLabel: adapter.label,
    promptSnippet: snippet(input.prompt, 120),
    status: initialJob.status,
    startedAt,
    updatedAt: startedAt,
    lastUpdate: initialJob.lastUpdate,
    outputTail: initialJob.outputTail,
    errorText: initialJob.errorText,
    pctComplete: initialJob.pctComplete,
  };
  const card = new JobStatusCard({
    channel,
    chatJid: input.chatJid,
    initialState,
    config: config.cardConfig,
  });
  await card.post();

  if (TERMINAL.has(initialJob.status)) {
    await card.update({
      status: initialJob.status,
      lastUpdate: initialJob.lastUpdate,
      outputTail: initialJob.outputTail,
      errorText: initialJob.errorText,
      pctComplete: initialJob.pctComplete,
    });
    await card.sendFinalOutput(initialJob.finalOutput);
    return {
      outcome: 'dispatched',
      lane,
      jobId: initialJob.jobId,
      summary: `lane:${lane} job:${initialJob.jobId} status:${initialJob.status}`,
    };
  }

  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollMs = config.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const watchUntil = startedAt + maxPollMs;
  let lastSeenStatus: JobStatus = initialJob.status;
  let lastFinalOutput: string | null = null;
  while (now() < watchUntil) {
    await sleep(pollIntervalMs);
    let snapshot: UnifiedJobView;
    try {
      snapshot = await adapter.fetchJob(initialJob.jobId, {
        chatJid: input.chatJid,
      });
    } catch (err) {
      // Network/auth/etc. — don't tear down the card, just push a
      // diagnostic line and keep polling. Persistent failure will hit
      // the maxPollMs ceiling.
      await card.update({
        lastUpdate: `(refresh failed: ${snippet(
          err instanceof Error ? err.message : String(err),
          80,
        )})`,
      });
      continue;
    }
    lastFinalOutput = snapshot.finalOutput ?? lastFinalOutput;
    await card.update({
      status: snapshot.status,
      lastUpdate: snapshot.lastUpdate,
      outputTail: snapshot.outputTail,
      errorText: snapshot.errorText,
      pctComplete: snapshot.pctComplete,
    });
    lastSeenStatus = snapshot.status;
    if (TERMINAL.has(snapshot.status)) {
      await card.sendFinalOutput(snapshot.finalOutput);
      return {
        outcome: 'dispatched',
        lane,
        jobId: snapshot.jobId,
        summary: `lane:${lane} job:${snapshot.jobId} status:${snapshot.status}`,
      };
    }
  }

  // Watch budget exhausted — surface a "still running" state and stop
  // polling. The job continues on the lane; the user can re-attach via
  // the lane-specific command surface.
  await card.update({
    lastUpdate: `(watch budget reached after ${Math.round(maxPollMs / 60000)}m — job still running on ${adapter.label})`,
  });
  await card.sendFinalOutput(lastFinalOutput);
  return {
    outcome: 'dispatched',
    lane,
    jobId: initialJob.jobId,
    summary: `lane:${lane} job:${initialJob.jobId} status:${lastSeenStatus} (watch_timeout)`,
  };
}
