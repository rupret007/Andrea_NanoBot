import { getBlueBubblesRestartRecoveryCutoff } from './channels/bluebubbles.js';
import {
  quarantineStaleBlueBubblesMessagesForRecovery,
  recoverAllActionableIngressClaims,
} from './db.js';

export interface StartupIngressRecoveryDependencies {
  getBlueBubblesRecoveryCutoff(now: Date): string;
  quarantineStaleBlueBubblesMessages(
    beforeTimestamp: string,
    quarantinedAt: Date,
  ): number;
  recoverAllClaims(now: Date): number;
}

export interface StartupIngressRecoveryResult {
  blueBubblesRecoveryCutoff: string;
  quarantinedBlueBubblesMessageCount: number;
  recoveredIngressClaimCount: number;
}

const defaultDependencies: StartupIngressRecoveryDependencies = {
  getBlueBubblesRecoveryCutoff: getBlueBubblesRestartRecoveryCutoff,
  quarantineStaleBlueBubblesMessages:
    quarantineStaleBlueBubblesMessagesForRecovery,
  recoverAllClaims: recoverAllActionableIngressClaims,
};

/**
 * Fence stale BlueBubbles ingress before releasing any claims owned by the
 * prior process. The caller may drain pending messages only after this returns.
 */
export function prepareActionableIngressForStartupRecovery(
  now: Date = new Date(),
  dependencies: StartupIngressRecoveryDependencies = defaultDependencies,
): StartupIngressRecoveryResult {
  const blueBubblesRecoveryCutoff =
    dependencies.getBlueBubblesRecoveryCutoff(now);
  const quarantinedBlueBubblesMessageCount =
    dependencies.quarantineStaleBlueBubblesMessages(
      blueBubblesRecoveryCutoff,
      now,
    );
  const recoveredIngressClaimCount = dependencies.recoverAllClaims(now);

  return {
    blueBubblesRecoveryCutoff,
    quarantinedBlueBubblesMessageCount,
    recoveredIngressClaimCount,
  };
}
