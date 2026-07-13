import crypto from 'crypto';

import { isBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import {
  getActiveOperatingProfile,
  getAllChats,
  getOutcomeBySource,
  getTasksForGroup,
  listOutcomesForGroup,
  listCommunicationIdentityReviewsForGroup,
  listCommunicationThreadsForGroup,
  listEverydayListGroups,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  listProfileSubjectsForGroup,
} from './db.js';
import type {
  CommunicationThreadRecord,
  EverydayListGroup,
  LifeThread,
  OperatingProfile,
  OperatingProfilePlan,
  OutcomeRecord,
  ProfileFactWithSubject,
  ProfileSubject,
  ScheduledTask,
} from './types.js';

export type PersonalContextNodeKind =
  | 'operating_profile'
  | 'person'
  | 'memory_fact'
  | 'life_thread'
  | 'communication_thread'
  | 'reminder'
  | 'followthrough_candidate'
  | 'list_group';

export interface PersonalContextGraphNode {
  nodeId: string;
  nodeKind: PersonalContextNodeKind;
  label: string;
  status?: string | null;
  updatedAt?: string | null;
  summary?: string | null;
  refs?: Record<string, string | number | boolean | null>;
}

export interface PersonalContextGraphEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeKind:
    | 'profile_tracks'
    | 'fact_about'
    | 'thread_about'
    | 'message_about'
    | 'reminder_about'
    | 'list_supports'
    | 'life_thread_supports';
  confidence: number;
  reason: string;
}

export interface PersonalContextGraphCoverage {
  activeProfile: boolean;
  people: number;
  memoryFacts: number;
  lifeThreads: number;
  communicationThreads: number;
  reminders: number;
  followthroughCandidates: number;
  listGroups: number;
  linkedCommunicationThreads: number;
  identityReviewedCommunicationThreads: number;
  resolvedCommunicationThreads: number;
  linkedLifeThreads: number;
}

export type PersonalContextGraphInsightKind =
  | 'needs_reply'
  | 'slipping'
  | 'prepare'
  | 'can_wait'
  | 'setup_gap'
  | 'memory_gap';

export interface PersonalContextGraphInsight {
  insightId: string;
  kind: PersonalContextGraphInsightKind;
  title: string;
  priorityScore: number;
  reason: string;
  nextAction: string;
  relatedNodeIds: string[];
  riskFlags: string[];
  freshnessKey?: string | null;
}

