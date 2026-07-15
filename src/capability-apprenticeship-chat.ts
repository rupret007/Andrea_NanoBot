import {
  approveCognitiveApprovalPacketCAS,
  getCapabilityAcquisition,
  getCapabilityProductionApprovalBinding,
  getCapabilityProductionRun,
  getCognitiveApprovalPacketForGroup,
  listCapabilityAcquisitions,
} from './db.js';
import { durableScopeHash } from './durable-work-continuity.js';
import {
  applyCapabilityOwnerControl,
  getCapabilityApprenticeshipStatus,
  issueCapabilityControlTokenForTrustedChat,
  issueCapabilityReviewTokenForTrustedChat,
  recordCapabilityOwnerVerdict,
  type CapabilityApprenticeshipStatus,
} from './production-capability-apprenticeship.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityOwnerReviewVerdict,
  CapabilityProductionRunRecord,
  CognitiveApprovalPacket,
  RegisteredGroup,
} from './types.js';

const REVIEW_VERDICTS = [
  'verified',
  'helpful',
  'partial',
  'blocked',
  'corrected',
  'rejected',
] as const satisfies readonly CapabilityOwnerReviewVerdict[];
const REVIEW_VERDICT_PATTERN = REVIEW_VERDICTS.join('|');
const OWNER_REVIEWABLE_RUN_STATUSES = new Set<
  CapabilityProductionRunRecord['status']
>([
  'awaiting_owner_review',
  'owner_reviewed',
  'awaiting_activation_approval',
  'active',
  'monitoring',
  'partial',
  'blocked',
  'paused',
]);
const MAX_CANDIDATES = 20;
const MAX_EVIDENCE_IDS = 32;
const ID_CAPTURE = '([a-zA-Z0-9][a-zA-Z0-9:._-]{0,239})';
const DIGEST_CAPTURE = '([a-fA-F0-9]{64})';

export type CapabilityChatOwnerAction =
  | {
      kind: 'approval';
      approvalPacketId: string;
      approvalVersion: number;
      scopeDigest: string;
      summaryDigest: string;
    }
  | {
      kind: 'review';
      verdict: (typeof REVIEW_VERDICTS)[number];
      reference: string | null;
    }
  | {
      kind: 'control';
      actionKind: 'pause' | 'revoke' | 'retire' | 'show_evidence';
      reference: string | null;
    }
  | {
      kind: 'status';
      queryKind:
        | 'learning'
        | 'canary_readiness'
        | 'review_needed'
        | 'current_state'
        | 'active'
        | 'why_paused'
        | 'keep_canary_only'
        | 'activate_exact_version';
      reference: string | null;
    };

export interface CapabilityChatDispatchInput {
  text: string;
  channelName: string;
  chatJid: string;
  group: RegisteredGroup;
  messageId?: string | null;
  now?: Date | string;
}

export interface CapabilityChatDispatchResult {
  handled: boolean;
  text?: string;
  action?:
    | 'approval'
    | 'review'
    | 'control'
    | 'status'
    | 'restricted'
    | 'disambiguation';
  timings?: { totalMs: number };
}

export interface CapabilityChatDispatcherDependencies {
  listAcquisitions: typeof listCapabilityAcquisitions;
  getAcquisition: typeof getCapabilityAcquisition;
  getRun: typeof getCapabilityProductionRun;
  getStatus: typeof getCapabilityApprenticeshipStatus;
  getApprovalPacket: typeof getCognitiveApprovalPacketForGroup;
  getApprovalBinding: typeof getCapabilityProductionApprovalBinding;
  approvePacket: typeof approveCognitiveApprovalPacketCAS;
  issueReviewToken: typeof issueCapabilityReviewTokenForTrustedChat;
  recordVerdict: typeof recordCapabilityOwnerVerdict;
  issueControlToken: typeof issueCapabilityControlTokenForTrustedChat;
  applyControl: typeof applyCapabilityOwnerControl;
  monotonicNow?: () => number;
}

