import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assessTelegramRoundtripState,
  persistNanoclawHostState,
  writeAssistantHealthState,
  writeAssistantReadyState,
  clearAssistantHealthState,
  clearAssistantReadyState,
  clearTelegramRoundtripState,
  clearTelegramTransportState,
  readTelegramRoundtripState,
  type NanoclawHostState,
  writeTelegramTransportState,
} from './host-control.js';
import {
  buildExpectedTelegramPingReply,
  evaluateTelegramPingReplies,
  recordOrganicTelegramRoundtripSuccess,
  recordTelegramProbeSuccess,
  recordTelegramProbeFailure,
  recordTelegramProbeUnconfigured,
} from './telegram-roundtrip.js';

describe('telegram roundtrip health', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-roundtrip-'));
    fs.mkdirSync(path.join(tempDir, 'data', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    clearTelegramRoundtripState();
    clearTelegramTransportState();
    clearAssistantHealthState();
    clearAssistantReadyState();
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedRunningHost(
    readyAt = '2026-04-04T12:00:00.000Z',
  ): NanoclawHostState {
    const hostState: NanoclawHostState = {
      bootId: 'boot-roundtrip',
      phase: 'running_ready',
      pid: process.pid,
      installMode: 'manual_host_control',
      nodePath: 'C:\\node.exe',
      nodeVersion: '22.22.2',
      startedAt: '2026-04-04T11:59:00.000Z',
      readyAt,
      lastError: '',
      dependencyState: 'ok',
      dependencyError: '',
      stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
      stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
    };
    persistNanoclawHostState(hostState);
    writeAssistantReadyState('1.2.42');
    writeAssistantHealthState({
      appVersion: '1.2.42',
      channelHealth: [
        {
          name: 'telegram',
          configured: true,
          state: 'ready',
          updatedAt: '2026-04-04T12:00:10.000Z',
          lastReadyAt: '2026-04-04T12:00:10.000Z',
          detail: 'Telegram polling connected.',
        },
      ],
    });
    return hostState;
  }

  it('evaluates the expected /ping reply text', () => {
    const observedAt = '2026-04-04T12:10:00.000Z';

    expect(
      evaluateTelegramPingReplies([
        { id: 1, text: buildExpectedTelegramPingReply(undefined, observedAt) },
      ]),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        matchedReply: expect.objectContaining({
          text: buildExpectedTelegramPingReply(undefined, observedAt),
        }),
      }),
    );

    expect(
      evaluateTelegramPingReplies([{ id: 2, text: 'Andrea is online.' }]),
    ).toEqual(
      expect.objectContaining({
        ok: true,
      }),
    );

    expect(
      evaluateTelegramPingReplies([
        {
          id: 3,
          text: `${buildExpectedTelegramPingReply(undefined, observedAt)}\nUnexpected extra line`,
        },
      ]),
    ).toEqual(
      expect.objectContaining({
        ok: false,
      }),
    );

    expect(
      evaluateTelegramPingReplies([{ id: 4, text: 'Something else' }]),
    ).toEqual(
      expect.objectContaining({
        ok: false,
      }),
    );
  });

  it('records organic success with a next-due timestamp', () => {
    seedRunningHost();

    const state = recordOrganicTelegramRoundtripSuccess({
      target: 'tg:123',
      observedAt: '2026-04-04T12:10:00.000Z',
    });

    expect(state.status).toBe('healthy');
    expect(state.bootId).toBe('boot-roundtrip');
    expect(state.lastSuccessAt).toBe('2026-04-04T12:10:00.000Z');
    expect(state.nextDueAt).toBe('2026-04-04T13:00:00.000Z');
    expect(readTelegramRoundtripState()?.chatTarget).toBe('tg:123');
  });

  it('rounds next-due timestamps to the next local top of hour near a boundary', () => {
    seedRunningHost();

    const state = recordOrganicTelegramRoundtripSuccess({
      target: 'tg:123',
      observedAt: '2026-04-04T12:59:59.000Z',
    });

    expect(state.nextDueAt).toBe('2026-04-04T13:00:00.000Z');
  });

  it('treats a missing roundtrip marker as pending during startup grace', () => {
    const hostState = seedRunningHost('2026-04-04T12:00:00.000Z');

    const assessment = assessTelegramRoundtripState({
      assistantHealthState: writeAssistantHealthState({
        appVersion: '1.2.42',
        channelHealth: [
          {
            name: 'telegram',
            configured: true,
            state: 'ready',
            updatedAt: '2026-04-04T12:00:10.000Z',
            lastReadyAt: '2026-04-04T12:00:10.000Z',
            detail: 'Telegram polling connected.',
          },
        ],
      }),
      telegramRoundtripState: null,
      hostState,
      readyState: writeAssistantReadyState('1.2.42'),
      now: new Date('2026-04-04T12:03:00.000Z'),
    });

    expect(assessment.status).toBe('pending');
    expect(assessment.due).toBe(false);
  });

  it('marks failed probes as degraded and due', () => {
    const hostState = seedRunningHost();
    const readyState = writeAssistantReadyState('1.2.42');
    const assistantHealthState = writeAssistantHealthState({
      appVersion: '1.2.42',
      channelHealth: [
        {
          name: 'telegram',
          configured: true,
          state: 'ready',
          updatedAt: '2026-04-04T12:00:10.000Z',
          lastReadyAt: '2026-04-04T12:00:10.000Z',
          detail: 'Telegram polling connected.',
        },
      ],
    });

    const roundtrip = recordTelegramProbeFailure({
      source: 'scheduled_probe',
      detail: 'No Telegram reply arrived before the roundtrip timeout.',
      target: 'tg:123',
      observedAt: '2026-04-04T12:31:00.000Z',
    });

    const assessment = assessTelegramRoundtripState({
      assistantHealthState,
      telegramRoundtripState: roundtrip,
      hostState,
      readyState,
      now: new Date('2026-04-04T12:31:05.000Z'),
    });

    expect(assessment.status).toBe('degraded');
    expect(assessment.due).toBe(true);
    expect(assessment.detail).toContain('timeout');
  });

  it('keeps a just-proved roundtrip healthy briefly after the scheduled due boundary', () => {
    const hostState = seedRunningHost('2026-04-04T12:00:00.000Z');
    const readyState = writeAssistantReadyState('1.2.42');
    const assistantHealthState = writeAssistantHealthState({
      appVersion: '1.2.42',
      channelHealth: [
        {
          name: 'telegram',
          configured: true,
          state: 'ready',
          updatedAt: '2026-04-04T12:59:58.000Z',
          lastReadyAt: '2026-04-04T12:59:58.000Z',
          detail: 'Telegram polling connected.',
        },
      ],
    });

    const roundtrip = recordTelegramProbeSuccess({
      source: 'live_smoke',
      target: 'tg:123',
      observedAt: '2026-04-04T12:59:58.000Z',
    });

    const assessment = assessTelegramRoundtripState({
      assistantHealthState,
      telegramRoundtripState: roundtrip,
      hostState,
      readyState,
      now: new Date('2026-04-04T13:03:00.000Z'),
    });

    expect(assessment.status).toBe('healthy');
    expect(assessment.due).toBe(false);
  });

  it('degrades a healthy user-session probe when the local bot token is blocked', () => {
    const hostState = seedRunningHost('2026-04-04T12:00:00.000Z');
    const readyState = writeAssistantReadyState('1.2.42');
    const assistantHealthState = writeAssistantHealthState({
      appVersion: '1.2.42',
      channelHealth: [
        {
          name: 'telegram',
          configured: true,
          state: 'degraded',
          updatedAt: '2026-04-04T12:10:00.000Z',
          lastReadyAt: null,
          detail: "Call to 'getMe' failed! (401: Unauthorized)",
        },
      ],
    });

    const roundtrip = recordTelegramProbeSuccess({
      source: 'live_smoke',
      target: '@andrea_nanobot',
      observedAt: '2026-04-04T12:10:00.000Z',
    });
    const transport = writeTelegramTransportState({
      bootId: 'boot-roundtrip',
      pid: process.pid,
      mode: 'long_polling',
      status: 'blocked',
      detail:
        'Telegram rejected this bot token with 401 Unauthorized. Rotate or replace TELEGRAM_BOT_TOKEN.',
      updatedAt: '2026-04-04T12:10:00.000Z',
      lastError: "Call to 'getMe' failed! (401: Unauthorized)",
      lastErrorClass: 'token_rotation_required',
      webhookPresent: false,
      webhookUrl: null,
      lastWebhookCheckAt: null,
      lastPollConflictAt: null,
      externalConsumerSuspected: false,
      tokenRotationRequired: true,
      consecutiveExternalConflicts: 0,
    });

    const assessment = assessTelegramRoundtripState({
      assistantHealthState,
      telegramRoundtripState: roundtrip,
      telegramTransportState: transport,
      hostState,
      readyState,
      now: new Date('2026-04-04T12:12:00.000Z'),
    });

    expect(assessment.status).toBe('degraded');
    expect(assessment.detail).toContain('another consumer or host');
  });

  it('records unconfigured probes with the attempted timestamp', () => {
    seedRunningHost();

    const state = recordTelegramProbeUnconfigured(
      'Telegram user-session is not configured.',
      process.cwd(),
      {
        source: 'live_smoke',
        target: 'tg:123',
        observedAt: '2026-04-04T12:20:00.000Z',
      },
    );

    expect(state.status).toBe('unconfigured');
    expect(state.source).toBe('live_smoke');
    expect(state.chatTarget).toBe('tg:123');
    expect(state.lastProbeAt).toBe('2026-04-04T12:20:00.000Z');
    expect(state.lastSuccessAt).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });
});
