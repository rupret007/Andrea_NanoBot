import {
  collapseRuntimeToolEvidenceV1,
  mergeRuntimeToolEvidenceV1,
  normalizeRuntimeToolEvidenceV1,
} from './runtime-tool-evidence.js';
import type { RuntimeToolEvidenceV1 } from './types.js';

function detachedEvidence(
  evidence: RuntimeToolEvidenceV1,
): RuntimeToolEvidenceV1 {
  // Re-normalization both validates the host value and returns a detached
  // canonical object. This prevents a persistent container's later IPC query
  // from mutating evidence already bound to a delivered user turn.
  const detached = normalizeRuntimeToolEvidenceV1(evidence);
  if (!detached) {
    throw new Error('Cannot scope invalid runtime tool evidence.');
  }
  return detached;
}

/**
 * Owns runtime receipts for one user turn even when its container process is
 * reused. The first confirmed delivery freezes an immutable receipt snapshot;
 * later IPC output from the persistent process is deliberately ignored.
 */
export class TurnRuntimeEvidenceScope {
  private currentAttempt = new Map<string, RuntimeToolEvidenceV1>();
  private readonly failedAttempts = new Map<string, RuntimeToolEvidenceV1>();
  private deliveredSnapshot: RuntimeToolEvidenceV1[] | null = null;

  beginAttempt(): void {
    this.currentAttempt = new Map<string, RuntimeToolEvidenceV1>();
  }

  observe(evidence: RuntimeToolEvidenceV1): void {
    if (this.deliveredSnapshot) return;
    const incoming = detachedEvidence(evidence);
    const current = this.currentAttempt.get(incoming.evidenceId);
    const merged = current
      ? mergeRuntimeToolEvidenceV1(current, incoming)
      : incoming;
    if (!merged) {
      throw new Error('Cannot merge runtime tool evidence for this turn.');
    }
    this.currentAttempt.set(incoming.evidenceId, detachedEvidence(merged));
  }

  markCurrentAttemptFailed(): void {
    if (this.deliveredSnapshot) return;
    for (const [evidenceId, evidence] of this.currentAttempt) {
      const current = this.failedAttempts.get(evidenceId);
      const merged = current
        ? mergeRuntimeToolEvidenceV1(current, evidence)
        : evidence;
      if (!merged) {
        throw new Error('Cannot merge failed-attempt runtime evidence.');
      }
      this.failedAttempts.set(evidenceId, detachedEvidence(merged));
    }
  }

  freezeDelivered(): void {
    if (this.deliveredSnapshot) return;
    this.deliveredSnapshot = [
      ...this.failedAttempts.values(),
      ...this.currentAttempt.values(),
    ].map(detachedEvidence);
  }

  snapshot(): RuntimeToolEvidenceV1 | null {
    const evidence = this.deliveredSnapshot || [
      ...this.failedAttempts.values(),
      ...this.currentAttempt.values(),
    ];
    return collapseRuntimeToolEvidenceV1(evidence.map(detachedEvidence));
  }
}
