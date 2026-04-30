/**
 * v14 Phase 1 — streaming job status card.
 *
 * The advisor flagged that "edit a Telegram message every time the job
 * emits output" hits both the per-message edit ceiling (~20 in practice)
 * and the per-chat rate limit (30 msg/sec) on real traffic. So this
 * module is *not* a thin wrapper around ``editMessage``. It is a
 * scheduler that:
 *
 * - debounces updates to at most 1 edit per ``minEditIntervalMs`` (default 4s)
 * - drops "no change" edits where the rendered text is identical
 * - caps edits per card at ``maxEditsPerCard`` (default 15) and once that
 *   ceiling is hit, sends a *new* card and abandons the old one
 * - guarantees a final flush on terminal states (completed / failed /
 *   stopped) so the user always sees the closing state
 * - falls back to ``sendMessage`` when the channel does not implement
 *   ``editMessage`` (e.g. BlueBubbles), trading edit-in-place for
 *   send-fresh on each transition
 *
 * The card itself is a structured ``JobStatusCardState`` rendered to text
 * on each flush. Splitting state from rendering means tests can assert
 * what the user *will* see at each transition without mocking the channel.
 */

import type { Channel } from './types.js';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type JobLane = 'cursor' | 'codex';

export interface JobStatusCardState {
  jobId: string;
  lane: JobLane;
  laneLabel: string;
  promptSnippet: string;
  status: JobStatus;
  startedAt: number;
  updatedAt: number;
  lastUpdate: string | null;
  outputTail: string | null;
  errorText: string | null;
  pctComplete: number | null;
}

export interface JobStatusCardConfig {
  minEditIntervalMs?: number;
  maxEditsPerCard?: number;
  outputTailMaxChars?: number;
  // Inject a clock for tests; defaults to ``Date.now``.
  now?: () => number;
}

export interface JobStatusCardChannel {
  sendMessage: Channel['sendMessage'];
  editMessage?: Channel['editMessage'];
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'stopped',
]);

const STATUS_ICON: Record<JobStatus, string> = {
  queued: '⏳',
  running: '🔄',
  completed: '✅',
  failed: '❌',
  stopped: '🛑',
};

