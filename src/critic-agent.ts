import crypto from 'crypto';

import { isDatabaseInitialized, upsertCriticReview } from './db.js';
import type { CognitiveExecutiveChannel, CriticReviewRecord } from './types.js';

const PRIVACY_JSON = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
});

const MUTATING_ACTION_PATTERNS = [
  /\bsend\b/i,
  /\bbluebubbles_send\b/i,
  /\bmessage[-_ ]?action.*send\b/i,
  /\bcalendar.*(create|write|update|delete|move)\b/i,
  /\bdelete\b/i,
  /\bcommit\b/i,
  /\bpush\b/i,
  /\brestart\b/i,
  /\bdeploy\b/i,
  /\bpurchase\b/i,
  /\bservice.*(change|stop|start|restart)\b/i,
  /\bruntime.*follow[-_ ]?up\b/i,
];

const OPERATOR_ACTION_PATTERNS = [
  /\brepair.*land\b/i,
  /\bgit\b/i,
  /\bcursor\b/i,
  /\bruntime\b/i,
  /\balexa.*admin\b/i,
  /\boperator\b/i,
];

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function normalizeAction(action: string): string {
  return action.replace(/\s+/g, ' ').trim().slice(0, 320);
}

export interface CriticReviewInput {
  actor: string;
  action: string;
  channel?: CognitiveExecutiveChannel | 'operator' | 'internal';
  approvedCapability?: string | null;
  hasExplicitUserApproval?: boolean;
  mainControlVerified?: boolean;
  evidenceIds?: string[];
  allowReadOnly?: boolean;
  now?: Date;
  persist?: boolean;
}

export function reviewAgentAction(
  input: CriticReviewInput,
): CriticReviewRecord {
  const createdAt = nowIso(input.now);
  const action = normalizeAction(input.action || 'unknown');
  const actor = normalizeAction(input.actor || 'unknown');
  const channel = input.channel || 'internal';
  const riskFlags: string[] = [];
  const mutating = MUTATING_ACTION_PATTERNS.some((pattern) =>
    pattern.test(action),
  );
  const operatorScoped = OPERATOR_ACTION_PATTERNS.some((pattern) =>
    pattern.test(action),
  );

  if (mutating) riskFlags.push('mutating_action');
  if (operatorScoped) riskFlags.push('operator_scoped_action');
  if (!input.evidenceIds?.length) riskFlags.push('missing_evidence_ids');
  if (!input.approvedCapability && mutating)
    riskFlags.push('missing_approved_capability');
  if (operatorScoped && !input.mainControlVerified)
    riskFlags.push('main_control_not_verified');

  let decision: CriticReviewRecord['decision'] = 'proceed';
  let approvalRequired = false;
  let summary = 'Critic review allows the proposed read-only action.';
  let nextAction = 'Proceed with the safe read-only path.';

  if (mutating && !input.hasExplicitUserApproval) {
    decision = 'stage_approval';
    approvalRequired = true;
    summary =
      'Critic review staged approval instead of executing a side effect.';
    nextAction =
      'Ask for explicit same-channel approval or create an approval packet.';
  }
  if (operatorScoped && !input.mainControlVerified) {
    decision = 'block';
    approvalRequired = true;
    summary =
      'Critic review blocked an operator-scoped action outside verified main control.';
    nextAction =
      'Move this to the main control/operator surface before continuing.';
  }
  if (mutating && input.hasExplicitUserApproval && !input.approvedCapability) {
    decision = 'block';
    approvalRequired = true;
    summary =
      'Critic review blocked an approved-looking mutation with no bound capability.';
    nextAction = 'Bind approval to the exact pending action before executing.';
  }

  const review: CriticReviewRecord = {
    reviewId: hashId(
      'critic',
      `${actor}|${action}|${channel}|${createdAt}|${riskFlags.join(',')}`,
    ),
    createdAt,
    actor,
    action,
    channel,
    decision,
    approvalRequired,
    riskFlagsJson: JSON.stringify(riskFlags),
    summary,
    nextAction,
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertCriticReview(review);
  }
  return review;
}

export function formatCriticReview(review: CriticReviewRecord): string {
  const risks = JSON.parse(review.riskFlagsJson || '[]') as string[];
  return [
    '*Critic Review*',
    `Decision: ${review.decision}`,
    `Action: ${review.action}`,
    `Approval: ${review.approvalRequired ? 'required' : 'not required'}`,
    `Risks: ${risks.length ? risks.join(', ') : 'none'}`,
    `Summary: ${review.summary}`,
    `Next: ${review.nextAction}`,
  ].join('\n');
}
