import crypto from 'crypto';

import { beginAgentOSEpisode } from './agent-os.js';
import { createTask } from './db.js';
import { planContextualReminder } from './local-reminder.js';
import { upsertOutcomeRecord } from './outcome-reviews.js';
import {
  buildPersonalContextGraph,
  redactPersonalContextText,
  type PersonalContextGraphInsight,
  type PersonalContextGraphNode,
} from './personal-context-graph.js';
import type {
  AssistantCapabilityId,
  AssistantCapabilityOutcomeMetadata,
} from './assistant-capabilities.js';
import type {
  OutcomeRecord,
  OutcomeReviewHorizon,
  OutcomeStatus,
} from './types.js';

export type FollowThroughOutcomeKind =
  | 'reviewed'
  | 'approved'
  | 'deferred'
  | 'dismissed'
  | 'handled'
  | 'explained'
  | 'blocked_unbound'
  | 'blocked_stale'
  | 'blocked_risky'
  | 'clarified';

export type FollowThroughReviewSection =
  | 'reply_related'
  | 'routine_related'
  | 'life_thread_related'
  | 'setup_suggested'
  | 'worth_watching';

export interface FollowThroughReviewItem {
  itemId: string;
  rank: number;
  section: FollowThroughReviewSection;
  title: string;
  whyItMatters: string;
  source: string;
  safeNextAction: string;
  riskFlags: string[];
  relatedNodeIds: string[];
  priorityScore: number;
  decisionScore: number;
  approvalReadiness: 'ready' | 'confirm_first' | 'watch_only';
  suggestedTiming: string;
  decisionRationale: string[];
  candidateNodeId?: string | null;
  snapshotHash: string;
}

export interface FollowThroughReviewResult {
  generatedAt: string;
  groupFolder: string;
  items: FollowThroughReviewItem[];
  reviewSeedJson: string;
}

export interface FollowThroughCommandResult {
  handled: boolean;
  replyText: string;
  review?: FollowThroughReviewResult;
  reviewSeedJson?: string;
  outcomeKind: FollowThroughOutcomeKind;
  selectedItem?: FollowThroughReviewItem;
  outcome?: OutcomeRecord;
  taskId?: string;
  agentOSEpisodeId?: string;
}

export type FollowThroughActivationCandidateSelector =
  | 'safest'
  | 'first'
  | number;

export interface FollowThroughActivationItemSummary {
  rank: number;
  title: string;
  whyItMatters: string;
  source: string;
  safeNextAction: string;
  approvalReadiness: FollowThroughReviewItem['approvalReadiness'];
  suggestedTiming: string;
  riskFlags: string[];
  decisionScore: number;
}

export interface FollowThroughActivationPreviewResult {
  kind: 'followthrough_activation_preview';
  mode: 'preview';
  readOnly: true;
  generatedAt: string;
  groupFolder: string;
  candidate: string;
  itemCount: number;
  readyCount: number;
  selectedItem: FollowThroughActivationItemSummary | null;
  approvalPhrase: string | null;
  fallbackPhrases: string[];
  blockedReason: string | null;
  reviewSeedJson: string;
  privacy: {
    metadataOnly: true;
    rawIdentifiersIncluded: false;
    rawTranscriptsIncluded: false;
    secretsRedacted: true;
    liveActionsExecuted: false;
  };
}

export interface FollowThroughActivationApplyResult {
  kind: 'followthrough_activation_apply';
  mode: 'apply';
  generatedAt: string;
  groupFolder: string;
  candidate: string;
  timing: string;
  applied: boolean;
  outcomeKind: FollowThroughOutcomeKind;
  selectedItem: FollowThroughActivationItemSummary | null;
  replyText: string;
  taskId?: string;
  outcomeId?: string;
  agentOSEpisodeId?: string;
  mutationSummary: {
    localReminderMetadata: boolean;
    outcomeRecord: boolean;
    agentOSEpisode: boolean;
    liveMessageSent: false;
    calendarWritten: false;
    credentialChanged: false;
  };
  privacy: {
    metadataOnly: true;
    rawIdentifiersIncluded: false;
    rawTranscriptsIncluded: false;
    secretsRedacted: true;
    liveActionsExecuted: false;
  };
}

interface FollowThroughReviewSeed {
  kind: 'followthrough_review';
  generatedAt: string;
  groupFolder: string;
  items: FollowThroughReviewItem[];
  privacy: {
    metadataOnly: true;
    rawIdentifiersIncluded: false;
    rawTranscriptsIncluded: false;
    secretsRedacted: true;
  };
}

interface ParsedFollowThroughCommand {
  kind:
    | 'review'
    | 'why'
    | 'approve'
    | 'remind'
    | 'defer'
    | 'dismiss'
    | 'handled';
  rank?: number;
  timing?: string | null;
  selectSafest?: boolean;
  selectCurrent?: boolean;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function clip(value: string | null | undefined, max = 180): string {
  const redacted = redactPersonalContextText(normalizeText(value));
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function genericReplyReason(flags: string[]): string {
  const isGroup = flags.includes('group_chat_confirm_audience');
  const inferred = flags.includes('assistant_inferred_link');
  const base = isGroup
    ? 'A recent group text thread appears to need follow-through.'
    : 'A recent text thread appears to need follow-through.';
  return inferred
    ? `${base} Confirm the thread or audience before tracking it.`
    : base;
}

function genericReplyTitle(flags: string[]): string {
  return flags.includes('group_chat_confirm_audience')
    ? 'Group text follow-through'
    : 'Text follow-through';
}

function hashStable(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 20);
}

function normalizeRiskFlag(flag: string): string {
  return redactPersonalContextText(flag)
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 64);
}

function sectionForNode(
  node: PersonalContextGraphNode,
): FollowThroughReviewSection {
  const source = String(node.refs?.source || '');
  if (source === 'communication_thread') return 'reply_related';
  if (source === 'life_thread') return 'life_thread_related';
  if (source === 'setup_routine') return 'routine_related';
  if (source === 'setup_reminder_suggestion') return 'setup_suggested';
  return 'worth_watching';
}