const DEFAULT_DEPENDENCIES: CapabilityChatDispatcherDependencies = {
  listAcquisitions: listCapabilityAcquisitions,
  getAcquisition: getCapabilityAcquisition,
  getRun: getCapabilityProductionRun,
  getStatus: getCapabilityApprenticeshipStatus,
  getApprovalPacket: getCognitiveApprovalPacketForGroup,
  getApprovalBinding: getCapabilityProductionApprovalBinding,
  approvePacket: approveCognitiveApprovalPacketCAS,
  issueReviewToken: issueCapabilityReviewTokenForTrustedChat,
  recordVerdict: recordCapabilityOwnerVerdict,
  issueControlToken: issueCapabilityControlTokenForTrustedChat,
  applyControl: applyCapabilityOwnerControl,
  monotonicNow: () => performance.now(),
};

function reviewAction(
  verdict: string | undefined,
  reference: string | undefined,
): CapabilityChatOwnerAction | null {
  if (!REVIEW_VERDICTS.includes(verdict as (typeof REVIEW_VERDICTS)[number])) {
    return null;
  }
  return {
    kind: 'review',
    verdict: verdict as (typeof REVIEW_VERDICTS)[number],
    reference: reference || null,
  };
}

function statusAction(
  queryKind: Extract<
    CapabilityChatOwnerAction,
    { kind: 'status' }
  >['queryKind'],
  reference?: string,
): CapabilityChatOwnerAction {
  return { kind: 'status', queryKind, reference: reference || null };
}

export function parseCapabilityChatOwnerAction(
  text: string,
): CapabilityChatOwnerAction | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 600) return null;

  const approval = normalized.match(
    new RegExp(
      `^approve\\s+capability\\s+packet\\s+${ID_CAPTURE}\\s+version\\s+([1-9][0-9]{0,8})\\s+scope\\s+${DIGEST_CAPTURE}\\s+summary\\s+${DIGEST_CAPTURE}\\s*[.!]?$`,
      'i',
    ),
  );
  if (approval) {
    return {
      kind: 'approval',
      approvalPacketId: approval[1]!,
      approvalVersion: Number(approval[2]),
      scopeDigest: approval[3]!.toLowerCase(),
      summaryDigest: approval[4]!.toLowerCase(),
    };
  }

  if (
    /^(?:what (?:capabilities|skills) are you learning|what are you learning)\s*[?.!]?$/i.test(
      normalized,
    )
  ) {
    return statusAction('learning');
  }

  let match = normalized.match(
    new RegExp(
      `^(?:is|are)\\s+(?:(?:that|this|the)\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+ready\\s+for\\s+(?:a\\s+)?canary(?:\\s+run)?\\s*[?.!]?$`,
      'i',
    ),
  );
  if (match) return statusAction('canary_readiness', match[1]);

  match = normalized.match(
    /^(?:what|which)\s+(?:(?:capability|canary)\s+)?(?:needs?|is awaiting)\s+(?:owner\s+)?review\s*[?.!]?$/i,
  );
  if (match) return statusAction('review_needed');

  if (
    /^(?:show|what is)\s+(?:the\s+)?capability status\s*[?.!]?$/i.test(
      normalized,
    )
  ) {
    return statusAction('current_state');
  }

  match = normalized.match(
    new RegExp(
      `^is\\s+(?:(?:that|this|the)\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+active\\s*[?.!]?$`,
      'i',
    ),
  );
  if (match) return statusAction('active', match[1]);

  match = normalized.match(
    new RegExp(
      `^why\\s+is\\s+(?:(?:that|this|the)\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+paused\\s*[?.!]?$`,
      'i',
    ),
  );
  if (match) return statusAction('why_paused', match[1]);

  match = normalized.match(
    new RegExp(
      `^keep\\s+(?:(?:that|this|the)\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+canary[- ]only\\s*[?.!]?$`,
      'i',
    ),
  );
  if (match) return statusAction('keep_canary_only', match[1]);

  match = normalized.match(
    new RegExp(
      `^activate\\s+(?:(?:that|this|the)\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+(?:at\\s+the\\s+)?exact\\s+(?:contract\\s+)?version\\s*[?.!]?$`,
      'i',
    ),
  );
  if (match) return statusAction('activate_exact_version', match[1]);

  match = normalized.match(
    new RegExp(
      `^capability verdict\\s*:\\s*(${REVIEW_VERDICT_PATTERN})(?:\\s+${ID_CAPTURE})?\\s*[.!]?$`,
      'i',
    ),
  );
  if (match) return reviewAction(match[1]?.toLowerCase(), match[2]);

  match = normalized.match(
    new RegExp(
      `^review\\s+(?:that\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+as\\s+(${REVIEW_VERDICT_PATTERN})\\s*[.!]?$`,
      'i',
    ),
  );
  if (match) return reviewAction(match[2]?.toLowerCase(), match[1]);

  match = normalized.match(
    new RegExp(
      `^mark\\s+(?:that\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+(${REVIEW_VERDICT_PATTERN})\\s*[.!]?$`,
      'i',
    ),
  );
  if (match) return reviewAction(match[2]?.toLowerCase(), match[1]);

  match = normalized.match(
    new RegExp(
      `^(pause|revoke|retire)\\s+(?:that\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s*[.!]?$`,
      'i',
    ),
  );
  if (match) {
    return {
      kind: 'control',
      actionKind: match[1]?.toLowerCase() as 'pause' | 'revoke' | 'retire',
      reference: match[2] || null,
    };
  }

  match = normalized.match(
    new RegExp(
      `^show\\s+(?:me\\s+)?(?:the\\s+)?evidence\\s+(?:for\\s+)?(?:that\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s*[?.!]?$`,
      'i',
    ),
  );
  if (!match) {
    match = normalized.match(
      new RegExp(
        `^show\\s+(?:that\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s+evidence\\s*[?.!]?$`,
        'i',
      ),
    );
  }
  if (!match) {
    match = normalized.match(
      new RegExp(
        `^what\\s+evidence\\s+do\\s+you\\s+have\\s+for\\s+(?:that\\s+)?(?:capability|canary)(?:\\s+${ID_CAPTURE})?\\s*[?.!]?$`,
        'i',
      ),
    );
  }
  return match
    ? {
        kind: 'control',
        actionKind: 'show_evidence',
        reference: match[1] || null,
      }
    : null;
}

