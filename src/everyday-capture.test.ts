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

  it('supports zero-setup capture and calm empty readouts before profile approval', async () => {
    const empty = await handleEverydayCaptureCommand(buildInput("what's on my list"));

    expect(empty.handled).toBe(true);
    expect(empty.replyText).toContain('Your list looks clear right now.');
    expect(empty.sendOptions?.inlineActionRows?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Groceries' }),
        expect.objectContaining({ label: 'Bills' }),
        expect.objectContaining({ label: 'Tonight' }),
      ]),
    );

    const add = await handleEverydayCaptureCommand(
      buildInput('add milk to my shopping list'),
    );

    expect(add.handled).toBe(true);
    expect(add.replyText).toContain('groceries');
    expect(listEverydayListGroups('main').map((group) => group.title)).toEqual(
      expect.arrayContaining([
        'Groceries',
        'Errands',
        'Bills',
        'Meals',
        'Household',
        'Tonight',
        'General',
      ]),
    );
    expect(add.sendOptions?.inlineActionRows?.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Done' }),
        expect.objectContaining({ label: 'Groceries' }),
        expect.objectContaining({ label: 'Plan' }),
      ]),
    );
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

    const groceriesReadout = await handleEverydayCaptureCommand(
      buildInput('what do I need from the store again'),
    );
    expect(groceriesReadout.replyText).toContain('milk');
    expect(groceriesReadout.replyText).toContain('batteries');

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

  it('supports recurring obligations, group moves, and reopen flows without turning into a second task system', async () => {
    const recurringBill = await handleEverydayCaptureCommand(
      buildInput('add pay water bill to my list every month'),
    );
    const billId = recurringBill.listItems?.[0]?.itemId;

    expect(getEverydayListItem(billId!)?.recurrenceKind).toBe('monthly');

    const done = await handleEverydayCaptureCommand(
      buildInput('mark that done', {
        priorContext: recurringBill.conversationData,
        now: new Date('2026-04-12T09:00:00-05:00'),
      }),
    );

    expect(done.replyText).toContain('marked pay water bill done');
    expect(getEverydayListItem(billId!)?.state).toBe('done');
    expect(getEverydayListItem(billId!)?.recurrenceNextDueAt).toBeTruthy();

    const refreshed = await handleEverydayCaptureCommand(
      buildInput('what bills do I need to pay this week', {
        now: new Date('2026-05-20T09:00:00-05:00'),
      }),
    );

    expect(refreshed.replyText).toContain('pay water bill');
    expect(getEverydayListItem(billId!)?.state).toBe('open');

    const moveToWeekend = await handleEverydayCaptureCommand(
      buildInput('make this part of my weekend list', {
        priorContext: recurringBill.conversationData,
      }),
    );
    const movedItem = getEverydayListItem(billId!);
    expect(moveToWeekend.replyText).toContain('moved pay water bill to weekend');
    expect(movedItem?.groupId).toBeTruthy();
    expect(
      listEverydayListGroups('main').find(
        (group) => group.groupId === movedItem?.groupId,
      )?.title,
    ).toBe('Weekend');

    const reopen = await handleEverydayCaptureCommand(
      buildInput('reopen that', {
        priorContext: {
          ...(recurringBill.conversationData || {}),
          activeListItemIds: [billId!],
        },
      }),
    );
    expect(reopen.replyText).toContain('reopened pay water bill');

    const stopRepeating = await handleEverydayCaptureCommand(
      buildInput('stop repeating that', {
        priorContext: {
          ...(recurringBill.conversationData || {}),
          activeListItemIds: [billId!],
        },
      }),
    );
    expect(stopRepeating.replyText).toContain('will stop repeating');
    expect(getEverydayListItem(billId!)?.recurrenceKind).toBe('none');
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

    expect(readout.replyText).toContain('From the store');
    expect(readout.replyText).toContain('If you want, I can send the fuller list to Telegram.');
    expect(readout.handoffOffer).toContain('fuller list to Telegram');
  });

  it('treats explicit grocery-list read asks as readouts even with active list context', async () => {
    await approveStarterProfile();

    const add = await handleEverydayCaptureCommand(
      buildInput('add eggs to my grocery list'),
    );

    const readout = await handleEverydayCaptureCommand(
      buildInput('show me my grocery list', {
        priorContext: add.conversationData,
      }),
    );

    expect(readout.handled).toBe(true);
    expect(readout.mode).toBe('read_items');
    expect(readout.replyText).toBeDefined();
    expect(readout.replyText!).toContain('*Groceries*');
    expect(readout.replyText!.toLowerCase()).toContain('eggs');
  });

  it('recognizes what is on my grocery list phrasing for shopping readouts', async () => {
    await approveStarterProfile();

    await handleEverydayCaptureCommand(
      buildInput('add milk to my shopping list'),
    );

    const readout = await handleEverydayCaptureCommand(
      buildInput("what's on my grocery list"),
    );

    expect(readout.handled).toBe(true);
    expect(readout.mode).toBe('read_items');
    expect(readout.replyText).toBeDefined();
    expect(readout.replyText!).toContain('*Groceries*');
    expect(readout.replyText!.toLowerCase()).toContain('milk');
  });

  it('recognizes what is still on my errands list phrasing for errand readouts', async () => {
    await approveStarterProfile();

    await handleEverydayCaptureCommand(
      buildInput('save this as an errand', {
        replyText: 'Drop off dry cleaning',
      }),
    );

    const readout = await handleEverydayCaptureCommand(
      buildInput("what's still on my errands list"),
    );

    expect(readout.handled).toBe(true);
    expect(readout.mode).toBe('read_items');
    expect(readout.replyText).toBeDefined();
    expect(readout.replyText!).toContain('*Errands*');
    expect(readout.replyText!.toLowerCase()).toContain('drop off dry cleaning');
  });

  it('adds a new item into the active list after a readout asks for the current slice', async () => {
    await approveStarterProfile();

    await handleEverydayCaptureCommand(
      buildInput('add eggs to my grocery list'),
    );

    const readout = await handleEverydayCaptureCommand(
      buildInput('what do I need from the store again'),
    );

    const add = await handleEverydayCaptureCommand(
      buildInput('add milk eggs and maybe trash bags', {
        priorContext: readout.conversationData,
      }),
    );

    expect(add.handled).toBe(true);
    expect(add.mode).toBe('add_item');
    expect(add.replyText).toContain('groceries');
    expect(add.listItems?.[0]?.title).toBe('milk eggs and maybe trash bags');
  });

  it('keeps the grocery group anchored even when the readout is empty', async () => {
    await approveStarterProfile();

    const readout = await handleEverydayCaptureCommand(
      buildInput('what do I need from the store again'),
    );

    expect(readout.handled).toBe(true);
    expect(readout.mode).toBe('read_items');
    expect(readout.conversationData?.activeListGroupId).toBeTruthy();

    const add = await handleEverydayCaptureCommand(
      buildInput('add milk eggs and maybe trash bags', {
        priorContext: readout.conversationData,
      }),
    );

    expect(add.handled).toBe(true);
    expect(add.mode).toBe('add_item');
    expect(add.replyText).toContain('groceries');
  });

  it('returns grouped Telegram readouts with contextual inline actions', async () => {
    await handleEverydayCaptureCommand(buildInput('add milk to my shopping list'));
    await handleEverydayCaptureCommand(buildInput('save this as an errand', {
      replyText: 'Pick up batteries',
    }));
    await handleEverydayCaptureCommand(buildInput('add pay water bill to my list'));

    const readout = await handleEverydayCaptureCommand(
      buildInput("what's still open"),
    );

    expect(readout.replyText).toContain('*Groceries*');
    expect(readout.replyText).toContain('*Errands*');
    expect(readout.replyText).toContain('*Bills This Week*');
    expect(readout.sendOptions?.inlineActionRows?.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Groceries' }),
        expect.objectContaining({ label: 'Done' }),
        expect.objectContaining({ label: 'Plan' }),
      ]),
    );
  });

  it('builds practical household smart views for store, bills, tonight, weekend, meals, and dinner gaps', async () => {
    const fridayMorning = new Date('2026-04-17T09:00:00-05:00');

    await handleEverydayCaptureCommand(
      buildInput('add tortillas to my shopping list', { now: fridayMorning }),
    );
    await handleEverydayCaptureCommand(
      buildInput('add salsa to my shopping list', { now: fridayMorning }),
    );
    await handleEverydayCaptureCommand(
      buildInput('add tortillas and salsa dinner for Friday', {
        now: fridayMorning,
      }),
    );
    await handleEverydayCaptureCommand(
      buildInput('add pay water bill to my list', { now: fridayMorning }),
    );
    const household = await handleEverydayCaptureCommand(
      buildInput('track that for the household', {
        replyText: 'Replace the air filter',
        now: fridayMorning,
      }),
    );
    await handleEverydayCaptureCommand(
      buildInput('make this part of my weekend list', {
        priorContext: household.conversationData,
        now: fridayMorning,
      }),
    );

    const store = await handleEverydayCaptureCommand(
      buildInput('what do we need from the store', { now: fridayMorning }),
    );
    expect(store.replyText).toContain('From the store');
    expect(store.replyText).toContain('*Groceries*');

    const bills = await handleEverydayCaptureCommand(
      buildInput('what bills are due this week', {
        channel: 'alexa',
        now: fridayMorning,
      }),
    );
    expect(bills.replyText).toContain('pay water bill');

    const tonight = await handleEverydayCaptureCommand(
      buildInput("what's left for tonight", {
        channel: 'alexa',
        now: fridayMorning,
      }),
    );
    expect(tonight.replyText).toContain('For tonight');

    const weekend = await handleEverydayCaptureCommand(
      buildInput('what should I handle this weekend', { now: fridayMorning }),
    );
    expect(weekend.replyText).toContain('*Weekend*');
    expect(weekend.replyText).toContain('Replace the air filter');

    const meals = await handleEverydayCaptureCommand(
      buildInput('what meal ideas do I have this week', { now: fridayMorning }),
    );
    expect(meals.replyText).toContain("This week's meal plan starts with");
    expect(meals.replyText).toContain('*Meals This Week*');
    expect(meals.replyText).toContain('tortillas and salsa dinner');

    const dinner = await handleEverydayCaptureCommand(
      buildInput("what's missing for dinner", { now: fridayMorning }),
    );
    expect(dinner.replyText || '').toContain('Dinner looks planned');
    expect((dinner.replyText || '').toLowerCase()).toContain('tortillas');
    expect((dinner.replyText || '').toLowerCase()).toContain('salsa');
  });

  it('tracks recently completed and slipping items for household review', async () => {
    const bill = await handleEverydayCaptureCommand(
      buildInput('add pay internet bill to my list'),
    );
    const done = await handleEverydayCaptureCommand(
      buildInput('mark that done', {
        priorContext: bill.conversationData,
      }),
    );
    expect(done.replyText).toContain('marked pay internet bill done');

    const recent = await handleEverydayCaptureCommand(
      buildInput('what did I finish lately'),
    );
    expect(recent.replyText).toContain('Recently finished');
    expect(recent.replyText).toContain('pay internet bill');

    const errand = await handleEverydayCaptureCommand(
      buildInput('save this as an errand', {
        replyText: 'Return the router',
      }),
    );
    const firstDefer = await handleEverydayCaptureCommand(
      buildInput('move that to next week', {
        priorContext: errand.conversationData,
      }),
    );
    const reopen = await handleEverydayCaptureCommand(
      buildInput('reopen that', {
        priorContext: firstDefer.conversationData,
      }),
    );
    await handleEverydayCaptureCommand(
      buildInput('move that to next week', {
        priorContext: reopen.conversationData,
      }),
    );

    const slipping = await handleEverydayCaptureCommand(
      buildInput("what's slipping"),
    );
    expect(slipping.replyText).toContain('Return the router');
  });
});
