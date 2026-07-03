import { beforeEach, describe, expect, it } from 'vitest';

import {
  createTask,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertOperatingProfile,
  upsertProfileFact,
  upsertProfileSubject,
  _initTestDatabase,
} from './db.js';
import {
  buildAgiLeapReadinessReport,
  buildCouncilGovernedDeepWorkBlueprint,
  makeAndreaSkillManifest,
} from './agi-leap-readiness.js';
import { applyFollowThroughActivation } from './follow-through-activation.js';
import {
  exportRedactedOnboardingProfilePack,
  importRedactedOnboardingProfilePack,
} from './onboarding-profile-pack.js';
import {
  buildPersonalContextGraph,
  formatPersonalContextGraphSummary,
} from './personal-context-graph.js';
import type { OperatingProfilePlan } from './types.js';

const now = '2026-06-18T12:00:00.000Z';

function seedSyntheticLife(
  groupFolder = 'main',
  options: { activeReminder?: boolean } = {},
): void {
  const plan: OperatingProfilePlan = {
    summary:
      'Andrea should help keep family logistics and important replies moving.',
    trackedAreas: ['messages', 'bills', 'errands'],
    defaultGroups: [
      {
        title: 'Family logistics',
        kind: 'general',
        scope: 'family',
        purpose: 'Keep family follow-through visible.',
      },
    ],
    routines: ['morning check-in'],
    reminderSuggestions: ['suggest reminders before things slip'],
    richerSurface: 'telegram',
    desiredIntegrations: [],
    learningPolicy: 'suggest_then_confirm',
  };
  upsertOperatingProfile({
    profileId: 'profile-main',
    groupFolder,
    status: 'active',
    version: 1,
    basedOnProfileId: null,
    intakeJson: JSON.stringify({
      rawText: 'Synthetic onboarding intake.',
      routines: plan.routines,
      trackingPriorities: plan.trackedAreas,
      defaultGroups: ['Family logistics'],
      integrationsWanted: ['Telegram', 'BlueBubbles'],
      richerSurface: 'telegram',
      scope: 'family',
      notes: [],
    }),
    planJson: JSON.stringify(plan),
    sourceChannel: 'telegram',
    createdAt: now,
    updatedAt: now,
    approvedAt: now,
    supersededAt: null,
  });
  upsertProfileSubject({
    id: 'subject-self',
    groupFolder,
    kind: 'self',
    canonicalName: 'self',
    displayName: 'You',
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
  });
  upsertProfileSubject({
    id: 'subject-riley',
    groupFolder,
    kind: 'person',
    canonicalName: 'riley',
    displayName: 'Riley',
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
  });
  upsertProfileFact({
    id: 'fact-style',
    groupFolder,
    subjectId: 'subject-self',
    category: 'conversational_style',
    factKey: 'setup.communication_style',
    valueJson: JSON.stringify({
      value: 'Warm, concise, and do not expose +14695550123.',
      memoryScope: 'user',
      confidence: 0.86,
      freshness: 'current',
      source: 'guided_profile_setup',
    }),
    state: 'accepted',
    sourceChannel: 'telegram',
    sourceSummary: 'Warm concise style with a private phone number.',
    createdAt: now,
    updatedAt: now,
    decidedAt: now,
  });
  upsertLifeThread({
    id: 'thread-school',
    groupFolder,
    title: 'School logistics',
    category: 'school',
    status: 'active',
    scope: 'family',
    relatedSubjectIds: ['subject-riley'],
    contextTags: ['school', 'family'],
    summary: 'Keep school forms and pickup changes from slipping.',
    nextAction: 'Check whether anything needs a reply.',
    nextFollowupAt: null,
    sourceKind: 'explicit',
    confidenceKind: 'explicit',
    userConfirmed: true,
    sensitivity: 'normal',
    surfaceMode: 'default',
    followthroughMode: 'important_only',
    lastSurfacedAt: null,
    snoozedUntil: null,
    linkedTaskId: null,
    mergedIntoThreadId: null,
    createdAt: now,
    lastUpdatedAt: now,
    lastUsedAt: now,
  });
  upsertCommunicationThread({
    id: 'comm-riley',
    groupFolder,
    title: 'Riley',
    linkedSubjectIds: ['subject-riley'],
    linkedLifeThreadIds: ['thread-school'],
    channel: 'bluebubbles',
    channelChatJid: 'bb:iMessage;-;+14695550123',
    lastInboundSummary: 'Riley asked whether the form is ready.',
    lastOutboundSummary: null,
    followupState: 'reply_needed',
    urgency: 'tonight',
    followupDueAt: null,
    suggestedNextAction: 'draft_reply',
    toneStyleHints: ['warm'],
    lastContactAt: now,
    lastMessageId: null,
    linkedTaskId: null,
    inferenceState: 'assistant_inferred',
    trackingMode: 'default',
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
  });
  if (options.activeReminder !== false) {
    createTask({
      id: 'task-school-form',
      group_folder: groupFolder,
      chat_jid: 'tg:main',
      prompt: 'Check school form',
      schedule_type: 'once',
      schedule_value: now,
      context_mode: 'group',
      next_run: now,
      status: 'active',
      created_at: now,
    });
  }
}