function iso(value?: Date | string): string {
  const parsed =
    value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('Capability owner-action time is invalid.');
  }
  return parsed.toISOString();
}

function isEvidenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(value)
  );
}

function storedEvidenceIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEvidenceId) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

function evidenceIds(
  acquisition: CapabilityAcquisitionRecord,
  run?: CapabilityProductionRunRecord,
  receiptId?: string | null,
): string[] {
  return [
    ...new Set(
      [
        ...storedEvidenceIds(acquisition.outcomeIdsJson),
        run?.workId,
        run?.checkpointId,
        run?.invocationId,
        run?.canaryApprovalPacketId,
        run?.activationApprovalPacketId,
        run?.outcomeId,
        run?.ownerReviewId,
        run?.healthEvidenceSetDigest,
        run?.postconditionFingerprint,
        receiptId,
      ].filter(isEvidenceId),
    ),
  ]
    .sort()
    .slice(0, MAX_EVIDENCE_IDS);
}

function currentStatuses(
  groupFolder: string,
  deps: CapabilityChatDispatcherDependencies,
  reference: string | null,
): CapabilityApprenticeshipStatus[] {
  if (reference) {
    const exactAcquisition = deps.getAcquisition(reference);
    const exactRun = deps.getRun(reference);
    const acquisitionIds = new Set<string>();
    if (exactAcquisition?.groupFolder === groupFolder) {
      acquisitionIds.add(exactAcquisition.acquisitionId);
    }
    if (exactRun?.groupFolder === groupFolder) {
      acquisitionIds.add(exactRun.acquisitionId);
    }
    return [...acquisitionIds].map((acquisitionId) => {
      const status = deps.getStatus(acquisitionId);
      if (
        !exactRun ||
        exactRun.acquisitionId !== acquisitionId ||
        status.runs.some((run) => run.runId === exactRun.runId)
      ) {
        return status;
      }
      // Preserve the canonical latest run at index zero. An exact older run may
      // be needed for status or outcome review, but must never become the
      // implicit lifecycle-control target merely because it fell outside the
      // bounded status projection.
      return { ...status, runs: [...status.runs, exactRun] };
    });
  }
  return deps
    .listAcquisitions({ groupFolder, limit: MAX_CANDIDATES })
    .filter((acquisition) => acquisition.groupFolder === groupFolder)
    .map((acquisition) => deps.getStatus(acquisition.acquisitionId));
}

function exactSurfaceRun(
  run: CapabilityProductionRunRecord,
  input: CapabilityChatDispatchInput,
): boolean {
  return (
    run.groupFolder === input.group.folder &&
    run.channel === input.channelName &&
    run.authorizedSurface === input.channelName &&
    run.chatScopeHash === durableScopeHash('chat', input.chatJid) &&
    run.groupScopeHash === durableScopeHash('group', input.group.folder)
  );
}

