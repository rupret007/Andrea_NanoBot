import { describe, expect, it } from 'vitest';

import {
  createWorkCockpitPresentationQueue,
  createWorkCockpitReadGuard,
  reconcileWorkCockpitCurrentSelection,
  resolveRuntimeDashboardJobId,
  shouldClearStaleWorkCockpitSelection,
} from './work-cockpit-targets.js';

function deferredPresentation() {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, complete: () => complete() };
}

describe('createWorkCockpitPresentationQueue', () => {
  it('finishes the older delivery and context together before presenting the newer card', async () => {
    const queue = createWorkCockpitPresentationQueue();
    const oldDelivery = deferredPresentation();
    const newDelivery = deferredPresentation();
    const events: string[] = [];
    let visibleText = 'initial';
    let context = { readOnlyRecovery: false };
    const pairedCards: Array<{ text: string; readOnlyRecovery: boolean }> = [];

    const older = queue.run('chat-one/thread-one', async () => {
      events.push('old-start');
      await oldDelivery.promise;
      visibleText = 'Status temporarily unavailable';
      context = { readOnlyRecovery: true };
      pairedCards.push({ text: visibleText, ...context });
      events.push('old-stored');
      return 'old-message';
    });
    const newer = queue.run('chat-one/thread-one', async () => {
      events.push('new-start');
      await newDelivery.promise;
      visibleText = 'Current task is running';
      context = { readOnlyRecovery: false };
      pairedCards.push({ text: visibleText, ...context });
      events.push('new-stored');
      return 'new-message';
    });

    await Promise.resolve();
    expect(events).toEqual(['old-start']);
    expect(visibleText).toBe('initial');
    oldDelivery.complete();
    await expect(older).resolves.toBe('old-message');
    expect({ text: visibleText, ...context }).toEqual({
      text: 'Status temporarily unavailable',
      readOnlyRecovery: true,
    });
    expect(events).toEqual(['old-start', 'old-stored', 'new-start']);

    newDelivery.complete();
    await expect(newer).resolves.toBe('new-message');
    expect({ text: visibleText, ...context }).toEqual({
      text: 'Current task is running',
      readOnlyRecovery: false,
    });
    expect(pairedCards).toEqual([
      { text: 'Status temporarily unavailable', readOnlyRecovery: true },
      { text: 'Current task is running', readOnlyRecovery: false },
    ]);
    expect(events).toEqual([
      'old-start',
      'old-stored',
      'new-start',
      'new-stored',
    ]);
  });

  it('rejects a failed presentation without poisoning the next one for that key', async () => {
    const queue = createWorkCockpitPresentationQueue();
    const failure = new Error('Synthetic edit failure');
    const events: string[] = [];
    const failed = queue.run('chat-one/thread-one', async () => {
      events.push('failed');
      throw failure;
    });
    const recovered = queue.run('chat-one/thread-one', async () => {
      events.push('recovered');
      return 'recovered-message';
    });
    await expect(failed).rejects.toBe(failure);
    await expect(recovered).resolves.toBe('recovered-message');
    expect(events).toEqual(['failed', 'recovered']);
  });

  it('allows other chats and threads to present while one key is waiting', async () => {
    const queue = createWorkCockpitPresentationQueue();
    const delivery = deferredPresentation();
    const events: string[] = [];
    const waiting = queue.run('chat-one/thread-one', async () => {
      await delivery.promise;
      events.push('waiting-finished');
    });
    await queue.run('chat-one/thread-two', async () => {
      events.push('other-thread');
    });
    await queue.run('chat-two/thread-one', async () => {
      events.push('other-chat');
    });
    expect(events).toEqual(['other-thread', 'other-chat']);
    delivery.complete();
    await waiting;
    expect(events).toEqual(['other-thread', 'other-chat', 'waiting-finished']);
  });

  it('reuses an idle key without letting old cleanup bypass a new pending delivery', async () => {
    const queue = createWorkCockpitPresentationQueue();
    const events: string[] = [];
    await queue.run('chat-one/thread-one', async () => {
      events.push('first');
    });
    const delivery = deferredPresentation();
    const second = queue.run('chat-one/thread-one', async () => {
      events.push('second-start');
      await delivery.promise;
      events.push('second-finished');
    });
    await Promise.resolve();
    const third = queue.run('chat-one/thread-one', async () => {
      events.push('third');
    });
    await Promise.resolve();
    expect(events).toEqual(['first', 'second-start']);
    delivery.complete();
    await Promise.all([second, third]);
    expect(events).toEqual([
      'first',
      'second-start',
      'second-finished',
      'third',
    ]);
  });
});

