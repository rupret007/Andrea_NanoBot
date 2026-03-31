import { describe, expect, it } from 'vitest';

import { analyzeAgentError } from './agent-error.js';

describe('analyzeAgentError', () => {
  it('classifies insufficient quota as non-retriable', () => {
    const analysis = analyzeAgentError(
      'Container exited with code 1: {"error":{"code":"insufficient_quota"}}',
    );

    expect(analysis.code).toBe('insufficient_quota');
    expect(analysis.nonRetriable).toBe(true);
    expect(analysis.userMessage).toContain('out of quota');
  });

  it('classifies invalid model alias as non-retriable', () => {
    const analysis = analyzeAgentError(
      'BadRequestError: Invalid model name passed in model=claude-sonnet-4-6',
    );

    expect(analysis.code).toBe('invalid_model_alias');
    expect(analysis.nonRetriable).toBe(true);
  });

  it('does not misclassify initial output timeout as credentials', () => {
    const analysis = analyzeAgentError({
      error: 'Container produced no structured output within 20000ms.',
      failureKind: 'initial_output_timeout',
      failureStage: 'startup',
      diagnosticHint:
        'container did not emit first structured result before timeout',
    });

    expect(analysis.code).toBe('initial_output_timeout');
    expect(analysis.nonRetriable).toBe(false);
    expect(analysis.userMessage).toContain('failed before first output');
  });

  it('keeps true credential failures non-retriable', () => {
    const analysis = analyzeAgentError(
      'Gateway authentication failed because the API key is invalid.',
    );

    expect(analysis.code).toBe('auth_failed');
    expect(analysis.nonRetriable).toBe(true);
  });

  it('keeps unknown transport failures retriable', () => {
    const analysis = analyzeAgentError(
      'Container exited with code 1: fetch failed ECONNRESET',
    );

    expect(analysis.code).toBe('transient_or_unknown');
    expect(analysis.nonRetriable).toBe(false);
    expect(analysis.userMessage).toBeNull();
  });
});
