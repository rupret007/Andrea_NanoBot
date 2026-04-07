import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFieldTrialOperatorTruth } from './field-trial-readiness.js';
import {
  resolveHostControlPaths,
  type HostControlSnapshot,
  type WindowsHostReconciliation,
} from './host-control.js';
import { writeProviderProofState } from './provider-proof-state.js';

describe('field-trial readiness', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-field-trial-'));
    process.chdir(tempDir);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
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
    expect(truth.alexa.blocker).toContain('No fresh signed Alexa IntentRequest');
    expect(truth.alexa.nextAction).toContain('Perform one real signed Alexa voice');
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
    expect(truth.bluebubbles.blocker).toContain('not installed or configured on this host');
    expect(truth.bluebubbles.nextAction).toContain('Mac-side BlueBubbles server/webhook');
    expect(truth.research.proofState).toBe('externally_blocked');
    expect(truth.research.blocker).toContain('quota or billing limit');
    expect(truth.imageGeneration.proofState).toBe('externally_blocked');
    expect(truth.imageGeneration.blocker).toContain('quota or billing limit');
  });
});
