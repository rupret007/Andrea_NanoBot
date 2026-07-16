import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import './channels/index.js';

import {
  buildCapabilitySelfModel,
  formatCapabilityNaturalResponse,
} from './capability-self-model.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import type { IntegrationDoctorReport } from './integration-doctor.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
} from './runtime-capability-registry.js';

const HEALTH_NEUTRAL_INTEGRATION_REPORT: IntegrationDoctorReport = {
  generatedAt: '2026-07-16T12:00:00.000Z',
  secretsRedacted: true,
  summary: {
    total: 0,
    healthy: 0,
    actionNeeded: 0,
    needsProof: 0,
    manualOrExternal: 0,
  },
  statuses: [],
};

const CONFIGURED_ENV = {
  TELEGRAM_BOT_TOKEN: 'configured',
  BLUEBUBBLES_BASE_URL: 'http://bluebubbles.test',
  GOOGLE_CALENDAR_CLIENT_ID: 'configured',
  BRAVE_API_KEY: 'configured',
};

const RUNTIME_MAPPED_SELF_MODEL_IDS = [
  'messages.send.telegram',
  'messages.send.bluebubbles',
  'calendar.read',
  'calendar.write',
  'research.web',
  'reminders.internal',
] as const;

function descriptorRegistry(): RuntimeCapabilityRegistry {
  return new RuntimeCapabilityRegistry(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS);
}

function buildDeterministicModel(registry: RuntimeCapabilityRegistry) {
  return buildCapabilitySelfModel({
    now: '2026-07-16T12:00:00.000Z',
    persist: false,
    env: CONFIGURED_ENV,
    envFileValues: {},
    providerHealthSnapshots: [],
    integrationReport: HEALTH_NEUTRAL_INTEGRATION_REPORT,
    capabilityRegistry: registry,
  });
}

function messageCapabilityLine(response: string, displayName: string): string {
  return (
    response.split('\n').find((line) => line.startsWith(`- ${displayName}:`)) ??
    ''
  );
}

describe('capability self-model runtime contract', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('marks every runtime-mapped capability unavailable with descriptor-only truth', () => {
    const report = buildDeterministicModel(descriptorRegistry());

    for (const capabilityId of RUNTIME_MAPPED_SELF_MODEL_IDS) {
      const state = report.states.find(
        (candidate) => candidate.capabilityId === capabilityId,
      );
      expect(state?.enabled, capabilityId).toBe(false);
      expect(state?.currentBlocker, capabilityId).toContain(
        'Production surface ',
      );
      expect(state?.currentBlocker, capabilityId).toContain(
        'is not registered in this process',
      );
    }
    expect(
      report.states.find((state) => state.capabilityId === 'research.web')
        ?.allowedChannels,
    ).toBe('alexa,telegram');
    expect(
      report.states.find(
        (state) => state.capabilityId === 'messages.send.bluebubbles',
      )?.allowedChannels,
    ).toBe('telegram,bluebubbles');
  });

  it('derives all mapped registration truth from real production composition', () => {
    const registry =
      registerProductionRuntimeCapabilitySurfaces(descriptorRegistry());
    const report = buildDeterministicModel(registry);

    for (const capabilityId of RUNTIME_MAPPED_SELF_MODEL_IDS) {
      const state = report.states.find(
        (candidate) => candidate.capabilityId === capabilityId,
      );
      expect(state?.enabled, capabilityId).toBe(true);
      expect(state?.currentBlocker ?? '', capabilityId).not.toContain(
        'Production surface',
      );
    }
    expect(
      report.states.find(
        (state) => state.capabilityId === 'messages.send.bluebubbles',
      )?.allowedChannels,
    ).toBe('telegram,bluebubbles');
  });

  it('reports descriptor-only message contracts without claiming registration', () => {
    const response = formatCapabilityNaturalResponse(
      'Can you send texts with BlueBubbles or Telegram?',
      { capabilityRegistry: descriptorRegistry() },
    );

    expect(response).toContain('host.messages.send.bluebubbles');
    expect(response).toContain('host.messages.send.telegram');
    expect(
      response.match(/no live production surface is registered/g),
    ).toHaveLength(2);
    expect(response).toContain('sending is unavailable here');
    expect(response).not.toContain('registry-owned executable binding');
    expect(response).not.toContain('live production surface host');
  });

  it('distinguishes BlueBubbles registry dispatch from Telegram host-owned execution', () => {
    const registry =
      registerProductionRuntimeCapabilitySurfaces(descriptorRegistry());
    const response = formatCapabilityNaturalResponse(
      'Can you send texts with BlueBubbles or Telegram?',
      { capabilityRegistry: registry },
    );

    expect(response).toContain(
      'registry-owned executable binding host.messages.send.bluebubbles is registered and exposed',
    );
    expect(response).toContain(
      'live production surface host.messages.send.telegram is registered and exposed',
    );
    expect(response).toContain(
      'existing host-owned guarded path, not a registry-owned binding',
    );
    expect(response).toContain('explicit send request is the authorization');
    expect(response).toContain('not a capability denial');
    expect(response).not.toContain('always draft first');
    const blueBubblesLine = messageCapabilityLine(
      response,
      'Send iMessage via BlueBubbles',
    );
    expect(blueBubblesLine).toContain('for telegram, bluebubbles');
    expect(blueBubblesLine).not.toMatch(/\b(?:direct|operator)\b/);
  });

  it('prefers a real BlueBubbles surface when it narrows descriptor channels', () => {
    const registry = descriptorRegistry();
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ handled: false }),
    });
    registry.registerToolSurface({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      actions: [
        { id: 'send', implementations: [async () => ({ handled: false })] },
      ],
      sourceChannels: ['bluebubbles'],
    });

    const report = buildDeterministicModel(registry);
    expect(
      report.states.find(
        (state) => state.capabilityId === 'messages.send.bluebubbles',
      )?.allowedChannels,
    ).toBe('bluebubbles');

    const response = formatCapabilityNaturalResponse(
      'Can you send texts with BlueBubbles?',
      { capabilityRegistry: registry },
    );
    const blueBubblesLine = messageCapabilityLine(
      response,
      'Send iMessage via BlueBubbles',
    );
    expect(blueBubblesLine).toContain('exposed for bluebubbles');
    expect(blueBubblesLine).not.toMatch(/\b(?:telegram|direct|operator)\b/);
  });

  it('reports a missing runtime contract separately from a missing surface', () => {
    const response = formatCapabilityNaturalResponse(
      'Can you send texts with BlueBubbles?',
      { capabilityRegistry: new RuntimeCapabilityRegistry([]) },
    );

    expect(
      response.match(/runtime capability contract is not registered/g),
    ).toHaveLength(2);
    expect(response).toContain('I will not claim that I can dispatch it');
  });
});
