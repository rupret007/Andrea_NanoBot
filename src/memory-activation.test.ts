import { beforeEach, describe, expect, it } from 'vitest';

import {
  createTask,
  listProfileFactsForGroup,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertOperatingProfile,
  upsertProfileFact,
  upsertProfileSubject,
  _initTestDatabase,
} from './db.js';
import {
  explainMemoryUse,
  formatRedactedProfilePackExport,
  formatSetupCompletenessStatus,
  handleMemoryActivationCommand,
} from './memory-activation.js';
import { upsertOutcomeRecord } from './outcome-reviews.js';
import type { OperatingProfilePlan } from './types.js';

const now = new Date('2026-06-18T12:00:00.000Z');
const nowIso = now.toISOString();

function seedSelf(): void {
  upsertProfileSubject({
    id: 'subject-self',
    groupFolder: 'main',
    kind: 'self',
    canonicalName: 'self',
    displayName: 'You',
    createdAt: nowIso,
    updatedAt: nowIso,
    disabledAt: null,
  });
}

function seedProfile(): void {
  const plan: OperatingProfilePlan = {
    summary: 'Andrea should keep replies and family logistics moving.',
    trackedAreas: ['messages', 'errands'],
    defaultGroups: [
      {
        title: 'Family logistics',
        kind: 'general',
        scope: 'family',
        purpose: 'Keep family loose ends visible.',
      },
    ],
    routines: ['morning check-in'],
    reminderSuggestions: [],
    richerSurface: 'telegram',
    desiredIntegrations: [],
    learningPolicy: 'suggest_then_confirm',
  };
  upsertOperatingProfile({
    profileId: 'profile-main',
    groupFolder: 'main',
    status: 'active',
    version: 1,
    basedOnProfileId: null,
    intakeJson: JSON.stringify({
      rawText: 'setup',
      routines: plan.routines,
      trackingPriorities: plan.trackedAreas,
      defaultGroups: ['Family logistics'],
      integrationsWanted: ['BlueBubbles'],
      richerSurface: 'telegram',
      scope: 'family',
      notes: [],
    }),
    planJson: JSON.stringify(plan),
    sourceChannel: 'telegram',
    createdAt: nowIso,
    updatedAt: nowIso,
    approvedAt: nowIso,
    supersededAt: null,
  });
}