function sectionForInsight(
  insight: PersonalContextGraphInsight,
): FollowThroughReviewSection {
  if (insight.kind === 'needs_reply') return 'reply_related';
  if (insight.kind === 'slipping') return 'life_thread_related';
  if (insight.kind === 'prepare') return 'worth_watching';
  return 'worth_watching';
}

function sourceLabelForSection(section: FollowThroughReviewSection): string {
  switch (section) {
    case 'reply_related':
      return 'text/context graph';
    case 'routine_related':
      return 'guided setup routine';
    case 'life_thread_related':
      return 'life thread';
    case 'setup_suggested':
      return 'guided setup suggestion';
    case 'worth_watching':
      return 'context graph';
  }
}

function safeItemFromNode(
  node: PersonalContextGraphNode,
  rankSeed: number,
): FollowThroughReviewItem {
  const section = sectionForNode(node);
  const nodeRiskFlags =
    typeof node.refs?.riskFlags === 'string'
      ? node.refs.riskFlags.split(',').map(normalizeRiskFlag).filter(Boolean)
      : [];
  const base = {
    nodeId: node.nodeId,
    label: node.label,
    summary: node.summary,
    source: node.refs?.source,
    status: 'proposed',
    riskFlags: nodeRiskFlags,
  };
  return enrichDecisionFields({
    itemId: `followthrough:${hashStable(base)}`,
    rank: rankSeed,
    section,
    title: clip(node.label || 'Follow-through candidate', 96),
    whyItMatters: clip(
      node.summary ||
        'Andrea found this as proposed follow-through, but it is not active yet.',
      180,
    ),
    source: sourceLabelForSection(section),
    safeNextAction:
      'Approve with timing to create local reminder tracking, or dismiss it.',
    riskFlags: [
      ...new Set(['proposed_only', 'approval_required', ...nodeRiskFlags]),
    ].slice(0, 8),
    relatedNodeIds: [node.nodeId],
    priorityScore: 0.5,
    candidateNodeId: node.nodeId,
    snapshotHash: hashStable(base),
  });
}

function safeItemFromInsight(
  insight: PersonalContextGraphInsight,
  rankSeed: number,
): FollowThroughReviewItem {
  const section = sectionForInsight(insight);
  const riskFlags = insight.riskFlags.map(normalizeRiskFlag).filter(Boolean);
  const base = {
    insightId: insight.insightId,
    title: insight.title,
    reason: insight.reason,
    nextAction: insight.nextAction,
    relatedNodeIds: insight.relatedNodeIds,
    riskFlags,
    freshnessKey: insight.freshnessKey || null,
  };
  const isReplyRelated = section === 'reply_related';
  return enrichDecisionFields({
    itemId: `followthrough:${hashStable(base)}`,
    rank: rankSeed,
    section,
    title: isReplyRelated
      ? clip(insight.title || genericReplyTitle(riskFlags), 96)
      : clip(insight.title || 'Follow-through candidate', 96),
    whyItMatters: isReplyRelated
      ? genericReplyReason(riskFlags)
      : clip(insight.reason, 180),
    source: sourceLabelForSection(section),
    safeNextAction: clip(
      insight.nextAction ||
        'Approve with timing to create local reminder tracking, or dismiss it.',
      180,
    ),
    riskFlags: [
      ...new Set(['proposed_only', 'approval_required', ...riskFlags]),
    ].slice(0, 8),
    relatedNodeIds: insight.relatedNodeIds.slice(0, 6),
    priorityScore: insight.priorityScore,
    candidateNodeId:
      insight.relatedNodeIds.find((id) =>
        id.startsWith('followthrough_candidate:'),
      ) || null,
    snapshotHash: hashStable(base),
  });
}

function seedSafeItem(item: FollowThroughReviewItem): FollowThroughReviewItem {
  const riskFlags = item.riskFlags.map(normalizeRiskFlag).filter(Boolean);
  const replyRelated = item.section === 'reply_related';
  return {
    ...item,
    title: replyRelated ? genericReplyTitle(riskFlags) : clip(item.title, 96),
    whyItMatters: replyRelated
      ? genericReplyReason(riskFlags)
      : clip(item.whyItMatters, 180),
    safeNextAction: replyRelated
      ? 'Review the thread and draft only after confirming the right audience.'
      : clip(item.safeNextAction, 180),
    riskFlags,
    suggestedTiming: clip(item.suggestedTiming, 80),
    decisionRationale: item.decisionRationale
      .map((reason) => clip(reason, 80))
      .slice(0, 4),
    relatedNodeIds: item.relatedNodeIds
      .filter((id) => /^[a-z_]+:[a-f0-9]{8,}$/i.test(id))
      .slice(0, 6),
  };
}

function sectionImpact(section: FollowThroughReviewSection): number {
  switch (section) {
    case 'reply_related':
      return 0.18;
    case 'life_thread_related':
      return 0.15;
    case 'routine_related':
      return 0.08;
    case 'setup_suggested':
      return 0.06;
    case 'worth_watching':
      return 0.04;
  }
}

function suggestedTimingForItem(
  item: Pick<
    FollowThroughReviewItem,
    'section' | 'priorityScore' | 'riskFlags'
  >,
): string {
  if (item.riskFlags.includes('group_chat_confirm_audience')) {
    return 'after audience confirmation';
  }
  if (item.riskFlags.includes('assistant_inferred_link')) {
    return 'after confirming the thread';
  }
  if (item.section === 'reply_related' || item.priorityScore >= 0.75) {
    return 'tonight';
  }
  if (item.section === 'life_thread_related') return 'tomorrow morning';
  if (item.section === 'routine_related') return 'next normal routine window';
  return 'later today';
}

