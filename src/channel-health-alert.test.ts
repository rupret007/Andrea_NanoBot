import { describe, expect, it } from 'vitest';

import {
  assessChannelHealthAlert,
  decideChannelHealthAlert,
} from './channel-health-alert.js';
import type { ChannelHealthSnapshot } from './types.js';

function snapshot(
  overrides: Partial<ChannelHealthSnapshot> = {},
): ChannelHealthSnapshot {
  return {
    name: 'bluebubbles',
    configured: true,
    state: 'ready',
    updatedAt: '2026-07-20T22:26:40.248Z',
    operatingMode: 'inbound_only',
    capabilities: {
      inboundAvailable: true,
      outboundAvailable: false,
    },
    alertDisposition: 'none',
    faultCode: null,
    ...overrides,
  };
}

describe('assessChannelHealthAlert', () => {
  it('does not alert for an intentionally paused outbound capability', () => {
    expect(assessChannelHealthAlert(snapshot())).toMatchObject({
      actionable: false,
      fingerprint: null,
    });
  });

  it('uses a stable actionable fingerprint and specific guidance for real faults', () => {
    expect(
      assessChannelHealthAlert(
        snapshot({
          state: 'degraded',
          alertDisposition: 'action_required',
          faultCode: 'transport_auth_failed',
        }),
      ),
    ).toEqual({
      actionable: true,
      fingerprint: 'bluebubbles:transport_auth_failed',
      likelyCause: "BlueBubbles rejected Andrea's configured credentials",
      nextAction:
        'Verify the BlueBubbles password on this host, then rerun debug:bluebubbles.',
    });
  });

  it('preserves legacy non-ready alert behavior for channels without metadata', () => {
    expect(
      assessChannelHealthAlert(
        snapshot({
          name: 'legacy',
          state: 'degraded',
          alertDisposition: undefined,
          faultCode: undefined,
        }),
      ),
    ).toMatchObject({
      actionable: true,
      fingerprint: 'legacy:degraded',
    });
  });
});

describe('decideChannelHealthAlert', () => {
  const transportFault = snapshot({
    state: 'degraded',
    alertDisposition: 'action_required',
    faultCode: 'transport_unreachable',
  });

  it('emits once for a fault and stays quiet for the same fingerprint', () => {
    expect(decideChannelHealthAlert(transportFault, null).event).toBe('fault');
    expect(
      decideChannelHealthAlert(
        transportFault,
        'bluebubbles:transport_unreachable',
      ).event,
    ).toBe('none');
  });

  it('emits for a changed actionable fault', () => {
    expect(
      decideChannelHealthAlert(
        snapshot({
          state: 'degraded',
          alertDisposition: 'action_required',
          faultCode: 'webhook_missing',
        }),
        'bluebubbles:transport_unreachable',
      ).event,
    ).toBe('fault');
  });

  it('recovers only from a prior real fault, not from a policy pause', () => {
    expect(
      decideChannelHealthAlert(snapshot(), 'bluebubbles:transport_unreachable')
        .event,
    ).toBe('recovered');
    expect(decideChannelHealthAlert(snapshot(), null).event).toBe('none');
    expect(
      decideChannelHealthAlert(
        snapshot({ operatingMode: 'disabled', state: 'stopped' }),
        'bluebubbles:transport_unreachable',
      ).event,
    ).toBe('none');
  });
});
