import {
  createTask,
  getActionBundleSnapshot,
  getCommunicationThread,
  getCompanionHandoff,
  getLifeThread,
  getMessageAction,
  getMission,
  getOutcome,
  getOutcomeBySource,
  getTaskById,
  getTasksForGroup,
  listActionBundlesForGroup,
  listCommunicationThreadsForGroup,
  listCompanionHandoffsForGroup,
  listLifeThreadsForGroup,
  listMessageActionsForGroup,
  listMissionSteps,
  listMissionsForGroup,
  listOutcomesForGroup,
  replaceMissionSteps,
  updateCommunicationThread,
  updateLifeThread,
  updateMessageAction,
  updateMission,
  updateOutcome,
  upsertOutcome,
} from './db.js';
import { planContextualReminder } from './local-reminder.js';
import { buildSignatureFlowText } from './signature-flows.js';
import type {
  ActionBundleRelatedRefs,
  ActionBundleSnapshot,
  ChannelInlineAction,
  CommunicationThreadRecord,
  CompanionHandoffRecord,
  LifeThread,
  MessageActionRecord,
  MissionRecord,
  MissionStepRecord,
  OutcomeLinkedRefs,
  OutcomeRecord,
  OutcomeReviewHorizon,
  OutcomeSourceType,
  OutcomeStatus,
  ScheduledTask,
} from './types.js';
import { buildVoiceReply } from './voice-ready.js';

export interface OutcomeReviewPromptMatch {
  kind:
    | 'daily_review'
    | 'weekly_review'
    | 'done_today'
    | 'not_done_today'
    | 'slipped'
    | 'carry_tomorrow'
    | 'follow_up_tomorrow'
    | 'needs_attention'
    | 'review_weekend'
    | 'still_open_person';
  personName?: string;
}

export interface OutcomeReviewItem {
  outcome: OutcomeRecord;
  linkedRefs: OutcomeLinkedRefs;
  sourceLabel: string;
  summaryText: string;
  nextFollowupText?: string | null;
  blockerText?: string | null;
}

export interface OutcomeReviewSnapshot {
  match: OutcomeReviewPromptMatch;
  generatedAt: string;
  completedToday: OutcomeReviewItem[];
  stillOpenTonight: OutcomeReviewItem[];
  carryIntoTomorrow: OutcomeReviewItem[];
  slipping: OutcomeReviewItem[];
  blocked: OutcomeReviewItem[];
  deferred: OutcomeReviewItem[];
  owedReplies: OutcomeReviewItem[];
  reviewThisWeek: OutcomeReviewItem[];
  lingering: OutcomeReviewItem[];
  weeklyResolved: OutcomeReviewItem[];
}

export interface OutcomeReviewPresentation {
  text: string;
  summaryText: string;
  inlineActionRows: ChannelInlineAction[][];
  focusOutcomeIds: string[];
  primaryOutcomeId?: string;
}

export interface OutcomeReviewControl {
  kind:
    | 'mark_handled'
    | 'still_open'
    | 'remind_tomorrow'
    | 'hide'
    | 'show';
}

export interface ApplyOutcomeReviewControlResult {
  handled: boolean;
  replyText?: string;
  outcome?: OutcomeRecord;
}

interface UpsertOutcomeInput {
  groupFolder: string;
  sourceType: OutcomeSourceType;
  sourceKey: string;
  status: OutcomeStatus;
  completionSummary?: string | null;
  nextFollowupText?: string | null;
  blockerText?: string | null;
  dueAt?: string | null;
  reviewHorizon?: OutcomeReviewHorizon;
  linkedRefs?: OutcomeLinkedRefs;
  userConfirmed?: boolean;
  showInDailyReview?: boolean;
  showInWeeklyReview?: boolean;
  reviewSuppressedUntil?: string | null;
  now?: Date;
}

interface ReminderSyncOptions {
  linkedRefs?: OutcomeLinkedRefs;
  summaryText?: string | null;
  nextFollowupText?: string | null;
  showInDailyReview?: boolean;
  showInWeeklyReview?: boolean;
  now?: Date;
}

type ReminderLikeTask = Pick<
  ScheduledTask,
  'id' | 'group_folder' | 'chat_jid' | 'prompt' | 'status' | 'next_run'
> &
  Partial<Pick<ScheduledTask, 'last_run' | 'last_result'>>;

const REVIEW_SUPPRESSION_DAYS = 30;

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function clipText(value: string | null | undefined, max = 140): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isSameLocalDay(
  value: string | null | undefined,
  now: Date,
  timeZone: string,
): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.toLocaleDateString('en-US', { timeZone }) ===
    now.toLocaleDateString('en-US', { timeZone })
  );
}

function hoursBetween(
  value: string | null | undefined,
  now: Date,
): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return (parsed - now.getTime()) / (60 * 60 * 1000);
}

function reviewHorizonFromDueAt(
  dueAt: string | null | undefined,
  now: Date,
): OutcomeReviewHorizon {
  const hours = hoursBetween(dueAt, now);
  if (hours === null) return 'later';
  if (hours <= 12) return 'today';
  if (hours <= 24) return 'tonight';
  if (hours <= 48) return 'tomorrow';
  if (hours <= 24 * 5) return 'this_week';
  if (hours <= 24 * 7) return 'weekend';
  return 'later';
}

function outcomeIdForSource(
  groupFolder: string,
  sourceType: OutcomeSourceType,
  sourceKey: string,
): string {
  return `${groupFolder}:${sourceType}:${sourceKey}`;
}

function parseOutcomeLinkedRefs(
  record: Pick<OutcomeRecord, 'linkedRefsJson'>,
): OutcomeLinkedRefs {
  return parseJsonSafe<OutcomeLinkedRefs>(record.linkedRefsJson, {});
}

function mapMissionHorizon(
  mission: MissionRecord,
  now: Date,
): OutcomeReviewHorizon {
  if (mission.dueAt) return reviewHorizonFromDueAt(mission.dueAt, now);
  switch (mission.dueHorizon) {
    case 'today':
      return 'today';
    case 'tonight':
      return 'tonight';
    case 'tomorrow':
      return 'tomorrow';
    case 'this_week':
      return 'this_week';
    case 'weekend':
      return 'weekend';
    default:
      return 'later';
  }
}