interface ActionCandidate {
  status: CapabilityApprenticeshipStatus;
  run: CapabilityProductionRunRecord;
}

function selectCandidate(
  candidates: ActionCandidate[],
  reference: string | null,
): { selected: ActionCandidate | null; ambiguous: ActionCandidate[] } {
  if (reference) {
    const matching = candidates.filter(
      (candidate) =>
        candidate.run.runId === reference ||
        candidate.status.acquisition.acquisitionId === reference,
    );
    return {
      selected: matching.length === 1 ? matching[0]! : null,
      ambiguous: matching.length > 1 ? matching : [],
    };
  }
  return {
    selected: candidates.length === 1 ? candidates[0]! : null,
    ambiguous: candidates.length > 1 ? candidates : [],
  };
}

function disambiguationText(
  candidates: ActionCandidate[],
  action: Exclude<CapabilityChatOwnerAction, { kind: 'approval' }>,
): string {
  const command =
    action.kind === 'review'
      ? `capability verdict: ${action.verdict} <run-id>`
      : action.kind === 'status'
        ? action.queryKind === 'activate_exact_version'
          ? 'activate capability <acquisition-id> exact version'
          : action.queryKind === 'keep_canary_only'
            ? 'keep capability <acquisition-id> canary-only'
            : `show capability status`
        : action.actionKind === 'show_evidence'
          ? 'show evidence for capability <acquisition-id>'
          : `${action.actionKind} capability <acquisition-id>`;
  return [
    'I found more than one exact capability candidate, so I did not record or change anything.',
    ...candidates
      .slice(0, 8)
      .map(
        ({ status, run }) =>
          `- Acquisition ${status.acquisition.acquisitionId} · run ${run.runId} · ${status.acquisition.state} · ${run.status}`,
      ),
    `Reply with: ${command}`,
    'Only metadata identifiers are shown; no private prompts or tool payloads were loaded.',
  ].join('\n');
}

function presentedPendingAction(
  status: CapabilityApprenticeshipStatus,
): CapabilityApprenticeshipStatus['pendingAction'] | 'canary_staging' {
  return status.acquisition.state === 'owner_review_required' &&
    status.pendingAction === 'none'
    ? 'canary_staging'
    : status.pendingAction;
}

function statusLine(status: CapabilityApprenticeshipStatus): string {
  const latest = status.runs[0];
  return `- ${status.acquisition.taskFamily} · ${status.acquisition.acquisitionId} · ${status.acquisition.state} v${status.acquisition.recordVersion} · pending ${presentedPendingAction(status)}${latest ? ` · latest ${latest.runId} ${latest.status} r${latest.revision}` : ' · no production run'}`;
}

function statusMatchesReference(
  status: CapabilityApprenticeshipStatus,
  reference: string,
): boolean {
  return (
    status.acquisition.acquisitionId === reference ||
    status.runs.some((run) => run.runId === reference)
  );
}

function selectStatusTargets(
  statuses: CapabilityApprenticeshipStatus[],
  action: Extract<CapabilityChatOwnerAction, { kind: 'status' }>,
): { targets: CapabilityApprenticeshipStatus[]; ambiguous: boolean } {
  if (action.reference) {
    const matching = statuses.filter((status) =>
      statusMatchesReference(status, action.reference as string),
    );
    return { targets: matching, ambiguous: matching.length > 1 };
  }
  const overview = new Set([
    'learning',
    'canary_readiness',
    'review_needed',
    'current_state',
  ]);
  return overview.has(action.queryKind)
    ? { targets: statuses, ambiguous: false }
    : {
        targets: statuses.length === 1 ? statuses : [],
        ambiguous: statuses.length > 1,
      };
}

function statusDisambiguationText(
  statuses: CapabilityApprenticeshipStatus[],
  action: Extract<CapabilityChatOwnerAction, { kind: 'status' }>,
): string {
  const command =
    action.queryKind === 'activate_exact_version'
      ? 'activate capability <acquisition-id> exact version'
      : action.queryKind === 'keep_canary_only'
        ? 'keep capability <acquisition-id> canary-only'
        : action.queryKind === 'why_paused'
          ? 'why is capability <acquisition-id> paused?'
          : 'is capability <acquisition-id> active?';
  return [
    'I found more than one capability, so I did not infer which one you meant or change anything.',
    ...statuses.slice(0, 8).map(statusLine),
    `Reply with: ${command}`,
    'No approval, review, activation, or lifecycle change was recorded.',
  ].join('\n');
}

