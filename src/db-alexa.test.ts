import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  clearAlexaSession,
  consumeAlexaOAuthAuthorizationCode,
  disableAlexaOAuthRefreshToken,
  getAlexaLinkedAccountByAccessTokenHash,
  getAlexaOAuthAuthorizationCode,
  getAlexaOAuthRefreshToken,
  getAlexaSession,
  insertAlexaOAuthAuthorizationCode,
  insertAlexaOAuthRefreshToken,
  purgeExpiredAlexaSessions,
  purgeExpiredAlexaOAuthAuthorizationCodes,
  purgeExpiredAlexaOAuthRefreshTokens,
  upsertAlexaLinkedAccount,
  upsertAlexaSession,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('alexa linked accounts', () => {
  it('stores and loads a linked Alexa account', () => {
    upsertAlexaLinkedAccount({
      accessTokenHash: 'hash-1',
      displayName: 'Andrea Alexa',
      groupFolder: 'main',
      allowedAlexaUserId: 'amzn1.ask.account.test',
      allowedAlexaPersonId: 'amzn1.ask.person.test',
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
      disabledAt: null,
    });

    expect(getAlexaLinkedAccountByAccessTokenHash('hash-1')).toMatchObject({
      displayName: 'Andrea Alexa',
      groupFolder: 'main',
      allowedAlexaUserId: 'amzn1.ask.account.test',
      allowedAlexaPersonId: 'amzn1.ask.person.test',
    });
  });
});

