import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getLifeThread,
  getRitualProfileByType,
  getTaskById,
  listProfileFactsForGroup,
} from './db.js';
import { handleLifeThreadCommand } from './life-threads.js';
import {
  buildDefaultRitualProfile,
  handleRitualCommand,
  listResolvedRitualProfiles,
} from './rituals.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('rituals', () => {
  it('builds conservative default ritual profiles', () => {
    const morning = buildDefaultRitualProfile('main', 'morning_brief');
    const openGuidance = buildDefaultRitualProfile('main', 'open_guidance');
    const profiles = listResolvedRitualProfiles('main');

    expect(morning.enabled).toBe(false);
    expect(morning.triggerStyle).toBe('suggested');
    expect(morning.optInState).toBe('not_set');
    expect(openGuidance.enabled).toBe(true);
    expect(openGuidance.triggerStyle).toBe('on_request');
    expect(openGuidance.optInState).toBe('opted_in');
    expect(profiles.map((profile) => profile.ritualType)).toContain(
      'thread_followthrough',
    );
  });

  it('enables a Telegram morning brief and creates a scheduled task', () => {
    const result = handleRitualCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'enable morning brief',
      now: new Date('2026-04-04T07:00:00.000Z'),
    });

    const profile = getRitualProfileByType('main', 'morning_brief');
    const task = profile?.linkedTaskId
      ? getTaskById(profile.linkedTaskId)
      : null;

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('Telegram');
    expect(profile?.enabled).toBe(true);
    expect(profile?.triggerStyle).toBe('scheduled');
    expect(profile?.optInState).toBe('opted_in');
    expect(profile?.nextDueAt).toBeTruthy();
    expect(task?.prompt).toBe('Good morning');
    expect(task?.schedule_type).toBe('cron');
    expect(task?.status).toBe('active');
  });

  it('can quiet a ritual based on the prior companion mode and pause the linked schedule', () => {
    handleRitualCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'enable morning brief',
      now: new Date('2026-04-04T07:00:00.000Z'),
    });

    const result = handleRitualCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'stop doing that',
      priorCompanionMode: 'morning_brief',
      now: new Date('2026-04-04T07:30:00.000Z'),
    });

    const profile = getRitualProfileByType('main', 'morning_brief');
    const task = profile?.linkedTaskId
      ? getTaskById(profile.linkedTaskId)
      : null;

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('morning brief');
    expect(profile?.enabled).toBe(false);
    expect(profile?.triggerStyle).toBe('on_request');
    expect(profile?.optInState).toBe('opted_out');
    expect(task?.status).toBe('paused');
  });

  it('pins the active thread into the evening reset without creating a second task system', () => {
    const created = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T16:00:00.000Z'),
    }).referencedThread!;

    const result = handleRitualCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'make this part of my evening reset',
      priorCompanionMode: 'open_guidance',
      priorContext: {
        usedThreadIds: [created.id],
      },
      now: new Date('2026-04-04T16:05:00.000Z'),
    });

    const thread = getLifeThread(created.id);

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('evening reset');
    expect(thread?.followthroughMode).toBe('important_only');
    expect(thread?.nextFollowupAt).toBeTruthy();
    expect(thread?.snoozedUntil).toBeNull();
  });

  it('turns down household surfacing and updates the underlying family-context preference', () => {
    const result = handleRitualCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'stop surfacing family context automatically',
      now: new Date('2026-04-04T18:00:00.000Z'),
    });

    const profile = getRitualProfileByType('main', 'household_checkin');
    const familyPreference = listProfileFactsForGroup('main', [
      'accepted',
    ]).find((fact) => fact.factKey === 'family_context_default');

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('family context');
    expect(profile?.enabled).toBe(false);
    expect(profile?.triggerStyle).toBe('on_request');
    expect(profile?.optInState).toBe('opted_out');
    expect(familyPreference).toBeDefined();
  });
});
