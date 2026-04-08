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
