import { describe, expect, it } from 'vitest';

import {
  formatCurrentFocusLabel,
  formatTaskContinuationGuidance,
  formatTaskLaneLabel,
  formatTaskOutputHeading,
  formatTaskReplyPrompt,
} from './task-presentation.js';

describe('task presentation helpers', () => {
  it('normalizes lane labels and current focus labels', () => {
    expect(formatTaskLaneLabel('cursor_cloud')).toBe('Cursor Cloud');
    expect(formatTaskLaneLabel('cursor_desktop')).toBe('Cursor Desktop');
    expect(formatTaskLaneLabel('codex_runtime')).toBe('Codex/OpenAI runtime');
    expect(formatCurrentFocusLabel('cursor')).toBe('Cursor');
    expect(formatCurrentFocusLabel('andrea_runtime')).toBe(
      'Codex/OpenAI runtime',
    );
    expect(formatCurrentFocusLabel(null)).toBe('none selected yet');
  });

  it('keeps continuation guidance lane-correct and task-first', () => {
    expect(formatTaskContinuationGuidance({ lane: 'cursor_cloud' })).toContain(
      'continue this task',
    );
    expect(
      formatTaskContinuationGuidance({ lane: 'cursor_desktop' }),
    ).toContain('machine-side terminal controls');
    expect(
      formatTaskContinuationGuidance({
        lane: 'codex_runtime',
        canReplyContinue: false,
      }),
    ).toContain('execution stays off on this host');
  });

  it('uses task-oriented output headings and reply prompts', () => {
    expect(formatTaskOutputHeading('final_output')).toBe('Current output');
    expect(formatTaskOutputHeading('latest_output')).toBe('Current output');
    expect(formatTaskOutputHeading('logs')).toBe('Recent activity');
    expect(
      formatTaskReplyPrompt({
        lane: 'codex_runtime',
        taskId: 'runtime-job-1234567890',
      }),
    ).toContain(
      'Reply here with what Andrea should change next for this task.',
    );
  });
});