function formatCapabilityStatusQuery(
  statuses: CapabilityApprenticeshipStatus[],
  action: Extract<CapabilityChatOwnerAction, { kind: 'status' }>,
  input: CapabilityChatDispatchInput,
): CapabilityChatDispatchResult {
  const selection = selectStatusTargets(statuses, action);
  if (selection.ambiguous) {
    return {
      handled: true,
      action: 'disambiguation',
      text: statusDisambiguationText(statuses, action),
    };
  }
  if (selection.targets.length === 0) {
    return {
      handled: true,
      action: 'status',
      text: 'No canonical capability matched this private group and identifier. I did not approve, review, activate, or change anything.',
    };
  }
  if (action.queryKind === 'learning' || action.queryKind === 'current_state') {
    return {
      handled: true,
      action: 'status',
      text: [
        'Capability learning (bounded metadata only):',
        ...selection.targets.map(statusLine),
        'No status query approves a canary, records an owner verdict, or activates a capability.',
      ].join('\n'),
    };
  }
  if (action.queryKind === 'canary_readiness') {
    return {
      handled: true,
      action: 'status',
      text: [
        'Canary readiness:',
        ...selection.targets.map((status) => {
          const pending = presentedPendingAction(status);
          const summary =
            pending === 'canary_staging'
              ? 'canonical candidate exists; ready for exact trusted-chat canary staging'
              : pending === 'canary_approval'
                ? 'exact canary is staged and awaiting separate approval'
                : pending === 'action_approval'
                  ? 'protected plan is staged and awaiting a separate action-specific approval on this exact trusted chat; canary or activation approval cannot substitute'
                  : pending === 'canary_execution'
                    ? 'approved exact canary is awaiting bounded execution'
                    : pending === 'owner_review'
                      ? 'canary completed and is awaiting an explicit owner verdict'
                      : `not awaiting canary work; current state is ${status.acquisition.state}`;
          return `- ${status.acquisition.acquisitionId} v${status.acquisition.recordVersion}: ${summary}.`;
        }),
        'This status check did not stage, approve, execute, or review a canary.',
      ].join('\n'),
    };
  }
  if (action.queryKind === 'review_needed') {
    const reviewRuns = selection.targets.flatMap((status) =>
      status.runs
        .filter(
          (run) =>
            run.status === 'awaiting_owner_review' &&
            Boolean(run.outcomeId) &&
            exactSurfaceRun(run, input),
        )
        .map((run) => ({ status, run })),
    );
    return {
      handled: true,
      action: 'status',
      text: reviewRuns.length
        ? [
            'Capability runs awaiting your verdict on this exact trusted chat:',
            ...reviewRuns.map(
              ({ status, run }) =>
                `- ${status.acquisition.acquisitionId} · ${run.runId} · candidate v${run.contractVersion} · run r${run.revision}`,
            ),
            'Reply with: capability verdict: <verdict> <run-id>',
            'Nothing was reviewed or approved by this status check.',
          ].join('\n')
        : 'No exact capability run on this trusted chat is awaiting owner review. I did not fabricate or record a verdict.',
    };
  }

  const status = selection.targets[0]!;
  const latest = status.runs[0];
  if (action.queryKind === 'active') {
    const active = ['active', 'monitoring'].includes(status.acquisition.state);
    return {
      handled: true,
      action: 'status',
      text: [
        `Capability ${status.acquisition.acquisitionId} is ${active ? 'active' : 'not active'}; canonical state is ${status.acquisition.state} v${status.acquisition.recordVersion}.`,
        latest
          ? `Latest run: ${latest.runId} · ${latest.status} r${latest.revision}.`
          : 'No production run is recorded.',
        'No lifecycle change was made.',
      ].join('\n'),
    };
  }
  if (action.queryKind === 'why_paused') {
    return {
      handled: true,
      action: 'status',
      text:
        status.acquisition.state === 'paused'
          ? [
              `Capability ${status.acquisition.acquisitionId} is paused at v${status.acquisition.recordVersion}.`,
              `Recorded correction count: ${status.acquisition.correctionCount}; negative outcome count: ${status.acquisition.negativeOutcomeCount}.`,
              latest
                ? `Latest run: ${latest.runId} · ${latest.status} r${latest.revision}.`
                : 'No production run is recorded.',
              'This bounded view does not invent a pause reason. Ask to show evidence for the exact capability to inspect its metadata identifiers.',
            ].join('\n')
          : `Capability ${status.acquisition.acquisitionId} is not paused; canonical state is ${status.acquisition.state} v${status.acquisition.recordVersion}. No lifecycle change was made.`,
    };
  }
  if (action.queryKind === 'keep_canary_only') {
    const active = ['active', 'monitoring'].includes(status.acquisition.state);
    return {
      handled: true,
      action: 'status',
      text: active
        ? `Capability ${status.acquisition.acquisitionId} is already ${status.acquisition.state}. I did not reinterpret “keep canary-only” as a destructive or revocation action. Reply “pause capability ${status.acquisition.acquisitionId}” to stop active reuse; that remains a separate explicit control.`
        : `Capability ${status.acquisition.acquisitionId} remains ${status.acquisition.state} v${status.acquisition.recordVersion}; I did not activate it or stage an activation approval. Activation remains a separate exact-version decision, so it stays canary-only unless that later approval path is completed.`,
    };
  }
  return {
    handled: true,
    action: 'status',
    text: [
      `Exact activation request recognized for ${status.acquisition.acquisitionId} v${status.acquisition.recordVersion}.`,
      latest
        ? `Latest run: ${latest.runId} · ${latest.status} r${latest.revision} · contract v${latest.contractVersion}.`
        : 'No production canary run is recorded.',
      'I did not activate it, stage an approval, approve a packet, or invent an owner review. Activation requires a canonical verified owner verdict, a separately staged exact-scope activation packet, and explicit approval consumed on the same bound trusted surface.',
    ].join('\n'),
  };
}