function clampSnippet(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * Pure render function — given a card state, produce the text the user
 * will see. Exported for tests so we can lock the rendered shape.
 */
export function renderJobStatusCard(state: JobStatusCardState): string {
  const lines: string[] = [];
  const icon = STATUS_ICON[state.status];
  lines.push(
    `${icon} Job [${state.laneLabel}] · ${state.jobId}`,
  );
  lines.push(`Status: ${state.status} (${formatDuration(state.updatedAt - state.startedAt)})`);
  if (state.pctComplete !== null) {
    const pct = Math.max(0, Math.min(100, Math.round(state.pctComplete)));
    lines.push(`Progress: ${pct}%`);
  }
  if (state.lastUpdate) {
    lines.push(`Last update: ${clampSnippet(state.lastUpdate, 140)}`);
  }
  if (state.outputTail) {
    lines.push('');
    lines.push('Output:');
    lines.push(state.outputTail);
  }
  if (state.errorText && state.status === 'failed') {
    lines.push('');
    lines.push(`Error: ${clampSnippet(state.errorText, 240)}`);
  }
  lines.push('');
  lines.push(`Prompt: ${state.promptSnippet}`);
  return lines.join('\n');
}

/**
 * Streaming status card. Construct one per dispatched job, feed it
 * ``update()`` calls as the underlying lane reports progress; the card
 * handles all debouncing, rate-limiting, edit-budget, and terminal-state
 * flush logic. Caller never has to think about Telegram's edit ceiling.
 */
export class JobStatusCard {
  private readonly channel: JobStatusCardChannel;
  private readonly chatJid: string;
  private readonly config: Required<JobStatusCardConfig>;
  private state: JobStatusCardState;
  private currentMessageId: string | null = null;
  private editsOnCurrent = 0;
  private lastEditAt = 0;
  private lastRenderedText: string | null = null;
  private pendingFlush: Promise<void> | null = null;
  private terminal = false;

  constructor(args: {
    channel: JobStatusCardChannel;
    chatJid: string;
    initialState: JobStatusCardState;
    config?: JobStatusCardConfig;
  }) {
    this.channel = args.channel;
    this.chatJid = args.chatJid;
    this.state = { ...args.initialState };
    this.config = {
      minEditIntervalMs: args.config?.minEditIntervalMs ?? 4000,
      maxEditsPerCard: args.config?.maxEditsPerCard ?? 15,
      outputTailMaxChars: args.config?.outputTailMaxChars ?? 600,
      now: args.config?.now ?? (() => Date.now()),
    };
  }

  getState(): JobStatusCardState {
    return { ...this.state };
  }

  /**
   * Initial post — sends the first card message and remembers its
   * platform message id so subsequent ``update`` calls can edit it.
   */
  async post(): Promise<void> {
    const text = renderJobStatusCard(this.state);
    const result = await this.channel.sendMessage(this.chatJid, text);
    this.currentMessageId = result.platformMessageId ?? null;
    this.editsOnCurrent = 0;
    this.lastEditAt = this.config.now();
    this.lastRenderedText = text;
  }

  /**
   * Merge new fields into the card state and (subject to debounce + edit
   * budget) flush. Terminal-state updates always flush immediately.
   *
   * The debounce/rate-limit logic: an edit only fires if either
   * (a) the rendered text differs from what was last shown AND
   * (b) at least ``minEditIntervalMs`` has elapsed since the last edit,
   * OR
   * (c) the new state is terminal (completed/failed/stopped) — terminal
   * flushes always go through so the user is never left with a stale
   * "running" status.
   */
  async update(
    patch: Partial<
      Pick<
        JobStatusCardState,
        | 'status'
        | 'lastUpdate'
        | 'outputTail'
        | 'errorText'
        | 'pctComplete'
      >
    >,
  ): Promise<void> {
    if (this.terminal) return; // Already finalised; further updates are dropped.

    const now = this.config.now();
    const next: JobStatusCardState = {
      ...this.state,
      ...patch,
      updatedAt: now,
    };
    if (
      patch.outputTail !== undefined &&
      patch.outputTail !== null &&
      patch.outputTail.length > this.config.outputTailMaxChars
    ) {
      next.outputTail =
        '…' +
        patch.outputTail.slice(
          patch.outputTail.length - this.config.outputTailMaxChars + 1,
        );
    }
    this.state = next;
    const isTerminal = TERMINAL_STATUSES.has(next.status);
    if (isTerminal) this.terminal = true;
    const elapsedSinceEdit = now - this.lastEditAt;
    if (!isTerminal && elapsedSinceEdit < this.config.minEditIntervalMs) {
      return; // Debounced.
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    // Wait for any in-flight flush to complete before starting our own.
    // Earlier this method short-circuited the second caller after the
    // await, but that lost terminal-state updates: when a terminal
    // patch arrived during a prior flush, ``this.terminal`` was set
    // and the state mutated, but the flush was never issued. The audit
    // caught this as a real race. Instead each caller queues up; if
    // state is already in sync with what was last rendered the flush
    // is a fast no-op.
    while (this.pendingFlush) {
      await this.pendingFlush;
    }
    const text = renderJobStatusCard(this.state);
    if (text === this.lastRenderedText) {
      // Nothing to push — previous flush already rendered current state.
      return;
    }
    const job = (async () => {
      const canEdit =
        typeof this.channel.editMessage === 'function' &&
        this.currentMessageId !== null &&
        this.editsOnCurrent < this.config.maxEditsPerCard;
      if (canEdit) {
        try {
          await this.channel.editMessage!(
            this.chatJid,
            this.currentMessageId!,
            text,
          );
          this.editsOnCurrent += 1;
          this.lastEditAt = this.config.now();
          this.lastRenderedText = text;
          return;
        } catch {
          // Fall through to send-fresh.
        }
      }
      // Send a fresh card — either no editMessage support, no message id
      // yet, the edit ceiling was hit, or the edit raised. Reset budget.
      const result = await this.channel.sendMessage(this.chatJid, text);
      this.currentMessageId = result.platformMessageId ?? null;
      this.editsOnCurrent = 0;
      this.lastEditAt = this.config.now();
      this.lastRenderedText = text;
    })();
    this.pendingFlush = job.finally(() => {
      this.pendingFlush = null;
    });
    await this.pendingFlush;
  }

  /**
   * Send the final job output as a *separate* message, not an edit. The
   * status card stays as the audit trail; the output is its own message
   * so the user can read it without scrolling through edit history.
   * Returns ``null`` when there is nothing to send.
   */
  async sendFinalOutput(text: string | null): Promise<void> {
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.channel.sendMessage(this.chatJid, trimmed);
  }
}
