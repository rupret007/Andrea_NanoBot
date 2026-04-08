import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
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
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
    expect(truth.research.proofState).toBe('externally_blocked');
    expect(truth.research.blocker).toContain('quota or billing limit');
    expect(truth.research.blockerOwner).toBe('external');
    expect(truth.imageGeneration.proofState).toBe('externally_blocked');
    expect(truth.imageGeneration.blocker).toContain('quota or billing limit');
    expect(truth.imageGeneration.blockerOwner).toBe('external');
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