function withStatusQueryTiming(
  result: CapabilityChatDispatchResult,
  startedAt: number,
  monotonicNow: () => number,
): CapabilityChatDispatchResult {
  const finishedAt = monotonicNow();
  const totalMs =
    Number.isFinite(startedAt) && Number.isFinite(finishedAt)
      ? Math.max(0, Math.round((finishedAt - startedAt) * 100) / 100)
      : 0;
  return {
    ...result,
    ...(result.text
      ? {
          text: `${result.text}\n\nStatus lookup timing (local): ${totalMs} ms.`,
        }
      : {}),
    timings: { totalMs },
  };
}

function stagedPacketMatchesCurrentBoundary(
  packet: CognitiveApprovalPacket,
  run: CapabilityProductionRunRecord,
): boolean {
  if (packet.approvalPacketId === run.canaryApprovalPacketId) {
    return run.status === 'awaiting_canary_approval';
  }
  if (packet.approvalPacketId === run.activationApprovalPacketId) {
    return run.status === 'awaiting_activation_approval';
  }
  return run.status === 'awaiting_action_approval';
}

function matchingApprovalCommandVersion(
  packet: CognitiveApprovalPacket,
): number | null {
  const version = packet.approvalVersion;
  if (!version || !Number.isSafeInteger(version) || version < 1) return null;
  return packet.status === 'approved' ? version - 1 : version;
}

function exactApprovalTruthText(
  packet: CognitiveApprovalPacket,
  channelName: string,
  approvedNow: boolean,
): string {
  if (packet.status === 'approved' && packet.approvalChannel === channelName) {
    return approvedNow
      ? `Approved exact capability packet ${packet.approvalPacketId} on this ${channelName} conversation. Current packet version is ${packet.approvalVersion}; no capability action was executed.`
      : `Capability packet ${packet.approvalPacketId} is already approved on this exact ${channelName} conversation at version ${packet.approvalVersion}. I did not approve it again or execute a capability action.`;
  }
  if (packet.status === 'expired') {
    return `Capability packet ${packet.approvalPacketId} is expired. I did not approve it or execute a capability action; stage a fresh exact packet after revalidation.`;
  }
  if (packet.status === 'rejected') {
    return `Capability packet ${packet.approvalPacketId} is rejected. I did not reopen, approve, or execute it.`;
  }
  if (packet.status === 'executed_elsewhere') {
    return `Capability packet ${packet.approvalPacketId} was decided elsewhere. I did not relabel, approve, or execute it here.`;
  }
  return `Capability packet ${packet.approvalPacketId} remains ${packet.status}. I did not approve or execute it.`;
}

