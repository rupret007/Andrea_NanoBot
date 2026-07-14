import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  applyLifeThreadCommitmentTransition,
  createLifeThreadWithInitialCommitment,
  getLifeThread,
  getRouterState,
  isDatabaseInitialized,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  mergeLifeThreadsAtomically,
  updateLifeThread,
  upsertLifeThreadSignal,
} from './db.js';
import {
  buildStructuredLifeThreadCommitmentTransition,
  compareLifeThreadCommitmentPriority,
  describeLifeThreadCommitment,
  getLifeThreadCommitment,
  interpretLifeThreadCommitment,
  shouldProactivelySurfaceCommitment,
} from './life-thread-commitment.js';
import {
  buildLifeThreadSnapshot,
  completeLifeThreadCommitment,
  deferLifeThreadCommitment,
  handleLifeThreadCommand,
  reactivateLifeThreadCommitment,
  scheduleLifeThreadCommitment,
  syncLifeThreadFromReminderTask,
} from './life-threads.js';
import type { LifeThread } from './types.js';

const NOW = new Date('2026-07-14T09:00:00-05:00');

function command(
  text: string,
  at = NOW,
  prior?: LifeThread,
  chatJid = `synthetic:${text.slice(0, 24)}`,
) {
  return handleLifeThreadCommand({
    groupFolder: 'commitment',
    channel: 'telegram',
    chatJid,
    messageId: `synthetic-message:${text}`,
    text,
    priorContext: prior
      ? {
          summaryText: prior.summary,
          usedThreadIds: [prior.id],
          usedThreadTitles: [prior.title],
          usedThreadReasons: ['explicit test context'],
          threadSummaryLines: [`${prior.title}: ${prior.summary}`],
        }
      : null,
    now: at,
  });
}

function saved(text: string, at = NOW): LifeThread {
  const result = command(text, at);
  expect(result.handled).toBe(true);
  expect(result.referencedThread).toBeTruthy();
  return getLifeThread(result.referencedThread!.id)!;
}

