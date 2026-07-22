import { createHash, randomUUID } from 'node:crypto';

export const CODING_WORK_CONTRACT_VERSION = 1 as const;

export const CODING_OPERATION_CLASSES = [
  'analysis',
  'repository_read',
  'code_edit',
  'test',
  'dependency_install',
  'commit',
  'push',
  'pull_request',
  'merge',
  'deploy',
  'destructive_git',
  'production_change',
  'external_mutation',
  'message',
] as const;

export type CodingOperationClass = (typeof CODING_OPERATION_CLASSES)[number];
export type CodingLanePreference = 'auto' | 'cursor' | 'codex';
export type CodingAuthority =
  | 'read_only'
  | 'isolated_workspace_write'
  | 'approval_required'
  | 'prohibited';

export interface CodingRepositoryBinding {
  canonicalRoot: string;
  worktreeRoot: string;
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  isolatedWorktree: boolean;
}

export interface CodingOperationGrant {
  operation: CodingOperationClass;
  authority: CodingAuthority;
  approvalId: string | null;
}

export interface CodingDelegationPacket {
  version: typeof CODING_WORK_CONTRACT_VERSION;
  packetId: string;
  objective: string;
  requestedLane: CodingLanePreference;
  repository: CodingRepositoryBinding;
  operations: readonly CodingOperationGrant[];
  evidenceRequired: readonly CodingEvidenceKind[];
  prohibitedOperations: readonly CodingOperationClass[];
  continuationId: string | null;
  createdAt: string;
  expiresAt: string;
  promptFingerprint: string;
  executionAuthority: 'bounded_by_packet';
}

export type CodingEvidenceKind =
  | 'filesystem_state'
  | 'git_status'
  | 'git_diff'
  | 'git_commit'
  | 'process_exit'
  | 'test_result'
  | 'artifact_state'
  | 'provider_receipt'
  | 'remote_ref';

