import { describe, expect, it } from 'vitest';

import {
  buildTaskOutputSuggestion,
  interpretTaskContinuation,
  maybeBuildHarmlessTaskReply,
  mergeTaskMessageContextPayload,
  summarizeVisibleTaskText,
} from './task-continuation.js';

describe('task continuation helper', () => {
  const outputPayload = mergeTaskMessageContextPayload(null, {
    taskContextType: 'output',
    taskTitle: 'Cursor Cloud bc-1234567890',
    taskSummary: 'Draft product copy for the launch note',
    outputPreview:
      'Launch faster with one assistant that keeps your task moving.',
    outputSource: 'conversation',
  });

  it('normalizes fix-that prompts using visible output context', () => {
    const result = interpretTaskContinuation({
      laneId: 'cursor',
      rawPrompt: 'fix that',
      contextKind: 'output',
      messageContextPayload: outputPayload,
    });

    expect(result.continuationKind).toBe('fix_issue');
    expect(result.usedVisibleContext).toBe(true);
    expect(result.normalizedPromptText).toContain(
      'Improve clarity, wording, and overall quality',
    );
    expect(result.normalizedPromptText).toContain(
      'If no specific issue is stated, perform a general improvement pass',
    );
    expect(result.normalizedPromptText).toContain(
      'Launch faster with one assistant',
    );
  });

  it('normalizes improve-that prompts using the same general improvement fallback', () => {
    const result = interpretTaskContinuation({
      laneId: 'cursor',
      rawPrompt: 'improve that',
      contextKind: 'output',
      messageContextPayload: outputPayload,
    });

    expect(result.continuationKind).toBe('fix_issue');
    expect(result.usedVisibleContext).toBe(true);
    expect(result.normalizedPromptText).toContain(
      'Revise the previous output using the visible task context below',
    );
    expect(result.normalizedPromptText).toContain(
      'Improve clarity, wording, and overall quality',
    );
  });

  it('leaves explicit fix instructions unchanged', () => {
    const rawPrompt = 'fix the grammar';
    const result = interpretTaskContinuation({
      laneId: 'cursor',
      rawPrompt,
      contextKind: 'output',
      messageContextPayload: outputPayload,
    });

    expect(result.continuationKind).toBe('fresh_instruction');
    expect(result.normalizedPromptText).toBe(rawPrompt);
    expect(result.usedVisibleContext).toBe(false);
  });

  it('keeps the shorter rewrite working after a vague fix-style reply', () => {
    const fixResult = interpretTaskContinuation({
      laneId: 'cursor',
      rawPrompt: 'fix that',
      contextKind: 'output',
      messageContextPayload: outputPayload,
    });
    expect(fixResult.continuationKind).toBe('fix_issue');

    const shorterResult = interpretTaskContinuation({
      laneId: 'cursor',
      rawPrompt: 'make it shorter',
      contextKind: 'output',
      messageContextPayload: outputPayload,
    });

    expect(shorterResult.continuationKind).toBe('revise_shorter');
    expect(shorterResult.normalizedPromptText).toContain(
      'make it shorter while preserving the key meaning',
    );
  });

  it('normalizes shorten, expand, and adapt prompts with visible context', () => {
    expect(
      interpretTaskContinuation({
        laneId: 'cursor',
        rawPrompt: 'make it shorter',
        contextKind: 'output',
        messageContextPayload: outputPayload,
      }).normalizedPromptText,
    ).toContain('make it shorter while preserving the key meaning');

    expect(
      interpretTaskContinuation({
        laneId: 'cursor',
        rawPrompt: 'add more detail',
        contextKind: 'output',
        messageContextPayload: outputPayload,
      }).normalizedPromptText,
    ).toContain('expand it with more detail');

    expect(
      interpretTaskContinuation({
        laneId: 'cursor',
        rawPrompt: 'do that but for enterprise customers',
        contextKind: 'output',
        messageContextPayload: outputPayload,
      }).normalizedPromptText,
    ).toContain('adapt it for enterprise customers');
  });

  it('passes longer specific instructions through unchanged', () => {
    const rawPrompt =
      'Rewrite this in a warmer tone, keep the CTA, and mention the Friday demo at the end.';
    const result = interpretTaskContinuation({
      laneId: 'cursor',
      rawPrompt,
      contextKind: 'output',
      messageContextPayload: outputPayload,
    });

    expect(result.continuationKind).toBe('fresh_instruction');
    expect(result.normalizedPromptText).toBe(rawPrompt);
    expect(result.usedVisibleContext).toBe(false);
  });

  it('does not invent context when none is available', () => {
    const result = interpretTaskContinuation({
      laneId: 'andrea_runtime',
      rawPrompt: 'try again',
      contextKind: 'job_card',
      messageContextPayload: null,
    });

    expect(result.continuationKind).toBe('retry');
    expect(result.normalizedPromptText).toBe('try again');
    expect(result.usedVisibleContext).toBe(false);
  });

  it('builds subtle output suggestions and harmless task acknowledgments', () => {
    expect(
      buildTaskOutputSuggestion({
        laneId: 'cursor',
        contextKind: 'output',
        hasStructuredOutput: true,
        canReplyContinue: true,
      }),
    ).toContain('make it shorter');
    expect(
      buildTaskOutputSuggestion({
        laneId: 'andrea_runtime',
        contextKind: 'activity',
        hasStructuredOutput: false,
        canReplyContinue: true,
      }),
    ).toContain('what Andrea should try next');
    expect(maybeBuildHarmlessTaskReply('thanks')).toContain(
      'what Andrea should change next for this task',
    );
    expect(maybeBuildHarmlessTaskReply('go ahead')).toBeNull();
  });

  it('summarizes visible task text safely', () => {
    expect(
      summarizeVisibleTaskText('Line one\nLine two\n' + 'x'.repeat(400), 60),
    ).toMatch(/\.\.\.$/);
  });
});