export interface PersonalContextGraphReport {
  generatedAt: string;
  groupFolder: string;
  nodes: PersonalContextGraphNode[];
  edges: PersonalContextGraphEdge[];
  coverage: PersonalContextGraphCoverage;
  rankedInsights: PersonalContextGraphInsight[];
  readinessScore: number;
  topGaps: string[];
  dailyIntelligenceQuestions: string[];
  privacy: {
    metadataOnly: true;
    rawPrivateBodiesStored: false;
    rawIdentifiersReturned: false;
    secretsRedacted: true;
  };
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function clip(value: string | null | undefined, max = 160): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function redactPersonalContextText(value: string): string {
  return clip(value, 260)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
    .replace(/\bbb:[^\s"']+/gi, '[chat]')
    .replace(/\b(?:iMessage|SMS);[^\s"']+/gi, '[chat]')
    .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]');
}

function graphId(kind: PersonalContextNodeKind, rawId: string): string {
  return `${kind}:${crypto
    .createHash('sha256')
    .update(`${kind}|${rawId}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function addNode(
  nodes: Map<string, PersonalContextGraphNode>,
  node: PersonalContextGraphNode,
): void {
  if (!nodes.has(node.nodeId)) nodes.set(node.nodeId, node);
}

function addEdge(
  edges: PersonalContextGraphEdge[],
  edge: PersonalContextGraphEdge,
): void {
  if (
    edges.some(
      (existing) =>
        existing.fromNodeId === edge.fromNodeId &&
        existing.toNodeId === edge.toNodeId &&
        existing.edgeKind === edge.edgeKind,
    )
  ) {
    return;
  }
  edges.push(edge);
}

function communicationThreadIsGroup(
  thread: CommunicationThreadRecord,
): boolean {
  return Boolean(
    thread.channelChatJid && /;chat|group/i.test(thread.channelChatJid),
  );
}

function communicationThreadHasUsefulTitle(
  thread: CommunicationThreadRecord,
): boolean {
  const title = normalizeText(thread.title);
  return Boolean(
    title &&
    !/^(?:messages? chat|messages? thread|communication (?:thread|follow-up)|text thread|recent (?:messages?|texts?))$/i.test(
      title,
    ),
  );
}

function communicationThreadSummary(thread: CommunicationThreadRecord): string {
  const medium =
    thread.channel === 'bluebubbles'
      ? communicationThreadIsGroup(thread)
        ? 'group text thread'
        : 'text thread'
      : 'communication thread';
  if (thread.followupState === 'reply_needed') {
    return `A recent ${medium} appears to need a reply or follow-through.`;
  }
  if (thread.followupState === 'scheduled') {
    return `A recent ${medium} already has follow-through scheduled.`;
  }
  if (thread.followupState === 'waiting_on_them') {
    return `A recent ${medium} is waiting on the other person.`;
  }
  return `A recent ${medium} is available as context.`;
}

function communicationThreadNextAction(
  thread: CommunicationThreadRecord,
): string {
  if (thread.followupState === 'waiting_on_them') {
    return 'Let it wait unless new inbound activity arrives.';
  }
  if (thread.suggestedNextAction === 'create_reminder') {
    return 'Create an approval-gated reminder or save it for later.';
  }
  if (
    thread.suggestedNextAction === 'draft_reply' ||
    thread.suggestedNextAction === 'reply_now'
  ) {
    return 'Review recent context and prepare a draft; do not send without approval.';
  }
  if (thread.suggestedNextAction === 'save_for_later') {
    return 'Keep this queued for later; when ready, ask Andrea to draft without sending.';
  }
  if (thread.suggestedNextAction === 'link_thread') {
    return 'Confirm the identity and audience before drafting or taking action.';
  }
  if (thread.suggestedNextAction === 'ignore') {
    return 'Leave it alone unless new activity changes the situation.';
  }
  if (thread.followupState === 'reply_needed') {
    return 'Review recent context and prepare a draft; do not send without approval.';
  }
  if (thread.followupState === 'scheduled') {
    return 'Keep the scheduled follow-through visible; do not duplicate it.';
  }
  return 'Review the thread before taking any action.';
}

function communicationThreadFreshnessKey(
  thread: CommunicationThreadRecord,
): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        thread.updatedAt,
        thread.lastContactAt,
        thread.lastMessageId || '',
        thread.followupState,
        thread.urgency,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 20);
}

function planFromProfile(
  profile: OperatingProfile | null,
): OperatingProfilePlan {
  if (!profile) {
    return {
      summary: 'No active operating profile.',
      trackedAreas: [],
      defaultGroups: [],
      routines: [],
      reminderSuggestions: [],
      richerSurface: 'telegram',
      desiredIntegrations: [],
      learningPolicy: 'suggest_then_confirm',
    };
  }
  return safeJsonParse<OperatingProfilePlan>(profile.planJson, {
    summary: 'Andrea is tracking everyday follow-through.',
    trackedAreas: [],
    defaultGroups: [],
    routines: [],
    reminderSuggestions: [],
    richerSurface: 'telegram',
    desiredIntegrations: [],
    learningPolicy: 'suggest_then_confirm',
  });
}

function addProfileNode(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  profile: OperatingProfile | null;
  plan: OperatingProfilePlan;
}): string | null {
  if (!params.profile) return null;
  const id = graphId('operating_profile', params.profile.profileId);
  addNode(params.nodes, {
    nodeId: id,
    nodeKind: 'operating_profile',
    label: 'Active Andrea setup',
    status: params.profile.status,
    updatedAt: params.profile.updatedAt,
    summary: redactPersonalContextText(params.plan.summary),
    refs: {
      trackedAreas: params.plan.trackedAreas.length,
      defaultGroups: params.plan.defaultGroups.length,
      routines: params.plan.routines.length,
    },
  });
  return id;
}

function addSubjectNodes(
  nodes: Map<string, PersonalContextGraphNode>,
  subjects: ProfileSubject[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const subject of subjects) {
    const id = graphId('person', subject.id);
    map.set(subject.id, id);
    addNode(nodes, {
      nodeId: id,
      nodeKind: 'person',
      label:
        subject.kind === 'self'
          ? 'You'
          : subject.kind === 'household'
            ? 'Household'
            : redactPersonalContextText(subject.displayName),
      status: subject.disabledAt ? 'disabled' : 'active',
      updatedAt: subject.updatedAt,
      refs: { kind: subject.kind },
    });
  }
  return map;
}

function addFactNodes(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  edges: PersonalContextGraphEdge[];
  facts: ProfileFactWithSubject[];
  subjectNodeIds: Map<string, string>;
}): void {
  for (const fact of params.facts) {
    const id = graphId('memory_fact', fact.id);
    const parsed = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
    const value =
      parsed && typeof parsed === 'object' && 'value' in parsed
        ? (parsed as { value?: unknown }).value
        : parsed;
    addNode(params.nodes, {
      nodeId: id,
      nodeKind: 'memory_fact',
      label: redactPersonalContextText(fact.factKey),
      status: fact.state,
      updatedAt: fact.updatedAt,
      summary: redactPersonalContextText(JSON.stringify(value)),
      refs: {
        category: fact.category,
        subjectKind: fact.subjectKind,
      },
    });
    const subjectNodeId = params.subjectNodeIds.get(fact.subjectId);
    if (subjectNodeId) {
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: subjectNodeId,
        edgeKind: 'fact_about',
        confidence: fact.state === 'accepted' ? 0.86 : 0.5,
        reason: 'Profile fact is scoped to this subject.',
      });
    }
  }
}

function addLifeThreadNodes(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  edges: PersonalContextGraphEdge[];
  lifeThreads: LifeThread[];
  subjectNodeIds: Map<string, string>;
}): Map<string, string> {
  const map = new Map<string, string>();
  for (const thread of params.lifeThreads) {
    const id = graphId('life_thread', thread.id);
    map.set(thread.id, id);
    addNode(params.nodes, {
      nodeId: id,
      nodeKind: 'life_thread',
      label: redactPersonalContextText(thread.title),
      status: thread.status,
      updatedAt: thread.lastUpdatedAt,
      summary: redactPersonalContextText(thread.summary),
      refs: {
        category: thread.category,
        scope: thread.scope,
        followthroughMode: thread.followthroughMode,
      },
    });
    for (const subjectId of thread.relatedSubjectIds) {
      const subjectNodeId = params.subjectNodeIds.get(subjectId);
      if (!subjectNodeId) continue;
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: subjectNodeId,
        edgeKind: 'thread_about',
        confidence: thread.confidenceKind === 'explicit' ? 0.9 : 0.65,
        reason: 'Life thread declares this related subject.',
      });
    }
  }
  return map;
}

