import { describe, expect, it } from 'vitest';
import { planCompoundReminderResearchRequest } from './reminder-research-coordinator.js';

describe('planCompoundReminderResearchRequest', () => {
  it('splits one explicit reminder from a following research request', () => {
    expect(
      planCompoundReminderResearchRequest(
        'Remind me tomorrow at 3 PM to call pharmacy, and look up what I should have ready',
        'main',
        'tg:owner',
        new Date('2026-07-14T10:00:00-05:00'),
        { channel: 'telegram', inboundId: '42' },
      ),
    ).toMatchObject({
      reminderText: 'Remind me tomorrow at 3 PM to call pharmacy',
      researchText: 'look up what I should have ready',
      requestedDepth: 'standard',
    });
  });

  it('does not split research that is itself the reminder body', () => {
    expect(
      planCompoundReminderResearchRequest(
        'Remind me tomorrow at 3 PM to research pharmacy billing',
        'main',
        'tg:owner',
        new Date('2026-07-14T10:00:00-05:00'),
      ),
    ).toBeNull();
  });
});