function buildSourceLabel(
  outcome: OutcomeRecord,
  linkedRefs: OutcomeLinkedRefs,
): string {
  if (outcome.sourceType === 'mission') {
    return getMission(outcome.sourceKey)?.title || 'Mission';
  }
  if (outcome.sourceType === 'action_bundle') {
    return (
      getActionBundleSnapshot(outcome.sourceKey)?.bundle.title ||
      'Action bundle'
    );
  }
  if (outcome.sourceType === 'message_action') {
    const messageAction = getMessageAction(outcome.sourceKey);
    return (
      linkedRefs.personName ||
      clipText(messageAction?.sourceSummary, 72) ||
      'Message draft'
    );
  }
  if (outcome.sourceType === 'reminder') {
    return clipText(getTaskById(outcome.sourceKey)?.prompt, 72) || 'Reminder';
  }
  if (outcome.sourceType === 'life_thread') {
    return getLifeThread(outcome.sourceKey)?.title || 'Life thread';
  }
  if (outcome.sourceType === 'communication_thread') {
    return (
      getCommunicationThread(outcome.sourceKey)?.title ||
      linkedRefs.personName ||
      'Conversation'
    );
  }
  if (outcome.sourceType === 'cross_channel_handoff') {
    const handoff = getCompanionHandoff(outcome.sourceKey);
    return (
      handoff?.missionSummary ||
      handoff?.voiceSummary ||
      linkedRefs.personName ||
      'Cross-channel handoff'
    );
  }
  if (outcome.sourceType === 'current_work') {
    return linkedRefs.currentWorkRef || outcome.sourceKey;
  }
  return outcome.sourceKey;
}

function buildReviewItem(outcome: OutcomeRecord): OutcomeReviewItem {
  const linkedRefs = parseOutcomeLinkedRefs(outcome);
  const sourceLabel = buildSourceLabel(outcome, linkedRefs);
  const ruleNote = linkedRefs.delegationRuleId
    ? linkedRefs.delegationExplanation || 'Used your usual rule here.'
    : null;
  return {
    outcome,
    linkedRefs,
    sourceLabel,
    summaryText: clipText(
      [
        clipText(outcome.completionSummary, 120) ||
          clipText(outcome.nextFollowupText, 120) ||
          sourceLabel,
        ruleNote,
      ]
        .filter(Boolean)
        .join(' '),
      160,
    ),
    nextFollowupText: outcome.nextFollowupText,
    blockerText: outcome.blockerText,
  };
}

function clusterKey(item: OutcomeReviewItem): string {
  if (item.linkedRefs.communicationThreadId) {
    return `communication:${item.linkedRefs.communicationThreadId}`;
  }
  if (item.linkedRefs.threadId) {
    return `life_thread:${item.linkedRefs.threadId}`;
  }
  if (item.linkedRefs.missionId) {
    return `mission:${item.linkedRefs.missionId}`;
  }
  if (item.linkedRefs.currentWorkRef) {
    return `current_work:${item.linkedRefs.currentWorkRef}`;
  }
  if (item.linkedRefs.handoffId) {
    return `handoff:${item.linkedRefs.handoffId}`;
  }
  if (item.linkedRefs.reminderTaskId) {
    return `reminder:${item.linkedRefs.reminderTaskId}`;
  }
  if (item.linkedRefs.actionBundleId) {
    return `action_bundle:${item.linkedRefs.actionBundleId}`;
  }
  if (item.linkedRefs.messageActionId) {
    return `message_action:${item.linkedRefs.messageActionId}`;
  }
  return `${item.outcome.sourceType}:${item.outcome.sourceKey}`;
}

function statusRank(status: OutcomeStatus): number {
  switch (status) {
    case 'failed':
      return 0;
    case 'partial':
      return 1;
    case 'deferred':
      return 2;
    case 'unknown':
      return 3;
    case 'completed':
      return 4;
    case 'skipped':
      return 5;
    default:
      return 6;
  }
}

function dedupeReviewItems(items: OutcomeReviewItem[]): OutcomeReviewItem[] {
  const grouped = new Map<string, OutcomeReviewItem[]>();
  for (const item of items) {
    const key = clusterKey(item);
    const existing = grouped.get(key) || [];
    existing.push(item);
    grouped.set(key, existing);
  }
  return [...grouped.values()]
    .map((group) =>
      group.sort((left, right) => {
        const rankDiff =
          statusRank(left.outcome.status) - statusRank(right.outcome.status);
        if (rankDiff !== 0) return rankDiff;
        return (
          Date.parse(right.outcome.updatedAt) -
          Date.parse(left.outcome.updatedAt)
        );
      })[0]!,
    )
    .sort(
      (left, right) =>
        Date.parse(right.outcome.updatedAt) - Date.parse(left.outcome.updatedAt),
    );
}

function limitItems(
  items: OutcomeReviewItem[],
  count = 3,
): OutcomeReviewItem[] {
  return items.slice(0, count);
}

function formatOutcomeLine(item: OutcomeReviewItem): string {
  const label = item.sourceLabel;
  if (item.blockerText) {
    return `${label}: ${clipText(item.blockerText, 120)}`;
  }
  if (item.nextFollowupText) {
    const ruleNote = item.linkedRefs.delegationRuleId
      ? clipText(
          item.linkedRefs.delegationExplanation || 'Used your usual rule here.',
          80,
        )
      : null;
    return `${label}: ${clipText(item.nextFollowupText, 120)}${
      ruleNote ? ` ${ruleNote}` : ''
    }`;
  }
  return `${label}: ${clipText(item.summaryText, 120)}`;
}

function buildOutcomeInlineRows(
  items: OutcomeReviewItem[],
): ChannelInlineAction[][] {
  const rows: ChannelInlineAction[][] = [];
  for (const [index, item] of items.slice(0, 2).entries()) {
    const prefix = `${index + 1}.`;
    rows.push([
      {
        label: `${prefix} Mark handled`,
        actionId: `/review-handle ${item.outcome.outcomeId}`,
      },
      {
        label: `${prefix} Still open`,
        actionId: `/review-open ${item.outcome.outcomeId}`,
      },
      {
        label: `${prefix} Tomorrow`,
        actionId: `/review-remind-tomorrow ${item.outcome.outcomeId}`,
      },
    ]);
    const secondary: ChannelInlineAction[] = [
      {
        label: `${prefix} Hide`,
        actionId: `/review-hide ${item.outcome.outcomeId}`,
      },
    ];
    if (
      item.linkedRefs.threadId ||
      item.linkedRefs.communicationThreadId ||
      item.linkedRefs.missionId ||
      item.linkedRefs.actionBundleId
    ) {
      secondary.push({
        label: `${prefix} Show thread/plan again`,
        actionId: `/review-show ${item.outcome.outcomeId}`,
      });
    }
    rows.push(secondary);
  }
  return rows;
}

function outcomeStatusFromBundle(snapshot: ActionBundleSnapshot): OutcomeStatus {
  const statuses = snapshot.actions.map((action) => action.status);
  if (statuses.length === 0) return 'unknown';
  if (statuses.every((status) => status === 'executed')) return 'completed';
  if (statuses.every((status) => status === 'deferred')) return 'deferred';
  if (statuses.every((status) => status === 'skipped')) return 'skipped';
  if (
    statuses.some((status) => status === 'failed') &&
    !statuses.some((status) => status === 'executed')
  ) {
    return 'failed';
  }
  if (
    statuses.some((status) =>
      ['approved', 'proposed', 'executed', 'failed', 'skipped', 'deferred'].includes(
        status,
      ),
    )
  ) {
    return 'partial';
  }
  return 'unknown';
}

