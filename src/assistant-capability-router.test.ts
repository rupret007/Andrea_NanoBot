import { describe, expect, it } from 'vitest';

import {
  continueAssistantCapabilityFromPriorSubjectData,
  continueAssistantCapabilityFromAlexaState,
  matchAssistantCapabilityRequest,
  resolveAlexaIntentToCapability,
} from './assistant-capability-router.js';
import type { AlexaConversationState } from './alexa-conversation.js';

describe('assistant capability router', () => {
  it('matches shared daily and household requests', () => {
    expect(
      matchAssistantCapabilityRequest('What am I forgetting?'),
    ).toMatchObject({
      capabilityId: 'daily.loose_ends',
    });
    expect(
      matchAssistantCapabilityRequest('What about Candace?'),
    ).toMatchObject({
      capabilityId: 'household.candace_upcoming',
    });
    expect(
      matchAssistantCapabilityRequest('What threads do I have open?'),
    ).toMatchObject({
      capabilityId: 'threads.list_open',
    });
  });

  it('matches bounded research prompts without inventing new intents', () => {
    expect(
      matchAssistantCapabilityRequest(
        'Compare meal delivery options for this week',
      ),
    ).toMatchObject({
      capabilityId: 'research.compare',
    });
    expect(
      matchAssistantCapabilityRequest(
        'What is the best choice about weekend plans',
      ),
    ).toMatchObject({
      capabilityId: 'research.recommend',
    });
    expect(
      matchAssistantCapabilityRequest(
        'What should I know before deciding on meal delivery?',
      ),
    ).toMatchObject({
      capabilityId: 'research.recommend',
    });
    expect(
      matchAssistantCapabilityRequest("What is Jar Jar Binks' species?"),
    ).toMatchObject({
      capabilityId: 'research.topic',
    });
    expect(
      matchAssistantCapabilityRequest(
        'What should I know about Jar Jar Binks?',
      ),
    ).toMatchObject({
      capabilityId: 'research.topic',
    });
  });

  it('matches explicit knowledge-library prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest('Save this to my library'),
    ).toMatchObject({
      capabilityId: 'knowledge.save_source',
    });
    expect(
      matchAssistantCapabilityRequest(
        'What do my saved notes say about Candace?',
      ),
    ).toMatchObject({
      capabilityId: 'knowledge.summarize_saved',
    });
    expect(
      matchAssistantCapabilityRequest('What sources are you using?'),
    ).toMatchObject({
      capabilityId: 'knowledge.explain_sources',
    });
  });

  it('matches communication-companion prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest(
        'Summarize this message: Candace: can you let me know if dinner still works tonight?',
      ),
    ).toMatchObject({
      capabilityId: 'communication.understand_message',
    });
    expect(
      matchAssistantCapabilityRequest('What should I say back to Candace?'),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
    });
    expect(
      matchAssistantCapabilityRequest('What do I owe people right now?'),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
    });
    expect(
      matchAssistantCapabilityRequest("What's still open with Candace?"),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
    });
    expect(
      matchAssistantCapabilityRequest('What should I talk to Candace about?'),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
    });
    expect(
      matchAssistantCapabilityRequest('Remind me to reply later'),
    ).toMatchObject({
      capabilityId: 'communication.manage_tracking',
    });
    expect(
      matchAssistantCapabilityRequest('@Andrea what should I say back?'),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
    });
    expect(
      matchAssistantCapabilityRequest('@Andrea summarize this'),
    ).toMatchObject({
      capabilityId: 'communication.understand_message',
    });
  });

  it('matches chief-of-staff prioritization, prep, decision, and explainability prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest('What matters most today?'),
    ).toMatchObject({
      capabilityId: 'staff.prioritize',
    });
    expect(
      matchAssistantCapabilityRequest('What should I prepare before tonight?'),
    ).toMatchObject({
      capabilityId: 'staff.prepare',
    });
    expect(
      matchAssistantCapabilityRequest(
        'Should I handle this tonight or tomorrow?',
      ),
    ).toMatchObject({
      capabilityId: 'staff.decision_support',
    });
    expect(
      matchAssistantCapabilityRequest('Why are you prioritizing that?'),
    ).toMatchObject({
      capabilityId: 'staff.explain',
    });
  });

  it('matches mission planning and mission control prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest(
        'Help me plan Friday dinner with Candace',
      ),
    ).toMatchObject({
      capabilityId: 'missions.propose',
    });
    expect(
      matchAssistantCapabilityRequest("What's my plan for this weekend?"),
    ).toMatchObject({
      capabilityId: 'missions.propose',
    });
    expect(matchAssistantCapabilityRequest('Save this plan')).toMatchObject({
      capabilityId: 'missions.manage',
    });
    expect(
      matchAssistantCapabilityRequest("What's blocking this?"),
    ).toMatchObject({
      capabilityId: 'missions.explain',
    });
  });

  it('matches ritual status, control, and follow-through prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest('What rituals do I have enabled?'),
    ).toMatchObject({
      capabilityId: 'rituals.status',
    });
    expect(
      matchAssistantCapabilityRequest(
        'What follow-ups am I carrying right now?',
      ),
    ).toMatchObject({
      capabilityId: 'rituals.followthrough',
    });
    expect(matchAssistantCapabilityRequest('Stop doing that')).toMatchObject({
      capabilityId: 'rituals.configure',
    });
  });

  it('matches Andrea Pulse requests cleanly', () => {
    expect(matchAssistantCapabilityRequest('Andrea Pulse')).toMatchObject({
      capabilityId: 'pulse.surprise_me',
    });
    expect(
      matchAssistantCapabilityRequest('tell me something interesting'),
    ).toMatchObject({
      capabilityId: 'pulse.interesting_thing',
    });
  });

  it('matches bounded image-generation requests without widening the capability graph', () => {
    expect(
      matchAssistantCapabilityRequest(
        'Generate an image of a cozy reading nook',
      ),
    ).toMatchObject({
      capabilityId: 'media.image_generate',
      canonicalText: 'a cozy reading nook',
    });
  });

  it('matches explicit pilot issue capture prompts without widening the router', () => {
    expect(matchAssistantCapabilityRequest('this felt weird')).toMatchObject({
      capabilityId: 'pilot.capture_issue',
    });
    expect(matchAssistantCapabilityRequest('that answer was off')).toMatchObject({
      capabilityId: 'pilot.capture_issue',
    });
    expect(
      matchAssistantCapabilityRequest('mark this flow as awkward'),
    ).toMatchObject({
      capabilityId: 'pilot.capture_issue',
    });
  });

  it('maps core Alexa intents into shared capabilities', () => {
    expect(resolveAlexaIntentToCapability('MyDayIntent')).toMatchObject({
      capabilityId: 'daily.morning_brief',
    });
    expect(resolveAlexaIntentToCapability('WhatNextIntent')).toMatchObject({
      capabilityId: 'daily.whats_next',
    });
    expect(
      resolveAlexaIntentToCapability('CandaceUpcomingIntent'),
    ).toMatchObject({
      capabilityId: 'household.candace_upcoming',
    });
  });

  it('continues the active capability for Alexa follow-ups when context is strong', () => {
    const state: AlexaConversationState = {
      flowKey: 'research_topic',
      subjectKind: 'general',
      subjectData: {
        activeCapabilityId: 'research.topic',
        lastAnswerSummary: 'meal delivery tradeoffs',
      },
      summaryText: 'meal delivery tradeoffs',
      supportedFollowups: [
        'anything_else',
        'shorter',
        'say_more',
        'memory_control',
      ],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState('anything else', state),
    ).toMatchObject({
      capabilityId: 'research.topic',
      continuation: true,
    });
  });

  it('continues the active mission context for blocker and execution follow-ups', () => {
    const state: AlexaConversationState = {
      flowKey: 'missions_propose',
      subjectKind: 'mission',
      subjectData: {
        activeCapabilityId: 'missions.propose',
        missionId: 'mission-1',
        missionSummary: 'Plan Friday dinner with Candace.',
      },
      summaryText: 'Plan Friday dinner with Candace.',
      supportedFollowups: ['anything_else', 'send_details', 'save_for_later'],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState("what's the blocker", state),
    ).toMatchObject({
      capabilityId: 'missions.explain',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromAlexaState('remind me', state),
    ).toMatchObject({
      capabilityId: 'missions.execute',
      continuation: true,
    });
  });

  it('continues the active mission context from shared assistant seed in direct chat', () => {
    const subjectData = {
      activeCapabilityId: 'missions.propose' as const,
      missionId: 'mission-1',
      missionSummary: 'Plan tonight.',
    };

    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        "what's the next step",
        subjectData,
      ),
    ).toMatchObject({
      capabilityId: 'missions.view',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        "what's blocking this",
        subjectData,
      ),
    ).toMatchObject({
      capabilityId: 'missions.explain',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'save that for later',
        subjectData,
      ),
    ).toBeNull();
  });

  it('keeps Pulse follow-ups on the active capability', () => {
    const state: AlexaConversationState = {
      flowKey: 'pulse_surprise_me',
      subjectKind: 'general',
      subjectData: {
        activeCapabilityId: 'pulse.surprise_me',
        lastAnswerSummary: 'A small odd one: octopuses have three hearts.',
      },
      summaryText: 'A small odd one: octopuses have three hearts.',
      supportedFollowups: ['anything_else', 'shorter', 'say_more'],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState('say more', state),
    ).toMatchObject({
      capabilityId: 'pulse.surprise_me',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromAlexaState(
        'be a little more direct',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'pulse.surprise_me',
      continuation: true,
    });
  });

  it('keeps research explainability follow-ups on the active capability', () => {
    const state: AlexaConversationState = {
      flowKey: 'research_compare',
      subjectKind: 'general',
      subjectData: {
        activeCapabilityId: 'research.compare',
        lastAnswerSummary: 'Meal delivery looks cheaper but less flexible.',
      },
      summaryText: 'Meal delivery looks cheaper but less flexible.',
      supportedFollowups: [
        'anything_else',
        'shorter',
        'say_more',
        'memory_control',
      ],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState(
        'why did you choose that route',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'research.compare',
      continuation: true,
    });
  });

  it('keeps chief-of-staff follow-ups on the active planning capability', () => {
    const state: AlexaConversationState = {
      flowKey: 'staff_prioritize',
      subjectKind: 'general',
      subjectData: {
        activeCapabilityId: 'staff.prioritize',
        lastAnswerSummary:
          'Dinner reply and one work pressure are the main things in view.',
      },
      summaryText:
        'Dinner reply and one work pressure are the main things in view.',
      supportedFollowups: ['anything_else', 'shorter', 'say_more'],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState(
        'why are you prioritizing that',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'staff.explain',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromAlexaState('be calmer', state),
    ).toMatchObject({
      capabilityId: 'staff.configure',
      continuation: true,
    });
  });

  it('keeps knowledge follow-ups on the active capability', () => {
    const state: AlexaConversationState = {
      flowKey: 'knowledge_summarize_saved',
      subjectKind: 'saved_item',
      subjectData: {
        activeCapabilityId: 'knowledge.summarize_saved',
        lastAnswerSummary:
          'Your saved material points to the Candace Friday dinner note.',
        knowledgeSourceIds: ['source-1'],
        knowledgeSourceTitles: ['Candace Dinner Notes'],
      },
      summaryText:
        'Your saved material points to the Candace Friday dinner note.',
      supportedFollowups: [
        'anything_else',
        'shorter',
        'say_more',
        'memory_control',
      ],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState('say more', state),
    ).toMatchObject({
      capabilityId: 'knowledge.summarize_saved',
      continuation: true,
    });
  });

  it('keeps communication follow-ups on the shared communication capability family', () => {
    const state: AlexaConversationState = {
      flowKey: 'communication_understand_message',
      subjectKind: 'communication_thread',
      subjectData: {
        activeCapabilityId: 'communication.understand_message',
        lastCommunicationSummary:
          'Candace still wants an answer about whether dinner works tonight.',
      },
      summaryText:
        'Candace still wants an answer about whether dinner works tonight.',
      supportedFollowups: ['anything_else', 'shorter', 'say_more'],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState(
        'what should I say back',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromAlexaState(
        'what conversations are still open',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
      continuation: true,
    });
  });

  it('leaves explicit handoff and completion follow-ups to the Alexa action layer', () => {
    const state: AlexaConversationState = {
      flowKey: 'daily_loose_ends',
      subjectKind: 'day_brief',
      subjectData: {
        activeCapabilityId: 'daily.loose_ends',
        lastAnswerSummary: 'Candace still needs a dinner answer.',
        companionContinuationJson: JSON.stringify({
          capabilityId: 'daily.loose_ends',
          voiceSummary: 'Candace still needs a dinner answer.',
          completionText:
            'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
        }),
      },
      summaryText: 'Candace still needs a dinner answer.',
      supportedFollowups: [
        'send_details',
        'save_to_library',
        'create_reminder',
        'save_for_later',
        'draft_follow_up',
      ],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState('send me the details', state),
    ).toBeNull();
    expect(
      continueAssistantCapabilityFromAlexaState(
        'save that in my library',
        state,
      ),
    ).toBeNull();
    expect(
      continueAssistantCapabilityFromAlexaState(
        'turn that into a reminder tonight',
        state,
      ),
    ).toBeNull();
    expect(
      continueAssistantCapabilityFromAlexaState('save that for later', state),
    ).toBeNull();
    expect(
      continueAssistantCapabilityFromAlexaState('draft that for me', state),
    ).toBeNull();
  });
});
