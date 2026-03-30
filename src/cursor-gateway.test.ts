import { describe, expect, it } from 'vitest';

import {
  formatCursorGatewaySmokeTestMessage,
  formatCursorGatewayStatusMessage,
  getCursorGatewayStatus,
  runCursorGatewaySmokeTest,
} from './cursor-gateway.js';

describe('cursor-gateway', () => {
  it('returns disabled mode when no cursor signals are configured', async () => {
    const status = await getCursorGatewayStatus({
      env: {},
      envFileValues: {},
      probe: true,
      fetchImpl: (async () => {
        throw new Error('should not probe');
      }) as unknown as typeof fetch,
    });

    expect(status.mode).toBe('disabled');
    expect(status.viaNineRouter).toBe(false);
    expect(status.modelLooksCursorBacked).toBe(false);
    expect(status.probeStatus).toBe('skipped');
  });

  it('returns partial mode when cursor model is configured without endpoint', async () => {
    const status = await getCursorGatewayStatus({
      env: { NANOCLAW_AGENT_MODEL: 'cu/default' },
      envFileValues: {},
      probe: true,
      fetchImpl: (async () => {
        throw new Error('should not probe');
      }) as unknown as typeof fetch,
    });

    expect(status.mode).toBe('partial');
    expect(status.modelLooksCursorBacked).toBe(true);
    expect(status.endpoint).toBeNull();
    expect(status.probeStatus).toBe('skipped');
    expect(status.probeDetail).toBe('Endpoint is missing.');
  });

  it('treats a custom remote gateway as cursor-backed when explicitly hinted', async () => {
    const status = await getCursorGatewayStatus({
      env: {
        ANTHROPIC_BASE_URL: 'https://cursor-bridge.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'token-123',
        CURSOR_GATEWAY_HINT: '9router',
      },
      envFileValues: {},
      probe: true,
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        expect(url).toContain('/v1/models');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(status.mode).toBe('configured');
    expect(status.cursorGatewayHinted).toBe(true);
    expect(status.probeStatus).toBe('ok');
  });

  it('returns configured mode with successful gateway probe', async () => {
    const status = await getCursorGatewayStatus({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
        ANTHROPIC_AUTH_TOKEN: 'token-123',
        NANOCLAW_AGENT_MODEL: 'cu/default',
      },
      envFileValues: {},
      probe: true,
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        expect(url).toContain('/v1/models');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(status.mode).toBe('configured');
    expect(status.viaNineRouter).toBe(true);
    expect(status.authTokenConfigured).toBe(true);
    expect(status.probeStatus).toBe('ok');
  });

  it('reports failed probe details when gateway rejects auth', async () => {
    const status = await getCursorGatewayStatus({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
        ANTHROPIC_AUTH_TOKEN: 'token-123',
        NANOCLAW_AGENT_MODEL: 'cu/default',
      },
      envFileValues: {},
      probe: true,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
        })) as unknown as typeof fetch,
    });

    expect(status.probeStatus).toBe('failed');
    expect(status.probeDetail).toContain('HTTP 401');
  });

  it('formats a user-facing status message', async () => {
    const status = await getCursorGatewayStatus({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
        NANOCLAW_AGENT_MODEL: 'cu/default',
      },
      envFileValues: {},
      probe: false,
      fetchImpl: (async () =>
        new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    const message = formatCursorGatewayStatusMessage(status);
    expect(message).toContain('*Cursor Integration Status*');
    expect(message).toContain('Mode: partial');
    expect(message).toContain('Optional next step:');
    expect(message).toContain('optional and separate');
  });

  it('runs e2e smoke test against configured gateway', async () => {
    const status = await getCursorGatewayStatus({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
        ANTHROPIC_AUTH_TOKEN: 'token-123',
        NANOCLAW_AGENT_MODEL: 'cu/default',
      },
      envFileValues: {},
      probe: false,
      fetchImpl: (async () =>
        new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    const smoke = await runCursorGatewaySmokeTest({
      status,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'token-123',
      },
      envFileValues: {},
      fetchImpl: (async (input: unknown) => {
        const url = String(input);
        expect(url).toContain('/v1/chat/completions');
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OK' } }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect(smoke.status).toBe('ok');
    expect(smoke.detail).toContain('succeeded');
  });

  it('reports skipped smoke test when cursor config is disabled', async () => {
    const smoke = await runCursorGatewaySmokeTest({
      env: {},
      envFileValues: {},
      fetchImpl: (async () => {
        throw new Error('should not call fetch');
      }) as unknown as typeof fetch,
    });

    expect(smoke.status).toBe('skipped');
    expect(smoke.detail).toContain('not enabled');
  });

  it('formats smoke-test message for chat output', async () => {
    const status = await getCursorGatewayStatus({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128/v1',
        ANTHROPIC_AUTH_TOKEN: 'token-123',
        NANOCLAW_AGENT_MODEL: 'cu/default',
      },
      envFileValues: {},
      probe: false,
      fetchImpl: (async () =>
        new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    const smoke = await runCursorGatewaySmokeTest({
      status,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'token-123',
      },
      envFileValues: {},
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OK' } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    const message = formatCursorGatewaySmokeTestMessage(status, smoke);
    expect(message).toContain('*Cursor End-to-End Test*');
    expect(message).toContain('E2E smoke: ok');
  });
});
