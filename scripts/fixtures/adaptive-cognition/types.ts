import type {
  AdaptiveActionCandidate,
  AdaptiveEvidence,
  AdaptiveNodeObservation,
  AdaptiveProblemFrame,
  AdaptiveRunStatus,
} from '../../../src/adaptive-cognition-engine.js';

export type AdaptiveCertificationOrigin = 'synthetic' | 'replay' | 'live';

export type AdaptiveHeldOutCategory =
  | 'ambiguity'
  | 'tool_failure_replan'
  | 'stale_evidence'
  | 'contradiction'
  | 'approval_authority'
  | 'provider_degradation'
  | 'privacy_injection'
  | 'long_horizon_restart'
  | 'mixed_adversarial';

export interface AdaptivePublicSuccessCriterion {
  criterionId: string;
  description: string;
  requiredEvidenceClasses: AdaptiveEvidence['evidenceClass'][];
  minimumConfidence: number;
}

export interface AdaptivePublicUnknown {
  description: string;
  impact: 'informational' | 'degrading' | 'blocking';
  resolvableBy: string[];
}

export interface AdaptivePublicTask {
  schemaVersion: 1;
  taskId: string;
  objective: string;
  taskFamily: string;
  channel: string;
  targetSubject: string;
  successCriteria: AdaptivePublicSuccessCriterion[];
  constraints: string[];
  unknowns: AdaptivePublicUnknown[];
  authority: Pick<
    AdaptiveProblemFrame['authority'],
    'actorScope' | 'maximumActionClass' | 'approvedActionIds'
  >;
  risk: AdaptiveProblemFrame['risk'];
  actions: AdaptiveActionCandidate[];
  simulateRestart: boolean;
}

export interface AdaptiveOracleEvidenceSpec {
  evidenceClass: AdaptiveEvidence['evidenceClass'];
  claim: string;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  freshness: AdaptiveEvidence['freshness'];
  verification: AdaptiveEvidence['verification'];
  supportsCriterionIds: string[];
  provenanceRefs: string[];
}

export interface AdaptiveOracleObservationSpec {
  status: AdaptiveNodeObservation['status'];
  summary: string;
  failureClass?: string;
  evidence?: AdaptiveOracleEvidenceSpec[];
}

export interface AdaptivePrivateOracle {
  scenarioId: string;
  category: AdaptiveHeldOutCategory;
  oracleToken: string;
  allowedTerminalStatuses: AdaptiveRunStatus[];
  expectsVerifiedCompletion: boolean;
  expectedPostcondition: {
    subject: string;
    predicate: string;
    value: string;
    receiptRequired: boolean;
  } | null;
  recoverableFailure: boolean;
  expectsReplan: boolean;
  expectsRestartRecovery: boolean;
  expectedClarification: boolean;
  expectedApprovalStop: boolean;
  actionScripts: Record<string, AdaptiveOracleObservationSpec[]>;
  forbiddenResultTokens: string[];
  notes: string[];
}

export interface AdaptiveHeldOutScenario {
  publicTask: AdaptivePublicTask;
  oracle: AdaptivePrivateOracle;
}

export interface AdaptiveHeldOutPack {
  schemaVersion: 1;
  suite: 'adaptive_cognition_held_out_v1';
  publicDigest: string;
  privateDigest: string;
  scenarios: AdaptiveHeldOutScenario[];
}

export interface AdaptiveScenarioCertificationResult {
  scenarioId: string;
  opaqueTaskId: string;
  category: AdaptiveHeldOutCategory;
  origin: AdaptiveCertificationOrigin;
  passed: boolean;
  terminalStatus: AdaptiveRunStatus;
  completionAuthorized: boolean;
  verifiedCompletion: boolean;
  recoverableFailure: boolean;
  replanSucceeded: boolean;
  restartRecovered: boolean;
  unauthorizedEffects: number;
  falseCompletions: number;
  executorMutationInvocations: number;
  executorInvocations: number;
  replans: number;
  retries: number;
  completionConfidence: number;
  calibrationOutcome: 0 | 1;
  failures: string[];
}

export interface LegacyStaticScenarioResult {
  scenarioId: string;
  passed: boolean;
  claimedCompletion: boolean;
  verifiedCompletion: boolean;
  falseCompletion: boolean;
  unauthorizedEffect: boolean;
  reason: string;
}
