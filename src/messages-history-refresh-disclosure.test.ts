import { describe, expect, it } from 'vitest';

import { formatMessagesHistoryRefreshDisclosure } from './messages-history-refresh-disclosure.js';

describe('Messages history refresh disclosure', () => {
  it('describes a bounded targeted success without claiming completeness', () => {
    const disclosure = formatMessagesHistoryRefreshDisclosure({
      mode: 'targeted_succeeded',
      requestedLimit: 400,
      inspectedCount: 17,
      storedCount: 2,
      latestLocalMessageAt: '2026-07-16T20:15:00.000Z',
      timeZone: 'America/Chicago',
    });

    expect(disclosure).toContain('Targeted refresh succeeded');
    expect(disclosure).toContain('newest 400 messages');
    expect(disclosure).toContain('Newest eligible local Messages item:');
    expect(disclosure).toContain('not independently verified');
    expect(disclosure).not.toMatch(/complete(?:ness)? was verified/i);
  });

  it.each([
    ['targeted_failed', 'Targeted refresh failed'],
    ['global_failed', 'Global refresh failed'],
    ['local_only', 'No provider refresh was attempted'],
  ] as const)('discloses the %s local-only fallback', (mode, expected) => {
    const disclosure = formatMessagesHistoryRefreshDisclosure({
      mode,
      requestedLimit: mode === 'global_failed' ? 500 : 400,
      latestLocalMessageAt: null,
      timeZone: 'America/Chicago',
    });

    expect(disclosure).toContain(expected);
    expect(disclosure).toContain('existing local snapshot only');
    expect(disclosure).toContain(
      'Newest eligible local Messages item: none found.',
    );
  });

  it('warns that a global success can omit quiet threads', () => {
    const disclosure = formatMessagesHistoryRefreshDisclosure({
      mode: 'global_succeeded',
      requestedLimit: 500,
      inspectedCount: 500,
      storedCount: 4,
      latestLocalMessageAt: '2026-07-16T20:15:00.000Z',
      timeZone: 'America/Chicago',
    });

    expect(disclosure).toContain('Global refresh succeeded');
    expect(disclosure).toContain('quiet thread can fall outside');
    expect(disclosure).not.toMatch(/all messages|full history/i);
  });

  it('retains a preceding global discovery result when a named thread then gets a targeted refresh', () => {
    const disclosure = formatMessagesHistoryRefreshDisclosure({
      mode: 'targeted_succeeded',
      requestedLimit: 400,
      inspectedCount: 12,
      storedCount: 1,
      latestLocalMessageAt: '2026-07-16T20:15:00.000Z',
      timeZone: 'America/Chicago',
      precedingGlobalDiscovery: {
        mode: 'global_succeeded',
        requestedLimit: 500,
        inspectedCount: 500,
        storedCount: 3,
      },
    });

    expect(disclosure).toContain('Targeted refresh succeeded');
    expect(disclosure).toContain('Metadata discovery refresh');
    expect(disclosure).toContain('bounded global refresh succeeded');
    expect(disclosure).toContain('global discovery read was bounded');
    expect(disclosure).toContain('quiet thread could have fallen outside');
    expect(disclosure).toContain('not independently verified');
  });
});
