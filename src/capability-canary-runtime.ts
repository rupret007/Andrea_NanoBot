import {
  capabilityHealthEvidenceSetDigest,
  capabilityProductionContractDigest,
  getCapabilityOwnerReviewForRun,
  getCapabilityProductionRun,
  getRegisteredGroup,
  listCapabilityAcquisitions,
  listCapabilityHealthEvidence,
  listCapabilityProductionRuns,
  listCognitiveApprovalPackets,
  listReliabilityObservations,
} from './db.js';
import {
  authorizeApprovedCapabilityActivation,
  authorizeApprovedCapabilityCanary,
  buildReleaseReadinessCandidateContract,
  getCapabilityApprenticeshipStatus,
  releaseReadinessCapabilityResource,
  runCapabilityProductionExecution,
  stageCapabilityActivation,
  stageCapabilityCanary,
} from './production-capability-apprenticeship.js';
import type { CapabilityCanaryCliDependencies } from './capability-canary-cli.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';

/** Canonical application dependencies for the guided capability CLI. */
export function capabilityCanaryCliDependencies(): CapabilityCanaryCliDependencies {
  return {
    listAcquisitions: listCapabilityAcquisitions,
    listRuns: listCapabilityProductionRuns,
    listRunHealth: listCapabilityHealthEvidence,
    listApprovals: listCognitiveApprovalPackets,
    listReliabilityObservations,
    getRun: getCapabilityProductionRun,
    getOwnerReview: getCapabilityOwnerReviewForRun,
    getStatus: getCapabilityApprenticeshipStatus,
    contractDigest: capabilityProductionContractDigest,
    healthEvidenceSetDigest: capabilityHealthEvidenceSetDigest,
    buildReleaseReadinessContract: buildReleaseReadinessCandidateContract,
    buildReleaseReadinessResource: releaseReadinessCapabilityResource,
    isTrustedBinding({ binding, authorizedSurface }) {
      if (
        authorizedSurface === 'owner_cockpit' &&
        binding.channel === 'owner_cockpit'
      ) {
        // Staging is not cockpit authentication or approval. The later owner
        // decision remains available only through the authenticated cockpit.
        return true;
      }
      const group = getRegisteredGroup(binding.chatId);
      return Boolean(
        group &&
        group.folder === binding.groupId &&
        authorizedSurface === binding.channel &&
        isTrustedOwnerReviewSurface({
          channelName: binding.channel,
          chatJid: binding.chatId,
          group,
        }),
      );
    },
    stageCanary: stageCapabilityCanary,
    authorizeCanary: authorizeApprovedCapabilityCanary,
    executeCanary: runCapabilityProductionExecution,
    stageActivation: stageCapabilityActivation,
    authorizeActivation: authorizeApprovedCapabilityActivation,
    now: () => new Date().toISOString(),
  };
}
