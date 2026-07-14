import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCouncilEvidencePack,
  buildCouncilEvidenceScorecard,
  summarizeCouncilEvidencePack,
} from './council-evidence.js';
import { _closeDatabase, _initTestDatabase, upsertLifeThread } from './db.js';
import {
  interpretLifeThreadCommitment,
  projectLifeThreadCommitment,
} from './life-thread-commitment.js';
import { setPersonalMemoryPolicy } from './personal-context-packet.js';
import type {
  LifeThread,
  LifeThreadCommitmentOperationalState,
  LifeThreadCommitmentState,
  ProfileSubject,
} from './types.js';

const PROVIDER_PRIVACY_NOW = new Date('2026-07-14T10:05:00.000Z');

function interpretedCommitment(input: {
  threadId: string;
  title: string;
  text: string;
  current?: LifeThreadCommitmentState;
}): LifeThreadCommitmentState {
  const chris: ProfileSubject = {
    id: 'person-chris',
    groupFolder: 'main',
    kind: 'person',
    canonicalName: 'chris',
    displayName: 'Chris',
    createdAt: PROVIDER_PRIVACY_NOW.toISOString(),
    updatedAt: PROVIDER_PRIVACY_NOW.toISOString(),
    disabledAt: null,
  };
  const interpretation = interpretLifeThreadCommitment({
    threadId: input.threadId,
    title: input.title,
    text: input.text,
    now: PROVIDER_PRIVACY_NOW,
    timeZone: 'UTC',
    sourceKind: 'calendar',
    sourceRef: `calendar:${input.threadId}:${input.text}`,
    current: input.current,
    knownSubjects: [chris],
  });
  if (!interpretation) {
    throw new Error(`Could not build ${input.threadId} commitment fixture.`);
  }
  return interpretation.state;
}

function upsertProviderPrivacyThread(input: {
  id: string;
  canary: string;
  state?: LifeThreadCommitmentOperationalState;
  surfaceMode?: LifeThread['surfaceMode'];
  followthroughMode?: LifeThread['followthroughMode'];
  snoozedUntil?: string | null;
}): LifeThread {
  const title = `Council privacy ${input.canary}`;
  let commitment = interpretedCommitment({
    threadId: input.id,
    title,
    text: `I'll complete ${input.canary}.`,
  });
  const transitionText: Partial<
    Record<LifeThreadCommitmentOperationalState, string>
  > = {
    waiting: `I sent ${input.canary} and I am waiting for a response.`,
    blocked: `I can't complete ${input.canary} until the permit arrives.`,
    delegated: 'Chris has this one.',
    deferred: `Not now. Shelve ${input.canary} until next month.`,
  };
  if (input.state && input.state !== 'active') {
    const text = transitionText[input.state];
    if (!text) throw new Error(`Unsupported privacy fixture ${input.state}.`);
    commitment = interpretedCommitment({
      threadId: input.id,
      title,
      text,
      current: commitment,
    });
  }
  const projection = projectLifeThreadCommitment(
    commitment,
    PROVIDER_PRIVACY_NOW,
  );
  const thread: LifeThread = {
    id: input.id,
    groupFolder: 'main',
    title,
    category: 'personal',
    status: projection.status,
    scope: 'personal',
    relatedSubjectIds: [],
    contextTags: ['council-privacy-fixture'],
    summary: `Private source detail ${input.canary}.`,
    nextAction: projection.nextAction,
    nextFollowupAt: projection.nextFollowupAt,
    sourceKind: 'calendar',
    confidenceKind: commitment.confidenceKind,
    commitment,
    userConfirmed: true,
    sensitivity: 'normal',
    surfaceMode: input.surfaceMode || 'default',
    followthroughMode: input.followthroughMode || projection.followthroughMode,
    lastSurfacedAt: null,
    snoozedUntil: input.snoozedUntil ?? projection.snoozedUntil,
    linkedTaskId: null,
    mergedIntoThreadId: null,
    createdAt: PROVIDER_PRIVACY_NOW.toISOString(),
    lastUpdatedAt: PROVIDER_PRIVACY_NOW.toISOString(),
    lastUsedAt: null,
  };
  upsertLifeThread(thread);
  return thread;
}

