/**
 * Lightweight knowledge graph for structured queries.
 *
 * The vector store handles fuzzy "what does Jeff usually order at Mod Pizza"
 * style queries. The KG handles structured ones: "list all bands Jeff plays
 * in", "find every project that depends on the auth-middleware refactor".
 *
 * Stored in JSON for simplicity. Adjacency lists are reconstructed at load.
 * Swap in a real graph DB (KuzuDB, Neo4j) by replacing this class.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { KnowledgeEdge, KnowledgeNode } from './types.js';

export class KnowledgeGraph {
  private nodes = new Map<string, KnowledgeNode>();
  private edges: KnowledgeEdge[] = [];
  private outgoing = new Map<string, KnowledgeEdge[]>();
  private incoming = new Map<string, KnowledgeEdge[]>();

  constructor(private readonly path?: string) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as {
        nodes: KnowledgeNode[];
        edges: KnowledgeEdge[];
      };
      this.nodes = new Map(parsed.nodes.map((n) => [n.id, n]));
      this.edges = parsed.edges;
      this.indexEdges();
    } catch {
      // empty graph
    }
  }

  async save(): Promise<void> {
    if (!this.path) return;
    const out = {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
    };
    await writeFile(this.path, JSON.stringify(out, null, 2), 'utf8');
  }

  upsertNode(
    n: Omit<KnowledgeNode, 'id' | 'createdAt'> & {
      id?: string;
      createdAt?: number;
    },
  ): KnowledgeNode {
    // Look up by id first; if absent, also try the new label and any of the
    // proposed aliases so alias-driven merging works (e.g. caller says label
    // "The Stalemates" with aliases ["Stalemate"] and we already have a node
    // labelled "Stalemate").
    let existing: KnowledgeNode | undefined;
    if (n.id) {
      existing = this.nodes.get(n.id);
    }
    if (!existing) {
      existing = this.findByLabel(n.label, n.type);
    }
    if (!existing && n.aliases) {
      for (const alias of n.aliases) {
        const hit = this.findByLabel(alias, n.type);
        if (hit) {
          existing = hit;
          break;
        }
      }
    }

    if (existing) {
      const merged: KnowledgeNode = {
        ...existing,
        ...n,
        id: existing.id,
        // Always preserve the original createdAt — caller-supplied values
        // (or `undefined` after spread) must not overwrite the existing one.
        createdAt: existing.createdAt,
        aliases: dedupe([
          ...(existing.aliases ?? []),
          ...(n.aliases ?? []),
          // Fold the previous label in as an alias if the caller renamed
          // the node, so the merge remains discoverable by either name.
          ...(existing.label && existing.label !== n.label
            ? [existing.label]
            : []),
        ]),
        attrs: { ...(existing.attrs ?? {}), ...(n.attrs ?? {}) },
      };
      this.nodes.set(existing.id, merged);
      return merged;
    }
    const node: KnowledgeNode = {
      ...n,
      id: n.id ?? randomUUID(),
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
    } as KnowledgeNode;
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(e: Omit<KnowledgeEdge, 'id'> & { id?: string }): KnowledgeEdge {
    const edge: KnowledgeEdge = {
      id: e.id ?? randomUUID(),
      ...e,
    } as KnowledgeEdge;
    this.edges.push(edge);
    push(this.outgoing, edge.from, edge);
    push(this.incoming, edge.to, edge);
    return edge;
  }

  /**
   * Multi-hop neighbor expansion bounded by `maxDepth`. Returns nodes plus
   * the path-edges traversed to reach them. Useful for "everything related
   * to X within 2 hops" queries that feed back into the prompt.
   */
  neighborhood(
    seedId: string,
    maxDepth = 2,
    predicateFilter?: (e: KnowledgeEdge) => boolean,
  ): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    // Unknown seed: return an empty result rather than emitting a phantom
    // node id with no backing KnowledgeNode.
    if (!this.nodes.has(seedId)) {
      return { nodes: [], edges: [] };
    }

    const seenNodes = new Set<string>([seedId]);
    const seenEdges: KnowledgeEdge[] = [];
    // Set lookup keeps de-dup at O(1); the array stays for return shape.
    const seenEdgeIds = new Set<string>();
    let frontier = new Set<string>([seedId]);

    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const edge of [
          ...(this.outgoing.get(id) ?? []),
          ...(this.incoming.get(id) ?? []),
        ]) {
          if (predicateFilter && !predicateFilter(edge)) continue;
          if (seenEdgeIds.has(edge.id)) continue;
          seenEdgeIds.add(edge.id);
          seenEdges.push(edge);
          for (const other of [edge.from, edge.to]) {
            if (!seenNodes.has(other)) {
              seenNodes.add(other);
              next.add(other);
            }
          }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    return {
      nodes: Array.from(seenNodes)
        .map((id) => this.nodes.get(id))
        .filter((n): n is KnowledgeNode => Boolean(n)),
      edges: seenEdges,
    };
  }

  findByLabel(label: string, type?: string): KnowledgeNode | undefined {
    const lc = label.toLowerCase();
    for (const n of this.nodes.values()) {
      if (type && n.type !== type) continue;
      if (n.label.toLowerCase() === lc) return n;
      if ((n.aliases ?? []).some((a) => a.toLowerCase() === lc)) return n;
    }
    return undefined;
  }

  query(predicate: (n: KnowledgeNode) => boolean): KnowledgeNode[] {
    return Array.from(this.nodes.values()).filter(predicate);
  }

  stats(): { nodes: number; edges: number; types: Record<string, number> } {
    const types: Record<string, number> = {};
    for (const n of this.nodes.values()) {
      types[n.type] = (types[n.type] ?? 0) + 1;
    }
    return { nodes: this.nodes.size, edges: this.edges.length, types };
  }

  private indexEdges() {
    this.outgoing.clear();
    this.incoming.clear();
    for (const e of this.edges) {
      push(this.outgoing, e.from, e);
      push(this.incoming, e.to, e);
    }
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