function addCommunicationNodes(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  edges: PersonalContextGraphEdge[];
  communicationThreads: CommunicationThreadRecord[];
  subjectNodeIds: Map<string, string>;
  lifeThreadNodeIds: Map<string, string>;
  confirmedIdentityLinks: Set<string>;
}): void {
  for (const thread of params.communicationThreads) {
    const id = graphId('communication_thread', thread.id);
    addNode(params.nodes, {
      nodeId: id,
      nodeKind: 'communication_thread',
      label: redactPersonalContextText(thread.title || 'Messages thread'),
      status: thread.followupState,
      updatedAt: thread.updatedAt,
      summary: communicationThreadSummary(thread),
      refs: {
        channel: thread.channel,
        urgency: thread.urgency,
        trackingMode: thread.trackingMode,
        groupChat: communicationThreadIsGroup(thread),
      },
    });
    for (const subjectId of thread.linkedSubjectIds) {
      const subjectNodeId = params.subjectNodeIds.get(subjectId);
      if (!subjectNodeId) continue;
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: subjectNodeId,
        edgeKind: 'message_about',
        confidence:
          thread.inferenceState === 'user_confirmed' ||
          params.confirmedIdentityLinks.has(`${thread.id}|${subjectId}`)
            ? 0.86
            : 0.58,
        reason: params.confirmedIdentityLinks.has(`${thread.id}|${subjectId}`)
          ? 'Owner explicitly confirmed this communication identity link.'
          : 'Communication thread is linked to this subject.',
      });
    }
    for (const lifeThreadId of thread.linkedLifeThreadIds) {
      const lifeThreadNodeId = params.lifeThreadNodeIds.get(lifeThreadId);
      if (!lifeThreadNodeId) continue;
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: lifeThreadNodeId,
        edgeKind: 'life_thread_supports',
        confidence: 0.72,
        reason: 'Communication thread references this life thread.',
      });
    }
  }
}

function addReminderNodes(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  edges: PersonalContextGraphEdge[];
  tasks: ScheduledTask[];
  profileNodeId: string | null;
}): void {
  for (const task of params.tasks) {
    const id = graphId('reminder', task.id);
    addNode(params.nodes, {
      nodeId: id,
      nodeKind: 'reminder',
      label: redactPersonalContextText(task.prompt),
      status: task.status,
      updatedAt: task.next_run || task.created_at,
      // Legacy script bodies are inert execution data, not personal context.
      // Never promote them into prompts, summaries, or memory surfaces.
      summary: redactPersonalContextText(task.last_result || ''),
      refs: {
        scheduleType: task.schedule_type,
        hasNextRun: Boolean(task.next_run),
      },
    });
    if (params.profileNodeId) {
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: params.profileNodeId,
        edgeKind: 'reminder_about',
        confidence: 0.5,
        reason: 'Reminder belongs to this assistant group.',
      });
    }
  }
}

interface FollowthroughCandidate {
  id: string;
  title: string;
  summary: string;
  source:
    | 'setup_routine'
    | 'setup_reminder_suggestion'
    | 'life_thread'
    | 'communication_thread';
  priorityScore: number;
  relatedNodeId?: string | null;
  riskFlags: string[];
}

function buildFollowthroughCandidates(params: {
  plan: OperatingProfilePlan;
  lifeThreads: LifeThread[];
  communicationThreads: CommunicationThreadRecord[];
}): FollowthroughCandidate[] {
  const candidates: FollowthroughCandidate[] = [];
  const add = (candidate: FollowthroughCandidate): void => {
    const normalizedTitle = normalizeText(candidate.title).toLowerCase();
    if (!normalizedTitle) return;
    if (
      candidates.some(
        (existing) =>
          normalizeText(existing.title).toLowerCase() === normalizedTitle,
      )
    ) {
      return;
    }
    candidates.push({
      ...candidate,
      title: redactPersonalContextText(candidate.title),
      summary: redactPersonalContextText(candidate.summary),
      riskFlags: candidate.riskFlags
        .map((flag) => redactPersonalContextText(flag))
        .filter(Boolean)
        .slice(0, 6),
    });
  };

  for (const routine of params.plan.routines.slice(0, 4)) {
    const label = normalizeText(routine);
    add({
      id: `routine:${label}`,
      title: label,
      summary:
        'Setup says this rhythm matters, but no active reminder is scheduled yet.',
      source: 'setup_routine',
      priorityScore: 0.44,
      riskFlags: ['proposed_only', 'approval_required'],
    });
  }
  for (const suggestion of params.plan.reminderSuggestions.slice(0, 4)) {
    const label = normalizeText(suggestion);
    add({
      id: `suggestion:${label}`,
      title: label,
      summary:
        'Setup generated this as a possible follow-through reminder; it is not scheduled.',
      source: 'setup_reminder_suggestion',
      priorityScore: 0.48,
      riskFlags: ['proposed_only', 'approval_required'],
    });
  }
  for (const thread of params.lifeThreads.slice(0, 8)) {
    if (thread.status !== 'active') continue;
    if (thread.followthroughMode === 'manual_only') continue;
    const nextAction = normalizeText(thread.nextAction || thread.summary);
    if (!nextAction) continue;
    add({
      id: `life:${thread.id}`,
      title: `Follow through on ${thread.title}`,
      summary: nextAction,
      source: 'life_thread',
      priorityScore: thread.followthroughMode === 'important_only' ? 0.58 : 0.5,
      relatedNodeId: graphId('life_thread', thread.id),
      riskFlags: [
        'proposed_only',
        'approval_required',
        thread.sensitivity === 'sensitive' ? 'sensitive_context' : '',
      ].filter(Boolean),
    });
  }
  for (const thread of params.communicationThreads.slice(0, 12)) {
    if (thread.followupState !== 'reply_needed') continue;
    if (thread.suggestedNextAction !== 'create_reminder') continue;
    add({
      id: `communication:${thread.id}`,
      title: `Remind me about ${thread.title || 'this conversation'}`,
      summary: communicationThreadSummary(thread),
      source: 'communication_thread',
      priorityScore:
        thread.urgency === 'overdue' || thread.urgency === 'tonight'
          ? 0.66
          : 0.52,
      relatedNodeId: graphId('communication_thread', thread.id),
      riskFlags: [
        'proposed_only',
        'approval_required',
        communicationThreadIsGroup(thread) ? 'group_chat_confirm_audience' : '',
        thread.inferenceState !== 'user_confirmed'
          ? 'assistant_inferred_link'
          : '',
      ].filter(Boolean),
    });
  }

  return candidates
    .sort((left, right) => right.priorityScore - left.priorityScore)
    .slice(0, 8);
}

