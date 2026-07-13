import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type AgiPublishStatus,
  type AgiReadinessDoctorReport,
  buildAgiReadinessReport,
  collectPublishStatus,
  formatAgiReadinessMarkdown,
  writeAgiReadinessArtifacts,
} from '../src/agi-readiness.js';
import {
  AGI_SCORECARD_DIMENSIONS,
  type AgiScorecardResult,
} from '../src/agi-scorecard.js';
import type {
  IntegrationDoctorReport,
  IntegrationStatus,
} from '../src/integration-doctor.js';
import type {
  LiveProofGauntletEntry,
  LiveProofGauntletReport,
} from '../src/types.js';

describe('AGI readiness', () => {
  it('separates missing model credentials from an intentionally disabled Telegram canary', () => {
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor([
        {
          name: 'model_providers',
          status: 'fail',
          detail: 'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OLLAMA_BASE_URL.',
        },
        {
          name: 'telegram_canary',
          status: 'warn',
          detail: 'ANDREA_USE_AGI is disabled.',
        },
      ]),
      integrations: integrations([status('telegram', 'Telegram', 'healthy')]),
      liveProof: liveProof([proof('Telegram bot proof', 'live_proven')]),
      publishStatus: publish({ ghAuthenticated: true, blockers: [] }),
    });

    expect(report.blockers.map((blocker) => blocker.category)).toContain(
      'external_config_required',
    );
    expect(report.repoWork).toEqual([]);
    expect(
      report.blockers.find((blocker) => blocker.id === 'telegram_canary'),
    ).toMatchObject({
      category: 'manual_live_proof_required',
      owner: 'manual',
      blocksLaunch: true,
    });
    expect(
      report.blockers.find((blocker) => blocker.id === 'telegram_canary')
        ?.action,
    ).not.toMatch(/configure TELEGRAM_BOT_TOKEN/i);
    expect(report.overallReadinessScore).toBeLessThan(
      report.deterministicScorecard.overallScore,
    );
  });

  it('prioritizes repo-side runtime work over optional provider gaps', () => {
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor(),
      integrations: integrations([
        status('runtime_backend', 'Runtime backend', 'externally_blocked', {
          blockerOwner: 'repo_side',
          nextAction: 'Repair host-control path.',
        }),
        status('research', 'Research', 'needs_auth', {
          blockerOwner: 'external',
          nextAction: 'Configure OPENAI_API_KEY.',
        }),
      ]),
      liveProof: liveProof([proof('Runtime proof', 'live_proven')]),
      publishStatus: publish({ ghAuthenticated: true, blockers: [] }),
    });

    expect(report.blockers[0]?.category).toBe('repo_fix_required');
    expect(report.repoWork[0]).toContain('Runtime backend');
    expect(
      report.blockers.some(
        (blocker) =>
          blocker.id === 'research' &&
          blocker.category === 'optional_capability_blocked',
      ),
    ).toBe(true);
  });

  it('distinguishes a configured but unobserved optional provider from a blocked provider', () => {
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor(),
      integrations: integrations([
        status('openai_cloud', 'OpenAI', 'near_live_only', {
          credentialState: 'configured',
          transportState: 'unknown',
          proofState: 'near_live_only',
          lastFailure: '',
          nextAction: 'Run one live provider probe.',
        }),
      ]),
      liveProof: liveProof([]),
      publishStatus: publish({ ghAuthenticated: true, blockers: [] }),
    });

    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai_cloud',
          category: 'optional_capability_unverified',
          blocksLaunch: false,
          status: 'near_live_only',
        }),
      ]),
    );
    expect(formatAgiReadinessMarkdown(report)).not.toContain(
      'OpenAI is blocked',
    );
  });

  it('separates missing config from manual live proof debt', () => {
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor(),
      integrations: integrations([]),
      liveProof: liveProof([
        proof('Telegram user-session proof', 'missing_config', {
          nextStep: 'Set TELEGRAM_USER_API_ID.',
        }),
        proof('Alexa signed IntentRequest proof', 'near_live_only', {
          blockerOwner: 'external',
          nextStep: 'Send one real signed simulator/device turn.',
        }),
      ]),
      publishStatus: publish({ ghAuthenticated: true, blockers: [] }),
    });

    expect(
      report.blockers.some(
        (blocker) => blocker.category === 'external_config_required',
      ),
    ).toBe(true);
    expect(
      report.blockers.some(
        (blocker) => blocker.category === 'manual_live_proof_required',
      ),
    ).toBe(true);
  });

  it('does not duplicate exact live-proof debt through the aggregate feature status', () => {
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor(),
      integrations: integrations([
        status('feature_proofs', 'Feature proof gaps', 'near_live_only', {
          nextAction: 'Run the exact proof step.',
        }),
      ]),
      liveProof: liveProof([
        proof('Alexa signed IntentRequest proof', 'stale', {
          nextStep: 'Run the exact proof step.',
        }),
      ]),
      publishStatus: publish({ ghAuthenticated: true, blockers: [] }),
    });

    expect(
      report.blockers.filter((blocker) => blocker.source === 'integrations'),
    ).toEqual([]);
    expect(
      report.blockers.filter((blocker) => blocker.source === 'live_proof'),
    ).toHaveLength(1);
  });

  it('reports GitHub auth as a publish-only blocker', () => {
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor(),
      integrations: integrations([]),
      liveProof: liveProof([]),
      publishStatus: publish({
        ghAuthenticated: false,
        blockers: [
          'Authenticate GitHub CLI with `gh auth login` before push/PR.',
        ],
      }),
    });
    const publishBlocker = report.blockers.find(
      (blocker) => blocker.category === 'publish_blocked',
    );

    expect(publishBlocker).toBeDefined();
    expect(publishBlocker?.blocksLaunch).toBe(false);
    expect(publishBlocker?.blocksPublish).toBe(true);
  });

  it('redacts secrets from JSON and Markdown output', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const report = buildAgiReadinessReport({
      generatedAt: '2026-06-29T12:00:00.000Z',
      scorecard: scorecard(),
      doctor: doctor([
        {
          name: 'model_providers',
          status: 'fail',
          detail: `bad api_key=${secret}`,
        },
      ]),
      integrations: integrations([
        status('research', 'Research', 'needs_auth', {
          nextAction: `Set OPENAI_API_KEY=${secret}.`,
          detail: `token=${secret}`,
        }),
      ]),
      liveProof: liveProof([
        proof('Research/provider proof', 'missing_config', {
          nextStep: `Use ${secret}`,
          detail: secret,
        }),
      ]),
      publishStatus: publish({
        blockers: [`gh auth failed with token=${secret}`],
      }),
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatAgiReadinessMarkdown(report)).not.toContain(secret);
  });

  it('writes JSON and Markdown artifacts under the configured state dir', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'agi-readiness-test-'));
    try {
      const report = buildAgiReadinessReport({
        generatedAt: '2026-06-29T12:00:00.000Z',
        scorecard: scorecard(),
        doctor: doctor(),
        integrations: integrations([]),
        liveProof: liveProof([]),
        publishStatus: publish({ ghAuthenticated: true, blockers: [] }),
      });
      const artifacts = await writeAgiReadinessArtifacts(report, { stateDir });
      const json = await readFile(artifacts.jsonPath, 'utf8');
      const markdown = await readFile(artifacts.markdownPath, 'utf8');

      expect(JSON.parse(json).runId).toBe(report.runId);
      expect(markdown).toContain('# Andrea AGI Live Readiness');
      expect(artifacts.dir).toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('does not call a clean synchronized main checkout publish-blocked', async () => {
    const status = collectPublishStatus({
      cwd: '/fixtures/clean-main',
      commandRunner: (command, args) => {
        const invocation = [command, ...args].join(' ');
        const stdout = new Map([
          ['git branch --show-current', 'main'],
          [
            'git remote get-url origin',
            'https://github.com/example/andrea.git',
          ],
          ['git rev-list --left-right --count origin/main...HEAD', '0 0'],
          ['git status --short', ''],
          ['gh --version', 'gh version fixture'],
          ['gh auth status', 'authenticated'],
        ]).get(invocation);
        return stdout === undefined
          ? { ok: false, stdout: '', stderr: 'unexpected fixture command' }
          : { ok: true, stdout, stderr: '' };
      },
    });

    expect(status.branch).toBe('main');
    expect(status.aheadBy).toBe(0);
    expect(status.blockers).not.toContain(
      'Create or switch to a codex/* branch before publishing.',
    );
  });
});