describe('AGI leap readiness', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('exports and imports a redacted onboarding profile pack', () => {
    seedSyntheticLife();

    const pack = exportRedactedOnboardingProfilePack({
      groupFolder: 'main',
      now: new Date(now),
    });
    const serialized = JSON.stringify(pack);

    expect(pack.setupCompleteness.hasActiveProfile).toBe(true);
    expect(pack.memoryQuality.acceptedFacts).toBeGreaterThan(0);
    expect(serialized).not.toContain('+14695550123');
    expect(serialized).not.toContain('bb:iMessage');
    expect(pack.privacy.rawIdentifiersIncluded).toBe(false);

    const imported = importRedactedOnboardingProfilePack({
      groupFolder: 'second_user',
      pack,
      now: new Date(now),
    });
    expect(imported.profile.status).toBe('draft');
    expect(imported.profile.sourceChannel).toBe('system');
  });

  it('builds a metadata-only personal context graph for daily intelligence', () => {
    seedSyntheticLife();

    const graph = buildPersonalContextGraph({
      groupFolder: 'main',
      now: new Date(now),
    });
    const serialized = JSON.stringify(graph);

    expect(graph.coverage.activeProfile).toBe(true);
    expect(graph.coverage.people).toBe(1);
    expect(graph.coverage.linkedCommunicationThreads).toBe(1);
    expect(graph.coverage.followthroughCandidates).toBeGreaterThan(0);
    expect(
      graph.nodes.some((node) => node.nodeKind === 'followthrough_candidate'),
    ).toBe(true);
    expect(graph.dailyIntelligenceQuestions).toContain('Who needs a reply?');
    expect(graph.rankedInsights[0]?.kind).toBe('needs_reply');
    expect(graph.rankedInsights[0]?.nextAction).toContain('draft');
    expect(graph.readinessScore).toBeGreaterThan(0.5);
    expect(serialized).not.toContain('+14695550123');
    expect(serialized).not.toContain('bb:iMessage');
    expect(serialized).not.toContain('Riley asked whether the form is ready');
    expect(serialized).not.toMatch(/they said\s+"/i);
    expect(formatPersonalContextGraphSummary(graph)).toContain(
      'Personal context graph readiness',
    );
  });

  it('distinguishes proposed follow-through candidates from active reminders', () => {
    seedSyntheticLife('no-active-reminders', { activeReminder: false });

    const graph = buildPersonalContextGraph({
      groupFolder: 'no-active-reminders',
      now: new Date(now),
    });
    const serialized = JSON.stringify(graph);

    expect(graph.coverage.reminders).toBe(0);
    expect(graph.coverage.followthroughCandidates).toBeGreaterThan(0);
    expect(graph.topGaps).toEqual(
      expect.arrayContaining([expect.stringContaining('Approve one proposed')]),
    );
    expect(graph.rankedInsights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'prepare',
          riskFlags: expect.arrayContaining([
            'proposed_only',
            'approval_required',
          ]),
        }),
      ]),
    );
    expect(serialized).not.toContain('+14695550123');
    expect(serialized).not.toContain('bb:iMessage');
  });

  it('raises durable autonomy only after a verified local follow-through chain exists', async () => {
    seedSyntheticLife('activation-loop', { activeReminder: false });

    const before = buildAgiLeapReadinessReport({
      groupFolder: 'activation-loop',
      now: new Date(now),
    });
    expect(before.contextGraph.coverage.reminders).toBe(0);

    const activation = await applyFollowThroughActivation({
      groupFolder: 'activation-loop',
      candidate: 'safest',
      timing: 'tonight',
      chatJid: 'local:followthrough:activation-loop',
      now: new Date(now),
    });
    const after = buildAgiLeapReadinessReport({
      groupFolder: 'activation-loop',
      now: new Date(now),
    });

    expect(activation.applied).toBe(true);
    expect(activation.mutationSummary).toMatchObject({
      localReminderMetadata: true,
      outcomeRecord: true,
      agentOSEpisode: true,
      liveMessageSent: false,
      calendarWritten: false,
    });
    expect(after.contextGraph.coverage.reminders).toBe(1);
    expect(after.durableAutonomyScore).toBeGreaterThan(
      before.durableAutonomyScore,
    );
    expect(after.contextGraph.rankedInsights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          riskFlags: expect.arrayContaining(['followthrough_approved']),
        }),
      ]),
    );
  });

  it('surfaces skill safety and council-governed deep-work readiness', () => {
    seedSyntheticLife();

    const skill = makeAndreaSkillManifest({
      generatedAt: now,
      skillId: 'communication.review_recent_texts',
      summary: 'Review recent texts and suggest approval-gated follow-ups.',
      permissions: ['read_bluebubbles_history', 'write_review_summary'],
      safetyClass: 'approval_gated_write',
      setupChecklist: ['Connect BlueBubbles', 'Run text review privacy tests'],
      trigger: { naturalLanguage: ['review my texts'] },
      toolRefs: ['bluebubbles.history'],
      evidenceNeeds: ['recent synced message history'],
    });
    const frontmatter = JSON.parse(skill.frontmatterJson);
    expect(frontmatter.permissions).toContain('read_bluebubbles_history');
    expect(frontmatter.safetyClass).toBe('approval_gated_write');

    const blueprint = buildCouncilGovernedDeepWorkBlueprint({
      generatedAt: now,
    });
    expect(blueprint.stages.map((stage) => stage.stageId)).toEqual([
      'plan',
      'approval',
      'resume',
      'verify',
      'record_outcome',
      'learn_safe_lessons',
    ]);
    expect(blueprint.safetyInvariants).toContain('No automatic message sends.');

    const report = buildAgiLeapReadinessReport({
      groupFolder: 'main',
      now: new Date(now),
    });
    expect(report.overallScore).toBeGreaterThan(0.4);
    expect(report.textReviewScore).toBeGreaterThan(0);
    expect(report.councilHealthScore).toBeGreaterThan(0);
    expect(report.privacy.automaticSendsEnabled).toBe(false);
    expect(report.topNextImprovement).toBeTruthy();
  });
});
