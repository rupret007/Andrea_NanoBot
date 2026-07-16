import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './channels/index.js';

import { buildCapabilitySelfModel } from './capability-self-model.js';
import { beginCognitiveKernelRun } from './cognitive-kernel.js';
import { buildCognitiveBlackboard } from './cognitive-blackboard.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import type { ProviderHealthSnapshot } from './provider-health.js';
import { writeProviderLiveHealthState } from './provider-live-health-state.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
} from './runtime-capability-registry.js';
import {
  buildToolReliabilityDoctorReport,
  refreshToolReliabilityFromCurrentTruth,
} from './tool-reliability.js';

const tempRoots: string[] = [];
const capabilityRegistry = registerProductionRuntimeCapabilitySurfaces(
  new RuntimeCapabilityRegistry(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS),
);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-current-truth-'));
  tempRoots.push(root);
  return root;
}

function liveBraveSnapshot(checkedAt: string): ProviderHealthSnapshot {
  return {
    providerId: 'brave_search',
    kind: 'search',
    state: 'healthy',
    lastHealthyAt: checkedAt,
    lastCheckedAt: checkedAt,
    failureClass: 'none',
    quotaState: 'unknown',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {
      healthEvidence: 'live_probe',
      liveProbe: 'ok',
      liveModel: '',
    },
  };
}

describe('fresh provider truth consumers', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.stubEnv('ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE', '1');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('MINIMAX_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-brave-key');
  });

  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one fresh redacted provider observation across reliability, capability, blackboard, and cognition', async () => {
    const root = tempRoot();
    const checkedAt = new Date().toISOString();
    writeProviderLiveHealthState(
      [liveBraveSnapshot(checkedAt)],
      checkedAt,
      root,
    );
    await refreshToolReliabilityFromCurrentTruth({
      now: new Date(checkedAt),
      providers: [liveBraveSnapshot(checkedAt)],
      projectRoot: root,
    });

    const capability = buildCapabilitySelfModel({
      now: checkedAt,
      persist: false,
      env: { BRAVE_SEARCH_API_KEY: 'configured' },
      envFileValues: {},
      projectRoot: root,
      capabilityRegistry,
    }).states.find((state) => state.capabilityId === 'research.web');
    expect(capability).toMatchObject({
      proofStatus: 'live_proven',
      currentBlocker: null,
    });

    const blackboard = buildCognitiveBlackboard({
      requestText: 'provider status',
      now: checkedAt,
      persist: false,
      projectRoot: root,
    });
    expect(blackboard.toolReliabilitySummary).not.toContain(
      'provider:brave_search',
    );
    expect(
      buildToolReliabilityDoctorReport(new Date(checkedAt)).rollups.find(
        (rollup) => rollup.subjectId === 'route:cognitive_executive.research',
      ),
    ).toMatchObject({
      currentHealth: 'healthy',
      confidenceCap: 0.95,
      nextAction: '',
    });

    const cognitive = beginCognitiveKernelRun({
      turnId: 'fresh-provider-current-truth',
      channel: 'telegram',
      taskFamily: 'research',
      goal: 'Research one current fact with sources.',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'research.topic',
      selectedSkillPurpose: 'Research with cited evidence.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'strong',
      projectRoot: root,
    });
    expect(cognitive.worldBeliefs[0]?.summary).toContain('1 providers healthy');
    expect(cognitive.worldBeliefs[0]?.summary).toContain('0 unknown');
  });

  it('does not reuse expired provider evidence', () => {
    const root = tempRoot();
    const checkedAt = new Date(Date.now() - 31 * 60 * 1_000).toISOString();
    writeProviderLiveHealthState(
      [liveBraveSnapshot(checkedAt)],
      checkedAt,
      root,
    );
    const now = new Date().toISOString();

    const capability = buildCapabilitySelfModel({
      now,
      persist: false,
      env: { BRAVE_SEARCH_API_KEY: 'configured' },
      envFileValues: {},
      projectRoot: root,
      capabilityRegistry,
    }).states.find((state) => state.capabilityId === 'research.web');
    expect(capability?.proofStatus).toBe('stale');

    const cognitive = beginCognitiveKernelRun({
      turnId: 'expired-provider-current-truth',
      channel: 'telegram',
      taskFamily: 'research',
      goal: 'Research one current fact with sources.',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'research.topic',
      selectedSkillPurpose: 'Research with cited evidence.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'strong',
      projectRoot: root,
    });
    expect(cognitive.worldBeliefs[0]?.summary).toContain('0 providers healthy');
    expect(cognitive.worldBeliefs[0]?.summary).toContain('1 unknown');
  });
});