function summarizeBundle(snapshot: ActionBundleSnapshot): string {
  const executed = snapshot.actions.filter(
    (action) => action.status === 'executed',
  ).length;
  const failed = snapshot.actions.filter(
    (action) => action.status === 'failed',
  ).length;
  const deferred = snapshot.actions.filter(
    (action) => action.status === 'deferred',
  ).length;
  if (executed > 0 && failed === 0 && deferred === 0) {
    return `${snapshot.bundle.title} moved forward cleanly.`;
  }
  if (executed > 0 && failed > 0) {
    return `${snapshot.bundle.title} moved forward, but one part still needs attention.`;
  }
  if (deferred > 0 && executed === 0) {
    return `${snapshot.bundle.title} was left for later.`;
  }
  return `${snapshot.bundle.title} is still in motion.`;
}

function summarizeMissionStep(steps: MissionStepRecord[]): string | null {
  const next = steps.find((step) => step.stepStatus !== 'done');
  return next ? next.title : null;
}

function buildCommunicationSummary(thread: CommunicationThreadRecord): string {
  return (
    clipText(thread.lastInboundSummary, 140) ||
    clipText(thread.lastOutboundSummary, 140) ||
    thread.title
  );
}

function buildLifeThreadSummary(thread: LifeThread): string {
  return (
    clipText(thread.nextAction, 140) ||
    clipText(thread.summary, 140) ||
    thread.title
  );
}

function personScopeMatches(item: OutcomeReviewItem, personName: string): boolean {
  const normalized = personName.toLowerCase();
  const candidates = [
    item.linkedRefs.personName,
    item.sourceLabel,
    item.summaryText,
    item.nextFollowupText || '',
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);
  return candidates.some((value) => value.includes(normalized));
}

export function upsertOutcomeRecord(input: UpsertOutcomeInput): OutcomeRecord {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const existing = getOutcomeBySource(
    input.groupFolder,
    input.sourceType,
    input.sourceKey,
  );
  const record: OutcomeRecord = {
    outcomeId:
      existing?.outcomeId ||
      outcomeIdForSource(input.groupFolder, input.sourceType, input.sourceKey),
    groupFolder: input.groupFolder,
    sourceType: input.sourceType,
    sourceKey: input.sourceKey,
    linkedRefsJson:
      input.linkedRefs !== undefined
        ? JSON.stringify(input.linkedRefs)
        : existing?.linkedRefsJson || null,
    status: input.status,
    completionSummary:
      input.completionSummary !== undefined
        ? input.completionSummary
        : existing?.completionSummary || null,
    nextFollowupText:
      input.nextFollowupText !== undefined
        ? input.nextFollowupText
        : existing?.nextFollowupText || null,
    blockerText:
      input.blockerText !== undefined
        ? input.blockerText
        : existing?.blockerText || null,
    dueAt: input.dueAt !== undefined ? input.dueAt : existing?.dueAt || null,
    reviewHorizon:
      input.reviewHorizon ||
      existing?.reviewHorizon ||
      reviewHorizonFromDueAt(input.dueAt, now),
    lastCheckedAt: nowIso,
    userConfirmed: input.userConfirmed ?? existing?.userConfirmed ?? false,
    showInDailyReview:
      input.showInDailyReview ?? existing?.showInDailyReview ?? true,
    showInWeeklyReview:
      input.showInWeeklyReview ?? existing?.showInWeeklyReview ?? true,
    reviewSuppressedUntil:
      input.reviewSuppressedUntil !== undefined
        ? input.reviewSuppressedUntil
        : existing?.reviewSuppressedUntil || null,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };
  upsertOutcome(record);
  return record;
}

export function getOutcomeForSource(
  groupFolder: string,
  sourceType: OutcomeSourceType,
  sourceKey: string,
): OutcomeRecord | undefined {
  return getOutcomeBySource(groupFolder, sourceType, sourceKey);
}

export function syncOutcomeFromBundleSnapshot(
  snapshot: ActionBundleSnapshot,
  now = new Date(),
): OutcomeRecord {
  const relatedRefs = parseJsonSafe<ActionBundleRelatedRefs>(
    snapshot.bundle.relatedRefsJson,
    {},
  );
  const firstRuleAction = snapshot.actions.find((action) => action.delegationRuleId);
  return upsertOutcomeRecord({
    groupFolder: snapshot.bundle.groupFolder,
    sourceType: 'action_bundle',
    sourceKey: snapshot.bundle.bundleId,
    status: outcomeStatusFromBundle(snapshot),
    completionSummary: summarizeBundle(snapshot),
    nextFollowupText:
      snapshot.actions.find((action) =>
        ['approved', 'proposed', 'failed'].includes(action.status),
      )?.summary || null,
    reviewHorizon:
      snapshot.bundle.bundleStatus === 'dismissed' ? 'tomorrow' : 'today',
    linkedRefs: {
      actionBundleId: snapshot.bundle.bundleId,
      missionId: relatedRefs.missionId,
      threadId: relatedRefs.threadId,
      communicationThreadId: relatedRefs.communicationThreadId,
      currentWorkRef: relatedRefs.currentWorkRef,
      handoffId: relatedRefs.handoffId,
      knowledgeSourceIds: relatedRefs.knowledgeSourceIds,
      chatJid: snapshot.bundle.presentationChatJid || undefined,
      delegationRuleId: firstRuleAction?.delegationRuleId || undefined,
      delegationMode: firstRuleAction?.delegationMode || null,
      delegationExplanation: firstRuleAction?.delegationExplanation || null,
    },
    userConfirmed: snapshot.bundle.userConfirmed,
    now,
  });
}

export function syncOutcomeFromMessageActionRecord(
  action: MessageActionRecord,
  now = new Date(),
): OutcomeRecord {
  const linkedRefs = parseJsonSafe<OutcomeLinkedRefs>(action.linkedRefsJson, {});
  const status: OutcomeStatus =
    action.sendStatus === 'sent'
      ? 'completed'
      : action.sendStatus === 'deferred'
        ? 'deferred'
        : action.sendStatus === 'failed'
          ? 'failed'
          : action.sendStatus === 'skipped'
            ? 'skipped'
            : 'partial';
  const completionSummary =
    action.sendStatus === 'sent'
      ? clipText(action.sourceSummary || 'Sent the reply.', 140)
      : action.sendStatus === 'failed'
        ? clipText(action.sourceSummary || 'The message still needs to go out.', 140)
        : clipText(action.sourceSummary || action.draftText, 140);
  const nextFollowupText =
    action.sendStatus === 'sent'
      ? 'That message already went out.'
      : action.sendStatus === 'deferred'
        ? 'This draft is saved to revisit before sending.'
        : action.sendStatus === 'failed'
          ? 'The draft is still here if you want to retry or send it later.'
          : action.sendStatus === 'approved'
            ? 'This is approved and ready to send.'
            : 'A reply is drafted, but it still needs your approval to send.';
  return upsertOutcomeRecord({
    groupFolder: action.groupFolder,
    sourceType: 'message_action',
    sourceKey: action.messageActionId,
    status,
    completionSummary,
    nextFollowupText,
    blockerText:
      action.sendStatus === 'failed'
        ? 'I could not send that right now.'
        : null,
    dueAt: action.followupAt || null,
    reviewHorizon: action.followupAt
      ? reviewHorizonFromDueAt(action.followupAt, now)
      : action.sendStatus === 'sent'
        ? 'none'
        : 'today',
    linkedRefs: {
      ...linkedRefs,
      messageActionId: action.messageActionId,
      chatJid: action.presentationChatJid || linkedRefs.chatJid,
    },
    now,
  });
}

