import { Script, createContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { OWNER_COCKPIT_HTML, OWNER_COCKPIT_JS } from './owner-cockpit-ui.js';

interface FakeElement {
  classList: { toggle: () => void };
  hidden: boolean;
  innerHTML: string;
  textContent: string;
}

function snapshot() {
  return {
    csrfToken: 'csrf-fixture',
    generatedAt: '2026-07-15T12:00:00.000Z',
    focus: { title: 'Review the canary', reason: 'Evidence is ready.' },
    today: [],
    threads: [],
    goals: [],
    approvals: [],
    outcomes: [],
    deepWork: {
      current: null,
      promotion: { verifiedMissions: 0, acceptanceRate: 0 },
      dogfood: {
        attemptedWorkingDays: 0,
        targetWorkingDays: 10,
        reviewedMissions: 0,
        nextAction: 'Run a real mission.',
      },
    },
    apprenticeship: {
      metrics: {
        acquisitionCount: 1,
        runCount: 2,
        pendingOwnerReviewCount: 1,
        reviewableRunCount: 2,
        totalLatencyMs: 125,
        totalProviderCalls: 0,
        totalCostUsd: 0,
      },
      acquisitions: [
        {
          id: 'capability-acquisition:fixture',
          state: 'canary_ready',
          taskFamily: 'release_readiness',
          gapKind: 'tool_usage_gap',
          riskLevel: 'low',
          evidenceOrigin: 'live',
          confidence: 0.94,
          correctionCount: 0,
          negativeOutcomeCount: 0,
          pendingAction: 'owner_review',
          ownerReviewRunId: 'capability-run:fixture',
          ownerReviewVerdict: 'verified',
          ownerReviewRevision: 2,
          activationProposalRunId: 'capability-run:fixture',
          activationRunId: null,
          controlsAvailable: true,
          evidenceIds: ['capability-outcome:fixture'],
          runs: [
            {
              id: 'capability-run:fixture',
              kind: 'canary',
              status: 'owner_reviewed',
              revision: 7,
              actionClass: 'local_lookup',
              reviewEligible: true,
              metrics: { latencyMs: 125, providerCalls: 0, costUsd: 0 },
              review: {
                verdict: 'verified',
                revision: 2,
                updatedAt: '2026-07-15T12:00:00.000Z',
              },
              evidenceIds: ['capability-outcome:fixture'],
            },
            {
              id: 'capability-run:older-reuse',
              kind: 'active_reuse',
              status: 'awaiting_owner_review',
              revision: 3,
              actionClass: 'local_lookup',
              reviewEligible: true,
              metrics: { latencyMs: 75, providerCalls: 0, costUsd: 0 },
              review: null,
              evidenceIds: ['capability-outcome:older-reuse'],
            },
          ],
        },
      ],
    },
    intelligence: {
      reviewedOutcomeCount: 0,
      requiredOutcomeCount: 5,
      baselineReady: false,
      baselineSaved: false,
      latency: {
        sampleCount: 0,
        averageMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        routes: [],
        providers: [],
        tools: [],
      },
    },
  };
}

function cockpitHarness() {
  const ids = [
    'notice',
    'freshness',
    'best-next',
    'best-why',
    'today',
    'today-count',
    'deep-work',
    'apprenticeship',
    'intelligence',
    'threads',
    'threads-count',
    'goals',
    'goals-count',
    'approvals',
    'approvals-count',
    'outcomes',
    'outcomes-count',
  ];
  const elements = new Map<string, FakeElement>(
    ids.map((id) => [
      id,
      {
        classList: { toggle: vi.fn() },
        hidden: false,
        innerHTML: '',
        textContent: '',
      },
    ]),
  );
  let clickHandler: ((event: { target: unknown }) => Promise<void>) | null =
    null;
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (!init) {
      return {
        ok: true,
        status: 200,
        json: async () => snapshot(),
      };
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push({ path, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, evidenceIds: ['evidence:fixture'] }),
    };
  });
  const document = {
    addEventListener: (
      event: string,
      handler: (event: { target: unknown }) => Promise<void>,
    ) => {
      if (event === 'click') clickHandler = handler;
    },
    getElementById: (id: string) => elements.get(id),
  };
  const context = createContext({
    confirm: vi.fn(() => true),
    document,
    fetch,
    location: { href: '' },
    prompt: vi.fn(() => 'fixture-target'),
    setTimeout: vi.fn(),
  });
  new Script(OWNER_COCKPIT_JS).runInContext(context);

  const click = async (dataset: Record<string, string>) => {
    const input = { value: 'fixture-target' };
    const details = { open: false };
    const card = {
      querySelector: (selector: string) =>
        selector === '[data-target-scope]' ? input : details,
    };
    const button = {
      dataset,
      closest: (selector: string) => (selector === 'button' ? button : card),
    };
    if (!clickHandler)
      throw new Error('Cockpit click handler was not installed.');
    await clickHandler({ target: button });
    return { details, input };
  };
  return { click, elements, posts };
}

