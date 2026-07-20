/* eslint-disable no-catch-all/no-catch-all -- Isolated crash-worker errors are returned as bounded fixture evidence. */
import fs from 'node:fs';

import '../../src/channels/index.js';

import {
  executeBlueBubblesOutboundRequest,
  type ExecuteBlueBubblesOutboundRequestResult,
} from '../../src/bluebubbles-outbound-request.js';
import { recordBlueBubblesOutboundDeliveryEvidence } from '../../src/bluebubbles-delivery-recovery.js';
import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  claimBlueBubblesMessageActionDispatch,
  getMessageAction,
  listMessageActionsForGroup,
  updateMessageAction,
  updateMessageActionIfSendStatus,
} from '../../src/db.js';
import {
  applyMessageActionOperation,
  createOrRefreshMessageActionFromDraft,
} from '../../src/message-actions.js';
import { registerProductionRuntimeCapabilitySurfaces } from '../../src/runtime-capability-production-surfaces.js';
import { runtimeCapabilityRegistry } from '../../src/runtime-capability-registry.js';
import type {
  RegisteredGroup,
  SendMessageOptions,
  SendMessageResult,
} from '../../src/types.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

type WorkerKind =
  | 'initialize'
  | 'stage'
  | 'stage_request'
  | 'approve'
  | 'inspect'
  | 'recover_and_replay'
  | 'race_approve'
  | 'stale_explicit_claim'
  | 'mutate_staged_action';

interface ProviderEffect {
  endpoint: '/api/v1/chat/new' | '/api/v1/message/text';
  receiptId: string;
  chatJid: string;
  addresses: string[];
  message: string;
  method: string;
  service: string | null;
  tempGuid: string;
  observedAt: string;
}

interface WorkerCommand {
  kind: WorkerKind;
  databasePath: string;
  providerBaseUrl?: string;
  barrierPath?: string;
  workerId?: string;
  approvalText?: string;
  providerEffect?: ProviderEffect;
}

const GROUP_FOLDER = 'main';
const SOURCE_CHANNEL = 'telegram' as const;
const SOURCE_CHAT_JID = 'tg:main';
const INBOUND_MESSAGE_ID = 'tg:bluebubbles-hard-kill-inbound-1';
const REQUEST_AT = new Date('2026-07-16T12:00:00.000Z');
const TARGET_CHAT_JID = 'bb:iMessage;-;+12025550123';
const TARGET_ADDRESS = '+12025550123';
const REQUEST = 'Text Travis Story: Hi from Andrea.';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: GROUP_FOLDER,
  trigger: '@Andrea',
  added_at: '2026-07-16T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const READY_CAPABILITY_FACTS = {
  toolRegistered: true,
  toolExposed: true,
  providerHealth: 'healthy' as const,
  writePermission: 'granted' as const,
  confirmation: 'satisfied' as const,
};

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseExplanation(value: string | null): Record<string, unknown> {
  try {
    return parseRecord(JSON.parse(value || '{}'));
  } catch {
    return {};
  }
}

function summarizeAction(action: ReturnType<typeof getMessageAction>) {
  if (!action) return null;
  const explanation = parseExplanation(action.explanationJson);
  return {
    messageActionId: action.messageActionId,
    sourceKey: action.sourceKey,
    sendStatus: action.sendStatus,
    platformMessageId: action.platformMessageId,
    draftText: action.draftText,
    targetConversationJson: action.targetConversationJson,
    approvedAt: action.approvedAt,
    presentationMessageId: action.presentationMessageId,
    lastUpdatedAt: action.lastUpdatedAt,
    dispatchAttempt: parseRecord(explanation.dispatchAttempt),
    executionReceipt: parseRecord(explanation.executionReceipt),
  };
}

function stageDraftAction() {
  return createOrRefreshMessageActionFromDraft({
    groupFolder: GROUP_FOLDER,
    presentationChannel: SOURCE_CHANNEL,
    presentationChatJid: SOURCE_CHAT_JID,
    sourceType: 'manual_prompt',
    sourceKey: 'stale-explicit-approval-race',
    sourceSummary: 'Staged BlueBubbles CAS race action.',
    draftText: 'Original bytes approved by the stale process.',
    personName: 'Travis Story',
    threadTitle: 'Travis Story',
    communicationContext: 'general',
    forceApproval: true,
    targetOverride: {
      kind: 'external_thread',
      chatJid: TARGET_CHAT_JID,
      threadId: null,
      replyToMessageId: null,
      isGroup: false,
      personName: 'Travis Story',
      blueBubblesCreateChatAddress: TARGET_ADDRESS,
    },
    targetChannelOverride: 'bluebubbles',
    now: REQUEST_AT,
  });
}