export function syncOutcomeFromMissionRecord(
  mission: MissionRecord,
  steps = listMissionSteps(mission.missionId),
  now = new Date(),
): OutcomeRecord {
  const blockers = parseJsonSafe<string[]>(mission.blockersJson, []);
  const nextStep = summarizeMissionStep(steps);
  const status: OutcomeStatus =
    mission.status === 'completed' || mission.status === 'archived'
      ? 'completed'
      : mission.status === 'blocked'
        ? 'failed'
        : mission.status === 'paused'
          ? 'deferred'
          : 'partial';
  return upsertOutcomeRecord({
    groupFolder: mission.groupFolder,
    sourceType: 'mission',
    sourceKey: mission.missionId,
    status,
    completionSummary: mission.summary,
    nextFollowupText: nextStep ? `Next, ${nextStep}.` : mission.summary,
    blockerText: blockers[0] || null,
    dueAt: mission.dueAt || null,
    reviewHorizon: mapMissionHorizon(mission, now),
    linkedRefs: {
      missionId: mission.missionId,
      threadId: mission.linkedLifeThreadIds[0],
      reminderTaskId: mission.linkedReminderIds[0],
      currentWorkRef: parseJsonSafe<{ title?: string }>(
        mission.linkedCurrentWorkJson,
        {},
      ).title,
      knowledgeSourceIds: mission.linkedKnowledgeSourceIds,
    },
    userConfirmed: mission.userConfirmed,
    now,
  });
}

export function syncOutcomeFromCommunicationThreadRecord(
  thread: CommunicationThreadRecord,
  now = new Date(),
): OutcomeRecord {
  const status: OutcomeStatus =
    thread.followupState === 'resolved' || thread.followupState === 'ignored'
      ? 'completed'
      : thread.followupState === 'scheduled'
        ? 'deferred'
        : thread.followupState === 'reply_needed'
          ? 'partial'
          : thread.followupState === 'waiting_on_them'
            ? 'unknown'
            : 'unknown';
  const reviewHorizon = thread.followupDueAt
    ? reviewHorizonFromDueAt(thread.followupDueAt, now)
    : thread.urgency === 'tonight'
      ? 'tonight'
      : thread.urgency === 'tomorrow'
        ? 'tomorrow'
        : thread.urgency === 'overdue'
          ? 'today'
          : 'later';
  return upsertOutcomeRecord({
    groupFolder: thread.groupFolder,
    sourceType: 'communication_thread',
    sourceKey: thread.id,
    status,
    completionSummary: buildCommunicationSummary(thread),
    nextFollowupText:
      thread.followupState === 'reply_needed'
        ? 'A reply still looks owed here.'
        : thread.followupState === 'scheduled'
          ? 'There is already a later follow-up queued here.'
          : thread.followupState === 'waiting_on_them'
            ? 'This is waiting on them for now.'
            : null,
    dueAt: thread.followupDueAt || null,
    reviewHorizon,
    linkedRefs: {
      communicationThreadId: thread.id,
      threadId: thread.linkedLifeThreadIds[0],
      reminderTaskId: thread.linkedTaskId || undefined,
      chatJid: thread.channelChatJid || undefined,
      personName: thread.title,
    },
    now,
  });
}

export function syncOutcomeFromLifeThreadRecord(
  thread: LifeThread,
  now = new Date(),
): OutcomeRecord {
  const dueAt = thread.nextFollowupAt || thread.snoozedUntil || null;
  const status: OutcomeStatus =
    thread.status === 'closed' || thread.status === 'archived'
      ? 'completed'
      : thread.status === 'paused' || Boolean(thread.snoozedUntil)
        ? 'deferred'
        : 'partial';
  return upsertOutcomeRecord({
    groupFolder: thread.groupFolder,
    sourceType: 'life_thread',
    sourceKey: thread.id,
    status,
    completionSummary: buildLifeThreadSummary(thread),
    nextFollowupText: thread.nextAction || thread.summary,
    dueAt,
    reviewHorizon: dueAt ? reviewHorizonFromDueAt(dueAt, now) : 'later',
    linkedRefs: {
      threadId: thread.id,
      reminderTaskId: thread.linkedTaskId || undefined,
    },
    userConfirmed: thread.userConfirmed,
    now,
  });
}

export function syncOutcomeFromReminderTask(
  task: ReminderLikeTask,
  options: ReminderSyncOptions = {},
): OutcomeRecord {
  const now = options.now || new Date();
  return upsertOutcomeRecord({
    groupFolder: task.group_folder,
    sourceType: 'reminder',
    sourceKey: task.id,
    status: task.status === 'completed' ? 'completed' : 'deferred',
    completionSummary:
      options.summaryText ||
      clipText(task.prompt, 140) ||
      'A reminder is holding the loop open.',
    nextFollowupText:
      options.nextFollowupText ||
      (task.status === 'completed'
        ? 'That reminder completed.'
        : 'A reminder is set so this comes back into view later.'),
    dueAt: task.next_run || null,
    reviewHorizon: task.next_run
      ? reviewHorizonFromDueAt(task.next_run, now)
      : 'later',
    linkedRefs: {
      reminderTaskId: task.id,
      ...(options.linkedRefs || {}),
    },
    showInDailyReview: options.showInDailyReview,
    showInWeeklyReview: options.showInWeeklyReview,
    now,
  });
}

export function syncOutcomeFromHandoffRecord(
  handoff: CompanionHandoffRecord,
  now = new Date(),
): OutcomeRecord {
  const status: OutcomeStatus =
    handoff.status === 'delivered'
      ? 'deferred'
      : handoff.status === 'failed'
        ? 'failed'
        : handoff.status === 'cancelled'
          ? 'skipped'
          : 'unknown';
  return upsertOutcomeRecord({
    groupFolder: handoff.groupFolder,
    sourceType: 'cross_channel_handoff',
    sourceKey: handoff.handoffId,
    status,
    completionSummary: handoff.voiceSummary,
    nextFollowupText:
      handoff.status === 'delivered'
        ? `The ${
            handoff.targetChannel === 'telegram' ? 'Telegram' : 'Messages'
          } handoff landed, but it still needs attention.`
        : handoff.status === 'failed'
          ? 'The handoff did not land cleanly yet.'
          : null,
    blockerText: handoff.status === 'failed' ? handoff.errorText || null : null,
    dueAt: handoff.expiresAt,
    reviewHorizon:
      handoff.status === 'delivered'
        ? 'tomorrow'
        : reviewHorizonFromDueAt(handoff.expiresAt, now),
    linkedRefs: {
      handoffId: handoff.handoffId,
      missionId: handoff.missionId || undefined,
      threadId: handoff.threadId || undefined,
      communicationThreadId: handoff.communicationThreadId || undefined,
      reminderTaskId: handoff.taskId || undefined,
      currentWorkRef: handoff.workRef || undefined,
    },
    now,
  });
}

