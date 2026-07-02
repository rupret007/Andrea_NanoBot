/**
 * Embedding client used by the memory subsystem.
 *
 * Defaults to Voyage AI (the recommended companion to Anthropic), with a
 * pure-JS fallback for offline development that uses a deterministic but
 * obviously-not-good hash-based projection. Swap in OpenAI's
 * text-embedding-3-large or a local sentence-transformers via Ollama as
 * needed.
 */

import type { EmbeddingClient } from '../memory/types.js';

export class VoyageEmbedder implements EmbeddingClient {
  readonly modelId: string;
  readonly dim: number;

  constructor(
    private readonly apiKey: string,
    modelId = 'voyage-3-large',
    dim = 1024,
    private readonly baseUrl = 'https://api.voyageai.com/v1',
  ) {
    this.modelId = modelId;
    this.dim = dim;
  }

  async embed(input: string[]): Promise<Float32Array[]> {
    if (input.length === 0) return [];
    const r = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input, model: this.modelId }),
    });
    if (!r.ok) throw new Error(`Voyage ${r.status}: ${await r.text()}`);
    const data: any = await r.json();
    return (data.data as { embedding: number[] }[]).map((d) =>
      normalize(Float32Array.from(d.embedding)),
    );
  }
}

/**
 * Hash-based fallback. Deterministic and zero-network — useful for unit
 * tests and offline dev. Embeddings are cheap & poor; do not use in prod.
 */
export class HashEmbedder implements EmbeddingClient {
  readonly modelId = 'hash-fallback-v1';
  constructor(public readonly dim = 256) {}

  async embed(input: string[]): Promise<Float32Array[]> {
    return input.map((s) => normalize(hashTo(s, this.dim)));
  }
}

function hashTo(s: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Knuth multiplicative hash. `>>> 0` coerces to unsigned 32-bit so that
    // both the modulo (idx) and parity bit (sign) are non-negative.
    const u = (c * 2654435761) >>> 0;
    const idx = u % dim;
    v[idx] += 1 - 2 * ((u >>> 4) & 1); // ±1
  }
  return v;
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}
