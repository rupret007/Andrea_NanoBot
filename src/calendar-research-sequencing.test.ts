import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

import { planCompoundCalendarResearchRequest } from './calendar-research-coordinator.js';
import {
  deliverPrimaryThenStartReadOnlySidecar,
  drainBackgroundReadOnlySidecars,
} from './calendar-research-sequencing.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('compound calendar and research production sequencing', () => {
  it('keeps the production turn on the bounded harness-bypass path', () => {
    const indexSource = fs.readFileSync(
      new URL('./index.ts', import.meta.url),
      'utf8',
    );
    const planIndex = indexSource.indexOf(
      'const compoundCalendarResearchPlan =\n    planCompoundCalendarResearchRequest(lastContent);',
    );
    const harnessIndex = indexSource.indexOf(
      'const turnAgentHarness: TurnAgentHarnessContext | null =',
    );

    expect(planIndex).toBeGreaterThan(-1);
    expect(harnessIndex).toBeGreaterThan(planIndex);
    expect(indexSource).toContain(
      'Boolean(compoundCalendarResearchPlan || compoundReminderResearchPlan)\n      ? null',
    );
    expect(indexSource).toContain(
      'harnessBypassed:\n          shouldHandleOutcomeReviewLocally ||\n          shouldHandleDurableContinuityLocally ||\n          Boolean(compoundCalendarResearchPlan || compoundReminderResearchPlan)',
    );
    expect(indexSource).toContain(
      'resolveExplicitResearchPersonalContextMode(compoundRequest.researchText)',
    );
    expect(indexSource).toContain(
      "personalContextMode:\n                compoundResearchPersonalContextMode || 'disabled'",
    );
    expect(indexSource).toContain("researchFollowupMode: 'explicit_only'");
    expect(indexSource).toContain("confirmationMode: 'calendar_targeted'");
    expect(indexSource).toContain(
      '!getPendingGoogleCalendarCreatedEvent(activePendingState)',
    );
    expect(indexSource).toContain(
      'actionId: getGoogleCalendarCreateConfirmationActionId(state)',
    );
    expect(
      indexSource.match(/planCompoundCalendarResearchRequest\(lastContent\)/g),
    ).toHaveLength(1);
    expect(indexSource).toContain('persistReminderOperation(plannedReminder)');
    expect(indexSource).toContain('setReminderResearchReceipt(');
    expect(indexSource).toContain('setReminderResearchOperation(');
    expect(indexSource).toContain(
      'startSidecar: priorResearchReceipt ? null : startResearch',
    );
    expect(indexSource).toContain('tryHandleReminderResearchStatus');
  });

  it('drains active sidecars before production channel disconnect', () => {
    const indexSource = fs.readFileSync(
      new URL('./index.ts', import.meta.url),
      'utf8',
    );
    const shutdownIndex = indexSource.indexOf(
      'const performShutdown = async (signal: string) =>',
    );
    const drainIndex = indexSource.indexOf(
      'await drainBackgroundReadOnlySidecars(10_000)',
      shutdownIndex,
    );
    const disconnectIndex = indexSource.indexOf(
      'for (const ch of channels)',
      shutdownIndex,
    );

    expect(shutdownIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(shutdownIndex);
    expect(disconnectIndex).toBeGreaterThan(drainIndex);
  });

  it('records the research leg separately without overwriting newer continuation state', () => {
    const indexSource = fs.readFileSync(
      new URL('./index.ts', import.meta.url),
      'utf8',
    );
    const sidecarDeliveryStart = indexSource.indexOf(
      'const deliverCompoundResearchFailure = async',
    );
    const sidecarDeliveryEnd = indexSource.indexOf(
      'const deliverCalendarReplyThenCompoundResearch = async',
      sidecarDeliveryStart,
    );
    const sidecarDeliverySource = indexSource.slice(
      sidecarDeliveryStart,
      sidecarDeliveryEnd,
    );

    expect(sidecarDeliveryStart).toBeGreaterThan(-1);
    expect(sidecarDeliveryEnd).toBeGreaterThan(sidecarDeliveryStart);
    expect(sidecarDeliverySource.match(/deliveryOrdinal: 2/g)).toHaveLength(2);
    expect(
      sidecarDeliverySource.match(/recordMetricEnabled: true/g),
    ).toHaveLength(2);
    expect(sidecarDeliverySource).not.toContain(
      'setSharedAssistantCapabilitySeed(',
    );
  });

  it('delivers the primary response before starting research', async () => {
    const order: string[] = [];
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => {
        order.push('calendar_draft_delivered');
      },
      startSidecar: async () => {
        order.push('research_started');
        return 'research result';
      },
      deliverResult: async (result) => {
        order.push(result);
      },
      deliverFailure: async () => {
        order.push('research_blocker');
      },
      onSidecarDeliveryError: async () => {
        order.push('research_delivery_error');
      },
    });
    await launch?.completion;

    expect(order).toEqual([
      'calendar_draft_delivered',
      'research_started',
      'research result',
    ]);
  });

  it('does not start research when primary delivery fails', async () => {
    const startSidecar = vi.fn(async () => 'research result');

    await expect(
      deliverPrimaryThenStartReadOnlySidecar({
        deliverPrimary: async () => {
          throw new Error('calendar delivery failed');
        },
        startSidecar,
        deliverResult: async () => undefined,
        deliverFailure: async () => undefined,
        onSidecarDeliveryError: async () => undefined,
      }),
    ).rejects.toThrow('calendar delivery failed');

    expect(startSidecar).not.toHaveBeenCalled();
  });

  it('registers the lifecycle before primary delivery can commit during shutdown', async () => {
    const allowPrimaryReturn = deferred<void>();
    const research = deferred<string>();
    const order: string[] = [];
    const launchPromise = deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => {
        order.push('calendar_delivery_committed');
        await allowPrimaryReturn.promise;
      },
      startSidecar: () => {
        order.push('research_started');
        return research.promise;
      },
      deliverResult: async () => {
        order.push('research_delivered');
      },
      deliverFailure: async () => undefined,
      onSidecarDeliveryError: async () => undefined,
    });
    await vi.waitFor(() => {
      expect(order).toEqual(['calendar_delivery_committed']);
    });

    const draining = drainBackgroundReadOnlySidecars(1_000);
    allowPrimaryReturn.resolve();
    const launch = await launchPromise;
    await vi.waitFor(() => {
      expect(order).toEqual([
        'calendar_delivery_committed',
        'research_started',
      ]);
    });
    research.resolve('research result');

    await expect(draining).resolves.toEqual({
      attempted: 1,
      remaining: 0,
      timedOut: false,
    });
    await launch!.completion;
    expect(order).toEqual([
      'calendar_delivery_committed',
      'research_started',
      'research_delivered',
    ]);
  });

  it('returns before deferred research resolves', async () => {
    const research = deferred<string>();
    const deliverResult = vi.fn(async () => undefined);
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => undefined,
      startSidecar: () => research.promise,
      deliverResult,
      deliverFailure: async () => undefined,
      onSidecarDeliveryError: async () => undefined,
    });

    expect(launch).not.toBeNull();
    expect(deliverResult).not.toHaveBeenCalled();
    research.resolve('research result');
    await launch!.completion;
    expect(deliverResult).toHaveBeenCalledOnce();
  });

  it('drains active research before a graceful transport shutdown', async () => {
    const research = deferred<string>();
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => undefined,
      startSidecar: () => research.promise,
      deliverResult: async () => undefined,
      deliverFailure: async () => undefined,
      onSidecarDeliveryError: async () => undefined,
    });

    const draining = drainBackgroundReadOnlySidecars(1_000);
    research.resolve('research result');

    await expect(draining).resolves.toEqual({
      attempted: 1,
      remaining: 0,
      timedOut: false,
    });
    await launch!.completion;
  });

  it('reports a bounded drain timeout without cancelling the sidecar', async () => {
    const research = deferred<string>();
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => undefined,
      startSidecar: () => research.promise,
      deliverResult: async () => undefined,
      deliverFailure: async () => undefined,
      onSidecarDeliveryError: async () => undefined,
    });

    await expect(drainBackgroundReadOnlySidecars(1)).resolves.toEqual({
      attempted: 1,
      remaining: 1,
      timedOut: true,
    });

    research.resolve('research result');
    await launch!.completion;
    await expect(drainBackgroundReadOnlySidecars()).resolves.toEqual({
      attempted: 0,
      remaining: 0,
      timedOut: false,
    });
  });

  it('delivers a research blocker exactly once after execution failure', async () => {
    const deliverFailure = vi.fn(async (_error: unknown) => undefined);
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => undefined,
      startSidecar: async () => {
        throw new Error('provider unavailable');
      },
      deliverResult: async () => undefined,
      deliverFailure,
      onSidecarDeliveryError: async () => undefined,
    });
    await launch?.completion;

    expect(deliverFailure).toHaveBeenCalledOnce();
    expect(deliverFailure.mock.calls[0]?.[0]).toEqual(
      new Error('provider unavailable'),
    );
  });

  it('starts and settles the sidecar exactly once when completion is observed repeatedly', async () => {
    const startSidecar = vi.fn(async () => 'research result');
    const deliverResult = vi.fn(async () => undefined);
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => undefined,
      startSidecar,
      deliverResult,
      deliverFailure: async () => undefined,
      onSidecarDeliveryError: async () => undefined,
    });

    await Promise.all([launch!.completion, launch!.completion]);

    expect(startSidecar).toHaveBeenCalledOnce();
    expect(deliverResult).toHaveBeenCalledOnce();
  });

  it('classifies result delivery errors without rejecting completion', async () => {
    const onSidecarDeliveryError = vi.fn(async (_error: unknown) => undefined);
    const launch = await deliverPrimaryThenStartReadOnlySidecar({
      deliverPrimary: async () => undefined,
      startSidecar: async () => 'research result',
      deliverResult: async () => {
        throw new Error('research delivery failed');
      },
      deliverFailure: async () => undefined,
      onSidecarDeliveryError,
    });

    await expect(launch?.completion).resolves.toBeUndefined();
    expect(onSidecarDeliveryError).toHaveBeenCalledOnce();
    expect(onSidecarDeliveryError.mock.calls[0]?.[0]).toEqual(
      new Error('research delivery failed'),
    );
  });

  it.each(['1', 'yes'])(
    'does not start research again for calendar confirmation %s',
    async (confirmation) => {
      const startSidecar = vi.fn(async () => 'research result');
      const plan = planCompoundCalendarResearchRequest(confirmation);
      const launch = await deliverPrimaryThenStartReadOnlySidecar({
        deliverPrimary: async () => undefined,
        startSidecar: plan ? startSidecar : null,
        deliverResult: async () => undefined,
        deliverFailure: async () => undefined,
        onSidecarDeliveryError: async () => undefined,
      });

      expect(plan).toBeNull();
      expect(launch).toBeNull();
      expect(startSidecar).not.toHaveBeenCalled();
    },
  );
});
