/**
 * Action policy gate.
 *
 * Every tool call passes through here before execution. The gate decides:
 *   - allow without prompt
 *   - allow but emit a warning (still executes; flags audit log)
 *   - require explicit user confirmation
 *   - deny outright
 *
 * Decisions consider the tool's `effect` class, the call site (background
 * scheduler vs direct user request), the user's per-tool allowlist/blocklist,
 * and a budget meter (rate limits + monthly USD cap).
 *
 * Precedence (top wins):
 *   1. `denied`            (universal hard block)
 *   2. `budgetExceeded`    (universal hard block)
 *   3. `allowed`           (universal explicit override)
 *   4. `alwaysConfirm`     (universal explicit confirmation gate)
 *   5. background vs user-initiated rules by tool effect
 *
 * Note: `warn` decisions DO allow execution. They are intended to be flagged
 * in the audit log but should not block the call.
 */

import type { ToolDescriptor, ToolInvocation } from '../agi-core/types.js';

export type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'warn'; reason: string }
  | { kind: 'confirm'; reason: string }
  | { kind: 'deny'; reason: string };

export interface PolicyContext {
  /** Was this triggered directly by a user message in this session? */
  initiatedByUser: boolean;
  /** Is the user currently confirming something? */
  inConfirmationFlow: boolean;
  /** Has the budget meter exceeded its window? */
  budgetExceeded: boolean;
  /** Caller's per-tool overrides. */
  allowed: Set<string>;
  denied: Set<string>;
  alwaysConfirm: Set<string>;
}

export function evaluate(
  tool: ToolDescriptor,
  _call: ToolInvocation,
  ctx: PolicyContext,
): PolicyDecision {
  // Universal hard blocks first.
  if (ctx.denied.has(tool.name)) {
    return { kind: 'deny', reason: `${tool.name} is on the user blocklist` };
  }
  if (ctx.budgetExceeded) {
    return { kind: 'deny', reason: 'Budget exceeded for this window' };
  }

  // Universal explicit allow — user pinned this tool, trust them
  // regardless of background/foreground status.
  if (ctx.allowed.has(tool.name)) {
    return { kind: 'allow' };
  }

  // Universal explicit confirmation gate — applies even to background callers
  // (they will not be able to satisfy a confirm and will be deferred upstream),
  // but expressed here so foreground callers also honor it before falling
  // through to per-effect defaults.
  if (ctx.alwaysConfirm.has(tool.name)) {
    return {
      kind: 'confirm',
      reason: 'User has marked this tool always-confirm',
    };
  }

  // Background calls have stricter defaults.
  if (!ctx.initiatedByUser) {
    if (tool.effect === 'destructive' || tool.effect === 'external') {
      return {
        kind: 'deny',
        reason: `Background task tried to ${tool.effect} via ${tool.name}`,
      };
    }
    if (tool.effect === 'write') {
      return {
        kind: 'warn',
        reason: `Background task is writing via ${tool.name}; logged.`,
      };
    }
    return { kind: 'allow' };
  }

  switch (tool.effect) {
    case 'read':
      return { kind: 'allow' };
    case 'write':
      // `warn` still allows execution but flags the audit log so a human can
      // notice silent writes after the fact.
      return ctx.inConfirmationFlow
        ? { kind: 'allow' }
        : {
            kind: 'warn',
            reason: `Write via ${tool.name} (silent allow with audit)`,
          };
    case 'external':
      return ctx.inConfirmationFlow
        ? { kind: 'allow' }
        : { kind: 'confirm', reason: `External action via ${tool.name}` };
    case 'destructive':
      return ctx.inConfirmationFlow
        ? { kind: 'allow' }
        : { kind: 'confirm', reason: `Destructive action via ${tool.name}` };
    default: {
      // Exhaustiveness — this branch is statically unreachable; if a new
      // effect class is added without updating this switch, TypeScript will
      // complain at the assignment to `_exhaustive`.
      const _exhaustive: never = tool.effect;
      throw new Error('Unreachable: ' + String(_exhaustive));
    }
  }
}
