/**
 * Core types for the Andrea AGI cognitive layer.
 *
 * Design intent: every reasoning step, plan, critique, and tool call is a
 * first-class typed event so the orchestrator can introspect, score, replay,
 * and learn from past runs. Nothing here is provider-specific — model calls
 * go through `src/models/router.ts`.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON schema for arguments. */
  schema: Record<string, unknown>;
  /** Side-effect classification — gates safety policy. */
  effect: 'read' | 'write' | 'external' | 'destructive';
  /** Approximate cost class for budget routing. */
  cost?: 'free' | 'cheap' | 'moderate' | 'expensive';
}

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown>;
  /** Stable id so retries / parallel branches don't double-execute. */
  callId: string;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  /** Wall-clock ms. */
  latencyMs?: number;
}

export interface ThoughtNode {
  id: string;
  parentId?: string;
  /** The reasoning the model produced at this step. */
  thought: string;
  /** Optional concrete plan emitted with this thought. */
  plan?: string[];
  /** Self-evaluated score 0..1 (set by critic). */
  score?: number;
  /** Reason the critic gave for this score. */
  critique?: string;
  /** If this branch ran a tool, its invocation. */
  toolCall?: ToolInvocation;
  toolResult?: ToolResult;
  /** Was this branch pruned by the search? */
  pruned?: boolean;
  /** Depth in the tree, root = 0. */
  depth: number;
  createdAt: number;
}

export interface CouncilVote {
  /** Which model voted. */
  voter: string;
  /** Index of the candidate the voter chose. */
  candidate: number;
  /** Confidence in their vote, 0..1. */
  confidence: number;
  /** Why they voted that way. */
  rationale: string;
}

export interface CognitionTrace {
  goal: string;
  startedAt: number;
  finishedAt?: number;
  /** All thought nodes considered, including pruned ones. */
  nodes: ThoughtNode[];
  /** Path of node ids from root → answer. */
  acceptedPath: string[];
  /** Council votes if a vote was held. */
  votes?: CouncilVote[];
  /** Final synthesized answer. */
  answer?: string;
  /** Total tokens (sum across all model calls in this trace). */
  tokens?: { input: number; output: number };
  /** Total wall-clock latency. */
  latencyMs?: number;
  /** Total est. USD spent. */
  costUsd?: number;
  /** Any safety violations the guardrails caught. */
  violations?: string[];
}

export interface CognitionConfig {
  /** Max depth for tree-of-thoughts. */
  maxDepth: number;
  /** Branches expanded per node. */
  branchingFactor: number;
  /** Beam width retained after pruning each level. */
  beamWidth: number;
  /** Acceptance threshold for early-stop on a leaf score. */
  acceptThreshold: number;
  /** Wall-clock budget in ms. */
  budgetMs: number;
  /** Token budget across the whole trace. */
  budgetTokens: number;
  /** USD budget across the whole trace. */
  budgetUsd: number;
  /** Council members (model ids); empty disables the council. */
  council: string[];
  /** Critic model id; falls back to primary if absent. */
  critic?: string;
  /** Whether to run the reflection loop after the answer. */
  reflectAfter: boolean;
}

export const DEFAULT_COGNITION_CONFIG: CognitionConfig = {
  maxDepth: 4,
  branchingFactor: 3,
  beamWidth: 2,
  acceptThreshold: 0.85,
  budgetMs: 60_000,
  budgetTokens: 200_000,
  budgetUsd: 1.0,
  council: [],
  reflectAfter: true,
};
