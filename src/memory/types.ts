/**
 * Memory subsystem types.
 *
 * Three coexisting stores:
 *
 *   - Episodic   — chronological log of conversations & actions, the
 *                  "what happened when" of the agent's life.
 *   - Semantic   — distilled facts, embeddings indexed for similarity search,
 *                  the "what I know" layer (vector store).
 *   - Procedural — heuristics, prompts, learned skills — the "how I do
 *                  things" layer (loaded into the system prompt).
 *
 * On top of those sits an explicit knowledge graph (entities + relations)
 * for queries that demand structured traversal (e.g., "who did Jeff meet
 * with last week from Cisco?").
 */

export type MemoryKind = 'episodic' | 'semantic' | 'procedural';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** Free-text content. */
  content: string;
  /** Optional pre-computed embedding (Float32Array of dim N). */
  embedding?: Float32Array;
  /** Free-form tags for filtered recall. */
  tags?: string[];
  /** Source — where this entry came from (channel id, file path, URL). */
  source?: string;
  /** Owner: a userId, a groupId, or "global". */
  scope: string;
  /** Importance score 0..1, used for retention decisions. */
  importance: number;
  /** Last time this was accessed (for forgetting curve). */
  lastAccessed: number;
  /** When the underlying fact was true / observed. */
  observedAt: number;
  /** When this entry was created in the store. */
  createdAt: number;
  /** Optional structured payload. */
  data?: Record<string, unknown>;
}

export interface RecallQuery {
  /** Natural-language query — embedded for similarity search. */
  text?: string;
  /** Optional pre-computed query embedding. */
  embedding?: Float32Array;
  /** Limit to specific kinds. */
  kinds?: MemoryKind[];
  /** Limit to specific scopes. */
  scopes?: string[];
  /** Return at most this many. */
  topK?: number;
  /** Tag filter (AND across tags). */
  tags?: string[];
  /** Only entries observed within this window. */
  since?: number;
  /** Importance floor. */
  minImportance?: number;
}

export interface RecallHit {
  entry: MemoryEntry;
  /** Cosine similarity to query, 0..1. */
  similarity: number;
  /** Combined score after recency + importance reweighting. */
  score: number;
}

export interface KnowledgeNode {
  id: string;
  /** Canonical label, e.g. "Jeff", "Cisco", "Stalemate (band)". */
  label: string;
  /** Type tag — Person, Org, Project, Place, Event, Task, Concept... */
  type: string;
  aliases?: string[];
  attrs?: Record<string, unknown>;
  /** Where the agent first heard about this entity. */
  source?: string;
  createdAt: number;
}

export interface KnowledgeEdge {
  id: string;
  from: string;
  to: string;
  /** Predicate, e.g. "works_at", "married_to", "depends_on". */
  predicate: string;
  weight?: number;
  source?: string;
  observedAt: number;
}

export interface EmbeddingClient {
  /** Returned vectors must be unit-normalized (cosine == dot). */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Dim of the embedding space. */
  dim: number;
  /** Identifier so callers can detect a model change. */
  modelId: string;
}
