import { randomUUID } from 'crypto';

import { draftCommunicationReply, formatCommunicationDraftReply } from './communication-companion.js';
import {
  createTask,
  findLatestOpenActionBundleForChat,
  findOpenActionBundleBySource,
  getActionBundleSnapshot,
  replaceActionBundleActions,
  updateActionBundle,
  updateActionBundleAction,
  upsertActionBundle,
} from './db.js';
import type { CompanionHandoffDeps } from './cross-channel-handoffs.js';
import { deliverCompanionHandoff } from './cross-channel-handoffs.js';
import { saveKnowledgeSource } from './knowledge-library.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { planContextualReminder } from './local-reminder.js';
import { updateMissionAfterExecution } from './missions.js';
import { handleRitualCommand } from './rituals.js';
import type {
  ActionBundleActionRecord,
  ActionBundleActionStatus,
  ActionBundleActionType,
  ActionBundleOriginKind,
  ActionBundlePresentationChannel,
  ActionBundlePresentationMode,
  ActionBundleRecord,
  ActionBundleRelatedRefs,
  ActionBundleSnapshot,
  ActionBundleSourceContext,
  ActionBundleStatus,
  ChannelInlineAction,
  CompanionContinuationCandidate,
  MissionSuggestedAction,
} from './types.js';

const ACTION_BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIONS_PER_BUNDLE = 4;

interface ReminderActionPayload {
  type: 'create_reminder';
  reminderBody: string;
  timingHint: string;
}

interface DraftActionPayload {
  type: 'draft_follow_up';
  text: string;
  threadTitle?: string | null;
  communicationThreadId?: string | null;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string | null;
}

interface ThreadActionPayload {
  type: 'save_to_thread';
  text: string;
  threadTitle?: string | null;
}

interface LibraryActionPayload {
  type: 'save_to_library';
  title: string;
  content: string;
}

interface RitualActionPayload {
  type: 'pin_to_ritual';
  text: string;
}

interface TelegramHandoffActionPayload {
  type: 'send_to_telegram';
  voiceSummary: string;
  payload: NonNullable<CompanionContinuationCandidate['handoffPayload']>;
  capabilityId?: string;
  threadId?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
  missionId?: string;
  missionSummary?: string;
  missionSuggestedActionsJson?: string;
  missionBlockersJson?: string;
  missionStepFocusJson?: string;
  knowledgeSourceIds?: string[];
  followupSuggestions?: string[];
}

interface CurrentWorkActionPayload {
  type: 'reference_current_work';
  linkedCurrentWorkJson: string;
  missionId?: string;
}

type BundleActionPayload =
  | ReminderActionPayload
  | DraftActionPayload
  | ThreadActionPayload
  | LibraryActionPayload
  | RitualActionPayload
  | TelegramHandoffActionPayload
  | CurrentWorkActionPayload;

export interface CreateActionBundleParams {
  groupFolder: string;
  presentationChannel: ActionBundlePresentationChannel;
  presentationChatJid?: string;
  presentationThreadId?: string | null;
  capabilityId?: string;
  continuationCandidate?: CompanionContinuationCandidate;
  summaryText?: string;
  replyText?: string;
  utterance?: string;
  now?: Date;
}

export interface ActionBundlePresentation {
  text: string;
  inlineActionRows: ChannelInlineAction[][];
  mode: ActionBundlePresentationMode;
}

export interface ActionBundleVoiceSummary {
  speech: string;
  summary: string;
}

export interface ActionBundleExecutionDeps extends Partial<CompanionHandoffDeps> {
  groupFolder: string;
  channel: ActionBundlePresentationChannel;
  chatJid?: string;
  currentTime?: Date;
}

export type ActionBundleOperation =
  | { kind: 'show' }
  | { kind: 'enter_selection' }
  | { kind: 'toggle_action'; orderIndex: number }
  | { kind: 'approve_all' }
  | { kind: 'run_selected' }
  | { kind: 'skip_selected' }
  | { kind: 'defer_all' }
  | { kind: 'execute_action_type'; actionType: ActionBundleActionType }
  | { kind: 'skip_action_type'; actionType: ActionBundleActionType }
  | { kind: 'execute_action_indexes'; orderIndexes: number[] };

