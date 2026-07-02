import { describe, expect, it } from 'vitest';

import { ALL_SYNCED_MESSAGES_TARGET } from './thread-summary-routing.js';
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
      matchAssistantCapabilityRequest('What should I do next?'),
    ).toMatchObject({
      capabilityId: 'daily.whats_next',
    });
    expect(
      matchAssistantCapabilityRequest('What am I probably missing?'),
    ).toMatchObject({
      capabilityId: 'daily.loose_ends',
    });
    expect(
      matchAssistantCapabilityRequest('Is there anything new I should know?'),
    ).toMatchObject({
      capabilityId: 'daily.loose_ends',
    });
    expect(
      matchAssistantCapabilityRequest('What should I not forget before bed?'),
    ).toMatchObject({
      capabilityId: 'daily.evening_reset',
    });
    expect(
      matchAssistantCapabilityRequest('What should I do before bed?'),
    ).toMatchObject({
      capabilityId: 'daily.evening_reset',
    });
    expect(
      matchAssistantCapabilityRequest(
        'What should I not lose sight of tonight?',
      ),
    ).toMatchObject({
      capabilityId: 'daily.evening_reset',
    });
    expect(
      matchAssistantCapabilityRequest('What do I need from the store again?'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
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
    expect(
      matchAssistantCapabilityRequest('What life threads are open?'),
    ).toMatchObject({
      capabilityId: 'threads.list_open',
    });
    expect(
      matchAssistantCapabilityRequest('Help me get tonight under control'),
    ).toMatchObject({
      capabilityId: 'staff.plan_horizon',
    });
    expect(
      matchAssistantCapabilityRequest('Walk me through tonight'),
    ).toMatchObject({
      capabilityId: 'staff.plan_horizon',
    });
    expect(
      matchAssistantCapabilityRequest('What matters before my next meeting?'),
    ).toMatchObject({
      capabilityId: 'staff.prepare',
    });
    expect(
      matchAssistantCapabilityRequest('Prep me for my next meeting'),
    ).toMatchObject({
      capabilityId: 'staff.prepare',
    });
    expect(
      matchAssistantCapabilityRequest('Why is this suddenly a priority?'),
    ).toMatchObject({
      capabilityId: 'staff.explain',
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
    expect(
      matchAssistantCapabilityRequest("Which one's actually better for me?"),
    ).toMatchObject({
      capabilityId: 'research.recommend',
    });
    expect(
      matchAssistantCapabilityRequest("What's the next step?"),
    ).toMatchObject({
      capabilityId: 'daily.whats_next',
    });
    for (const prompt of [
      'What is the weather today in Dallas?',
      "What's the weather today in Dallas.",
      "What's the forecast for Dallas tomorrow?",
      'Will it rain in Dallas tonight?',
      "What's the temperature in Dallas right now?",
      "What's the weather in Austin this weekend?",
    ]) {
      expect(matchAssistantCapabilityRequest(prompt)).toMatchObject({
        capabilityId: 'research.topic',
      });
    }
    expect(
      matchAssistantCapabilityRequest("What's on my schedule for Saturday?"),
    ).toBeNull();
  });

  it('matches explicit knowledge-library prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest('Save this to my library'),
    ).toMatchObject({
      capabilityId: 'knowledge.save_source',
    });
    expect(matchAssistantCapabilityRequest('Capture this idea')).toMatchObject({
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
    expect(
      matchAssistantCapabilityRequest('Just use my saved stuff'),
    ).toMatchObject({
      capabilityId: 'knowledge.list_sources',
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
      matchAssistantCapabilityRequest('What should I send back to Candace?'),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
    });
    expect(
      matchAssistantCapabilityRequest('Make that less stiff'),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
    });
    expect(matchAssistantCapabilityRequest('More blunt')).toMatchObject({
      capabilityId: 'communication.draft_reply',
    });
    expect(
      matchAssistantCapabilityRequest('What do I owe people right now?'),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
    });
    expect(
      matchAssistantCapabilityRequest('What texts need me?'),
    ).toMatchObject({
      capabilityId: 'communication.review_recent_texts',
    });
    expect(
      matchAssistantCapabilityRequest('What texts need me right now?'),
    ).toMatchObject({
      capabilityId: 'communication.review_recent_texts',
    });
    expect(
      matchAssistantCapabilityRequest('Review my texts today'),
    ).toMatchObject({
      capabilityId: 'communication.review_recent_texts',
      arguments: expect.objectContaining({
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      }),
    });
    expect(
      matchAssistantCapabilityRequest('review my recent text messages'),
    ).toMatchObject({
      capabilityId: 'communication.review_recent_texts',
      canonicalText: 'review recent text messages from the last 24 hours',
    });
    expect(
      matchAssistantCapabilityRequest('what should I reply to in my texts'),
    ).toMatchObject({
      capabilityId: 'communication.review_recent_texts',
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
      matchAssistantCapabilityRequest('@Andrea what should I send back?'),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
    });
    expect(
      matchAssistantCapabilityRequest('@Andrea summarize this'),
    ).toMatchObject({
      capabilityId: 'communication.understand_message',
    });
    expect(
      matchAssistantCapabilityRequest(
        'Can you summerize my text messages in the Pops of Punk text thread please. Last 2 days.',
      ),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      arguments: expect.objectContaining({
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'last_days',
        timeWindowValue: 2,
      }),
    });
    expect(
      matchAssistantCapabilityRequest(
        'Summarize my text messages in Pops of Punk from yesterday',
      ),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      arguments: expect.objectContaining({
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'yesterday',
      }),
    });
    expect(
      matchAssistantCapabilityRequest(
        'Summarize the texts today from the Pops of Punk text thread please',
      ),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      arguments: expect.objectContaining({
        targetChatName: 'Pops of Punk',
        timeWindowKind: 'today',
      }),
    });
    expect(
      matchAssistantCapabilityRequest('Summarize my text messages for today'),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      canonicalText: 'Summarize my text messages for today',
    });
    expect(
      matchAssistantCapabilityRequest('What are my recent text messages?'),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      canonicalText: 'What are my recent text messages',
    });
    expect(
      matchAssistantCapabilityRequest('yeah all text messages for today'),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      arguments: expect.objectContaining({
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      }),
    });
    expect(
      matchAssistantCapabilityRequest('what are my text messages for today?'),
    ).toMatchObject({
      capabilityId: 'communication.summarize_thread',
      canonicalText: 'summarize all synced text messages from today',
      arguments: expect.objectContaining({
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      }),
    });
    expect(
      matchAssistantCapabilityRequest('Summarize the latest news today'),
    ).toMatchObject({
      capabilityId: 'research.summarize',
    });
  });

  it('matches memory activation and setup lifecycle prompts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest('Finish my Andrea setup'),
    ).toMatchObject({
      capabilityId: 'capture.profile_setup',
    });
    expect(
      matchAssistantCapabilityRequest('Show my setup completeness'),
    ).toMatchObject({
      capabilityId: 'memory.explain',
    });
    expect(
      matchAssistantCapabilityRequest('Export my profile pack'),
    ).toMatchObject({
      capabilityId: 'memory.explain',
    });
    expect(
      matchAssistantCapabilityRequest('Why do you know that?'),
    ).toMatchObject({
      capabilityId: 'memory.explain',
    });
    expect(
      matchAssistantCapabilityRequest('What did you learn about me?'),
    ).toMatchObject({
      capabilityId: 'memory.explain',
    });
    expect(matchAssistantCapabilityRequest('Accept learning #1')).toMatchObject(
      {
        capabilityId: 'memory.remember',
      },
    );
    expect(matchAssistantCapabilityRequest('Reject learning #1')).toMatchObject(
      {
        capabilityId: 'memory.forget',
      },
    );
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

  it('matches reminder overview readouts cleanly', () => {
    expect(
      matchAssistantCapabilityRequest('What reminders do I have?'),
    ).toMatchObject({
      capabilityId: 'followthrough.reminder_overview',
      canonicalText: 'what reminders do I have',
    });
    expect(
      matchAssistantCapabilityRequest('What reminders do I have tomorrow?'),
    ).toMatchObject({
      capabilityId: 'followthrough.reminder_overview',
      canonicalText: 'what reminders do I have tomorrow',
    });
    expect(
      matchAssistantCapabilityRequest('What should I remember tomorrow?'),
    ).toMatchObject({
      capabilityId: 'followthrough.reminder_overview',
      canonicalText: 'what reminders do I have tomorrow',
    });
    expect(
      matchAssistantCapabilityRequest('What do I need to remember this week?'),
    ).toMatchObject({
      capabilityId: 'followthrough.reminder_overview',
      canonicalText: 'what reminders do I have this week',
    });
    expect(
      matchAssistantCapabilityRequest('What should I remember tonight?'),
    ).toMatchObject({
      capabilityId: 'daily.evening_reset',
    });
  });

  it('routes personalized setup and everyday capture prompts before broader planning logic', () => {
    expect(
      matchAssistantCapabilityRequest('Help me set this up'),
    ).toMatchObject({
      capabilityId: 'capture.profile_setup',
    });
    expect(
      matchAssistantCapabilityRequest('Show me my current setup'),
    ).toMatchObject({
      capabilityId: 'capture.profile_review',
    });
    expect(
      matchAssistantCapabilityRequest('Add milk to my shopping list'),
    ).toMatchObject({
      capabilityId: 'capture.add_item',
    });
    expect(
      matchAssistantCapabilityRequest('Add milk to my grocery list'),
    ).toMatchObject({
      capabilityId: 'capture.add_item',
    });
    expect(
      matchAssistantCapabilityRequest('What bills do I need to pay this week?'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest('What meals have I planned this week?'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest("what's on groceries"),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest("what's left for tonight"),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest('What do we need from the store?'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest("What's still on my errands list?"),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest('Show me my grocery list'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest("What's on my grocery list?"),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest("What's missing for dinner?"),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest('What should I handle this weekend?'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest('What meal ideas do I have this week?'),
    ).toMatchObject({
      capabilityId: 'capture.read_items',
    });
    expect(
      matchAssistantCapabilityRequest('repeat that every Friday'),
    ).toMatchObject({
      capabilityId: 'capture.update_item',
    });
    expect(
      matchAssistantCapabilityRequest('make this part of my weekend list'),
    ).toMatchObject({
      capabilityId: 'capture.update_item',
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
    expect(
      matchAssistantCapabilityRequest('that answer was off'),
    ).toMatchObject({
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

  it('continues everyday capture from prior subject data for updates, conversions, and setup approval', () => {
    expect(
      continueAssistantCapabilityFromPriorSubjectData('mark that done', {
        activeCapabilityId: 'capture.read_items',
      }),
    ).toMatchObject({
      capabilityId: 'capture.update_item',
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'save that under the household thread',
        {
          activeCapabilityId: 'capture.read_items',
        },
      ),
    ).toMatchObject({
      capabilityId: 'capture.convert_item',
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'turn that into a reminder',
        {
          activeCapabilityId: 'capture.add_item',
        },
      ),
    ).toMatchObject({
      capabilityId: 'capture.convert_item',
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData('approve that', {
        activeCapabilityId: 'capture.profile_setup',
      }),
    ).toMatchObject({
      capabilityId: 'capture.profile_setup',
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'add milk eggs and maybe trash bags',
        {
          activeCapabilityId: 'capture.read_items',
          activeTaskKind: 'list_read',
          activeListGroupId: 'group-groceries',
        },
      ),
    ).toMatchObject({
      capabilityId: 'capture.add_item',
      continuation: true,
    });
  });

  it('maps broad Alexa intent families into shared capabilities when carrier phrases are strong', () => {
    expect(
      resolveAlexaIntentToCapability('CompanionGuidanceIntent', {
        slotValue: 'am i forgetting',
      }),
    ).toMatchObject({
      capabilityId: 'daily.loose_ends',
    });
    expect(
      resolveAlexaIntentToCapability('PeopleHouseholdIntent', {
        slotValue: 'Candace',
      }),
    ).toMatchObject({
      capabilityId: 'household.candace_upcoming',
    });
    expect(
      resolveAlexaIntentToCapability('PlanningOrientationIntent', {
        slotValue: 'tonight',
      }),
    ).toMatchObject({
      capabilityId: 'missions.propose',
    });
    expect(
      resolveAlexaIntentToCapability('OpenAskIntent', {
        slotValue: 'Jar Jar Binks',
      }),
    ).toMatchObject({
      capabilityId: 'research.topic',
    });
  });

  it('leaves broad Alexa local voice asks for the Alexa dialogue layer', () => {
    expect(
      resolveAlexaIntentToCapability('CompanionGuidanceIntent', {
        slotValue: 'up',
      }),
    ).toBeNull();
    expect(
      resolveAlexaIntentToCapability('CompanionGuidanceIntent', {
        slotValue: 'time is it',
      }),
    ).toBeNull();
    expect(
      resolveAlexaIntentToCapability('CompanionGuidanceIntent', {
        slotValue: 'what can you do',
      }),
    ).toBeNull();
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
    expect(
      continueAssistantCapabilityFromAlexaState('handle this', state),
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

  it('routes proposed follow-through review prompts and selected follow-ups', () => {
    expect(
      matchAssistantCapabilityRequest('show proposed reminders'),
    ).toMatchObject({
      capabilityId: 'rituals.followthrough',
    });
    expect(
      matchAssistantCapabilityRequest('what follow-through should I approve'),
    ).toMatchObject({
      capabilityId: 'rituals.followthrough',
    });

    expect(
      continueAssistantCapabilityFromPriorSubjectData('approve #1', {
        activeCapabilityId: 'rituals.followthrough',
        followthroughReviewJson: JSON.stringify({
          kind: 'followthrough_review',
          items: [],
        }),
      }),
    ).toMatchObject({
      capabilityId: 'rituals.followthrough',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'remind me about #2 tonight',
        {
          activeCapabilityId: 'rituals.followthrough',
        },
      ),
    ).toMatchObject({
      capabilityId: 'rituals.followthrough',
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
    expect(
      continueAssistantCapabilityFromAlexaState(
        'why is this suddenly a priority',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'staff.explain',
      continuation: true,
    });
    expect(
      continueAssistantCapabilityFromAlexaState(
        'what matters before my next meeting',
        state,
      ),
    ).toMatchObject({
      capabilityId: 'staff.prepare',
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
    expect(
      continueAssistantCapabilityFromAlexaState('what texts need me', state),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
      continuation: true,
    });
  });

  it('does not let an active communication context swallow a fresh explicit person-and-topic draft ask', () => {
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'What should I say back to Candace about dinner tonight?',
        {
          activeCapabilityId: 'communication.open_loops',
        },
      ),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
      reason: 'matched relationship-aware draft phrasing',
    });

    expect(
      matchAssistantCapabilityRequest(
        'What should I say back to Candace about dinner tonight?',
      ),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
      reason: 'matched relationship-aware draft phrasing',
    });
  });

  it('binds selected item follow-ups to the recent text review context', () => {
    const subjectData = {
      activeCapabilityId: 'communication.review_recent_texts' as const,
      recentTextReviewJson: JSON.stringify({
        version: 1,
        items: [
          {
            itemId: 'review-1',
            rank: 1,
            section: 'needs_reply',
            chatJid: 'bb:iMessage;-;+14695550123',
            chatLabel: 'Candace',
            summaryText: 'Candace asked whether dinner still works tonight.',
          },
          {
            itemId: 'review-2',
            rank: 2,
            section: 'needs_reply',
            chatJid: 'bb:iMessage;-;+14695550124',
            chatLabel: 'Alex',
            summaryText: 'Alex asked for the set list.',
          },
          {
            itemId: 'review-3',
            rank: 3,
            section: 'worth_watching',
            chatJid: 'bb:iMessage;-;+14695550125',
            chatLabel: 'Morgan',
            summaryText: 'Morgan mentioned a loose follow-up.',
          },
        ],
      }),
    };

    for (const prompt of [
      'draft #1',
      'make #2 warmer',
      'remind me about #3 tonight',
      'save #2',
      'skip #1',
      'mark #1 handled',
      'why #1',
      'draft it',
      'make that warmer',
      'remind me about that tonight',
      'save that',
      'skip it',
      'mark handled',
      'why that',
    ]) {
      expect(
        continueAssistantCapabilityFromPriorSubjectData(prompt, subjectData),
      ).toMatchObject({
        capabilityId: 'communication.draft_reply',
        continuation: true,
      });
    }

    expect(
      continueAssistantCapabilityFromPriorSubjectData('save #2', {
        activeCapabilityId: 'communication.draft_reply',
        recentTextReviewJson: subjectData.recentTextReviewJson,
      }),
    ).toMatchObject({
      capabilityId: 'communication.draft_reply',
      continuation: true,
    });
  });

  it('binds pronoun follow-ups to the active follow-through review context', () => {
    const subjectData = {
      activeCapabilityId: 'daily.command_center' as const,
      followthroughReviewJson: JSON.stringify({
        kind: 'followthrough_review',
        generatedAt: '2026-06-29T18:00:00.000Z',
        groupFolder: 'main',
        items: [
          {
            itemId: 'followthrough:1',
            rank: 1,
            section: 'routine_related',
            title: 'Morning check-in',
            whyItMatters: 'Setup says this rhythm matters.',
            source: 'guided setup routine',
            safeNextAction: 'Approve with timing.',
            riskFlags: ['proposed_only', 'approval_required'],
            relatedNodeIds: [],
            priorityScore: 0.5,
            decisionScore: 0.6,
            approvalReadiness: 'ready',
            suggestedTiming: 'tomorrow morning',
            decisionRationale: ['safe local reminder candidate'],
            snapshotHash: 'snapshot',
          },
        ],
      }),
    };

    for (const prompt of [
      'why this one',
      'defer it',
      'dismiss it',
      'mark handled',
    ]) {
      expect(
        continueAssistantCapabilityFromPriorSubjectData(prompt, subjectData),
      ).toMatchObject({
        capabilityId: 'rituals.followthrough',
        continuation: true,
      });
    }
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
