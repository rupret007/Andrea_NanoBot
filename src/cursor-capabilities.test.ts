import { describe, expect, it } from 'vitest';

import {
  formatCursorCapabilitySummaryMessage,
  formatCursorOperationFailure,
  summarizeCursorCapabilities,
} from './cursor-capabilities.js';
import type { CursorCloudStatus } from './cursor-cloud.js';
import type { CursorDesktopStatus } from './cursor-desktop.js';
import type { CursorGatewayStatus } from './cursor-gateway.js';

function buildDesktopStatus(
  overrides: Partial<CursorDesktopStatus> = {},
): CursorDesktopStatus {
  return {
    enabled: false,
    baseUrl: null,
    hasToken: false,
    timeoutMs: 30_000,
    label: null,
    probeStatus: 'skipped',
    probeDetail: null,
    machineName: null,
    cliPath: null,
    activeRuns: null,
    trackedSessions: null,
    ...overrides,
  };
}

function buildCloudStatus(
  overrides: Partial<CursorCloudStatus> = {},
): CursorCloudStatus {
  return {
    enabled: false,
    baseUrl: 'https://api.cursor.com',
    hasApiKey: false,
    authMode: 'auto',
    hasWebhookSecret: false,
    timeoutMs: 20_000,
    maxRetries: 2,
    retryBaseMs: 800,
    ...overrides,
  };
}

function buildGatewayStatus(
  overrides: Partial<CursorGatewayStatus> = {},
): CursorGatewayStatus {
  return {
    endpoint: null,
    authTokenConfigured: false,
    model: null,
    viaNineRouter: false,
    cursorGatewayHinted: false,
    modelLooksCursorBacked: false,
    mode: 'disabled',
    probeStatus: 'skipped',
    probeDetail: null,
    ...overrides,
  };
}

describe('cursor-capabilities', () => {
  it('reports unavailable job control when neither desktop nor cloud is configured', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildDesktopStatus(),
      cloudStatus: buildCloudStatus(),
      gatewayStatus: buildGatewayStatus(),
    });

    expect(summary.jobBackend).toBe('none');
    expect(summary.canRunJobs).toBe(false);
    expect(summary.canListModels).toBe(false);
    expect(summary.nextStep).toContain('CURSOR_DESKTOP_BRIDGE_URL');

    const message = formatCursorCapabilitySummaryMessage(summary);
    expect(message).toContain('Job backend: not configured');
    expect(message).toContain('Main-control job commands: unavailable');
    expect(message).toContain('/cursor_models: requires Cursor Cloud API');
  });

  it('prefers the desktop bridge for job control when both backends are configured', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildDesktopStatus({
        enabled: true,
        probeStatus: 'ok',
        hasToken: true,
        baseUrl: 'https://cursor-mac.example.com',
      }),
      cloudStatus: buildCloudStatus({
        enabled: true,
        hasApiKey: true,
      }),
      gatewayStatus: buildGatewayStatus({
        mode: 'configured',
      }),
    });

    expect(summary.jobBackend).toBe('desktop');
    expect(summary.canRunJobs).toBe(true);
    expect(summary.canListModels).toBe(true);
    expect(summary.cursorRoutingReady).toBe(true);
    expect(summary.nextStep).toContain('Desktop bridge job control is ready');
  });

  it('passes through actionable Cursor setup failures unchanged', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor create failed',
        new Error(
          'Cursor is not configured. Either set CURSOR_DESKTOP_BRIDGE_URL + CURSOR_DESKTOP_BRIDGE_TOKEN for your normal machine, or set CURSOR_API_KEY for Cursor Cloud Agents.',
        ),
      ),
    ).toContain(
      'Either set CURSOR_DESKTOP_BRIDGE_URL + CURSOR_DESKTOP_BRIDGE_TOKEN',
    );
  });

  it('falls back to sanitized generic messaging for unsafe unknown errors', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor create failed',
        new Error('ECONNREFUSED to 127.0.0.1:4124 with token bridge-secret'),
      ),
    ).toBe(
      'Cursor create failed. The external integration is currently unreachable.',
    );
  });
});