export interface ActionBundleOperationResult {
  handled: boolean;
  snapshot?: ActionBundleSnapshot;
  presentation?: ActionBundlePresentation;
  replyText?: string;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function titleCaseActionType(actionType: ActionBundleActionType): string {
  switch (actionType) {
    case 'create_reminder':
      return 'set the reminder';
    case 'draft_follow_up':
      return 'draft the reply';
    case 'save_to_thread':
      return 'save it to the thread';
    case 'save_to_library':
      return 'save it to the library';
    case 'pin_to_ritual':
      return 'pin it to your ritual';
    case 'send_to_telegram':
      return 'send the fuller version to Telegram';
    case 'reference_current_work':
      return 'keep current work in view';
    default:
      return 'handle the next step';
  }
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function buildSourceContextKey(params: {
  originKind: ActionBundleOriginKind;
  capabilityId?: string;
  candidate?: CompanionContinuationCandidate;
  sourceContext: ActionBundleSourceContext;
}): string {
  const refs = [
    params.originKind,
    params.capabilityId || '',
    params.candidate?.missionId || '',
    params.candidate?.threadId || '',
    params.candidate?.communicationThreadId || '',
    params.sourceContext.titleHint || '',
    params.sourceContext.utterance || '',
  ];
  return refs.map((part) => normalizeText(part)).join('|');
}

function deriveOriginKind(
  capabilityId: string | undefined,
  candidate: CompanionContinuationCandidate | undefined,
): ActionBundleOriginKind | null {
  if (candidate?.missionId || capabilityId?.startsWith('missions.')) {
    return 'mission';
  }
  if (
    candidate?.communicationThreadId ||
    capabilityId?.startsWith('communication.')
  ) {
    return 'communication';
  }
  if (candidate?.chiefOfStaffContextJson || capabilityId?.startsWith('staff.')) {
    return 'chief_of_staff';
  }
  if (
    capabilityId?.startsWith('daily.') ||
    capabilityId === 'household.candace_upcoming'
  ) {
    return 'daily_guidance';
  }
  if (
    capabilityId?.startsWith('research.') ||
    capabilityId?.startsWith('knowledge.')
  ) {
    return 'research';
  }
  if (candidate?.handoffPayload) {
    return 'handoff';
  }
  return null;
}

function deriveBundleTitle(
  originKind: ActionBundleOriginKind,
  candidate: CompanionContinuationCandidate | undefined,
  sourceContext: ActionBundleSourceContext,
): string {
  if (sourceContext.titleHint) return sourceContext.titleHint;
  if (candidate?.threadTitle) return `${candidate.threadTitle} next steps`;
  if (candidate?.missionSummary) return 'Mission next steps';
  if (sourceContext.personName) return `${sourceContext.personName} next steps`;
  switch (originKind) {
    case 'mission':
      return 'Mission action bundle';
    case 'communication':
      return 'Follow-up bundle';
    case 'chief_of_staff':
      return 'Chief-of-staff next steps';
    case 'daily_guidance':
      return 'Daily next steps';
    case 'research':
      return 'Research follow-through';
    case 'handoff':
      return 'Handoff next steps';
    default:
      return 'Action bundle';
  }
}

function deriveSourceContext(params: {
  originKind: ActionBundleOriginKind;
  capabilityId?: string;
  candidate?: CompanionContinuationCandidate;
  summaryText?: string;
  replyText?: string;
  utterance?: string;
}): ActionBundleSourceContext {
  const summaryText =
    normalizeText(params.summaryText) ||
    normalizeText(params.replyText) ||
    normalizeText(params.candidate?.voiceSummary);
  return {
    whyLine:
      params.originKind === 'communication'
        ? 'These are the cleanest follow-through moves from this conversation.'
        : params.originKind === 'mission'
          ? 'These are the next concrete moves from the mission.'
          : params.originKind === 'research'
            ? 'These are the best next steps from what Andrea just surfaced.'
            : 'These are the most useful next steps from this answer.',
    summaryText: summaryText || undefined,
    utterance: normalizeText(params.utterance) || undefined,
    personName:
      params.candidate?.threadTitle && !params.candidate?.communicationThreadId
        ? undefined
        : undefined,
    titleHint:
      params.candidate?.threadTitle ||
      (params.originKind === 'mission' ? 'Mission next steps' : undefined),
  };
}

function buildRelatedRefs(
  candidate: CompanionContinuationCandidate | undefined,
): ActionBundleRelatedRefs {
  return {
    missionId: candidate?.missionId,
    threadId: candidate?.threadId,
    communicationThreadId: candidate?.communicationThreadId,
    knowledgeSourceIds: candidate?.knowledgeSourceIds,
  };
}

function defaultReminderTiming(originKind: ActionBundleOriginKind): string {
  switch (originKind) {
    case 'communication':
      return 'tomorrow morning';
    case 'research':
      return 'tomorrow evening';
    case 'chief_of_staff':
    case 'daily_guidance':
      return 'today evening';
    case 'mission':
      return 'tomorrow morning';
    default:
      return 'tomorrow morning';
  }
}

function inferReminderBody(
  sourceContext: ActionBundleSourceContext,
  candidate: CompanionContinuationCandidate | undefined,
): string {
  return (
    normalizeText(candidate?.completionText) ||
    normalizeText(candidate?.missionSummary) ||
    normalizeText(candidate?.lastCommunicationSummary) ||
    normalizeText(sourceContext.summaryText) ||
    'follow up on this'
  );
}

function synthesizeMissionActions(params: {
  candidate: CompanionContinuationCandidate;
  sourceContext: ActionBundleSourceContext;
  now: string;
}): Array<{
  actionType: ActionBundleActionType;
  targetSystem: ActionBundleActionRecord['targetSystem'];
  summary: string;
  requiresConfirmation: boolean;
  payload: BundleActionPayload;
}> {
  const suggestedActions = parseJsonSafe<MissionSuggestedAction[]>(
    params.candidate.missionSuggestedActionsJson,
    [],
  );
  const actions: Array<{
    actionType: ActionBundleActionType;
    targetSystem: ActionBundleActionRecord['targetSystem'];
    summary: string;
    requiresConfirmation: boolean;
    payload: BundleActionPayload;
  }> = [];
  for (const action of suggestedActions) {
    const linkedRef = parseJsonSafe<Record<string, unknown>>(
      action.linkedRefJson,
      {},
    );
    if (action.kind === 'create_reminder') {
      actions.push({
        actionType: 'create_reminder',
        targetSystem: 'reminders',
        summary: 'Set a reminder to keep this moving',
        requiresConfirmation: true,
        payload: {
          type: 'create_reminder',
          reminderBody: inferReminderBody(params.sourceContext, params.candidate),
          timingHint: defaultReminderTiming('mission'),
        },
      });
    } else if (action.kind === 'draft_follow_up') {
      actions.push({
        actionType: 'draft_follow_up',
        targetSystem: 'communication',
        summary: action.label || 'Draft the follow-up',
        requiresConfirmation: true,
        payload: {
          type: 'draft_follow_up',
          text: 'what should I say back',
          threadTitle:
            typeof linkedRef.threadTitle === 'string'
              ? linkedRef.threadTitle
              : params.candidate.threadTitle || null,
          communicationThreadId: params.candidate.communicationThreadId || null,
          communicationSubjectIds: params.candidate.communicationSubjectIds || [],
          communicationLifeThreadIds:
            params.candidate.communicationLifeThreadIds || [],
          lastCommunicationSummary: params.candidate.lastCommunicationSummary,
        },
      });
    } else if (action.kind === 'save_to_library') {
      actions.push({
        actionType: 'save_to_library',
        targetSystem: 'knowledge_library',
        summary: 'Save the useful context to the library',
        requiresConfirmation: true,
        payload: {
          type: 'save_to_library',
          title: params.candidate.missionSummary || 'Mission note',
          content:
            params.candidate.missionSummary ||
            params.sourceContext.summaryText ||
            'Mission context',
        },
      });
    } else if (action.kind === 'link_thread' || action.kind === 'track_follow_up') {
      actions.push({
        actionType: 'save_to_thread',
        targetSystem: 'life_threads',
        summary: action.label || 'Save this under the thread',
        requiresConfirmation: true,
        payload: {
          type: 'save_to_thread',
          text: inferReminderBody(params.sourceContext, params.candidate),
          threadTitle:
            typeof linkedRef.threadTitle === 'string'
              ? linkedRef.threadTitle
              : params.candidate.threadTitle || null,
        },
      });
    } else if (action.kind === 'pin_to_ritual') {
      actions.push({
        actionType: 'pin_to_ritual',
        targetSystem: 'rituals',
        summary: action.label || 'Pin this into the evening reset',
        requiresConfirmation: true,
        payload: {
          type: 'pin_to_ritual',
          text: inferReminderBody(params.sourceContext, params.candidate),
        },
      });
    } else if (action.kind === 'reference_current_work') {
      const linkedCurrentWorkJson =
        typeof linkedRef.title === 'string' ? JSON.stringify(linkedRef) : '';
      if (linkedCurrentWorkJson) {
        actions.push({
          actionType: 'reference_current_work',
          targetSystem: 'current_work',
          summary: action.label || 'Keep current work in the execution picture',
          requiresConfirmation: false,
          payload: {
            type: 'reference_current_work',
            linkedCurrentWorkJson,
            missionId: params.candidate.missionId,
          },
        });
      }
    }
  }
  return actions;
}

function synthesizeActions(params: {
  originKind: ActionBundleOriginKind;
  candidate: CompanionContinuationCandidate;
  sourceContext: ActionBundleSourceContext;
  presentationChannel: ActionBundlePresentationChannel;
  now: string;
}): Array<{
  actionType: ActionBundleActionType;
  targetSystem: ActionBundleActionRecord['targetSystem'];
  summary: string;
  requiresConfirmation: boolean;
  payload: BundleActionPayload;
}> {
  if (params.originKind === 'mission') {
    return synthesizeMissionActions({
      candidate: params.candidate,
      sourceContext: params.sourceContext,
      now: params.now,
    });
  }

  const actions: Array<{
    actionType: ActionBundleActionType;
    targetSystem: ActionBundleActionRecord['targetSystem'];
    summary: string;
    requiresConfirmation: boolean;
    payload: BundleActionPayload;
  }> = [];
  const completionText = inferReminderBody(params.sourceContext, params.candidate);
  const threadTitle = params.candidate.threadTitle || null;

  if (params.originKind === 'communication') {
    actions.push({
      actionType: 'draft_follow_up',
      targetSystem: 'communication',
      summary: 'Draft the reply',
      requiresConfirmation: true,
      payload: {
        type: 'draft_follow_up',
        text: 'what should I say back',
        threadTitle,
        communicationThreadId: params.candidate.communicationThreadId || null,
        communicationSubjectIds: params.candidate.communicationSubjectIds || [],
        communicationLifeThreadIds: params.candidate.communicationLifeThreadIds || [],
        lastCommunicationSummary: params.candidate.lastCommunicationSummary,
      },
    });
    actions.push({
      actionType: 'create_reminder',
      targetSystem: 'reminders',
      summary: 'Set a reminder to revisit this',
      requiresConfirmation: true,
      payload: {
        type: 'create_reminder',
        reminderBody: completionText,
        timingHint: defaultReminderTiming('communication'),
      },
    });
    actions.push({
      actionType: 'save_to_thread',
      targetSystem: 'life_threads',
      summary: threadTitle
        ? `Save it under ${threadTitle}`
        : 'Save it to the thread',
      requiresConfirmation: true,
      payload: {
        type: 'save_to_thread',
        text: completionText,
        threadTitle,
      },
    });
  } else if (
    params.originKind === 'chief_of_staff' ||
    params.originKind === 'daily_guidance'
  ) {
    actions.push({
      actionType: 'create_reminder',
      targetSystem: 'reminders',
      summary: 'Set a reminder for the follow-through',
      requiresConfirmation: true,
      payload: {
        type: 'create_reminder',
        reminderBody: completionText,
        timingHint: defaultReminderTiming(params.originKind),
      },
    });
    actions.push({
      actionType: 'save_to_thread',
      targetSystem: 'life_threads',
      summary: threadTitle ? `Save it under ${threadTitle}` : 'Save it for later',
      requiresConfirmation: true,
      payload: {
        type: 'save_to_thread',
        text: completionText,
        threadTitle,
      },
    });
    actions.push({
      actionType: 'pin_to_ritual',
      targetSystem: 'rituals',
      summary: 'Pin it into the evening reset',
      requiresConfirmation: true,
      payload: {
        type: 'pin_to_ritual',
        text: completionText,
      },
    });
  } else if (params.originKind === 'research' || params.originKind === 'handoff') {
    if (
      params.presentationChannel !== 'telegram' &&
      params.candidate.handoffPayload
    ) {
      actions.push({
        actionType: 'send_to_telegram',
        targetSystem: 'cross_channel_handoffs',
        summary: 'Send the fuller version to Telegram',
        requiresConfirmation: true,
        payload: {
          type: 'send_to_telegram',
          capabilityId: params.candidate.capabilityId,
          voiceSummary: params.candidate.voiceSummary || completionText,
          payload: params.candidate.handoffPayload,
          threadId: params.candidate.threadId,
          communicationThreadId: params.candidate.communicationThreadId,
          communicationSubjectIds: params.candidate.communicationSubjectIds,
          communicationLifeThreadIds: params.candidate.communicationLifeThreadIds,
          lastCommunicationSummary: params.candidate.lastCommunicationSummary,
          missionId: params.candidate.missionId,
          missionSummary: params.candidate.missionSummary,
          missionSuggestedActionsJson: params.candidate.missionSuggestedActionsJson,
          missionBlockersJson: params.candidate.missionBlockersJson,
          missionStepFocusJson: params.candidate.missionStepFocusJson,
          knowledgeSourceIds: params.candidate.knowledgeSourceIds,
          followupSuggestions: params.candidate.followupSuggestions,
        },
      });
    }
    actions.push({
      actionType: 'save_to_library',
      targetSystem: 'knowledge_library',
      summary: 'Save the key result to the library',
      requiresConfirmation: true,
      payload: {
        type: 'save_to_library',
        title: params.candidate.handoffPayload?.title || 'Saved research note',
        content:
          params.candidate.handoffPayload?.text ||
          completionText ||
          'Saved research context',
      },
    });
    actions.push({
      actionType: 'create_reminder',
      targetSystem: 'reminders',
      summary: 'Remind me to revisit this',
      requiresConfirmation: true,
      payload: {
        type: 'create_reminder',
        reminderBody: completionText,
        timingHint: defaultReminderTiming('research'),
      },
    });
  }

  return actions;
}

function canReuseOpenBundle(snapshot: ActionBundleSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.actions.every(
    (action) => action.status === 'proposed' || action.status === 'approved',
  );
}

export function createOrRefreshActionBundle(
  params: CreateActionBundleParams,
): ActionBundleSnapshot | null {
  const candidate = params.continuationCandidate;
  if (!candidate) return null;
  const originKind = deriveOriginKind(params.capabilityId, candidate);
  if (!originKind) return null;

  const now = params.now || new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ACTION_BUNDLE_TTL_MS).toISOString();
  const sourceContext = deriveSourceContext({
    originKind,
    capabilityId: params.capabilityId,
    candidate,
    summaryText: params.summaryText,
    replyText: params.replyText,
    utterance: params.utterance,
  });
  const sourceContextKey = buildSourceContextKey({
    originKind,
    capabilityId: params.capabilityId,
    candidate,
    sourceContext,
  });
  const synthesized = synthesizeActions({
    originKind,
    candidate,
    sourceContext,
    presentationChannel: params.presentationChannel,
    now: nowIso,
  }).slice(0, MAX_ACTIONS_PER_BUNDLE);
  if (synthesized.length < 2) return null;

  const existing = findOpenActionBundleBySource(
    params.groupFolder,
    sourceContextKey,
    nowIso,
  );
  const existingSnapshot = existing
    ? getActionBundleSnapshot(existing.bundleId)
    : undefined;
  const bundleId =
    existing?.bundleId && canReuseOpenBundle(existingSnapshot)
      ? existing.bundleId
      : randomUUID();
  const record: ActionBundleRecord = {
    bundleId,
    groupFolder: params.groupFolder,
    title: deriveBundleTitle(originKind, candidate, sourceContext),
    originKind,
    originCapability: params.capabilityId || null,
    sourceContextKey,
    sourceContextJson: JSON.stringify(sourceContext),
    presentationChannel: params.presentationChannel,
    presentationChatJid: params.presentationChatJid || null,
    presentationThreadId: params.presentationThreadId || null,
    presentationMessageId:
      existing?.bundleId === bundleId ? existing.presentationMessageId || null : null,
    presentationMode:
      existing?.bundleId === bundleId ? existing.presentationMode || 'default' : 'default',
    bundleStatus: existing?.bundleId === bundleId ? existing.bundleStatus : 'open',
    userConfirmed: existing?.bundleId === bundleId ? existing.userConfirmed : false,
    createdAt: existing?.bundleId === bundleId ? existing.createdAt : nowIso,
    expiresAt,
    lastUpdatedAt: nowIso,
    relatedRefsJson: JSON.stringify(buildRelatedRefs(candidate)),
  };
  const actions: ActionBundleActionRecord[] = synthesized.map((action, index) => ({
    actionId:
      existingSnapshot?.actions.find((item) => item.orderIndex === index + 1)?.actionId ||
      randomUUID(),
    bundleId,
    orderIndex: index + 1,
    actionType: action.actionType,
    targetSystem: action.targetSystem,
    summary: action.summary,
    requiresConfirmation: action.requiresConfirmation,
    status:
      existingSnapshot?.actions.find((item) => item.orderIndex === index + 1)?.status ||
      'proposed',
    failureReason:
      existingSnapshot?.actions.find((item) => item.orderIndex === index + 1)?.failureReason ||
      null,
    payloadJson: JSON.stringify(action.payload),
    resultRefJson:
      existingSnapshot?.actions.find((item) => item.orderIndex === index + 1)?.resultRefJson ||
      null,
    createdAt:
      existingSnapshot?.actions.find((item) => item.orderIndex === index + 1)?.createdAt ||
      nowIso,
    lastUpdatedAt: nowIso,
  }));

  upsertActionBundle(record);
  replaceActionBundleActions(bundleId, actions);
  return getActionBundleSnapshot(bundleId) || null;
}

function statusPill(action: ActionBundleActionRecord, selectionMode: boolean): string {
  if (selectionMode) {
    return action.status === 'approved' ? '[x]' : '[ ]';
  }
  switch (action.status) {
    case 'executed':
      return '[done]';
    case 'failed':
      return '[needs attention]';
    case 'skipped':
      return '[skipped]';
    case 'deferred':
      return '[later]';
    case 'approved':
      return '[ready]';
    default:
      return '[ready]';
  }
}

function pendingActions(snapshot: ActionBundleSnapshot): ActionBundleActionRecord[] {
  return snapshot.actions.filter((action) =>
    ['proposed', 'approved'].includes(action.status),
  );
}

function selectedActions(snapshot: ActionBundleSnapshot): ActionBundleActionRecord[] {
  return snapshot.actions.filter((action) => action.status === 'approved');
}

export function buildActionBundlePresentation(
  snapshot: ActionBundleSnapshot,
): ActionBundlePresentation {
  const mode = snapshot.bundle.presentationMode || 'default';
  const sourceContext = parseJsonSafe<ActionBundleSourceContext>(
    snapshot.bundle.sourceContextJson,
    {},
  );
  const selectionMode = mode === 'selection';
  const lines = ['*Action bundle*', `*${snapshot.bundle.title}*`];
  if (sourceContext.whyLine) {
    lines.push(sourceContext.whyLine);
  }
  for (const action of snapshot.actions) {
    lines.push(
      `${action.orderIndex}. ${statusPill(action, selectionMode)} ${action.summary}`,
    );
  }

  const rows: ChannelInlineAction[][] = [];
  if (selectionMode) {
    for (const action of pendingActions(snapshot)) {
      rows.push([
        {
          label: `${action.status === 'approved' ? '[x]' : '[ ]'} ${action.orderIndex}. ${action.summary}`,
          actionId: `/bundle-toggle ${snapshot.bundle.bundleId} ${action.orderIndex}`,
        },
      ]);
    }
    rows.push([
      { label: 'Run selected', actionId: `/bundle-run-selected ${snapshot.bundle.bundleId}` },
      { label: 'Skip selected', actionId: `/bundle-skip-selected ${snapshot.bundle.bundleId}` },
    ]);
    rows.push([
      { label: 'Show again', actionId: `/bundle-show ${snapshot.bundle.bundleId}` },
    ]);
  } else {
    rows.push([
      { label: 'Approve all', actionId: `/bundle-run-all ${snapshot.bundle.bundleId}` },
      { label: 'Pick actions', actionId: `/bundle-pick ${snapshot.bundle.bundleId}` },
      { label: 'Not now', actionId: `/bundle-defer ${snapshot.bundle.bundleId}` },
    ]);
  }

  return {
    text: lines.join('\n'),
    inlineActionRows: rows,
    mode,
  };
}

export function buildActionBundleVoiceSummary(
  snapshot: ActionBundleSnapshot,
): ActionBundleVoiceSummary {
  const actions = pendingActions(snapshot).slice(0, 3).map((action) => action.summary.toLowerCase());
  const summary =
    actions.length > 0
      ? `I have ${actions.length === 1 ? 'one next step' : `${actions.length} next steps`} ready: ${formatList(actions)}.`
      : 'I have a bundle ready if you want me to go over it again.';
  return {
    summary,
    speech: `${summary} Say do that, just the reminder, save it for later, or send the details to Telegram.`,
  };
}

function parseOrdinalSelection(text: string, snapshot: ActionBundleSnapshot): number[] {
  const normalized = text.toLowerCase();
  if (/do the first two/.test(normalized)) return [1, 2].filter((index) => index <= snapshot.actions.length);
  if (/do the first one|do the first\b/.test(normalized)) return [1];
  const matches = [...normalized.matchAll(/\b(\d+)\b/g)]
    .map((match) => Number.parseInt(match[1] || '', 10))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= snapshot.actions.length);
  return [...new Set(matches)];
}

