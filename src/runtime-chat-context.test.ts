import { describe, expect, it } from 'vitest';

import {
  buildRuntimeReplyContextMissingMessage,
  buildRuntimeSelectionMissingMessage,
  computeRuntimeCardContextExpiry,
  extractRuntimeBackendJobIdFromText,
  isRuntimeBackendCardText,
  resolveRuntimeJobTarget,
  resolveRuntimeLogsTarget,
  resolveRuntimeReplyContext,
} from './runtime-chat-context.js';

describe('runtime-chat-context helpers', () => {
  it('extracts runtime job ids from current runtime card text', () => {
    expect(
      extractRuntimeBackendJobIdFromText(
        'Andrea OpenAI follow-up accepted.\n\nAndrea OpenAI Runtime\n- Job ID: runtime-job-follow_up-123',
      ),
    ).toBe('runtime-job-follow_up-123');
  });

  it('recognizes runtime cards and logs cards only', () => {
    expect(
      isRuntimeBackendCardText(
        'Andrea OpenAI logs are not ready yet for job runtime-job-123.',
      ),
    ).toBe(true);
    expect(isRuntimeBackendCardText('What is next on my calendar?')).toBe(
      false,
    );
  });

  it('computes a 24-hour reply-context expiry window', () => {
    expect(
      computeRuntimeCardContextExpiry('2026-04-03T10:00:00.000Z'),
    ).toBe('2026-04-04T10:00:00.000Z');
  });

  it('resolves explicit and selected runtime job targets', () => {
    expect(resolveRuntimeJobTarget('job_123', 'job_selected')).toEqual({
      jobId: 'job_123',
      usedSelection: false,
      missingSelection: false,
    });
    expect(resolveRuntimeJobTarget(undefined, 'job_selected')).toEqual({
      jobId: 'job_selected',
      usedSelection: true,
      missingSelection: false,
    });
    expect(resolveRuntimeJobTarget(undefined, null)).toEqual({
      jobId: null,
      usedSelection: false,
      missingSelection: true,
    });
  });

  it('resolves current logs requests from selection without overriding explicit job ids', () => {
    expect(resolveRuntimeLogsTarget(undefined, undefined, 'job_selected')).toEqual({
      jobId: 'job_selected',
      usedSelection: true,
      missingSelection: false,
      limit: 40,
    });
    expect(resolveRuntimeLogsTarget('80', undefined, 'job_selected')).toEqual({
      jobId: 'job_selected',
      usedSelection: true,
      missingSelection: false,
      limit: 80,
    });
    expect(resolveRuntimeLogsTarget('job_123', '90', 'job_selected')).toEqual({
      jobId: 'job_123',
      usedSelection: false,
      missingSelection: false,
      limit: 90,
    });
  });

  it('classifies reply-linked runtime context as ready, missing, or expired', () => {
    const replyText =
      'Andrea OpenAI job accepted.\n\nAndrea OpenAI Runtime\n- Job ID: runtime-job-create-123';

    expect(
      resolveRuntimeReplyContext({
        replyMessageId: '500',
        replyText,
        contextMessageId: '500',
        contextJobId: 'runtime-job-create-123',
        contextGroupFolder: 'main',
        currentGroupFolder: 'main',
        expiresAt: '2026-04-04T10:00:00.000Z',
        nowIso: '2026-04-03T10:00:00.000Z',
      }),
    ).toEqual({
      kind: 'ready',
      jobIdHint: 'runtime-job-create-123',
      jobId: 'runtime-job-create-123',
    });

    expect(
      resolveRuntimeReplyContext({
        replyMessageId: '500',
        replyText,
        currentGroupFolder: 'main',
        nowIso: '2026-04-03T10:00:00.000Z',
      }),
    ).toEqual({
      kind: 'missing',
      jobIdHint: 'runtime-job-create-123',
      jobId: null,
    });

    expect(
      resolveRuntimeReplyContext({
        replyMessageId: '500',
        replyText,
        contextMessageId: '500',
        contextJobId: 'runtime-job-create-123',
        contextGroupFolder: 'main',
        currentGroupFolder: 'main',
        expiresAt: '2026-04-03T09:00:00.000Z',
        nowIso: '2026-04-03T10:00:00.000Z',
      }),
    ).toEqual({
      kind: 'expired',
      jobIdHint: 'runtime-job-create-123',
      jobId: null,
    });
  });

  it('renders honest fallback messages for stale reply context and missing selection', () => {
    expect(buildRuntimeReplyContextMissingMessage('job_123')).toContain(
      '/runtime-followup job_123 TEXT',
    );
    expect(buildRuntimeSelectionMissingMessage('logs')).toContain(
      '/runtime-logs JOB_ID [LINES]',
    );
  });
});
