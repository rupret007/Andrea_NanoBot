/**
 * Episodic memory — append-only log of conversations and tool calls.
 *
 * The vector store does fuzzy retrieval; this is the source of truth for
 * "what did we do at 3:47pm on Tuesday?" replay and audit. Stored as a
 * rotating JSONL file per scope. The reflection loop reads it daily to
 * distill semantic memories.
 */

import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Episode {
  id: string;
  scope: string;
  /** "user", "assistant", "tool", "system", "event". */
  actor: string;
  content: string;
  /** Optional structured payload (tool call args / results). */
  data?: Record<string, unknown>;
  at: number;
}

export interface EpisodicLogOptions {
  /**
   * Rotate the log when its size exceeds this many bytes. Rotated files are
   * renamed to `<path>.<timestamp>.jsonl`. Defaults to 50 MB. Set to 0 or a
   * negative number to disable rotation.
   */
  rotateBytes?: number;
}

const DEFAULT_ROTATE_BYTES = 50 * 1024 * 1024;

export class EpisodicLog {
  private readonly rotateBytes: number;
  /**
   * Promise chain that serializes appends. Concurrent callers chain onto
   * the same tail so writes happen one at a time and we don't get
   * interleaved partial lines on the JSONL file.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    opts: EpisodicLogOptions = {},
  ) {
    this.rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  }

  async append(ep: Omit<Episode, 'at'> & { at?: number }): Promise<void> {
    const full: Episode = { at: Date.now(), ...ep } as Episode;
    const line = JSON.stringify(full) + '\n';

    // Chain onto the serialization tail so concurrent appends don't
    // interleave bytes mid-line.
    const next = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await this.maybeRotate(line.length);
      await appendFile(this.path, line, 'utf8');
    });

    // Swallow chain-fatal errors so a single failed write doesn't poison
    // every subsequent append; the caller still sees this call's error.
    this.tail = next.catch(() => undefined);
    return next;
  }

  async readWindow(opts: {
    since?: number;
    until?: number;
    scope?: string;
    limit?: number;
  }): Promise<Episode[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(Boolean);
    const out: Episode[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      let ep: Episode;
      try {
        ep = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (opts.scope && ep.scope !== opts.scope) continue;
      if (opts.since && ep.at < opts.since) continue;
      if (opts.until && ep.at > opts.until) continue;
      out.unshift(ep);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }

  /** Force-rotate the log regardless of size. Mostly for tests / ops. */
  async rotate(): Promise<string | undefined> {
    return this.rotateNow();
  }

  private async maybeRotate(incomingBytes: number): Promise<void> {
    if (this.rotateBytes <= 0) return;
    let currentSize = 0;
    try {
      const s = await stat(this.path);
      currentSize = s.size;
    } catch {
      // file doesn't exist yet — nothing to rotate
      return;
    }
    if (currentSize + incomingBytes <= this.rotateBytes) return;
    await this.rotateNow();
  }

  private async rotateNow(): Promise<string | undefined> {
    try {
      await stat(this.path);
    } catch {
      return undefined;
    }
    const target = `${this.path}.${Date.now()}.jsonl`;
    await rename(this.path, target);
    return target;
  }
}