export function syncOutcomeFromCurrentWorkRef(params: {
  groupFolder: string;
  sourceKey: string;
  currentWorkRef: string;
  missionId?: string;
  chatJid?: string;
  now?: Date;
}): OutcomeRecord {
  const now = params.now || new Date();
  return upsertOutcomeRecord({
    groupFolder: params.groupFolder,
    sourceType: 'current_work',
    sourceKey: params.sourceKey,
    status: 'partial',
    completionSummary: `${params.currentWorkRef} is still part of the active execution picture.`,
    nextFollowupText:
      'Keep this in view while the surrounding loop is still active.',
    reviewHorizon: 'today',
    linkedRefs: {
      currentWorkRef: params.currentWorkRef,
      missionId: params.missionId,
      chatJid: params.chatJid,
    },
    now,
  });
}

export function seedOutcomeRecordsForGroup(
  groupFolder: string,
  now = new Date(),
): OutcomeRecord[] {
  for (const snapshot of listActionBundlesForGroup({
    groupFolder,
    statuses: ['open', 'partially_done', 'done', 'dismissed'],
    limit: 40,
  })) {
    syncOutcomeFromBundleSnapshot(snapshot, now);
  }

  const missions = listMissionsForGroup({
    groupFolder,
    statuses: ['active', 'blocked', 'paused', 'completed', 'archived'],
    includeUnconfirmed: true,
    limit: 40,
  });
  for (const mission of missions) {
    syncOutcomeFromMissionRecord(
      mission,
      listMissionSteps(mission.missionId),
      now,
    );
  }

  const communicationThreads = listCommunicationThreadsForGroup({
    groupFolder,
    includeDisabled: false,
    limit: 80,
  });
  for (const thread of communicationThreads) {
    syncOutcomeFromCommunicationThreadRecord(thread, now);
  }

  for (const messageAction of listMessageActionsForGroup({
    groupFolder,
    includeSent: true,
    limit: 80,
  })) {
    syncOutcomeFromMessageActionRecord(messageAction, now);
  }

  const lifeThreads = listLifeThreadsForGroup(groupFolder);
  for (const thread of lifeThreads) {
    syncOutcomeFromLifeThreadRecord(thread, now);
  }

  const referencedTaskIds = new Set<string>();
  for (const mission of missions) {
    for (const taskId of mission.linkedReminderIds) {
      referencedTaskIds.add(taskId);
    }
  }
  for (const thread of communicationThreads) {
    if (thread.linkedTaskId) referencedTaskIds.add(thread.linkedTaskId);
  }
  for (const thread of lifeThreads) {
    if (thread.linkedTaskId) referencedTaskIds.add(thread.linkedTaskId);
  }
  for (const task of getTasksForGroup(groupFolder)) {
    const existing = getOutcomeBySource(groupFolder, 'reminder', task.id);
    if (existing) referencedTaskIds.add(task.id);
  }
  for (const taskId of referencedTaskIds) {
    const task = getTaskById(taskId);
    if (task) syncOutcomeFromReminderTask(task, { now });
  }

  for (const handoff of listCompanionHandoffsForGroup({
    groupFolder,
    statuses: ['queued', 'delivered', 'failed', 'cancelled'],
    limit: 40,
  })) {
    syncOutcomeFromHandoffRecord(handoff, now);
  }

  return listOutcomesForGroup({
    groupFolder,
    includeSuppressed: true,
    limit: 300,
    now: now.toISOString(),
  });
}

function buildSections(
  items: OutcomeReviewItem[],
  match: OutcomeReviewPromptMatch,
  now: Date,
  timeZone: string,
): OutcomeReviewSnapshot {
  const completedToday = items.filter(
    (item) =>
      item.outcome.status === 'completed' &&
      isSameLocalDay(item.outcome.updatedAt, now, timeZone),
  );
  const stillOpenTonight = items.filter(
    (item) =>
      ['partial', 'deferred', 'unknown'].includes(item.outcome.status) &&
      ['today', 'tonight'].includes(item.outcome.reviewHorizon),
  );
  const carryIntoTomorrow = items.filter(
    (item) =>
      ['partial', 'deferred', 'unknown'].includes(item.outcome.status) &&
      ['today', 'tonight', 'tomorrow'].includes(item.outcome.reviewHorizon),
  );
  const slipping = items.filter((item) => {
    if (
      item.outcome.status === 'completed' ||
      item.outcome.status === 'skipped'
    ) {
      return false;
    }
    const hours = hoursBetween(item.outcome.dueAt, now);
    return hours !== null && hours < 0;
  });
  const blocked = items.filter(
    (item) =>
      item.outcome.status === 'failed' ||
      Boolean(normalizeText(item.blockerText)),
  );
  const deferred = items.filter((item) => item.outcome.status === 'deferred');
  const owedReplies = items.filter(
    (item) =>
      ['communication_thread', 'message_action'].includes(item.outcome.sourceType) &&
      item.outcome.status !== 'completed' &&
      item.outcome.status !== 'skipped',
  );
  const reviewThisWeek = items.filter(
    (item) =>
      item.outcome.status !== 'completed' &&
      ['this_week', 'weekend'].includes(item.outcome.reviewHorizon),
  );
  const lingering = items.filter(
    (item) =>
      item.outcome.status !== 'completed' &&
      item.outcome.status !== 'skipped' &&
      now.getTime() - Date.parse(item.outcome.updatedAt) >=
        3 * 24 * 60 * 60 * 1000,
  );
  const weeklyResolved = items.filter(
    (item) =>
      item.outcome.status === 'completed' &&
      now.getTime() - Date.parse(item.outcome.updatedAt) <=
        7 * 24 * 60 * 60 * 1000,
  );

  return {
    match,
    generatedAt: now.toISOString(),
    completedToday: limitItems(completedToday),
    stillOpenTonight: limitItems(stillOpenTonight),
    carryIntoTomorrow: limitItems(carryIntoTomorrow),
    slipping: limitItems(slipping),
    blocked: limitItems(blocked),
    deferred: limitItems(deferred),
    owedReplies: limitItems(owedReplies),
    reviewThisWeek: limitItems(reviewThisWeek),
    lingering: limitItems(lingering),
    weeklyResolved: limitItems(weeklyResolved),
  };
}

