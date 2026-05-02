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