function scorecard(): AgiScorecardResult {
  const dimensionScores = Object.fromEntries(
    AGI_SCORECARD_DIMENSIONS.map((dimension) => [dimension, 0.98]),
  ) as AgiScorecardResult['dimensionScores'];
  return {
    runId: 'scorecard-test',
    generatedAt: '2026-06-29T12:00:00.000Z',
    mode: 'deterministic',
    overallScore: 0.98,
    grade: 'A+',
    scenarioResults: [],
    suiteSummaries: [
      {
        suite: 'strategy-evals',
        score: 0.98,
        passed: true,
        scenarioCount: 1,
        failingCount: 0,
      },
    ],
    dimensionScores,
    tracePaths: [],
    toolsUsed: [],
    pendingActions: [],
    latencyMs: 10,
    estimatedCostUsd: 0,
    regressions: [],
    weaknesses: [],
    recommendations: ['Keep the deterministic scorecard green.'],
    note: 'not a claim of general intelligence',
  };
}

function doctor(
  checks: AgiReadinessDoctorReport['checks'] = [],
): AgiReadinessDoctorReport {
  return {
    ok: !checks.some((check) => check.status === 'fail'),
    stateDir: '/tmp/andrea',
    checks: [
      { name: 'state_dir', status: 'ok', detail: 'writable' },
      ...checks,
    ],
  };
}

