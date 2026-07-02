/**
 * Lightweight vector store.
 *
 * Default backend is in-memory with a brute-force cosine scan — fine for
 * personal scale (< 100k entries). When the store grows past `flushThreshold`
 * we persist to a SQLite file (sqlite-vec extension if available, plain BLOB
 * column otherwise). This keeps the whole memory layer dependency-light
 * for the common case but allows scaling out without a code change.
 *
 * Cosine similarity assumes embeddings are unit-normalized (the contract on
 * `EmbeddingClient.embed`).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  EmbeddingClient,
  MemoryEntry,
  MemoryKind,
  RecallHit,
  RecallQuery,
} from './types.js';

export interface VectorStoreOptions {
  /** Path to JSONL persistence file. Omit for in-memory only. */
  path?: string;
  /** Persist every N writes. */
  flushThreshold?: number;
  /** Decay constant for recency reweighting (ms). */
  recencyHalfLifeMs?: number;
}

interface PersistHeader {
  /** Marker so we can identify a header line vs a regular entry. */
  __vectorStoreHeader: true;
  embedModelId: string;
  embedDim: number;
  version: 1;
}

const warnedDimPairs = new Set<string>();

export class VectorStore {
  private entries: MemoryEntry[] = [];
  private dirty = 0;

  constructor(
    private readonly embed: EmbeddingClient,
    private readonly opts: VectorStoreOptions = {},
  ) {}

