import { describe, expect, it } from 'vitest';

import { buildDirectAssistantContinuationPrompt } from './direct-assistant-continuation.js';

describe('buildDirectAssistantContinuationPrompt', () => {
  it('rewrites terse shorten follow-ups using the previous assistant reply', () => {
    const result = buildDirectAssistantContinuationPrompt({
      rawPrompt: 'make it shorter',
      previousAssistantText:
        'Andrea_NanoBot is a personal assistant that helps with tasks, answers questions, browses the web, and schedules reminders.',
    });

    expect(result.usedVisibleContext).toBe(true);
    expect(result.shouldStartFreshSession).toBe(true);
    expect(result.normalizedPromptText).toContain(
      'Rewrite this sentence in a shorter way while preserving the meaning.',
    );
    expect(result.normalizedPromptText).toContain(
      'Reply with one sentence only:',
    );
    expect(result.fallbackPromptText).toContain(
      'Return a shorter version of this sentence:',
    );
    expect(result.normalizedPromptText).toContain(
      'Andrea_NanoBot is a personal assistant',
    );
  });

  it('rewrites vague fix follow-ups into a general improvement pass', () => {
    const result = buildDirectAssistantContinuationPrompt({
      rawPrompt: 'fix that',
      previousAssistantText:
        'enterprise post-restart continuity verification completed successfully',
    });

    expect(result.usedVisibleContext).toBe(true);
    expect(result.shouldStartFreshSession).toBe(true);
    expect(result.normalizedPromptText).toContain(
      'Rewrite this sentence more clearly and smoothly while preserving the meaning.',
    );
    expect(result.fallbackPromptText).toContain(
      'Improve the wording of this sentence and return only the revised sentence:',
    );
    expect(result.normalizedPromptText).toContain('enterprise post-restart');
  });

  it('leaves explicit instructions unchanged', () => {
    const result = buildDirectAssistantContinuationPrompt({
      rawPrompt: 'Rewrite that in a warmer tone and keep it to one sentence.',
      previousAssistantText:
        'Andrea_NanoBot is a personal assistant that helps with tasks and reminders.',
    });

    expect(result.usedVisibleContext).toBe(false);
    expect(result.shouldStartFreshSession).toBe(false);
    expect(result.normalizedPromptText).toBe(
      'Rewrite that in a warmer tone and keep it to one sentence.',
    );
  });

  it('does nothing when there is no previous assistant reply', () => {
    const result = buildDirectAssistantContinuationPrompt({
      rawPrompt: 'make it shorter',
      previousAssistantText: null,
    });

    expect(result.usedVisibleContext).toBe(false);
    expect(result.shouldStartFreshSession).toBe(false);
    expect(result.normalizedPromptText).toBe('make it shorter');
  });

  it('compacts multiline visible context before building a terse follow-up prompt', () => {
    const result = buildDirectAssistantContinuationPrompt({
      rawPrompt: 'fix that',
      previousAssistantText:
        'Line one.\n\nLine two with   extra   spaces.\nLine three.',
    });

    expect(result.normalizedPromptText).toBe(
      'Rewrite this sentence more clearly and smoothly while preserving the meaning. Reply with one sentence only: Line one. Line two with extra spaces. Line three.',
    );
  });
});
