import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  insertPilotJourneyEvent,
  storeChatMetadata,
  storeMessage,
  upsertMessageAction,
} from './db.js';
import { buildFieldTrialOperatorTruth } from './field-trial-readiness.js';
import {
  getAlexaLastSignedRequestStatePath,
  resolveHostControlPaths,
  type HostControlSnapshot,
  type WindowsHostReconciliation,
} from './host-control.js';
import { completePilotJourney, startPilotJourney } from './pilot-mode.js';
import { writeProviderProofState } from './provider-proof-state.js';

describe('field-trial readiness', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-field-trial-'));
    process.chdir(tempDir);
    vi.unstubAllEnvs();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T12:00:00.000Z'));
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('marks Telegram live-proven when transport and roundtrip are healthy', () => {
    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: {
        bootId: 'boot-telegram',
        phase: 'running_ready',
        pid: process.pid,
        installMode: 'manual_host_control',
        nodePath: 'C:\\node.exe',
        nodeVersion: '22.22.2',
        startedAt: '2026-04-07T16:00:00.000Z',
        readyAt: '2026-04-07T16:00:05.000Z',
        lastError: '',
        dependencyState: 'ok',
        dependencyError: '',
        stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
        stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
        hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
      },
      readyState: {
        bootId: 'boot-telegram',
        pid: process.pid,
        readyAt: '2026-04-07T16:00:05.000Z',
        appVersion: '1.0.0-test',
      },
      assistantHealthState: {
        bootId: 'boot-telegram',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-07T16:00:10.000Z',
        channels: [
          {
            name: 'telegram',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-07T16:00:10.000Z',
            detail: 'Telegram channel ready',
          },
        ],
      },
      telegramRoundtripState: {
        bootId: 'boot-telegram',
        pid: process.pid,
        status: 'healthy',
        source: 'live_smoke',
        detail: 'Telegram live smoke passed.',
        chatTarget: 'Andrea',
        expectedReply: '/ping',
        updatedAt: '2099-04-07T16:00:12.000Z',
        lastSuccessAt: '2099-04-07T16:00:12.000Z',
        lastProbeAt: '2099-04-07T16:00:12.000Z',
        nextDueAt: '2099-04-07T16:30:12.000Z',
        consecutiveFailures: 0,
      },
      telegramTransportState: {
        bootId: 'boot-telegram',
        pid: process.pid,
        mode: 'long_polling',
        status: 'ready',
        detail: 'Telegram long polling is ready.',
        updatedAt: '2026-04-07T16:00:10.000Z',
        lastError: null,
        lastErrorClass: 'none',
        webhookPresent: false,
        webhookUrl: null,
        lastWebhookCheckAt: null,
        lastPollConflictAt: null,
        externalConsumerSuspected: false,
        tokenRotationRequired: false,
        consecutiveExternalConflicts: 0,
      },
      runtimeAuditState: null,
    };
    const windowsHost: WindowsHostReconciliation = {
      snapshot,
      runtimePid: process.pid,
      processRunning: true,
      readyMatchesHost: true,
      serviceState: 'running_ready',
      activeLaunchMode: 'manual_host_control',
      launcherError: '',
      dependencyState: 'ok',
      dependencyError: '',
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost,
    });

    expect(truth.telegram.proofState).toBe('live_proven');
    expect(truth.telegram.blocker).toBe('');
  });

  it('reduces Alexa to one exact next step when no signed turn is recorded', () => {
    vi.stubEnv('ALEXA_SKILL_ID', 'amzn1.ask.skill.test');

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.alexa.proofState).toBe('near_live_only');
    expect(truth.alexa.proofKind).toBe('none');
    expect(truth.alexa.proofFreshness).toBe('none');
    expect(truth.alexa.blocker).toContain('No handled signed Alexa IntentRequest');
    expect(truth.alexa.nextAction).toContain('What am I forgetting?');
    expect(truth.alexa.confirmCommand).toBe('npm run services:status');
  });

  it('keeps LaunchRequest-only Alexa proof below live_proven', () => {
    vi.stubEnv('ALEXA_SKILL_ID', 'amzn1.ask.skill.test');
    const alexaStatePath = getAlexaLastSignedRequestStatePath(tempDir);
    fs.mkdirSync(path.dirname(alexaStatePath), { recursive: true });
    fs.writeFileSync(
      alexaStatePath,
      JSON.stringify({
        updatedAt: '2026-04-07T18:00:00.000Z',
        requestId: 'launch-1',
        requestType: 'LaunchRequest',
        intentName: null,
        applicationIdVerified: true,
        linkingResolved: false,
        groupFolder: null,
        responseSource: 'launch',
      }),
    );

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.alexa.proofState).toBe('near_live_only');
    expect(truth.alexa.proofKind).toBe('launch_only');
    expect(truth.alexa.lastSignedRequestType).toBe('LaunchRequest');
  });

  it('requires a handled fresh IntentRequest before Alexa becomes live_proven', () => {
    vi.stubEnv('ALEXA_SKILL_ID', 'amzn1.ask.skill.test');
    const alexaStatePath = getAlexaLastSignedRequestStatePath(tempDir);
    fs.mkdirSync(path.dirname(alexaStatePath), { recursive: true });
    fs.writeFileSync(
      alexaStatePath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        requestId: 'intent-1',
        requestType: 'IntentRequest',
        intentName: 'WhatAmIForgettingIntent',
        applicationIdVerified: true,
        linkingResolved: true,
        groupFolder: 'main',
        responseSource: 'local_companion',
      }),
    );

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.alexa.proofState).toBe('live_proven');
    expect(truth.alexa.proofKind).toBe('handled_intent');
    expect(truth.alexa.proofFreshness).toBe('fresh');
    expect(truth.alexa.lastSignedIntent).toBe('WhatAmIForgettingIntent');
    expect(truth.alexa.lastSignedResponseSource).toBe('local_companion');
  });

  it('keeps Alexa live-proven when a later signed request follows an earlier handled proof intent', () => {
    vi.stubEnv('ALEXA_SKILL_ID', 'amzn1.ask.skill.test');
    const alexaStatePath = getAlexaLastSignedRequestStatePath(tempDir);
    fs.mkdirSync(path.dirname(alexaStatePath), { recursive: true });
    fs.writeFileSync(
      alexaStatePath,
      JSON.stringify({
        lastSignedRequest: {
          updatedAt: new Date().toISOString(),
          requestId: 'session-ended-1',
          requestType: 'SessionEndedRequest',
          intentName: null,
          applicationIdVerified: true,
          linkingResolved: false,
          groupFolder: null,
          responseSource: 'fallback',
        },
        lastHandledProofIntent: {
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          requestId: 'intent-1',
          requestType: 'IntentRequest',
          intentName: 'WhatAmIForgettingIntent',
          applicationIdVerified: true,
          linkingResolved: true,
          groupFolder: 'main',
          responseSource: 'local_companion',
        },
      }),
    );

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.alexa.proofState).toBe('live_proven');
    expect(truth.alexa.lastSignedRequestType).toBe('SessionEndedRequest');
    expect(truth.alexa.lastHandledProofIntent).toBe(
      'WhatAmIForgettingIntent',
    );
    expect(truth.alexa.lastHandledProofResponseSource).toBe(
      'local_companion',
    );
    expect(truth.alexa.lastHandledProofAt).not.toBe('none');
  });

  it('treats BlueBubbles as externally blocked when it is not installed on this host', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', '');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', '');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', '');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', '');
    vi.stubEnv('BLUEBUBBLES_ALLOWED_CHAT_GUIDS', '');
    vi.stubEnv('BLUEBUBBLES_ALLOWED_CHAT_GUID', '');
    writeProviderProofState({
      updatedAt: '2026-04-07T18:00:00.000Z',
      research: {
        proofState: 'externally_blocked',
        blocker: "Andrea's OpenAI research path on this machine has hit a quota or billing limit.",
        detail: 'OpenAI-backed outward research is blocked on this host.',
        nextAction:
          'Restore direct provider quota/billing or credentials, then rerun npm run debug:research-mode.',
        checkedAt: '2026-04-07T18:00:00.000Z',
        source: 'debug_research_mode',
      },
      imageGeneration: {
        proofState: 'externally_blocked',
        blocker: 'the OpenAI image account on this machine has hit a quota or billing limit.',
        detail: 'Image generation is blocked on this host.',
        nextAction:
          'Restore direct provider quota/billing or credentials, then rerun npm run debug:research-mode.',
        checkedAt: '2026-04-07T18:00:00.000Z',
        source: 'debug_research_mode',
      },
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.bluebubbles.proofState).toBe('externally_blocked');
    expect(truth.bluebubbles.blocker).toContain('not configured in Andrea on this host');
    expect(truth.bluebubbles.nextAction).toContain('BLUEBUBBLES_*');
    expect(truth.bluebubbles.chatScope).toBe('allowlist');
    expect(truth.research.proofState).toBe('externally_blocked');
    expect(truth.research.blocker).toContain('quota or billing limit');
    expect(truth.research.blockerOwner).toBe('external');
    expect(truth.imageGeneration.proofState).toBe('externally_blocked');
    expect(truth.imageGeneration.blocker).toContain('quota or billing limit');
    expect(truth.imageGeneration.blockerOwner).toBe('external');
  });

  it('marks BlueBubbles live-proven from fresh same-chat proof across real traffic', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-07T20:10:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-07T20:10:00.000Z',
            detail: 'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200)',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;+;chat-proof',
      '2026-04-07T20:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:msg-1',
      chat_jid: 'bb:iMessage;+;chat-proof',
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: '@Andrea hi',
      timestamp: '2026-04-07T20:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:msg-2',
      chat_jid: 'bb:iMessage;+;chat-proof',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Hi. I am here.',
      timestamp: '2026-04-07T20:01:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-proof-1',
      journeyId: 'ordinary_chat',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;+;chat-proof',
      threadId: null,
      routeKey: 'direct_quick_reply',
      systemsInvolved: ['assistant_shell'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Ordinary chat greeting',
      startedAt: '2026-04-07T20:00:00.000Z',
      completedAt: '2026-04-07T20:00:02.000Z',
      durationMs: 2000,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-proof-2',
      journeyId: 'daily_guidance',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;+;chat-proof',
      threadId: null,
      routeKey: 'daily.loose_ends',
      systemsInvolved: ['daily_companion'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Daily loose-ends guidance',
      startedAt: '2026-04-07T20:03:00.000Z',
      completedAt: '2026-04-07T20:03:06.000Z',
      durationMs: 6000,
    });
    upsertMessageAction({
      messageActionId: 'msg-action-proof-1',
      groupFolder: 'main',
      sourceType: 'communication_thread',
      sourceKey: 'comm-proof',
      sourceSummary: 'Candace reply went out in the same thread.',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-proof',
        personName: 'Candace',
      }),
      draftText: 'Yes, tonight still works for me.',
      trustLevel: 'approve_before_send',
      sendStatus: 'sent',
      followupAt: null,
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({ communicationThreadId: 'comm-proof', personName: 'Candace' }),
      platformMessageId: 'bb:sent-proof-1',
      scheduledTaskId: null,
      approvedAt: '2026-04-07T20:04:00.000Z',
      lastActionKind: 'sent',
      lastActionAt: '2026-04-07T20:04:30.000Z',
      dedupeKey: 'proof-key-1',
      presentationChatJid: 'bb:iMessage;+;chat-proof',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: '2026-04-07T20:04:00.000Z',
      lastUpdatedAt: '2026-04-07T20:04:30.000Z',
      sentAt: '2026-04-07T20:04:30.000Z',
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).toBe('live_proven');
    expect(truth.bluebubbles.mostRecentEngagedChatJid).toBe('bb:iMessage;+;chat-proof');
    expect(truth.bluebubbles.transportState).toBe('ready');
    expect(truth.bluebubbles.replyGateMode).toBe('mention_required');
    expect(truth.bluebubbles.publicWebhookUrl).toContain('secret=***');
    expect(truth.bluebubbles.lastInboundObservedAt).toBe('2026-04-07T20:00:00.000Z');
    expect(truth.bluebubbles.lastOutboundResult).toContain('bb:iMessage;+;chat-proof');
    expect(truth.bluebubbles.messageActionProofState).toBe('fresh');
    expect(truth.bluebubbles.messageActionProofChatJid).toBe('bb:iMessage;+;chat-proof');
  });

  it('anchors BlueBubbles proof to the presentation chat when a linked-thread action was decided from self-chat', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-self-proof',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-10T00:12:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-10T00:12:00.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200) | last inbound 2026-04-10T00:10:00.000Z | last inbound chat bb:iMessage;-;jeffstory007@gmail.com | last inbound self_authored yes | last outbound 2026-04-10T00:11:00.000Z (bb:iMessage;-;jeffstory007@gmail.com) | last outbound target kind chat_guid | last outbound target value iMessage;-;jeffstory007@gmail.com | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence chat_guid',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;-;jeffstory007@gmail.com',
      '2026-04-10T00:11:00.000Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:self-proof-user-1',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'bb:jeffstory007@gmail.com',
      sender_name: 'Jeff',
      content: '@Andrea what should I send back?',
      timestamp: '2026-04-10T00:10:00.000Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:self-proof-bot-1',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is a draft you can send.',
      timestamp: '2026-04-10T00:11:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-self-proof-1',
      journeyId: 'ordinary_chat',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      threadId: null,
      routeKey: 'direct_quick_reply',
      systemsInvolved: ['assistant_shell'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Ordinary self-chat proof',
      startedAt: '2026-04-10T00:10:00.000Z',
      completedAt: '2026-04-10T00:10:02.000Z',
      durationMs: 2000,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-self-proof-2',
      journeyId: 'daily_guidance',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      threadId: null,
      routeKey: 'communication.draft_reply',
      systemsInvolved: ['communication_companion'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Drafted a same-thread reply from self-chat.',
      startedAt: '2026-04-10T00:11:00.000Z',
      completedAt: '2026-04-10T00:11:06.000Z',
      durationMs: 6000,
    });
    upsertMessageAction({
      messageActionId: 'msg-action-self-proof-1',
      groupFolder: 'main',
      sourceType: 'communication_thread',
      sourceKey: 'comm-self-proof',
      sourceSummary: 'Draft reply was decided from the self-chat proof thread.',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;external-thread',
        personName: 'Che',
      }),
      draftText: 'Yes, Saturday is still the plan.',
      trustLevel: 'approve_before_send',
      sendStatus: 'sent',
      followupAt: null,
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({
        communicationThreadId: 'comm-self-proof',
        personName: 'Che',
      }),
      platformMessageId: 'bb:sent-self-proof-1',
      scheduledTaskId: null,
      approvedAt: '2026-04-10T00:11:30.000Z',
      lastActionKind: 'sent',
      lastActionAt: '2026-04-10T00:11:40.000Z',
      dedupeKey: 'proof-key-self-1',
      presentationChatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: '2026-04-10T00:11:20.000Z',
      lastUpdatedAt: '2026-04-10T00:11:40.000Z',
      sentAt: '2026-04-10T00:11:40.000Z',
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).toBe('live_proven');
    expect(truth.bluebubbles.messageActionProofState).toBe('fresh');
    expect(truth.bluebubbles.messageActionProofChatJid).toBe(
      'bb:iMessage;-;jeffstory007@gmail.com',
    );
  });

  it('keeps BlueBubbles near-live when same-chat pilot proof exists but message-action proof is missing', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-07T20:10:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-07T20:10:00.000Z',
            detail: 'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200)',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;+;chat-proof',
      '2026-04-07T20:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:msg-1',
      chat_jid: 'bb:iMessage;+;chat-proof',
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: '@Andrea hi',
      timestamp: '2026-04-07T20:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:msg-2',
      chat_jid: 'bb:iMessage;+;chat-proof',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Hi. I am here.',
      timestamp: '2026-04-07T20:01:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-proof-1',
      journeyId: 'ordinary_chat',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;+;chat-proof',
      threadId: null,
      routeKey: 'direct_quick_reply',
      systemsInvolved: ['assistant_shell'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Ordinary chat greeting',
      startedAt: '2026-04-07T20:00:00.000Z',
      completedAt: '2026-04-07T20:00:02.000Z',
      durationMs: 2000,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-proof-2',
      journeyId: 'daily_guidance',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;+;chat-proof',
      threadId: null,
      routeKey: 'daily.loose_ends',
      systemsInvolved: ['daily_companion'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Daily loose-ends guidance',
      startedAt: '2026-04-07T20:03:00.000Z',
      completedAt: '2026-04-07T20:03:06.000Z',
      durationMs: 6000,
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).not.toBe('live_proven');
    expect(truth.bluebubbles.messageActionProofState).toBe('none');
    expect(truth.bluebubbles.blocker).toContain('message-action proof');
  });

  it('treats a self-authored @Andrea BlueBubbles message with failed reply-back as degraded-but-usable', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-self',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T05:10:33.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'degraded',
            updatedAt: '2026-04-08T05:10:33.000Z',
            lastError:
              'BlueBubbles send failed after targets [chat_guid, last_addressed_handle, service_specific_last_addressed_handle]: Message Send Error',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200) | last inbound 2026-04-08T05:10:24.440Z | last inbound chat bb:iMessage;-;+14695405551 | last inbound self_authored yes | no outbound sent yet | last outbound target kind service_specific_last_addressed_handle | last outbound target value iMessage;-;jeffstory007@gmail.com | last send error Message Send Error | send method apple-script | private api available no | last metadata hydration history | attempted target sequence chat_guid -> last_addressed_handle -> service_specific_last_addressed_handle',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;-;+14695405551',
      '2026-04-08T05:10:24.440Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:msg-self-1',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'bb:+14695405551',
      sender_name: 'Jeff',
      content: '@Andrea what time is it?',
      timestamp: '2026-04-08T05:10:24.440Z',
      is_from_me: true,
      is_bot_message: false,
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).toBe('degraded_but_usable');
    expect(truth.bluebubbles.blocker).toContain('received your @Andrea message');
    expect(truth.bluebubbles.blockerOwner).toBe('repo_side');
    expect(truth.bluebubbles.nextAction).toContain('self-chat');
    expect(truth.bluebubbles.lastInboundObservedAt).toBe('2026-04-08T05:10:24.440Z');
    expect(truth.bluebubbles.lastInboundChatJid).toBe('bb:iMessage;-;+14695405551');
    expect(truth.bluebubbles.lastInboundWasSelfAuthored).toBe(true);
    expect(truth.bluebubbles.lastOutboundResult).toBe('none');
    expect(truth.bluebubbles.lastOutboundTargetKind).toBe(
      'service_specific_last_addressed_handle',
    );
    expect(truth.bluebubbles.lastOutboundTarget).toBe(
      'iMessage;-;jeffstory007@gmail.com',
    );
    expect(truth.bluebubbles.lastSendErrorDetail).toBe('Message Send Error');
    expect(truth.bluebubbles.sendMethod).toBe('apple-script');
    expect(truth.bluebubbles.privateApiAvailable).toBe('no');
    expect(truth.bluebubbles.lastMetadataHydrationSource).toBe('history');
    expect(truth.bluebubbles.attemptedTargetSequence).toBe(
      'chat_guid -> last_addressed_handle -> service_specific_last_addressed_handle',
    );
  });

  it('prefers the newest real BlueBubbles traffic chat over a stale earlier proof chat in degraded status', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-latest',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-09T23:45:38.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-09T23:45:38.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200) | last inbound 2026-04-09T23:45:19.881Z | last inbound chat bb:iMessage;-;+14695405551 | last inbound self_authored yes | last outbound 2026-04-09T23:45:38.765Z (bb:iMessage;-;+14695405551) | last outbound target kind chat_guid | last outbound target value iMessage;-;+14695405551 | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence chat_guid',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;-;+14695405551',
      '2026-04-09T23:45:38.765Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:msg-active-1',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'bb:+14695405551',
      sender_name: 'Jeff',
      content: '@Andrea what should I say back',
      timestamp: '2026-04-09T23:45:19.881Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:msg-active-2',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Here is a draft you can send.',
      timestamp: '2026-04-09T23:45:38.765Z',
      is_from_me: true,
      is_bot_message: true,
    });
    insertPilotJourneyEvent({
      eventId: 'bb-stale-proof-1',
      journeyId: 'ordinary_chat',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      threadId: null,
      routeKey: 'direct_quick_reply',
      systemsInvolved: ['assistant_shell'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Older ordinary-chat proof',
      startedAt: '2026-04-09T19:00:20.000Z',
      completedAt: '2026-04-09T19:00:23.072Z',
      durationMs: 3000,
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).toBe('degraded_but_usable');
    expect(truth.bluebubbles.mostRecentEngagedChatJid).toBe(
      'bb:iMessage;-;+14695405551',
    );
    expect(truth.bluebubbles.mostRecentEngagedAt).toBe(
      '2026-04-09T23:45:38.765Z',
    );
    expect(truth.bluebubbles.detail).toContain('bb:iMessage;-;+14695405551');
    expect(truth.bluebubbles.detail).not.toContain(
      'bb:iMessage;-;jeffstory007@gmail.com, but a fresh same-chat message-action decision is still missing',
    );
  });

  it('keeps the active self-thread anchored when another BlueBubbles chat pings later', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-self-thread',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-10T00:32:10.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-10T00:32:10.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200) | last inbound 2026-04-10T00:32:06.334Z | last inbound chat bb:RCS;-;+14696881303 | last inbound self_authored no | last outbound 2026-04-10T00:11:29.973Z (bb:iMessage;-;jeffstory007@gmail.com) | last outbound target kind chat_guid | last outbound target value iMessage;-;jeffstory007@gmail.com | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence chat_guid',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;-;jeffstory007@gmail.com',
      '2026-04-10T00:11:29.973Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:RCS;-;+14696881303',
      '2026-04-10T00:32:06.334Z',
      'RCS;-;+14696881303',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:self-thread-user-1',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'bb:jeffstory007@gmail.com',
      sender_name: 'Jeff',
      content: '@Andrea what should I say back',
      timestamp: '2026-04-10T00:08:15.455Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:self-thread-bot-1',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Sure! Here is your draft text you can send.',
      timestamp: '2026-04-10T00:11:29.973Z',
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessage({
      id: 'bb:other-chat-1',
      chat_jid: 'bb:RCS;-;+14696881303',
      sender: 'bb:+14696881303',
      sender_name: '+14696881303',
      content: "I'm home",
      timestamp: '2026-04-10T00:32:06.334Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).toBe('degraded_but_usable');
    expect(truth.bluebubbles.mostRecentEngagedChatJid).toBe(
      'bb:iMessage;-;jeffstory007@gmail.com',
    );
    expect(truth.bluebubbles.mostRecentEngagedAt).toBe(
      '2026-04-10T00:11:29.973Z',
    );
    expect(truth.bluebubbles.lastInboundChatJid).toBe('bb:RCS;-;+14696881303');
    expect(truth.bluebubbles.messageActionProofState).toBe('none');
    expect(truth.bluebubbles.messageActionProofDetail).toContain(
      'Andrea drafted in bb:iMessage;-;jeffstory007@gmail.com',
    );
    expect(truth.bluebubbles.detail).toContain(
      'bb:iMessage;-;jeffstory007@gmail.com',
    );
  });

  it('keeps research and image generation live-proven from persisted provider proof', () => {
    writeProviderProofState({
      updatedAt: '2026-04-08T01:00:00.000Z',
      research: {
        proofState: 'live_proven',
        blocker: '',
        detail: 'OpenAI-backed outward research returned a live answer on this host.',
        nextAction: '',
        checkedAt: '2026-04-08T01:00:00.000Z',
        source: 'debug_research_mode',
      },
      imageGeneration: {
        proofState: 'live_proven',
        blocker: '',
        detail: 'Telegram image generation returned an image artifact.',
        nextAction: '',
        checkedAt: '2026-04-08T01:00:00.000Z',
        source: 'debug_research_mode',
      },
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.research.proofState).toBe('live_proven');
    expect(truth.research.detail).toContain('live answer');
    expect(truth.imageGeneration.proofState).toBe('live_proven');
    expect(truth.imageGeneration.detail).toContain('image artifact');
  });

  it('treats Google Calendar as externally blocked when current-repo credentials are missing even if stale proof exists', () => {
    writeProviderProofState({
      updatedAt: '2026-04-08T01:00:00.000Z',
      googleCalendar: {
        proofState: 'live_proven',
        blocker: '',
        detail: 'Google Calendar used to be live-proven here.',
        nextAction: '',
        checkedAt: '2026-04-08T01:00:00.000Z',
        source: 'debug_google_calendar',
      },
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.googleCalendar.proofState).toBe('externally_blocked');
    expect(truth.googleCalendar.blocker).toContain('not connected');
    expect(truth.googleCalendar.blockerOwner).toBe('external');
  });

  it('surfaces persisted Google Calendar live proof when current-repo credentials are present', () => {
    vi.stubEnv('GOOGLE_CALENDAR_ACCESS_TOKEN', 'token');
    vi.stubEnv('GOOGLE_CALENDAR_IDS', 'primary');
    writeProviderProofState({
      updatedAt: '2026-04-08T01:00:00.000Z',
      googleCalendar: {
        proofState: 'live_proven',
        blocker: '',
        detail: 'Google Calendar read/write is live-proven on this host.',
        nextAction: '',
        checkedAt: '2026-04-08T01:00:00.000Z',
        source: 'debug_google_calendar',
      },
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.googleCalendar.proofState).toBe('live_proven');
    expect(truth.googleCalendar.detail).toContain('live-proven');
  });

  it('keeps Alexa live-proven from a recent successful pilot journey when restart cleared the signed-request file', () => {
    vi.stubEnv('ALEXA_SKILL_ID', 'amzn1.ask.skill.test');
    const started = startPilotJourney({
      journeyId: 'alexa_orientation',
      systemsInvolved: ['alexa', 'assistant_capabilities'],
      summaryText: 'What am I forgetting?',
      routeKey: 'WhatAmIForgettingIntent',
      channel: 'alexa',
      groupFolder: 'main',
      chatJid: null,
      threadId: null,
      startedAt: '2026-04-08T11:55:00.000Z',
    });
    expect(started).toBeTruthy();
    completePilotJourney({
      eventId: started!.eventId,
      outcome: 'success',
      blockerOwner: 'none',
      completedAt: '2026-04-08T11:55:12.000Z',
      summaryText: 'The conversation most likely to slip is Candace.',
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.alexa.proofState).toBe('live_proven');
    expect(truth.alexa.lastSignedRequestAt).toBe('none');
    expect(truth.alexa.lastHandledProofAt).toBe('2026-04-08T11:55:12.000Z');
    expect(truth.alexa.lastHandledProofIntent).toBe('alexa_orientation');
    expect(truth.alexa.lastHandledProofResponseSource).toBe('pilot_recent_success');
    expect(truth.journeys.alexa_orientation.proofState).toBe('live_proven');
  });

  it('marks work cockpit live-proven from a recent pilot journey and surfaces pilot issue state', () => {
    const started = startPilotJourney({
      journeyId: 'work_cockpit',
      systemsInvolved: ['work_cockpit', 'andrea_runtime'],
      summaryText: 'Opened Current Work and continued it.',
      routeKey: 'current_work',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: 'thread-1',
      startedAt: '2026-04-07T17:00:00.000Z',
    });
    expect(started).toBeTruthy();
    completePilotJourney({
      eventId: started!.eventId,
      outcome: 'success',
      blockerOwner: 'none',
      currentWorkRef: 'runtime-job-1',
      completedAt: '2026-04-07T17:00:10.000Z',
      summaryText: 'Opened Current Work and continued runtime-job-1.',
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.workCockpit.proofState).toBe('live_proven');
    expect(truth.workCockpit.detail).toContain('live-proven');
    expect(truth.journeys.work_cockpit.proofState).toBe('live_proven');
    expect(truth.pilotIssues.loggingEnabled).toBe(true);
    expect(truth.pilotIssues.openCount).toBe(0);
  });

  it('surfaces degraded-but-usable journey truth instead of counting it as live-proven', () => {
    const started = startPilotJourney({
      journeyId: 'cross_channel_handoff',
      systemsInvolved: ['cross_channel_handoffs'],
      summaryText: 'Cross-channel handoff or save',
      routeKey: 'assistant_completion',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      startedAt: '2026-04-07T19:00:00.000Z',
    });
    expect(started).toBeTruthy();
    completePilotJourney({
      eventId: started!.eventId,
      outcome: 'degraded_usable',
      blockerClass: 'local_degraded_path',
      blockerOwner: 'repo_side',
      completedAt: '2026-04-07T19:00:05.000Z',
      summaryText: "I can't check that live right now.",
    });

    const truth = buildFieldTrialOperatorTruth({ projectRoot: tempDir });

    expect(truth.journeys.cross_channel_handoff.proofState).toBe('degraded_but_usable');
    expect(truth.journeys.cross_channel_handoff.blocker).toContain('local degraded path');
  });
});