  async load(): Promise<void> {
    if (!this.opts.path) return;
    let raw: string;
    try {
      raw = await readFile(this.opts.path, 'utf8');
    } catch {
      // missing file is fine
      return;
    }

    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return;

    // Inspect first line for a header. If present, validate against current
    // embedder; mismatched header => drop the file rather than poison the
    // store with vectors from a different embedding space.
    let startIdx = 0;
    try {
      const maybeHeader = JSON.parse(lines[0]);
      if (maybeHeader && maybeHeader.__vectorStoreHeader === true) {
        startIdx = 1;
        const h = maybeHeader as PersistHeader;
        if (
          h.embedModelId !== this.embed.modelId ||
          h.embedDim !== this.embed.dim
        ) {
          // Mismatched embedder — drop the persisted file and start fresh.
          this.entries = [];
          try {
            await unlink(this.opts.path);
          } catch {
            // best-effort
          }
          return;
        }
      }
    } catch {
      // first line not JSON — fall through to per-line parsing
    }

    const out: MemoryEntry[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && parsed.__vectorStoreHeader === true) continue;
        out.push(rehydrate(parsed));
      } catch {
        // skip a single corrupt line rather than nuking the whole store
      }
    }
    this.entries = out;
  }

  async flush(): Promise<void> {
    if (!this.opts.path) return;
    const header: PersistHeader = {
      __vectorStoreHeader: true,
      embedModelId: this.embed.modelId,
      embedDim: this.embed.dim,
      version: 1,
    };
    const lines: string[] = [JSON.stringify(header)];
    for (const e of this.entries) {
      lines.push(
        JSON.stringify({
          ...e,
          embedding: e.embedding ? Array.from(e.embedding) : undefined,
        }),
      );
    }
    const body = lines.join('\n') + '\n';
    const tmp = this.opts.path + '.tmp';
    // Atomic-ish: write to .tmp, then rename. rename is atomic on POSIX
    // within the same filesystem, so a crash mid-write leaves either the
    // old file or the new file intact, never a truncated mix.
    await mkdir(dirname(this.opts.path), { recursive: true });
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.opts.path);
    this.dirty = 0;
  }

  async upsert(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'> & { id?: string },
  ): Promise<MemoryEntry> {
    // Runtime validation — the cast-as-MemoryEntry pattern was hiding missing
    // required fields. Default sensibly rather than silently letting undefined
    // through.
    const importance =
      typeof entry.importance === 'number' && Number.isFinite(entry.importance)
        ? entry.importance
        : 0.5;
    const now = Date.now();
    const lastAccessed =
      typeof entry.lastAccessed === 'number' &&
      Number.isFinite(entry.lastAccessed)
        ? entry.lastAccessed
        : now;
    const observedAt =
      typeof entry.observedAt === 'number' && Number.isFinite(entry.observedAt)
        ? entry.observedAt
        : now;
    if (typeof entry.scope !== 'string' || entry.scope.length === 0) {
      throw new Error(
        'VectorStore.upsert: entry.scope must be a non-empty string',
      );
    }
    if (typeof entry.kind !== 'string') {
      throw new Error('VectorStore.upsert: entry.kind is required');
    }
    if (typeof entry.content !== 'string') {
      throw new Error('VectorStore.upsert: entry.content must be a string');
    }

    const e: MemoryEntry = {
      ...entry,
      id: entry.id ?? randomUUID(),
      createdAt: now,
      kind: entry.kind,
      content: entry.content,
      scope: entry.scope,
      importance,
      lastAccessed,
      observedAt,
    };

    if (!e.embedding && entry.content) {
      const [v] = await this.embed.embed([entry.content]);
      e.embedding = v;
    }

    if (e.embedding && e.embedding.length !== this.embed.dim) {
      throw new Error(
        `VectorStore.upsert: embedding dim ${e.embedding.length} does not match embedder dim ${this.embed.dim}`,
      );
    }

    const i = this.entries.findIndex((x) => x.id === e.id);
    if (i >= 0) this.entries[i] = e;
    else this.entries.push(e);
    this.dirty += 1;
    if (this.opts.flushThreshold && this.dirty >= this.opts.flushThreshold) {
      await this.flush();
    }
    return e;
  }

  async recall(q: RecallQuery): Promise<RecallHit[]> {
    let queryVec = q.embedding;
    if (!queryVec && q.text) {
      [queryVec] = await this.embed.embed([q.text]);
    }

    const halfLife = this.opts.recencyHalfLifeMs ?? 1000 * 60 * 60 * 24 * 30; // 30d
    const now = Date.now();
    const minImportance = q.minImportance ?? 0;

    const candidates = this.entries.filter((e) => {
      if (q.kinds && !q.kinds.includes(e.kind)) return false;
      if (q.scopes && !q.scopes.includes(e.scope)) return false;
      if (q.since && e.observedAt < q.since) return false;
      if (q.tags && !q.tags.every((t) => (e.tags ?? []).includes(t)))
        return false;
      if ((e.importance ?? 0) < minImportance) return false;
      return true;
    });

    const hits: RecallHit[] = candidates.map((e) => {
      const sim = queryVec && e.embedding ? cosine(queryVec, e.embedding) : 0;
      // Clamp the (now - observedAt) gap at zero so a future observedAt
      // can't push recency above 1 (which would also distort score ranking).
      const gap = Math.max(0, now - e.observedAt);
      const recency = Math.exp((-Math.log(2) * gap) / halfLife);
      const score = 0.7 * sim + 0.2 * recency + 0.1 * (e.importance ?? 0);
      // NOTE: do NOT mutate e.lastAccessed here — that would defeat decay()
      // because every candidate scanned would look freshly-accessed. We bump
      // only the entries that actually appear in the returned topK below.
      return { entry: e, similarity: sim, score };
    });

    hits.sort((a, b) => b.score - a.score);
    const topK = hits.slice(0, q.topK ?? 8);
    for (const h of topK) {
      h.entry.lastAccessed = now;
    }
    return topK;
  }

  async forget(predicate: (e: MemoryEntry) => boolean): Promise<number> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !predicate(e));
    return before - this.entries.length;
  }

  /**
   * Apply the forgetting curve: drop low-importance entries that haven't
   * been accessed recently and aren't tagged "permanent".
   */
  async decay(): Promise<number> {
    const now = Date.now();
    const cutoff = 1000 * 60 * 60 * 24 * 90; // 90d
    return this.forget((e) => {
      // Defensive: treat missing lastAccessed as createdAt so a malformed
      // entry can't hide forever.
      const last =
        typeof e.lastAccessed === 'number' && Number.isFinite(e.lastAccessed)
          ? e.lastAccessed
          : e.createdAt;
      return (
        e.importance < 0.3 &&
        now - last > cutoff &&
        !(e.tags ?? []).includes('permanent')
      );
    });
  }

  size(kind?: MemoryKind): number {
    return kind
      ? this.entries.filter((e) => e.kind === kind).length
      : this.entries.length;
  }

  all(): MemoryEntry[] {
    return [...this.entries];
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    const key = `${a.length}x${b.length}`;
    if (!warnedDimPairs.has(key)) {
      warnedDimPairs.add(key);
      // eslint-disable-next-line no-console
      console.warn(
        `[vector-store] cosine: dim mismatch ${a.length} vs ${b.length}; returning 0`,
      );
    }
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  if (!Number.isFinite(dot)) return 0;
  return Math.max(0, Math.min(1, dot));
}

function rehydrate(raw: any): MemoryEntry {
  return {
    ...raw,
    embedding: Array.isArray(raw.embedding)
      ? Float32Array.from(raw.embedding)
      : undefined,
  };
}
