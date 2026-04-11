import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAlexaConversationState,
  getAlexaConversationReferencedFactId,
  loadAlexaConversationState,
  resolveAlexaConversationFollowup,
  saveAlexaConversationState,
  type AlexaConversationState,
} from './alexa-conversation.js';
import { _initTestDatabase } from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('alexa conversation state', () => {
  it('asks for a clearer anchor when a follow-up arrives with no Alexa context', () => {
    expect(
      resolveAlexaConversationFollowup('anything else', undefined).speech,
    ).toContain('a person, a plan, or something you want me to remember');
  });

  it('stores, loads, and clears short-lived Alexa context', () => {
    saveAlexaConversationState(
      'alexa:user',
      'hash-1',
      'main',
      {
        flowKey: 'my_day',
        subjectKind: 'day_brief',
        subjectData: {},
        summaryText: 'today and what matters most',
        supportedFollowups: ['anything_else', 'shorter'],
        styleHints: {},
      },
      10 * 60 * 1000,
      new Date('2026-04-03T08:00:00.000Z'),
    );

    expect(
      loadAlexaConversationState(
        'alexa:user',
        'hash-1',
        '2026-04-03T08:05:00.000Z',
      ),
    ).toMatchObject({
      flowKey: 'my_day',
      summaryText: 'today and what matters most',
    });

    clearAlexaConversationState('alexa:user');
    expect(
      loadAlexaConversationState(
        'alexa:user',
        'hash-1',
        '2026-04-03T08:05:00.000Z',
      ),
    ).toBeUndefined();
  });

  it('expires and isolates context by token hash', () => {
    saveAlexaConversationState(
      'alexa:user',
      'hash-1',
      'main',
      {
        flowKey: 'my_day',
        subjectKind: 'day_brief',
        subjectData: {},
        summaryText: 'today and what matters most',
        supportedFollowups: ['anything_else'],
        styleHints: {},
      },
      60 * 1000,
      new Date('2026-04-03T08:00:00.000Z'),
    );

    expect(
      loadAlexaConversationState(
        'alexa:user',
        'hash-2',
        '2026-04-03T08:00:30.000Z',
      ),
    ).toBeUndefined();
    expect(
      loadAlexaConversationState(
        'alexa:user',
        'hash-1',
        '2026-04-03T08:02:00.000Z',
      ),
    ).toBeUndefined();
  });

  it('resolves strong follow-ups and rejects weak ones', () => {
    const state: AlexaConversationState = {
      flowKey: 'before_next_meeting',
      subjectKind: 'meeting',
      subjectData: {},
      summaryText: 'your next meeting and what to handle before it',
      supportedFollowups: [
        'anything_else',
        'shorter',
        'say_more',
        'before_that',
        'after_that',
        'remind_before_that',
        'save_that',
        'save_for_later',
        'send_details',
        'save_to_library',
        'track_thread',
        'create_reminder',
        'draft_follow_up',
        'approve_bundle',
        'show_bundle',
        'action_guidance',
        'risk_check',
        'memory_control',
      ],
      styleHints: {},
    };

    expect(
      resolveAlexaConversationFollowup('anything else', state),
    ).toMatchObject({ ok: true, action: 'anything_else' });
    expect(
      resolveAlexaConversationFollowup('make that shorter', state),
    ).toMatchObject({ ok: true, action: 'shorter' });
    expect(
      resolveAlexaConversationFollowup('say more', state),
    ).toMatchObject({ ok: true, action: 'say_more' });
    expect(
      resolveAlexaConversationFollowup('remember that', state),
    ).toMatchObject({ ok: true, action: 'save_that' });
    expect(
      resolveAlexaConversationFollowup('save that for later', state),
    ).toMatchObject({ ok: true, action: 'save_for_later' });
    expect(
      resolveAlexaConversationFollowup('send me the details', state),
    ).toMatchObject({ ok: true, action: 'send_details' });
    expect(
      resolveAlexaConversationFollowup(
        'give me the deeper comparison in Telegram',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'send_details' });
    expect(
      resolveAlexaConversationFollowup('send that to my messages', state),
    ).toMatchObject({ ok: true, action: 'send_details' });
    expect(
      resolveAlexaConversationFollowup('save that in my library', state),
    ).toMatchObject({ ok: true, action: 'save_to_library' });
    expect(
      resolveAlexaConversationFollowup('track that under Candace thread', state),
    ).toMatchObject({ ok: true, action: 'track_thread' });
    expect(
      resolveAlexaConversationFollowup('turn that into a reminder tonight', state),
    ).toMatchObject({ ok: true, action: 'create_reminder' });
    expect(
      resolveAlexaConversationFollowup('just the reminder', state),
    ).toMatchObject({ ok: true, action: 'create_reminder' });
    expect(
      resolveAlexaConversationFollowup('keep track of that for tonight', state),
    ).toMatchObject({ ok: true, action: 'save_for_later' });
    expect(
      resolveAlexaConversationFollowup('draft that for me', state),
    ).toMatchObject({ ok: true, action: 'draft_follow_up' });
    expect(
      resolveAlexaConversationFollowup('draft a message about that', state),
    ).toMatchObject({ ok: true, action: 'draft_follow_up' });
    expect(
      resolveAlexaConversationFollowup('do that', state),
    ).toMatchObject({ ok: true, action: 'approve_bundle' });
    expect(
      resolveAlexaConversationFollowup('show me the actions again', state),
    ).toMatchObject({ ok: true, action: 'show_bundle' });
    expect(
      resolveAlexaConversationFollowup('remind me before that', state),
    ).toMatchObject({ ok: true, action: 'remind_before_that' });
    expect(
      resolveAlexaConversationFollowup('what should I do about that', state),
    ).toMatchObject({ ok: true, action: 'action_guidance' });
    expect(
      resolveAlexaConversationFollowup('should I be worried about anything', state),
    ).toMatchObject({ ok: true, action: 'risk_check' });
    expect(
      resolveAlexaConversationFollowup('be a little more direct', state),
    ).toMatchObject({ ok: true, action: 'memory_control' });
    expect(
      resolveAlexaConversationFollowup('what is the weather', state),
    ).toMatchObject({ ok: false });
  });

  it('preserves communication-thread continuity fields in stored Alexa state', () => {
    saveAlexaConversationState(
      'alexa:user',
      'hash-communication',
      'main',
      {
        flowKey: 'communication_understand_message',
        subjectKind: 'communication_thread',
        subjectData: {
          communicationThreadId: 'comm-1',
          communicationSubjectIds: ['subject-candace'],
          communicationLifeThreadIds: ['thread-1'],
          lastCommunicationSummary: 'Candace still needs a dinner answer.',
        },
        summaryText: 'Candace still needs a dinner answer.',
        supportedFollowups: ['anything_else', 'send_details'],
        styleHints: {},
      },
      10 * 60 * 1000,
      new Date('2026-04-03T08:00:00.000Z'),
    );

    expect(
      loadAlexaConversationState(
        'alexa:user',
        'hash-communication',
        '2026-04-03T08:05:00.000Z',
      ),
    ).toMatchObject({
      subjectKind: 'communication_thread',
      subjectData: {
        communicationThreadId: 'comm-1',
        lastCommunicationSummary: 'Candace still needs a dinner answer.',
      },
    });
  });

  it('resolves generic person follow-ups and explainability prompts', () => {
    const state: AlexaConversationState = {
      flowKey: 'family_upcoming',
      subjectKind: 'household',
      subjectData: {
        personName: 'Candace',
        activePeople: ['Candace', 'Travis'],
        householdFocus: true,
      },
      summaryText: 'family plans and household logistics',
      supportedFollowups: [
        'anything_else',
        'switch_person',
        'memory_control',
      ],
      styleHints: {},
    };

    expect(
      resolveAlexaConversationFollowup('what about Travis', state),
    ).toMatchObject({ ok: true, action: 'switch_person' });
    expect(
      resolveAlexaConversationFollowup('why did you say that', state),
    ).toMatchObject({ ok: true, action: 'memory_control' });
    expect(
      resolveAlexaConversationFollowup('what is the weather', state).speech,
    ).toContain('still about Candace');
  });

  it('uses the active Alexa anchor when a follow-up binding is too weak to complete safely', () => {
    const state: AlexaConversationState = {
      flowKey: 'candace_followthrough',
      subjectKind: 'person',
      subjectData: {
        personName: 'Candace',
        activeVoiceAnchor: 'Candace dinner plans',
      },
      summaryText: 'Candace still needs a dinner answer tonight.',
      supportedFollowups: ['anything_else'],
      styleHints: {},
    };

    expect(
      resolveAlexaConversationFollowup('save that', state),
    ).toMatchObject({
      ok: false,
      speech: expect.stringContaining('Candace dinner plans'),
    });
  });

  it('exposes referenced fact ids for memory-control follow-ups', () => {
    expect(
      getAlexaConversationReferencedFactId({
        flowKey: 'memory_control',
        subjectKind: 'memory_fact',
        subjectData: { profileFactId: 'fact-1' },
        summaryText: 'memory control',
        supportedFollowups: ['memory_control'],
        styleHints: {},
      }),
    ).toBe('fact-1');
  });
});
