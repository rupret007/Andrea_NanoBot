import type {
  BackendJobDetails,
  BackendPrimaryOutputResult,
} from './backend-lanes/types.js';

export type RepairApprovalScope = 'execution_only' | 'execution_and_landing';

export type RepairWorkerResultStatus =
  | 'waiting_for_cloud_result'
  | 'verified'
  | 'failed_tests'
  | 'blocked_external'
  | 'needs_local_landing'
  | 'malformed';

export interface RepairWorkerResult {
  status: RepairWorkerResultStatus;
  changedFiles: string[];
  testsRun: string[];
  testsPassed: boolean | null;
  patchArtifact: string | null;
  commitSha: string | null;
  blockerClass: string | null;
  needsLocalApply: boolean;
  verificationSummary: string;
  nextLegalAction: string;
  secretRedacted: boolean;
}

export interface RepairVerificationBundle {
  evidenceKind:
    | 'test'
    | 'build'
    | 'status'
    | 'smoke'
    | 'audit'
    | 'trace'
    | 'manual';
  passed: boolean;
  summary: string;
  command: string | null;
  metadata: Record<string, string>;
}

const SECRET_FRAGMENT_PATTERN =
  /\b(?:sk-(?:proj-|ant-|cp-)?[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|AIza[0-9A-Za-z_-]{12,}|crsr_[0-9a-fA-F]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compactString(value: unknown, fallback = '', max = 500): string {
  const text = normalizeText(value) || fallback;
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeString(
  value: unknown,
  max = 500,
): {
  value: string;
  redacted: boolean;
} {
  const text = compactString(value, '', max);
  let redacted = false;
  const valueOut = text.replace(SECRET_FRAGMENT_PATTERN, () => {
    redacted = true;
    return '[redacted-secret]';
  });
  return { value: valueOut, redacted };
}

function sanitizeStringArray(
  value: unknown,
  maxItems = 12,
): {
  values: string[];
  redacted: boolean;
} {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  let redacted = false;
  const values = items
    .map((item) => {
      const sanitized = sanitizeString(item, 260);
      redacted = redacted || sanitized.redacted;
      return sanitized.value;
    })
    .filter(Boolean)
    .slice(0, maxItems);
  return { values, redacted };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [
    text,
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map(
      (match) => match[1] || '',
    ),
    ...Array.from(text.matchAll(/(\{[\s\S]{40,}\})/g)).map(
      (match) => match[1] || '',
    ),
  ];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep looking for a later fenced object.
    }
  }
  return null;
}

function pickWorkerResultObject(
  text: string,
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const metadataResult = metadata?.repairWorkerResult;
  if (
    metadataResult &&
    typeof metadataResult === 'object' &&
    !Array.isArray(metadataResult)
  ) {
    return metadataResult as Record<string, unknown>;
  }
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const nested = parsed.repairWorkerResult || parsed.repair_worker_result;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return parsed;
}

function normalizeStatus(value: unknown): RepairWorkerResultStatus {
  const status = compactString(value, '', 80).toLowerCase();
  if (
    status === 'verified' ||
    status === 'failed_tests' ||
    status === 'blocked_external' ||
    status === 'needs_local_landing' ||
    status === 'waiting_for_cloud_result'
  ) {
    return status;
  }
  if (status === 'success' || status === 'completed' || status === 'passed') {
    return 'verified';
  }
  if (status === 'failed' || status === 'tests_failed') {
    return 'failed_tests';
  }
  if (status === 'blocked' || status === 'external_blocker') {
    return 'blocked_external';
  }
  return 'malformed';
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = compactString(value, '', 40).toLowerCase();
  if (['true', 'yes', 'pass', 'passed', '1'].includes(text)) return true;
  if (['false', 'no', 'fail', 'failed', '0'].includes(text)) return false;
  return null;
}

export function parseRepairWorkerResult(
  text?: string | null,
  metadata?: Record<string, unknown> | null,
): RepairWorkerResult {
  const rawText = normalizeText(text);
  const object = pickWorkerResultObject(rawText, metadata);
  if (!object) {
    return {
      status: 'waiting_for_cloud_result',
      changedFiles: [],
      testsRun: [],
      testsPassed: null,
      patchArtifact: null,
      commitSha: null,
      blockerClass: null,
      needsLocalApply: false,
      verificationSummary:
        'Worker output has not returned a structured repair result yet.',
      nextLegalAction: 'Wait for the cloud worker result or refresh the job.',
      secretRedacted: false,
    };
  }

  const changedFiles = sanitizeStringArray(
    object.changedFiles || object.changed_files,
  );
  const testsRun = sanitizeStringArray(object.testsRun || object.tests_run);
  const summary = sanitizeString(
    object.verificationSummary ||
      object.verification_summary ||
      object.summary ||
      'Worker returned a repair result.',
    700,
  );
  const patchArtifact = sanitizeString(
    object.patchArtifact || object.patch_artifact || object.artifactPath,
    260,
  );
  const commitSha = sanitizeString(object.commitSha || object.commit_sha, 80);
  const blockerClass = sanitizeString(
    object.blockerClass || object.blocker_class,
    120,
  );
  const nextLegalAction = sanitizeString(
    object.nextLegalAction || object.next_legal_action,
    300,
  );
  const testsPassed = parseBoolean(object.testsPassed ?? object.tests_passed);
  const needsLocalApply =
    parseBoolean(object.needsLocalApply ?? object.needs_local_apply) ?? false;
  let status = normalizeStatus(object.status);
  if (status === 'malformed') {
    status = 'waiting_for_cloud_result';
  }
  if (status === 'verified' && testsPassed === false) {
    status = 'failed_tests';
  }
  if (status === 'verified' && needsLocalApply) {
    status = 'needs_local_landing';
  }
  if (status === 'verified' && testsPassed !== true) {
    status = 'waiting_for_cloud_result';
  }

  const secretRedacted =
    changedFiles.redacted ||
    testsRun.redacted ||
    summary.redacted ||
    patchArtifact.redacted ||
    commitSha.redacted ||
    blockerClass.redacted ||
    nextLegalAction.redacted;

  return {
    status,
    changedFiles: changedFiles.values,
    testsRun: testsRun.values,
    testsPassed,
    patchArtifact: patchArtifact.value || null,
    commitSha: commitSha.value || null,
    blockerClass: blockerClass.value || null,
    needsLocalApply,
    verificationSummary: summary.value,
    nextLegalAction:
      nextLegalAction.value ||
      deriveRepairNextLegalAction(status, needsLocalApply, 'execution_only'),
    secretRedacted,
  };
}

export function parseRepairApprovalScopeFromText(
  text: string | null | undefined,
): RepairApprovalScope {
  const normalized = normalizeText(text).toLowerCase();
  return /\b(?:repair and land|approve landing|land it|commit(?: and push)?|push(?: and restart)?|restart after(?:wards)?|deploy)\b/.test(
    normalized,
  )
    ? 'execution_and_landing'
    : 'execution_only';
}

export function isLandingScopeApproved(
  scope: string | null | undefined,
): boolean {
  return compactString(scope, '', 160).includes('execution_and_landing');
}

export function deriveRepairNextLegalAction(
  status: RepairWorkerResultStatus,
  needsLocalApply: boolean,
  landingScope: string | null | undefined,
): string {
  if (status === 'waiting_for_cloud_result') {
    return 'Wait for structured worker output before claiming verification.';
  }
  if (status === 'failed_tests') {
    return 'Pause before landing; tests failed and a new repair pass is required.';
  }
  if (status === 'blocked_external') {
    return 'Pause and resolve the external/manual blocker before retrying.';
  }
  if (status === 'needs_local_landing' || needsLocalApply) {
    return isLandingScopeApproved(landingScope)
      ? 'Apply or land the verified patch only after dirty-path and test gates pass.'
      : 'Ask for explicit landing approval before commit, push, or restart.';
  }
  if (status === 'verified') {
    return 'Keep verification evidence linked; landing still needs explicit landing scope if code changed.';
  }
  return 'Refresh the worker job and require a valid repair result contract.';
}

export function buildRepairVerificationBundle(
  result: RepairWorkerResult,
  params: {
    feedbackId: string;
    repairPlanId?: string | null;
    executionId?: string | null;
    workerId?: string | null;
    laneId?: string | null;
    jobId?: string | null;
  },
): RepairVerificationBundle {
  const evidenceKind: RepairVerificationBundle['evidenceKind'] =
    result.testsRun.length > 0
      ? 'test'
      : result.status === 'blocked_external'
        ? 'status'
        : 'manual';
  const passed =
    (result.status === 'verified' || result.status === 'needs_local_landing') &&
    result.testsPassed === true;
  return {
    evidenceKind,
    passed,
    summary: result.verificationSummary,
    command: result.testsRun.join('; ') || null,
    metadata: {
      feedbackId: params.feedbackId,
      repairPlanId: params.repairPlanId || '',
      executionId: params.executionId || '',
      workerId: params.workerId || '',
      laneId: params.laneId || '',
      jobId: params.jobId || '',
      workerResultStatus: result.status,
      testsPassed:
        result.testsPassed === null ? 'unknown' : String(result.testsPassed),
      changedFiles: result.changedFiles.join(','),
      patchArtifact: result.patchArtifact || '',
      commitSha: result.commitSha || '',
      blockerClass: result.blockerClass || '',
      needsLocalApply: String(result.needsLocalApply),
      verificationFinal: String(passed),
      secretRedacted: String(result.secretRedacted),
    },
  };
}

export async function collectRepairWorkerOutput(params: {
  lane: {
    getPrimaryOutput(input: {
      handle: { laneId: 'cursor' | 'andrea_runtime'; jobId: string };
      groupFolder: string;
      chatJid: string;
      limit?: number;
    }): Promise<BackendPrimaryOutputResult>;
  };
  job: BackendJobDetails;
  groupFolder: string;
  chatJid: string;
}): Promise<string | null> {
  const metadata = params.job.metadata || {};
  const metadataText = [
    metadata.finalOutputText,
    metadata.latestOutputText,
    metadata.errorText,
    metadata.summary,
  ]
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
    .join('\n');
  if (metadataText.trim()) return metadataText;
  const output = await params.lane.getPrimaryOutput({
    handle: params.job.handle,
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
    limit: 80,
  });
  return output.text;
}
