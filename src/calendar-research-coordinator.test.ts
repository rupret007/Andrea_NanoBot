import { describe, expect, it } from 'vitest';

import { planGoogleCalendarCreate } from './google-calendar-create.js';
import { planCompoundCalendarResearchRequest } from './calendar-research-coordinator.js';

const calendars = [
  {
    id: 'primary',
    summary: 'Primary',
    primary: true,
    accessRole: 'owner',
    writable: true,
    selected: true,
  },
];

describe('planCompoundCalendarResearchRequest', () => {
  it('splits the live calendar and research prompt without contaminating the event title', () => {
    const plan = planCompoundCalendarResearchRequest(
      'Add to my calendar that I need to meditate tomorrow morning at 8 am and can you look for a good meditation for me please.',
    );

    expect(plan).toEqual({
      calendarText:
        'Add to my calendar that I need to meditate tomorrow at 8 am',
      researchText: 'recommend a good meditation for me',
      requestedDepth: 'standard',
      allowWebSearch: true,
      explicitMaxEffort: false,
    });

    const calendarPlan = planGoogleCalendarCreate(
      plan!.calendarText,
      calendars,
      new Date('2026-07-13T12:00:00-05:00'),
      'America/Chicago',
    );
    expect(calendarPlan.kind).toBe('draft');
    if (calendarPlan.kind === 'draft') {
      expect(calendarPlan.draft.title).toBe('I need to meditate');
    }
  });

  it.each([
    [
      'Schedule a planning block tomorrow at 9am; investigate current meditation guidance',
      'research current meditation guidance',
    ],
    [
      'Add a wellness block tomorrow at 8am, then also compare guided and silent meditation',
      'compare guided and silent meditation',
    ],
    [
      'Put a focus block on my calendar Friday at 10am and would you recommend the best breathing exercise for me?',
      'recommend the best breathing exercise for me',
    ],
  ])('supports explicit clause boundaries in %s', (text, researchText) => {
    expect(planCompoundCalendarResearchRequest(text)).toMatchObject({
      researchText,
      requestedDepth: 'standard',
      allowWebSearch: true,
    });
  });

  it.each([
    [
      'Add a meditation block to my calendar tomorrow at 8am and kick off some research on guided meditation and provide me the results',
      'research guided meditation',
    ],
    [
      'Schedule a sleep review tomorrow at 9am; start research on sleep routines and provide results',
      'research sleep routines',
    ],
    [
      'Schedule meditation tomorrow at 8am and also have it kick off some research on guided meditation and provide me the results',
      'research guided meditation',
    ],
  ])('canonicalizes natural research-launch phrasing in %s', (text, query) => {
    expect(planCompoundCalendarResearchRequest(text)).toMatchObject({
      researchText: query,
      requestedDepth: 'deep',
      allowWebSearch: true,
    });
  });

  it('recognizes explicit maximum-effort language without changing ordinary requests', () => {
    expect(
      planCompoundCalendarResearchRequest(
        'Add a focus block to my calendar tomorrow at 8am and can you use all available resources to research meditation techniques?',
      ),
    ).toMatchObject({
      researchText: 'research meditation techniques',
      explicitMaxEffort: true,
      requestedDepth: 'deep',
    });
    expect(
      planCompoundCalendarResearchRequest(
        'Add a focus block to my calendar tomorrow at 8am and can you research meditation techniques',
      ),
    ).toMatchObject({
      explicitMaxEffort: false,
      requestedDepth: 'standard',
    });
  });

  it.each([
    'using all the resources available to research meditation techniques',
    'research everything about meditation techniques',
    'research meditation techniques with max IQ',
    'research meditation techniques with ultrathink',
    'research meditation techniques comprehensively',
    'research meditation techniques thoroughly',
    'research meditation techniques as a deep dive',
  ])('recognizes maximum-effort phrase: %s', (researchClause) => {
    expect(
      planCompoundCalendarResearchRequest(
        `Add a focus block to my calendar tomorrow at 8am; ${researchClause}`,
      ),
    ).toMatchObject({ explicitMaxEffort: true, requestedDepth: 'deep' });
  });

  it.each([
    'Add a research block to my calendar tomorrow at 8am and research meditation techniques',
    'Add a review called Find and compare providers to my calendar tomorrow at 8am',
    'Add an event titled Review options and find current pricing tomorrow at 8am',
    'Add an event titled Budget review and can you research vendor pricing tomorrow at 9am',
    'Add "Budget review and can you research vendor pricing" to my calendar tomorrow at 9am',
    'Add “Planning notes and would you compare private vendors” to my calendar tomorrow at 9am',
    "Add 'Budget review and can you research vendor pricing' to my calendar tomorrow at 9am",
    "Add 'Budget review; research vendor pricing' to my calendar tomorrow at 9am",
    "Add 'Budget review and can you research vendor pricing to my calendar tomorrow at 9am",
    "Add Budget review and can you research vendor pricing' to my calendar tomorrow at 9am",
    'Add "Budget review and can you research vendor pricing to my calendar tomorrow at 9am',
    'Add Budget review and can you research vendor pricing" to my calendar tomorrow at 9am',
    'Add “Budget review and can you research vendor pricing to my calendar tomorrow at 9am',
    'Add Budget review and can you research vendor pricing” to my calendar tomorrow at 9am',
    'Add ‘Budget review and can you research vendor pricing’ to my calendar tomorrow at 9am',
    'Add ‘Budget review and can you research vendor pricing to my calendar tomorrow at 9am',
    'Add Budget review and can you research vendor pricing’ to my calendar tomorrow at 9am',
    'Add (Budget review and can you research vendor pricing) to my calendar tomorrow at 9am',
    'Add (Budget review and can you research vendor pricing to my calendar tomorrow at 9am',
    'Add Budget review and can you research vendor pricing) to my calendar tomorrow at 9am',
    'Add [Budget review and can you research vendor pricing] to my calendar tomorrow at 9am',
    'Add [Budget review, then compare vendor pricing] to my calendar tomorrow at 9am',
    'Add [Budget review and can you research vendor pricing to my calendar tomorrow at 9am',
    'Add Budget review and can you research vendor pricing] to my calendar tomorrow at 9am',
  ])('keeps title text out of the outward research clause in %s', (text) => {
    expect(planCompoundCalendarResearchRequest(text)).toBeNull();
  });

  it.each([
    "Schedule Taylor's planning review tomorrow at 9am and can you research current vendor pricing",
    "Schedule the team's planning review tomorrow at 9am and can you research current vendor pricing",
    'Schedule the team’s planning review tomorrow at 9am and can you research current vendor pricing',
    "Schedule a planning review tomorrow at 9am and can you research why vendors don't publish current pricing",
    'Schedule a planning review (30 minutes) tomorrow at 9am and can you research current vendor pricing',
    'Schedule a planning review [30 minutes] tomorrow at 9am and can you research current vendor pricing',
    'Add "Budget review" to my calendar tomorrow at 9am and can you research current vendor pricing',
    "Add 'Budget review' to my calendar tomorrow at 9am and can you research current vendor pricing",
    'Schedule a planning review tomorrow at 9am and can you research current vendor pricing (including annual plans)',
  ])('preserves an ordinary compound boundary in %s', (text) => {
    expect(planCompoundCalendarResearchRequest(text)).toMatchObject({
      researchText: expect.stringMatching(/^(?:research|recommend|compare) /),
      allowWebSearch: true,
    });
  });

  it.each([
    'Add dinner with Sam and Alex to my calendar tomorrow at 7pm.',
    'Add the research and development review to my calendar tomorrow at 9am.',
    'What is on my calendar tomorrow and research meditation for me.',
    'Research meditation and add a focus block to my calendar tomorrow at 8am.',
    'Remind me tomorrow at 8am and find a meditation for me.',
    'Add a focus block to my calendar tomorrow at 8am and tell me about meditation.',
    'Add a focus block to my calendar tomorrow at 8am and find current meditation guidance.',
    'Add a focus block to my calendar tomorrow at 8am and compare meditation apps.',
    'yes',
    'confirm',
    'Can you say more about the meditation research?',
    'Start a timer for ten minutes.',
    'Kick off the meeting tomorrow morning.',
  ])('does not over-split %s', (text) => {
    expect(planCompoundCalendarResearchRequest(text)).toBeNull();
  });
});
