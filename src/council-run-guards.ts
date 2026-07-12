/*
 * Council run budget and repeated-failure guards.
 *
 * Deterministic signature and bounded-run patterns adapted from
 * open-multi-agent/open-multi-agent loop/task utilities (MIT, commit
 * 6d382d1bb86b714d0ad25c3f51719ef07723635d).
 * Copyright (c) 2025 open-multi-agent contributors.
 */

import { createHash } from 'node:crypto';

import type { CouncilRunBudget } from './council-contracts.js';
import { redactCouncilText } from './council-safety.js';

export interface CouncilFailureObservation {
  role: string;
  providerId: string;
  failure: string;
}

export interface CouncilFailureGuardResult {
  signature: string;
  count: number;
  repeated: boolean;
  riskFlag?: string;
}

export function resolveCouncilRunBudget(mode: string): CouncilRunBudget {
  if (mode === 'single_model') {
    return {
      mode,
      maxRoles: 2,
      roleTimeoutMs: 12_000,
      maxRetries: 0,
      maxConcurrency: 1,
      fallbackAllowed: false,
      estimatedCostTier: 'low',
      usedRoles: 0,
      retryCount: 0,
      loopGuardTriggered: false,
      status: 'within_budget',
    };
  }
  if (mode === 'max_iq_council' || mode === 'repair_council') {
    return {
      mode,
      maxRoles: 5,
      roleTimeoutMs: 45_000,
      maxRetries: 1,
      maxConcurrency: 2,
      fallbackAllowed: true,
      estimatedCostTier: 'high',
      usedRoles: 0,
      retryCount: 0,
      loopGuardTriggered: false,
      status: 'within_budget',
    };
  }
  return {
    mode,
    maxRoles: 4,
    roleTimeoutMs: 20_000,
    maxRetries: 0,
    maxConcurrency: 2,
    fallbackAllowed: false,
    estimatedCostTier: 'medium',
    usedRoles: 0,
    retryCount: 0,
    loopGuardTriggered: false,
    status: 'within_budget',
  };
}

export function finalizeCouncilRunBudget(
  budget: CouncilRunBudget,
  input: {
    usedRoles: number;
    retryCount: number;
    loopGuardTriggered: boolean;
  },
): CouncilRunBudget {
  const exceeded =
    input.usedRoles > budget.maxRoles || input.retryCount > budget.maxRetries;
  const degraded = input.loopGuardTriggered || input.retryCount > 0;
  return {
    ...budget,
    usedRoles: input.usedRoles,
    retryCount: input.retryCount,
    loopGuardTriggered: input.loopGuardTriggered,
    status: exceeded ? 'exceeded' : degraded ? 'degraded' : 'within_budget',
  };
}

export class CouncilFailureGuard {
  private readonly counts = new Map<string, number>();

  constructor(private readonly repeatThreshold = 2) {}

  record(input: CouncilFailureObservation): CouncilFailureGuardResult {
    const signature = buildFailureSignature(input);
    const count = (this.counts.get(signature) || 0) + 1;
    this.counts.set(signature, count);
    const repeated = count >= this.repeatThreshold;
    return {
      signature,
      count,
      repeated,
      riskFlag: repeated
        ? `repeated_failure_signature:${signature}`
        : undefined,
    };
  }
}

function buildFailureSignature(input: CouncilFailureObservation): string {
  const normalized = stableStringify({
    role: input.role,
    providerId: input.providerId,
    failure: redactCouncilText(input.failure, 240).toLowerCase(),
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