export function buildReviewSnapshot(params: {
  groupFolder: string;
  match: OutcomeReviewPromptMatch;
  now?: Date;
  timeZone?: string;
}): OutcomeReviewSnapshot {
  const now = params.now || new Date();
  seedOutcomeRecordsForGroup(params.groupFolder, now);
  const outcomes = listOutcomesForGroup({
    groupFolder: params.groupFolder,
    includeSuppressed: true,
    limit: 400,
    now: now.toISOString(),
  }).filter((record) => {
    if (params.match.kind === 'weekly_review' || params.match.kind === 'review_weekend') {
      return record.showInWeeklyReview;
    }
    return record.showInDailyReview;
  });

  let items = dedupeReviewItems(
    outcomes
      .filter((record) => {
        if (
          record.reviewSuppressedUntil &&
          Date.parse(record.reviewSuppressedUntil) > now.getTime()
        ) {
          return false;
        }
        return true;
      })
      .map((outcome) => buildReviewItem(outcome)),
  );
  if (params.match.kind === 'still_open_person' && params.match.personName) {
    items = items.filter((item) =>
      personScopeMatches(item, params.match.personName || ''),
    );
  }

  return buildSections(
    items,
    params.match,
    now,
    params.timeZone || 'America/Chicago',
  );
}

function buildTelegramReviewText(snapshot: OutcomeReviewSnapshot): string {
  const sections: string[] = [];
  const addSection = (title: string, items: OutcomeReviewItem[]) => {
    if (items.length === 0) return;
    sections.push(
      `*${title}*`,
      ...items.map((item) => `- ${formatOutcomeLine(item)}`),
      '',
    );
  };

  switch (snapshot.match.kind) {
    case 'done_today':
      addSection('Done Today', snapshot.completedToday);
      addSection('Still Open Tonight', snapshot.stillOpenTonight);
      break;
    case 'not_done_today':
      addSection('Still Open Tonight', snapshot.stillOpenTonight);
      addSection('Carry Into Tomorrow', snapshot.carryIntoTomorrow);
      addSection('Slipping', snapshot.slipping);
      break;
    case 'slipped':
      addSection('Slipping', snapshot.slipping);
      addSection('Blocked', snapshot.blocked);
      break;
    case 'carry_tomorrow':
    case 'follow_up_tomorrow':
      addSection('Carry Into Tomorrow', snapshot.carryIntoTomorrow);
      addSection('Owed Replies', snapshot.owedReplies);
      break;
    case 'weekly_review':
    case 'review_weekend':
      addSection('Closed This Week', snapshot.weeklyResolved);
      addSection('Review This Week', snapshot.reviewThisWeek);
      addSection('Lingering', snapshot.lingering);
      addSection('Blocked', snapshot.blocked);
      break;
    case 'still_open_person':
      addSection(
        snapshot.match.personName
          ? `Still Open With ${snapshot.match.personName}`
          : 'Still Open',
        snapshot.owedReplies.length > 0
          ? snapshot.owedReplies
          : snapshot.carryIntoTomorrow,
      );
      addSection('Blocked', snapshot.blocked);
      break;
    case 'daily_review':
    case 'needs_attention':
    default:
      addSection('Done Today', snapshot.completedToday);
      addSection('Still Open Tonight', snapshot.stillOpenTonight);
      addSection('Carry Into Tomorrow', snapshot.carryIntoTomorrow);
      addSection('Blocked', snapshot.blocked);
      addSection('Owed Replies', snapshot.owedReplies);
      break;
  }

  if (sections.length === 0) {
    return 'Andrea: Nothing important looks open enough to review right now.';
  }

  const lead =
    snapshot.match.kind === 'weekly_review' ||
    snapshot.match.kind === 'review_weekend'
      ? 'Andrea: Here is the weekly review.'
      : snapshot.match.kind === 'done_today'
        ? 'Andrea: Here is what actually got done today.'
        : snapshot.match.kind === 'slipped'
          ? 'Andrea: Here is what looks like it slipped.'
          : 'Andrea: Here is the current review.';
  return [lead, '', ...sections].join('\n').trim();
}

function buildAlexaReviewText(snapshot: OutcomeReviewSnapshot): string {
  const firstOpen =
    snapshot.stillOpenTonight[0] ||
    snapshot.carryIntoTomorrow[0] ||
    snapshot.blocked[0] ||
    snapshot.owedReplies[0] ||
    null;
  const firstDone =
    snapshot.completedToday[0] || snapshot.weeklyResolved[0] || null;
  const blocker =
    snapshot.blocked[0]?.blockerText ||
    snapshot.slipping[0]?.summaryText ||
    firstOpen?.nextFollowupText ||
    null;

  return buildVoiceReply({
    summary:
      snapshot.match.kind === 'done_today'
        ? firstDone
          ? `Today you did move ${firstDone.sourceLabel.toLowerCase()}.`
          : 'Nothing major looks closed today yet.'
        : firstOpen
          ? `The main thing still open is ${firstOpen.sourceLabel.toLowerCase()}.`
          : 'Nothing major looks open right now.',
    details: [
      blocker ? clipText(blocker, 140) : null,
      firstDone && firstOpen
        ? `You did move ${firstDone.sourceLabel.toLowerCase()}, but ${firstOpen.sourceLabel.toLowerCase()} still needs attention.`
        : null,
    ],
    offerMore: false,
    maxDetails: 2,
  });
}

export function buildOutcomeReviewResponse(params: {
  groupFolder: string;
  match: OutcomeReviewPromptMatch;
  channel: 'telegram' | 'alexa' | 'bluebubbles';
  now?: Date;
  timeZone?: string;
}): OutcomeReviewPresentation {
  const snapshot = buildReviewSnapshot({
    groupFolder: params.groupFolder,
    match: params.match,
    now: params.now,
    timeZone: params.timeZone,
  });
  const focusItems =
    snapshot.match.kind === 'weekly_review' ||
    snapshot.match.kind === 'review_weekend'
      ? [
          ...snapshot.reviewThisWeek,
          ...snapshot.blocked,
          ...snapshot.lingering,
        ]
      : [
          ...snapshot.stillOpenTonight,
          ...snapshot.carryIntoTomorrow,
          ...snapshot.blocked,
          ...snapshot.owedReplies,
        ];
  const dedupedFocus = dedupeReviewItems(focusItems);
  const primaryOutcomeId = dedupedFocus[0]?.outcome.outcomeId;

  if (params.channel === 'alexa') {
    const text = buildAlexaReviewText(snapshot);
    return {
      text,
      summaryText: text,
      inlineActionRows: [],
      focusOutcomeIds: dedupedFocus.map((item) => item.outcome.outcomeId),
      primaryOutcomeId,
    };
  }

  if (params.channel === 'bluebubbles') {
    const openLead = dedupedFocus[0];
    const text = openLead
      ? `Andrea: The main thing still open is ${openLead.sourceLabel}. Ask me to send the fuller review to Telegram if you want the full list.`
      : 'Andrea: Nothing important looks open enough to review right now.';
    return {
      text,
      summaryText: text,
      inlineActionRows: [],
      focusOutcomeIds: dedupedFocus.map((item) => item.outcome.outcomeId),
      primaryOutcomeId,
    };
  }

  return {
    text: buildTelegramReviewText(snapshot),
    summaryText:
      dedupedFocus[0]?.summaryText ||
      snapshot.completedToday[0]?.summaryText ||
      'Nothing important looks open right now.',
    inlineActionRows: buildOutcomeInlineRows(dedupedFocus),
    focusOutcomeIds: dedupedFocus.map((item) => item.outcome.outcomeId),
    primaryOutcomeId,
  };
}