function addFollowthroughCandidateNodes(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  edges: PersonalContextGraphEdge[];
  candidates: FollowthroughCandidate[];
  profileNodeId: string | null;
  groupFolder: string;
}): void {
  for (const candidate of params.candidates) {
    const id = graphId('followthrough_candidate', candidate.id);
    const reviewItemId = followthroughReviewItemIdForNode({
      nodeId: id,
      label: candidate.title,
      summary: candidate.summary,
      source: candidate.source,
      status: 'proposed',
    });
    const outcome = getOutcomeBySource(
      params.groupFolder,
      'followthrough_candidate',
      reviewItemId,
    );
    const status = followthroughGraphStatus(outcome);
    addNode(params.nodes, {
      nodeId: id,
      nodeKind: 'followthrough_candidate',
      label: candidate.title,
      status,
      updatedAt: outcome?.updatedAt || null,
      summary: candidate.summary,
      refs: {
        source: candidate.source,
        approvalRequired: true,
        outcomeStatus: outcome?.status || null,
        outcomeKind: status,
        hasReminder: Boolean(parseOutcomeLinkedRefs(outcome).reminderTaskId),
        riskFlags: candidate.riskFlags.join(','),
      },
    });
    if (params.profileNodeId) {
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: params.profileNodeId,
        edgeKind: 'reminder_about',
        confidence: 0.46,
        reason:
          'Follow-through candidate comes from setup, memory, or text review context and still needs approval.',
      });
    }
    if (candidate.relatedNodeId) {
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: candidate.relatedNodeId,
        edgeKind: 'reminder_about',
        confidence: 0.58,
        reason: 'Follow-through candidate is tied to this context node.',
      });
    }
  }
}

function followthroughReviewItemIdForNode(params: {
  nodeId: string;
  label: string;
  summary?: string | null;
  source?: unknown;
  status?: string | null;
}): string {
  const base = {
    nodeId: params.nodeId,
    label: params.label,
    summary: params.summary,
    source: params.source,
    status: params.status,
  };
  return `followthrough:${crypto
    .createHash('sha256')
    .update(JSON.stringify(base))
    .digest('hex')
    .slice(0, 20)}`;
}

