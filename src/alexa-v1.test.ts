import { describe, expect, it } from 'vitest';

import {
  ALEXA_DEFAULT_REPROMPT,
  ALEXA_ANYTHING_IMPORTANT_INTENT,
  ALEXA_CALENDAR_CANCEL_INTENT,
  ALEXA_CALENDAR_CREATE_INTENT,
  ALEXA_CALENDAR_MOVE_INTENT,
  ALEXA_COMPANION_GUIDANCE_INTENT,
  ALEXA_CONVERSATION_CONTROL_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_OPEN_ASK_INTENT,
  ALEXA_PEOPLE_HOUSEHOLD_INTENT,
  ALEXA_PLANNING_ORIENTATION_INTENT,
  ALEXA_REMINDER_CREATE_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_SAVE_REMIND_HANDOFF_INTENT,
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
    expect(isAlexaPersonalIntent(ALEXA_COMPANION_GUIDANCE_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent(ALEXA_OPEN_ASK_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent(ALEXA_CALENDAR_CREATE_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent(ALEXA_CALENDAR_MOVE_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent(ALEXA_CALENDAR_CANCEL_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent(ALEXA_REMINDER_CREATE_INTENT)).toBe(true);
    expect(isAlexaPersonalIntent('AskAndreaIntent')).toBe(false);
  });

  it('builds focused personal prompts for Alexa v1 intents', () => {
    expect(
      buildAlexaPersonalPrompt(ALEXA_COMPANION_GUIDANCE_INTENT, {
        captureText: 'what am I forgetting',
      }),
    ).toContain('practical daily assistant jobs');
    expect(
      buildAlexaPersonalPrompt(ALEXA_PEOPLE_HOUSEHOLD_INTENT, {
        captureText: 'Candace',
      }),
    ).toContain('people, household follow-through');
    expect(
      buildAlexaPersonalPrompt(ALEXA_PLANNING_ORIENTATION_INTENT, {
        captureText: 'tonight',
      }),
    ).toContain('plan or blocker');
    expect(
      buildAlexaPersonalPrompt(ALEXA_SAVE_REMIND_HANDOFF_INTENT, {
        captureText: 'the fuller version',
      }),
    ).toContain('add, move, remind, save, or hand off');
    expect(
      buildAlexaPersonalPrompt(ALEXA_OPEN_ASK_INTENT, {
        captureText: 'Jar Jar Binks',
      }),
    ).toContain('practical question naturally and briefly');
    expect(
      buildAlexaPersonalPrompt(ALEXA_CONVERSATION_CONTROL_INTENT, {
        captureText: 'a little more direct',
      }),
    ).toContain('conversation-control request naturally');
    expect(
      buildAlexaPersonalPrompt(ALEXA_CALENDAR_CREATE_INTENT, {
        captureText: 'lunch with Sam tomorrow afternoon',
      }),
    ).toContain('Add this calendar event cleanly');
    expect(
      buildAlexaPersonalPrompt(ALEXA_CALENDAR_MOVE_INTENT, {
        captureText: 'move lunch to 3 PM',
      }),
    ).toContain('Move or reschedule this calendar event');
    expect(
      buildAlexaPersonalPrompt(ALEXA_CALENDAR_CANCEL_INTENT, {
        captureText: 'cancel lunch tomorrow',
      }),
    ).toContain('Cancel this calendar event safely');
    expect(
      buildAlexaPersonalPrompt(ALEXA_REMINDER_CREATE_INTENT, {
        captureText: 'take my pills at 9',
      }),
    ).toContain('Save this reminder cleanly');
    expect(buildAlexaPersonalPrompt(ALEXA_MY_DAY_INTENT)).toContain(
      'practical morning brief',
    );
    expect(
      buildAlexaPersonalPrompt(ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT),
    ).toContain('highest-priority thing');
    expect(buildAlexaPersonalPrompt(ALEXA_ANYTHING_IMPORTANT_INTENT)).toContain(
      'Anything I should know',
    );
    expect(
      buildAlexaPersonalPrompt(ALEXA_WHAT_AM_I_FORGETTING_INTENT),
    ).toContain('What am I forgetting');
    expect(buildAlexaPersonalPrompt(ALEXA_EVENING_RESET_INTENT)).toContain(
      'evening reset',
    );
    expect(buildAlexaPersonalPrompt(ALEXA_FAMILY_UPCOMING_INTENT)).toContain(
      'Candace or Travis',
    );
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
      buildAlexaOpenConversationPrompt(
        'help me figure out dinner with Candace',
      ),
    ).toContain('Stay in the same Andrea Alexa conversation');
  });
});

describe('alexa v1 speech helpers', () => {
  it('keeps help and welcome copy short and voice-first', () => {
    expect(buildAlexaHelpSpeech('Andrea')).toContain('your schedule');
    expect(buildAlexaHelpSpeech('Andrea')).toContain(
      'remind me to take my pills at 9',
    );
    expect(buildAlexaHelpSpeech('Andrea')).toContain('what should I say back');
    expect(buildAlexaHelpSpeech('Andrea')).toContain('Telegram');
    expect(buildAlexaHelpSpeech('Andrea')).not.toContain('Andrea Pulse');
    expect(buildAlexaHelpSpeech('Andrea')).not.toContain('Candace');
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain('This is Andrea.');
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain('schedule');
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain(
      'remind me to take my pills at 9',
    );
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain(
      'what should I say back',
    );
    expect(buildAlexaWelcomeSpeech('Andrea')).not.toContain('Candace');
    expect(buildAlexaFallbackSpeech('Andrea')).toContain("didn't catch that");
    expect(buildAlexaFallbackSpeech('Andrea')).toContain('your schedule');
    expect(buildAlexaFallbackSpeech('Andrea')).toContain('one reminder');
    expect(buildAlexaFallbackSpeech('Andrea')).toContain(
      'what should I say back',
    );
    expect(ALEXA_DEFAULT_REPROMPT).toContain('remind me to take my pills at 9');
    expect(ALEXA_DEFAULT_REPROMPT).toContain("what's on my calendar tomorrow");
    expect(ALEXA_DEFAULT_REPROMPT).toContain('what should I say back');
    expect(ALEXA_DEFAULT_REPROMPT).not.toContain('Candace');
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
