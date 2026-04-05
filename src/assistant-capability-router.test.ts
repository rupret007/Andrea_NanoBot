import { describe, expect, it } from 'vitest';

import {
  continueAssistantCapabilityFromAlexaState,
  matchAssistantCapabilityRequest,
  resolveAlexaIntentToCapability,
} from './assistant-capability-router.js';
import type { AlexaConversationState } from './alexa-conversation.js';

describe('assistant capability router', () => {
  it('matches shared daily and household requests', () => {
    expect(matchAssistantCapabilityRequest('What am I forgetting?')).toMatchObject({
      capabilityId: 'daily.loose_ends',
    });
    expect(
      matchAssistantCapabilityRequest("What's still open with Candace?"),
    ).toMatchObject({
      capabilityId: 'household.candace_upcoming',
    });
    expect(matchAssistantCapabilityRequest('What threads do I have open?')).toMatchObject(
      {
        capabilityId: 'threads.list_open',
      },
    );
  });

  it('matches bounded research prompts without inventing new intents', () => {
    expect(
      matchAssistantCapabilityRequest('Compare meal delivery options for this week'),
    ).toMatchObject({
      capabilityId: 'research.compare',
    });
    expect(
      matchAssistantCapabilityRequest('What is the best choice about weekend plans'),
    ).toMatchObject({
      capabilityId: 'research.recommend',
    });
    expect(
      matchAssistantCapabilityRequest('What should I know before deciding on meal delivery?'),
    ).toMatchObject({
      capabilityId: 'research.recommend',
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
      matchAssistantCapabilityRequest('Generate an image of a cozy reading nook'),
    ).toMatchObject({
      capabilityId: 'media.image_generate',
      canonicalText: 'a cozy reading nook',
    });
  });

  it('maps core Alexa intents into shared capabilities', () => {
    expect(resolveAlexaIntentToCapability('MyDayIntent')).toMatchObject({
      capabilityId: 'daily.morning_brief',
    });
    expect(resolveAlexaIntentToCapability('WhatNextIntent')).toMatchObject({
      capabilityId: 'daily.whats_next',
    });
    expect(resolveAlexaIntentToCapability('CandaceUpcomingIntent')).toMatchObject({
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
      supportedFollowups: ['anything_else', 'shorter', 'say_more', 'memory_control'],
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
      continueAssistantCapabilityFromAlexaState('be a little more direct', state),
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
      supportedFollowups: ['anything_else', 'shorter', 'say_more', 'memory_control'],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      continueAssistantCapabilityFromAlexaState('why did you choose that route', state),
    ).toMatchObject({
      capabilityId: 'research.compare',
      continuation: true,
    });
  });
});
