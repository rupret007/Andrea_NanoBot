import { describe, expect, it } from 'vitest';

import {
  analyzeAgentError,
  buildRepeatedAgentErrorMessage,
} from './agent-error.js';

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
    expect(analysis.userMessage).not.toContain('/debug-status');
  });

  it('mentions lifecycle-only output when runtime never reached a real answer', () => {
    const analysis = analyzeAgentError({
      error: 'Container completed without a real assistant answer.',
      failureKind: 'runtime_bootstrap_failed',
      failureStage: 'runtime',
      diagnosticHint:
        'container produced lifecycle-only output but never reached a real assistant answer before the hard timeout',
      sawLifecycleOnlyOutput: true,
    });

    expect(analysis.code).toBe('runtime_bootstrap_failed');
    expect(analysis.userMessage).toContain('lifecycle output');
  });

  it('mentions the recovery retry when runtime still fails after retry', () => {
    const analysis = analyzeAgentError({
      error: 'Container exited with code 1.',
      failureKind: 'runtime_bootstrap_failed',
      failureStage: 'runtime',
      diagnosticHint:
        'assistant runtime hit a transient execution failure before producing a stable answer',
      recoveryAttempted: true,
    });

    expect(analysis.code).toBe('runtime_bootstrap_failed');
    expect(analysis.userMessage).toContain('retried once');
  });

  it('keeps true credential failures non-retriable', () => {
    const analysis = analyzeAgentError(
      'Gateway authentication failed because the API key is invalid.',
    );

    expect(analysis.code).toBe('auth_failed');
    expect(analysis.nonRetriable).toBe(true);
  });

  it('does not treat runtime timeout text with credential references as credentials', () => {
    const analysis = analyzeAgentError(
      'Container produced no structured output within 20000ms while prior credential checks were ok.',
    );

    expect(analysis.code).toBe('initial_output_timeout');
    expect(analysis.nonRetriable).toBe(false);
  });

  it('treats container transport crashes as retriable runtime failures', () => {
    const analysis = analyzeAgentError(
      'Container exited with code 1: fetch failed ECONNRESET',
    );

    expect(analysis.code).toBe('runtime_bootstrap_failed');
    expect(analysis.nonRetriable).toBe(false);
    expect(analysis.userMessage).toContain('runtime failed during startup');
  });

  it('builds a concise repeated message for runtime startup failures', () => {
    expect(buildRepeatedAgentErrorMessage('initial_output_timeout')).toContain(
      'assistant runtime',
    );
  });

  it('builds a concise repeated message for auth/config failures', () => {
    expect(buildRepeatedAgentErrorMessage('auth_failed')).toContain(
      'operator attention',
    );
  });
});
