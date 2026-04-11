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