describe('alexa sessions', () => {
  it('stores and loads a pending Alexa session', () => {
    upsertAlexaSession({
      principalKey: 'alexa:person-1',
      accessTokenHash: 'hash-1',
      pendingKind: 'confirm_save_for_later',
      payloadJson: JSON.stringify({ captureText: 'buy coffee filters' }),
      expiresAt: '2026-04-03T01:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });

    expect(
      getAlexaSession('alexa:person-1', 'hash-1', '2026-04-03T00:30:00.000Z'),
    ).toMatchObject({
      pendingKind: 'confirm_save_for_later',
    });
  });

  it('drops expired sessions', () => {
    upsertAlexaSession({
      principalKey: 'alexa:person-2',
      accessTokenHash: 'hash-2',
      pendingKind: 'capture_reminder_lead_time',
      payloadJson: '{}',
      expiresAt: '2026-04-03T00:10:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });

    expect(
      getAlexaSession('alexa:person-2', 'hash-2', '2026-04-03T00:11:00.000Z'),
    ).toBeUndefined();
  });

  it('clears sessions whose token hash no longer matches', () => {
    upsertAlexaSession({
      principalKey: 'alexa:person-3',
      accessTokenHash: 'hash-3',
      pendingKind: 'capture_follow_up_reference',
      payloadJson: '{}',
      expiresAt: '2026-04-03T01:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });

    expect(
      getAlexaSession(
        'alexa:person-3',
        'other-hash',
        '2026-04-03T00:30:00.000Z',
      ),
    ).toBeUndefined();
    expect(
      getAlexaSession('alexa:person-3', 'hash-3', '2026-04-03T00:30:00.000Z'),
    ).toBeUndefined();
  });

  it('supports explicit purge and clear helpers', () => {
    upsertAlexaSession({
      principalKey: 'alexa:person-4',
      accessTokenHash: 'hash-4',
      pendingKind: 'confirm_reminder_before_next_meeting',
      payloadJson: '{}',
      expiresAt: '2026-04-03T00:10:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    upsertAlexaSession({
      principalKey: 'alexa:person-5',
      accessTokenHash: 'hash-5',
      pendingKind: 'confirm_save_for_later',
      payloadJson: '{}',
      expiresAt: '2026-04-03T01:10:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    });

    expect(purgeExpiredAlexaSessions('2026-04-03T00:11:00.000Z')).toBe(1);
    clearAlexaSession('alexa:person-5');
    expect(
      getAlexaSession('alexa:person-5', 'hash-5', '2026-04-03T00:30:00.000Z'),
    ).toBeUndefined();
  });
});

describe('alexa oauth authorization codes', () => {
  it('stores, loads, consumes, and purges authorization codes', () => {
    insertAlexaOAuthAuthorizationCode({
      codeHash: 'code-hash-1',
      clientId: 'client-1',
      redirectUri: 'https://layla.amazon.com/api/skill/link/test',
      scope: 'andrea.alexa.link',
      codeChallenge: 'challenge-1',
      codeChallengeMethod: 'S256',
      groupFolder: 'main',
      displayName: 'Andrea Alexa',
      createdAt: '2026-04-03T00:00:00.000Z',
      expiresAt: '2026-04-03T00:10:00.000Z',
      usedAt: null,
    });

    expect(getAlexaOAuthAuthorizationCode('code-hash-1')).toMatchObject({
      clientId: 'client-1',
      groupFolder: 'main',
      codeChallengeMethod: 'S256',
    });

    expect(
      consumeAlexaOAuthAuthorizationCode(
        'code-hash-1',
        '2026-04-03T00:05:00.000Z',
        '2026-04-03T00:05:00.000Z',
      ),
    ).toBe(true);
    expect(
      consumeAlexaOAuthAuthorizationCode(
        'code-hash-1',
        '2026-04-03T00:06:00.000Z',
        '2026-04-03T00:06:00.000Z',
      ),
    ).toBe(false);

    insertAlexaOAuthAuthorizationCode({
      codeHash: 'code-hash-2',
      clientId: 'client-1',
      redirectUri: 'https://layla.amazon.com/api/skill/link/test',
      scope: 'andrea.alexa.link',
      codeChallenge: null,
      codeChallengeMethod: null,
      groupFolder: 'main',
      displayName: 'Andrea Alexa',
      createdAt: '2026-04-03T00:00:00.000Z',
      expiresAt: '2026-04-03T00:01:00.000Z',
      usedAt: null,
    });

    expect(
      purgeExpiredAlexaOAuthAuthorizationCodes('2026-04-03T00:02:00.000Z'),
    ).toBe(1);
    expect(getAlexaOAuthAuthorizationCode('code-hash-2')).toBeUndefined();
  });
});

describe('alexa oauth refresh tokens', () => {
  it('stores, disables, and purges refresh tokens', () => {
    insertAlexaOAuthRefreshToken({
      refreshTokenHash: 'refresh-hash-1',
      clientId: 'client-1',
      scope: 'andrea.alexa.link',
      groupFolder: 'main',
      displayName: 'Andrea Alexa',
      createdAt: '2026-04-03T00:00:00.000Z',
      expiresAt: '2026-04-03T01:00:00.000Z',
      disabledAt: null,
    });

    expect(getAlexaOAuthRefreshToken('refresh-hash-1')).toMatchObject({
      clientId: 'client-1',
      groupFolder: 'main',
    });
    expect(
      disableAlexaOAuthRefreshToken(
        'refresh-hash-1',
        '2026-04-03T00:30:00.000Z',
      ),
    ).toBe(true);
    expect(
      disableAlexaOAuthRefreshToken(
        'refresh-hash-1',
        '2026-04-03T00:31:00.000Z',
      ),
    ).toBe(false);

    insertAlexaOAuthRefreshToken({
      refreshTokenHash: 'refresh-hash-2',
      clientId: 'client-1',
      scope: 'andrea.alexa.link',
      groupFolder: 'main',
      displayName: 'Andrea Alexa',
      createdAt: '2026-04-03T00:00:00.000Z',
      expiresAt: '2026-04-03T00:10:00.000Z',
      disabledAt: null,
    });

    expect(
      purgeExpiredAlexaOAuthRefreshTokens('2026-04-03T00:11:00.000Z'),
    ).toBe(1);
    expect(getAlexaOAuthRefreshToken('refresh-hash-2')).toBeUndefined();
  });
});
