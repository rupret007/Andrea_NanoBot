import { createHash } from 'node:crypto';

import type { PlatformTaskFamily } from './andrea-platform-bridge.js';
import { brokerCapabilityResources } from './capability-resource-broker.js';
import { isDatabaseInitialized } from './db.js';
import type {
  CapabilityAcquisitionState,
  CapabilityGapKind,
  ImprovementRiskLevel,
} from './types.js';
import { observeCapabilityGap } from './verified-capability-acquisition.js';

const EXPLICIT_CAPABILITY_LEARNING_PATTERN =
  /\b(?:learn how to|teach (?:yourself|andrea) (?:how to|to)|acquire (?:a |the )?(?:new )?capability|add (?:a |the )?(?:new )?capability|new capability|unfamiliar (?:task|tool|workflow|capability)|novel (?:task|tool|workflow|capability)|figure out how to (?:use|run|invoke|integrate|build)|you (?:do not|don't|cannot|can't) know how to|never (?:done|used|run) this before)\b/i;

export interface TurnCapabilityAcquisitionStatus {
  acquisitionId: string;
  state: CapabilityAcquisitionState;
  gapKind: CapabilityGapKind;
  taskFamily: PlatformTaskFamily;
  nextSafeAction: string;
  ownerScopeRef: string;
  requestFingerprint: string;
  evidenceOrigin: 'live';
  metadataOnly: true;
  rawContentStored: false;
  candidateResourceCount: number;
  selectedResourceCount: number;
  durableWorkLinked: boolean;
  deepWorkPacketId?: string;
}

export interface ObserveTurnCapabilityGapInput {
  turnId: string;
  channel: string;
  groupFolder?: string | null;
  actorId?: string | null;
  text: string;
  requestRoute?: string | null;
  runOrigin: 'live' | 'replay' | 'synthetic';
  taskFamily: PlatformTaskFamily;
  selectedSkillId: string;
  selectedSkillRisk: 'none' | 'low' | 'medium' | 'high';
  selectedSkillApprovalNeed: 'none' | 'conditional' | 'explicit';
  executionPosture?: string | null;
  durableWorkId?: string | null;
  deepWorkPacketId?: string | null;
  now?: Date;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedIntent(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function bounded(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function turnShape(text: string): string {
  const normalized = text.trim();
  const words = normalized ? normalized.split(/\s+/).length : 0;
  const shape = words <= 8 ? 'short' : words <= 30 ? 'medium' : 'long';
  return `${shape}:${/\?/.test(normalized) ? 'question' : 'request'}`;
}

function acquisitionRisk(
  value: ObserveTurnCapabilityGapInput['selectedSkillRisk'],
): ImprovementRiskLevel {
  if (value === 'high') return 'high';
  if (value === 'medium') return 'medium';
  return 'low';
}

export function hasExplicitCapabilityLearningIntent(text: string): boolean {
  return EXPLICIT_CAPABILITY_LEARNING_PATTERN.test(normalizedIntent(text));
}

/**
 * Record only a bounded, metadata-derived capability gap for an explicit
 * learn-first turn. Discovery is transient here: this boundary never scopes,
 * compiles, approves, executes, activates, or stores the request body.
 */
export function observeTurnCapabilityGap(
  input: ObserveTurnCapabilityGapInput,
): TurnCapabilityAcquisitionStatus | null {
  if (
    input.runOrigin !== 'live' ||
    !input.groupFolder ||
    !isDatabaseInitialized()
  ) {
    return null;
  }
  const learnFirst = input.executionPosture === 'learn_first';
  if (!learnFirst && !hasExplicitCapabilityLearningIntent(input.text)) {
    return null;
  }

  const ownerScopeRef = sha256(
    `${input.groupFolder}\u0000${input.actorId || 'group-owner'}`,
  ).slice(0, 32);
  const requestFingerprint = sha256(
    `${ownerScopeRef}\u0000${normalizedIntent(input.text)}`,
  );
  const postconditions = [
    `A bounded ${input.taskFamily} capability plan identifies the exact prerequisites and resources required for the request.`,
    'The capability is not used until its postconditions are independently verified under the existing approval policy.',
  ];
  const targetOutcome = `Acquire a verified ${input.taskFamily} capability for explicit unfamiliar-task request ${requestFingerprint.slice(0, 24)} (${turnShape(input.text)}).`;
  const broker = brokerCapabilityResources({
    targetOutcome,
    postconditions,
    taskFamily: input.taskFamily,
    groupFolder: input.groupFolder,
    // This is an inventory-only classification pass. Looking at descriptors
    // that require operator context or approved content does not grant either;
    // the acquisition ledger and eventual executor must still enforce them.
    authorityCeiling: 'operator_context',
    maxDataEgressClass: 'approved_content',
    maxRiskLevel: 'critical',
    maxResources: 4,
  });
  const shouldLinkRepositoryWork =
    input.taskFamily === 'code' &&
    broker.gapKind === 'implementation_gap' &&
    Boolean(input.durableWorkId && input.deepWorkPacketId);
  const environmentFingerprint = sha256(
    [
      'turn-capability-acquisition:v1',
      input.channel,
      input.requestRoute || 'unknown-route',
      input.selectedSkillId,
      ownerScopeRef,
    ].join('|'),
  );
  const record = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: input.groupFolder,
    targetOutcome,
    postconditions,
    taskFamily: input.taskFamily,
    gapKind: broker.gapKind,
    knownPrerequisites: broker.selectedResources.map(
      (item) => `resource:${item.resource.resourceId}@${item.resource.version}`,
    ),
    missingPrerequisites: broker.missingPostconditions.map(
      (_item, index) => `unmet-postcondition:${index + 1}`,
    ),
    affectedCapability: input.selectedSkillId,
    candidateResources: broker.rankedCandidates
      .slice(0, 8)
      .map((item) => item.resource),
    riskLevel: acquisitionRisk(input.selectedSkillRisk),
    dataEgressClass: 'local_only',
    expectedCostBand: 'unknown',
    expectedLatencyBand: 'unknown',
    authorityRequirements:
      input.selectedSkillApprovalNeed === 'none'
        ? ['Resource discovery does not grant execution authority.']
        : [
            'Resource discovery does not grant execution authority.',
            'Any authority-bearing step requires its exact fresh approval.',
          ],
    confidence: learnFirst ? 0.9 : 0.75,
    provenanceRefs: [
      `turn-ref:${sha256(input.turnId)}`,
      `owner-scope:${ownerScopeRef}`,
      `intent-fingerprint:${requestFingerprint}`,
    ],
    evidenceOrigin: 'live',
    environmentFingerprint: `sha256:${environmentFingerprint}`,
    ...(shouldLinkRepositoryWork && input.durableWorkId
      ? { durableWorkId: input.durableWorkId }
      : {}),
    now: input.now,
  });

  return {
    acquisitionId: record.acquisitionId,
    state: record.state,
    gapKind: record.gapKind,
    taskFamily: input.taskFamily,
    nextSafeAction: bounded(record.nextSafeAction, 300),
    ownerScopeRef,
    requestFingerprint,
    evidenceOrigin: 'live',
    metadataOnly: true,
    rawContentStored: false,
    candidateResourceCount: Math.min(broker.rankedCandidates.length, 8),
    selectedResourceCount: Math.min(broker.selectedResources.length, 4),
    durableWorkLinked: shouldLinkRepositoryWork,
    ...(shouldLinkRepositoryWork && input.deepWorkPacketId
      ? { deepWorkPacketId: input.deepWorkPacketId }
      : {}),
  };
}
