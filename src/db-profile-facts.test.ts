import { beforeEach, describe, expect, it } from 'vitest';
import {
  _initTestDatabase,
  getProfileFact,
  getProfileSubjectByKey,
  listProfileFactsForGroup,
  upsertProfileFact,
  upsertProfileSubject,
  updateProfileFactState,
} from './db.js';
beforeEach(() => {
  _initTestDatabase();
});

describe('profile subjects and facts', () => {
  it('stores and updates structured profile facts', () => {
    upsertProfileSubject({
      id: 'main:self:self',
      groupFolder: 'main',
      kind: 'self',
      canonicalName: 'self',
      displayName: 'you',
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
      disabledAt: null,
    });

    const subject = getProfileSubjectByKey('main', 'self', 'self');
    expect(subject?.displayName).toBe('you');

    upsertProfileFact({
      id: 'fact-1',
      groupFolder: 'main',
      subjectId: 'main:self:self',
      category: 'conversational_style',
      factKey: 'response_style',
      valueJson: JSON.stringify({ mode: 'short_direct' }),
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'User prefers short direct answers.',
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
      decidedAt: '2026-04-03T00:00:00.000Z',
    });

    expect(getProfileFact('fact-1')).toMatchObject({
      factKey: 'response_style',
      state: 'accepted',
    });

    expect(
      listProfileFactsForGroup('main', ['accepted']).map(
        (fact) => fact.factKey,
      ),
    ).toContain('response_style');

    expect(
      updateProfileFactState(
        'fact-1',
        'disabled',
        '2026-04-03T01:00:00.000Z',
        '2026-04-03T01:00:00.000Z',
      ),
    ).toBe(true);
    expect(getProfileFact('fact-1')?.state).toBe('disabled');
  });
});
