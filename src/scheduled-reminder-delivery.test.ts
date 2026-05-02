import { describe, expect, it } from 'vitest';

import { buildPlainReminderDeliveryText } from './scheduled-reminder-delivery.js';

describe('scheduled reminder delivery', () => {
  it('renders plain local reminder tasks without invoking an agent', () => {
    expect(
      buildPlainReminderDeliveryText({
        prompt: 'Send a concise reminder telling the user to call Sam.',
        script: null,
      }),
    ).toBe('Reminder: call Sam.');
  });

  it('renders calendar-style and status-style reminder prompts directly', () => {
    expect(
      buildPlainReminderDeliveryText({
        prompt: 'Send a concise reminder that Google timed proof is scheduled.',
        script: null,
      }),
    ).toBe('Reminder: Google timed proof is scheduled.');
    expect(
      buildPlainReminderDeliveryText({
        prompt: 'Send a concise reminder about the self-improvement check.',
        script: null,
      }),
    ).toBe('Reminder: the self-improvement check.');
  });

  it('ignores scripted or non-reminder scheduled tasks', () => {
    expect(
      buildPlainReminderDeliveryText({
        prompt: 'Send a concise reminder telling the user to call Sam.',
        script: 'echo hi',
      }),
    ).toBeNull();
    expect(
      buildPlainReminderDeliveryText({
        prompt: 'Summarize my current tasks.',
        script: null,
      }),
    ).toBeNull();
  });
});