function approvalReadinessForItem(
  item: Pick<
    FollowThroughReviewItem,
    'riskFlags' | 'section' | 'priorityScore'
  >,
): FollowThroughReviewItem['approvalReadiness'] {
  if (
    item.riskFlags.some((flag) =>
      ['group_chat_confirm_audience', 'assistant_inferred_link'].includes(flag),
    )
  ) {
    return 'confirm_first';
  }
  if (item.priorityScore < 0.42 && item.section === 'worth_watching') {
    return 'watch_only';
  }
  return 'ready';
}

function decisionRationaleForItem(
  item: Pick<
    FollowThroughReviewItem,
    'section' | 'priorityScore' | 'riskFlags' | 'approvalReadiness'
  >,
): string[] {
  const reasons: string[] = [];
  if (item.section === 'reply_related') reasons.push('someone may be waiting');
  if (item.section === 'life_thread_related')
    reasons.push('linked life thread');
  if (item.section === 'routine_related') reasons.push('setup rhythm');
  if (item.priorityScore >= 0.75) reasons.push('high context priority');
  if (item.priorityScore >= 0.55 && item.priorityScore < 0.75) {
    reasons.push('moderate context priority');
  }
  if (item.approvalReadiness === 'confirm_first') {
    reasons.push('needs confirmation before tracking');
  } else if (item.approvalReadiness === 'watch_only') {
    reasons.push('better to watch than activate');
  } else {
    reasons.push('safe local reminder candidate');
  }
  return reasons.slice(0, 4);
}

function enrichDecisionFields(
  item: Omit<
    FollowThroughReviewItem,
    | 'decisionScore'
    | 'approvalReadiness'
    | 'suggestedTiming'
    | 'decisionRationale'
  >,
): FollowThroughReviewItem {
  const approvalReadiness = approvalReadinessForItem(item);
  const riskPenalty =
    approvalReadiness === 'confirm_first'
      ? 0.22
      : approvalReadiness === 'watch_only'
        ? 0.16
        : 0;
  const decisionScore = Math.max(
    0,
    Math.min(1, item.priorityScore + sectionImpact(item.section) - riskPenalty),
  );
  const enriched = {
    ...item,
    approvalReadiness,
    suggestedTiming: suggestedTimingForItem(item),
    decisionScore,
    decisionRationale: [] as string[],
  };
  return {
    ...enriched,
    decisionRationale: decisionRationaleForItem(enriched),
  };
}

function dedupeItems(
  items: FollowThroughReviewItem[],
): FollowThroughReviewItem[] {
  const seen = new Set<string>();
  const deduped: FollowThroughReviewItem[] = [];
  for (const item of items) {
    const key = `${item.section}:${item.title.toLowerCase()}:${item.whyItMatters.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped
    .sort((left, right) => {
      const scoreDiff = right.decisionScore - left.decisionScore;
      if (scoreDiff !== 0) return scoreDiff;
      return right.priorityScore - left.priorityScore;
    })
    .slice(0, 8)
    .map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
}

function seedFor(
  result: Omit<FollowThroughReviewResult, 'reviewSeedJson'>,
): string {
  const seed: FollowThroughReviewSeed = {
    kind: 'followthrough_review',
    generatedAt: result.generatedAt,
    groupFolder: result.groupFolder,
    items: result.items.map(seedSafeItem),
    privacy: {
      metadataOnly: true,
      rawIdentifiersIncluded: false,
      rawTranscriptsIncluded: false,
      secretsRedacted: true,
    },
  };
  return JSON.stringify(seed);
}

function parseSeedJson(
  seedJson: string | null | undefined,
): FollowThroughReviewSeed | null {
  if (!seedJson) return null;
  try {
    const parsed = JSON.parse(seedJson) as FollowThroughReviewSeed;
    if (parsed?.kind !== 'followthrough_review') return null;
    if (!Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function coerceReviewItem(
  item: FollowThroughReviewItem,
): FollowThroughReviewItem {
  if (
    typeof item.decisionScore === 'number' &&
    item.approvalReadiness &&
    item.suggestedTiming &&
    Array.isArray(item.decisionRationale)
  ) {
    return item;
  }
  return enrichDecisionFields({
    ...item,
    riskFlags: Array.isArray(item.riskFlags) ? item.riskFlags : [],
    relatedNodeIds: Array.isArray(item.relatedNodeIds)
      ? item.relatedNodeIds
      : [],
    priorityScore:
      typeof item.priorityScore === 'number' ? item.priorityScore : 0.5,
  });
}

export function buildFollowThroughReview(params: {
  groupFolder: string;
  now?: Date;
}): FollowThroughReviewResult {
  const generatedAt = (params.now || new Date()).toISOString();
  const graph = buildPersonalContextGraph({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const nodeItems = graph.nodes
    .filter((node) => node.nodeKind === 'followthrough_candidate')
    .map((node, index) => safeItemFromNode(node, index + 1));
  const insightItems = graph.rankedInsights
    .filter((insight) =>
      ['needs_reply', 'slipping', 'prepare'].includes(insight.kind),
    )
    .map((insight, index) => safeItemFromInsight(insight, index + 1));
  const items = dedupeItems([...insightItems, ...nodeItems]);
  const base = {
    generatedAt,
    groupFolder: params.groupFolder,
    items,
  };
  return {
    ...base,
    reviewSeedJson: seedFor(base),
  };
}

function sectionTitle(section: FollowThroughReviewSection): string {
  switch (section) {
    case 'reply_related':
      return 'Needs reply';
    case 'routine_related':
      return 'Routines';
    case 'life_thread_related':
      return 'Life threads';
    case 'setup_suggested':
      return 'Setup suggestions';
    case 'worth_watching':
      return 'Worth watching';
  }
}

function bestFirstApproval(
  items: FollowThroughReviewItem[],
): FollowThroughReviewItem | null {
  return (
    items.find((item) => item.approvalReadiness === 'ready') ||
    items.find((item) => item.approvalReadiness === 'confirm_first') ||
    items[0] ||
    null
  );
}

export function formatFollowThroughReview(
  result: FollowThroughReviewResult,
): string {
  if (result.items.length === 0) {
    return [
      'Follow-through candidates',
      '',
      'Nothing needs approval right now. Andrea has no proposed reminders or slipping context to activate.',
    ].join('\n');
  }

  const sections: FollowThroughReviewSection[] = [
    'reply_related',
    'life_thread_related',
    'routine_related',
    'setup_suggested',
    'worth_watching',
  ];
  const lines = ['Follow-through candidates'];
  const best = bestFirstApproval(result.items);
  if (best) {
    const command =
      best.approvalReadiness === 'ready'
        ? `remind me about #${best.rank} ${best.suggestedTiming}`
        : `why #${best.rank}`;
    lines.push(
      '',
      `Safest first approval: #${best.rank} ${best.title}`,
      `Why: ${best.decisionRationale.join(', ')}.`,
      `Suggested timing: ${best.suggestedTiming}.`,
      `Readiness: ${best.approvalReadiness.replace(/_/g, ' ')}. Try: \`${command}\`.`,
    );
  }
  for (const section of sections) {
    const items = result.items.filter((item) => item.section === section);
    if (items.length === 0) continue;
    lines.push('', sectionTitle(section));
    for (const item of items) {
      const flags = item.riskFlags.length
        ? ` Flags: ${item.riskFlags.join(', ')}.`
        : '';
      lines.push(
        `${item.rank}. ${item.title} - ${item.whyItMatters} Next: ${item.safeNextAction} Timing: ${item.suggestedTiming}. Readiness: ${item.approvalReadiness.replace(/_/g, ' ')}.${flags}`,
      );
    }
  }
  lines.push(
    '',
    'You can say: approve #1, remind me about #2 tonight, defer #3, dismiss #4, why #1, or mark #1 handled.',
  );
  return lines.join('\n');
}

