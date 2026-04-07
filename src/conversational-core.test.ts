import { describe, expect, it } from 'vitest';

import {
  buildGracefulDegradedReply,
  classifyConversationalTurn,
  isResearchEligibleConversationalPrompt,
} from './conversational-core.js';

describe('conversational core classifier', () => {
  it('classifies ordinary greetings and vibe checks locally', () => {
    expect(classifyConversationalTurn("Hey, what's up?")).toBe(
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
    expect(
      classifyConversationalTurn('What should I know about Jar Jar Binks?'),
    ).toBe('source_grounded_question');
    expect(
      classifyConversationalTurn(
        'Can you help me compare three backup vendors for next month?',
      ),
    ).toBe('source_grounded_question');
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
  });

  it('does not pull local utilities or personal guidance into research', () => {
    expect(
      isResearchEligibleConversationalPrompt('What time is it in Australia?'),
    ).toBe(false);
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
});