describe('createWorkCockpitReadGuard', () => {
  it('allows only the newest read for the same chat and thread key', () => {
    const guard = createWorkCockpitReadGuard();
    const first = guard.begin('chat-one/thread-one');
    expect(first()).toBe(true);
    const second = guard.begin('chat-one/thread-one');
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    expect(second()).toBe(true);
    const third = guard.begin('chat-one/thread-one');
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });

  it('keeps unrelated chats and threads independently current', () => {
    const guard = createWorkCockpitReadGuard();
    const firstThread = guard.begin('chat-one/thread-one');
    const secondThread = guard.begin('chat-one/thread-two');
    const otherChat = guard.begin('chat-two/thread-one');
    const newerFirstThread = guard.begin('chat-one/thread-one');
    expect(firstThread()).toBe(false);
    expect(newerFirstThread()).toBe(true);
    expect(secondThread()).toBe(true);
    expect(otherChat()).toBe(true);
  });

  it('retains at most 256 keys and never revives an evicted callback', () => {
    const guard = createWorkCockpitReadGuard();
    const reads = Array.from({ length: 256 }, (_, index) =>
      guard.begin(`chat-${index}`),
    );
    expect(reads.every((isCurrent) => isCurrent())).toBe(true);
    const extra = guard.begin('chat-256');
    expect(reads[0]()).toBe(false);
    expect(reads.slice(1).every((isCurrent) => isCurrent())).toBe(true);
    expect(extra()).toBe(true);

    const renewedFirst = guard.begin('chat-0');
    expect(reads[0]()).toBe(false);
    expect(reads[1]()).toBe(false);
    expect(renewedFirst()).toBe(true);
    expect(extra()).toBe(true);
  });

  it('refreshes retention order when a known key starts another read', () => {
    const guard = createWorkCockpitReadGuard();
    const reads = Array.from({ length: 256 }, (_, index) =>
      guard.begin(`chat-${index}`),
    );
    const latestFirst = guard.begin('chat-0');
    const extra = guard.begin('chat-256');
    expect(reads[0]()).toBe(false);
    expect(reads[1]()).toBe(false);
    expect(reads.slice(2).every((isCurrent) => isCurrent())).toBe(true);
    expect(latestFirst()).toBe(true);
    expect(extra()).toBe(true);
  });
});

describe('resolveRuntimeDashboardJobId', () => {
  it('uses the exact runtime job id from a unified current-work card', () => {
    expect(
      resolveRuntimeDashboardJobId({
        laneId: 'andrea_runtime',
        agentId: 'runtime-job-1',
        state: { kind: 'work_current' },
      }),
    ).toBe('runtime-job-1');
  });

  it('uses the exact runtime job id from a runtime-current card', () => {
    expect(
      resolveRuntimeDashboardJobId({
        laneId: 'cursor',
        agentId: 'runtime-job-2',
        state: { kind: 'runtime_current' },
      }),
    ).toBe('runtime-job-2');
  });

  it('does not treat cursor work cards as runtime targets', () => {
    expect(
      resolveRuntimeDashboardJobId({
        laneId: 'cursor',
        agentId: 'bc-task-1',
        state: { kind: 'work_current' },
      }),
    ).toBeNull();
  });
});

describe('reconcileWorkCockpitCurrentSelection', () => {
  it('keeps an explicit current-work selection when one already exists', () => {
    expect(
      reconcileWorkCockpitCurrentSelection({
        currentSelection: {
          laneId: 'cursor',
          jobId: 'cursor-job-1',
        },
        runtimeJobId: 'runtime-job-1',
      }),
    ).toEqual({
      laneId: 'cursor',
      jobId: 'cursor-job-1',
    });
  });

  it('promotes the current runtime task when the shared selection is missing', () => {
    expect(
      reconcileWorkCockpitCurrentSelection({
        currentSelection: null,
        runtimeJobId: 'runtime-job-2',
      }),
    ).toEqual({
      laneId: 'andrea_runtime',
      jobId: 'runtime-job-2',
    });
  });

  it('falls back to the current cursor task when no runtime task is selected', () => {
    expect(
      reconcileWorkCockpitCurrentSelection({
        currentSelection: null,
        cursorJobId: 'cursor-job-2',
      }),
    ).toEqual({
      laneId: 'cursor',
      jobId: 'cursor-job-2',
    });
  });
});

describe('shouldClearStaleWorkCockpitSelection', () => {
  it('clears a shared selection only when the selected job is missing', () => {
    expect(
      shouldClearStaleWorkCockpitSelection({
        selectedJobId: 'runtime-job-1',
        selectedExists: false,
        status: 'succeeded',
      }),
    ).toBe(true);
  });

  it('keeps completed jobs selectable in the work cockpit', () => {
    expect(
      shouldClearStaleWorkCockpitSelection({
        selectedJobId: 'runtime-job-2',
        selectedExists: true,
        status: 'succeeded',
      }),
    ).toBe(false);
  });

  it('keeps running jobs selectable in the work cockpit', () => {
    expect(
      shouldClearStaleWorkCockpitSelection({
        selectedJobId: 'runtime-job-3',
        selectedExists: true,
        status: 'running',
      }),
    ).toBe(false);
  });
});
