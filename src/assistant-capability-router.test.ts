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
});
