import { describe, expect, it } from 'vitest';

import {
  extractAlexaVoiceIntentCapture,
  pickAlexaConversationFollowupCandidate,
  planAlexaDialogueTurn,
  resolveAlexaVoiceIntentFamily,
} from './alexa-dialogue.js';
import type { AlexaConversationState } from './alexa-conversation.js';

describe('alexa dialogue', () => {
  it('maps the broad Alexa intents into stable voice families', () => {
    expect(resolveAlexaVoiceIntentFamily('CompanionGuidanceIntent')).toBe(
      'companion_guidance',
    );
    expect(resolveAlexaVoiceIntentFamily('PeopleHouseholdIntent')).toBe(
      'people_household',
    );
    expect(resolveAlexaVoiceIntentFamily('PlanningOrientationIntent')).toBe(
      'planning_orientation',
    );
    expect(resolveAlexaVoiceIntentFamily('SaveRemindHandoffIntent')).toBe(
      'save_remind_handoff',
    );
    expect(resolveAlexaVoiceIntentFamily('CalendarCreateIntent')).toBe(
      'save_remind_handoff',
    );
    expect(resolveAlexaVoiceIntentFamily('CalendarMoveIntent')).toBe(
      'save_remind_handoff',
    );
    expect(resolveAlexaVoiceIntentFamily('CalendarCancelIntent')).toBe(
      'save_remind_handoff',
    );
    expect(resolveAlexaVoiceIntentFamily('ReminderCreateIntent')).toBe(
      'save_remind_handoff',
    );
    expect(resolveAlexaVoiceIntentFamily('OpenAskIntent')).toBe('open_ask');
    expect(resolveAlexaVoiceIntentFamily('ConversationControlIntent')).toBe(
      'conversation_control',
    );
  });

  it('captures broad-family slot phrasing into useful candidate utterances', () => {
    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'am i forgetting',
      }),
    ).toMatchObject({
      preferredText: 'what am I forgetting',
      candidateTexts: ['what am I forgetting'],
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'time is it',
      }),
    ).toMatchObject({
      preferredText: 'what time is it',
      candidateTexts: ['what time is it'],
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'up',
      }),
    ).toMatchObject({
      preferredText: "what's up",
      candidateTexts: ["what's up"],
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'what can you do',
      }),
    ).toMatchObject({
      preferredText: 'what can you do',
      candidateTexts: ['what can you do', 'help me'],
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'next on my calendar',
      }),
    ).toMatchObject({
      preferredText: "what's next on my calendar",
      candidateTexts: ["what's next on my calendar", "what's coming up"],
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'first meeting tomorrow',
      }),
    ).toMatchObject({
      preferredText: 'when is my first meeting tomorrow',
      candidateTexts: [
        'when is my first meeting tomorrow',
        'what is on my calendar tomorrow',
      ],
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'do i owe people',
      }),
    ).toMatchObject({
      preferredText: 'what do I owe people',
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'bills this week',
      }),
    ).toMatchObject({
      preferredText: 'what bills do I need to pay this week',
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'meal plan',
      }),
    ).toMatchObject({
      preferredText: 'help me plan meals this week',
    });

    expect(
      extractAlexaVoiceIntentCapture('CompanionGuidanceIntent', {
        guidanceText: 'take my pills at 9',
      }),
    ).toMatchObject({
      preferredText: 'remind me to take my pills at 9',
    });

    expect(
      extractAlexaVoiceIntentCapture('PeopleHouseholdIntent', {
        subject: 'Candace',
      }),
    ).toMatchObject({
      preferredText: 'what about Candace',
      candidateTexts: expect.arrayContaining([
        'what about Candace',
        "what's still open with Candace",
      ]),
    });

    expect(
      extractAlexaVoiceIntentCapture('PlanningOrientationIntent', {
        topic: 'tonight',
      }),
    ).toMatchObject({
      preferredText: 'help me plan tonight',
      candidateTexts: expect.arrayContaining([
        'help me plan tonight',
        'help me figure out tonight',
        'figure out tonight',
        "what's the next step for tonight",
      ]),
    });

    expect(
      extractAlexaVoiceIntentCapture('SaveRemindHandoffIntent', {
        item: 'the fuller version',
      }),
    ).toMatchObject({
      preferredText: 'save the fuller version',
      candidateTexts: expect.arrayContaining([
        'save the fuller version',
        'send the fuller version to Telegram',
      ]),
    });

    expect(
      extractAlexaVoiceIntentCapture('SaveRemindHandoffIntent', {
        item: 'that',
      }),
    ).toMatchObject({
      preferredText: 'save that',
      candidateTexts: ['save that', 'send me the full version', 'draft that'],
    });

    expect(
      extractAlexaVoiceIntentCapture('CalendarCreateIntent', {
        eventTitle: 'lunch with Sam',
        targetDate: 'tomorrow',
        targetTime: 'afternoon',
        calendarReference: 'main calendar',
      }),
    ).toMatchObject({
      preferredText: 'schedule lunch with Sam tomorrow afternoon on main calendar',
      candidateTexts: expect.arrayContaining([
        'schedule lunch with Sam tomorrow afternoon on main calendar',
        'add lunch with Sam tomorrow afternoon on main calendar',
      ]),
    });

    expect(
      extractAlexaVoiceIntentCapture('CalendarMoveIntent', {
        eventReference: 'lunch with Sam',
        targetTime: '3 PM',
      }),
    ).toMatchObject({
      preferredText: 'move lunch with Sam to 3 PM',
    });

    expect(
      extractAlexaVoiceIntentCapture('CalendarCancelIntent', {
        eventReference: 'lunch with Sam',
        targetDate: 'tomorrow',
      }),
    ).toMatchObject({
      preferredText: 'cancel lunch with Sam tomorrow',
    });

    expect(
      extractAlexaVoiceIntentCapture('ReminderCreateIntent', {
        reminderBody: 'take my pills',
        reminderTime: '9 PM',
      }),
    ).toMatchObject({
      preferredText: 'remind me to take my pills at 9 PM',
    });

    expect(
      extractAlexaVoiceIntentCapture('OpenAskIntent', {
        query: 'meal delivery and grocery pickup',
      }),
    ).toMatchObject({
      preferredText: 'compare meal delivery and grocery pickup',
    });

    expect(
      extractAlexaVoiceIntentCapture('ConversationControlIntent', {
        controlText: 'a little more direct',
      }),
    ).toMatchObject({
      preferredText: 'be a little more direct',
      candidateTexts: ['be a little more direct'],
    });

    expect(
      extractAlexaVoiceIntentCapture('ConversationControlIntent', {
        controlText: 'what about that',
      }),
    ).toMatchObject({
      preferredText: 'what about that',
      candidateTexts: expect.arrayContaining([
        'what about that',
        'remember that',
        'save that',
      ]),
    });
  });

  it('uses the active Alexa frame to recover conversational follow-ups', () => {
    const state: AlexaConversationState = {
      flowKey: 'candace_followthrough',
      subjectKind: 'person',
      subjectData: {
        personName: 'Candace',
        activeSubjectLabel: 'Candace',
      },
      summaryText: 'Candace still needs a dinner answer tonight.',
      supportedFollowups: [
        'anything_else',
        'say_more',
        'shorter',
        'memory_control',
        'switch_person',
        'action_guidance',
        'risk_check',
        'save_that',
        'save_for_later',
        'send_details',
        'create_reminder',
      ],
      styleHints: {
        channelMode: 'alexa_companion',
        responseSource: 'local_companion',
      },
    };

    expect(
      pickAlexaConversationFollowupCandidate(
        ['anything else', 'say more'],
        state,
      ),
    ).toMatchObject({
      action: 'anything_else',
      text: 'anything else',
    });

    expect(
      planAlexaDialogueTurn('be a little more direct', state),
    ).toMatchObject({
      route: 'handoff',
      followupAction: 'memory_control',
    });

    expect(
      planAlexaDialogueTurn('what about that', state),
    ).toMatchObject({
      route: 'handoff',
      followupAction: 'switch_person',
    });

    expect(planAlexaDialogueTurn('save that', state)).toMatchObject({
      route: 'handoff',
      followupAction: 'save_that',
    });
  });

  it('keeps simple local questions out of unsupported-command failure paths', () => {
    expect(planAlexaDialogueTurn('what time is it')).toMatchObject({
      route: 'local',
      localKind: 'time',
    });
    expect(planAlexaDialogueTurn('what day is it')).toMatchObject({
      route: 'local',
      localKind: 'day',
    });
    expect(planAlexaDialogueTurn("what's up")).toMatchObject({
      route: 'local',
      localKind: 'whats_up',
    });
    expect(planAlexaDialogueTurn('can you help me')).toMatchObject({
      route: 'local',
      localKind: 'help',
    });
    expect(planAlexaDialogueTurn('what can you do')).toMatchObject({
      route: 'local',
      localKind: 'help',
    });
  });

  it('clarifies underspecified asks instead of failing hard', () => {
    expect(planAlexaDialogueTurn('what should I know')).toMatchObject({
      route: 'clarify',
      blockerClass: 'weak_clarifier_recovery',
    });
    expect(planAlexaDialogueTurn('what about that')).toMatchObject({
      route: 'clarify',
      blockerClass: 'no_context_reference',
    });
    expect(planAlexaDialogueTurn('')).toMatchObject({
      route: 'clarify',
      blockerClass: 'carrier_phrase_missing',
    });
  });

  it('routes open asks into the shared capability graph when possible', () => {
    expect(planAlexaDialogueTurn('what am I forgetting')).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'daily.loose_ends',
    });
    expect(
      planAlexaDialogueTurn('compare meal delivery and grocery pickup'),
    ).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'research.compare',
    });
    expect(planAlexaDialogueTurn('what should I say back')).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'communication.draft_reply',
    });
    expect(planAlexaDialogueTurn('what do I owe people')).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'communication.open_loops',
    });
    expect(planAlexaDialogueTurn("what's still open")).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'daily.loose_ends',
    });
    expect(
      planAlexaDialogueTurn('what bills do I need to pay this week'),
    ).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'capture.read_items',
    });
    expect(planAlexaDialogueTurn('figure out tonight')).toMatchObject({
      route: 'shared_capability',
      capabilityId: 'missions.propose',
    });
    expect(planAlexaDialogueTurn('check runtime job status')).toMatchObject({
      route: 'blocked',
      blockerClass: 'operator_handoff_required',
    });
  });

  it('falls back to the assistant bridge for broader asks that are real but not yet capability-backed', () => {
    expect(
      planAlexaDialogueTurn('help me think through the school fundraiser note'),
    ).toMatchObject({
      route: 'assistant_bridge',
      blockerClass: 'fallback_unmatched_open_utterance',
    });
  });
});
