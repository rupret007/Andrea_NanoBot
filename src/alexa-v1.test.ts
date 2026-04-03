import { describe, expect, it } from 'vitest';

import {
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  buildAlexaHelpSpeech,
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
      'Give me my day',
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
  });
});

describe('alexa v1 speech helpers', () => {
  it('keeps help and welcome copy short and voice-first', () => {
    expect(buildAlexaHelpSpeech('Andrea')).toContain('what is next');
    expect(buildAlexaWelcomeSpeech('Andrea')).toContain('Andrea is ready');
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
