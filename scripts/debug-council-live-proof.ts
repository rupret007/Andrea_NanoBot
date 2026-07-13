import { buildCouncilDoctorReport } from '../src/council-quality.js';
import { isAndreaPlatformCoordinatorBridgeEnabled } from '../src/andrea-platform-bridge.js';
import {
  resolveCouncilLiveProofConfig,
  runRecordedCouncilLiveProof,
} from '../src/council-live-proof.js';
import { initDatabase } from '../src/db.js';
import { recordAssistantMetric } from '../src/personal-assistant-metrics.js';
import { runObservableProviderCouncil } from '../src/provider-council-runner.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from '../src/provider-live-probe.js';

async function main(): Promise<void> {
  const config = resolveCouncilLiveProofConfig(process.argv.slice(2));
  const correlationId = `live-ultrathink-proof:${Date.now().toString(36)}`;
  const costReservationEventId = `live-council-cost-reservation:${correlationId}`;
  initDatabase();

  let providerHealthSnapshots: Awaited<
    ReturnType<typeof collectProviderHealthSnapshotsWithLiveProbe>
  > = [];
  const { result, assessment, latencyMs } = await runRecordedCouncilLiveProof({
    config,
    correlationId,
    record: (reservation) =>
      recordAssistantMetric({
        eventId: costReservationEventId,
        groupFolder: config.groupFolder,
        ...reservation,
      }),
    execute: async () => {
      const checkedAt = new Date().toISOString();
      providerHealthSnapshots =
        await collectProviderHealthSnapshotsWithLiveProbe(checkedAt);
      return runObservableProviderCouncil(
        {
          goal: 'Externally non-mutating Andrea release diagnosis: identify the highest-value grounded agency reliability improvement and return a bounded evidence-backed recommendation without changing user or world state.',
          taskFamily: 'operator',
          channel: 'system',
          groupFolder: config.groupFolder,
          correlationId,
          requestedMode: 'max_iq_council',
          riskLevel: 'high',
          requiredEvidence: 'partial',
          allowedSideEffects: 'none',
          rawContentPolicy: 'metadata_only',
          runOrigin: 'live',
          metadata: {
            thinking_control: 'deep',
            thinking_trigger: 'ultrathink',
            proof_surface: 'budgeted_live_council',
            estimated_cost_threshold_usd:
              config.estimatedCostThresholdUsd.toFixed(4),
            cost_control_status: config.costControlStatus,
            actual_billing_cap_enforced: String(
              config.actualBillingCapEnforced,
            ),
          },
        },
        { providerHealthSnapshots },
      );
    },
  });
  const schema = result.structuredVerdict?.schemaStatusSummary;
  const evidenceIds = result.structuredVerdict?.evidenceIds || [];

  const doctor = buildCouncilDoctorReport(new Date().toISOString(), {
    providerHealth: providerHealthSnapshots,
  });
  console.log(
    JSON.stringify(
      {
        mode: 'live',
        terminal: assessment.terminal,
        proofAcceptanceStatus: 'structural_only_cost_cap_proof_debt',
        acceptanceEligible: config.acceptanceEligible,
        councilRunId: result.councilRunId || null,
        councilMode: result.mode || null,
        confidence: result.structuredVerdict?.confidence ?? null,
        schemaInvalidFallbacks: schema?.invalid_fallback ?? null,
        evidenceCount: evidenceIds.length,
        completedVerifier: assessment.completedVerifier,
        providerProvenanceComplete: assessment.providerProvenanceComplete,
        participationFull: assessment.participationFull,
        evidenceSufficient: assessment.evidenceSufficient,
        evidenceGapCount: assessment.evidenceGapIds.length,
        evidenceGapIds: assessment.evidenceGapIds,
        confidenceCalibrated: assessment.confidenceCalibrated,
        inputStructureValid: assessment.inputStructureValid,
        modeValid: assessment.modeValid,
        verdictUsable: assessment.verdictUsable,
        approvalBoundaryClean: assessment.approvalBoundaryClean,
        privacyBoundaryClean: assessment.privacyBoundaryClean,
        budgetValid: assessment.budgetValid,
        riskStateClean: assessment.riskStateClean,
        platformRecordFallback: assessment.platformRecordFallback,
        platformRecordLocalRuntime: assessment.platformRecordLocalRuntime,
        failureReasons: assessment.reasons,
        providerFailures: result.providerFailures || [],
        degradationClasses: doctor.degradationClasses || [],
        latencyMs,
        estimatedCostReservationUsd: config.estimatedCostReservationUsd,
        providerBilledCostUsd: null,
        costAccountingClass: 'fixed_estimate_reservation',
        estimatedCostThresholdUsd: config.estimatedCostThresholdUsd,
        actualBillingCapEnforced: config.actualBillingCapEnforced,
        costControlStatus: config.costControlStatus,
        costControlProofDebt: config.costControlProofDebt,
        executionBoundary: {
          rawPromptStored: false,
          rawProviderOutputStored: false,
          userOrWorldMutationAllowed: false,
          liveProviderCalls: true,
          localDiagnosticWrites: true,
          coordinatorRecordPostPossible:
            isAndreaPlatformCoordinatorBridgeEnabled(),
        },
      },
      null,
      2,
    ),
  );
  if (!assessment.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
