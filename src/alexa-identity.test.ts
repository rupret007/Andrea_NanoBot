import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  getAlexaPrincipalKey,
  hashAlexaAccessToken,
  resolveAlexaLinkedAccount,
  resolveAlexaLinkedAccountSeed,
  seedConfiguredAlexaLinkedAccount,
} from './alexa-identity.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('resolveAlexaLinkedAccountSeed', () => {
  it('returns null when no seed env is configured', () => {
    expect(resolveAlexaLinkedAccountSeed({})).toBeNull();
  });

  it('ignores partial display metadata when no seed token is configured', () => {
    expect(
      resolveAlexaLinkedAccountSeed({
        ALEXA_LINKED_ACCOUNT_NAME: 'Andrea Alexa',
        ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: 'main',
      }),
    ).toBeNull();
  });

  it('requires token and group folder together', () => {
    expect(() =>
      resolveAlexaLinkedAccountSeed({
        ALEXA_LINKED_ACCOUNT_TOKEN: 'secret',
      }),
    ).toThrow('requires both');
  });
});

describe('Alexa linked-account resolution', () => {
  it('seeds and resolves a linked account by access token hash', () => {
    seedConfiguredAlexaLinkedAccount({
      ALEXA_LINKED_ACCOUNT_TOKEN: 'secret-token',
      ALEXA_LINKED_ACCOUNT_NAME: 'Andrea Alexa',
      ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: 'main',
      ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID: 'amzn1.ask.account.test-user',
      ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID: 'amzn1.ask.person.test-person',
    });

    const resolution = resolveAlexaLinkedAccount(
      {
        userId: 'amzn1.ask.account.test-user',
        personId: 'amzn1.ask.person.test-person',
        accessToken: 'secret-token',
      },
      'Andrea',
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.account.accessTokenHash).toBe(
      hashAlexaAccessToken('secret-token'),
    );
    expect(resolution.account.groupFolder).toBe('main');
    expect(resolution.principalKey).toBe(
      getAlexaPrincipalKey({
        userId: 'amzn1.ask.account.test-user',
        personId: 'amzn1.ask.person.test-person',
      }),
    );
  });

  it('returns link-account when the token is missing or unknown', () => {
    expect(
      resolveAlexaLinkedAccount(
        {
          userId: 'amzn1.ask.account.test-user',
        },
        'Andrea',
      ),
    ).toMatchObject({
      ok: false,
      kind: 'link-account',
    });

    expect(
      resolveAlexaLinkedAccount(
        {
          userId: 'amzn1.ask.account.test-user',
          accessToken: 'unknown-token',
        },
        'Andrea',
      ),
    ).toMatchObject({
      ok: false,
      kind: 'link-account',
    });
  });

  it('rejects mismatched Alexa user or person bindings', () => {
    seedConfiguredAlexaLinkedAccount({
      ALEXA_LINKED_ACCOUNT_TOKEN: 'secret-token',
      ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: 'main',
      ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID: 'amzn1.ask.account.expected',
      ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID: 'amzn1.ask.person.expected',
    });

    expect(
      resolveAlexaLinkedAccount(
        {
          userId: 'amzn1.ask.account.other',
          personId: 'amzn1.ask.person.expected',
          accessToken: 'secret-token',
        },
        'Andrea',
      ),
    ).toMatchObject({
      ok: false,
      kind: 'forbidden',
    });

    expect(
      resolveAlexaLinkedAccount(
        {
          userId: 'amzn1.ask.account.expected',
          personId: 'amzn1.ask.person.other',
          accessToken: 'secret-token',
        },
        'Andrea',
      ),
    ).toMatchObject({
      ok: false,
      kind: 'forbidden',
    });
  });

  it('binds the Alexa user and person IDs on first successful resolution when they were unset', () => {
    seedConfiguredAlexaLinkedAccount({
      ALEXA_LINKED_ACCOUNT_TOKEN: 'secret-token',
      ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: 'main',
    });

    const resolution = resolveAlexaLinkedAccount(
      {
        userId: 'amzn1.ask.account.bound-user',
        personId: 'amzn1.ask.person.bound-person',
        accessToken: 'secret-token',
      },
      'Andrea',
    );

    expect(resolution).toMatchObject({
      ok: true,
    });
    if (!resolution.ok) return;
    expect(resolution.account.allowedAlexaUserId).toBe(
      'amzn1.ask.account.bound-user',
    );
    expect(resolution.account.allowedAlexaPersonId).toBe(
      'amzn1.ask.person.bound-person',
    );
  });
});
