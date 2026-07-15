/**
 * Test-only contract between the production apprenticeship implementation and
 * its deterministic certification runner. Certification evidence is always
 * synthetic and may never be interpreted as a live canary, owner review, or
 * activation.
 */

export const PRODUCTION_APPRENTICESHIP_SCENARIOS = [
  {
    id: 'A_valid_atomic_canary_readiness',
    title: 'Valid Atomic Canary Readiness',
    requiredAssertions: [
      'canonical_chain_verified',
      'candidate_current',
      'sandbox_and_held_out_passed',
      'fresh_health_bound',
      'exact_canary_approval_bound',
      'durable_work_staged',
      'grant_and_lease_valid',
      'advanced_once_to_canary_ready',
    ],
  },
  {
    id: 'B_naked_identifier_rejection',
    title: 'Naked Identifier Rejection',
    requiredAssertions: [
      'caller_identifiers_not_trusted',
      'disconnected_graph_rejected',
      'state_unchanged',
    ],
  },
  {
    id: 'C_cross_acquisition_receipt_borrowing',
    title: 'Cross-Acquisition Receipt Borrowing',
    requiredAssertions: [
      'foreign_receipt_detected',
      'transition_rejected',
      'state_unchanged',
    ],
  },
  {
    id: 'D_cross_version_outcome_borrowing',
    title: 'Cross-Version Outcome Borrowing',
    requiredAssertions: [
      'stale_candidate_version_detected',
      'foreign_outcome_rejected',
      'state_unchanged',
    ],
  },
  {
    id: 'E_health_expiry',
    title: 'Health Expiry',
    requiredAssertions: [
      'stale_health_detected',
      'readiness_or_activation_blocked',
      'freshness_reason_preserved',
    ],
  },
  {
    id: 'F_approval_scope_mismatch',
    title: 'Approval-Scope Mismatch',
    requiredAssertions: [
      'approval_scope_mismatch_detected',
      'grant_not_laundered',
      'transition_rejected',
    ],
  },
  {
    id: 'G_lease_mismatch_or_expiry',
    title: 'Lease Mismatch or Expiry',
    requiredAssertions: [
      'lease_identity_or_expiry_detected',
      'execution_not_owned',
      'transition_rejected',
    ],
  },
  {
    id: 'H_crash_before_canary_effect',
    title: 'Crash Before Canary Effect',
    requiredAssertions: [
      'restart_reconstructed_work',
      'effect_count_at_most_one',
      'safe_resume_completed',
    ],
  },
  {
    id: 'I_crash_after_effect_before_outcome',
    title: 'Crash After Effect but Before Outcome',
    requiredAssertions: [
      'started_effect_reconciled',
      'existing_effect_verified',
      'effect_not_blindly_replayed',
    ],
  },
  {
    id: 'J_crash_after_outcome_before_transition',
    title: 'Crash After Outcome but Before State Transition',
    requiredAssertions: [
      'canonical_outcome_recovered',
      'transition_advanced_once',
      'no_duplicate_outcome_or_activation',
    ],
  },
  {
    id: 'K_owner_review_binding',
    title: 'Owner Review Binding',
    requiredAssertions: [
      'exact_private_owner_review_accepted',
      'wrong_owner_channel_and_stale_review_rejected',
      'generic_or_mixed_feedback_rejected',
      'review_revision_counted_once',
    ],
  },
  {
    id: 'L_activation_approval_separation',
    title: 'Activation Approval Separation',
    requiredAssertions: [
      'review_without_activation_did_not_activate',
      'activation_without_review_did_not_activate',
      'separate_exact_approval_required',
    ],
  },
  {
    id: 'M_exact_activation',
    title: 'Exact Activation',
    requiredAssertions: [
      'complete_canonical_join_activated_exact_version',
      'one_active_projection_created',
      'exact_replay_was_noop',
    ],
  },
  {
    id: 'N_active_reuse',
    title: 'Active Reuse',
    requiredAssertions: [
      'semantic_variant_matched_exact_contract',
      'new_durable_work_instantiated',
      'registered_binding_executed',
      'postcondition_independently_verified',
      'monitoring_outcome_recorded',
    ],
  },
  {
    id: 'O_reuse_efficiency',
    title: 'Reuse Efficiency',
    requiredAssertions: [
      'discovery_and_planning_calls_decreased',
      'correctness_not_regressed',
      'safety_not_regressed',
      'live_claim_not_fabricated',
    ],
  },
  {
    id: 'P_negative_outcome',
    title: 'Negative Outcome',
    requiredAssertions: [
      'corrected_or_rejected_prevented_promotion',
      'negative_evidence_preserved',
      'repeated_negative_paused_or_quarantined',
    ],
  },
  {
    id: 'Q_safety_violation',
    title: 'Safety Violation',
    requiredAssertions: [
      'safety_violation_quarantined_immediately',
      'later_match_and_use_blocked',
      'historical_evidence_preserved',
    ],
  },
  {
    id: 'R_version_drift',
    title: 'Version Drift',
    requiredAssertions: [
      'incompatible_resource_change_detected',
      'active_match_stopped',
      'revalidation_required',
    ],
  },
  {
    id: 'S_revocation',
    title: 'Revocation',
    requiredAssertions: [
      'owner_revocation_applied_atomically',
      'new_execution_blocked',
      'pending_activation_invalidated',
      'historical_evidence_preserved',
    ],
  },
  {
    id: 'T_concurrent_activation',
    title: 'Concurrent Activation',
    requiredAssertions: [
      'activation_race_exercised',
      'exactly_one_transition_succeeded',
      'exactly_one_projection_created',
    ],
  },
  {
    id: 'U_privacy',
    title: 'Privacy',
    requiredAssertions: [
      'ledger_metadata_only',
      'raw_prompts_outputs_paths_and_secrets_absent',
      'private_content_not_persisted',
    ],
  },
  {
    id: 'V_authority',
    title: 'Authority',
    requiredAssertions: [
      'activation_granted_no_new_authority',
      'protected_actions_still_require_fresh_approval',
      'all_protected_bypass_attempts_rejected',
    ],
  },
] as const;

