import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listHierarchicalGoals,
  listProactiveOpportunities,
  listSkillPlaybooks,
  updateProactiveOpportunityStatus,
  upsertProactiveOpportunity,
} from './db.js';
import {
  buildRealityGroundingReport,
  type BuildRealityGroundingInput,
} from './reality-grounding.js';
import type { ProactiveOpportunity, RealityDoctorReport } from './types.js';

export interface ProactiveOpportunityReport {
  generatedAt: string;
  opportunities: ProactiveOpportunity[];
  topOpportunity?: ProactiveOpportunity | null;
  suppressed: ProactiveOpportunity[];
  nextAction: string;
  privacy: {
    metadataOnly: true;
    rawPrivateBodiesStored: false;
    rawPromptsStored: false;
    hiddenReasoningStored: false;
    rawToolOutputStored: false;
    secretsRedacted: true;
  };
}

const PRIVACY = {
  metadataOnly: true,
  rawPrivateBodiesStored: false,
  rawPromptsStored: false,
  hiddenReasoningStored: false,
  rawToolOutputStored: false,
  secretsRedacted: true,
} as const;

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|raw tool output/i;

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function safeText(value: string | null | undefined, limit = 900): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  if (SECRET_RE.test(normalized)) return '[redacted opportunity metadata]';
  return redactCouncilText(normalized, limit);
}

