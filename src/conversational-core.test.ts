import { describe, expect, it } from 'vitest';

import {
  buildCalendarCompanionEventReply,
  buildCalendarCompanionFailureReply,
  buildCalendarCompanionReminderReply,
  buildGracefulDegradedReply,
  classifyConversationalTurn,
  isResearchEligibleConversationalPrompt,
} from './conversational-core.js';

describe('conversational core classifier', () => {
  it('classifies ordinary greetings and vibe checks locally', () => {
    expect(classifyConversationalTurn("Hey, what's up?")).toBe(
      'greeting_or_vibe_check',
    );
    expect(classifyConversationalTurn("@Andrea what's up?")).toBe(
      'greeting_or_vibe_check',
    );
    expect(classifyConversationalTurn("How's it going?")).toBe(
      'greeting_or_vibe_check',
    );
    expect(classifyConversationalTurn('Can you help me?')).toBe(
      'greeting_or_vibe_check',
    );
  });

  it('classifies lightweight companion prompts separately', () => {
    expect(classifyConversationalTurn('What should I do next?')).toBe(
      'lightweight_companion',
    );
    expect(classifyConversationalTurn('What am I forgetting?')).toBe(
      'lightweight_companion',
    );
    expect(classifyConversationalTurn('What am I probably missing?')).toBe(
      'lightweight_companion',
    );
    expect(
      classifyConversationalTurn('What should I not forget before bed?'),
    ).toBe('lightweight_companion');
  });

  it('classifies personal guidance separately from general knowledge', () => {
    expect(classifyConversationalTurn("What's still open with Candace?")).toBe(
      'personal_guidance',
    );
  });

  it('classifies simple factoids and source-grounded prompts distinctly', () => {
    expect(classifyConversationalTurn("What is Jar Jar Binks' species?")).toBe(
      'simple_factoid',
    );
    expect(classifyConversationalTurn("What's the news today?")).toBe(
      'source_grounded_question',
    );
    expect(
      classifyConversationalTurn('What should I know about Jar Jar Binks?'),
    ).toBe('source_grounded_question');
    expect(
      classifyConversationalTurn(
        'Can you help me compare three backup vendors for next month?',
      ),
    ).toBe('source_grounded_question');
    expect(
      classifyConversationalTurn('What is the weather today in Dallas?'),
    ).toBe('source_grounded_question');
    expect(
      classifyConversationalTurn("What's the forecast for Dallas tomorrow?"),
    ).toBe('source_grounded_question');
    expect(classifyConversationalTurn('Will it rain in Dallas tonight?')).toBe(
      'source_grounded_question',
    );
  });

  it('keeps work and operator asks out of the ordinary conversational lane', () => {
    expect(classifyConversationalTurn('/cursor_status')).toBe(
      'work_or_operator',
    );
    expect(
      classifyConversationalTurn('Show me the runtime logs for that cursor job'),
    ).toBe('work_or_operator');
  });
});

describe('research eligibility classifier', () => {
  it('treats plain factoids as research-eligible when they are not local utilities', () => {
    expect(
      isResearchEligibleConversationalPrompt(
        "What is Jar Jar Binks' species?",
      ),
    ).toBe(true);
    expect(
      isResearchEligibleConversationalPrompt(
        'What should I know about Jar Jar Binks?',
      ),
    ).toBe(true);
    expect(
      isResearchEligibleConversationalPrompt(
        'What is the weather today in Dallas?',
      ),
    ).toBe(true);
    expect(
      isResearchEligibleConversationalPrompt(
        "What's the forecast for Dallas tomorrow?",
      ),
    ).toBe(true);
  });

  it('does not pull local utilities or personal guidance into research', () => {
    expect(
      isResearchEligibleConversationalPrompt('What time is it in Australia?'),
    ).toBe(false);
    expect(isResearchEligibleConversationalPrompt('What day is it?')).toBe(false);
    expect(
      isResearchEligibleConversationalPrompt("What's still open with Candace?"),
    ).toBe(false);
  });
});

