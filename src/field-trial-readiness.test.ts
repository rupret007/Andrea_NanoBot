import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBlueBubblesMonitorState,
  createDefaultBlueBubblesMonitorState,
  writeBlueBubblesMonitorState,
} from './bluebubbles-monitor-state.js';
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
    clearBlueBubblesMonitorState(tempDir);
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    clearBlueBubblesMonitorState(tempDir);
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

  it('keeps Telegram live-proven when the same-boot roundtrip is recent but the hourly probe is merely overdue', () => {
    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: {
        bootId: 'boot-telegram-recent',
        phase: 'running_ready',
        pid: process.pid,
        installMode: 'manual_host_control',
        nodePath: 'C:\\node.exe',
        nodeVersion: '22.22.2',
        startedAt: '2026-04-08T09:00:00.000Z',
        readyAt: '2026-04-08T09:00:05.000Z',
        lastError: '',
        dependencyState: 'ok',
        dependencyError: '',
        stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
        stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
        hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
      },
      readyState: {
        bootId: 'boot-telegram-recent',
        pid: process.pid,
        readyAt: '2026-04-08T09:00:05.000Z',
        appVersion: '1.0.0-test',
      },
      assistantHealthState: {
        bootId: 'boot-telegram-recent',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T11:58:30.000Z',
        channels: [
          {
            name: 'telegram',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-08T11:58:30.000Z',
            detail: 'Telegram channel ready',
          },
        ],
      },
      telegramRoundtripState: {
        bootId: 'boot-telegram-recent',
        pid: process.pid,
        status: 'failed',
        source: 'live_smoke',
        detail: 'Telegram roundtrip probe is overdue, but the last /ping succeeded on this boot.',
        chatTarget: 'Andrea',
        expectedReply: '/ping',
        updatedAt: '2026-04-08T10:45:00.000Z',
        lastSuccessAt: '2026-04-08T10:45:00.000Z',
        lastProbeAt: '2026-04-08T10:45:00.000Z',
        nextDueAt: '2026-04-08T11:45:00.000Z',
        consecutiveFailures: 0,
      },
      telegramTransportState: {
        bootId: 'boot-telegram-recent',
        pid: process.pid,
        mode: 'long_polling',
        status: 'ready',
        detail: 'Telegram long polling is ready.',
        updatedAt: '2026-04-08T11:58:30.000Z',
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
    expect(truth.telegram.nextAction).toContain('telegram:user:smoke');
  });

  it('keeps Telegram live-proven after restart when a same-boot smoke succeeded but the roundtrip marker is still pending', () => {
    const recentSuccessAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: {
        bootId: 'boot-telegram-pending',
        phase: 'running_ready',
        pid: process.pid,
        installMode: 'manual_host_control',
        nodePath: 'C:\\node.exe',
        nodeVersion: '22.22.2',
        startedAt: recentSuccessAt,
        readyAt: recentSuccessAt,
        lastError: '',
        dependencyState: 'ok',
        dependencyError: '',
        stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
        stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
        hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
      },
      readyState: {
        bootId: 'boot-telegram-pending',
        pid: process.pid,
        readyAt: recentSuccessAt,
        appVersion: '1.0.0-test',
      },
      assistantHealthState: {
        bootId: 'boot-telegram-pending',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: recentSuccessAt,
        channels: [
          {
            name: 'telegram',
            configured: true,
            state: 'ready',
            updatedAt: recentSuccessAt,
            detail: 'Telegram channel ready',
          },
        ],
      },
      telegramRoundtripState: {
        bootId: 'boot-telegram-pending',
        pid: process.pid,
        status: 'pending',
        source: 'live_smoke',
        detail: 'Telegram roundtrip is waiting for post-startup confirmation.',
        chatTarget: 'Andrea',
        expectedReply: '/ping',
        updatedAt: recentSuccessAt,
        lastSuccessAt: recentSuccessAt,
        lastProbeAt: recentSuccessAt,
        nextDueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        consecutiveFailures: 0,
      },
      telegramTransportState: {
        bootId: 'boot-telegram-pending',
        pid: process.pid,
        mode: 'long_polling',
        status: 'ready',
        detail: 'Telegram long polling is ready.',
        updatedAt: recentSuccessAt,
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
    expect(truth.bluebubbles.blocker).toContain('Messages bridge is not configured on this PC');
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

  it('parses BlueBubbles direct companion chats as conversational 1:1 mode', () => {
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
        bootId: 'boot-blue-direct-mode',
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
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate direct_1to1 | group trigger required yes | transport reachable/auth ok (200) | last inbound 2026-04-10T00:10:00.000Z | last inbound chat bb:iMessage;-;+14695405551 | last inbound self_authored yes | last outbound 2026-04-10T00:11:00.000Z (bb:iMessage;-;+14695405551) | last outbound target kind chat_guid | last outbound target value iMessage;-;+14695405551 | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence chat_guid',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.replyGateMode).toBe('direct_1to1');
    expect(truth.bluebubbles.detail).toContain('Messages bridge configuration is present');
  });

  it('uses persisted outbound diagnostics when the live bridge detail has not rehydrated them yet', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL', 'http://192.168.5.136:4305');
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    writeBlueBubblesMonitorState(
      {
        ...createDefaultBlueBubblesMonitorState('2026-04-10T00:12:00.000Z'),
        updatedAt: '2026-04-10T00:12:00.000Z',
        lastOutboundObservedAt: '2026-04-10T00:11:00.000Z',
        lastOutboundObservedChatJid: 'bb:iMessage;-;+14695405551',
        lastOutboundTargetKind: 'chat_guid',
        lastOutboundTargetValue: 'iMessage;-;+14695405551',
        lastMetadataHydrationSource: 'history',
        lastAttemptedTargetSequence: ['chat_guid', 'service_specific_direct'],
      },
      tempDir,
    );

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-persisted-outbound',
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
              'listener 0.0.0.0:4305/bluebubbles/webhook | provider bluebubbles | configured base url http://macbook-pro.local:1234 | active endpoint http://macbook-pro.local:1234 | candidate endpoints http://macbook-pro.local:1234 | candidate probe results http://macbook-pro.local:1234 => reachable/auth ok (200) | scope all_synced | reply gate mention_required | webhook http://192.168.5.136:4305/bluebubbles/webhook?secret=*** | webhook registration registered on the BlueBubbles server as webhook 1 | webhook registration state registered | transport probe state reachable | transport reachable/auth ok (200) via http://macbook-pro.local:1234 | no inbound observed yet | last inbound chat none | last inbound self_authored no | no outbound sent yet | last outbound target kind none | last outbound target value none | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence none | detection healthy | detection detail none | detection next action none | shadow poll last ok 2026-04-10T00:11:55.000Z | shadow poll error none | server seen chat none | server seen at none | fallback idle | fallback last sent none',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.lastOutboundTargetKind).toBe('chat_guid');
    expect(truth.bluebubbles.lastOutboundTarget).toBe('iMessage;-;+14695405551');
    expect(truth.bluebubbles.lastMetadataHydrationSource).toBe('history');
    expect(truth.bluebubbles.attemptedTargetSequence).toBe(
      'chat_guid -> service_specific_direct',
    );
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
      'bb:iMessage;-;+14695405551',
    );
    expect(truth.bluebubbles.mostRecentEngagedChatJid).toBe(
      'bb:iMessage;-;+14695405551',
    );
  });

  it('credits a fresh same-thread continuation after a BlueBubbles message-action without needing two pilot success events', () => {
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
        bootId: 'boot-blue-continuation-proof',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-10T19:01:34.886Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-10T19:01:34.886Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200) | last inbound 2026-04-10T19:01:27.147Z | last inbound chat bb:iMessage;-;+14695405551 | last inbound self_authored no | last outbound 2026-04-10T19:01:34.886Z (bb:iMessage;-;+14695405551) | last outbound target kind chat_guid | last outbound target value iMessage;-;+14695405551 | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence chat_guid',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    storeChatMetadata(
      'bb:iMessage;-;+14695405551',
      '2026-04-10T19:01:34.886Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:continuation-action-user',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'bb:+14695405551',
      sender_name: 'Jeff',
      content: '@Andrea send it',
      timestamp: '2026-04-10T14:43:21.164Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:continuation-action-bot',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: I sent that to Communication follow-up.',
      timestamp: '2026-04-10T14:43:29.235Z',
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessage({
      id: 'bb:continuation-user',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'bb:+14695405551',
      sender_name: 'Jeff',
      content: '@Andrea sounds good.',
      timestamp: '2026-04-10T19:01:27.147Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bb:continuation-bot',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Okay.',
      timestamp: '2026-04-10T19:01:34.886Z',
      is_from_me: true,
      is_bot_message: true,
    });
    upsertMessageAction({
      messageActionId: 'msg-action-continuation-proof-1',
      groupFolder: 'main',
      sourceType: 'communication_thread',
      sourceKey: 'comm-continuation-proof',
      sourceSummary: 'Draft reply was sent from the canonical BlueBubbles proof chat.',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-rad-dad',
        personName: 'Rad Dad',
      }),
      draftText: 'Hey, just following up.',
      trustLevel: 'approve_before_send',
      sendStatus: 'sent',
      followupAt: null,
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({ personName: 'Rad Dad' }),
      platformMessageId: 'bb:sent-continuation-proof-1',
      scheduledTaskId: null,
      approvedAt: '2026-04-10T14:43:24.000Z',
      lastActionKind: 'sent',
      lastActionAt: '2026-04-10T14:43:26.973Z',
      dedupeKey: 'continuation-proof-key-1',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: '2026-04-10T14:42:55.469Z',
      lastUpdatedAt: '2026-04-10T14:43:26.973Z',
      sentAt: '2026-04-10T14:43:26.973Z',
    });

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
      windowsHost: null,
    });

    expect(truth.bluebubbles.proofState).toBe('live_proven');
    expect(truth.bluebubbles.messageActionProofState).toBe('fresh');
    expect(truth.bluebubbles.messageActionProofChatJid).toBe(
      'bb:iMessage;-;+14695405551',
    );
    expect(truth.bluebubbles.detail).toContain('fresh same-thread continuation');
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
      'bb:iMessage;-;+14695405551',
    );
    expect(truth.bluebubbles.mostRecentEngagedAt).toBe(
      '2026-04-10T00:11:29.973Z',
    );
    expect(truth.bluebubbles.lastInboundChatJid).toBe('bb:RCS;-;+14696881303');
    expect(truth.bluebubbles.messageActionProofState).toBe('none');
    expect(truth.bluebubbles.messageActionProofDetail).toContain(
      'Andrea drafted in bb:iMessage;-;jeffstory007@gmail.com',
    );
    expect(truth.bluebubbles.messageActionProofDetail).toContain(
      'Canonical self-thread: bb:iMessage;-;+14695405551.',
    );
    expect(truth.bluebubbles.detail).toContain(
      'bb:iMessage;-;+14695405551',
    );
  });

  it('surfaces suspected missed 1:1 inbound detection and Telegram fallback state in BlueBubbles truth', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv(
      'BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL',
      'http://192.168.5.136:4305',
    );
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    writeBlueBubblesMonitorState(
      {
        ...createDefaultBlueBubblesMonitorState('2026-04-08T11:58:00.000Z'),
        updatedAt: '2026-04-08T11:58:00.000Z',
        detectionState: 'suspected_missed_inbound',
        detectionDetail:
          'BlueBubbles server saw newer 1:1 chat activity in bb:iMessage;-;+14695550123, but Andrea has not observed that inbound on the webhook side yet.',
        detectionNextAction:
          'Check the Mac-side BlueBubbles webhook target and whether this Windows listener is reachable from the Mac, then repro the same text thread.',
        shadowPollLastOkAt: '2026-04-08T11:58:00.000Z',
        shadowPollMostRecentChat: 'bb:iMessage;-;+14695550123',
        mostRecentServerSeenAt: '2026-04-08T11:56:30.000Z',
        mostRecentServerSeenChatJid: 'bb:iMessage;-;+14695550123',
        mostRecentServerSeenMessageId: 'bb:missed-msg-1',
        mostRecentWebhookObservedAt: '2026-04-08T11:40:00.000Z',
        mostRecentWebhookObservedChatJid: 'bb:RCS;-;+14696881303',
        crossSurfaceFallbackState: 'sent',
        crossSurfaceFallbackLastSentAt: '2026-04-08T11:58:00.000Z',
        crossSurfaceFallbackLastDetail: 'sent fallback notice to tg:main',
        recentEvidence: [
          {
            kind: 'missed_inbound',
            chatJid: 'bb:iMessage;-;+14695550123',
            signature: 'bb:missed-msg-1',
            observedAt: '2026-04-08T11:56:30.000Z',
          },
          {
            kind: 'missed_inbound',
            chatJid: 'bb:iMessage;-;+14695550123',
            signature: 'bb:missed-msg-2',
            observedAt: '2026-04-08T11:57:00.000Z',
          },
        ],
        perChatServerSeen: {
          'bb:iMessage;-;+14695550123': '2026-04-08T11:56:30.000Z',
        },
        perChatWebhookObserved: {
          'bb:RCS;-;+14696881303': '2026-04-08T11:40:00.000Z',
        },
      },
      tempDir,
    );

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-missed',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T11:58:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-08T11:58:00.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | scope all_synced | reply gate mention_required | transport reachable/auth ok (200) | last inbound 2026-04-08T11:40:00.000Z | last inbound chat bb:RCS;-;+14696881303 | last inbound self_authored no | last outbound 2026-04-08T11:32:00.000Z (bb:iMessage;-;+14695405551) | last outbound target kind chat_guid | last outbound target value iMessage;-;+14695405551 | last send error none | send method apple-script | private api available no | last metadata hydration none | attempted target sequence chat_guid',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
    });

    expect(truth.bluebubbles.proofState).toBe('degraded_but_usable');
    expect(truth.bluebubbles.blocker).toContain('newer chat activity');
    expect(truth.bluebubbles.detectionState).toBe('suspected_missed_inbound');
    expect(truth.bluebubbles.shadowPollMostRecentChat).toBe(
      'bb:iMessage;-;+14695550123',
    );
    expect(truth.bluebubbles.mostRecentServerSeenChatJid).toBe(
      'bb:iMessage;-;+14695550123',
    );
    expect(truth.bluebubbles.mostRecentWebhookObservedChatJid).toBe(
      'bb:RCS;-;+14696881303',
    );
    expect(truth.bluebubbles.crossSurfaceFallbackState).toBe('sent');
    expect(truth.bluebubbles.crossSurfaceFallbackLastSentAt).toBe(
      '2026-04-08T11:58:00.000Z',
    );
    expect(truth.bluebubbles.detail).toContain(
      'Most recent server-seen chat: bb:iMessage;-;+14695550123.',
    );
    expect(truth.bluebubbles.detail).toContain(
      'Most recent webhook-observed chat: bb:RCS;-;+14696881303.',
    );
    expect(truth.bluebubbles.detail).toContain('Telegram fallback: sent');
  });

  it('surfaces transport-unreachable BlueBubbles truth with active endpoint and candidate results', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv(
      'BLUEBUBBLES_BASE_URL_CANDIDATES',
      'http://192.168.5.22:1234,http://macbook-pro.local:1234',
    );
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv(
      'BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL',
      'http://192.168.5.136:4305',
    );
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    writeBlueBubblesMonitorState(
      {
        ...createDefaultBlueBubblesMonitorState('2026-04-08T11:58:00.000Z'),
        updatedAt: '2026-04-08T11:58:00.000Z',
        detectionState: 'transport_unreachable',
        detectionDetail:
          'Andrea could not reach the BlueBubbles server from this host, so Messages may be missing inbound texts before Andrea ever sees them. no reachable BlueBubbles endpoint (http://macbook-pro.local:1234 => unreachable (fetch failed) | http://192.168.5.22:1234 => unreachable (fetch failed))',
        detectionNextAction:
          'Check the BlueBubbles server endpoint for this Windows host, prefer a stable IP or explicit candidate list over a .local hostname, then retry the same 1:1 Messages thread.',
        shadowPollLastError: 'fetch failed',
        activeBaseUrl: null,
        candidateProbeResults: {
          'http://macbook-pro.local:1234': 'unreachable (fetch failed)',
          'http://192.168.5.22:1234': 'unreachable (fetch failed)',
        },
        crossSurfaceFallbackState: 'armed',
        recentEvidence: [
          {
            kind: 'transport_unreachable',
            chatJid: 'bluebubbles:transport',
            signature: 'none:2026-04-08T11:58:00.000Z',
            observedAt: '2026-04-08T11:58:00.000Z',
          },
        ],
      },
      tempDir,
    );

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-transport',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T11:58:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'degraded',
            updatedAt: '2026-04-08T11:58:00.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | configured base url http://macbook-pro.local:1234 | active endpoint none | candidate endpoints http://macbook-pro.local:1234, http://192.168.5.22:1234 | candidate probe results http://macbook-pro.local:1234 => unreachable (fetch failed) | http://192.168.5.22:1234 => unreachable (fetch failed) | transport no reachable BlueBubbles endpoint | webhook registration skipped because no reachable BlueBubbles endpoint is available yet',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
    });

    expect(truth.bluebubbles.proofState).toBe('externally_blocked');
    expect(truth.bluebubbles.detectionState).toBe('transport_unreachable');
    expect(truth.bluebubbles.providerName).toBe('bluebubbles');
    expect(truth.bluebubbles.bridgeAvailability).toBe('unavailable');
    expect(truth.bluebubbles.activeServerBaseUrl).toBe('none');
    expect(truth.bluebubbles.serverBaseUrlCandidates).toContain(
      'http://192.168.5.22:1234',
    );
    expect(truth.bluebubbles.serverBaseUrlCandidateResults).toContain(
      'http://macbook-pro.local:1234 => unreachable',
    );
    expect(truth.bluebubbles.blocker).toContain(
      'Messages bridge is unavailable from this Windows host right now',
    );
    expect(truth.launchReadiness.coreBlockers.join(' | ')).not.toContain(
      'bluebubbles',
    );
    expect(truth.launchReadiness.optionalBridgeBlockers.join(' | ')).toContain(
      'messages bridge (bluebubbles)',
    );
  });

  it('prefers live healthy bridge detail over a stale persisted degraded monitor snapshot', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv(
      'BLUEBUBBLES_BASE_URL_CANDIDATES',
      'http://macbook-pro.local:1234, http://192.168.5.22:1234',
    );
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv(
      'BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL',
      'http://192.168.5.136:4305',
    );
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    writeBlueBubblesMonitorState(
      {
        ...createDefaultBlueBubblesMonitorState('2026-04-08T12:10:00.000Z'),
        updatedAt: '2026-04-08T12:10:00.000Z',
        detectionState: 'transport_unreachable',
        detectionDetail:
          'Andrea could not reach the BlueBubbles server from this host earlier in the run.',
        detectionNextAction: 'Retry later.',
        activeBaseUrl: null,
        crossSurfaceFallbackState: 'sent',
        crossSurfaceFallbackLastSentAt: '2026-04-08T12:00:00.000Z',
      },
      tempDir,
    );

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-recovered',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T12:12:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-08T12:12:00.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | provider bluebubbles | configured base url http://macbook-pro.local:1234 | active endpoint http://192.168.5.22:1234 | candidate endpoints http://macbook-pro.local:1234, http://192.168.5.22:1234 | candidate probe results http://macbook-pro.local:1234 => unreachable (fetch failed) || http://192.168.5.22:1234 => reachable/auth ok (200) | scope all_synced | reply gate mention_required | webhook http://192.168.5.136:4305/bluebubbles/webhook?secret=*** | webhook registration registered on the BlueBubbles server as webhook 1 | webhook registration state registered | transport probe state reachable | transport reachable/auth ok (200) via http://192.168.5.22:1234 | detection healthy | detection detail none | detection next action none | shadow poll last ok 2026-04-08T12:11:55.000Z | shadow poll error none | server seen chat none | server seen at none | fallback idle | fallback last sent none',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
    });

    expect(truth.bluebubbles.detectionState).toBe('healthy');
    expect(truth.bluebubbles.bridgeAvailability).toBe('available');
    expect(truth.bluebubbles.activeServerBaseUrl).toBe('http://192.168.5.22:1234');
    expect(truth.bluebubbles.webhookRegistrationState).toBe('registered');
    expect(truth.bluebubbles.crossSurfaceFallbackState).toBe('idle');
  });

  it('treats a reachable-but-missing webhook registration as bridge unavailable', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv(
      'BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL',
      'http://192.168.5.136:4305',
    );
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-missing-webhook',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T12:20:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'degraded',
            updatedAt: '2026-04-08T12:20:00.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | provider bluebubbles | configured base url http://macbook-pro.local:1234 | active endpoint http://macbook-pro.local:1234 | candidate endpoints http://macbook-pro.local:1234 | candidate probe results http://macbook-pro.local:1234 => reachable/auth ok (200) | scope all_synced | reply gate mention_required | webhook http://192.168.5.136:4305/bluebubbles/webhook?secret=*** | webhook registration no matching Andrea webhook is registered on the BlueBubbles server | webhook registration state missing | transport probe state reachable | transport reachable/auth ok (200) via http://macbook-pro.local:1234 | detection healthy | detection detail none | detection next action none | shadow poll last ok 2026-04-08T12:19:55.000Z | shadow poll error none | server seen chat none | server seen at none | fallback idle | fallback last sent none',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
    });

    expect(truth.bluebubbles.bridgeAvailability).toBe('unavailable');
    expect(truth.bluebubbles.webhookRegistrationState).toBe('missing');
    expect(truth.bluebubbles.blocker).toContain(
      "does not have Andrea's webhook registered yet",
    );
  });

  it('treats a reachable bridge with a failing shadow poll as unstable instead of ignored', () => {
    vi.stubEnv('BLUEBUBBLES_ENABLED', 'true');
    vi.stubEnv('BLUEBUBBLES_BASE_URL', 'http://macbook-pro.local:1234');
    vi.stubEnv('BLUEBUBBLES_PASSWORD', 'secret');
    vi.stubEnv('BLUEBUBBLES_GROUP_FOLDER', 'main');
    vi.stubEnv('BLUEBUBBLES_CHAT_SCOPE', 'all_synced');
    vi.stubEnv(
      'BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL',
      'http://192.168.5.136:4305',
    );
    vi.stubEnv('BLUEBUBBLES_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');

    writeBlueBubblesMonitorState(
      {
        ...createDefaultBlueBubblesMonitorState('2026-04-08T12:24:00.000Z'),
        updatedAt: '2026-04-08T12:24:00.000Z',
        detectionState: 'ignored_by_gate_or_scope',
        detectionDetail:
          'Andrea saw a Messages turn earlier in the run, but it was intentionally ignored.',
        detectionNextAction: 'Use @Andrea in that thread.',
      },
      tempDir,
    );

    const snapshot: HostControlSnapshot = {
      paths: resolveHostControlPaths(tempDir),
      nodeRuntime: null,
      hostState: null,
      readyState: null,
      assistantHealthState: {
        bootId: 'boot-blue-shadow-poll',
        pid: process.pid,
        appVersion: '1.0.0-test',
        updatedAt: '2026-04-08T12:25:00.000Z',
        channels: [
          {
            name: 'bluebubbles',
            configured: true,
            state: 'degraded',
            updatedAt: '2026-04-08T12:25:00.000Z',
            detail:
              'listener 0.0.0.0:4305/bluebubbles/webhook | provider bluebubbles | configured base url http://macbook-pro.local:1234 | active endpoint http://macbook-pro.local:1234 | candidate endpoints http://macbook-pro.local:1234 | candidate probe results http://macbook-pro.local:1234 => reachable/auth ok (200) | scope all_synced | reply gate mention_required | webhook http://192.168.5.136:4305/bluebubbles/webhook?secret=*** | webhook registration registered on the BlueBubbles server as webhook 1 | webhook registration state registered | transport probe state reachable | transport reachable/auth ok (200) via http://macbook-pro.local:1234 | detection ignored_by_gate_or_scope | detection detail Andrea saw a Messages turn earlier in the run, but it was intentionally ignored. | detection next action Use @Andrea in that thread. | shadow poll last ok none | shadow poll error Not Found | server seen chat none | server seen at none | fallback cooldown | fallback last sent none',
          },
        ],
      },
      telegramRoundtripState: null,
      telegramTransportState: null,
      runtimeAuditState: null,
    };

    const truth = buildFieldTrialOperatorTruth({
      projectRoot: tempDir,
      hostSnapshot: snapshot,
    });

    expect(truth.bluebubbles.bridgeAvailability).toBe('available');
    expect(truth.bluebubbles.detectionState).toBe('mixed_degraded');
    expect(truth.bluebubbles.blocker).toContain('same-thread health check is failing');
    expect(truth.bluebubbles.blockerOwner).toBe('repo_side');
    expect(truth.bluebubbles.detectionNextAction).toContain('shadow-poll path');
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