describe('life-thread commitment intelligence', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => {
    if (isDatabaseInitialized()) _closeDatabase();
  });

  it.each([
    ['I might call Brian tomorrow.', 'speculative', 'proposed', false],
    ['I am planning to call Brian tomorrow.', 'tentative', 'proposed', false],
    ['I need to call Brian tomorrow.', 'intended', 'active', true],
    ["I'll call Brian tomorrow.", 'committed', 'active', true],
    [
      'Remind me to call Brian tomorrow.',
      'explicitly_requested',
      'active',
      true,
    ],
  ] as const)(
    'classifies %s',
    (text, strength, operationalState, hasAction) => {
      const thread = saved(text);
      const state = getLifeThreadCommitment(thread);
      expect(state.strength).toBe(strength);
      expect(state.operationalState).toBe(operationalState);
      expect(Boolean(state.currentAction)).toBe(hasAction);
      expect(shouldProactivelySurfaceCommitment(thread, NOW)).toBe(
        strength === 'intended' || strength === 'committed',
      );
    },
  );

  it('moves a completed outgoing action into waiting without repeating it', () => {
    const thread = saved('I need to send Brandon the estimate.');
    command(
      'I sent Brandon the estimate and I am waiting for his response.',
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    const updated = getLifeThread(thread.id)!;
    const state = getLifeThreadCommitment(updated);
    expect(state.operationalState).toBe('waiting');
    expect(state.owner.displayNames).toEqual(['Brandon']);
    expect(state.currentAction).toBeNull();
    expect(updated.nextAction).toBeNull();
    expect(shouldProactivelySurfaceCommitment(updated, NOW)).toBe(false);

    command('Brandon replied.', new Date(NOW.getTime() + 2_000), updated);
    const resolved = getLifeThread(thread.id)!;
    expect(getLifeThreadCommitment(resolved).operationalState).toBe(
      'completed',
    );
    expect(getLifeThreadCommitment(resolved).currentAction).toBeNull();
    expect(getLifeThreadCommitment(resolved).downstreamAction).toBeNull();
    expect(resolved.nextAction).toBeNull();
  });

  it('reactivates only an explicit distinct downstream action after waiting', () => {
    const thread = saved('I need to send Brandon the estimate.');
    command(
      'I sent Brandon the estimate and I am waiting for his response. Once he replies, I need to review the approved estimate.',
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    let state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state.downstreamAction).toBe('Review the approved estimate');
    expect(state.downstreamAction).not.toContain('send Brandon');

    command(
      'Brandon replied.',
      new Date(NOW.getTime() + 2_000),
      getLifeThread(thread.id)!,
    );
    state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state.operationalState).toBe('active');
    expect(state.currentAction).toBe('Review the approved estimate');
  });

  it('keeps conditional follow-up timing separate from the sent date', () => {
    const thread = saved('I need to email Brandon the estimate.');
    command(
      "I emailed Brandon today. If I don't hear back by Friday, I need to follow up.",
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    const state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state.operationalState).toBe('waiting');
    expect(state.followUp?.dueAt).toBe('2026-07-17T22:00:00.000Z');
    expect(state.followUp?.dependencyIds).toEqual(
      state.dependencies.map((dependency) => dependency.id),
    );
  });

  it('adds a worded business-day follow-up without falsely resolving the wait', () => {
    const thread = saved('I need to email Brandon the estimate.');
    command(
      'I sent Brandon the estimate and I am waiting for his response.',
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    command(
      "If they haven't replied in five business days, ping me.",
      new Date(NOW.getTime() + 2_000),
      getLifeThread(thread.id)!,
    );
    const state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state.operationalState).toBe('waiting');
    expect(
      state.dependencies.every((dependency) => !dependency.satisfied),
    ).toBe(true);
    expect(state.followUp?.dueAt).toBe('2026-07-21T14:00:00.000Z');
  });

  it('preserves a blocker and reactivates only after matching evidence', () => {
    const blocked = saved('I need the VIN before I can get the quote.');
    let state = getLifeThreadCommitment(blocked);
    expect(state.operationalState).toBe('blocked');
    expect(state.downstreamAction).toBe('get the quote');
    expect(state.currentAction).toBeNull();

    command('I got the VIN.', new Date(NOW.getTime() + 1_000), blocked);
    state = getLifeThreadCommitment(getLifeThread(blocked.id)!);
    expect(state.operationalState).toBe('active');
    expect(state.currentAction).toBe('get the quote');
    expect(state.dependencies.every((dependency) => dependency.satisfied)).toBe(
      true,
    );
  });

  it('transfers ownership on delegation and returns it only on explicit takeback', () => {
    const delegated = saved('Brandon is taking care of Farmers today.');
    let state = getLifeThreadCommitment(delegated);
    expect(state.operationalState).toBe('delegated');
    expect(state.owner.displayNames).toEqual(['Brandon']);
    expect(state.owner.displayNames).not.toContain('Farmers');
    expect(getLifeThread(delegated.id)?.status).toBe('active');

    command(
      "Actually, I'll handle it myself.",
      new Date(NOW.getTime() + 1_000),
      delegated,
    );
    state = getLifeThreadCommitment(getLifeThread(delegated.id)!);
    expect(state.operationalState).toBe('active');
    expect(state.owner.kind).toBe('self');
  });

  it('recognizes lowercase delegated owners without assigning the object noun', () => {
    const delegated = saved('i asked ujjwal to cover Wintrust.');
    const state = getLifeThreadCommitment(delegated);
    expect(state.operationalState).toBe('delegated');
    expect(state.owner.displayNames).toEqual(['Ujjwal']);
    expect(state.owner.displayNames).not.toContain('Wintrust');
  });

  it('defers without cancelling and matures at the saved local time', () => {
    const thread = saved("I'll review the insurance options.");
    command('Revisit this in August.', new Date(NOW.getTime() + 1_000), thread);
    let updated = getLifeThread(thread.id)!;
    expect(updated.status).toBe('paused');
    expect(getLifeThreadCommitment(updated).reactivateAt).toBe(
      '2026-08-01T14:00:00.000Z',
    );
    expect(
      buildLifeThreadSnapshot({
        groupFolder: 'commitment',
        now: new Date('2026-07-31T23:00:00-05:00'),
      }).activeThreads,
    ).toHaveLength(0);
    buildLifeThreadSnapshot({
      groupFolder: 'commitment',
      now: new Date('2026-08-01T09:01:00-05:00'),
    });
    updated = getLifeThread(thread.id)!;
    expect(updated.status).toBe('active');
    expect(getLifeThreadCommitment(updated).operationalState).toBe('active');
  });

  it('strengthens and weakens without retaining contradictory state', () => {
    const thread = saved('I might finish the deck Friday.');
    command(
      "Actually, yes, I'm going to do it.",
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    let state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state.strength).toBe('committed');
    expect(state.operationalState).toBe('active');

    command(
      "That was only an idea. Don't treat that as a task.",
      new Date(NOW.getTime() + 2_000),
      getLifeThread(thread.id)!,
    );
    state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state.strength).toBe('speculative');
    expect(state.operationalState).toBe('proposed');
    expect(state.dependencies).toEqual([]);
    expect(state.currentAction).toBeNull();
  });

  it('does not accept negated completion and suppresses real terminal states', () => {
    const thread = saved("I'll finish the permit application.");
    const negated = command(
      "It isn't done.",
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    expect(negated.handled).toBe(false);
    expect(
      getLifeThreadCommitment(getLifeThread(thread.id)!).operationalState,
    ).toBe('active');

    command(
      'I finished the permit application.',
      new Date(NOW.getTime() + 2_000),
      thread,
    );
    const completed = getLifeThread(thread.id)!;
    expect(getLifeThreadCommitment(completed).operationalState).toBe(
      'completed',
    );
    expect(completed.status).toBe('closed');
    expect(shouldProactivelySurfaceCommitment(completed, NOW)).toBe(false);
  });

  it('resolves all dependencies one at a time and any dependency immediately', () => {
    const initial = interpretLifeThreadCommitment({
      threadId: 'multi',
      title: 'Numbers',
      text: 'I need to finish the deck.',
      now: NOW,
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'initial',
    })!;
    const blocked = interpretLifeThreadCommitment({
      threadId: 'multi',
      title: 'Numbers',
      text: "I can't finish until Luke and Tracey respond.",
      now: new Date(NOW.getTime() + 1_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'blocked',
      current: initial.state,
    })!;
    expect(blocked.state.dependencies).toHaveLength(2);
    const luke = interpretLifeThreadCommitment({
      threadId: 'multi',
      title: 'Numbers',
      text: 'Luke replied.',
      now: new Date(NOW.getTime() + 2_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'luke',
      current: blocked.state,
    })!;
    expect(luke.kind).toBe('dependency_updated');
    expect(luke.state.operationalState).toBe('blocked');
    expect(
      luke.state.dependencies.filter((item) => item.satisfied),
    ).toHaveLength(1);
    const tracey = interpretLifeThreadCommitment({
      threadId: 'multi',
      title: 'Numbers',
      text: 'Tracey replied.',
      now: new Date(NOW.getTime() + 3_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'tracey',
      current: luke.state,
    })!;
    expect(tracey.state.operationalState).toBe('active');
  });

  it('rejects ambiguous mutation and deterministically ranks actionability first', () => {
    const first = saved("I'll finish the first proposal.");
    const second = saved("I'll finish the second proposal.");
    const ambiguous = command(
      'I finished the proposal.',
      new Date(NOW.getTime() + 1_000),
      undefined,
      'synthetic:ambiguous',
    );
    expect(ambiguous.handled).toBe(true);
    expect(ambiguous.responseText).toContain('more than one open commitment');
    expect(getLifeThread(first.id)?.status).toBe('active');
    expect(getLifeThread(second.id)?.status).toBe('active');

    const idea = saved('I might reorganize the archive someday.');
    const ordered = [idea, first].sort((left, right) =>
      compareLifeThreadCommitmentPriority(left, right, NOW),
    );
    expect(ordered[0]?.id).toBe(first.id);
  });

  it('uses only coarse explicit importance evidence after actionability', () => {
    const normal = saved('I need to review the routine notes.');
    const important = saved(
      'This is high priority: I need to review the incident notes.',
    );
    const critical = saved(
      'This is critical: I need to review the security report.',
    );
    expect(getLifeThreadCommitment(normal).importance).toBe('normal');
    expect(getLifeThreadCommitment(important).importance).toBe('important');
    expect(getLifeThreadCommitment(critical).importance).toBe('critical');
    expect(
      [normal, important, critical]
        .sort((left, right) =>
          compareLifeThreadCommitmentPriority(left, right, NOW),
        )
        .map((thread) => thread.id),
    ).toEqual([critical.id, important.id, normal.id]);

    const blocked = saved(
      'This is critical: I cannot finish the permit until the report arrives.',
    );
    expect(
      [blocked, normal].sort((left, right) =>
        compareLifeThreadCommitmentPriority(left, right, NOW),
      )[0]?.id,
    ).toBe(normal.id);
  });

  it('keeps similar obligations involving the same person as distinct identities', () => {
    const file = saved('I need to send Brandon the file.');
    const estimate = saved('I need to send Brandon the estimate.');
    expect(estimate.id).not.toBe(file.id);
    const matchingTitles = listLifeThreadsForGroup('commitment').filter(
      (thread) => thread.title === file.title,
    );
    expect(matchingTitles.map((thread) => thread.id).sort()).toEqual(
      [file.id, estimate.id].sort(),
    );
  });

  it('preserves manual-only and future snooze controls across transitions', () => {
    const manual = saved('I might review the insurance packet Friday.');
    updateLifeThread(manual.id, {
      surfaceMode: 'manual_only',
      followthroughMode: 'manual_only',
      snoozedUntil: '2026-07-20T14:00:00.000Z',
    });
    command(
      "Actually, yes, I'm going to do it.",
      new Date(NOW.getTime() + 1_000),
      getLifeThread(manual.id)!,
    );
    const updated = getLifeThread(manual.id)!;
    expect(updated.surfaceMode).toBe('manual_only');
    expect(updated.followthroughMode).toBe('manual_only');
    expect(updated.snoozedUntil).toBe('2026-07-20T14:00:00.000Z');
    expect(shouldProactivelySurfaceCommitment(updated, NOW)).toBe(false);
  });

  it('keeps terminal cancellation closed under structured workflow helpers', () => {
    const thread = saved("I'll submit the application Friday.");
    command(
      'Never mind, I am not doing that.',
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    const cancelled = getLifeThread(thread.id)!;
    const revision = getLifeThreadCommitment(cancelled).revision;
    expect(
      reactivateLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: 'commitment',
        now: NOW,
      }),
    ).toBeNull();
    expect(
      deferLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: 'commitment',
        until: '2026-08-01T14:00:00.000Z',
        now: NOW,
      })?.id,
    ).toBe(thread.id);
    expect(
      scheduleLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: 'commitment',
        dueAt: '2026-08-01T14:00:00.000Z',
        now: NOW,
      })?.id,
    ).toBe(thread.id);
    expect(
      completeLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: 'commitment',
        now: NOW,
      })?.id,
    ).toBe(thread.id);
    const recovered = getLifeThread(thread.id)!;
    expect(getLifeThreadCommitment(recovered).operationalState).toBe(
      'cancelled',
    );
    expect(getLifeThreadCommitment(recovered).revision).toBe(revision);
  });

  it('keeps stale stable-source reminder replay from overwriting current metadata', () => {
    const original = syncLifeThreadFromReminderTask({
      taskId: 'stable-reminder',
      groupFolder: 'commitment',
      prompt: 'send the old estimate',
      now: NOW,
    });
    syncLifeThreadFromReminderTask({
      taskId: 'stable-reminder',
      groupFolder: 'commitment',
      prompt: 'send the corrected estimate',
      now: new Date(NOW.getTime() + 2_000),
    });
    syncLifeThreadFromReminderTask({
      taskId: 'stable-reminder',
      groupFolder: 'commitment',
      prompt: 'send the old estimate',
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(getLifeThread(original.id)?.summary).toBe(
      'Remind me to send the corrected estimate',
    );
    expect(listLifeThreadsForGroup('commitment')).toHaveLength(1);
  });

  it('keeps one reminder commitment across repeated sync and restart', () => {
    _closeDatabase();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-reminder-identity-'),
    );
    const databasePath = path.join(directory, 'messages.db');
    try {
      _initTestDatabaseAtPath(databasePath);
      const first = syncLifeThreadFromReminderTask({
        taskId: 'durable-reminder',
        groupFolder: 'commitment',
        prompt: 'send the estimate',
        now: NOW,
      });
      syncLifeThreadFromReminderTask({
        taskId: 'durable-reminder',
        groupFolder: 'commitment',
        prompt: 'send the corrected estimate',
        now: new Date(NOW.getTime() + 1_000),
      });
      syncLifeThreadFromReminderTask({
        taskId: 'durable-reminder',
        groupFolder: 'commitment',
        prompt: 'send the corrected estimate',
        now: new Date(NOW.getTime() + 2_000),
      });
      _closeDatabase();
      _initTestDatabaseAtPath(databasePath);
      const replayed = syncLifeThreadFromReminderTask({
        taskId: 'durable-reminder',
        groupFolder: 'commitment',
        prompt: 'send the corrected estimate',
        now: new Date(NOW.getTime() + 3_000),
      });
      expect(replayed.id).toBe(first.id);
      expect(listLifeThreadsForGroup('commitment')).toHaveLength(1);
    } finally {
      if (isDatabaseInitialized()) _closeDatabase();
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${databasePath}${suffix}`, { force: true });
      }
      fs.rmSync(directory, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('describes the topic, unknown ownership, and saved timezone explicitly', () => {
    const thread = saved("I'll submit the permit application.");
    command(
      'I submitted it, so now the ball is in their court.',
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    const waiting = getLifeThread(thread.id)!;
    const description = describeLifeThreadCommitment(
      waiting,
      NOW,
      'America/Chicago',
    );
    expect(description).toContain("I'll submit the permit application");
    expect(description).toContain('the expected response or event');
    expect(description).not.toContain('waiting on you');

    const boundary = saved("I'll revisit the boundary item.");
    const deferredBoundary = deferLifeThreadCommitment({
      threadId: boundary.id,
      groupFolder: 'commitment',
      until: '2026-07-15T00:30:00.000Z',
      now: NOW,
    })!;
    const boundaryDescription = describeLifeThreadCommitment(
      deferredBoundary,
      NOW,
      'America/Chicago',
    );
    expect(boundaryDescription).toContain('Jul 14, 2026');
    expect(boundaryDescription).not.toContain('Jul 15, 2026');
  });

  it('deduplicates replay and retains stale evidence without regressing truth', () => {
    const thread = saved("I'll submit the report Friday.");
    const initial = getLifeThreadCommitment(thread);
    const older = buildStructuredLifeThreadCommitmentTransition({
      thread,
      text: 'Older evidence says this is tentative.',
      now: new Date(NOW.getTime() + 1_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'event:older',
      kind: 'weakened',
      reason: 'Synthetic stale evidence.',
      patch: {
        strength: 'tentative',
        operationalState: 'proposed',
        readiness: 'non_actionable',
        currentAction: null,
      },
    });
    const newer = buildStructuredLifeThreadCommitmentTransition({
      thread,
      text: 'The report is definitely committed.',
      now: new Date(NOW.getTime() + 2_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'event:newer',
      kind: 'strengthened',
      reason: 'Synthetic newer evidence.',
      patch: { strength: 'committed' },
    });
    const apply = (interpretation: typeof newer) =>
      applyLifeThreadCommitmentTransition({
        threadId: thread.id,
        groupFolder: thread.groupFolder,
        state: interpretation.state,
        transition: interpretation.transition,
        signal: {
          id: interpretation.eventId,
          threadId: thread.id,
          groupFolder: thread.groupFolder,
          sourceKind: 'explicit',
          summaryText: interpretation.reason,
          confidenceKind: 'explicit',
          commitmentTransition: interpretation.transition,
          createdAt: interpretation.state.updatedAt,
        },
      });
    expect(apply(newer)).toBe('applied');
    expect(apply(newer)).toBe('duplicate');
    expect(apply(older)).toBe('stale');
    expect(getLifeThreadCommitment(getLifeThread(thread.id)!).strength).toBe(
      'committed',
    );
    expect(
      listLifeThreadSignals(thread.id, 20).find(
        (signal) => signal.id === older.eventId,
      )?.commitmentTransition?.disposition,
    ).toBe('stale');
    expect(initial.revision).toBe(1);
  });

  it('protects immutable transition signals from ordinary overwrite', () => {
    const thread = saved("I'll call the contractor.");
    const origin = listLifeThreadSignals(thread.id, 5)[0]!;
    expect(origin.commitmentTransition).toBeTruthy();
    expect(() =>
      upsertLifeThreadSignal({
        ...origin,
        summaryText: 'attempted overwrite',
        commitmentTransition: null,
      }),
    ).toThrow('cannot overwrite immutable commitment provenance');
    expect(listLifeThreadSignals(thread.id, 5)[0]?.summaryText).not.toBe(
      'attempted overwrite',
    );
  });

  it('rolls back every merge mutation when terminal provenance cannot append', () => {
    const from = saved("I'll prepare the merge source.");
    const to = saved("I'll prepare the merge target.");
    const supersession = buildStructuredLifeThreadCommitmentTransition({
      thread: from,
      text: 'Merge source into target.',
      now: new Date(NOW.getTime() + 1_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'merge-collision',
      kind: 'superseded',
      reason: 'The user merged this commitment into the target.',
      patch: {
        operationalState: 'superseded',
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
    upsertLifeThreadSignal({
      id: supersession.eventId,
      threadId: from.id,
      groupFolder: 'commitment',
      sourceKind: 'explicit',
      summaryText: 'ordinary context that must roll back',
      confidenceKind: 'explicit',
      createdAt: NOW.toISOString(),
    });
    expect(() =>
      mergeLifeThreadsAtomically({
        fromThreadId: from.id,
        toThreadId: to.id,
        groupFolder: 'commitment',
        state: supersession.state,
        transition: supersession.transition,
        summary: 'Merge source into target.',
        now: supersession.state.updatedAt,
        signal: {
          id: supersession.eventId,
          threadId: from.id,
          groupFolder: 'commitment',
          sourceKind: 'explicit',
          summaryText: 'Merge source into target.',
          confidenceKind: 'explicit',
          commitmentTransition: supersession.transition,
          createdAt: supersession.state.updatedAt,
        },
      }),
    ).toThrow('identity conflicts');
    expect(
      listLifeThreadSignals(from.id, 20).some(
        (signal) => signal.id === supersession.eventId,
      ),
    ).toBe(true);
    expect(getLifeThread(from.id)).toMatchObject({
      mergedIntoThreadId: null,
      status: 'active',
    });

    const foreign = handleLifeThreadCommand({
      groupFolder: 'other',
      channel: 'telegram',
      chatJid: 'other-chat',
      messageId: 'foreign-thread-origin',
      text: "I'll prepare the foreign target.",
      now: NOW,
    }).referencedThread!;
    const crossGroup = buildStructuredLifeThreadCommitmentTransition({
      thread: from,
      text: 'Merge into the foreign target.',
      now: new Date(NOW.getTime() + 2_000),
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'cross-group-merge',
      kind: 'superseded',
      reason: 'Attempted cross-group merge.',
      patch: supersession.transition.afterState!,
    });
    expect(
      mergeLifeThreadsAtomically({
        fromThreadId: from.id,
        toThreadId: foreign.id,
        groupFolder: 'commitment',
        state: crossGroup.state,
        transition: crossGroup.transition,
        summary: 'Merge into the foreign target.',
        now: crossGroup.state.updatedAt,
        signal: {
          id: crossGroup.eventId,
          threadId: from.id,
          groupFolder: 'commitment',
          sourceKind: 'explicit',
          summaryText: 'Merge into the foreign target.',
          confidenceKind: 'explicit',
          commitmentTransition: crossGroup.transition,
          createdAt: crossGroup.state.updatedAt,
        },
      }),
    ).toBe('missing');
    expect(getLifeThread(from.id)?.mergedIntoThreadId).toBeNull();
  });

  it('rolls back an invalid initial origin before any thread is written', () => {
    const interpretation = interpretLifeThreadCommitment({
      threadId: 'atomic-origin',
      title: 'Atomic Origin',
      text: "I'll finish the atomic test.",
      now: NOW,
      timeZone: 'America/Chicago',
      sourceKind: 'explicit',
      sourceRef: 'atomic-origin',
    })!;
    const thread: LifeThread & {
      commitment: NonNullable<LifeThread['commitment']>;
    } = {
      id: 'atomic-origin',
      groupFolder: 'commitment',
      title: 'Atomic Origin',
      category: 'personal',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: [],
      contextTags: [],
      summary: "I'll finish the atomic test.",
      nextAction: null,
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      commitment: interpretation.state,
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
      mergedIntoThreadId: null,
      createdAt: NOW.toISOString(),
      lastUpdatedAt: NOW.toISOString(),
      lastUsedAt: NOW.toISOString(),
    };
    expect(() =>
      createLifeThreadWithInitialCommitment({
        thread,
        signal: {
          id: 'wrong-origin-id',
          threadId: thread.id,
          groupFolder: thread.groupFolder,
          sourceKind: 'explicit',
          summaryText: thread.summary,
          confidenceKind: 'explicit',
          commitmentTransition: interpretation.transition,
          createdAt: NOW.toISOString(),
        },
      }),
    ).toThrow('provenance does not match');
    expect(getLifeThread(thread.id)).toBeUndefined();
    expect(listLifeThreadSignals(thread.id, 5)).toEqual([]);
  });

  it('backfills only the released sentinel and fails closed on unknown canonical bytes', () => {
    _closeDatabase();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-commitment-migration-'),
    );
    const databasePath = path.join(directory, 'messages.db');
    const legacy = new Database(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE life_threads (
          id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, title TEXT NOT NULL,
          category TEXT NOT NULL, status TEXT NOT NULL, scope TEXT NOT NULL,
          related_subject_ids_json TEXT NOT NULL, context_tags_json TEXT NOT NULL,
          summary TEXT NOT NULL, next_action TEXT, next_followup_at TEXT,
          source_kind TEXT NOT NULL, confidence_kind TEXT NOT NULL,
          user_confirmed INTEGER NOT NULL DEFAULT 0,
          sensitivity TEXT NOT NULL DEFAULT 'normal',
          surface_mode TEXT NOT NULL DEFAULT 'default',
          followthrough_mode TEXT NOT NULL DEFAULT 'important_only',
          last_surfaced_at TEXT, snoozed_until TEXT, linked_task_id TEXT,
          commitment_state_json TEXT NOT NULL DEFAULT '{}',
          merged_into_thread_id TEXT, created_at TEXT NOT NULL,
          last_updated_at TEXT NOT NULL, last_used_at TEXT
        );
        CREATE TABLE life_thread_signals (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, group_folder TEXT NOT NULL,
          source_kind TEXT NOT NULL, summary_text TEXT NOT NULL, chat_jid TEXT,
          message_id TEXT, task_id TEXT, calendar_event_id TEXT,
          profile_fact_id TEXT, confidence_kind TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      const insert = legacy.prepare(`
        INSERT INTO life_threads (
          id, group_folder, title, category, status, scope,
          related_subject_ids_json, context_tags_json, summary, next_action,
          next_followup_at, source_kind, confidence_kind, user_confirmed,
          sensitivity, surface_mode, followthrough_mode, commitment_state_json,
          created_at, last_updated_at
        ) VALUES (?, 'commitment', ?, 'personal', ?, 'personal', '[]', '[]', ?, ?, ?, ?, 'explicit', 1, 'normal', 'default', 'important_only', ?, ?, ?)
      `);
      insert.run(
        'legacy-paused',
        'Legacy Paused api key=legacy-title-secret',
        'paused',
        'Review later password=legacy-summary-secret',
        'Review later with BSA-legacy-action-secret',
        '2026-08-01T14:00:00.000Z',
        'explicit',
        '{}',
        NOW.toISOString(),
        NOW.toISOString(),
      );
      insert.run(
        'legacy-malformed',
        'Legacy Malformed',
        'active',
        'Context only',
        null,
        null,
        'inferred',
        '{}',
        NOW.toISOString(),
        NOW.toISOString(),
      );
      insert.run(
        'legacy-cancelled',
        'Legacy Cancelled',
        'closed',
        'Cancelled context',
        null,
        null,
        'explicit',
        '{}',
        NOW.toISOString(),
        NOW.toISOString(),
      );
      legacy
        .prepare(
          `INSERT INTO life_thread_signals (
             id, thread_id, group_folder, source_kind, summary_text,
             confidence_kind, created_at
           ) VALUES (?, ?, 'commitment', 'explicit', ?, 'explicit', ?)`,
        )
        .run(
          'legacy-cancelled-signal',
          'legacy-cancelled',
          'cancelled: never mind',
          NOW.toISOString(),
        );
    } finally {
      legacy.close();
    }
    try {
      _initTestDatabaseAtPath(databasePath);
      const paused = getLifeThread('legacy-paused')!;
      const malformed = getLifeThread('legacy-malformed')!;
      expect(paused.title).toBe('Legacy Paused api key=[redacted-secret]');
      expect(paused.summary).toBe('Review later password=[redacted-secret]');
      expect(paused.nextAction).toContain('[redacted-secret]');
      expect(JSON.stringify(paused)).not.toContain('legacy-title-secret');
      expect(JSON.stringify(paused)).not.toContain('legacy-summary-secret');
      expect(JSON.stringify(paused)).not.toContain('legacy-action-secret');
      expect(getLifeThreadCommitment(paused).operationalState).toBe('deferred');
      expect(paused.status).toBe('paused');
      expect(getLifeThreadCommitment(malformed).operationalState).toBe(
        'proposed',
      );
      expect(getLifeThreadCommitment(malformed).currentAction).toBeNull();
      expect(
        getLifeThreadCommitment(getLifeThread('legacy-cancelled')!)
          .operationalState,
      ).toBe('cancelled');
      _closeDatabase();
      const migratedDatabase = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      const migratedCompatibility = migratedDatabase
        .prepare(
          `SELECT title, summary, next_action FROM life_threads WHERE id = 'legacy-paused'`,
        )
        .get() as {
        title: string;
        summary: string;
        next_action: string | null;
      };
      migratedDatabase.close();
      expect(migratedCompatibility).toEqual({
        title: 'Legacy Paused api key=[redacted-secret]',
        summary: 'Review later password=[redacted-secret]',
        next_action: 'Review later with [redacted-secret]',
      });
      _initTestDatabaseAtPath(databasePath);
      const reopenedPaused = getLifeThread('legacy-paused')!;
      expect(reopenedPaused.commitment?.version).toBe(1);
      expect(reopenedPaused.title).toBe(migratedCompatibility.title);
      expect(reopenedPaused.summary).toBe(migratedCompatibility.summary);
      expect(reopenedPaused.nextAction).toBe(migratedCompatibility.next_action);
      _closeDatabase();

      const restoredDatabase = new Database(databasePath);
      restoredDatabase
        .prepare(
          `UPDATE life_threads
           SET title = ?, summary = ?, next_action = ?
           WHERE id = 'legacy-paused'`,
        )
        .run(
          'Restored api key=restored-title-secret',
          'Restored password=restored-summary-secret',
          'Restored with BSA-restored-action-secret',
        );
      restoredDatabase.close();
      _initTestDatabaseAtPath(databasePath);
      const restoredPaused = getLifeThread('legacy-paused')!;
      expect(restoredPaused.title).toBe('Restored api key=[redacted-secret]');
      expect(restoredPaused.summary).toBe(
        'Restored password=[redacted-secret]',
      );
      expect(restoredPaused.nextAction).toBe('Restored with [redacted-secret]');
      expect(JSON.stringify(restoredPaused)).not.toContain(
        'restored-title-secret',
      );
      expect(JSON.stringify(restoredPaused)).not.toContain(
        'restored-summary-secret',
      );
      expect(JSON.stringify(restoredPaused)).not.toContain(
        'restored-action-secret',
      );
      _closeDatabase();

      const malformedJson = '{"version":1,"bad":true}';
      const malformedDatabase = new Database(databasePath);
      malformedDatabase
        .prepare(
          `UPDATE life_threads SET commitment_state_json = ? WHERE id = 'legacy-malformed'`,
        )
        .run(malformedJson);
      malformedDatabase.close();
      expect(() => _initTestDatabaseAtPath(databasePath)).toThrow(
        'unsupported canonical commitment state',
      );
      _closeDatabase();
      const verifyMalformed = new Database(databasePath);
      expect(
        (
          verifyMalformed
            .prepare(
              `SELECT commitment_state_json FROM life_threads WHERE id = 'legacy-malformed'`,
            )
            .get() as { commitment_state_json: string }
        ).commitment_state_json,
      ).toBe(malformedJson);
      const futureJson = '{"version":2,"revision":99}';
      verifyMalformed
        .prepare(
          `UPDATE life_threads SET commitment_state_json = ? WHERE id = 'legacy-malformed'`,
        )
        .run(futureJson);
      verifyMalformed.close();
      expect(() => _initTestDatabaseAtPath(databasePath)).toThrow(
        'unsupported canonical commitment state',
      );
      _closeDatabase();
      const verifyFuture = new Database(databasePath);
      expect(
        (
          verifyFuture
            .prepare(
              `SELECT commitment_state_json FROM life_threads WHERE id = 'legacy-malformed'`,
            )
            .get() as { commitment_state_json: string }
        ).commitment_state_json,
      ).toBe(futureJson);
      verifyFuture.close();
    } finally {
      if (isDatabaseInitialized()) _closeDatabase();
      fs.rmSync(directory, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('survives two durable close/reopen cycles with canonical provenance', () => {
    _closeDatabase();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-commitment-test-'),
    );
    const databasePath = path.join(directory, 'messages.db');
    try {
      _initTestDatabaseAtPath(databasePath);
      const thread = saved("I'll submit the license application Friday.");
      command(
        "I submitted it and I'm waiting for the permit office to respond. Once it responds, I need to review the approval.",
        new Date(NOW.getTime() + 1_000),
        thread,
      );
      updateLifeThread(thread.id, {
        surfaceMode: 'manual_only',
        followthroughMode: 'manual_only',
      });
      const cancelled = saved("I'll archive the obsolete notes.");
      command(
        'Never mind, cancel the obsolete notes.',
        new Date(NOW.getTime() + 1_500),
        cancelled,
      );
      const disabled = saved('I might inspect the disabled archive.');
      updateLifeThread(disabled.id, { followthroughMode: 'off' });
      command(
        "Actually, yes, I'm going to do it.",
        new Date(NOW.getTime() + 1_750),
        disabled,
      );
      _closeDatabase();
      _initTestDatabaseAtPath(databasePath);
      expect(
        getLifeThreadCommitment(getLifeThread(thread.id)!).operationalState,
      ).toBe('waiting');
      expect(getLifeThread(thread.id)).toMatchObject({
        surfaceMode: 'manual_only',
        followthroughMode: 'manual_only',
      });
      expect(
        getLifeThreadCommitment(getLifeThread(cancelled.id)!).operationalState,
      ).toBe('cancelled');
      expect(getLifeThread(disabled.id)?.followthroughMode).toBe('off');
      command(
        'The permit office responded.',
        new Date(NOW.getTime() + 2_000),
        getLifeThread(thread.id)!,
      );
      _closeDatabase();
      _initTestDatabaseAtPath(databasePath);
      const recovered = getLifeThread(thread.id)!;
      expect(getLifeThreadCommitment(recovered).operationalState).toBe(
        'active',
      );
      expect(recovered).toMatchObject({
        surfaceMode: 'manual_only',
        followthroughMode: 'manual_only',
      });
      expect(getLifeThread(disabled.id)?.followthroughMode).toBe('off');
      expect(
        listLifeThreadSignals(thread.id, 20).filter(
          (signal) => signal.commitmentTransition,
        ).length,
      ).toBe(3);
    } finally {
      if (isDatabaseInitialized()) _closeDatabase();
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${databasePath}${suffix}`, { force: true });
      }
      fs.rmSync(directory, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('restores the exact pre-deferral state and preserves explicit operator controls', () => {
    const thread = saved("I'll review the permit approval.");
    command(
      'I submitted it and I am waiting for the permit office to respond.',
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    updateLifeThread(thread.id, { followthroughMode: 'off' });
    const waiting = getLifeThread(thread.id)!;
    expect(getLifeThreadCommitment(waiting).operationalState).toBe('waiting');
    command(
      'Defer this until August.',
      new Date(NOW.getTime() + 2_000),
      waiting,
    );
    let state = getLifeThreadCommitment(getLifeThread(thread.id)!);
    expect(state).toMatchObject({
      operationalState: 'deferred',
      deferredFrom: 'waiting',
    });
    command(
      'Resume this.',
      new Date(NOW.getTime() + 3_000),
      getLifeThread(thread.id)!,
    );
    const resumed = getLifeThread(thread.id)!;
    state = getLifeThreadCommitment(resumed);
    expect(state.operationalState).toBe('waiting');
    expect(state.currentAction).toBeNull();
    expect(state.dependencies).toHaveLength(1);
    expect(resumed.followthroughMode).toBe('off');
    expect(shouldProactivelySurfaceCommitment(resumed, NOW)).toBe(false);
    expect(
      buildLifeThreadSnapshot({
        groupFolder: 'commitment',
        now: new Date(NOW.getTime() + 4_000),
      }).activeThreads.some((candidate) => candidate.id === resumed.id),
    ).toBe(false);
  });

  it('gives imperative cancellation terminal precedence with a negation guard', () => {
    const thread = saved("I'll file the permit.");
    command(
      "Don't treat that as a task; cancel it.",
      new Date(NOW.getTime() + 1_000),
      thread,
    );
    expect(
      getLifeThreadCommitment(getLifeThread(thread.id)!).operationalState,
    ).toBe('cancelled');

    const guarded = saved("I'll review the audit.");
    command("Don't cancel it.", new Date(NOW.getTime() + 2_000), guarded);
    expect(
      getLifeThreadCommitment(getLifeThread(guarded.id)!).operationalState,
    ).toBe('active');
  });

  it('uses stable source occurrence identity without copying secrets into canonical memory', () => {
    const text =
      'I need to rotate password=private-token-12345 for the billing portal.';
    const first = handleLifeThreadCommand({
      groupFolder: 'commitment',
      channel: 'telegram',
      chatJid: 'telegram:private-user-jid',
      messageId: 'message-one',
      text,
      now: NOW,
    });
    const thread = getLifeThread(first.referencedThread!.id)!;
    const canonical = JSON.stringify(getLifeThreadCommitment(thread));
    expect(canonical).not.toContain('private-token-12345');
    expect(canonical).not.toContain('private-user-jid');
    expect(canonical).toContain('[redacted-secret]');
    expect(getLifeThreadCommitment(thread).evidence).toHaveLength(1);
    expect(getLifeThreadCommitment(thread).evidence[0]?.reasonKinds).toEqual(
      expect.arrayContaining(['direct_language', 'state_transition']),
    );
    const provenance = listLifeThreadSignals(thread.id, 10)[0]!;
    expect(provenance.summaryText).toContain('commitment_transition:active');
    expect(provenance.summaryText).not.toContain('private-token-12345');
    expect(provenance.chatJid).toMatch(/^commitment-chat:[a-f0-9]{64}$/);
    expect(provenance.chatJid).not.toContain('private-user-jid');
    expect(provenance.messageId).toMatch(/^commitment-message:[a-f0-9]{64}$/);

    handleLifeThreadCommand({
      groupFolder: 'commitment',
      channel: 'telegram',
      chatJid: 'telegram:private-user-jid',
      messageId: 'message-one',
      text,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(listLifeThreadSignals(thread.id, 10)).toHaveLength(1);
    handleLifeThreadCommand({
      groupFolder: 'commitment',
      channel: 'telegram',
      chatJid: 'telegram:private-user-jid',
      messageId: 'message-two',
      text,
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(listLifeThreadSignals(thread.id, 10)).toHaveLength(2);
  });

  it('redacts credentials from end-to-end save, detail, and durable life-thread storage', () => {
    _closeDatabase();
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-commitment-redaction-'),
    );
    const databasePath = path.join(directory, 'messages.db');
    const canary = 'PRIVATE-LIFE-THREAD-CANARY';
    try {
      _initTestDatabaseAtPath(databasePath);
      const savedResult = handleLifeThreadCommand({
        groupFolder: 'commitment',
        channel: 'telegram',
        chatJid: 'telegram:private-storage-user',
        messageId: 'private-storage-message',
        text: `I need to rotate the billing portal password=${canary}.`,
        now: NOW,
      });
      expect(savedResult.handled).toBe(true);
      expect(savedResult.responseText).not.toContain(canary);
      expect(savedResult.responseText).toContain('[redacted-secret]');

      const thread = getLifeThread(savedResult.referencedThread!.id)!;
      expect(JSON.stringify(thread)).not.toContain(canary);
      expect(thread.title).toContain('[redacted-secret]');
      expect(thread.summary).toContain('[redacted-secret]');
      expect(thread.nextAction).toContain('[redacted-secret]');
      expect(
        getRouterState(
          'life_thread_last_referenced:telegram:private-storage-user',
        ),
      ).not.toContain(canary);

      const detail = handleLifeThreadCommand({
        groupFolder: 'commitment',
        channel: 'telegram',
        chatJid: 'telegram:private-storage-user',
        messageId: 'private-storage-detail',
        text: "What's in that thread?",
        priorContext: {
          summaryText: thread.summary,
          usedThreadIds: [thread.id],
          usedThreadTitles: [thread.title],
        },
        now: new Date(NOW.getTime() + 1_000),
      });
      expect(detail.responseText).not.toContain(canary);

      const durable = new Database(databasePath, { readonly: true });
      try {
        const row = durable
          .prepare(`SELECT * FROM life_threads WHERE id = ?`)
          .get(thread.id);
        const signals = durable
          .prepare(`SELECT * FROM life_thread_signals WHERE thread_id = ?`)
          .all(thread.id);
        expect(JSON.stringify({ row, signals })).not.toContain(canary);
        expect(JSON.stringify({ row, signals })).toContain('[redacted-secret]');
      } finally {
        durable.close();
      }
    } finally {
      if (isDatabaseInitialized()) _closeDatabase();
      fs.rmSync(directory, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps structured commitment mutations scoped to the owning group', () => {
    const thread = saved("I'll review the scoped record.");
    const revision = getLifeThreadCommitment(thread).revision;
    expect(
      deferLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: 'other',
        until: '2026-08-01T14:00:00.000Z',
        now: NOW,
      }),
    ).toBeNull();
    expect(
      scheduleLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: 'other',
        dueAt: '2026-08-01T14:00:00.000Z',
        now: NOW,
      }),
    ).toBeNull();
    expect(getLifeThreadCommitment(getLifeThread(thread.id)!).revision).toBe(
      revision,
    );
  });

  it('keeps future reminders dormant and restores the exact requested action when due', () => {
    const result = command(
      'Remind me Friday to submit the permit.',
      NOW,
      undefined,
      'synthetic:future-reminder',
    );
    const thread = getLifeThread(result.referencedThread!.id)!;
    const state = getLifeThreadCommitment(thread);
    expect(thread.nextAction).toBeNull();
    expect(state.downstreamAction).toBe('Submit the permit');
    expect(shouldProactivelySurfaceCommitment(thread, NOW)).toBe(false);
    const due = new Date(state.dueAt!);
    expect(
      buildLifeThreadSnapshot({
        groupFolder: 'commitment',
        now: new Date(due.getTime() + 1_000),
      }).activeThreads[0]?.nextAction,
    ).toBe('Submit the permit');
  });

  it('keeps group scope private', () => {
    saved("I'll review the private insurance notes.");
    expect(listLifeThreadsForGroup('other')).toEqual([]);
  });
});