export type ProductionApprenticeshipScenarioId =
  (typeof PRODUCTION_APPRENTICESHIP_SCENARIOS)[number]['id'];

export type ProductionApprenticeshipScenarioStatus =
  | 'pass'
  | 'fail'
  | 'not_implemented';

export interface ProductionApprenticeshipScenarioEvidence {
  id: ProductionApprenticeshipScenarioId;
  title: string;
  status: ProductionApprenticeshipScenarioStatus;
  origin: 'certification_synthetic';
  executed: boolean;
  assertions: Record<string, boolean>;
  evidenceIds: string[];
  reason: string;
  counters: {
    providerCalls: number;
    costUsd: number;
    externalEffects: number;
    productionWrites: number;
    unauthorizedEffects: number;
    duplicateEffects: number;
    privacyLeaks: number;
  };
}

export interface ProductionApprenticeshipCertificationEvidence {
  schemaVersion: 1;
  certification: 'Andrea Verified Production Apprenticeship';
  mode: 'deterministic_offline';
  evidenceOrigin: 'certification_synthetic';
  implementationStatus: 'complete' | 'partial' | 'unavailable';
  runId: string;
  startedAt: string;
  completedAt: string;
  fatalError: string | null;
  scenarios: ProductionApprenticeshipScenarioEvidence[];
  environment: {
    hermeticParentProven: boolean;
    providerEnvironmentSuppressed: boolean;
    parentNonLoopbackDenied: boolean;
    childNonLoopbackDenied: boolean;
    networkEscapeCount: number;
    providerCalls: number;
    costUsd: number;
    externalEffects: number;
    productionWrites: number;
    productionMetricWrites: number;
  };
  ownerEvidence: {
    genuineOwnerEvidenceCount: number;
    syntheticOwnerFixtureCount: number;
    syntheticFixturesLabeled: boolean;
  };
  privacy: {
    metadataOnly: boolean;
    privateContentLeakCount: number;
    secretLeakCount: number;
    rawPathLeakCount: number;
  };
  cleanup: {
    manifestCreatedBeforeExecution: boolean;
    manifestRemoved: boolean;
    fixtureRootRemoved: boolean;
    isolatedResidueCount: number;
    productionResidueCount: number;
    liveChildCount: number;
    errors: string[];
  };
  benchmarkIsolation: {
    scenarioMetadataExposedToProduction: boolean;
    productionFixtureImportCount: number;
    benchmarkSpecificBranchCount: number;
  };
}

export interface ProductionApprenticeshipCertificationContext {
  runId: string;
  startedAt: string;
  fixtureRoot: string;
  cleanupManifestPath: string;
  requiredScenarioIds: readonly ProductionApprenticeshipScenarioId[];
  mode: 'deterministic_offline';
  evidenceOrigin: 'certification_synthetic';
}

export type RunProductionApprenticeshipCertificationCases = (
  context: ProductionApprenticeshipCertificationContext,
) => Promise<ProductionApprenticeshipCertificationEvidence>;
