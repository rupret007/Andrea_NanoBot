import { listCapabilityAcquisitions } from './db.js';
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

export type CapabilityChatOwnerAction =
  | {
      kind: 'review';
      verdict: (typeof REVIEW_VERDICTS)[number];
      reference: string | null;
    }
  | {
      kind: 'control';
      actionKind: 'pause' | 'revoke' | 'retire' | 'show_evidence';
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
  action?: 'review' | 'control' | 'restricted' | 'disambiguation';
}

export interface CapabilityChatDispatcherDependencies {
  listAcquisitions: typeof listCapabilityAcquisitions;
  getStatus: typeof getCapabilityApprenticeshipStatus;
  issueReviewToken: typeof issueCapabilityReviewTokenForTrustedChat;
  recordVerdict: typeof recordCapabilityOwnerVerdict;
  issueControlToken: typeof issueCapabilityControlTokenForTrustedChat;
  applyControl: typeof applyCapabilityOwnerControl;
}

const DEFAULT_DEPENDENCIES: CapabilityChatDispatcherDependencies = {
  listAcquisitions: listCapabilityAcquisitions,
  getStatus: getCapabilityApprenticeshipStatus,
  issueReviewToken: issueCapabilityReviewTokenForTrustedChat,
  recordVerdict: recordCapabilityOwnerVerdict,
  issueControlToken: issueCapabilityControlTokenForTrustedChat,
  applyControl: applyCapabilityOwnerControl,
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

export function parseCapabilityChatOwnerAction(
  text: string,
): CapabilityChatOwnerAction | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 600) return null;

  let match = normalized.match(
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
): CapabilityApprenticeshipStatus[] {
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
  action: CapabilityChatOwnerAction,
): string {
  const command =
    action.kind === 'review'
      ? `capability verdict: ${action.verdict} <run-id>`
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

  const statuses = currentStatuses(input.group.folder, deps);
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
