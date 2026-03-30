import { describe, expect, it } from 'vitest';

import {
  formatCursorCapabilitySummaryMessage,
  formatCursorOperationFailure,
  summarizeCursorCapabilities,
} from './cursor-capabilities.js';
import { CursorCloudApiError } from './cursor-cloud.js';
import type { CursorCloudStatus } from './cursor-cloud.js';
import type {
  CursorDesktopAgentJobCompatibility,
  CursorDesktopStatus,
} from './cursor-desktop.js';
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
    terminalAvailable: false,
    agentJobCompatibility: 'unknown',
    agentJobDetail: null,
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

function buildReadyDesktopStatus(
  compatibility: CursorDesktopAgentJobCompatibility,
  detail: string | null = null,
): CursorDesktopStatus {
  return buildDesktopStatus({
    enabled: true,
    baseUrl: 'https://cursor-bridge.example.com',
    hasToken: true,
    probeStatus: 'ok',
    terminalAvailable: true,
    agentJobCompatibility: compatibility,
    agentJobDetail: detail,
  });
}

describe('cursor-capabilities', () => {
  it('reports both Cloud and desktop as unavailable when nothing is configured', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildDesktopStatus(),
      cloudStatus: buildCloudStatus(),
      gatewayStatus: buildGatewayStatus(),
    });

    expect(summary.cloudCodingJobsReady).toBe(false);
    expect(summary.desktopTerminalReady).toBe(false);
    expect(summary.desktopAgentJobs).toBe('unavailable');
    expect(summary.canListModels).toBe(false);
    expect(summary.nextStep).toContain('CURSOR_API_KEY');

    const message = formatCursorCapabilitySummaryMessage(summary);
    expect(message).toContain('Cloud coding jobs: unavailable');
    expect(message).toContain('Desktop bridge terminal control: unavailable');
    expect(message).toContain('Desktop bridge agent jobs: unavailable');
    expect(message).toContain(
      '/cursor-models: requires Cursor Cloud API (`CURSOR_API_KEY`)',
    );
    expect(summary.nextStep).toContain('CURSOR_DESKTOP_BRIDGE_URL');
  });

  it('reports both Cloud jobs and desktop terminal control when both are ready', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildReadyDesktopStatus('validated'),
      cloudStatus: buildCloudStatus({
        enabled: true,
        hasApiKey: true,
      }),
      gatewayStatus: buildGatewayStatus({
        mode: 'configured',
      }),
    });

    expect(summary.cloudCodingJobsReady).toBe(true);
    expect(summary.desktopTerminalReady).toBe(true);
    expect(summary.desktopAgentJobs).toBe('validated');
    expect(summary.canListModels).toBe(true);
    expect(summary.cursorRoutingReady).toBe(true);
    expect(summary.nextStep).toContain('Cursor Cloud coding jobs');
    expect(formatCursorCapabilitySummaryMessage(summary)).toContain(
      '/cursor-models: enabled via Cursor Cloud (results depend on API response)',
    );
  });

  it('frames missing optional surfaces more softly when Cursor Cloud is already ready', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildDesktopStatus(),
      cloudStatus: buildCloudStatus({
        enabled: true,
        hasApiKey: true,
      }),
      gatewayStatus: buildGatewayStatus(),
    });

    const message = formatCursorCapabilitySummaryMessage(summary);
    expect(summary.nextStep).toContain('Desktop bridge remains optional');
    expect(summary.nextStep).toContain('optional and separate');
    expect(message).toContain('Optional next step:');
    expect(message).not.toContain(
      'Next step: Cursor Cloud coding jobs are ready. Desktop bridge terminal control is unavailable because',
    );
  });

  it('marks desktop agent jobs conditional when the bridge is healthy but compatibility is unknown', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildReadyDesktopStatus('unknown'),
      cloudStatus: buildCloudStatus({
        enabled: true,
        hasApiKey: true,
      }),
      gatewayStatus: buildGatewayStatus(),
    });

    expect(summary.cloudCodingJobsReady).toBe(true);
    expect(summary.desktopTerminalReady).toBe(true);
    expect(summary.desktopAgentJobs).toBe('conditional');
    expect(summary.nextStep).toContain('still conditional');
    expect(summary.nextStep).toContain('optional and separate');
  });

  it('keeps Cloud jobs ready while marking desktop agent jobs unavailable after a failed compatibility check', () => {
    const summary = summarizeCursorCapabilities({
      desktopStatus: buildReadyDesktopStatus(
        'failed',
        "Warning: 'p' is not in the list of known options, but still passed to Electron/Chromium.",
      ),
      cloudStatus: buildCloudStatus({
        enabled: true,
        hasApiKey: true,
      }),
      gatewayStatus: buildGatewayStatus(),
    });

    expect(summary.cloudCodingJobsReady).toBe(true);
    expect(summary.desktopTerminalReady).toBe(true);
    expect(summary.desktopAgentJobs).toBe('unavailable');
    expect(summary.nextStep).toContain(
      'Desktop bridge terminal control is ready',
    );
    expect(summary.nextStep).toContain('optional and separate');
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
      'Cursor create failed. Cursor Cloud needs a repository for that job. Use `/cursor-create --repo <url> ...` or configure a default repository in Cursor settings.',
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

  it('explains when a Cursor Cloud job is already finished before stop', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor stop failed for bc-12345678-1234-1234-1234-123456789012',
        new CursorCloudApiError(
          'Cursor API POST /v0/agents/bc-12345678-1234-1234-1234-123456789012/stop failed with HTTP 400: Cloud Agent not running.: This Cloud Agent is no longer available.',
          400,
          {
            error:
              'Cloud Agent not running.: This Cloud Agent is no longer available.',
          },
        ),
      ),
    ).toBe(
      'Cursor stop failed for bc-12345678-1234-1234-1234-123456789012. That Cursor Cloud job is no longer running, so there is nothing left to stop. Use /cursor-sync to refresh its final state.',
    );
  });

  it('passes through Cloud-only queued follow-up guidance for desktop sessions', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor follow-up failed for desk_123',
        new Error(
          'Desktop bridge sessions are not part of the queued Cloud follow-up flow in the current product. Use /cursor-sync to refresh the session, /cursor-conversation to inspect it, and /cursor-terminal for machine-side actions.',
        ),
      ),
    ).toContain('queued Cloud follow-up flow');
  });

  it('passes through Cloud-only results guidance for desktop sessions', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor results lookup failed for desk_123',
        new Error(
          'Cursor results are only available for Cursor Cloud jobs in the current product. Use /cursor-conversation for text output from desktop bridge sessions, and /cursor-terminal* for machine-side actions.',
        ),
      ),
    ).toBe(
      'Cursor results lookup failed for desk_123. Cursor results are only available for Cursor Cloud jobs in the current product. Use /cursor-conversation for text output from desktop bridge sessions, and /cursor-terminal* for machine-side actions.',
    );
  });

  it('passes through Cloud-only download guidance for desktop sessions', () => {
    expect(
      formatCursorOperationFailure(
        'Cursor download failed for desk_123',
        new Error(
          'Cursor download links are only available for Cursor Cloud jobs in the current product. Desktop bridge sessions do not expose downloadable result files through this path.',
        ),
      ),
    ).toBe(
      'Cursor download failed for desk_123. Cursor download links are only available for Cursor Cloud jobs in the current product. Desktop bridge sessions do not expose downloadable result files through this path.',
    );
  });
});