export function interpretActionBundleFollowup(
  utterance: string,
  snapshot: ActionBundleSnapshot,
): ActionBundleOperation | null {
  const normalized = normalizeText(utterance).toLowerCase();
  if (!normalized) return null;
  if (/^(approve all|do that|do all that|run it|do it)\b/.test(normalized)) {
    return { kind: 'approve_all' };
  }
  if (/^(show me the actions again|show again|what are the actions)\b/.test(normalized)) {
    return { kind: 'show' };
  }
  if (/^(pick actions|let me choose)\b/.test(normalized)) {
    return { kind: 'enter_selection' };
  }
  if (/^(not now|later|not right now|leave that for later)\b/.test(normalized)) {
    return { kind: 'defer_all' };
  }
  if (/^(just the reminder|only the reminder)\b/.test(normalized)) {
    return { kind: 'execute_action_type', actionType: 'create_reminder' };
  }
  if (/^(just the draft|draft it)\b/.test(normalized)) {
    return { kind: 'execute_action_type', actionType: 'draft_follow_up' };
  }
  if (/^(save but don'?t remind|save it for later)\b/.test(normalized)) {
    const threadAction = snapshot.actions.find((action) => action.actionType === 'save_to_thread');
    return {
      kind: 'execute_action_type',
      actionType: threadAction ? 'save_to_thread' : 'save_to_library',
    };
  }
  if (/^skip the reminder\b/.test(normalized)) {
    return { kind: 'skip_action_type', actionType: 'create_reminder' };
  }
  const orderIndexes = parseOrdinalSelection(normalized, snapshot);
  if (orderIndexes.length > 0) {
    return { kind: 'execute_action_indexes', orderIndexes };
  }
  return null;
}

export function rememberActionBundlePresentation(params: {
  bundleId: string;
  messageId?: string | null;
  mode?: ActionBundlePresentationMode;
  now?: Date;
}): void {
  updateActionBundle(params.bundleId, {
    presentationMessageId: params.messageId || null,
    presentationMode: params.mode,
    lastUpdatedAt: (params.now || new Date()).toISOString(),
  });
}

export function findLatestChatActionBundle(params: {
  groupFolder: string;
  presentationChannel: ActionBundlePresentationChannel;
  chatJid: string;
  now?: Date;
}): ActionBundleSnapshot | undefined {
  const record = findLatestOpenActionBundleForChat({
    groupFolder: params.groupFolder,
    presentationChannel: params.presentationChannel,
    presentationChatJid: params.chatJid,
    now: (params.now || new Date()).toISOString(),
  });
  if (!record) return undefined;
  return getActionBundleSnapshot(record.bundleId);
}

function recomputeBundleStatus(actions: ActionBundleActionRecord[]): ActionBundleStatus {
  if (actions.every((action) => action.status === 'deferred')) return 'dismissed';
  if (actions.every((action) => action.status === 'executed')) return 'done';
  if (
    actions.some((action) =>
      ['executed', 'failed', 'skipped', 'deferred'].includes(action.status),
    )
  ) {
    return 'partially_done';
  }
  return 'open';
}

function finalizeBundleUpdate(
  snapshot: ActionBundleSnapshot,
  updates: Partial<ActionBundleRecord>,
  now: Date,
): ActionBundleSnapshot | undefined {
  updateActionBundle(snapshot.bundle.bundleId, {
    ...updates,
    lastUpdatedAt: now.toISOString(),
  });
  return getActionBundleSnapshot(snapshot.bundle.bundleId);
}

function describeExecutionOutcome(params: {
  executed: string[];
  failed: string[];
  skipped: string[];
  deferred: boolean;
}): string {
  if (params.executed.length > 0 && params.failed.length === 0 && params.skipped.length === 0) {
    return `Andrea: Done — ${formatList(params.executed)}.`;
  }
  if (params.executed.length > 0 && params.failed.length > 0) {
    return `Andrea: I handled ${formatList(params.executed)}, but ${formatList(params.failed)} still needs attention.`;
  }
  if (params.executed.length > 0 && params.skipped.length > 0) {
    return `Andrea: I handled ${formatList(params.executed)} and skipped ${formatList(params.skipped)}.`;
  }
  if (params.deferred) {
    return 'Andrea: Okay — I left that bundle for later.';
  }
  if (params.failed.length > 0) {
    return `Andrea: I couldn't finish ${formatList(params.failed)} yet.`;
  }
  if (params.skipped.length > 0) {
    return `Andrea: Okay — I skipped ${formatList(params.skipped)}.`;
  }
  return 'Andrea: Okay.';
}

async function executeBundleAction(
  action: ActionBundleActionRecord,
  snapshot: ActionBundleSnapshot,
  deps: ActionBundleExecutionDeps,
): Promise<{
  ok: boolean;
  label: string;
  detailText?: string;
  failureReason?: string;
  resultRefJson?: string | null;
}> {
  const payload = parseJsonSafe<BundleActionPayload>(action.payloadJson, {} as BundleActionPayload);
  const now = deps.currentTime || (deps.now ? deps.now() : new Date());
  const relatedRefs = parseJsonSafe<ActionBundleRelatedRefs>(
    snapshot.bundle.relatedRefsJson,
    {},
  );

  if (payload.type === 'create_reminder') {
    const reminderChatJid =
      deps.chatJid ||
      deps.resolveTelegramMainChat?.(deps.groupFolder)?.chatJid ||
      undefined;
    if (!reminderChatJid) {
      return {
        ok: false,
        label: titleCaseActionType(action.actionType),
        failureReason: 'No chat is available for reminder delivery.',
      };
    }
    const planned = planContextualReminder(
      payload.timingHint,
      payload.reminderBody,
      deps.groupFolder,
      reminderChatJid,
      now,
    );
    if (!planned) {
      return {
        ok: false,
        label: 'the reminder',
        failureReason: 'I could not pin down the reminder timing yet.',
      };
    }
    createTask(planned.task);
    if (relatedRefs.missionId) {
      updateMissionAfterExecution({
        missionId: relatedRefs.missionId,
        actionKind: 'create_reminder',
        linkedReminderId: planned.task.id,
      });
    }
    return {
      ok: true,
      label: 'the reminder',
      detailText: planned.confirmation,
      resultRefJson: JSON.stringify({ taskId: planned.task.id }),
    };
  }

  if (payload.type === 'draft_follow_up') {
    const draft = draftCommunicationReply({
      channel: deps.channel,
      groupFolder: deps.groupFolder,
      chatJid: deps.chatJid,
      text: payload.text,
      conversationSummary:
        payload.lastCommunicationSummary || snapshot.bundle.title,
      priorContext: {
        threadTitle: payload.threadTitle || undefined,
        communicationThreadId: payload.communicationThreadId || undefined,
        communicationSubjectIds: payload.communicationSubjectIds || [],
        communicationLifeThreadIds: payload.communicationLifeThreadIds || [],
        lastCommunicationSummary: payload.lastCommunicationSummary || undefined,
      },
      now,
    });
    if (!draft.ok) {
      return {
        ok: false,
        label: 'the draft',
        failureReason:
          draft.clarificationQuestion || 'The draft still needs one more detail.',
      };
    }
    return {
      ok: true,
      label: 'the draft',
      detailText: formatCommunicationDraftReply(deps.channel, draft),
      resultRefJson: JSON.stringify({
        communicationThreadId: draft.thread?.id || payload.communicationThreadId || null,
      }),
    };
  }

  if (payload.type === 'save_to_thread') {
    const result = handleLifeThreadCommand({
      groupFolder: deps.groupFolder,
      channel: deps.channel,
      chatJid: deps.chatJid,
      text: payload.threadTitle
        ? `track this under ${payload.threadTitle} thread`
        : 'save this for later',
      replyText: payload.text,
      conversationSummary: snapshot.bundle.title,
      now,
    });
    if (!result.handled) {
      return {
        ok: false,
        label: 'the thread save',
        failureReason: 'I could not place that under the right thread yet.',
      };
    }
    if (relatedRefs.missionId && result.referencedThread) {
      updateMissionAfterExecution({
        missionId: relatedRefs.missionId,
        actionKind: 'link_thread',
        linkedLifeThreadId: result.referencedThread.id,
      });
    }
    return {
      ok: true,
      label: 'the thread save',
      detailText: result.responseText || 'Andrea: I saved that under the thread.',
      resultRefJson: JSON.stringify({
        threadId: result.referencedThread?.id || null,
      }),
    };
  }

  if (payload.type === 'save_to_library') {
    const saved = saveKnowledgeSource({
      groupFolder: deps.groupFolder,
      title: payload.title,
      content: payload.content,
      sourceType: 'generated_note',
      sourceChannel: deps.channel === 'alexa' ? 'alexa' : deps.channel,
      now,
    });
    if (!saved.ok || !saved.source) {
      return {
        ok: false,
        label: 'the library save',
        failureReason: saved.message,
      };
    }
    if (relatedRefs.missionId) {
      updateMissionAfterExecution({
        missionId: relatedRefs.missionId,
        actionKind: 'save_to_library',
        linkedKnowledgeSourceId: saved.source.sourceId,
      });
    }
    return {
      ok: true,
      label: 'the library save',
      detailText: saved.message,
      resultRefJson: JSON.stringify({ sourceId: saved.source.sourceId }),
    };
  }

  if (payload.type === 'pin_to_ritual') {
    const result = handleRitualCommand({
      groupFolder: deps.groupFolder,
      channel: deps.channel,
      chatJid: deps.chatJid,
      text: 'make this part of my evening reset',
      replyText: payload.text,
      conversationSummary: snapshot.bundle.title,
      priorContext: relatedRefs.threadId ? { usedThreadIds: [relatedRefs.threadId] } : undefined,
      now,
    });
    if (!result.handled) {
      return {
        ok: false,
        label: 'the ritual pin',
        failureReason: 'I could not pin that into the ritual yet.',
      };
    }
    return {
      ok: true,
      label: 'the ritual pin',
      detailText: result.responseText || 'Andrea: I added that to your evening reset.',
    };
  }

  if (payload.type === 'send_to_telegram') {
    const delivery = await deliverCompanionHandoff(
      {
        groupFolder: deps.groupFolder,
        originChannel: deps.channel,
        targetChannel: 'telegram',
        capabilityId: payload.capabilityId,
        voiceSummary: payload.voiceSummary,
        payload: payload.payload,
        threadId: payload.threadId,
        communicationThreadId: payload.communicationThreadId,
        communicationSubjectIds: payload.communicationSubjectIds,
        communicationLifeThreadIds: payload.communicationLifeThreadIds,
        lastCommunicationSummary: payload.lastCommunicationSummary,
        missionId: payload.missionId,
        missionSummary: payload.missionSummary,
        missionSuggestedActionsJson: payload.missionSuggestedActionsJson,
        missionBlockersJson: payload.missionBlockersJson,
        missionStepFocusJson: payload.missionStepFocusJson,
        knowledgeSourceIds: payload.knowledgeSourceIds,
        followupSuggestions: payload.followupSuggestions,
      },
      deps as CompanionHandoffDeps,
    );
    if (!delivery.ok) {
      return {
        ok: false,
        label: 'the Telegram handoff',
        failureReason: delivery.errorText || delivery.speech,
      };
    }
    return {
      ok: true,
      label: 'the Telegram handoff',
      detailText: delivery.speech,
      resultRefJson: JSON.stringify({ handoffId: delivery.handoffId }),
    };
  }

  if (payload.type === 'reference_current_work') {
    if (payload.missionId) {
      updateMissionAfterExecution({
        missionId: payload.missionId,
        actionKind: 'reference_current_work',
        linkedCurrentWorkJson: payload.linkedCurrentWorkJson,
      });
    }
    return {
      ok: true,
      label: 'the current-work link',
      detailText: 'Andrea: Done — I kept that current work context attached.',
      resultRefJson: JSON.stringify({ linkedCurrentWorkJson: payload.linkedCurrentWorkJson }),
    };
  }

  return {
    ok: false,
    label: titleCaseActionType(action.actionType),
    failureReason: 'That bundle action is not supported yet.',
  };
}

async function executeActions(
  snapshot: ActionBundleSnapshot,
  actions: ActionBundleActionRecord[],
  deps: ActionBundleExecutionDeps,
): Promise<ActionBundleOperationResult> {
  const currentTime = deps.currentTime || (deps.now ? deps.now() : new Date());
  const executed: string[] = [];
  const failed: string[] = [];
  const detailTexts: string[] = [];
  for (const action of actions) {
    if (['executed', 'skipped', 'deferred'].includes(action.status)) continue;
    updateActionBundleAction(action.actionId, {
      status: 'approved',
      lastUpdatedAt: currentTime.toISOString(),
      failureReason: null,
    });
    const result = await executeBundleAction(action, snapshot, {
      ...deps,
      currentTime,
    });
    if (result.ok) {
      updateActionBundleAction(action.actionId, {
        status: 'executed',
        lastUpdatedAt: currentTime.toISOString(),
        failureReason: null,
        resultRefJson: result.resultRefJson || null,
      });
      executed.push(result.label);
      if (result.detailText) detailTexts.push(result.detailText);
    } else {
      updateActionBundleAction(action.actionId, {
        status: 'failed',
        lastUpdatedAt: currentTime.toISOString(),
        failureReason: result.failureReason || 'Bundle action failed',
      });
      failed.push(result.label);
    }
  }
  const refreshed = getActionBundleSnapshot(snapshot.bundle.bundleId);
  if (!refreshed) return { handled: false };
  const bundleStatus = recomputeBundleStatus(refreshed.actions);
  const finalSnapshot = finalizeBundleUpdate(
    refreshed,
      {
        bundleStatus,
        userConfirmed: true,
        presentationMode: 'default',
      },
      currentTime,
    );
  const replyParts = [describeExecutionOutcome({ executed, failed, skipped: [], deferred: false })];
  if (detailTexts.length === 1 && executed.length === 1 && actions.length === 1) {
    replyParts.push(detailTexts[0]!);
  } else if (detailTexts.length > 0 && executed.includes('the draft')) {
    const draftText = detailTexts.find((text) => /draft:/i.test(text));
    if (draftText) replyParts.push(draftText);
  }
  return {
    handled: true,
    snapshot: finalSnapshot,
    presentation: finalSnapshot ? buildActionBundlePresentation(finalSnapshot) : undefined,
    replyText: replyParts.filter(Boolean).join('\n\n'),
  };
}

export async function applyActionBundleOperation(
  bundleId: string,
  operation: ActionBundleOperation,
  deps: ActionBundleExecutionDeps,
): Promise<ActionBundleOperationResult> {
  const snapshot = getActionBundleSnapshot(bundleId);
  if (!snapshot) return { handled: false };
  const now = deps.currentTime || (deps.now ? deps.now() : new Date());

  if (operation.kind === 'show') {
    const next = finalizeBundleUpdate(
      snapshot,
      { presentationMode: 'default' },
      now,
    );
    return {
      handled: true,
      snapshot: next,
      presentation: next ? buildActionBundlePresentation(next) : undefined,
    };
  }

  if (operation.kind === 'enter_selection') {
    const next = finalizeBundleUpdate(
      snapshot,
      { presentationMode: 'selection' },
      now,
    );
    return {
      handled: true,
      snapshot: next,
      presentation: next ? buildActionBundlePresentation(next) : undefined,
    };
  }

  if (operation.kind === 'toggle_action') {
    const action = snapshot.actions.find((item) => item.orderIndex === operation.orderIndex);
    if (!action || !['proposed', 'approved'].includes(action.status)) {
      return { handled: false };
    }
    updateActionBundleAction(action.actionId, {
      status: action.status === 'approved' ? 'proposed' : 'approved',
      lastUpdatedAt: now.toISOString(),
    });
    const next = finalizeBundleUpdate(snapshot, { presentationMode: 'selection' }, now);
    return {
      handled: true,
      snapshot: next,
      presentation: next ? buildActionBundlePresentation(next) : undefined,
    };
  }

  if (operation.kind === 'defer_all') {
    for (const action of pendingActions(snapshot)) {
      updateActionBundleAction(action.actionId, {
        status: 'deferred',
        lastUpdatedAt: now.toISOString(),
      });
    }
    const next = finalizeBundleUpdate(
      snapshot,
      { bundleStatus: 'dismissed', presentationMode: 'default' },
      now,
    );
    return {
      handled: true,
      snapshot: next,
      presentation: next ? buildActionBundlePresentation(next) : undefined,
      replyText: describeExecutionOutcome({
        executed: [],
        failed: [],
        skipped: [],
        deferred: true,
      }),
    };
  }

  if (operation.kind === 'skip_selected') {
    const selected = selectedActions(snapshot);
    for (const action of selected) {
      updateActionBundleAction(action.actionId, {
        status: 'skipped',
        lastUpdatedAt: now.toISOString(),
      });
    }
    const refreshed = getActionBundleSnapshot(bundleId);
    if (!refreshed) return { handled: false };
    const next = finalizeBundleUpdate(
      refreshed,
      { bundleStatus: recomputeBundleStatus(refreshed.actions), presentationMode: 'default' },
      now,
    );
    return {
      handled: true,
      snapshot: next,
      presentation: next ? buildActionBundlePresentation(next) : undefined,
      replyText: describeExecutionOutcome({
        executed: [],
        failed: [],
        skipped: selected.map((action) => action.summary.toLowerCase()),
        deferred: false,
      }),
    };
  }

  if (operation.kind === 'skip_action_type') {
    const target = pendingActions(snapshot).filter((action) => action.actionType === operation.actionType);
    for (const action of target) {
      updateActionBundleAction(action.actionId, {
        status: 'skipped',
        lastUpdatedAt: now.toISOString(),
      });
    }
    const refreshed = getActionBundleSnapshot(bundleId);
    if (!refreshed) return { handled: false };
    const next = finalizeBundleUpdate(
      refreshed,
      { bundleStatus: recomputeBundleStatus(refreshed.actions), presentationMode: 'default' },
      now,
    );
    return {
      handled: true,
      snapshot: next,
      presentation: next ? buildActionBundlePresentation(next) : undefined,
      replyText: describeExecutionOutcome({
        executed: [],
        failed: [],
        skipped: target.map((action) => action.summary.toLowerCase()),
        deferred: false,
      }),
    };
  }

  if (operation.kind === 'approve_all') {
    return executeActions(snapshot, pendingActions(snapshot), deps);
  }

  if (operation.kind === 'run_selected') {
    return executeActions(snapshot, selectedActions(snapshot), deps);
  }

  if (operation.kind === 'execute_action_type') {
    return executeActions(
      snapshot,
      pendingActions(snapshot).filter((action) => action.actionType === operation.actionType),
      deps,
    );
  }

  if (operation.kind === 'execute_action_indexes') {
    const indexSet = new Set(operation.orderIndexes);
    return executeActions(
      snapshot,
      pendingActions(snapshot).filter((action) => indexSet.has(action.orderIndex)),
      deps,
    );
  }

  return { handled: false };
}
