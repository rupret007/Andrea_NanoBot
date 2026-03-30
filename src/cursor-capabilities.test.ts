import { describe, expect, it } from 'vitest';

import {
  formatCursorCapabilitySummaryMessage,
  formatCursorOperationFailure,
  summarizeCursorCapabilities,
} from './cursor-capabilities.js';
import { CursorCloudApiError } from './cursor-cloud.js';
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
    expect(formatCursorCapabilitySummaryMessage(summary)).toContain(
      '/cursor_models: enabled via Cursor Cloud (results depend on API response)',
    );
  });

  it('falls back to cloud job control in status when the desktop bridge probe failed', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildDesktopStatus({
        enabled: true,
        hasToken: true,
        baseUrl: 'https://cursor-mac.example.com',
        probeStatus: 'failed',
        probeDetail: 'bridge temporarily unavailable',
      }),
      cloudStatus: buildCloudStatus({
        enabled: true,
        hasApiKey: true,
      }),
      gatewayStatus: buildGatewayStatus(),
    });

    expect(summary.jobBackend).toBe('cloud');
    expect(summary.canRunJobs).toBe(true);
    expect(summary.nextStep).toContain('Fix the desktop bridge URL/token');
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

  it('explains when Cursor Cloud requires a repository for job creation', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor create failed',
        new Error(
          'Cursor API POST /v0/agents failed with HTTP 400: Repository is required. Either provide a repository URL in the source.repository field, or configure a default repository at https://cursor.com/settings.',
        ),
      ),
    ).toBe(
      'Cursor create failed. Cursor Cloud needs a repository for that job. Use `/cursor_create --repo <url> ...` or configure a default repository in Cursor settings.',
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

  it('passes through desktop-only terminal-control errors unchanged', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor terminal status failed for bc-demo',
        new Error(
          'Cursor terminal control is only available for desktop bridge sessions on your own machine.',
        ),
      ),
    ).toBe(
      'Cursor terminal status failed for bc-demo. Cursor terminal control is only available for desktop bridge sessions on your own machine.',
    );
  });

  it('passes through invalid agent id guidance unchanged', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor sync failed for bad-id',
        new Error(
          'Invalid Cursor agent id "not-a-real-agent-id". Use an id like bc_abc123 or a Cursor URL that contains ?id=<agent_id>.',
        ),
      ),
    ).toBe(
      'Cursor sync failed for bad-id. Invalid Cursor agent id "not-a-real-agent-id". Use an id like bc_abc123 or a Cursor URL that contains ?id=<agent_id>.',
    );
  });

  it('explains invalid Cursor Cloud agent ids with a recovery hint', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor sync failed for not-a-real-agent-id',
        new CursorCloudApiError(
          'Cursor API GET /v0/agents/not-a-real-agent-id failed with HTTP 400: Invalid agent ID',
          400,
          {
            error: 'Invalid agent ID',
            details: [
              {
                code: 'custom',
                message: "Agent ID must be in the format 'bc-<uuid>'",
                path: ['id'],
              },
            ],
          },
        ),
      ),
    ).toBe(
      'Cursor sync failed for not-a-real-agent-id. Cursor Cloud could not use that agent id. Use an id like bc-<uuid> or a full Cursor URL that contains ?id=<agent_id>.',
    );
  });

  it('explains when Cursor Cloud cannot find a valid-looking agent id', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor sync failed for bc-12345678-1234-1234-1234-123456789012',
        new CursorCloudApiError(
          'Cursor API GET /v0/agents/bc-12345678-1234-1234-1234-123456789012 failed with HTTP 404: Not found',
          404,
          { error: 'Not found' },
        ),
      ),
    ).toBe(
      'Cursor sync failed for bc-12345678-1234-1234-1234-123456789012. Cursor Cloud could not find that agent id.',
    );
  });
});