describe('memory activation', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('formats setup completeness and redacted profile packs', () => {
    seedSelf();
    seedProfile();
    upsertProfileFact({
      id: 'fact-private',
      groupFolder: 'main',
      subjectId: 'subject-self',
      category: 'preferences',
      factKey: 'setup.privacy_comfort',
      valueJson: JSON.stringify({
        value: 'Do not expose +14695550123 or bb:iMessage;-;+14695550123.',
        memoryScope: 'user',
        confidence: 0.82,
        freshness: 'current',
        source: 'guided_profile_setup',
      }),
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'private number +14695550123',
      createdAt: nowIso,
      updatedAt: nowIso,
      decidedAt: nowIso,
    });

    expect(
      formatSetupCompletenessStatus({ groupFolder: 'main', now }),
    ).toContain('AGI daily-agent readiness');
    expect(
      formatSetupCompletenessStatus({ groupFolder: 'main', now }),
    ).toContain('Missing setup areas');
    expect(
      formatSetupCompletenessStatus({ groupFolder: 'main', now }),
    ).toContain('Next setup question');
    expect(
      formatSetupCompletenessStatus({ groupFolder: 'main', now }),
    ).toContain('finish my Andrea setup');
    const pack = formatRedactedProfilePackExport({
      groupFolder: 'main',
      channel: 'telegram',
      now,
    });
    expect(pack).toContain('redacted Andrea profile pack');
    expect(pack).not.toContain('+14695550123');
    expect(pack).not.toContain('bb:iMessage');
  });

  it('explains accepted memory facts with source, confidence, and freshness', () => {
    seedSelf();
    upsertProfileFact({
      id: 'fact-style',
      groupFolder: 'main',
      subjectId: 'subject-self',
      category: 'conversational_style',
      factKey: 'setup.communication_style',
      valueJson: JSON.stringify({
        value: 'Warm but concise.',
        memoryScope: 'user',
        confidence: 0.86,
        freshness: 'current',
        source: 'guided_profile_setup',
      }),
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'User asked for warm concise style.',
      createdAt: nowIso,
      updatedAt: nowIso,
      decidedAt: nowIso,
    });

    const reply = explainMemoryUse({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'why do you know that?',
      factIdHint: 'fact-style',
      now,
    });

    expect(reply).toContain('guided setup');
    expect(reply).toContain('guided_profile_setup');
    expect(reply).toContain('Warm but concise');
    expect(reply).toContain('86%');
    expect(reply).toContain('current');
  });

  it('runs daily learning review and keeps sensitive updates proposed until accepted', () => {
    seedSelf();
    upsertCommunicationThread({
      id: 'comm-sensitive',
      groupFolder: 'main',
      title: 'Riley',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: 'bb:iMessage;-;+14695550123',
      lastInboundSummary: 'Riley asked about a private health appointment.',
      lastOutboundSummary: null,
      followupState: 'reply_needed',
      urgency: 'tonight',
      followupDueAt: null,
      suggestedNextAction: 'draft_reply',
      toneStyleHints: ['careful'],
      lastContactAt: nowIso,
      lastMessageId: null,
      linkedTaskId: null,
      inferenceState: 'assistant_inferred',
      trackingMode: 'default',
      createdAt: nowIso,
      updatedAt: nowIso,
      disabledAt: null,
    });
    upsertLifeThread({
      id: 'life-sensitive',
      groupFolder: 'main',
      title: 'Health follow-through',
      category: 'health',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-self'],
      contextTags: ['health'],
      summary: 'Private appointment details should be handled carefully.',
      nextAction: 'Check what needs a reply.',
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
      createdAt: nowIso,
      lastUpdatedAt: nowIso,
      lastUsedAt: nowIso,
    });
    createTask({
      id: 'task-private',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt: 'Check private health appointment',
      schedule_type: 'once',
      schedule_value: nowIso,
      context_mode: 'group',
      next_run: nowIso,
      status: 'active',
      created_at: nowIso,
    });

    const review = handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'what did you learn about me?',
      now,
    });

    expect(review.responseText).toContain('proposed learning');
    expect(review.responseText).toContain('text review:');
    expect(review.responseText).toContain('life threads:');
    expect(review.responseText).toContain('tasks and reminders:');
    expect(review.responseText).toContain('Sensitive: review first');
    expect(listProfileFactsForGroup('main', ['accepted'])).toHaveLength(0);
    expect(
      listProfileFactsForGroup('main', ['proposed']).some((fact) =>
        fact.factKey.startsWith('learning.'),
      ),
    ).toBe(true);

    const accept = handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'accept learning #1',
      now,
    });
    expect(accept.responseText).toContain('Accepted learning #1');
    expect(listProfileFactsForGroup('main', ['accepted']).length).toBe(1);
    const accepted = listProfileFactsForGroup('main', ['accepted'])[0]!;
    expect(accepted.valueJson).toContain('"freshness":"current"');

    const explanation = explainMemoryUse({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'why do you know that?',
      factIdHint: accept.referencedFactId,
      now,
    });
    expect(explanation).toContain('daily learning review');
    expect(explanation).toContain('current');

    handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'daily learning review',
      now,
    });
    const stillAccepted = listProfileFactsForGroup('main', ['accepted']).find(
      (fact) => fact.id === accepted.id,
    );
    expect(stillAccepted?.valueJson).toContain('"freshness":"current"');
  });

  it('proposes memory from repeated follow-through outcomes without auto-accepting sensitive patterns', () => {
    seedSelf();
    upsertOutcomeRecord({
      groupFolder: 'main',
      sourceType: 'followthrough_candidate',
      sourceKey: 'followthrough:health-1',
      status: 'completed',
      completionSummary:
        'Marked follow-through handled for a private health appointment.',
      linkedRefs: {
        followthroughCandidateId: 'followthrough:health-1',
        agentOSEpisodeId: 'agentos:episode:followthrough:health-1',
      },
      now,
    });
    upsertOutcomeRecord({
      groupFolder: 'main',
      sourceType: 'followthrough_candidate',
      sourceKey: 'followthrough:health-2',
      status: 'deferred',
      completionSummary: 'Deferred follow-through about health paperwork.',
      nextFollowupText: 'Bring this back in a later follow-through review.',
      linkedRefs: {
        followthroughCandidateId: 'followthrough:health-2',
      },
      now,
    });

    const review = handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'what did you learn about me?',
      now,
    });

    expect(review.responseText).toContain('outcomes:');
    expect(review.responseText).toContain('Follow-through outcomes');
    expect(review.responseText).toContain('Sensitive: review first');
    expect(listProfileFactsForGroup('main', ['accepted'])).toHaveLength(0);
    const proposed = listProfileFactsForGroup('main', ['proposed']);
    expect(
      proposed.some((fact) =>
        fact.factKey.startsWith('learning.outcome.followthrough.'),
      ),
    ).toBe(true);

    const accept = handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'accept learning #1',
      now,
    });
    const explanation = explainMemoryUse({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'why do you know that?',
      factIdHint: accept.referencedFactId,
      now,
    });
    expect(explanation).toContain('follow-through outcome review');
    expect(explanation).toContain('Confidence');
    expect(explanation).toContain('current');
  });

  it('supports editing and rejecting proposed learning items', () => {
    seedSelf();
    createTask({
      id: 'task-logistics',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt: 'Check school forms',
      schedule_type: 'once',
      schedule_value: nowIso,
      context_mode: 'group',
      next_run: nowIso,
      status: 'active',
      created_at: nowIso,
    });

    handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'daily learning review',
      now,
    });
    const edit = handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'edit learning #1: school forms are a recurring family logistics risk',
      now,
    });
    expect(edit.responseText).toContain('still proposed');
    expect(listProfileFactsForGroup('main', ['accepted'])).toHaveLength(0);

    const reject = handleMemoryActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'reject learning #1',
      now,
    });
    expect(reject.responseText).toContain('rejected');
    expect(listProfileFactsForGroup('main', ['rejected'])).toHaveLength(1);
  });
});