export function matchOutcomeReviewPrompt(
  rawText: string,
): OutcomeReviewPromptMatch | null {
  const normalized = normalizeText(rawText).toLowerCase();
  if (!normalized) return null;
  const personMatch = normalized.match(
    /^what(?:'s| is)? still open with ([a-z][a-z' -]+)$/i,
  );
  if (personMatch?.[1]) {
    return {
      kind: 'still_open_person',
      personName: personMatch[1]
        .trim()
        .replace(/\b\w/g, (value) => value.toUpperCase()),
    };
  }
  if (/^daily review\b/.test(normalized)) return { kind: 'daily_review' };
  if (/^weekly review\b/.test(normalized)) return { kind: 'weekly_review' };
  if (/what actually got done today|what got done today/.test(normalized)) {
    return { kind: 'done_today' };
  }
  if (/what did(?: not|n't) get done today/.test(normalized)) {
    return { kind: 'not_done_today' };
  }
  if (/what slipped|at risk of slipping/.test(normalized)) {
    return { kind: 'slipped' };
  }
  if (/what am i carrying into tomorrow|carry into tomorrow/.test(normalized)) {
    return { kind: 'carry_tomorrow' };
  }
  if (/what should i follow up on tomorrow/.test(normalized)) {
    return { kind: 'follow_up_tomorrow' };
  }
  if (/what should i review this weekend/.test(normalized)) {
    return { kind: 'review_weekend' };
  }
  if (/what(?:'s| is)? still open from this week/.test(normalized)) {
    return { kind: 'weekly_review' };
  }
  if (
    /what messages are still unsent|what do i still owe people|what still needs my attention|what(?:'s| is)? still open|what should i remember tonight/.test(
      normalized,
    )
  ) {
    return { kind: 'needs_attention' };
  }
  return null;
}

export function interpretOutcomeReviewControl(
  rawText: string,
): OutcomeReviewControl | null {
  const normalized = normalizeText(rawText).toLowerCase();
  if (!normalized) return null;
  if (
    /^(mark that handled|that's done|that is done|close that out|mark this handled)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'mark_handled' };
  }
  if (/^(still open)\b/.test(normalized)) {
    return { kind: 'still_open' };
  }
  if (
    /^(remind me tomorrow instead|tomorrow instead|remind tomorrow)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'remind_tomorrow' };
  }
  if (
    /^(don't show that in review|hide that from review|hide that)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'hide' };
  }
  if (/^(show thread again|show plan again|show that again)\b/.test(normalized)) {
    return { kind: 'show' };
  }
  return null;
}

function reminderBodyForOutcome(
  outcome: OutcomeRecord,
  linkedRefs: OutcomeLinkedRefs,
): string {
  return (
    normalizeText(outcome.nextFollowupText) ||
    normalizeText(outcome.completionSummary) ||
    linkedRefs.personName ||
    'follow up on this'
  );
}

function buildShowReferenceReply(
  outcome: OutcomeRecord,
  linkedRefs: OutcomeLinkedRefs,
): string {
  if (linkedRefs.missionId) {
    const mission = getMission(linkedRefs.missionId);
    const steps = mission ? listMissionSteps(mission.missionId) : [];
    const nextStep = steps.find((step) => step.stepStatus !== 'done');
    if (mission) {
      return buildSignatureFlowText({
        lead: `Andrea: ${mission.summary}`,
        detailLines: [
          nextStep ? `Next step: ${nextStep.title}` : null,
          mission.title ? `Plan: ${mission.title}` : null,
        ],
        nextAction: nextStep?.title || null,
        whyLine: parseJsonSafe<string[]>(mission.blockersJson, [])[0] || null,
      });
    }
  }
  if (linkedRefs.threadId) {
    const thread = getLifeThread(linkedRefs.threadId);
    if (thread) {
      return buildSignatureFlowText({
        lead: `Andrea: ${thread.title}`,
        detailLines: [
          thread.summary,
          thread.nextAction ? `Next action: ${thread.nextAction}` : null,
        ],
        nextAction: thread.nextAction || null,
      });
    }
  }
  if (linkedRefs.communicationThreadId) {
    const thread = getCommunicationThread(linkedRefs.communicationThreadId);
    if (thread) {
      return buildSignatureFlowText({
        lead: `Andrea: ${thread.title}`,
        detailLines: [
          thread.lastInboundSummary || thread.lastOutboundSummary || null,
          `Follow-up: ${thread.followupState.replace(/_/g, ' ')}`,
        ],
        nextAction:
          thread.followupState === 'reply_needed'
            ? 'Draft the reply or remind yourself later.'
            : null,
      });
    }
  }
  if (linkedRefs.actionBundleId) {
    const bundle = getActionBundleSnapshot(linkedRefs.actionBundleId);
    if (bundle) {
      return buildSignatureFlowText({
        lead: `Andrea: ${bundle.bundle.title}`,
        detailLines: bundle.actions.map(
          (action) => `${action.orderIndex}. ${action.summary}`,
        ),
        nextAction:
          bundle.actions.find((action) =>
            ['proposed', 'approved'].includes(action.status),
          )?.summary || null,
      });
    }
  }
  if (linkedRefs.messageActionId) {
    const messageAction = getMessageAction(linkedRefs.messageActionId);
    if (messageAction) {
      return buildSignatureFlowText({
        lead: 'Andrea: Here is the current draft.',
        detailLines: [
          messageAction.draftText,
          `Status: ${messageAction.sendStatus.replace(/_/g, ' ')}`,
        ],
        nextAction:
          messageAction.sendStatus === 'sent'
            ? null
            : 'Send it, send it later, or remind yourself instead.',
      });
    }
  }
  return `Andrea: ${outcome.completionSummary || 'That is still linked to the underlying thread or plan.'}`;
}

export function applyOutcomeReviewControl(params: {
  groupFolder: string;
  outcomeId: string;
  control: OutcomeReviewControl;
  chatJid?: string;
  now?: Date;
}): ApplyOutcomeReviewControlResult {
  const now = params.now || new Date();
  const outcome = getOutcome(params.outcomeId);
  if (!outcome || outcome.groupFolder !== params.groupFolder) {
    return { handled: false };
  }
  const linkedRefs = parseOutcomeLinkedRefs(outcome);

  if (params.control.kind === 'show') {
    return {
      handled: true,
      outcome,
      replyText: buildShowReferenceReply(outcome, linkedRefs),
    };
  }

  if (params.control.kind === 'hide') {
    updateOutcome(outcome.outcomeId, {
      showInDailyReview: false,
      showInWeeklyReview: false,
      reviewSuppressedUntil: new Date(
        now.getTime() + REVIEW_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
      updatedAt: now.toISOString(),
    });
    return {
      handled: true,
      outcome: getOutcome(outcome.outcomeId),
      replyText: 'Andrea: Okay — I will leave that out of review for now.',
    };
  }

  if (params.control.kind === 'still_open') {
    updateOutcome(outcome.outcomeId, {
      status: 'partial',
      reviewHorizon:
        outcome.reviewHorizon === 'none' ? 'tomorrow' : outcome.reviewHorizon,
      userConfirmed: true,
      updatedAt: now.toISOString(),
    });
    return {
      handled: true,
      outcome: getOutcome(outcome.outcomeId),
      replyText: 'Andrea: Okay — I will keep that in view as still open.',
    };
  }

  if (params.control.kind === 'remind_tomorrow') {
    const reminderChatJid = params.chatJid || linkedRefs.chatJid;
    if (!reminderChatJid) {
      return {
        handled: true,
        outcome,
        replyText:
          'Andrea: I can hold that as still open, but I do not have the right chat context to place the reminder from here yet.',
      };
    }
    const planned = planContextualReminder(
      'tomorrow morning',
      reminderBodyForOutcome(outcome, linkedRefs),
      params.groupFolder,
      reminderChatJid,
      now,
    );
    if (!planned) {
      return {
        handled: true,
        outcome,
        replyText:
          'Andrea: I could not pin down the tomorrow reminder cleanly yet.',
      };
    }
    createTask(planned.task);
    syncOutcomeFromReminderTask(planned.task, {
      linkedRefs: {
        reminderTaskId: planned.task.id,
        ...linkedRefs,
      },
      summaryText: planned.confirmation,
      now,
    });
    if (linkedRefs.communicationThreadId) {
      updateCommunicationThread(linkedRefs.communicationThreadId, {
        linkedTaskId: planned.task.id,
        followupState: 'scheduled',
        urgency: 'tomorrow',
        followupDueAt: planned.task.next_run,
      });
      const updatedThread = getCommunicationThread(
        linkedRefs.communicationThreadId,
      );
      if (updatedThread) {
        syncOutcomeFromCommunicationThreadRecord(updatedThread, now);
      }
    }
    if (linkedRefs.threadId) {
      const thread = getLifeThread(linkedRefs.threadId);
      if (thread) {
        updateLifeThread(thread.id, {
          linkedTaskId: planned.task.id,
          snoozedUntil: planned.task.next_run,
          status: 'paused',
          lastUpdatedAt: now.toISOString(),
        });
        const updatedThread = getLifeThread(thread.id);
        if (updatedThread) syncOutcomeFromLifeThreadRecord(updatedThread, now);
      }
    }
    updateOutcome(outcome.outcomeId, {
      status: 'deferred',
      reviewHorizon: 'tomorrow',
      nextFollowupText: 'A reminder is set for tomorrow morning.',
      updatedAt: now.toISOString(),
      userConfirmed: true,
      linkedRefsJson: JSON.stringify({
        ...linkedRefs,
        reminderTaskId: planned.task.id,
        chatJid: reminderChatJid,
      }),
    });
    if (linkedRefs.messageActionId) {
      const messageAction = getMessageAction(linkedRefs.messageActionId);
      if (messageAction) {
        updateMessageAction(messageAction.messageActionId, {
          sendStatus: 'deferred',
          followupAt: planned.task.next_run,
          lastUpdatedAt: now.toISOString(),
          linkedRefsJson: JSON.stringify({
            ...parseJsonSafe<OutcomeLinkedRefs>(messageAction.linkedRefsJson, {}),
            reminderTaskId: planned.task.id,
          }),
        });
        const updatedMessageAction = getMessageAction(messageAction.messageActionId);
        if (updatedMessageAction) {
          syncOutcomeFromMessageActionRecord(updatedMessageAction, now);
        }
      }
    }
    return {
      handled: true,
      outcome: getOutcome(outcome.outcomeId),
      replyText: `Andrea: ${planned.confirmation}`,
    };
  }

  if (params.control.kind === 'mark_handled') {
    if (linkedRefs.communicationThreadId) {
      updateCommunicationThread(linkedRefs.communicationThreadId, {
        followupState: 'resolved',
        suggestedNextAction: 'ignore',
        updatedAt: now.toISOString(),
      });
      const updated = getCommunicationThread(linkedRefs.communicationThreadId);
      if (updated) syncOutcomeFromCommunicationThreadRecord(updated, now);
    } else if (linkedRefs.threadId) {
      const thread = getLifeThread(linkedRefs.threadId);
      if (thread) {
        updateLifeThread(thread.id, {
          status: 'closed',
          lastUpdatedAt: now.toISOString(),
          lastUsedAt: now.toISOString(),
        });
        const updated = getLifeThread(thread.id);
        if (updated) syncOutcomeFromLifeThreadRecord(updated, now);
      }
    } else if (linkedRefs.missionId) {
      const mission = getMission(linkedRefs.missionId);
      if (mission) {
        const steps = listMissionSteps(mission.missionId);
        const target = steps.find((step) => step.stepStatus !== 'done');
        if (target) {
          replaceMissionSteps(
            mission.missionId,
            steps.map((step) =>
              step.stepId === target.stepId
                ? {
                    ...step,
                    stepStatus: 'done',
                    lastUpdatedAt: now.toISOString(),
                  }
                : step,
            ),
          );
        }
        const refreshedSteps = listMissionSteps(mission.missionId);
        updateMission(mission.missionId, {
          status: refreshedSteps.every((step) => step.stepStatus === 'done')
            ? 'completed'
            : mission.status === 'proposed'
              ? 'active'
              : mission.status,
          userConfirmed: true,
          lastUpdatedAt: now.toISOString(),
        });
        const updatedMission = getMission(mission.missionId);
        if (updatedMission) {
          syncOutcomeFromMissionRecord(updatedMission, refreshedSteps, now);
        }
      }
    } else if (linkedRefs.messageActionId) {
      const messageAction = getMessageAction(linkedRefs.messageActionId);
      if (messageAction && messageAction.sendStatus !== 'sent') {
        updateMessageAction(messageAction.messageActionId, {
          sendStatus: 'skipped',
          lastUpdatedAt: now.toISOString(),
        });
        const updatedAction = getMessageAction(messageAction.messageActionId);
        if (updatedAction) {
          syncOutcomeFromMessageActionRecord(updatedAction, now);
        }
      }
      updateOutcome(outcome.outcomeId, {
        status: 'completed',
        updatedAt: now.toISOString(),
        userConfirmed: true,
      });
    } else {
      updateOutcome(outcome.outcomeId, {
        status: 'completed',
        updatedAt: now.toISOString(),
        userConfirmed: true,
      });
    }
    return {
      handled: true,
      outcome: getOutcome(outcome.outcomeId),
      replyText: 'Andrea: Okay — I marked that as handled.',
    };
  }

  return { handled: false };
}