describe('graceful degraded replies', () => {
  it('keeps runtime-unavailable replies non-technical for ordinary chat', () => {
    const reply = buildGracefulDegradedReply({
      kind: 'assistant_runtime_unavailable',
      channel: 'telegram',
      text: "What's up?",
    });

    expect(reply).toContain("I'm here");
    expect(reply).not.toContain('runtime failed during startup or execution');
    expect(reply).not.toContain('operator');
    expect(reply).not.toContain('setup verify');
  });

  it('keeps deeper-read misses calm in messages', () => {
    const reply = buildGracefulDegradedReply({
      kind: 'assistant_runtime_unavailable',
      channel: 'bluebubbles',
      text: 'help me with this',
    });

    expect(reply).toContain("didn't come through cleanly");
    expect(reply).toContain('one simple thing');
    expect(reply).not.toContain('deeper read missed');
  });

  it('uses the honest live-check fallback for current-news asks', () => {
    const reply = buildGracefulDegradedReply({
      kind: 'assistant_runtime_unavailable',
      channel: 'telegram',
      text: "What's the news today?",
    });

    expect(reply).toContain("can't check that live right now");
    expect(reply).not.toContain("didn't come through cleanly");
  });

  it('keeps research-unavailable replies channel-safe and human', () => {
    const telegramReply = buildGracefulDegradedReply({
      kind: 'research_unavailable',
      channel: 'telegram',
      text: "What is Jar Jar Binks' species?",
    });
    const alexaReply = buildGracefulDegradedReply({
      kind: 'research_unavailable',
      channel: 'alexa',
      text: "What is Jar Jar Binks' species?",
    });
    const bluebubblesReply = buildGracefulDegradedReply({
      kind: 'research_unavailable',
      channel: 'bluebubbles',
      text: "What is Jar Jar Binks' species?",
    });

    expect(telegramReply).toContain("can't check that live right now");
    expect(alexaReply).not.toContain('saved material or help narrow the question');
    expect(bluebubblesReply).toContain('grounded');
  });

  it('renders auth, stale-context, and unsupported-capability replies without operator leakage', () => {
    const authReply = buildGracefulDegradedReply({
      kind: 'auth_or_linking_required',
      channel: 'telegram',
      text: 'save that to my library',
    });
    const staleReply = buildGracefulDegradedReply({
      kind: 'stale_context',
      channel: 'bluebubbles',
      text: 'what happens next',
    });
    const unsupportedReply = buildGracefulDegradedReply({
      kind: 'unsupported_channel_capability',
      channel: 'alexa',
      text: 'send me the full version',
      targetChannel: 'telegram',
    });

    expect(authReply).toContain('account linked');
    expect(authReply).not.toContain('operator');
    expect(authReply).not.toContain('setup verify');
    expect(staleReply).toContain('lost the thread');
    expect(staleReply).not.toContain('runtime');
    expect(unsupportedReply).toContain('Telegram');
    expect(unsupportedReply).not.toContain('delegate');
  });

  it('keeps calendar-create failures human without leaking technical setup detail in BlueBubbles', () => {
    const reply = buildCalendarCompanionFailureReply({
      channel: 'bluebubbles',
      action: 'create_event',
      kind: 'calendar_auth_unavailable',
    });

    expect(reply).toContain("I don't have the calendar connected");
    expect(reply).toContain('save that for later');
    expect(reply).toContain('remind Jeff instead');
    expect(reply).not.toContain('GOOGLE_CALENDAR_');
    expect(reply).not.toContain('host');
    expect(reply).not.toContain('setup');
  });

  it('keeps reminder-confirmation failures human during a transient host restart window', () => {
    const reply = buildCalendarCompanionFailureReply({
      channel: 'telegram',
      action: 'confirm_reminder',
      kind: 'temporary_unavailable',
    });

    expect(reply).toContain("I couldn't line that reminder up right this second");
    expect(reply).toContain('save that for later');
    expect(reply).not.toContain('host');
    expect(reply).not.toContain('runtime');
  });

  it('keeps calendar access failures calm and action-oriented', () => {
    const reply = buildCalendarCompanionFailureReply({
      channel: 'telegram',
      action: 'create_event',
      kind: 'calendar_access_unavailable',
    });

    expect(reply).toContain("I can't reach the calendar right now.");
    expect(reply).toContain('save that for later');
    expect(reply).not.toContain('GOOGLE_CALENDAR_');
  });

  it('formats calendar-create successes with a short human confirmation', () => {
    const reply = buildCalendarCompanionEventReply({
      action: 'create_event',
      title: 'check air filters',
      startIso: '2026-04-09T00:00:00.000Z',
      endIso: '2026-04-09T01:00:00.000Z',
      allDay: false,
      timeZone: 'America/Chicago',
      calendarName: 'Jeff',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
    });

    expect(reply).toContain(
      'Got it - I added "check air filters" to Jeff\'s calendar',
    );
    expect(reply).toContain('Open in Google Calendar: https://calendar.google.com/calendar/event?eid=abc');
    expect(reply).not.toContain('Added "check air filters" to Jeff on');
  });

  it('keeps primary-calendar email addresses out of the human confirmation copy', () => {
    const reply = buildCalendarCompanionEventReply({
      action: 'create_event',
      title: 'check air filters',
      startIso: '2026-04-09T00:00:00.000Z',
      endIso: '2026-04-09T01:00:00.000Z',
      allDay: false,
      timeZone: 'America/Chicago',
      calendarName: 'jeffstory007@gmail.com',
      htmlLink: null,
    });

    expect(reply).toContain('to your calendar');
    expect(reply).not.toContain('jeffstory007@gmail.com');
  });

  it('formats reminder confirmations like the same assistant', () => {
    const reply = buildCalendarCompanionReminderReply({
      title: 'check air filters',
      offsetLabel: '30 minutes before',
      remindAtIso: '2026-04-08T23:30:00.000Z',
      allDay: false,
      timeZone: 'America/Chicago',
    });

    expect(reply).toContain(
      "Done - I'll remind you 30 minutes before check air filters at",
    );
    expect(reply).not.toContain('Reminder:');
  });
});