function parseOutcomeLinkedRefs(
  outcome: OutcomeRecord | undefined,
): Record<string, unknown> {
  if (!outcome?.linkedRefsJson) return {};
  try {
    const parsed = JSON.parse(outcome.linkedRefsJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function followthroughGraphStatus(
  outcome: OutcomeRecord | undefined,
):
  | 'proposed'
  | 'approved'
  | 'deferred'
  | 'handled'
  | 'dismissed'
  | 'blocked_unbound'
  | 'blocked_stale'
  | 'blocked_risky' {
  if (!outcome) return 'proposed';
  const text = `${outcome.completionSummary || ''} ${outcome.blockerText || ''}`;
  if (outcome.status === 'completed') return 'handled';
  if (outcome.status === 'skipped') return 'dismissed';
  if (outcome.status === 'failed') {
    if (/stale|changed|no longer/i.test(text)) return 'blocked_stale';
    if (/audience|thread|group|inferred/i.test(text)) return 'blocked_risky';
    return 'blocked_unbound';
  }
  if (outcome.status === 'deferred') {
    return parseOutcomeLinkedRefs(outcome).reminderTaskId
      ? 'approved'
      : 'deferred';
  }
  return 'proposed';
}

function addListGroupNodes(params: {
  nodes: Map<string, PersonalContextGraphNode>;
  edges: PersonalContextGraphEdge[];
  groups: EverydayListGroup[];
  profileNodeId: string | null;
}): void {
  for (const group of params.groups) {
    const id = graphId('list_group', group.groupId);
    addNode(params.nodes, {
      nodeId: id,
      nodeKind: 'list_group',
      label: redactPersonalContextText(group.title),
      status: group.archivedAt ? 'archived' : 'active',
      updatedAt: group.updatedAt,
      summary: redactPersonalContextText(group.sourceSummary || ''),
      refs: {
        kind: group.kind,
        scope: group.scope,
      },
    });
    if (params.profileNodeId) {
      addEdge(params.edges, {
        fromNodeId: id,
        toNodeId: params.profileNodeId,
        edgeKind: 'list_supports',
        confidence: 0.7,
        reason: 'List group is part of the active assistant setup.',
      });
    }
  }
}

function scoreCoverage(coverage: PersonalContextGraphCoverage): number {
  const communicationLinkRatio =
    coverage.communicationThreads > 0
      ? Math.min(
          coverage.resolvedCommunicationThreads / coverage.communicationThreads,
          1,
        )
      : 0;
  const lifeThreadLinkRatio =
    coverage.lifeThreads > 0
      ? Math.min(coverage.linkedLifeThreads / coverage.lifeThreads, 1)
      : 0;
  const followthroughScore =
    coverage.reminders > 0
      ? Math.min(coverage.reminders / 3, 1)
      : Math.min(coverage.followthroughCandidates / 3, 1) * 0.5;
  const parts = [
    coverage.activeProfile ? 0.12 : 0,
    Math.min(coverage.people / 5, 1) * 0.1,
    Math.min(coverage.memoryFacts / 8, 1) * 0.18,
    Math.min(coverage.lifeThreads / 3, 1) * 0.12,
    Math.min(coverage.communicationThreads / 5, 1) * 0.1,
    followthroughScore * 0.1,
    Math.min(coverage.listGroups / 5, 1) * 0.05,
    communicationLinkRatio * 0.13,
    lifeThreadLinkRatio * 0.1,
  ];
  return Number(
    Math.min(
      1,
      parts.reduce((sum, part) => sum + part, 0),
    ).toFixed(3),
  );
}

function buildGaps(coverage: PersonalContextGraphCoverage): string[] {
  const gaps: string[] = [];
  if (!coverage.activeProfile)
    gaps.push('Run guided setup to create an active operating profile.');
  if (coverage.memoryFacts < 4)
    gaps.push(
      'Accept a few core memory facts so Andrea can explain what it knows.',
    );
  if (coverage.people < 2)
    gaps.push('Add the important people or groups Andrea should understand.');
  if (coverage.lifeThreads < 1)
    gaps.push(
      'Create at least one life thread for an outcome Andrea should track.',
    );
  const communicationLinkRatio =
    coverage.communicationThreads > 0
      ? coverage.resolvedCommunicationThreads / coverage.communicationThreads
      : 1;
  const unlinked = Math.max(
    0,
    coverage.communicationThreads - coverage.resolvedCommunicationThreads,
  );
  if (
    coverage.communicationThreads > 0 &&
    unlinked > 0 &&
    communicationLinkRatio < 1
  ) {
    gaps.push(
      `Confirm or dismiss identity links for ${unlinked} recent communication thread${unlinked === 1 ? '' : 's'} before trusting relationship-aware reply recommendations; use \`review communication identities\` and do not infer identities from phone numbers or generic language.`,
    );
  }
  if (coverage.reminders === 0) {
    gaps.push(
      coverage.followthroughCandidates > 0
        ? 'Approve one proposed follow-through reminder when you want Andrea to actively track it.'
        : 'Add or verify reminders if follow-through is part of the assistant role.',
    );
  }
  return gaps.slice(0, 5);
}

function insightId(
  kind: PersonalContextGraphInsightKind,
  rawId: string,
): string {
  return `context_graph:insight:${kind}:${crypto
    .createHash('sha256')
    .update(`${kind}|${rawId}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function addInsight(
  insights: PersonalContextGraphInsight[],
  insight: PersonalContextGraphInsight,
): void {
  if (insights.some((existing) => existing.insightId === insight.insightId)) {
    return;
  }
  insights.push({
    ...insight,
    title: redactPersonalContextText(insight.title),
    reason: redactPersonalContextText(insight.reason),
    nextAction: redactPersonalContextText(insight.nextAction),
    priorityScore: Number(
      Math.max(0, Math.min(1, insight.priorityScore)).toFixed(3),
    ),
    freshnessKey: insight.freshnessKey
      ? redactPersonalContextText(insight.freshnessKey)
      : null,
    riskFlags: insight.riskFlags
      .map((flag) => redactPersonalContextText(flag))
      .filter(Boolean)
      .slice(0, 6),
  });
}

function buildGraphInsights(params: {
  activeProfile: OperatingProfile | null;
  coverage: PersonalContextGraphCoverage;
  resolvedCommunicationThreadIds: Set<string>;
  suppressedCommunicationThreadIds: Set<string>;
  facts: ProfileFactWithSubject[];
  lifeThreads: LifeThread[];
  communicationThreads: CommunicationThreadRecord[];
  tasks: ScheduledTask[];
  followthroughCandidates: FollowthroughCandidate[];
  followthroughOutcomes: OutcomeRecord[];
}): PersonalContextGraphInsight[] {
  const insights: PersonalContextGraphInsight[] = [];
  const displayThreadDetail = (thread: LifeThread): string => {
    const rawSummary =
      normalizeText(thread.nextAction || thread.summary || thread.title) ||
      'Follow-up';
    const summary = rawSummary
      .replace(
        /^(?:the first fixed point in your day is|the next grounded thing is|the clearest next anchor is|the next thing that still needs attention is|the thing most likely to slip is|one carryover to keep in sight is|the thing worth closing tonight is|the thing still most likely to slip tonight is)\s+/i,
        '',
      )
      .trim();
    const detail = /^[a-z]/.test(summary)
      ? `${summary[0]!.toUpperCase()}${summary.slice(1)}`
      : summary;
    return detail;
  };
  const displayThreadTitle = (thread: LifeThread): string => {
    const detail = displayThreadDetail(thread);
    const title = normalizeText(thread.title);
    return /^(?:follow[- ]?up|thread|carryover|open loops?)$/i.test(title)
      ? detail
      : title;
  };
  if (!params.activeProfile) {
    addInsight(insights, {
      insightId: insightId(
        'setup_gap',
        params.coverage.activeProfile ? 'setup-active' : 'setup-missing',
      ),
      kind: 'setup_gap',
      title: 'Finish Andrea setup',
      priorityScore: 0.92,
      reason:
        'Setup is the first durable source for memory, daily priorities, and text-review context.',
      nextAction:
        'Say `finish my Andrea setup` or run the local setup dogfood preview.',
      relatedNodeIds: [],
      riskFlags: ['local_only', 'no_live_send'],
    });
  }
  if (params.facts.length < 4) {
    addInsight(insights, {
      insightId: insightId('memory_gap', `facts:${params.facts.length}`),
      kind: 'memory_gap',
      title: 'Accept core memory facts',
      priorityScore: params.facts.length === 0 ? 0.86 : 0.64,
      reason:
        'Daily guidance is weak until Andrea has a few accepted, explainable memories.',
      nextAction:
        'Ask `what did you learn about me?` and accept, reject, or edit proposed memory updates.',
      relatedNodeIds: [],
      riskFlags: ['sensitive_facts_remain_proposed'],
    });
  }
  const unresolvedCommunicationThreads = params.communicationThreads.filter(
    (thread) =>
      !params.resolvedCommunicationThreadIds.has(thread.id) &&
      !params.suppressedCommunicationThreadIds.has(thread.id),
  );
  if (unresolvedCommunicationThreads.length > 0) {
    addInsight(insights, {
      insightId: insightId(
        'setup_gap',
        `communication-identities:${unresolvedCommunicationThreads.length}`,
      ),
      kind: 'setup_gap',
      title: 'Review communication identities',
      priorityScore: 0.84,
      reason: `${unresolvedCommunicationThreads.length} recent conversation${unresolvedCommunicationThreads.length === 1 ? ' is' : 's are'} not yet linked to a person or explicitly dismissed.`,
      nextAction:
        'Use `review communication identities`; confirm or dismiss each thread without guessing from identifiers or message text.',
      relatedNodeIds: unresolvedCommunicationThreads
        .slice(0, 2)
        .map((thread) => graphId('communication_thread', thread.id)),
      riskFlags: [
        'identity_review_required',
        'no_identity_inference',
        'owner_confirmation_required',
      ],
    });
  }
  const communicationInsightPriority = (
    thread: CommunicationThreadRecord,
    identityResolved: boolean,
  ): number => {
    const baseScore = identityResolved
      ? thread.followupState === 'reply_needed'
        ? 0.74
        : 0.58
      : thread.followupState === 'reply_needed'
        ? 0.42
        : 0.34;
    const urgencyBoost =
      thread.urgency === 'overdue' || thread.urgency === 'tonight'
        ? 0.16
        : thread.urgency === 'soon' || thread.urgency === 'tomorrow'
          ? 0.08
          : 0;
    return baseScore + urgencyBoost;
  };
  const actionableCommunicationThreads = params.communicationThreads.filter(
    (thread) =>
      !params.suppressedCommunicationThreadIds.has(thread.id) &&
      communicationThreadHasUsefulTitle(thread) &&
      (thread.followupState === 'reply_needed' ||
        thread.followupState === 'scheduled'),
  );
  const resolvedCommunicationInsights = actionableCommunicationThreads
    .filter((thread) => params.resolvedCommunicationThreadIds.has(thread.id))
    .sort(
      (left, right) =>
        communicationInsightPriority(right, true) -
          communicationInsightPriority(left, true) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 18);
  const unresolvedCommunicationInsights = actionableCommunicationThreads
    .filter((thread) => !params.resolvedCommunicationThreadIds.has(thread.id))
    .sort(
      (left, right) =>
        communicationInsightPriority(right, false) -
          communicationInsightPriority(left, false) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 2);
  for (const thread of [
    ...resolvedCommunicationInsights,
    ...unresolvedCommunicationInsights,
  ]) {
    const identityResolved = params.resolvedCommunicationThreadIds.has(
      thread.id,
    );
    addInsight(insights, {
      insightId: insightId('needs_reply', thread.id),
      kind: 'needs_reply',
      title: thread.title || 'Messages follow-up',
      priorityScore: communicationInsightPriority(thread, identityResolved),
      reason: communicationThreadSummary(thread),
      nextAction: identityResolved
        ? communicationThreadNextAction(thread)
        : 'Review the identity and audience before drafting; do not infer who this is.',
      relatedNodeIds: [graphId('communication_thread', thread.id)],
      freshnessKey: communicationThreadFreshnessKey(thread),
      riskFlags: [
        communicationThreadIsGroup(thread)
          ? 'group_chat_confirm_audience'
          : null,
        !identityResolved ? 'identity_unresolved' : null,
        thread.inferenceState !== 'user_confirmed'
          ? 'assistant_inferred_link'
          : null,
      ].filter(Boolean) as string[],
    });
  }
  for (const thread of params.lifeThreads.slice(0, 20)) {
    if (thread.status !== 'active') continue;
    if (thread.followthroughMode === 'manual_only') continue;
    const detail = displayThreadDetail(thread);
    const hasNextAction = Boolean(
      normalizeText(thread.nextAction || thread.summary),
    );
    addInsight(insights, {
      insightId: insightId('slipping', thread.id),
      kind: 'slipping',
      title: displayThreadTitle(thread),
      priorityScore:
        thread.followthroughMode === 'important_only'
          ? 0.68
          : thread.followthroughMode === 'scheduled'
            ? 0.6
            : 0.48,
      reason:
        detail ||
        'Active life thread is available for daily follow-through ranking.',
      nextAction: hasNextAction
        ? detail || 'Keep this in view during the daily plan.'
        : 'Ask what the next visible step should be.',
      relatedNodeIds: [graphId('life_thread', thread.id)],
      riskFlags: [
        thread.sensitivity === 'sensitive' ? 'sensitive_context' : null,
        thread.relatedSubjectIds.length === 0 ? 'unlinked_life_thread' : null,
      ].filter(Boolean) as string[],
    });
  }
  for (const task of params.tasks.slice(0, 10)) {
    if (task.status !== 'active') continue;
    addInsight(insights, {
      insightId: insightId('prepare', task.id),
      kind: 'prepare',
      title: task.prompt,
      priorityScore: task.next_run ? 0.56 : 0.42,
      reason: task.next_run
        ? 'A local reminder has an upcoming run time.'
        : 'A local reminder is active without a clear next run.',
      nextAction:
        'Use this as prep context; do not pretend the reminder fired.',
      relatedNodeIds: [graphId('reminder', task.id)],
      riskFlags: [],
    });
  }
  for (const outcome of params.followthroughOutcomes.slice(0, 8)) {
    const status = followthroughGraphStatus(outcome);
    const linkedRefs = parseOutcomeLinkedRefs(outcome);
    const hasReminder = Boolean(linkedRefs.reminderTaskId);
    const isActive = [
      'approved',
      'deferred',
      'blocked_stale',
      'blocked_risky',
    ].includes(status);
    if (!isActive) continue;
    addInsight(insights, {
      insightId: insightId('prepare', `outcome:${outcome.outcomeId}`),
      kind: status.startsWith('blocked') ? 'slipping' : 'prepare',
      title:
        status === 'approved'
          ? 'Approved follow-through'
          : status === 'deferred'
            ? 'Deferred follow-through'
            : 'Blocked follow-through',
      priorityScore:
        status === 'approved' ? 0.78 : status === 'deferred' ? 0.7 : 0.66,
      reason:
        outcome.blockerText ||
        outcome.nextFollowupText ||
        outcome.completionSummary ||
        'Follow-through outcome needs review.',
      nextAction: hasReminder
        ? 'Keep this local reminder visible in daily planning.'
        : status.startsWith('blocked')
          ? 'Review the blocker before trying to track it again.'
          : 'Decide whether to approve, defer, dismiss, or mark handled.',
      relatedNodeIds: [],
      riskFlags: [
        `followthrough_${status}`,
        status.startsWith('blocked') ? 'needs_user_clarification' : '',
      ].filter(Boolean),
    });
  }
  for (const candidate of params.followthroughCandidates.slice(0, 6)) {
    addInsight(insights, {
      insightId: insightId('prepare', `candidate:${candidate.id}`),
      kind: 'prepare',
      title: candidate.title,
      priorityScore: candidate.priorityScore,
      reason: candidate.summary,
      nextAction:
        'Ask to turn this into a reminder when you want Andrea to actively track it.',
      relatedNodeIds: [
        graphId('followthrough_candidate', candidate.id),
        candidate.relatedNodeId || '',
      ].filter(Boolean),
      riskFlags: candidate.riskFlags,
    });
  }
  const waitingThreads = params.communicationThreads.filter(
    (thread) =>
      thread.followupState === 'waiting_on_them' &&
      !params.suppressedCommunicationThreadIds.has(thread.id) &&
      communicationThreadHasUsefulTitle(thread),
  );
  for (const thread of waitingThreads.slice(0, 4)) {
    addInsight(insights, {
      insightId: insightId('can_wait', thread.id),
      kind: 'can_wait',
      title: thread.title || 'Waiting conversation',
      priorityScore: 0.24,
      reason: communicationThreadSummary(thread),
      nextAction: communicationThreadNextAction(thread),
      relatedNodeIds: [graphId('communication_thread', thread.id)],
      freshnessKey: communicationThreadFreshnessKey(thread),
      riskFlags: ['waiting_on_them'],
    });
  }
  return insights
    .sort((left, right) => right.priorityScore - left.priorityScore)
    .slice(0, 12);
}

export function buildPersonalContextGraph(params: {
  groupFolder: string;
  now?: Date;
}): PersonalContextGraphReport {
  const generatedAt = (params.now || new Date()).toISOString();
  const nodes = new Map<string, PersonalContextGraphNode>();
  const edges: PersonalContextGraphEdge[] = [];
  const activeProfile = getActiveOperatingProfile(params.groupFolder) || null;
  const plan = planFromProfile(activeProfile);
  const profileNodeId = addProfileNode({ nodes, profile: activeProfile, plan });
  const subjects = listProfileSubjectsForGroup(params.groupFolder);
  const facts = listProfileFactsForGroup(params.groupFolder, ['accepted']);
  const lifeThreads = listLifeThreadsForGroup(params.groupFolder, [
    'active',
    'paused',
  ]);
  const communicationThreads = listCommunicationThreadsForGroup({
    groupFolder: params.groupFolder,
    limit: 80,
  });
  const identityReviews = listCommunicationIdentityReviewsForGroup(
    params.groupFolder,
  );
  const activeCommunicationThreadIds = new Set(
    communicationThreads.map((thread) => thread.id),
  );
  const identityReviewedThreadIds = new Set(
    identityReviews
      .filter((review) => activeCommunicationThreadIds.has(review.threadId))
      .map((review) => review.threadId),
  );
  const knownGroupChatJids = new Set(
    getAllChats()
      .filter((chat) => chat.is_group === 1)
      .map((chat) => chat.jid),
  );
  const groupCommunicationThreadIds = new Set(
    communicationThreads
      .filter((thread) =>
        Boolean(
          thread.channelChatJid &&
          (knownGroupChatJids.has(thread.channelChatJid) ||
            communicationThreadIsGroup(thread)),
        ),
      )
      .map((thread) => thread.id),
  );
  const selfCommunicationThreadIds = new Set(
    communicationThreads
      .filter(
        (thread) =>
          thread.channelChatJid &&
          isBlueBubblesSelfThreadAliasJid(thread.channelChatJid),
      )
      .map((thread) => thread.id),
  );
  const confirmedIdentityLinks = new Set(
    identityReviews
      .filter(
        (review) =>
          activeCommunicationThreadIds.has(review.threadId) &&
          review.decision === 'confirmed' &&
          review.linkedSubjectId,
      )
      .map((review) => `${review.threadId}|${review.linkedSubjectId}`),
  );
  const tasks = getTasksForGroup(params.groupFolder).filter(
    (task) => task.status !== 'completed',
  );
  const followthroughOutcomes = listOutcomesForGroup({
    groupFolder: params.groupFolder,
    sourceTypes: ['followthrough_candidate'],
    includeSuppressed: true,
    limit: 80,
    now: generatedAt,
  });
  const followthroughCandidates = buildFollowthroughCandidates({
    plan,
    lifeThreads,
    communicationThreads,
  });
  const groups = listEverydayListGroups(params.groupFolder).filter(
    (group) => !group.archivedAt,
  );

  const subjectNodeIds = addSubjectNodes(nodes, subjects);
  addFactNodes({ nodes, edges, facts, subjectNodeIds });
  const lifeThreadNodeIds = addLifeThreadNodes({
    nodes,
    edges,
    lifeThreads,
    subjectNodeIds,
  });
  addCommunicationNodes({
    nodes,
    edges,
    communicationThreads,
    subjectNodeIds,
    lifeThreadNodeIds,
    confirmedIdentityLinks,
  });
  addReminderNodes({ nodes, edges, tasks, profileNodeId });
  addFollowthroughCandidateNodes({
    nodes,
    edges,
    candidates: followthroughCandidates,
    profileNodeId,
    groupFolder: params.groupFolder,
  });
  addListGroupNodes({ nodes, edges, groups, profileNodeId });

  if (profileNodeId) {
    for (const fact of facts.filter((fact) =>
      fact.factKey.startsWith('setup.'),
    )) {
      addEdge(edges, {
        fromNodeId: graphId('memory_fact', fact.id),
        toNodeId: profileNodeId,
        edgeKind: 'profile_tracks',
        confidence: 0.78,
        reason: 'Setup memory was accepted as part of the operating profile.',
      });
    }
  }

  const linkedCommunicationThreadIds = new Set(
    communicationThreads
      .filter(
        (thread) =>
          thread.linkedSubjectIds.length > 0 ||
          thread.linkedLifeThreadIds.length > 0,
      )
      .map((thread) => thread.id),
  );
  const identityLinkedCommunicationThreadIds = new Set(
    communicationThreads
      .filter((thread) => thread.linkedSubjectIds.length > 0)
      .map((thread) => thread.id),
  );
  const resolvedCommunicationThreadIds = new Set([
    ...identityLinkedCommunicationThreadIds,
    ...identityReviewedThreadIds,
    ...groupCommunicationThreadIds,
    ...selfCommunicationThreadIds,
  ]);
  const coverage: PersonalContextGraphCoverage = {
    activeProfile: Boolean(activeProfile),
    people: subjects.filter((subject) => subject.kind === 'person').length,
    memoryFacts: facts.length,
    lifeThreads: lifeThreads.length,
    communicationThreads: communicationThreads.length,
    reminders: tasks.length,
    followthroughCandidates: followthroughCandidates.length,
    listGroups: groups.length,
    linkedCommunicationThreads: linkedCommunicationThreadIds.size,
    identityReviewedCommunicationThreads: identityReviewedThreadIds.size,
    resolvedCommunicationThreads: resolvedCommunicationThreadIds.size,
    linkedLifeThreads: lifeThreads.filter(
      (thread) => thread.relatedSubjectIds.length > 0,
    ).length,
  };
  const rankedInsights = buildGraphInsights({
    activeProfile,
    coverage,
    resolvedCommunicationThreadIds,
    suppressedCommunicationThreadIds: selfCommunicationThreadIds,
    facts,
    lifeThreads,
    communicationThreads,
    tasks,
    followthroughCandidates,
    followthroughOutcomes,
  });

  return {
    generatedAt,
    groupFolder: params.groupFolder,
    nodes: [...nodes.values()],
    edges,
    coverage,
    rankedInsights,
    readinessScore: scoreCoverage(coverage),
    topGaps: buildGaps(coverage),
    dailyIntelligenceQuestions: [
      'What matters today?',
      'Who needs a reply?',
      'What is slipping?',
      'What should Andrea prepare?',
      'What can safely wait?',
    ],
    privacy: {
      metadataOnly: true,
      rawPrivateBodiesStored: false,
      rawIdentifiersReturned: false,
      secretsRedacted: true,
    },
  };
}

export function formatPersonalContextGraphSummary(
  report: PersonalContextGraphReport,
): string {
  const topInsight = report.rankedInsights[0] || null;
  return [
    `Personal context graph readiness: ${Math.round(report.readinessScore * 100)}%`,
    `Coverage: ${report.coverage.people} people, ${report.coverage.memoryFacts} memory facts, ${report.coverage.lifeThreads} life threads, ${report.coverage.communicationThreads} communication threads, ${report.coverage.reminders} active reminders, ${report.coverage.followthroughCandidates} proposed follow-throughs.`,
    topInsight
      ? `Top daily insight: ${topInsight.title} (${topInsight.kind}) - ${topInsight.nextAction}`
      : null,
    report.topGaps.length
      ? `Next gap: ${report.topGaps[0]}`
      : 'Next gap: keep refreshing real-world proof and outcome reviews.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatPersonalContextGraphHealth(
  report: PersonalContextGraphReport,
): string {
  const topPeople = report.nodes
    .filter((node) => node.nodeKind === 'person')
    .slice(0, 5)
    .map((node) => node.label);
  const topLifeThreads = report.nodes
    .filter((node) => node.nodeKind === 'life_thread')
    .slice(0, 5)
    .map((node) => node.label);
  const unlinkedConversations =
    report.coverage.communicationThreads -
    report.coverage.resolvedCommunicationThreads;
  return [
    'Personal Context Graph Health',
    '',
    `Readiness: ${Math.round(report.readinessScore * 100)}%`,
    `Coverage: ${report.coverage.people} people, ${report.coverage.memoryFacts} memory facts, ${report.coverage.lifeThreads} life threads, ${report.coverage.communicationThreads} conversations, ${report.coverage.followthroughCandidates} proposed follow-throughs.`,
    `Top linked people: ${topPeople.length ? topPeople.join(', ') : 'none yet'}.`,
    `Top life threads: ${topLifeThreads.length ? topLifeThreads.join(', ') : 'none yet'}.`,
    `Stale or unlinked conversations: ${Math.max(0, unlinkedConversations)}.`,
    `Privacy posture: metadata-only, raw identifiers returned: ${report.privacy.rawIdentifiersReturned ? 'yes' : 'no'}.`,
    report.rankedInsights.length
      ? 'Ranked daily insights:'
      : 'Ranked daily insights: none yet.',
    ...report.rankedInsights
      .slice(0, 5)
      .map(
        (insight, index) =>
          `${index + 1}. ${insight.title} - ${insight.nextAction} (${Math.round(
            insight.priorityScore * 100,
          )}%)`,
      ),
    `Next graph repair: ${
      report.topGaps[0] ||
      report.rankedInsights.find((insight) => insight.riskFlags.length > 0)
        ?.nextAction ||
      'Keep accepting real memory updates and verifying outcomes.'
    }`,
  ].join('\n');
}