describe('council evidence scorecard', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('summarizes evidence coverage and applies deterministic penalties', () => {
    const scorecard = buildCouncilEvidenceScorecard({
      requiredEvidence: 'strong',
      rawContentPolicy: 'sanitized_snippets',
      overallGrade: 'partial',
      gaps: ['provider_gemini_cloud_not_configured', 'no_saved_knowledge_hits'],
      cards: [
        {
          evidenceId: 'intent:test',
          sourceClass: 'user_input',
          evidenceGrade: 'partial',
          freshness: 'fresh',
          sensitivity: 'private',
          summary: 'Sanitized goal.',
        },
        {
          evidenceId: 'provider_health:gemini_cloud',
          sourceClass: 'provider_health',
          evidenceGrade: 'weak',
          freshness: 'fresh',
          sensitivity: 'normal',
          summary: 'Provider is not configured.',
        },
        {
          evidenceId: 'policy:sanitized_snippets',
          sourceClass: 'policy',
          evidenceGrade: 'partial',
          freshness: 'not_applicable',
          sensitivity: 'normal',
          summary: 'No raw private bodies.',
        },
      ],
    });

    expect(scorecard.requiredGrade).toBe('strong');
    expect(scorecard.availableGrade).toBe('partial');
    expect(scorecard.gapCount).toBe(2);
    expect(scorecard.sourceCoverage).toMatchObject({
      user_input: 1,
      provider_health: 1,
      policy: 1,
    });
    expect(scorecard.createSafetyCoverage).toMatchObject({
      unknown: 3,
    });
    expect(scorecard.citationCoverage).toMatchObject({
      total: 3,
      cited: 0,
      missing: 3,
    });
    expect(scorecard.averageSourcePriority).toBe(0);
    expect(scorecard.freshnessCoverage).toMatchObject({
      total: 3,
      fresh: 2,
      notApplicable: 1,
    });
    expect(scorecard.confidencePenalty).toBeGreaterThan(0);
  });

  it('does not inject personal-assistant memory into research evidence', () => {
    const pack = buildCouncilEvidencePack({
      goal: 'Compare public approaches to provider observability.',
      taskFamily: 'research',
      groupFolder: 'main',
      requiredEvidence: 'partial',
      rawContentPolicy: 'sanitized_snippets',
      correlationId: 'research-scope-proof',
    });

    expect(pack.cards.some((card) => card.sourceClass === 'local_memory')).toBe(
      false,
    );
    expect(pack.gaps).not.toContain('no_profile_facts');
    expect(pack.gaps).not.toContain('no_active_life_threads');
    expect(
      pack.cards.some((card) =>
        card.evidenceId.startsWith('integration_status:'),
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: 'manual-only',
      state: 'active' as const,
      surfaceMode: 'manual_only' as const,
    },
    {
      label: 'followthrough-off',
      state: 'active' as const,
      followthroughMode: 'off' as const,
    },
    {
      label: 'future-snoozed',
      state: 'active' as const,
      snoozedUntil: '2026-07-15T10:05:00.000Z',
    },
    { label: 'waiting', state: 'waiting' as const },
    { label: 'blocked', state: 'blocked' as const },
    { label: 'delegated', state: 'delegated' as const },
    { label: 'deferred', state: 'deferred' as const },
  ])(
    'keeps $label life-thread content out of provider-visible snippets',
    (fixture) => {
      const canary = `PRIVATE-LIFE-THREAD-${fixture.label.toUpperCase()}`;
      const thread = upsertProviderPrivacyThread({
        id: `privacy-${fixture.label}`,
        canary,
        state: fixture.state,
        surfaceMode: fixture.surfaceMode,
        followthroughMode: fixture.followthroughMode,
        snoozedUntil: fixture.snoozedUntil,
      });
      setPersonalMemoryPolicy({
        groupFolder: 'main',
        source: 'calendar',
        enabled: true,
        allowDerivedFacts: true,
        now: PROVIDER_PRIVACY_NOW,
      });

      const pack = buildCouncilEvidencePack({
        goal: 'Organize my day without exposing suppressed local context.',
        taskFamily: 'assistant',
        groupFolder: 'main',
        rawContentPolicy: 'sanitized_snippets',
        providerConsentedSources: ['calendar'],
        providerHealthSnapshots: [],
        correlationId: `privacy-${fixture.label}`,
        now: PROVIDER_PRIVACY_NOW,
      });
      const card = pack.cards.find(
        (candidate) => candidate.evidenceId === `life_thread:${thread.id}`,
      );
      const providerVisible = summarizeCouncilEvidencePack(pack);

      expect(providerVisible).not.toContain(canary);
      if (card) {
        expect(card.summary).toContain('Life-thread metadata');
        expect(JSON.stringify(card)).not.toContain(canary);
      } else {
        expect(fixture.state).toBe('deferred');
      }
    },
  );

  it('requires local source opt-in and explicit provider-egress source consent before exposing a life-thread snippet', () => {
    const canary = 'PRIVATE-LIFE-THREAD-SOURCE-CONSENT';
    const thread = upsertProviderPrivacyThread({
      id: 'privacy-source-consent',
      canary,
      state: 'active',
    });
    const build = (providerConsentedSources: Array<'calendar'> = []) =>
      buildCouncilEvidencePack({
        goal: 'Organize my day with explicitly approved context.',
        taskFamily: 'assistant',
        groupFolder: 'main',
        rawContentPolicy: 'sanitized_snippets',
        providerConsentedSources,
        providerHealthSnapshots: [],
        correlationId: `source-consent-${providerConsentedSources.length}`,
        now: PROVIDER_PRIVACY_NOW,
      });
    const cardFor = (pack: ReturnType<typeof buildCouncilEvidencePack>) =>
      pack.cards.find(
        (candidate) => candidate.evidenceId === `life_thread:${thread.id}`,
      );

    const noMemoryPolicy = build(['calendar']);
    expect(cardFor(noMemoryPolicy)?.summary).toContain('Life-thread metadata');
    expect(summarizeCouncilEvidencePack(noMemoryPolicy)).not.toContain(canary);

    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'calendar',
      enabled: true,
      allowDerivedFacts: false,
      now: PROVIDER_PRIVACY_NOW,
    });
    const derivedFactsDisabled = build(['calendar']);
    expect(summarizeCouncilEvidencePack(derivedFactsDisabled)).not.toContain(
      canary,
    );

    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'calendar',
      enabled: true,
      allowDerivedFacts: true,
      now: new Date(PROVIDER_PRIVACY_NOW.getTime() + 1_000),
    });
    const missingProviderConsent = build();
    expect(summarizeCouncilEvidencePack(missingProviderConsent)).not.toContain(
      canary,
    );

    const fullyConsented = build(['calendar']);
    expect(cardFor(fullyConsented)?.summary).toContain(canary);
    expect(summarizeCouncilEvidencePack(fullyConsented)).toContain(canary);

    setPersonalMemoryPolicy({
      groupFolder: 'main',
      source: 'calendar',
      enabled: false,
      now: new Date(PROVIDER_PRIVACY_NOW.getTime() + 2_000),
    });
    const revoked = build(['calendar']);
    expect(cardFor(revoked)?.summary).toContain('Life-thread metadata');
    expect(summarizeCouncilEvidencePack(revoked)).not.toContain(canary);
  });

  it('keeps sensitive commitment content out of provider-available evidence', () => {
    upsertLifeThread({
      id: 'private-medical-thread',
      groupFolder: 'main',
      title: 'Secret oncology biopsy decision',
      category: 'health',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: [],
      contextTags: ['medical'],
      summary: 'Private stage four oncology result.',
      nextAction: 'Call Dr Smith about the stage four result.',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      userConfirmed: true,
      sensitivity: 'sensitive',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
      mergedIntoThreadId: null,
      createdAt: '2026-07-14T10:00:00.000Z',
      lastUpdatedAt: '2026-07-14T10:00:00.000Z',
      lastUsedAt: null,
    });

    for (const rawContentPolicy of [
      'metadata_only',
      'sanitized_snippets',
    ] as const) {
      const pack = buildCouncilEvidencePack({
        goal: 'Help me organize today.',
        taskFamily: 'assistant',
        groupFolder: 'main',
        rawContentPolicy,
        correlationId: `private-proof-${rawContentPolicy}`,
        now: new Date('2026-07-14T10:05:00.000Z'),
      });
      const providerVisible = summarizeCouncilEvidencePack(pack);
      const lifeThreadCard = pack.cards.find(
        (card) => card.evidenceId === 'life_thread:private-medical-thread',
      );

      expect(lifeThreadCard?.availableToCouncil).toBe(true);
      expect(lifeThreadCard?.summary).toContain('Life-thread metadata');
      expect(providerVisible).not.toContain('oncology');
      expect(providerVisible).not.toContain('stage four');
      expect(providerVisible).not.toContain('Dr Smith');
      expect(JSON.stringify(lifeThreadCard)).not.toContain('biopsy');
    }
  });

  it('withholds raw intent and metadata values under metadata-only policy', () => {
    const pack = buildCouncilEvidencePack({
      goal: 'Plan around PRIVATE-CODENAME-ZEPHYR without exposing it.',
      taskFamily: 'assistant',
      groupFolder: 'main',
      rawContentPolicy: 'metadata_only',
      metadata: {
        operator_note: 'PRIVATE-METADATA-ORCHID',
        route: 'PRIVATE-ROUTE-LAVENDER',
      },
      correlationId: 'metadata-policy-proof',
      now: new Date('2026-07-14T10:05:00.000Z'),
    });

    const providerVisible = summarizeCouncilEvidencePack(pack);
    expect(providerVisible).toContain('Intent metadata');
    expect(providerVisible).toContain('operator_note');
    expect(providerVisible).not.toContain('PRIVATE-CODENAME-ZEPHYR');
    expect(providerVisible).not.toContain('PRIVATE-METADATA-ORCHID');
    expect(providerVisible).not.toContain('PRIVATE-ROUTE-LAVENDER');
  });

  it('keeps explicitly local-only cards unavailable after contract enrichment', () => {
    const pack = buildCouncilEvidencePack({
      goal: 'PRIVATE-LOCAL-ONLY-GOAL',
      taskFamily: 'assistant',
      groupFolder: 'main',
      rawContentPolicy: 'local_only',
      metadata: { note: 'PRIVATE-LOCAL-ONLY-METADATA' },
      correlationId: 'local-only-proof',
      now: new Date('2026-07-14T10:05:00.000Z'),
    });
    const providerVisible = summarizeCouncilEvidencePack(pack);
    const privateCards = pack.cards.filter((card) =>
      ['user_input', 'local_memory', 'knowledge'].includes(card.sourceClass),
    );

    expect(privateCards.length).toBeGreaterThan(0);
    expect(
      privateCards.every((card) => card.availableToCouncil === false),
    ).toBe(true);
    expect(providerVisible).not.toContain('intent:local-only-proof');
    expect(providerVisible).not.toContain('PRIVATE-LOCAL-ONLY-GOAL');
    expect(providerVisible).not.toContain('PRIVATE-LOCAL-ONLY-METADATA');
  });

  it('keeps the intent and privacy policy in bounded evidence summaries', () => {
    const pack = buildCouncilEvidencePack({
      goal: 'Review local runtime status.',
      taskFamily: 'operator',
      groupFolder: 'main',
      correlationId: 'bounded-summary-proof',
    });
    for (let index = 0; index < 10; index += 1) {
      pack.cards.push({
        evidenceId: `extra:${index}`,
        sourceClass: 'runtime',
        evidenceGrade: 'partial',
        freshness: 'fresh',
        sensitivity: 'normal',
        summary: `Extra runtime evidence ${index}.`,
        sourcePriority: 120,
      });
    }

    const summary = summarizeCouncilEvidencePack(pack);

    expect(summary).toContain('intent:bounded-summary-proof');
    expect(summary).toContain('policy:sanitized_snippets');
  });

  it('uses injected live provider evidence without configuration-only unknown gaps', () => {
    const checkedAt = '2026-07-12T22:00:00.000Z';
    const pack = buildCouncilEvidencePack({
      goal: 'Review local runtime status.',
      taskFamily: 'operator',
      correlationId: 'live-provider-evidence',
      providerHealthSnapshots: [
        {
          providerId: 'openai_cloud',
          kind: 'llm',
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
          metadata: { healthEvidence: 'live_probe', liveProbe: 'ok' },
        },
      ],
    });

    expect(pack.gaps).not.toContain('provider_openai_cloud_unknown');
    expect(
      pack.cards.find(
        (card) => card.evidenceId === 'provider_health:openai_cloud',
      ),
    ).toMatchObject({ evidenceGrade: 'partial', gap: null });
  });
});