function status(
  integrationId: string,
  label: string,
  state: IntegrationStatus['state'],
  overrides: Partial<IntegrationStatus> = {},
): IntegrationStatus {
  return {
    integrationId,
    label,
    state,
    credentialState: 'not_required',
    transportState: state === 'healthy' ? 'healthy' : 'degraded',
    proofState: state,
    lastHealthyAt: state === 'healthy' ? '2026-06-29T12:00:00.000Z' : null,
    lastFailure: '',
    blockerOwner: 'none',
    nextAction: '',
    repairability: 'status_only',
    safeActions: [],
    detail: `${label} is ${state}.`,
    ...overrides,
  };
}

function integrations(statuses: IntegrationStatus[]): IntegrationDoctorReport {
  return {
    generatedAt: '2026-06-29T12:00:00.000Z',
    summary: {
      total: statuses.length,
      healthy: statuses.filter((item) => item.state === 'healthy').length,
      actionNeeded: statuses.filter((item) => item.state !== 'healthy').length,
      needsProof: statuses.filter((item) => item.state === 'needs_proof')
        .length,
      manualOrExternal: statuses.filter((item) =>
        ['manual_action_required', 'externally_blocked', 'needs_auth'].includes(
          item.state,
        ),
      ).length,
    },
    statuses,
    secretsRedacted: true,
  };
}

function proof(
  proofName: string,
  status: LiveProofGauntletEntry['status'],
  overrides: Partial<LiveProofGauntletEntry> = {},
): LiveProofGauntletEntry {
  return {
    proofId: `proof:${proofName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    proofName,
    status,
    lastProofAt: status === 'live_proven' ? '2026-06-29T12:00:00.000Z' : 'none',
    nextStep: 'No action needed.',
    repoWorkRequired: false,
    blockerOwner: status === 'live_proven' ? 'none' : 'external',
    evidenceIdsJson: '[]',
    detail: '',
    privacyJson: '{}',
    ...overrides,
  };
}

function liveProof(entries: LiveProofGauntletEntry[]): LiveProofGauntletReport {
  const liveProvenCount = entries.filter(
    (entry) => entry.status === 'live_proven',
  ).length;
  const dailyCoreEntries = entries.filter(
    (entry) => !/Alexa signed IntentRequest/i.test(entry.proofName),
  );
  return {
    generatedAt: '2026-06-29T12:00:00.000Z',
    entries,
    liveProvenCount,
    proofDebtCount: entries.length - liveProvenCount,
    dailyCoreLiveProvenCount: dailyCoreEntries.filter(
      (entry) => entry.status === 'live_proven',
    ).length,
    dailyCoreProofDebtCount: dailyCoreEntries.filter(
      (entry) => entry.status !== 'live_proven',
    ).length,
    optionalProofDebtCount: entries.filter(
      (entry) =>
        /Alexa signed IntentRequest/i.test(entry.proofName) &&
        entry.status !== 'live_proven',
    ).length,
    repoWorkRequiredCount: entries.filter((entry) => entry.repoWorkRequired)
      .length,
    nextAction:
      entries.find((entry) => entry.status !== 'live_proven')?.nextStep ??
      'All proof surfaces are live-proven.',
    privacyJson: '{}',
  };
}

function publish(overrides: Partial<AgiPublishStatus> = {}): AgiPublishStatus {
  return {
    branch: 'codex/agi-runtime-integration',
    remote: 'https://github.com/rupret007/Andrea_NanoBot.git',
    aheadBy: 2,
    hasTrackedChanges: false,
    hasOutOfScopeUntracked: false,
    ignoredUntracked: [],
    ghCliInstalled: true,
    ghAuthenticated: true,
    pushReady: true,
    prReady: true,
    blockers: [],
    detail: 'publish ready',
    ...overrides,
  };
}
