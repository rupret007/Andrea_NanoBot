import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANDREA_STARTUP_TASK_NAME,
  buildBootAlertMessage,
  buildStartupTaskActionArgument,
  clearPendingBootAlert,
  getPendingBootAlertPath,
  readPendingBootAlert,
  redactStartupText,
  type PendingBootAlert,
} from './startup-autostart.js';

describe('startup autostart helpers', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-startup-'));
    fs.mkdirSync(path.join(tempDir, 'data', 'runtime'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds the scheduled task action for the canonical boot script', () => {
    const command = buildStartupTaskActionArgument('C:\\Andrea\\nanoclaw');

    expect(command).toContain('scripts\\andrea-startup.ps1');
    expect(command).toContain('boot');
    expect(ANDREA_STARTUP_TASK_NAME).toBe('Andrea-All-Services');
  });

  it('redacts provider and channel secrets from boot alerts', () => {
    const redacted = redactStartupText(
      [
        'OpenAI sk-proj-thisShouldNotAppear1234567890',
        'Telegram 123456789:AA-secret-token-value-abc123456789',
        'webhook?secret=superSecretValue&x=1',
        'password=sensitive',
      ].join('\n'),
    );

    expect(redacted).not.toContain('thisShouldNotAppear');
    expect(redacted).not.toContain('AA-secret-token');
    expect(redacted).not.toContain('superSecretValue');
    expect(redacted).not.toContain('sensitive');
  });

  it('formats degraded boot summaries with next actions', () => {
    const message = buildBootAlertMessage({
      status: 'degraded',
      generatedAt: '2026-05-06T00:00:00.000Z',
      components: [
        {
          id: 'nanobot_host',
          label: 'NanoBot host',
          status: 'healthy',
          detail: 'running_ready',
        },
        {
          id: 'bluebubbles',
          label: 'BlueBubbles / iMessage',
          status: 'degraded',
          detail: 'Mac endpoint unreachable',
          nextAction: 'Turn on the Mac BlueBubbles server.',
        },
      ],
    });

    expect(message).toContain('Andrea boot summary');
    expect(message).toContain('Status: degraded');
    expect(message).toContain('BlueBubbles / iMessage: degraded');
    expect(message).toContain('Turn on the Mac BlueBubbles server.');
  });

  it('reads and clears pending boot alerts from runtime state', () => {
    const alert: PendingBootAlert = {
      alertId: 'boot-alert-1',
      createdAt: '2026-05-06T00:00:00.000Z',
      status: 'degraded',
      dedupeKey: 'startup:boot:degraded:boot-1',
      message: 'Andrea boot summary\nSecret sk-api-hidden1234567890',
    };
    fs.writeFileSync(
      getPendingBootAlertPath(tempDir),
      JSON.stringify(alert),
      'utf-8',
    );

    const pending = readPendingBootAlert(tempDir);
    expect(pending?.alertId).toBe('boot-alert-1');
    expect(pending?.message).not.toContain('hidden');
    expect(clearPendingBootAlert('boot-alert-1', tempDir)).toBe(true);
    expect(readPendingBootAlert(tempDir)).toBeNull();
  });
});