function onlyAction() {
  const actions = listMessageActionsForGroup({
    groupFolder: GROUP_FOLDER,
    includeSent: true,
    limit: 20,
  });
  if (actions.length !== 1) {
    throw new Error(`Expected one message action, observed ${actions.length}.`);
  }
  return actions[0]!;
}

async function postToFakeProvider(
  providerBaseUrl: string,
  chatJid: string,
  text: string,
  options?: SendMessageOptions,
): Promise<SendMessageResult> {
  const firstContactAddress = options?.blueBubblesCreateChatAddress;
  const endpoint = firstContactAddress
    ? '/api/v1/chat/new'
    : '/api/v1/message/text';
  const body = firstContactAddress
    ? {
        addresses: [firstContactAddress],
        message: text,
        method: 'private-api',
        service: 'iMessage',
        tempGuid: options?.idempotencyKey,
      }
    : {
        chatGuid: chatJid.replace(/^bb:/, ''),
        message: text,
        tempGuid: options?.idempotencyKey,
        method: 'private-api',
      };
  const response = await fetch(new URL(endpoint, providerBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = parseRecord(await response.json());
  if (!response.ok || typeof payload.receiptId !== 'string') {
    throw new Error('The deterministic BlueBubbles provider rejected POST.');
  }
  return {
    platformMessageId: payload.receiptId,
    threadId: typeof payload.threadId === 'string' ? payload.threadId : chatJid,
  };
}

async function executeRequest(
  providerBaseUrl: string,
): Promise<ExecuteBlueBubblesOutboundRequestResult> {
  return executeBlueBubblesOutboundRequest({
    groupFolder: GROUP_FOLDER,
    channel: SOURCE_CHANNEL,
    chatJid: SOURCE_CHAT_JID,
    group: MAIN_GROUP,
    rawText: REQUEST,
    inboundMessageId: INBOUND_MESSAGE_ID,
    recipientResolution: {
      state: 'resolved',
      target: {
        chatJid: TARGET_CHAT_JID,
        displayName: 'Travis Story',
        isGroup: false,
        blueBubblesCreateChatAddress: TARGET_ADDRESS,
      },
    },
    now: REQUEST_AT,
    capabilityFacts: READY_CAPABILITY_FACTS,
    executionDeps: {
      groupFolder: GROUP_FOLDER,
      channel: SOURCE_CHANNEL,
      chatJid: SOURCE_CHAT_JID,
      currentTime: REQUEST_AT,
      sendToTarget: (_targetChannel, chatJid, text, options) =>
        postToFakeProvider(providerBaseUrl, chatJid, text, options),
    },
  });
}

async function stageInitialRequest(providerBaseUrl: string) {
  const result = await executeRequest(providerBaseUrl);
  if (!result.handled || result.state !== 'staged') {
    throw new Error('The initial Text request must produce an unsent draft.');
  }
  updateMessageAction(result.action.messageActionId, {
    presentationMessageId: `tg:draft-card:${result.action.messageActionId}`,
    lastUpdatedAt: '2026-07-16T12:00:00.500Z',
  });
  return {
    state: result.state,
    action: onlyAction(),
  };
}

async function approveStagedRequest(
  providerBaseUrl: string,
  approvalText: string | undefined,
  options?: {
    expectedMessageActionId?: string;
    acceptObservedCompetingDispatch?: boolean;
  },
) {
  if (!/^(?:send now|send it)$/i.test(approvalText?.trim() || '')) {
    throw new Error('Approval must be a fresh Send now/send it turn.');
  }
  const staged = onlyAction();
  if (
    options?.expectedMessageActionId &&
    staged.messageActionId !== options.expectedMessageActionId
  ) {
    throw new Error('Approval race resolved a different message action.');
  }
  if (staged.sendStatus !== 'drafted' || !staged.presentationMessageId) {
    if (
      options?.acceptObservedCompetingDispatch &&
      staged.presentationMessageId &&
      ['delivery_unverified', 'sent'].includes(staged.sendStatus)
    ) {
      return {
        state: staged.sendStatus,
        action: staged,
      };
    }
    throw new Error('Fresh approval requires a delivered, unsent draft card.');
  }
  const result = await applyMessageActionOperation(
    staged.messageActionId,
    { kind: 'send' },
    {
      groupFolder: GROUP_FOLDER,
      channel: SOURCE_CHANNEL,
      chatJid: SOURCE_CHAT_JID,
      currentTime: new Date('2026-07-16T12:00:01.000Z'),
      sendToTarget: (_targetChannel, chatJid, text, options) =>
        postToFakeProvider(providerBaseUrl, chatJid, text, options),
    },
  );
  if (!result.action) {
    throw new Error('Fresh approval did not resolve a message action.');
  }
  return {
    state: result.action.sendStatus,
    action: result.action,
  };
}

async function waitForBarrier(barrierPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(barrierPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The BlueBubbles race barrier timed out.');
}

async function sendToParent(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('BlueBubbles fixture requires an IPC parent.'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function recoverAndReplay(command: WorkerCommand) {
  const effect = command.providerEffect;
  if (!effect || !command.providerBaseUrl) {
    throw new Error('Recovery requires provider effect evidence and endpoint.');
  }
  const fenced = onlyAction();
  const explanation = parseExplanation(fenced.explanationJson);
  const attempt = parseRecord(explanation.dispatchAttempt);
  if (attempt.idempotencyKey !== effect.tempGuid) {
    throw new Error('Provider evidence does not match the fenced action key.');
  }

  const uncorrelatedRecovery = recordBlueBubblesOutboundDeliveryEvidence({
    chatJid: effect.chatJid,
    message: {
      id: 'bb:uncorrelated-identical-row',
      chat_jid: effect.chatJid,
      sender: 'Me',
      sender_name: 'You',
      content: effect.message,
      timestamp: effect.observedAt,
      is_from_me: true,
      is_bot_message: false,
      provider_idempotency_key: 'different-first-contact-action',
    },
    groupFolders: [GROUP_FOLDER],
    now: new Date('2026-07-16T12:00:10.000Z'),
  });

  const correlatedRecovery = recordBlueBubblesOutboundDeliveryEvidence({
    chatJid: effect.chatJid,
    message: {
      id: effect.receiptId,
      chat_jid: effect.chatJid,
      sender: 'Me',
      sender_name: 'You',
      content: effect.message,
      timestamp: effect.observedAt,
      is_from_me: true,
      is_bot_message: false,
      provider_idempotency_key: effect.tempGuid,
    },
    groupFolders: [GROUP_FOLDER],
    now: new Date('2026-07-16T12:00:11.000Z'),
  });
  const replay = await executeRequest(command.providerBaseUrl);
  const finalAction = onlyAction();
  return {
    uncorrelated: {
      inspected: uncorrelatedRecovery.inspected,
      reconciled: uncorrelatedRecovery.reconciled,
      stillUnverified: uncorrelatedRecovery.stillUnverified,
    },
    correlated: {
      inspected: correlatedRecovery.inspected,
      reconciled: correlatedRecovery.reconciled,
      stillUnverified: correlatedRecovery.stillUnverified,
    },
    replayState: replay.handled ? replay.state : 'unhandled',
    action: summarizeAction(finalAction),
  };
}

async function handleCommand(command: WorkerCommand): Promise<void> {
  _initTestDatabaseAtPath(command.databasePath);
  if (command.kind === 'initialize') {
    await sendToParent({ type: 'initialized' });
    return;
  }
  if (command.kind === 'inspect') {
    await sendToParent({
      type: 'inspection',
      action: summarizeAction(onlyAction()),
    });
    return;
  }
  if (command.kind === 'stage') {
    await sendToParent({
      type: 'staged',
      action: summarizeAction(stageDraftAction()),
    });
    return;
  }
  if (command.kind === 'mutate_staged_action') {
    const snapshot = onlyAction();
    const mutated = updateMessageActionIfSendStatus(
      snapshot.messageActionId,
      [snapshot.sendStatus],
      snapshot.lastUpdatedAt,
      {
        draftText: 'Newer authoritative bytes that must remain unsent.',
        sendStatus: 'skipped',
        requiresApproval: false,
        approvedAt: null,
        lastActionKind: 'skipped',
        lastActionAt: '2026-07-16T12:00:01.000Z',
        lastUpdatedAt: '2026-07-16T12:00:01.000Z',
      },
    );
    await sendToParent({
      type: 'mutation_result',
      mutated,
      action: summarizeAction(onlyAction()),
    });
    return;
  }
  if (command.kind === 'stale_explicit_claim') {
    if (!command.barrierPath) {
      throw new Error('Stale explicit claim requires a barrier path.');
    }
    const snapshot = onlyAction();
    if (snapshot.sendStatus !== 'drafted') {
      throw new Error('Stale explicit claim requires a drafted snapshot.');
    }
    await sendToParent({
      type: 'ready_for_stale_claim',
      action: summarizeAction(snapshot),
    });
    await waitForBarrier(command.barrierPath);
    const attemptedAt = '2026-07-16T12:00:02.000Z';
    const claimed = claimBlueBubblesMessageActionDispatch({
      messageActionId: snapshot.messageActionId,
      expectedSendStatus: snapshot.sendStatus,
      expectedLastUpdatedAt: snapshot.lastUpdatedAt,
      approvedAt: attemptedAt,
      attemptedAt,
      claimedLastUpdatedAt: attemptedAt,
      explanationJson: JSON.stringify({
        safetyReason: 'Stale explicit approval race fixture.',
        dispatchAttempt: {
          state: 'dispatching',
          provider: 'bluebubbles',
          idempotencyKey: snapshot.messageActionId,
          targetChatJid: TARGET_CHAT_JID,
          startedAt: attemptedAt,
        },
      }),
    });
    await sendToParent({
      type: 'stale_claim_result',
      claimed,
      action: summarizeAction(onlyAction()),
    });
    return;
  }
  if (command.kind === 'recover_and_replay') {
    await sendToParent({
      type: 'recovery_result',
      ...(await recoverAndReplay(command)),
    });
    return;
  }
  if (!command.providerBaseUrl) {
    throw new Error('Execution requires a deterministic provider endpoint.');
  }
  if (command.kind === 'stage_request') {
    const result = await stageInitialRequest(command.providerBaseUrl);
    await sendToParent({
      type: 'staging_result',
      state: result.state,
      action: summarizeAction(result.action),
    });
    return;
  }
  let raceSnapshotId: string | undefined;
  if (command.kind === 'race_approve') {
    if (!command.barrierPath) {
      throw new Error('Approval race requires a barrier path.');
    }
    const raceSnapshot = onlyAction();
    if (
      raceSnapshot.sendStatus !== 'drafted' ||
      !raceSnapshot.presentationMessageId
    ) {
      throw new Error('Approval race requires a delivered, unsent draft card.');
    }
    raceSnapshotId = raceSnapshot.messageActionId;
    await sendToParent({
      type: 'ready_for_barrier',
      workerId: command.workerId,
      messageActionId: raceSnapshotId,
    });
    await waitForBarrier(command.barrierPath);
  }
  if (command.kind !== 'approve' && command.kind !== 'race_approve') {
    throw new Error(`Unsupported provider command: ${command.kind}`);
  }
  const result = await approveStagedRequest(
    command.providerBaseUrl,
    command.approvalText,
    command.kind === 'race_approve'
      ? {
          expectedMessageActionId: raceSnapshotId,
          acceptObservedCompetingDispatch: true,
        }
      : undefined,
  );
  await sendToParent({
    type: 'approval_result',
    workerId: command.workerId,
    state: result.state,
    action: summarizeAction(result.action),
  });
}

process.once('message', (value) => {
  const command = value as WorkerCommand;
  handleCommand(command)
    .catch(async (error) => {
      await sendToParent({
        type: 'error',
        failureClass: 'bluebubbles_message_action_fixture_failed',
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      process.exitCode = 1;
    })
    .finally(() => {
      try {
        _closeDatabase();
      } catch {
        // A hard kill or failed initialization can leave no open connection.
      }
      process.disconnect();
    });
});
