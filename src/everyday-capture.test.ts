import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./openai-provider.js', () => ({
  resolveOpenAiProviderConfig: () => null,
  describeOpenAiProviderFailure: () => 'provider blocked',
}));

import {
  getActiveOperatingProfile,
  getEverydayListItem,
  getMission,
  getTasksForGroup,
  listEverydayListGroups,
  listEverydayListItems,
  listLifeThreadsForGroup,
  listOperatingProfileSuggestions,
  _initTestDatabase,
} from './db.js';
import {
  getEverydayCaptureSignal,
  handleEverydayCaptureCommand,
  type EverydayCaptureCommandInput,
} from './everyday-capture.js';

function buildInput(
  text: string,
  overrides: Partial<EverydayCaptureCommandInput> = {},
): EverydayCaptureCommandInput {
  return {
    channel: 'telegram',
    groupFolder: 'main',
    chatJid: 'tg:main',
    text,
    now: new Date('2026-04-12T09:00:00-05:00'),
    ...overrides,
  };
}

async function approveStarterProfile(): Promise<void> {
  await handleEverydayCaptureCommand(buildInput('help me set this up'));
  await handleEverydayCaptureCommand(
    buildInput(
      'Track groceries, errands, bills, meals, pills, and household follow-through for me. Telegram should be richer, and I use Alexa and calendar.',
    ),
  );
  await handleEverydayCaptureCommand(buildInput('approve that'));
}

