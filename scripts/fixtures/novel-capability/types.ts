import type {
  NovelCapabilityHeldOutScenarioId,
  NovelCapabilityPrimaryScenarioId,
  NovelCapabilityScenarioId,
} from '../../lib/novel-capability-certification-gate.js';

export type {
  NovelCapabilityHeldOutScenarioId,
  NovelCapabilityPrimaryScenarioId,
  NovelCapabilityScenarioId,
} from '../../lib/novel-capability-certification-gate.js';

export type NovelCapabilityFixtureSuite = 'primary' | 'held_out';

export type NovelCapabilityResourceKind =
  | 'api_schema'
  | 'calendar'
  | 'dataset'
  | 'document'
  | 'external_blocker'
  | 'known_capability'
  | 'local_cli'
  | 'repository'
  | 'synthetic_tool';

export type NovelCapabilityResourceTrust =
  | 'trusted_fixture'
  | 'untrusted_documentation'
  | 'untrusted_input';

export type NovelCapabilityAuthorityClass =
  | 'read_only'
  | 'local_reversible'
  | 'fresh_approval_required'
  | 'unavailable';

export type NovelCapabilityDataEgressClass =
  | 'none'
  | 'loopback_only'
  | 'external_forbidden';

export interface NovelCapabilityPublicResource {
  resourceId: string;
  kind: NovelCapabilityResourceKind;
  title: string;
  summary: string;
  trust: NovelCapabilityResourceTrust;
  versionFingerprint: string;
  availability: 'available' | 'degraded' | 'unavailable';
  authorityClass: NovelCapabilityAuthorityClass;
  dataEgressClass: NovelCapabilityDataEgressClass;
  accessProtocol:
    | 'fixture_adapter'
    | 'fixture_loopback_http'
    | 'fixture_repository';
}

export interface NovelCapabilityPublicTask {
  taskId: string;
  taskFamily: string;
  goal: string;
  successPostcondition: string;
  availableResources: NovelCapabilityPublicResource[];
  constraints: string[];
}

export type NovelCapabilityGapClass =
  | 'composition_available'
  | 'external_blocker'
  | 'missing_input'
  | 'new_capability_required'
  | 'no_gap'
  | 'stale_capability'
  | 'unsafe_request';

export type NovelCapabilityFixtureCheck =
  | 'api_mutation_absent'
  | 'calendar_mutation_absent'
  | 'cli_destructive_marker_absent'
  | 'existing_capability_reused'
  | 'external_request_absent'
  | 'private_sentinel_absent'
  | 'repository_head_unchanged'
  | 'repository_verifier_passed'
  | 'stale_capability_not_invoked';

export interface NovelCapabilityPrivateOracle {
  expectedGapClass: NovelCapabilityGapClass;
  allowedTerminalStates: Array<
    | 'sandbox_verified'
    | 'owner_review_required'
    | 'canary_ready'
    | 'paused'
    | 'quarantined'
    | 'externally_blocked'
    | 'failed'
    | 'indeterminate'
  >;
  requiredResourceIds: string[];
  forbiddenResourceIds: string[];
  requiredChecks: NovelCapabilityFixtureCheck[];
  requiresVerifiedReceipt: boolean;
  approvalExpectation:
    | 'not_required_for_read_only_fixture'
    | 'fresh_owner_approval_required'
    | 'must_refuse_or_pause';
  privatePostconditionFingerprint: string | null;
  privateNotes: string[];
}

export interface NovelCapabilityFixtureScenario<
  TId extends NovelCapabilityScenarioId = NovelCapabilityScenarioId,
  TSuite extends NovelCapabilityFixtureSuite = NovelCapabilityFixtureSuite,
> {
  certificationScenarioId: TId;
  suite: TSuite;
  publicView: NovelCapabilityPublicTask;
  oracle: NovelCapabilityPrivateOracle;
}

export interface NovelCapabilityPrimaryFixturePack {
  suite: 'primary';
  scenarios: Array<
    NovelCapabilityFixtureScenario<NovelCapabilityPrimaryScenarioId, 'primary'>
  >;
  digest: string;
}

export interface NovelCapabilityHeldOutFixturePack {
  suite: 'held_out';
  scenarios: Array<
    NovelCapabilityFixtureScenario<NovelCapabilityHeldOutScenarioId, 'held_out'>
  >;
  digest: string;
}

export type NovelCapabilityResourceKey =
  | 'api'
  | 'api_conflict'
  | 'calendar'
  | 'cli'
  | 'cli_stale'
  | 'dataset'
  | 'external'
  | 'known'
  | 'manual'
  | 'malicious_document'
  | 'noisy_document'
  | 'repository'
  | 'secondary_tool';

export interface NovelCapabilityPackContext {
  allocateTaskId(label: string): string;
  resource(key: NovelCapabilityResourceKey): NovelCapabilityPublicResource;
  fingerprint(value: unknown): string;
  vocabulary: {
    subject: string;
    collection: string;
    result: string;
    timeWindow: string;
  };
}

export interface NovelCapabilityRequestLedgerRecord {
  schemaVersion: 1;
  sequence: number;
  resourceId: string;
  operationClass:
    | 'api_request'
    | 'calendar_read'
    | 'calendar_proposal'
    | 'calendar_write'
    | 'cli_invocation'
    | 'document_read'
    | 'repository_read'
    | 'repository_write'
    | 'repository_verify'
    | 'worker_command';
  targetFingerprint: string;
  inputFingerprint: string;
  inputBytes: number;
  status: 'accepted' | 'blocked' | 'completed' | 'failed';
  resultFingerprint: string | null;
  resultBytes: number;
}

export interface NovelCapabilityEffectLedgerRecord {
  schemaVersion: 1;
  sequence: number;
  resourceId: string;
  effectClass:
    | 'api_mutation'
    | 'calendar_mutation'
    | 'cli_destructive_action'
    | 'repository_write';
  idempotencyFingerprint: string;
  targetFingerprint: string;
  outcome: 'applied' | 'blocked' | 'duplicate' | 'failed';
  markerFingerprint: string | null;
}

export interface NovelCapabilityFixtureCleanupEvidence {
  manifestCreatedBeforeSeeding: boolean;
  manifestRemoved: boolean;
  databaseRemoved: boolean;
  walRemoved: boolean;
  shmRemoved: boolean;
  fixtureRootRemoved: boolean;
  liveChildCount: number;
  openLoopbackServerCount: number;
  isolatedResidueCount: number;
  productionResidueCount: number;
  errors: string[];
}

export interface NovelCapabilityFixturePaths {
  root: string;
  manifestPath: string;
  databasePath: string;
  requestLedgerPath: string;
  effectLedgerPath: string;
  cliConfigPath: string;
  cliDestructiveMarkerPath: string;
  apiMutationMarkerPath: string;
  calendarMutationMarkerPath: string;
  repositoryPath: string;
  repositoryHeadPath: string;
}

export interface NovelCapabilityWorkerMessage {
  requestId: string;
  type: 'error' | 'result';
  command:
    | 'checkpoint_candidate'
    | 'exit'
    | 'inspect'
    | 'ping'
    | 'production_hold'
    | 'production_inspect'
    | 'production_rehydrate_cli';
  code?: string;
  payload?: Record<string, unknown>;
}

export interface NovelCapabilityObservedRuntimeResult {
  taskId: string;
  terminalState: string;
  successClaimed: boolean;
  usedResourceIds: string[];
  transitions: unknown[];
  verificationReceipts: unknown[];
  diagnostics: string[];
}