function dispatchExactCapabilityApproval(
  input: CapabilityChatDispatchInput,
  action: Extract<CapabilityChatOwnerAction, { kind: 'approval' }>,
  deps: CapabilityChatDispatcherDependencies,
): CapabilityChatDispatchResult {
  const groupFolder = input.group.folder;
  const packet = deps.getApprovalPacket({
    approvalPacketId: action.approvalPacketId,
    groupFolder,
  });
  const binding = deps.getApprovalBinding({
    approvalPacketId: action.approvalPacketId,
    groupFolder,
  });
  if (!packet || !binding || binding.ambiguous || !binding.run) {
    return {
      handled: true,
      action: 'approval',
      text: 'No one exact canonical capability packet and production binding matched this command. I did not approve or execute anything.',
    };
  }
  const run = binding.run;
  if (
    binding.authorizedSurface !== input.channelName ||
    binding.trustedChatSurface !== input.channelName ||
    !exactSurfaceRun(run, input)
  ) {
    return {
      handled: true,
      action: 'restricted',
      text: 'That capability packet belongs to a different exact trusted conversation or channel. I did not relabel, approve, or execute it.',
    };
  }
  const commandVersion = matchingApprovalCommandVersion(packet);
  if (
    commandVersion !== action.approvalVersion ||
    packet.scopeDigest !== action.scopeDigest ||
    packet.summaryDigest !== action.summaryDigest
  ) {
    return {
      handled: true,
      action: 'approval',
      text: 'The packet version, scope digest, or reviewed-summary digest no longer matches canonical truth. I did not approve or execute anything; inspect the current packet before deciding.',
    };
  }
  if (packet.status !== 'staged') {
    return {
      handled: true,
      action: 'approval',
      text: exactApprovalTruthText(packet, input.channelName, false),
    };
  }
  if (packet.approvalChannel !== null && packet.approvalChannel !== undefined) {
    return {
      handled: true,
      action: 'approval',
      text: 'The staged capability packet already carries unexpected decision provenance. I did not relabel, approve, or execute it.',
    };
  }
  if (!stagedPacketMatchesCurrentBoundary(packet, run)) {
    return {
      handled: true,
      action: 'approval',
      text: 'The capability run is no longer waiting at this packet boundary. I did not approve or execute anything; inspect current run truth first.',
    };
  }
  const now = iso(input.now);
  const result = deps.approvePacket({
    approvalPacketId: packet.approvalPacketId,
    groupFolder,
    expectedSummary: packet.summary,
    expectedApprovalVersion: action.approvalVersion,
    expectedScopeDigest: action.scopeDigest,
    now,
    approvalChannel: input.channelName,
  });
  const current =
    deps.getApprovalPacket({
      approvalPacketId: packet.approvalPacketId,
      groupFolder,
    }) || packet;
  if (result.status === 'approved') {
    return {
      handled: true,
      action: 'approval',
      text: exactApprovalTruthText(current, input.channelName, true),
    };
  }
  if (result.status === 'expired' || result.status === 'already_decided') {
    return {
      handled: true,
      action: 'approval',
      text: exactApprovalTruthText(current, input.channelName, false),
    };
  }
  return {
    handled: true,
    action: 'approval',
    text: 'Canonical packet truth changed before approval could be recorded. I did not retry, broaden authority, or execute anything; inspect the current packet before deciding.',
  };
}

function isExpectedCanonicalConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(Capability|Canary) (owner|run|review|acquisition|production|control|is|has)/i.test(
      error.message,
    )
  );
}

