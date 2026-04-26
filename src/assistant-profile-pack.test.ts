import { describe, expect, it } from 'vitest';

import {
  ANDREA_CAPABILITY_PACKAGES,
  ANDREA_INTEGRATION_CAPABILITY_REGISTRY,
  ANDREA_MEMORY_PROFILE_PACK,
  ANDREA_RITUAL_MANIFEST,
  ANDREA_TASK_STATE_MODEL,
  buildAndreaCapabilityPackagingLine,
  buildAndreaIntegrationHealthRollup,
  buildAndreaMemoryFreshnessRollup,
  buildAndreaPlatformConfigSnapshots,
} from './assistant-profile-pack.js';

describe('assistant profile pack', () => {
  it('defines a three-tier memory model', () => {
    expect(ANDREA_MEMORY_PROFILE_PACK.map((tier) => tier.id)).toEqual([
      'working',
      'semantic',
      'procedural',
    ]);
    expect(ANDREA_MEMORY_PROFILE_PACK[1]?.includes).toContain('life threads');
    expect(ANDREA_MEMORY_PROFILE_PACK[2]?.includes).toContain('rituals');
  });

  it('defines benchmark-guided task states and capability packs', () => {
    expect(ANDREA_TASK_STATE_MODEL.map((state) => state.state)).toEqual([
      'active',
      'waiting',
      'someday',
      'done',
    ]);
    expect(
      ANDREA_CAPABILITY_PACKAGES.some((pack) => pack.id === 'meeting_prep'),
    ).toBe(true);
    expect(
      ANDREA_CAPABILITY_PACKAGES.some((pack) => pack.id === 'repo_standup'),
    ).toBe(true);
    expect(buildAndreaCapabilityPackagingLine()).toContain('meeting prep');
    expect(buildAndreaCapabilityPackagingLine()).toContain('life threads');
  });

  it('keeps integration packaging honest about live, degraded, and blocked lanes', () => {
    expect(
      ANDREA_INTEGRATION_CAPABILITY_REGISTRY.find(
        (entry) => entry.id === 'google_calendar',
      )?.status,
    ).toBe('live_proven');
    expect(
      ANDREA_INTEGRATION_CAPABILITY_REGISTRY.find(
        (entry) => entry.id === 'gmail_inbox_triage',
      )?.status,
    ).toBe('near_live_only');
    expect(
      ANDREA_INTEGRATION_CAPABILITY_REGISTRY.find(
        (entry) => entry.id === 'live_research_watchlist',
      )?.status,
    ).toBe('externally_blocked');

    expect(buildAndreaIntegrationHealthRollup()).toMatchObject({
      google_calendar: 'live_proven',
      gmail_inbox_triage: 'near_live_only',
      live_research_watchlist: 'externally_blocked',
    });
  });

  it('builds seed rollups and platform snapshots even before db-backed groups are present', () => {
    expect(buildAndreaMemoryFreshnessRollup([])).toMatchObject({
      groupsTracked: '0',
      indexStatus: 'seeded_profile_pack_and_db_backed',
      changelogStatus: 'append_only',
      arbitrationStatus: 'active_memory_intelligence',
    });
    expect(ANDREA_RITUAL_MANIFEST).toHaveLength(7);

    const snapshots = buildAndreaPlatformConfigSnapshots([]);
    expect(
      snapshots.map(
        (snapshot) => `${snapshot.component}:${snapshot.configName}`,
      ),
    ).toEqual([
      'andrea.memory:memory_profile_pack',
      'andrea.memory:memory_freshness_rollup',
      'andrea.memory:memory_intelligence_report',
      'andrea.integrations:integration_capability_registry',
      'andrea.integrations:integration_health_rollup',
      'andrea.rituals:ritual_manifest',
      'andrea.rituals:ritual_status_rollup',
    ]);
  });
});