function parseRank(value: string): number | undefined {
  const match = value.match(/(?:#|number\s*|item\s*)?(\d{1,2})/i);
  if (!match) return undefined;
  const rank = Number.parseInt(match[1]!, 10);
  return Number.isFinite(rank) && rank > 0 ? rank : undefined;
}

function parseCommand(text: string): ParsedFollowThroughCommand {
  const normalized = normalizeText(text).toLowerCase();
  const rank = parseRank(normalized);
  const safeApproval = normalized.match(
    /^approve\s+(?:the\s+)?(?:(?:first\s+)?safe(?:st)?)(?:\s+one)?(?:\s+(.+))?$/i,
  );
  if (safeApproval) {
    const timing = normalizeText(safeApproval[1] || '');
    return timing
      ? { kind: 'remind', timing, selectSafest: true }
      : { kind: 'approve', selectSafest: true };
  }
  if (
    /^(?:why|explain)\s+(?:it|this|this one|that|that one)$/i.test(normalized)
  ) {
    return { kind: 'why', selectCurrent: true };
  }
  if (
    /^(?:why|explain)\b/.test(normalized) ||
    /\bwhy\b.*(?:#|number|item)\s*\d+/i.test(normalized)
  ) {
    return { kind: 'why', rank };
  }
  if (
    /^(?:defer|snooze)\s+(?:it|this|this one|that|that one)$/i.test(normalized)
  ) {
    return { kind: 'defer', selectCurrent: true };
  }
  if (/^(?:defer|snooze)\b/.test(normalized)) {
    return { kind: 'defer', rank };
  }
  if (
    /^(?:dismiss|skip|ignore)\s+(?:it|this|this one|that|that one)$/i.test(
      normalized,
    )
  ) {
    return { kind: 'dismiss', selectCurrent: true };
  }
  if (/^(?:dismiss|skip|ignore)\b/.test(normalized)) {
    return { kind: 'dismiss', rank };
  }
  if (
    /^mark\s+(?:it|this|this one|that|that one)\s+(?:as\s*)?(?:handled|done|resolved)\b/i.test(
      normalized,
    )
  ) {
    return { kind: 'handled', selectCurrent: true };
  }
  if (/^(?:mark\s*)?(?:handled|done|resolved)$/i.test(normalized)) {
    return { kind: 'handled', selectCurrent: true };
  }
  if (
    /^(?:mark\s*)?(?:(?:#|number|item)\s*)?\d+\s*(?:as\s*)?(?:handled|done|resolved)\b/i.test(
      normalized,
    ) ||
    /^(?:handled|done|resolved)\b/.test(normalized)
  ) {
    return { kind: 'handled', rank };
  }
  if (/^approve\b/.test(normalized)) {
    return { kind: 'approve', rank };
  }
  if (/^remind me\b/.test(normalized)) {
    const timing = normalized
      .replace(
        /^remind me(?:\s+(?:about|to track|to remember|on|for))?\s*/i,
        '',
      )
      .replace(/^(?:#|number\s*|item\s*)?\d+\s*/i, '')
      .trim();
    return { kind: 'remind', rank, timing: timing || null };
  }
  if (
    /^what follow-through should i approve\b/.test(normalized) ||
    /^show proposed reminders\b/.test(normalized) ||
    /^what should andrea track\b/.test(normalized) ||
    /^what is slipping\b/.test(normalized) ||
    /^what's slipping\b/.test(normalized)
  ) {
    return { kind: 'review' };
  }
  return { kind: 'review' };
}

function normalizeTimingForReminder(
  timing: string | null | undefined,
): string | null {
  const value = normalizeText(timing).toLowerCase();
  if (!value) return null;
  if (value === 'tonight') return 'tonight';
  if (value === 'this evening') return 'today evening';
  if (value === 'this afternoon') return 'today afternoon';
  if (value === 'this morning') return 'today morning';
  if (
    /^(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(morning|afternoon|evening|tonight)$/i.test(
      value,
    )
  ) {
    return value;
  }
  if (
    /^(?:later\s+)?(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(
      value,
    )
  ) {
    return value;
  }
  if (
    /^(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.test(
      value,
    )
  ) {
    return value;
  }
  return null;
}

function itemByRank(
  items: FollowThroughReviewItem[],
  rank: number | undefined,
): FollowThroughReviewItem | null {
  if (!rank) return null;
  return items.find((item) => item.rank === rank) || null;
}

function safestApprovalItem(
  items: FollowThroughReviewItem[],
): FollowThroughReviewItem | null {
  return (
    items.find(
      (item) =>
        item.approvalReadiness === 'ready' &&
        !item.riskFlags.includes('assistant_inferred_link') &&
        !item.riskFlags.includes('group_chat_confirm_audience'),
    ) ||
    items.find((item) => item.approvalReadiness === 'ready') ||
    null
  );
}

function riskSeverity(flags: string[]): number {
  let score = 0;
  if (flags.includes('assistant_inferred_link')) score += 2;
  if (flags.includes('group_chat_confirm_audience')) score += 3;
  if (flags.includes('sensitive_context')) score += 2;
  return score;
}

function validateFreshSelection(params: {
  groupFolder: string;
  item: FollowThroughReviewItem;
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  const fresh = buildFollowThroughReview({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const current =
    fresh.items.find((item) => item.itemId === params.item.itemId) ||
    fresh.items.find(
      (item) =>
        item.candidateNodeId &&
        item.candidateNodeId === params.item.candidateNodeId,
    );
  if (!current) {
    return {
      ok: false,
      reason:
        'That follow-through item is no longer in the current context graph.',
    };
  }
  if (current.snapshotHash !== params.item.snapshotHash) {
    return {
      ok: false,
      reason:
        'That follow-through item changed since the review, so I need you to review it again.',
    };
  }
  if (riskSeverity(current.riskFlags) > riskSeverity(params.item.riskFlags)) {
    return {
      ok: false,
      reason:
        'That follow-through item now has stricter risk flags, so I need you to confirm it again.',
    };
  }
  return { ok: true };
}

function itemRequiresAudienceConfirmation(
  item: FollowThroughReviewItem,
): boolean {
  return item.riskFlags.some((flag) =>
    ['group_chat_confirm_audience', 'assistant_inferred_link'].includes(flag),
  );
}

function reminderBodyFor(item: FollowThroughReviewItem): string {
  const title = item.title.replace(/^remind me about\s+/i, '').trim();
  const body = title || item.whyItMatters || 'this follow-through item';
  return /^[A-Z]/.test(body)
    ? `${body[0]!.toLowerCase()}${body.slice(1)}`
    : body;
}

function reviewFromSeedOrFresh(params: {
  groupFolder: string;
  seedJson?: string | null;
  now?: Date;
}): FollowThroughReviewResult {
  const seed = parseSeedJson(params.seedJson);
  if (seed?.groupFolder === params.groupFolder) {
    const base = {
      generatedAt: seed.generatedAt,
      groupFolder: seed.groupFolder,
      items: seed.items.map(coerceReviewItem),
    };
    return {
      ...base,
      reviewSeedJson: seedFor(base),
    };
  }
  return buildFollowThroughReview({
    groupFolder: params.groupFolder,
    now: params.now,
  });
}

function recordEpisode(params: {
  groupFolder: string;
  channel: 'telegram' | 'bluebubbles' | 'alexa';
  item: FollowThroughReviewItem;
  actionKind: FollowThroughOutcomeKind;
}): string {
  const episodeId = `agentos:episode:followthrough:${hashStable({
    groupFolder: params.groupFolder,
    itemId: params.item.itemId,
    actionKind: params.actionKind,
  })}`;
  const result = beginAgentOSEpisode({
    episodeId,
    turnId: `followthrough-${params.actionKind}-${params.item.itemId}`,
    channel: params.channel,
    groupFolder: params.groupFolder,
    taskFamily: 'communication',
    goal: `Follow-through candidate: ${params.item.title}`,
    requestRoute: 'followthrough.activation',
    selectedSkillId: 'followthrough.activation',
    selectedSkillPurpose:
      'Review and approval-stage a local follow-through candidate.',
    selectedSkillApprovalNeed:
      params.actionKind === 'explained'
        ? 'none'
        : 'explicit approval/timing required before mutation',
    selectedSkillSideEffectRisk:
      'local reminder/outcome metadata only; no sends or calendar writes',
    selectedSkillEvidenceLevel: 'context_graph_candidate',
    thinkingPreference: 'normal',
    thinkingTrigger: 'followthrough-candidate',
  });
  return result.episode.episodeId;
}

function recordFollowThroughOutcome(params: {
  groupFolder: string;
  item: FollowThroughReviewItem;
  status: OutcomeStatus;
  summary: string;
  nextFollowupText?: string | null;
  blockerText?: string | null;
  dueAt?: string | null;
  reviewHorizon?: OutcomeReviewHorizon;
  userConfirmed?: boolean;
  showInDailyReview?: boolean;
  agentOSEpisodeId?: string;
  reminderTaskId?: string;
  now?: Date;
}): OutcomeRecord {
  return upsertOutcomeRecord({
    groupFolder: params.groupFolder,
    sourceType: 'followthrough_candidate',
    sourceKey: params.item.itemId,
    status: params.status,
    completionSummary: params.summary,
    nextFollowupText: params.nextFollowupText ?? null,
    blockerText: params.blockerText ?? null,
    dueAt: params.dueAt ?? null,
    reviewHorizon: params.reviewHorizon || 'today',
    linkedRefs: {
      followthroughCandidateId: params.item.itemId,
      agentOSEpisodeId: params.agentOSEpisodeId,
      reminderTaskId: params.reminderTaskId,
    },
    userConfirmed: params.userConfirmed ?? true,
    showInDailyReview: params.showInDailyReview ?? true,
    showInWeeklyReview: true,
    now: params.now,
  });
}

function recordBlockedFollowThroughOutcome(params: {
  groupFolder: string;
  item: FollowThroughReviewItem;
  blockerText: string;
  outcomeKind: FollowThroughOutcomeKind;
  agentOSEpisodeId?: string;
  now?: Date;
}): OutcomeRecord {
  return recordFollowThroughOutcome({
    groupFolder: params.groupFolder,
    item: params.item,
    status: 'failed',
    summary: `Blocked follow-through candidate #${params.item.rank}: ${params.outcomeKind}.`,
    blockerText: params.blockerText,
    reviewHorizon: 'today',
    userConfirmed: false,
    showInDailyReview: true,
    agentOSEpisodeId: params.agentOSEpisodeId,
    now: params.now,
  });
}

function oneQuestionForUnbound(): string {
  return 'Which follow-through item did you mean? Use the number from the list, like `approve #1` or `why #2`.';
}

export async function handleFollowThroughActivationCommand(params: {
  groupFolder: string;
  channel: 'telegram' | 'bluebubbles' | 'alexa';
  chatJid?: string | null;
  text?: string | null;
  now?: Date;
  priorReviewJson?: string | null;
  metadataOnly?: boolean;
}): Promise<FollowThroughCommandResult> {
  const command = parseCommand(params.text || '');
  const review = reviewFromSeedOrFresh({
    groupFolder: params.groupFolder,
    seedJson: params.priorReviewJson,
    now: params.now,
  });

  if (command.kind === 'review') {
    return {
      handled: true,
      replyText: formatFollowThroughReview(review),
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'reviewed',
    };
  }

  const item = command.selectSafest
    ? safestApprovalItem(review.items)
    : command.selectCurrent
      ? bestFirstApproval(review.items)
      : itemByRank(review.items, command.rank);
  if (!item) {
    return {
      handled: true,
      replyText: command.selectSafest
        ? 'I do not see a safe follow-through candidate ready to approve. Say `show proposed reminders` to review the current list.'
        : oneQuestionForUnbound(),
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'blocked_unbound',
    };
  }

  if (command.kind === 'why') {
    const episodeId = recordEpisode({
      groupFolder: params.groupFolder,
      channel: params.channel,
      item,
      actionKind: 'explained',
    });
    return {
      handled: true,
      replyText: [
        `#${item.rank}: ${item.title}`,
        `Why it matters: ${item.whyItMatters}`,
        `Source: ${item.source}.`,
        `Safe next action: ${item.safeNextAction}`,
        item.riskFlags.length
          ? `Risk flags: ${item.riskFlags.join(', ')}.`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'explained',
      selectedItem: item,
      agentOSEpisodeId: episodeId,
    };
  }

  if (
    itemRequiresAudienceConfirmation(item) &&
    ['approve', 'remind'].includes(command.kind)
  ) {
    const episodeId = recordEpisode({
      groupFolder: params.groupFolder,
      channel: params.channel,
      item,
      actionKind: 'blocked_risky',
    });
    const outcome = recordBlockedFollowThroughOutcome({
      groupFolder: params.groupFolder,
      item,
      blockerText:
        'Needs explicit audience or thread confirmation before local tracking.',
      outcomeKind: 'blocked_risky',
      agentOSEpisodeId: episodeId,
      now: params.now,
    });
    return {
      handled: true,
      replyText: `Quick check before I track #${item.rank}: confirm the exact audience or thread, because this item was inferred or may involve a group chat.`,
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'blocked_risky',
      selectedItem: item,
      outcome,
      agentOSEpisodeId: episodeId,
    };
  }

  if (command.kind === 'approve') {
    const episodeId = recordEpisode({
      groupFolder: params.groupFolder,
      channel: params.channel,
      item,
      actionKind: 'clarified',
    });
    return {
      handled: true,
      replyText: `What timing should I use for #${item.rank}? Try \`remind me about #${item.rank} tonight\` or \`remind me about #${item.rank} tomorrow morning\`.`,
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'clarified',
      selectedItem: item,
      agentOSEpisodeId: episodeId,
    };
  }

  if (command.kind === 'remind') {
    const freshness = validateFreshSelection({
      groupFolder: params.groupFolder,
      item,
      now: params.now,
    });
    if (!freshness.ok) {
      const episodeId = recordEpisode({
        groupFolder: params.groupFolder,
        channel: params.channel,
        item,
        actionKind: 'blocked_stale',
      });
      const outcome = recordBlockedFollowThroughOutcome({
        groupFolder: params.groupFolder,
        item,
        blockerText: freshness.reason,
        outcomeKind: 'blocked_stale',
        agentOSEpisodeId: episodeId,
        now: params.now,
      });
      return {
        handled: true,
        replyText: `${freshness.reason} Say \`show proposed reminders\` to get a fresh numbered list.`,
        review,
        reviewSeedJson: review.reviewSeedJson,
        outcomeKind: 'blocked_stale',
        selectedItem: item,
        outcome,
        agentOSEpisodeId: episodeId,
      };
    }
    const timing = normalizeTimingForReminder(command.timing);
    if (!timing) {
      return {
        handled: true,
        replyText: `What timing should I use for #${item.rank}? Try \`tonight\`, \`tomorrow morning\`, or \`Friday at 4pm\`.`,
        review,
        reviewSeedJson: review.reviewSeedJson,
        outcomeKind: 'clarified',
        selectedItem: item,
      };
    }
    if (!params.chatJid) {
      return {
        handled: true,
        replyText:
          'I can approval-stage that once this chat has a reminder destination.',
        review,
        reviewSeedJson: review.reviewSeedJson,
        outcomeKind: 'blocked_unbound',
        selectedItem: item,
      };
    }
    const planned = planContextualReminder(
      timing,
      reminderBodyFor(item),
      params.groupFolder,
      params.chatJid,
      params.now,
    );
    if (!planned) {
      return {
        handled: true,
        replyText: `I could not parse that timing yet. Try \`remind me about #${item.rank} tomorrow morning\` or \`remind me about #${item.rank} Friday at 4pm\`.`,
        review,
        reviewSeedJson: review.reviewSeedJson,
        outcomeKind: 'clarified',
        selectedItem: item,
      };
    }
    const task = params.metadataOnly
      ? {
          ...planned.task,
          status: 'paused' as const,
          prompt: `Approval-gated follow-through metadata: ${planned.task.prompt}`,
        }
      : planned.task;
    createTask(task);
    const episodeId = recordEpisode({
      groupFolder: params.groupFolder,
      channel: params.channel,
      item,
      actionKind: 'approved',
    });
    const outcome = recordFollowThroughOutcome({
      groupFolder: params.groupFolder,
      item,
      status: 'deferred',
      summary: params.metadataOnly
        ? `Staged approval-gated local follow-through metadata for #${item.rank}.`
        : `Approved local follow-through reminder for #${item.rank}.`,
      nextFollowupText: params.metadataOnly
        ? `Paused local reminder metadata for #${item.rank}; explicit activation is required before delivery. ${planned.confirmation}`
        : planned.confirmation,
      dueAt: task.next_run,
      reviewHorizon: 'today',
      agentOSEpisodeId: episodeId,
      reminderTaskId: task.id,
      now: params.now,
    });
    return {
      handled: true,
      replyText: params.metadataOnly
        ? [
            `I staged #${item.rank} as approval-gated local follow-through metadata.`,
            `Timing target: ${planned.confirmation.replace(/^Okay\.\s*/i, '')}`,
            'It is paused until explicitly activated. No message was sent and no calendar was changed.',
          ].join('\n')
        : `${planned.confirmation}\n\nI recorded this as local follow-through tracking only. No message was sent and no calendar was changed.`,
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'approved',
      selectedItem: item,
      outcome,
      taskId: task.id,
      agentOSEpisodeId: episodeId,
    };
  }

  const freshness = validateFreshSelection({
    groupFolder: params.groupFolder,
    item,
    now: params.now,
  });
  if (!freshness.ok) {
    const episodeId = recordEpisode({
      groupFolder: params.groupFolder,
      channel: params.channel,
      item,
      actionKind: 'blocked_stale',
    });
    const outcome = recordBlockedFollowThroughOutcome({
      groupFolder: params.groupFolder,
      item,
      blockerText: freshness.reason,
      outcomeKind: 'blocked_stale',
      agentOSEpisodeId: episodeId,
      now: params.now,
    });
    return {
      handled: true,
      replyText: `${freshness.reason} Say \`show proposed reminders\` to get a fresh numbered list.`,
      review,
      reviewSeedJson: review.reviewSeedJson,
      outcomeKind: 'blocked_stale',
      selectedItem: item,
      outcome,
      agentOSEpisodeId: episodeId,
    };
  }

  const episodeId = recordEpisode({
    groupFolder: params.groupFolder,
    channel: params.channel,
    item,
    actionKind:
      command.kind === 'defer'
        ? 'deferred'
        : command.kind === 'dismiss'
          ? 'dismissed'
          : 'handled',
  });
  const outcomeKind =
    command.kind === 'defer'
      ? 'deferred'
      : command.kind === 'dismiss'
        ? 'dismissed'
        : 'handled';
  const outcome = recordFollowThroughOutcome({
    groupFolder: params.groupFolder,
    item,
    status:
      command.kind === 'defer'
        ? 'deferred'
        : command.kind === 'dismiss'
          ? 'skipped'
          : 'completed',
    summary:
      command.kind === 'defer'
        ? `Deferred follow-through candidate #${item.rank}.`
        : command.kind === 'dismiss'
          ? `Dismissed follow-through candidate #${item.rank}.`
          : `Marked follow-through candidate #${item.rank} handled.`,
    nextFollowupText:
      command.kind === 'defer'
        ? 'Bring this back in a later follow-through review.'
        : null,
    reviewHorizon: command.kind === 'defer' ? 'tomorrow' : 'none',
    showInDailyReview: command.kind !== 'dismiss',
    agentOSEpisodeId: episodeId,
    now: params.now,
  });
  return {
    handled: true,
    replyText:
      command.kind === 'defer'
        ? `Deferred #${item.rank}. I will keep it visible for a later follow-through review.`
        : command.kind === 'dismiss'
          ? `Dismissed #${item.rank}. I will not treat it as active follow-through.`
          : `Marked #${item.rank} handled. I recorded the outcome locally.`,
    review,
    reviewSeedJson: review.reviewSeedJson,
    outcomeKind,
    selectedItem: item,
    outcome,
    agentOSEpisodeId: episodeId,
  };
}

export function buildFollowThroughOutcomeMetadata(params: {
  outcomeKind: FollowThroughOutcomeKind;
  handled: boolean;
  capabilityId: AssistantCapabilityId;
  item?: FollowThroughReviewItem;
  taskId?: string;
  agentOSEpisodeId?: string;
}): AssistantCapabilityOutcomeMetadata {
  return {
    source: 'followthrough_activation',
    outcomeKind: params.outcomeKind,
    handled: params.handled,
    capabilityId: params.capabilityId,
    itemId: params.item?.itemId,
    itemRank: params.item?.rank,
    taskId: params.taskId,
    agentOSEpisodeId: params.agentOSEpisodeId,
  };
}

function candidateLabel(
  candidate: FollowThroughActivationCandidateSelector,
): string {
  return typeof candidate === 'number' ? `#${candidate}` : candidate;
}

function summarizeActivationItem(
  item: FollowThroughReviewItem | null,
): FollowThroughActivationItemSummary | null {
  if (!item) return null;
  return {
    rank: item.rank,
    title: clip(item.title, 120),
    whyItMatters: clip(item.whyItMatters, 160),
    source: clip(item.source, 80),
    safeNextAction: clip(item.safeNextAction, 160),
    approvalReadiness: item.approvalReadiness,
    suggestedTiming: item.suggestedTiming,
    riskFlags: item.riskFlags,
    decisionScore: Number(item.decisionScore.toFixed(3)),
  };
}

function selectActivationItem(
  items: FollowThroughReviewItem[],
  candidate: FollowThroughActivationCandidateSelector,
): FollowThroughReviewItem | null {
  if (typeof candidate === 'number') return itemByRank(items, candidate);
  if (candidate === 'first') return bestFirstApproval(items);
  return safestApprovalItem(items) || bestFirstApproval(items);
}

function activationApprovalPhrase(
  item: FollowThroughReviewItem | null,
  candidate: FollowThroughActivationCandidateSelector,
  timing?: string | null,
): string | null {
  if (!item) return null;
  if (item.approvalReadiness !== 'ready') return `why #${item.rank}`;
  const when = normalizeText(timing || item.suggestedTiming || 'tonight');
  if (candidate === 'safest') return `approve the safest one ${when}`;
  return `remind me about #${item.rank} ${when}`;
}

export function buildFollowThroughActivationPreview(params: {
  groupFolder: string;
  candidate?: FollowThroughActivationCandidateSelector;
  timing?: string | null;
  now?: Date;
}): FollowThroughActivationPreviewResult {
  const candidate = params.candidate ?? 'safest';
  const review = buildFollowThroughReview({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const selected = selectActivationItem(review.items, candidate);
  const selectedSummary = summarizeActivationItem(selected);
  const blockedReason = selected
    ? selected.approvalReadiness === 'confirm_first'
      ? 'Confirm the exact audience or thread before local tracking.'
      : selected.approvalReadiness === 'watch_only'
        ? 'This item is better to watch than activate right now.'
        : null
    : 'No follow-through candidate is available.';

  return {
    kind: 'followthrough_activation_preview',
    mode: 'preview',
    readOnly: true,
    generatedAt: review.generatedAt,
    groupFolder: params.groupFolder,
    candidate: candidateLabel(candidate),
    itemCount: review.items.length,
    readyCount: review.items.filter(
      (item) => item.approvalReadiness === 'ready',
    ).length,
    selectedItem: selectedSummary,
    approvalPhrase: activationApprovalPhrase(
      selected,
      candidate,
      params.timing,
    ),
    fallbackPhrases: selected ? ['why this one', 'defer it'] : [],
    blockedReason,
    reviewSeedJson: review.reviewSeedJson,
    privacy: {
      metadataOnly: true,
      rawIdentifiersIncluded: false,
      rawTranscriptsIncluded: false,
      secretsRedacted: true,
      liveActionsExecuted: false,
    },
  };
}

export async function applyFollowThroughActivation(params: {
  groupFolder: string;
  candidate?: FollowThroughActivationCandidateSelector;
  timing: string;
  channel?: 'telegram' | 'bluebubbles' | 'alexa';
  chatJid?: string | null;
  now?: Date;
  metadataOnly?: boolean;
}): Promise<FollowThroughActivationApplyResult> {
  const candidate = params.candidate ?? 'safest';
  const preview = buildFollowThroughActivationPreview({
    groupFolder: params.groupFolder,
    candidate,
    timing: params.timing,
    now: params.now,
  });
  const selectedRank = preview.selectedItem?.rank;
  if (!selectedRank) {
    return {
      kind: 'followthrough_activation_apply',
      mode: 'apply',
      generatedAt: preview.generatedAt,
      groupFolder: params.groupFolder,
      candidate: candidateLabel(candidate),
      timing: params.timing,
      applied: false,
      outcomeKind: 'blocked_unbound',
      selectedItem: null,
      replyText:
        'No follow-through candidate is available. Run the preview again after Andrea has current context.',
      mutationSummary: {
        localReminderMetadata: false,
        outcomeRecord: false,
        agentOSEpisode: false,
        liveMessageSent: false,
        calendarWritten: false,
        credentialChanged: false,
      },
      privacy: {
        metadataOnly: true,
        rawIdentifiersIncluded: false,
        rawTranscriptsIncluded: false,
        secretsRedacted: true,
        liveActionsExecuted: false,
      },
    };
  }

  const result = await handleFollowThroughActivationCommand({
    groupFolder: params.groupFolder,
    channel: params.channel || 'telegram',
    chatJid: params.chatJid ?? `local:followthrough:${params.groupFolder}`,
    text: `remind me about #${selectedRank} ${params.timing}`,
    now: params.now,
    priorReviewJson: preview.reviewSeedJson,
    metadataOnly: params.metadataOnly ?? true,
  });

  return {
    kind: 'followthrough_activation_apply',
    mode: 'apply',
    generatedAt: preview.generatedAt,
    groupFolder: params.groupFolder,
    candidate: candidateLabel(candidate),
    timing: params.timing,
    applied: result.outcomeKind === 'approved',
    outcomeKind: result.outcomeKind,
    selectedItem: summarizeActivationItem(result.selectedItem || null),
    replyText: clip(result.replyText, 800),
    taskId: result.taskId,
    outcomeId: result.outcome?.outcomeId,
    agentOSEpisodeId: result.agentOSEpisodeId,
    mutationSummary: {
      localReminderMetadata: Boolean(result.taskId),
      outcomeRecord: Boolean(result.outcome),
      agentOSEpisode: Boolean(result.agentOSEpisodeId),
      liveMessageSent: false,
      calendarWritten: false,
      credentialChanged: false,
    },
    privacy: {
      metadataOnly: true,
      rawIdentifiersIncluded: false,
      rawTranscriptsIncluded: false,
      secretsRedacted: true,
      liveActionsExecuted: false,
    },
  };
}