function safeJson(value: unknown, limit = 3200): string {
  try {
    const json = JSON.stringify(value ?? null);
    return safeText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            preview: json.slice(0, Math.max(32, limit - 120)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function evidenceJson(ids: string[]): string {
  return JSON.stringify(
    Array.from(
      new Set(
        ids
          .map((id) =>
            String(id || '')
              .replace(/[^A-Za-z0-9:_-]+/g, '_')
              .slice(0, 220),
          )
          .filter(Boolean),
      ),
    ).slice(0, 40),
  );
}

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

function isSuppressed(opportunity: ProactiveOpportunity, now: string): boolean {
  if (opportunity.status === 'dismissed') return true;
  if (opportunity.status !== 'snoozed') return false;
  if (!opportunity.snoozedUntil) return true;
  return Date.parse(opportunity.snoozedUntil) > Date.parse(now);
}

function candidate(input: {
  groupFolder?: string | null;
  now: string;
  triggerSource: string;
  relatedGoalId?: string | null;
  summary: string;
  reason: string;
  urgency: ProactiveOpportunity['urgency'];
  confidence: number;
  suggestedAction: string;
  approvalRequirement?: ProactiveOpportunity['approvalRequirement'];
  evidenceIds: string[];
}): ProactiveOpportunity {
  const stable = [
    input.groupFolder || 'global',
    input.triggerSource,
    input.relatedGoalId || '',
    input.summary,
  ].join('|');
  return {
    opportunityId: hashId('opportunity', stable),
    createdAt: input.now,
    updatedAt: input.now,
    groupFolder: input.groupFolder || null,
    triggerSource: safeText(input.triggerSource, 180),
    relatedGoalId: input.relatedGoalId || null,
    opportunitySummary: safeText(input.summary),
    reason: safeText(input.reason),
    urgency: input.urgency,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    suggestedAction: safeText(input.suggestedAction),
    approvalRequirement: input.approvalRequirement || 'read_only',
    status: 'proposed',
    snoozedUntil: null,
    evidenceRefsJson: evidenceJson(input.evidenceIds),
    privacyJson: privacyJson(),
  };
}

function buildCandidates(input: {
  groupFolder?: string | null;
  now: string;
  reality: RealityDoctorReport;
}): ProactiveOpportunity[] {
  const out: ProactiveOpportunity[] = [];
  const proofNeeds = input.reality.proofClosureSteps.filter(
    (step) => step.status !== 'complete',
  );
  const firstProof = proofNeeds[0];
  if (firstProof) {
    out.push(
      candidate({
        groupFolder: input.groupFolder,
        now: input.now,
        triggerSource: `proof:${firstProof.proofId}`,
        summary: `Close ${firstProof.proofName}.`,
        reason:
          'Reality Grounding says this proof gap limits high-confidence launch/status claims.',
        urgency:
          firstProof.status === 'missing_config' ||
          firstProof.status === 'externally_blocked'
            ? 'high'
            : 'normal',
        confidence: 0.78,
        suggestedAction: firstProof.exactNextStep,
        approvalRequirement:
          firstProof.status === 'repo_bug'
            ? 'operator_only'
            : 'manual_external',
        evidenceIds: [firstProof.stepId, firstProof.proofId],
      }),
    );
  }

  for (const contradiction of input.reality.contradictions.slice(0, 2)) {
    out.push(
      candidate({
        groupFolder: input.groupFolder,
        now: input.now,
        triggerSource: `contradiction:${contradiction.contradictionKind}`,
        summary: contradiction.summary,
        reason: 'Truth Maintenance found a mismatch worth resolving.',
        urgency: contradiction.severity === 'high' ? 'high' : 'normal',
        confidence: 0.72,
        suggestedAction: contradiction.nextAction,
        approvalRequirement: 'read_only',
        evidenceIds: [contradiction.contradictionId],
      }),
    );
  }

  if (isDatabaseInitialized()) {
    for (const goal of listHierarchicalGoals({
      groupFolder: input.groupFolder,
      statuses: ['active', 'blocked'],
      limit: 3,
    })) {
      out.push(
        candidate({
          groupFolder: input.groupFolder,
          now: input.now,
          triggerSource: 'active_goal',
          relatedGoalId: goal.goalId,
          summary: `Move ${goal.title} forward.`,
          reason:
            goal.status === 'blocked'
              ? 'This active goal is blocked and has a next safe action.'
              : 'This active goal is still current and has a practical next action.',
          urgency:
            goal.priority === 'urgent' || goal.priority === 'high'
              ? 'high'
              : 'normal',
          confidence: goal.confidence,
          suggestedAction: goal.nextAction,
          approvalRequirement: goal.approvalBoundary,
          evidenceIds: [goal.goalId],
        }),
      );
    }
    const skill = listSkillPlaybooks({
      groupFolder: input.groupFolder,
      statuses: ['suggested'],
      limit: 1,
    })[0];
    if (skill) {
      out.push(
        candidate({
          groupFolder: input.groupFolder,
          now: input.now,
          triggerSource: 'suggested_skill',
          summary: `Review learned skill: ${skill.title}.`,
          reason:
            'A suggested skill is waiting for review before Andrea treats it as a durable default.',
          urgency: 'low',
          confidence: skill.reliabilityScore,
          suggestedAction: skill.nextAction,
          approvalRequirement: 'read_only',
          evidenceIds: [skill.skillId],
        }),
      );
    }
  }

  return out;
}

export function buildProactiveOpportunityReport(
  params: {
    groupFolder?: string | null;
    now?: Date;
    persist?: boolean;
    realityInput?: BuildRealityGroundingInput;
    realityReport?: RealityDoctorReport;
  } = {},
): ProactiveOpportunityReport {
  const now = nowIso(params.now);
  const reality =
    params.realityReport ||
    buildRealityGroundingReport({
      ...(params.realityInput || {}),
      requestText:
        params.realityInput?.requestText || 'proactive opportunity detection',
      channel: params.realityInput?.channel || 'operator',
      persist: false,
    });
  const existing = isDatabaseInitialized()
    ? listProactiveOpportunities({
        groupFolder: params.groupFolder,
        limit: 100,
      })
    : [];
  const existingById = new Map(
    existing.map((item) => [item.opportunityId, item]),
  );
  const candidates = buildCandidates({
    groupFolder: params.groupFolder,
    now,
    reality,
  });
  const merged = candidates.map((item) => {
    const prior = existingById.get(item.opportunityId);
    if (prior && isSuppressed(prior, now)) return prior;
    if (prior && prior.status !== 'proposed') {
      return {
        ...item,
        status: prior.status,
        snoozedUntil: prior.snoozedUntil,
      };
    }
    return item;
  });
  if (params.persist !== false && isDatabaseInitialized()) {
    for (const item of merged) upsertProactiveOpportunity(item);
  }
  const suppressed = merged.filter((item) => isSuppressed(item, now));
  const opportunities = merged
    .filter((item) => !isSuppressed(item, now))
    .sort((a, b) => {
      const urgencyA =
        a.urgency === 'high' ? 2 : a.urgency === 'normal' ? 1 : 0;
      const urgencyB =
        b.urgency === 'high' ? 2 : b.urgency === 'normal' ? 1 : 0;
      return urgencyB - urgencyA || b.confidence - a.confidence;
    });
  const topOpportunity = opportunities[0] || null;
  return {
    generatedAt: now,
    opportunities,
    topOpportunity,
    suppressed,
    nextAction:
      topOpportunity?.suggestedAction ||
      'No proactive opportunity is strong enough to surface right now.',
    privacy: PRIVACY,
  };
}

export function formatProactiveOpportunityReport(
  report: ProactiveOpportunityReport,
): string {
  const lines = [
    '*Proactive Opportunities*',
    `Generated: ${report.generatedAt}`,
    `Surfaceable: ${report.opportunities.length}`,
    `Suppressed: ${report.suppressed.length}`,
    '',
    '*Top Opportunities*',
    ...(report.opportunities.length
      ? report.opportunities.slice(0, 8).map((item) => {
          return `- ${item.status}: ${item.opportunitySummary} / urgency=${item.urgency} / confidence=${item.confidence.toFixed(2)} / next=${item.suggestedAction}`;
        })
      : ['- none']),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; opportunities are suggestions, not hidden actions.',
  ];
  return lines.map((line) => redactCouncilText(line, 1200)).join('\n');
}

export function applyProactiveOpportunityControl(input: {
  text: string;
  opportunityId?: string | null;
  now?: Date;
}): { handled: boolean; message: string } {
  const normalized = input.text.trim().toLowerCase();
  const target =
    input.opportunityId ||
    listProactiveOpportunities({ statuses: ['shown', 'proposed'], limit: 1 })[0]
      ?.opportunityId;
  if (!target) {
    return { handled: false, message: 'No current opportunity was found.' };
  }
  if (
    /stop suggesting|do not bring this up|don't bring this up|dismiss/.test(
      normalized,
    )
  ) {
    updateProactiveOpportunityStatus(target, 'dismissed', nowIso(input.now));
    return {
      handled: true,
      message: "Got it. I won't keep surfacing that opportunity.",
    };
  }
  if (/snooze|later/.test(normalized)) {
    const now = input.now || new Date();
    const snoozedUntil = new Date(
      now.getTime() + 24 * 60 * 60 * 1000,
    ).toISOString();
    updateProactiveOpportunityStatus(
      target,
      'snoozed',
      now.toISOString(),
      snoozedUntil,
    );
    return {
      handled: true,
      message: "Okay. I'll hold that suggestion for now.",
    };
  }
  return { handled: false, message: 'No opportunity control matched.' };
}