export interface CodingVerificationEvidence {
  evidenceId: string;
  kind: CodingEvidenceKind;
  outcome: 'passed' | 'failed' | 'unresolved';
  operation: CodingOperationClass;
  exitCode: number | null;
  fingerprint: string | null;
  observedAt: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export type CodingClaimKind =
  | 'analysis_complete'
  | 'files_changed'
  | 'tests_passed'
  | 'artifact_created'
  | 'commit_created'
  | 'pushed'
  | 'pull_request_created'
  | 'deployed'
  | 'goal_achieved';

export interface CodingWorkClaim {
  claimId: string;
  kind: CodingClaimKind;
  text: string;
  evidenceIds: readonly string[];
}

export interface CodingWorkResult {
  version: typeof CODING_WORK_CONTRACT_VERSION;
  resultId: string;
  packetId: string;
  jobId: string;
  lane: Exclude<CodingLanePreference, 'auto'>;
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timed_out';
  startedAt: string;
  completedAt: string;
  changedPathFingerprints: readonly string[];
  testSummaries: readonly string[];
  artifactFingerprints: readonly string[];
  failures: readonly string[];
  claims: readonly CodingWorkClaim[];
  evidence: readonly CodingVerificationEvidence[];
  verification: CodingWorkVerification;
  agentOutputTrusted: false;
}

export interface CodingWorkVerification {
  status: 'verified' | 'partial' | 'unverified' | 'rejected';
  verifiedClaimIds: readonly string[];
  unsupportedClaimIds: readonly string[];
  invariantFailures: readonly string[];
  checkedAt: string;
}

const MUTATING_OPERATIONS = new Set<CodingOperationClass>([
  'code_edit',
  'dependency_install',
  'commit',
  'push',
  'pull_request',
  'merge',
  'deploy',
  'destructive_git',
  'production_change',
  'external_mutation',
  'message',
]);

const ALWAYS_SEPARATE_APPROVAL = new Set<CodingOperationClass>([
  'dependency_install',
  'commit',
  'push',
  'pull_request',
  'merge',
  'deploy',
  'destructive_git',
  'production_change',
  'external_mutation',
  'message',
]);

const DEFAULT_PROHIBITED = [
  'push',
  'pull_request',
  'merge',
  'deploy',
  'destructive_git',
  'production_change',
  'external_mutation',
  'message',
] as const satisfies readonly CodingOperationClass[];

const EVIDENCE_BY_CLAIM: Readonly<
  Record<CodingClaimKind, readonly CodingEvidenceKind[]>
> = {
  analysis_complete: ['process_exit'],
  files_changed: ['filesystem_state', 'git_diff'],
  tests_passed: ['process_exit', 'test_result'],
  artifact_created: ['artifact_state'],
  commit_created: ['git_commit'],
  pushed: ['provider_receipt', 'remote_ref'],
  pull_request_created: ['provider_receipt'],
  deployed: ['provider_receipt'],
  goal_achieved: ['filesystem_state', 'process_exit'],
};

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function uniqueOperations(
  operations: readonly CodingOperationClass[],
): CodingOperationClass[] {
  const selected = new Set(operations);
  return CODING_OPERATION_CLASSES.filter((operation) =>
    selected.has(operation),
  );
}

export function classifyCodingOperations(
  prompt: string,
): CodingOperationClass[] {
  const text = prompt.toLowerCase();
  const operations = new Set<CodingOperationClass>();

  if (
    /\b(explain|review|assess|inspect|analy[sz]e|investigate|diagnose|research)\b/.test(
      text,
    )
  ) {
    operations.add('analysis');
  }
  if (
    /\b(read|inspect|show|list|status|diff|log|review|search|find)\b/.test(text)
  ) {
    operations.add('repository_read');
  }
  if (
    /\b(edit|change|fix|implement|add|remove|refactor|rewrite|patch|migrate|build|create)\b/.test(
      text,
    )
  ) {
    operations.add('code_edit');
  }
  if (
    /\b(test|typecheck|lint|format(?:ting)?|verify|validation)\b/.test(text)
  ) {
    operations.add('test');
  }
  if (
    /\b(install|upgrade|add dependency|npm i\b|pnpm add\b|pip install\b)\b/.test(
      text,
    )
  ) {
    operations.add('dependency_install');
  }
  if (/\bcommit\b/.test(text)) operations.add('commit');
  if (/\bpush\b/.test(text)) operations.add('push');
  if (/\b(pull request|open (?:a )?pr|create (?:a )?pr)\b/.test(text)) {
    operations.add('pull_request');
  }
  if (/\bmerge\b/.test(text)) operations.add('merge');
  if (/\b(deploy|release|publish|ship to production)\b/.test(text)) {
    operations.add('deploy');
  }
  if (
    /\b(reset --hard|force push|push --force|clean -fd|delete branch|drop database)\b/.test(
      text,
    )
  ) {
    operations.add('destructive_git');
  }
  if (/\b(production|live service|prod\b)\b/.test(text)) {
    operations.add('production_change');
  }
  if (/\b(send|message|email|text|post to|notify)\b/.test(text)) {
    operations.add('message');
  }
  if (/\b(purchase|buy|charge|external system|third[- ]party)\b/.test(text)) {
    operations.add('external_mutation');
  }

  if (operations.size === 0) operations.add('analysis');
  if ([...operations].some((operation) => MUTATING_OPERATIONS.has(operation))) {
    operations.add('repository_read');
  }
  return uniqueOperations([...operations]);
}

export function buildCodingDelegationPacket(input: {
  objective: string;
  requestedLane?: CodingLanePreference;
  repository: CodingRepositoryBinding;
  requestedOperations?: readonly CodingOperationClass[];
  approvedOperations?: Readonly<Partial<Record<CodingOperationClass, string>>>;
  continuationId?: string | null;
  now?: Date;
  ttlMs?: number;
  packetId?: string;
}): CodingDelegationPacket {
  const objective = input.objective.trim();
  if (!objective) throw new Error('Coding delegation objective is required.');
  if (objective.length > 20_000)
    throw new Error('Coding delegation objective is too large.');
  const now = input.now ?? new Date();
  const ttlMs = Math.max(
    60_000,
    Math.min(24 * 60 * 60 * 1000, input.ttlMs ?? 60 * 60 * 1000),
  );
  const operations = uniqueOperations(
    input.requestedOperations ?? classifyCodingOperations(objective),
  );
  const approvals = input.approvedOperations ?? {};
  const grants: CodingOperationGrant[] = operations.map((operation) => {
    const approvalId = approvals[operation]?.trim() || null;
    if (ALWAYS_SEPARATE_APPROVAL.has(operation)) {
      return {
        operation,
        authority: approvalId ? 'approval_required' : 'prohibited',
        approvalId,
      };
    }
    if (operation === 'code_edit') {
      return {
        operation,
        authority: input.repository.isolatedWorktree
          ? 'isolated_workspace_write'
          : 'prohibited',
        approvalId: null,
      };
    }
    return { operation, authority: 'read_only', approvalId: null };
  });
  const prohibitedOperations = uniqueOperations([
    ...DEFAULT_PROHIBITED,
    ...grants
      .filter((grant) => grant.authority === 'prohibited')
      .map((grant) => grant.operation),
  ]);
  const evidenceRequired = new Set<CodingEvidenceKind>(['process_exit']);
  if (operations.includes('repository_read'))
    evidenceRequired.add('git_status');
  if (operations.includes('code_edit')) {
    evidenceRequired.add('filesystem_state');
    evidenceRequired.add('git_diff');
  }
  if (operations.includes('test')) evidenceRequired.add('test_result');
  if (operations.includes('commit')) evidenceRequired.add('git_commit');
  if (operations.includes('push')) {
    evidenceRequired.add('provider_receipt');
    evidenceRequired.add('remote_ref');
  }

  return {
    version: CODING_WORK_CONTRACT_VERSION,
    packetId: input.packetId ?? `coding_${randomUUID()}`,
    objective,
    requestedLane: input.requestedLane ?? 'auto',
    repository: { ...input.repository },
    operations: grants,
    evidenceRequired: [...evidenceRequired],
    prohibitedOperations,
    continuationId: input.continuationId ?? null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    promptFingerprint: fingerprint(objective),
    executionAuthority: 'bounded_by_packet',
  };
}

function evidenceSupportsClaim(
  claim: CodingWorkClaim,
  evidence: ReadonlyMap<string, CodingVerificationEvidence>,
): boolean {
  const linked = claim.evidenceIds
    .map((evidenceId) => evidence.get(evidenceId))
    .filter((entry): entry is CodingVerificationEvidence => Boolean(entry));
  if (linked.length !== claim.evidenceIds.length || linked.length === 0)
    return false;
  if (linked.some((entry) => entry.outcome !== 'passed')) return false;
  const requiredKinds = EVIDENCE_BY_CLAIM[claim.kind];
  return requiredKinds.every((kind) =>
    linked.some((entry) => entry.kind === kind),
  );
}

export function verifyCodingWorkClaims(input: {
  packet: CodingDelegationPacket;
  claims: readonly CodingWorkClaim[];
  evidence: readonly CodingVerificationEvidence[];
  now?: Date;
}): CodingWorkVerification {
  const invariantFailures: string[] = [];
  const evidenceById = new Map<string, CodingVerificationEvidence>();
  for (const item of input.evidence) {
    if (evidenceById.has(item.evidenceId))
      invariantFailures.push('duplicate_evidence_id');
    evidenceById.set(item.evidenceId, item);
    const grant = input.packet.operations.find(
      (entry) => entry.operation === item.operation,
    );
    if (!grant || grant.authority === 'prohibited') {
      invariantFailures.push(
        `evidence_for_unauthorized_operation:${item.operation}`,
      );
    }
  }
  const claimIds = new Set<string>();
  const verifiedClaimIds: string[] = [];
  const unsupportedClaimIds: string[] = [];
  for (const claim of input.claims) {
    if (claimIds.has(claim.claimId))
      invariantFailures.push('duplicate_claim_id');
    claimIds.add(claim.claimId);
    if (evidenceSupportsClaim(claim, evidenceById))
      verifiedClaimIds.push(claim.claimId);
    else unsupportedClaimIds.push(claim.claimId);
  }
  const now = input.now ?? new Date();
  const packetExpired = now.getTime() > Date.parse(input.packet.expiresAt);
  if (packetExpired) invariantFailures.push('delegation_packet_expired');
  const status: CodingWorkVerification['status'] =
    invariantFailures.length > 0
      ? 'rejected'
      : unsupportedClaimIds.length === 0
        ? 'verified'
        : verifiedClaimIds.length > 0
          ? 'partial'
          : 'unverified';
  return {
    status,
    verifiedClaimIds,
    unsupportedClaimIds,
    invariantFailures: [...new Set(invariantFailures)],
    checkedAt: now.toISOString(),
  };
}

export function claimMayBeStatedAsFact(
  result: CodingWorkResult,
  claimId: string,
): boolean {
  return (
    result.verification.status !== 'rejected' &&
    result.verification.verifiedClaimIds.includes(claimId)
  );
}

export function parseCodingWorkResult(value: unknown): CodingWorkResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CodingWorkResult>;
  if (
    row.version !== CODING_WORK_CONTRACT_VERSION ||
    typeof row.resultId !== 'string' ||
    typeof row.packetId !== 'string' ||
    typeof row.jobId !== 'string' ||
    (row.lane !== 'cursor' && row.lane !== 'codex') ||
    row.agentOutputTrusted !== false ||
    !Array.isArray(row.claims) ||
    !Array.isArray(row.evidence) ||
    !row.verification ||
    !Array.isArray(row.verification.verifiedClaimIds) ||
    !Array.isArray(row.verification.unsupportedClaimIds) ||
    !Array.isArray(row.verification.invariantFailures)
  ) {
    return null;
  }
  return row as CodingWorkResult;
}
