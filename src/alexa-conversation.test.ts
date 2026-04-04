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
        'before_that',
        'after_that',
        'remind_before_that',
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
      resolveAlexaConversationFollowup('remind me before that', state),
    ).toMatchObject({ ok: true, action: 'remind_before_that' });
    expect(
      resolveAlexaConversationFollowup('what is the weather', state),
    ).toMatchObject({ ok: false });
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