describe('owner cockpit capability apprenticeship UI', () => {
  it('renders bounded state, evidence, metrics, and accessible exact actions', async () => {
    expect(() => new Script(OWNER_COCKPIT_JS)).not.toThrow();
    expect(OWNER_COCKPIT_HTML).toContain(
      'aria-labelledby="apprenticeship-heading"',
    );
    expect(OWNER_COCKPIT_HTML).toContain('id="apprenticeship"');

    const harness = cockpitHarness();
    await vi.waitFor(() => {
      expect(harness.elements.get('apprenticeship')?.innerHTML).toContain(
        'release_readiness',
      );
    });
    const html = harness.elements.get('apprenticeship')?.innerHTML || '';
    expect(html).toContain('Capability apprenticeship metrics');
    expect(html).toContain('capability-outcome:fixture');
    expect(html).toContain('Owner review: Verified');
    expect(html).toContain('Helpful (not verified)');
    expect(html).toContain('current revision 2');
    expect(
      html.match(/aria-label="Review this exact capability run"/g),
    ).toHaveLength(2);
    expect(html).toContain('<label for="capability-target-0">');
    for (const verdict of [
      'verified',
      'helpful',
      'partial',
      'blocked',
      'corrected',
      'rejected',
    ]) {
      expect(html).toContain(`data-capability-verdict="${verdict}"`);
    }
    expect(html).toContain('data-capability-control="show-evidence"');
    expect(html).toContain('data-capability-control="pause"');
    expect(html).toContain('data-capability-control="revoke"');
    expect(html).toContain('data-capability-control="retire"');
    expect(html).toContain('data-capability-propose=');
    expect(html.match(/data-capability-propose=/g)).toHaveLength(1);
    expect(html).toContain('data-capability-run="capability-run:older-reuse"');
    expect(html).not.toContain('PRIVATE');
  });

  it('posts each explicit verdict only to the exact canary review route', async () => {
    const harness = cockpitHarness();
    await vi.waitFor(() =>
      expect(harness.elements.get('apprenticeship')?.innerHTML).toContain(
        'release_readiness',
      ),
    );
    const verdicts = [
      'verified',
      'helpful',
      'partial',
      'blocked',
      'corrected',
      'rejected',
    ];
    for (const verdict of verdicts) {
      await harness.click({
        capabilityReview: 'capability-acquisition:fixture',
        capabilityRun: 'capability-run:fixture',
        capabilityVerdict: verdict,
      });
    }
    expect(harness.posts).toEqual(
      verdicts.map((verdict) => ({
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/runs/capability-run%3Afixture/review',
        body: { verdict, confirmation: 'REVIEW_CANARY' },
      })),
    );
  });

  it('keeps each reviewable run independently actionable', async () => {
    const harness = cockpitHarness();
    await vi.waitFor(() =>
      expect(harness.elements.get('apprenticeship')?.innerHTML).toContain(
        'capability-run:older-reuse',
      ),
    );

    await harness.click({
      capabilityReview: 'capability-acquisition:fixture',
      capabilityRun: 'capability-run:older-reuse',
      capabilityVerdict: 'partial',
    });

    expect(harness.posts).toEqual([
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/runs/capability-run%3Aolder-reuse/review',
        body: { verdict: 'partial', confirmation: 'REVIEW_CANARY' },
      },
    ]);
  });

  it('keeps evidence, control, proposal, approval, and activation actions separate', async () => {
    const harness = cockpitHarness();
    await vi.waitFor(() =>
      expect(harness.elements.get('apprenticeship')?.innerHTML).toContain(
        'release_readiness',
      ),
    );
    const evidence = await harness.click({
      capabilityControl: 'show-evidence',
      capabilityId: 'capability-acquisition:fixture',
    });
    expect(evidence.details.open).toBe(true);
    await harness.click({
      capabilityControl: 'pause',
      capabilityId: 'capability-acquisition:fixture',
    });
    await harness.click({
      capabilityControl: 'revoke',
      capabilityId: 'capability-acquisition:fixture',
    });
    await harness.click({
      capabilityControl: 'retire',
      capabilityId: 'capability-acquisition:fixture',
    });
    await harness.click({
      capabilityPropose: 'capability-acquisition:fixture',
      capabilityRun: 'capability-run:fixture',
    });
    await harness.click({
      capabilityActivate: 'capability-acquisition:fixture',
      capabilityRun: 'capability-run:fixture',
    });

    expect(harness.posts).toEqual([
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/show-evidence',
        body: { confirmation: 'SHOW_EVIDENCE' },
      },
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/pause',
        body: { confirmation: 'PAUSE' },
      },
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/revoke',
        body: { confirmation: 'REVOKE' },
      },
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/retire',
        body: { confirmation: 'RETIRE' },
      },
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/runs/capability-run%3Afixture/activation-proposal',
        body: {
          confirmation: 'PROPOSE_ACTIVATION',
          targetScopeKey: 'fixture-target',
        },
      },
      {
        path: '/api/v1/capability-apprenticeship/acquisitions/capability-acquisition%3Afixture/runs/capability-run%3Afixture/activate',
        body: {
          confirmation: 'ACTIVATE_APPROVED_CAPABILITY',
          targetScopeKey: 'fixture-target',
        },
      },
    ]);
  });
});