export function dispatchCapabilityApprenticeshipOwnerAction(
  input: CapabilityChatDispatchInput,
  deps: CapabilityChatDispatcherDependencies = DEFAULT_DEPENDENCIES,
): CapabilityChatDispatchResult {
  const action = parseCapabilityChatOwnerAction(input.text);
  if (!action) return { handled: false };
  if (!isTrustedOwnerReviewSurface(input)) {
    return {
      handled: true,
      action: 'restricted',
      text: 'Capability review and controls are private to the registered main Telegram chat or explicitly configured Messages self-thread. I did not load evidence, issue a token, approve anything, or change capability state.',
    };
  }

  if (action.kind === 'approval') {
    return dispatchExactCapabilityApproval(input, action, deps);
  }

  const statusStartedAt =
    action.kind === 'status'
      ? (deps.monotonicNow || DEFAULT_DEPENDENCIES.monotonicNow!)()
      : 0;
  const statuses = currentStatuses(input.group.folder, deps, action.reference);
  if (action.kind === 'status') {
    return withStatusQueryTiming(
      formatCapabilityStatusQuery(statuses, action, input),
      statusStartedAt,
      deps.monotonicNow || DEFAULT_DEPENDENCIES.monotonicNow!,
    );
  }
  const candidates: ActionCandidate[] = statuses.flatMap((status) => {
    if (action.kind === 'review') {
      return status.runs
        .filter(
          (run) =>
            OWNER_REVIEWABLE_RUN_STATUSES.has(run.status) &&
            Boolean(run.outcomeId) &&
            exactSurfaceRun(run, input),
        )
        .map((run) => ({ status, run }));
    }
    const latestRun = status.runs[0];
    return latestRun && exactSurfaceRun(latestRun, input)
      ? [{ status, run: latestRun }]
      : [];
  });
  const selection = selectCandidate(candidates, action.reference);
  if (selection.ambiguous.length > 1) {
    return {
      handled: true,
      action: 'disambiguation',
      text: disambiguationText(selection.ambiguous, action),
    };
  }
  if (!selection.selected) {
    return {
      handled: true,
      action: 'disambiguation',
      text:
        action.kind === 'review'
          ? 'No exact canary eligible for owner review matched this private surface and identifier. I did not record a verdict or approve activation.'
          : 'No exact capability matched this private surface and identifier. I did not issue a control token or change capability state.',
    };
  }

  const { status, run } = selection.selected;
  const now = iso(input.now);
  try {
    if (action.kind === 'review') {
      const token = deps.issueReviewToken({
        runId: run.runId,
        channelName: input.channelName,
        chatJid: input.chatJid,
        group: input.group,
        messageId: input.messageId || null,
        now,
      });
      const result = deps.recordVerdict({
        token,
        verdict: action.verdict,
        sourceMessageId: input.messageId || null,
        now,
      });
      return {
        handled: true,
        action: 'review',
        text: [
          `Capability canary verdict recorded: ${action.verdict}.`,
          `Acquisition: ${result.acquisition.acquisitionId}`,
          `Run: ${result.run.runId}`,
          `State: ${result.acquisition.state} · ${result.run.status}`,
          'Activation was not proposed or approved. Protected effects still require their normal fresh approval.',
        ].join('\n'),
      };
    }

    const token = deps.issueControlToken({
      acquisitionId: status.acquisition.acquisitionId,
      actionKind: action.actionKind,
      channelName: input.channelName,
      chatJid: input.chatJid,
      group: input.group,
      messageId: input.messageId || null,
      now,
    });
    const result = deps.applyControl({ token, now });
    const ids = evidenceIds(
      result.acquisition,
      result.run,
      result.receipt?.receiptId,
    );
    if (action.actionKind === 'show_evidence') {
      return {
        handled: true,
        action: 'control',
        text: [
          'Capability evidence (metadata only):',
          `Acquisition: ${result.acquisition.acquisitionId}`,
          `State: ${result.acquisition.state}`,
          ...(result.run
            ? [`Run: ${result.run.runId} · ${result.run.status}`]
            : []),
          `Evidence IDs: ${ids.length ? ids.join(', ') : 'none recorded'}`,
          'No private prompts, raw messages, credentials, paths, or tool payloads are included.',
        ].join('\n'),
      };
    }
    return {
      handled: true,
      action: 'control',
      text: [
        `Capability control applied: ${action.actionKind}.`,
        `Acquisition: ${result.acquisition.acquisitionId}`,
        `State: ${result.acquisition.state}`,
        ...(result.run
          ? [`Run: ${result.run.runId} · ${result.run.status}`]
          : []),
        'Historical evidence was retained. This did not approve a canary, activation, or protected effect.',
      ].join('\n'),
    };
  } catch (error) {
    if (!isExpectedCanonicalConflict(error)) throw error;
    return {
      handled: true,
      action: action.kind,
      text: 'The exact capability state changed before this private action could be consumed. I did not retry against a different run or broaden its scope.',
    };
  }
}