describe('everyday capture', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates a draft operating profile and seeds starter groups after approval', async () => {
    const start = await handleEverydayCaptureCommand(
      buildInput('help me set this up'),
    );

    expect(start.handled).toBe(true);
    expect(start.mode).toBe('profile_setup');
    expect(start.replyText).toContain('what you want Andrea to track');

    const proposal = await handleEverydayCaptureCommand(
      buildInput(
        'Track groceries, errands, bills, meals, pills, and household follow-through for me. Telegram should be richer, and I use Alexa and calendar.',
      ),
    );

    expect(proposal.handled).toBe(true);
    expect(proposal.replyText).toContain('*Proposed Andrea setup*');
    expect(proposal.replyText).toContain('Groceries');
    expect(getActiveOperatingProfile('main')).toBeUndefined();

    const approval = await handleEverydayCaptureCommand(
      buildInput('approve that'),
    );

    expect(approval.handled).toBe(true);
    expect(approval.replyText).toContain('saved that setup');
    expect(getActiveOperatingProfile('main')?.status).toBe('active');
    expect(listEverydayListGroups('main').map((group) => group.title)).toEqual(
      expect.arrayContaining([
        'Groceries',
        'Errands',
        'Bills',
        'Meals',
        'Tonight',
        'Household',
        'General',
      ]),
    );
  });

  it('captures practical list items, reads them back, and keeps suggestions gated', async () => {
    await approveStarterProfile();

    await handleEverydayCaptureCommand(buildInput('add milk to my shopping list'));
    await handleEverydayCaptureCommand(buildInput('put batteries on my list'));
    await handleEverydayCaptureCommand(
      buildInput('add pay water bill to my list'),
    );
    await handleEverydayCaptureCommand(buildInput('add dinner idea for Friday'));
    await handleEverydayCaptureCommand(buildInput('add my pills to tonight'));

    const allItems = listEverydayListItems('main', { includeDone: true });
    expect(allItems.map((item) => item.title)).toEqual(
      expect.arrayContaining([
        'milk',
        'batteries',
        'pay water bill',
        'Dinner idea',
        'Take pills',
      ]),
    );

    const billsReadout = await handleEverydayCaptureCommand(
      buildInput('what bills do I need to pay this week'),
    );
    expect(billsReadout.replyText).toContain('pay water bill');

    const mealsReadout = await handleEverydayCaptureCommand(
      buildInput('what meals have I planned this week'),
    );
    expect(mealsReadout.replyText).toContain('Dinner idea');

    expect(getEverydayCaptureSignal({ groupFolder: 'main', focus: 'weekly' })).toEqual(
      expect.arrayContaining(['Bill: pay water bill']),
    );
    expect(getEverydayCaptureSignal({ groupFolder: 'main', focus: 'tonight' })).toEqual(
      expect.arrayContaining(['Tonight: Take pills']),
    );

    const suggestions = listOperatingProfileSuggestions('main', ['proposed']);
    expect(suggestions.map((item) => item.title)).toEqual(
      expect.arrayContaining(['Bills group', 'Tonight meds']),
    );

    const dismiss = await handleEverydayCaptureCommand(
      buildInput('dismiss that suggestion'),
    );
    expect(dismiss.replyText).toContain('leave that suggestion alone');
    expect(listOperatingProfileSuggestions('main', ['dismissed'])).toHaveLength(1);
  });

  it('supports mark-done, defer, and reminder conversion from the active item frame', async () => {
    await approveStarterProfile();

    const addErrand = await handleEverydayCaptureCommand(
      buildInput('save this as an errand', {
        replyText: 'Pick up air filters',
      }),
    );
    const errandId = addErrand.listItems?.[0]?.itemId;
    expect(errandId).toBeTruthy();

    const done = await handleEverydayCaptureCommand(
      buildInput('mark that done', {
        priorContext: addErrand.conversationData,
      }),
    );
    expect(done.replyText).toContain('marked Pick up air filters done');
    expect(getEverydayListItem(errandId!)?.state).toBe('done');

    const addBill = await handleEverydayCaptureCommand(
      buildInput('add pay water bill to my list'),
    );
    const billId = addBill.listItems?.[0]?.itemId;

    const defer = await handleEverydayCaptureCommand(
      buildInput('move that to next week', {
        priorContext: addBill.conversationData,
      }),
    );
    expect(defer.replyText).toContain('moved pay water bill to next week');
    expect(getEverydayListItem(billId!)?.state).toBe('deferred');
    expect(getEverydayListItem(billId!)?.deferUntil).toBeTruthy();

    const askReminder = await handleEverydayCaptureCommand(
      buildInput('turn that into a reminder', {
        priorContext: addBill.conversationData,
      }),
    );
    expect(askReminder.replyText).toContain('Tell me when');

    const reminder = await handleEverydayCaptureCommand(
      buildInput('tomorrow at 3'),
    );
    expect(reminder.replyText).toContain("I'll remind you tomorrow at 3pm");
    expect(getEverydayListItem(billId!)?.state).toBe('converted_to_reminder');
    expect(getTasksForGroup('main')).toHaveLength(1);
  });

  it('can convert items into a plan or a household thread without collapsing the systems together', async () => {
    await approveStarterProfile();

    const meal = await handleEverydayCaptureCommand(
      buildInput('add dinner idea for Friday'),
    );
    const mealId = meal.listItems?.[0]?.itemId;

    const mission = await handleEverydayCaptureCommand(
      buildInput('make this part of my plan', {
        priorContext: meal.conversationData,
      }),
    );
    expect(mission.handled).toBe(true);
    expect(mission.replyText).toBeTruthy();
    expect(getEverydayListItem(mealId!)?.state).toBe('converted_to_mission');
    const missionLinkage = JSON.parse(
      getEverydayListItem(mealId!)?.linkageJson || '{}',
    ) as { missionId?: string };
    expect(missionLinkage.missionId).toBeTruthy();
    expect(getMission(missionLinkage.missionId!)).toBeTruthy();

    const household = await handleEverydayCaptureCommand(
      buildInput('track that for the household', {
        replyText: 'Replace the air filter',
      }),
    );
    const householdId = household.listItems?.[0]?.itemId;

    const thread = await handleEverydayCaptureCommand(
      buildInput('save that under the household thread', {
        priorContext: household.conversationData,
      }),
    );
    expect(thread.replyText).toContain('saved Replace the air filter under the household thread');
    expect(getEverydayListItem(householdId!)?.state).toBe('open');
    const threadLinkage = JSON.parse(
      getEverydayListItem(householdId!)?.linkageJson || '{}',
    ) as { threadId?: string };
    expect(threadLinkage.threadId).toBeTruthy();
    expect(listLifeThreadsForGroup('main')).toHaveLength(1);
  });

  it('keeps Alexa list readout concise and offers Telegram when the slice is long', async () => {
    await approveStarterProfile();
    await handleEverydayCaptureCommand(
      buildInput('add milk to my shopping list', { channel: 'alexa' }),
    );
    await handleEverydayCaptureCommand(
      buildInput('put batteries on my list', { channel: 'alexa' }),
    );
    await handleEverydayCaptureCommand(
      buildInput('add bread to my shopping list', { channel: 'alexa' }),
    );
    await handleEverydayCaptureCommand(
      buildInput('add trash bags to my shopping list', { channel: 'alexa' }),
    );

    const readout = await handleEverydayCaptureCommand(
      buildInput('what do I still need to buy', { channel: 'alexa' }),
    );

    expect(readout.replyText).toContain('You still need');
    expect(readout.replyText).toContain('Want the fuller list in Telegram?');
    expect(readout.handoffOffer).toContain('fuller list to Telegram');
  });
});
