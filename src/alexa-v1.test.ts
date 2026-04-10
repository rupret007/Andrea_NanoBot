import { describe, expect, it } from 'vitest';

import {
  ALEXA_DEFAULT_REPROMPT,
  ALEXA_ANYTHING_IMPORTANT_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_WHAT_AM_I_FORGETTING_INTENT,
  ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT,
  buildAlexaFallbackSpeech,
  buildAlexaHelpSpeech,
  buildAlexaOpenConversationPrompt,
  buildAlexaPersonalPrompt,
  buildAlexaWelcomeSpeech,
  buildDraftFollowUpQuestion,
  buildReminderConfirmationSpeech,
  buildReminderLeadTimeQuestion,
  buildSaveForLaterConfirmationSpeech,
  buildSaveForLaterQuestion,
  isAlexaPersonalIntent,
} from './alexa-v1.js';

describe('alexa v1 prompt mapping', () => {
  it('marks the bounded personal intents as supported', () => {
    expect(isAlexaPersonalIntent(ALEXA_MY_DAY_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent('AskAndreaIntent')).toBe(false);
  });

  it('builds focused personal prompts for Alexa v1 intents', () => {
    expect(buildAlexaPersonalPrompt(ALEXA_MY_DAY_INTENT)).toContain(
      'practical morning brief',
    );
    expect(
      buildAlexaPersonalPrompt(ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT),
    ).toContain('highest-priority thing');
    expect(
      buildAlexaPersonalPrompt(ALEXA_ANYTHING_IMPORTANT_INTENT),
    ).toContain('Anything I should know');
    expect(
      buildAlexaPersonalPrompt(ALEXA_WHAT_AM_I_FORGETTING_INTENT),
    ).toContain('What am I forgetting');
    expect(
      buildAlexaPersonalPrompt(ALEXA_EVENING_RESET_INTENT),
    ).toContain('evening reset');
    expect(
      buildAlexaPersonalPrompt(ALEXA_FAMILY_UPCOMING_INTENT),
    ).toContain('Candace or Travis');
    expect(
      buildAlexaPersonalPrompt(ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT, {
        leadTimeText: '30 minutes',
      }),
    ).toContain('30 minutes');
    expect(
      buildAlexaPersonalPrompt(ALEXA_SAVE_FOR_LATER_INTENT, {
        captureText: 'check the venue contract',
      }),
    ).toContain('check the venue contract');
    expect(
      buildAlexaPersonalPrompt(ALEXA_DRAFT_FOLLOW_UP_INTENT, {
        meetingReference: 'my design review',
      }),
    ).toContain('my design review');
    expect(buildAlexaPersonalPrompt(ALEXA_MY_DAY_INTENT)).toContain(
      'Lead with the main thing first',
    );
    expect(
      buildAlexaOpenConversationPrompt('help me figure out dinner with Candace'),
    ).toContain('Stay in the same Andrea Alexa conversation');
  });
});

describe('alexa v1 speech helpers', () => {
  it('keeps help and welcome copy short and voice-first', () => {
    expect(buildAlexaHelpSpeech('Andrea')).toContain('Ask about today, Candace');
    expect(buildAlexaHelpSpeech('Andrea')).toContain('Andrea Pulse');
    expect(buildAlexaHelpSpeech('Andrea')).toContain('Telegram');
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain(
      'This is Andrea.',
    );
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain('fuller version');
    expect(buildAlexaFallbackSpeech('Andrea')).toContain(
      'did not quite catch that',
    );
    expect(ALEXA_DEFAULT_REPROMPT).toContain(
      "what's still open with Candace",
    );
  });

  it('builds short clarification and confirmation questions', () => {
    expect(buildReminderLeadTimeQuestion('Andrea')).toContain(
      'How long before your next meeting',
    );
    expect(buildReminderConfirmationSpeech('Andrea', '30 minutes')).toContain(
      '30 minutes before your next meeting',
    );
    expect(buildSaveForLaterQuestion('Andrea')).toContain('save for later');
    expect(
      buildSaveForLaterConfirmationSpeech(
        'Andrea',
        'review the long community-skill notes before Friday afternoon',
      ),
    ).toContain('Want me to keep it');
    expect(buildDraftFollowUpQuestion()).toBe('Which meeting do you mean?');
  });
});
