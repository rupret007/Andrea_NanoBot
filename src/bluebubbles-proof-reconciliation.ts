import { listMessageActionsForGroup, listMessagesForChatWindow } from './db.js';
import {
  canonicalizeBlueBubblesSelfThreadJid,
  getBlueBubblesCanonicalSelfThreadJid,
  getBlueBubblesSelfThreadAliasJids,
  isBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
import {
  isBlueBubblesProofDrillAction,
  reconcileBlueBubblesSelfThreadContinuity,
} from './message-actions.js';
import type {
  BlueBubblesProofReconciliationReport,
  BlueBubblesProofTimelineEntry,
  MessageActionRecord,
  NewMessage,
} from './types.js';

const DEFAULT_WINDOW_HOURS = 48;
const DEFAULT_FRESHNESS_HOURS = 24;

function canonicalSelfThread(chatJid: string | null | undefined): string {
  if (!chatJid) return 'none';
  return canonicalizeBlueBubblesSelfThreadJid(chatJid || null) || chatJid;
}

function parseJsonRecord(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function shapeMessageContent(content: string): string {
  const normalized = content.toLowerCase();
  const labels: string[] = [];
  if (normalized.includes('@andrea')) labels.push('@andrea');
  if (/\bstart (?:blue ?bubbles )?proof\b/.test(normalized)) {
    labels.push('proof_start');
  }
  if (normalized.includes('send it later')) labels.push('send_later');
  if (normalized.includes('what should i say')) labels.push('reply_help');
  if (normalized.includes('what am i forgetting')) labels.push('forgetting');
  if (/\bproof drill\b.*\b(?:recorded|ready|deferred)\b/.test(normalized)) {
    labels.push('proof_confirmation');
  }
  if (/\b(?:saved|queued|remind|bring it back)\b/.test(normalized)) {
    labels.push('defer_confirmation');
  }
  if (/^\s*(?:hi|hello|hey)\b/.test(normalized)) labels.push('greeting');
  return labels.length > 0 ? labels.join('+') : `${content.length}_chars`;
}

function messageDirection(
  message: NewMessage,
): BlueBubblesProofTimelineEntry['direction'] {
  if (message.is_bot_message) return 'outbound';
  return message.is_from_me ? 'local_self' : 'inbound';
}

function actionPresentationOrTargetChat(action: MessageActionRecord): string {
  const target = parseJsonRecord(action.targetConversationJson);
  const targetChatJid =
    typeof target.chatJid === 'string' ? target.chatJid : null;
  const presentation = canonicalSelfThread(action.presentationChatJid);
  if (presentation !== 'none') return presentation;
  return canonicalSelfThread(targetChatJid);
}

function actionTouchesSelfThread(action: MessageActionRecord): boolean {
  if (isBlueBubblesSelfThreadAliasJid(action.presentationChatJid)) return true;
  const target = parseJsonRecord(action.targetConversationJson);
  if (
    typeof target.chatJid === 'string' &&
    isBlueBubblesSelfThreadAliasJid(target.chatJid)
  ) {
    return true;
  }
  const linkedRefs = parseJsonRecord(action.linkedRefsJson);
  return (
    typeof linkedRefs.chatJid === 'string' &&
    isBlueBubblesSelfThreadAliasJid(linkedRefs.chatJid)
  );
}

function actionObservedAt(action: MessageActionRecord): string {
  return (
    action.lastActionAt ||
    action.sentAt ||
    action.lastUpdatedAt ||
    action.createdAt
  );
}

function isDecisionLikeAction(action: MessageActionRecord): boolean {
  if (action.targetChannel !== 'bluebubbles') return false;
  if (action.targetKind !== 'external_thread') return false;
  if (action.sendStatus === 'skipped') return false;
  if (action.sendStatus === 'sent') return true;
  if (action.sendStatus === 'deferred') {
    return (
      action.lastActionKind === 'scheduled_send' ||
      action.lastActionKind === 'remind_instead' ||
      action.lastActionKind === 'save_to_thread' ||
      isBlueBubblesProofDrillAction(action)
    );
  }
  return ['scheduled_send', 'remind_instead', 'save_to_thread'].includes(
    action.lastActionKind || '',
  );
}

function isConfirmationMessage(message: NewMessage): boolean {
  if (!message.is_bot_message) return false;
  const shape = shapeMessageContent(message.content || '');
  return (
    shape.includes('proof_confirmation') ||
    shape.includes('defer_confirmation') ||
    /^19_chars$/.test(shape) ||
    /^36_chars$/.test(shape)
  );
}

function maxIso(values: string[]): string {
  return (
    values
      .filter((value) => value && value !== 'none')
      .sort()
      .at(-1) || 'none'
  );
}

export function buildBlueBubblesProofReconciliationReport(
  params: {
    groupFolder?: string;
    now?: Date;
    windowHours?: number;
    freshnessHours?: number;
  } = {},
): BlueBubblesProofReconciliationReport {
  const now = params.now || new Date();
  const groupFolder = params.groupFolder || 'main';
  const windowMs =
    Math.max(1, params.windowHours || DEFAULT_WINDOW_HOURS) * 60 * 60 * 1000;
  const freshnessMs =
    Math.max(1, params.freshnessHours || DEFAULT_FRESHNESS_HOURS) *
    60 *
    60 *
    1000;
  const windowStart = new Date(now.getTime() - windowMs).toISOString();
  const windowEnd = now.toISOString();
  const freshnessCutoff = now.getTime() - freshnessMs;
  const canonicalJid = getBlueBubblesCanonicalSelfThreadJid();
  const aliasJids = [...new Set(getBlueBubblesSelfThreadAliasJids())];

  const messages = aliasJids.flatMap((chatJid) =>
    listMessagesForChatWindow({
      chatJid,
      startTimestamp: windowStart,
      endTimestamp: windowEnd,
      limit: 300,
    }),
  );
  const actionCandidates = listMessageActionsForGroup({
    groupFolder,
    includeSent: true,
    limit: 250,
  }).filter((action) => {
    if (action.targetChannel !== 'bluebubbles') return false;
    if (!actionTouchesSelfThread(action)) return false;
    const observedMs = Date.parse(actionObservedAt(action));
    return Number.isFinite(observedMs) && observedMs >= Date.parse(windowStart);
  });

  const actionEntries: BlueBubblesProofTimelineEntry[] = actionCandidates.map(
    (action) => {
      const chatJid = actionPresentationOrTargetChat(action);
      return {
        at: actionObservedAt(action),
        kind: 'message_action',
        chatJid,
        canonicalChatJid: canonicalSelfThread(chatJid),
        messageActionId: action.messageActionId,
        actionStatus: action.sendStatus,
        actionKind: action.lastActionKind || null,
        proofEligible: isDecisionLikeAction(action),
        detail: isBlueBubblesProofDrillAction(action)
          ? 'proof_drill_action'
          : action.sendStatus === 'skipped'
            ? 'skipped_action'
            : 'message_action',
      };
    },
  );
  const messageEntries: BlueBubblesProofTimelineEntry[] = messages.map(
    (message) => ({
      at: message.timestamp,
      kind: 'message',
      chatJid: message.chat_jid,
      canonicalChatJid: canonicalSelfThread(message.chat_jid),
      direction: messageDirection(message),
      contentShape: shapeMessageContent(message.content || ''),
      messageId: message.id,
      proofEligible: false,
      detail: message.is_bot_message ? 'bot_message' : 'user_or_self_message',
    }),
  );
  const timeline = [...messageEntries, ...actionEntries].sort((left, right) =>
    left.at.localeCompare(right.at),
  );

  const canonicalMessages = messages.filter(
    (message) => canonicalSelfThread(message.chat_jid) === canonicalJid,
  );
  const lastInboundAt = maxIso(
    canonicalMessages
      .filter((message) => !message.is_bot_message)
      .map((message) => message.timestamp),
  );
  const lastOutboundAt = maxIso(
    canonicalMessages
      .filter((message) => message.is_bot_message)
      .map((message) => message.timestamp),
  );

  const decisionActions = actionCandidates
    .filter((action) => isDecisionLikeAction(action))
    .map((action) => ({
      action,
      at: actionObservedAt(action),
      chatJid: actionPresentationOrTargetChat(action),
      atMs: Date.parse(actionObservedAt(action)),
    }))
    .filter(
      (entry) => entry.chatJid === canonicalJid && Number.isFinite(entry.atMs),
    )
    .sort((left, right) => right.atMs - left.atMs);
  const skippedActions = actionCandidates
    .filter((action) => action.sendStatus === 'skipped')
    .sort(
      (left, right) =>
        Date.parse(actionObservedAt(right)) -
        Date.parse(actionObservedAt(left)),
    );
  const lastDecision = decisionActions[0] || null;
  const confirmation = lastDecision
    ? canonicalMessages
        .filter((message) => {
          const messageMs = Date.parse(message.timestamp);
          return (
            Number.isFinite(messageMs) &&
            messageMs >= lastDecision.atMs &&
            isConfirmationMessage(message)
          );
        })
        .sort((left, right) =>
          left.timestamp.localeCompare(right.timestamp),
        )[0] || null
    : null;
  const continuity = reconcileBlueBubblesSelfThreadContinuity({
    groupFolder,
    chatJid: canonicalJid,
    now,
    allowRehydrate: true,
  });
  const activeActionId = continuity.activeMessageActionId || 'none';
  const activeActionChatJid =
    continuity.activeAction?.presentationChatJid ||
    continuity.recentTargetChatJid ||
    'none';

  let messageActionProofState: BlueBubblesProofReconciliationReport['messageActionProofState'] =
    'none';
  let blockerCategory: BlueBubblesProofReconciliationReport['blockerCategory'] =
    'no_action';
  let blocker =
    'No BlueBubbles message-action decision is recorded in the canonical self-thread yet.';
  let nextAction =
    'In the canonical self-thread, ask `@Andrea start bluebubbles proof`, then reply `@Andrea send it later tonight`.';

  if (lastDecision) {
    if (lastDecision.atMs < freshnessCutoff) {
      messageActionProofState = 'stale';
      blockerCategory = 'stale';
      blocker =
        'A BlueBubbles message-action decision exists, but it is outside the fresh proof window.';
      nextAction =
        'Repeat the proof drill in the canonical self-thread and defer it with `@Andrea send it later tonight`.';
    } else if (!confirmation) {
      messageActionProofState = 'stale';
      blockerCategory = 'awaiting_confirmation';
      blocker =
        'A fresh BlueBubbles deferred/decision action exists, but Andrea confirmation in the same canonical thread is not recorded yet.';
      nextAction =
        'Send one more same-thread `@Andrea hi` or rerun the proof drill so Andrea posts a confirmation in that same thread.';
    } else {
      messageActionProofState = 'fresh';
      blockerCategory = 'none';
      blocker = 'none';
      nextAction =
        'No BlueBubbles proof action needed; keep periodic proof fresh after restarts.';
    }
  } else if (activeActionId !== 'none') {
    blockerCategory = 'awaiting_decision';
    blocker =
      'A BlueBubbles draft/action is active in the canonical self-thread, but it has not received a safe decision yet.';
    nextAction =
      'Reply in the same self-thread with `@Andrea send it later tonight`.';
  } else if (skippedActions.length > 0) {
    blockerCategory = 'skipped';
    blocker =
      'The most recent tracked BlueBubbles action in the proof window was skipped, so it cannot promote proof.';
  } else if (lastInboundAt === 'none' && lastOutboundAt === 'none') {
    blockerCategory = 'no_canonical_traffic';
    blocker =
      'No recent canonical self-thread BlueBubbles traffic is recorded in the proof window.';
  }

  return {
    generatedAt: windowEnd,
    groupFolder,
    canonicalSelfThreadChatJid: canonicalJid,
    aliasJids,
    windowStart,
    windowEnd,
    timeline,
    activeActionId,
    activeActionChatJid,
    lastInboundAt,
    lastOutboundAt,
    lastDecisionAt: lastDecision?.at || 'none',
    lastDecisionActionId: lastDecision?.action.messageActionId || 'none',
    lastDecisionChatJid: lastDecision?.chatJid || 'none',
    confirmationAt: confirmation?.timestamp || 'none',
    messageActionProofState,
    blockerCategory,
    blocker,
    nextAction,
    privacy: {
      rawMessageBodiesStored: false,
      contentShapeOnly: true,
    },
  };
}

export function formatBlueBubblesProofReconciliationReport(
  report: BlueBubblesProofReconciliationReport,
): string {
  const entries = report.timeline.slice(-16).map((entry) => {
    if (entry.kind === 'message') {
      return `${entry.at} message ${entry.direction} ${entry.chatJid} shape=${entry.contentShape}`;
    }
    return `${entry.at} action ${entry.actionStatus}/${entry.actionKind || 'none'} ${entry.chatJid} proof=${entry.proofEligible ? 'yes' : 'no'} id=${entry.messageActionId}`;
  });
  return [
    'BLUEBUBBLES PROOF TIMELINE',
    `canonical_self_thread: ${report.canonicalSelfThreadChatJid}`,
    `aliases: ${report.aliasJids.join(', ')}`,
    `window: ${report.windowStart} -> ${report.windowEnd}`,
    `message_action_proof_state: ${report.messageActionProofState}`,
    `last_inbound_at: ${report.lastInboundAt}`,
    `last_outbound_at: ${report.lastOutboundAt}`,
    `last_decision_at: ${report.lastDecisionAt}`,
    `last_decision_action: ${report.lastDecisionActionId}`,
    `confirmation_at: ${report.confirmationAt}`,
    `active_action: ${report.activeActionId}`,
    `blocker_category: ${report.blockerCategory}`,
    `blocker: ${report.blocker}`,
    `next_action: ${report.nextAction}`,
    'privacy: content-shape-only, no raw private message bodies',
    '',
    ...entries,
  ].join('\n');
}
