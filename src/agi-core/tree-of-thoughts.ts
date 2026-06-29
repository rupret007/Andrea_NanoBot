/**
 * Tree-of-Thoughts deliberate reasoning.
 *
 * For non-trivial requests, the cognitive core does NOT just sample one
 * chain-of-thought — it expands a small tree, scores each branch with a
 * separate critic prompt, prunes weak branches with beam search, and keeps
 * going until either a branch crosses `acceptThreshold` or the budget is
 * exhausted.
 *
 * The implementation here is provider-agnostic: it takes a `propose` and a
 * `critique` function and a budget; `cognitive-core.ts` wires those to the
 * model router.
 *
 * References:
 *   Yao et al. 2023, "Tree of Thoughts: Deliberate Problem Solving with LLMs"
 *   Madaan et al. 2023, "Self-Refine"
 */

import { randomUUID } from 'node:crypto';
import type { CognitionConfig, ThoughtNode } from './types.js';

export interface ProposeFn {
  (params: {
    goal: string;
    parent?: ThoughtNode;
    siblings: ThoughtNode[];
    depth: number;
  }): Promise<{ thought: string; plan?: string[]; tokens: number }>;
}

export interface CritiqueFn {
  (params: { goal: string; node: ThoughtNode }): Promise<{
    score: number;
    critique: string;
    tokens: number;
  }>;
}

export interface SearchBudget {
  startedAt: number;
  budgetMs: number;
  budgetTokens: number;
  tokensUsed: number;
}

export interface SearchResult {
  nodes: ThoughtNode[];
  best?: ThoughtNode;
  acceptedPath: string[];
  tokens: number;
  reason: 'accepted' | 'exhausted' | 'budget' | 'stuck';
}

/**
 * Run a beam-search tree-of-thoughts expansion. Returns every node that was
 * created (pruned or not) so callers can persist the full deliberation for
 * auditing and learning.
 */
export async function searchTreeOfThoughts(
  goal: string,
  cfg: CognitionConfig,
  propose: ProposeFn,
  critique: CritiqueFn,
): Promise<SearchResult> {
  const nodes: ThoughtNode[] = [];
  const budget: SearchBudget = {
    startedAt: Date.now(),
    budgetMs: cfg.budgetMs,
    budgetTokens: cfg.budgetTokens,
    tokensUsed: 0,
  };

  // Seed with the root: a single empty "anchor" so all real thoughts have a
  // parent and the tree shape is uniform.
  const root: ThoughtNode = {
    id: randomUUID(),
    thought: '<root>',
    depth: 0,
    score: 0,
    createdAt: Date.now(),
  };
  nodes.push(root);

  let frontier: ThoughtNode[] = [root];

  for (let depth = 1; depth <= cfg.maxDepth; depth++) {
    if (overBudget(budget)) break;
    const candidates: ThoughtNode[] = [];

    for (const parent of frontier) {
      if (overBudget(budget)) break;
      const siblings: ThoughtNode[] = [];
      for (let b = 0; b < cfg.branchingFactor; b++) {
        if (overBudget(budget)) break;
        const proposal = await propose({ goal, parent, siblings, depth });
        budget.tokensUsed += proposal.tokens;

        const node: ThoughtNode = {
          id: randomUUID(),
          parentId: parent.id,
          thought: proposal.thought,
          plan: proposal.plan,
          depth,
          createdAt: Date.now(),
        };

        const judged = await critique({ goal, node });
        budget.tokensUsed += judged.tokens;
        node.score = judged.score;
        node.critique = judged.critique;

        nodes.push(node);
        siblings.push(node);
        candidates.push(node);

        // Early acceptance — a clearly correct branch ends the search now.
        if (node.score >= cfg.acceptThreshold) {
          return {
            nodes,
            best: node,
            acceptedPath: pathTo(node, nodes),
            tokens: budget.tokensUsed,
            reason: 'accepted',
          };
        }
      }
    }

    if (candidates.length === 0) {
      return {
        nodes,
        acceptedPath: [],
        tokens: budget.tokensUsed,
        reason: 'stuck',
      };
    }

    // Beam prune: keep the top-K candidates by score.
    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const survivors = candidates.slice(0, cfg.beamWidth);
    for (const c of candidates.slice(cfg.beamWidth)) c.pruned = true;
    frontier = survivors;
  }

  // No branch hit the threshold — return the best we found.
  const best = nodes
    .filter((n) => n.id !== root.id && !n.pruned)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  return {
    nodes,
    best,
    acceptedPath: best ? pathTo(best, nodes) : [],
    tokens: budget.tokensUsed,
    reason: overBudget(budget) ? 'budget' : 'exhausted',
  };
}

function overBudget(b: SearchBudget): boolean {
  if (Date.now() - b.startedAt >= b.budgetMs) return true;
  if (b.tokensUsed >= b.budgetTokens) return true;
  return false;
}

function pathTo(node: ThoughtNode, nodes: ThoughtNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let cur: ThoughtNode | undefined = node;
  while (cur) {
    out.unshift(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}
