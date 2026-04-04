import crypto from 'crypto';

import {
  getAlexaLinkedAccountByAccessTokenHash,
  upsertAlexaLinkedAccount,
} from './db.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { type AlexaLinkedAccount } from './types.js';

export interface AlexaPrincipalIdentity {
  userId: string;
  personId?: string;
  accessToken?: string;
}

export interface AlexaLinkedAccountSeed {
  accessToken: string;
  displayName: string;
  groupFolder: string;
  allowedAlexaUserId?: string;
  allowedAlexaPersonId?: string;
}

export type AlexaLinkedAccountResolution =
  | {
      ok: true;
      account: AlexaLinkedAccount;
      principalKey: string;
    }
  | {
      ok: false;
      kind: 'link-account' | 'forbidden';
      speech: string;
      reprompt?: string;
    };

const ALEXA_LINKED_ACCOUNT_ENV_KEYS = [
  'ALEXA_LINKED_ACCOUNT_TOKEN',
  'ALEXA_LINKED_ACCOUNT_NAME',
  'ALEXA_LINKED_ACCOUNT_GROUP_FOLDER',
  'ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID',
  'ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID',
  'ALEXA_TARGET_GROUP_FOLDER',
] as const;

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function hashAlexaAccessToken(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('hex');
}

export function getAlexaPrincipalKey(
  principal: Pick<AlexaPrincipalIdentity, 'userId' | 'personId'>,
): string {
  const raw = principal.personId?.trim() || principal.userId.trim();
  return `alexa:${raw}`;
}

export function resolveAlexaLinkedAccountSeed(
  env = process.env,
): AlexaLinkedAccountSeed | null {
  const envFile =
    env === process.env ? readEnvFile([...ALEXA_LINKED_ACCOUNT_ENV_KEYS]) : {};
  const token = (
    env.ALEXA_LINKED_ACCOUNT_TOKEN ||
    envFile.ALEXA_LINKED_ACCOUNT_TOKEN ||
    ''
  ).trim();
  const displayName = (
    env.ALEXA_LINKED_ACCOUNT_NAME ||
    envFile.ALEXA_LINKED_ACCOUNT_NAME ||
    'Andrea Alexa'
  ).trim();
  const groupFolder = (
    env.ALEXA_LINKED_ACCOUNT_GROUP_FOLDER ||
    envFile.ALEXA_LINKED_ACCOUNT_GROUP_FOLDER ||
    env.ALEXA_TARGET_GROUP_FOLDER ||
    envFile.ALEXA_TARGET_GROUP_FOLDER ||
    ''
  ).trim();
  const allowedAlexaUserId = normalizeOptional(
    env.ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID ||
      envFile.ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID,
  );
  const allowedAlexaPersonId = normalizeOptional(
    env.ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID ||
      envFile.ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID,
  );

  if (!token) return null;
  if (!groupFolder) {
    throw new Error(
      'Alexa linked-account seeding requires both ALEXA_LINKED_ACCOUNT_TOKEN and ALEXA_LINKED_ACCOUNT_GROUP_FOLDER.',
    );
  }

  assertValidGroupFolder(groupFolder);
  return {
    accessToken: token,
    displayName,
    groupFolder,
    allowedAlexaUserId,
    allowedAlexaPersonId,
  };
}

export function seedConfiguredAlexaLinkedAccount(
  env = process.env,
): AlexaLinkedAccount | null {
  const seed = resolveAlexaLinkedAccountSeed(env);
  if (!seed) return null;

  const now = new Date().toISOString();
  const record: AlexaLinkedAccount = {
    accessTokenHash: hashAlexaAccessToken(seed.accessToken),
    displayName: seed.displayName,
    groupFolder: seed.groupFolder,
    allowedAlexaUserId: seed.allowedAlexaUserId || null,
    allowedAlexaPersonId: seed.allowedAlexaPersonId || null,
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
  };
  upsertAlexaLinkedAccount(record);
  logger.info(
    { groupFolder: record.groupFolder },
    'Seeded Alexa linked account from local config',
  );
  return record;
}

export function resolveAlexaLinkedAccount(
  principal: AlexaPrincipalIdentity,
  assistantName: string,
): AlexaLinkedAccountResolution {
  if (!principal.accessToken) {
    return {
      ok: false,
      kind: 'link-account',
      speech: `${assistantName} needs account linking before she can read your personal day. Please link the skill in the Alexa app first.`,
      reprompt: 'Link the skill in the Alexa app, then ask again.',
    };
  }

  const accessTokenHash = hashAlexaAccessToken(principal.accessToken);
  const account = getAlexaLinkedAccountByAccessTokenHash(accessTokenHash);
  if (!account) {
    return {
      ok: false,
      kind: 'link-account',
      speech: `${assistantName} does not recognize this Alexa link yet. Please relink the skill and try again.`,
      reprompt: 'Relink the skill in the Alexa app, then try again.',
    };
  }

  if (
    account.allowedAlexaUserId &&
    account.allowedAlexaUserId !== principal.userId
  ) {
    return {
      ok: false,
      kind: 'forbidden',
      speech: `${assistantName} is not authorized for this Alexa profile.`,
      reprompt: 'Use the linked Alexa profile and try again.',
    };
  }

  if (
    account.allowedAlexaPersonId &&
    account.allowedAlexaPersonId !== principal.personId
  ) {
    return {
      ok: false,
      kind: 'forbidden',
      speech: `${assistantName} needs the linked Alexa voice profile for this request.`,
      reprompt: 'Try again from the linked Alexa voice profile.',
    };
  }

  let resolvedAccount = account;
  const nextAllowedUserId = account.allowedAlexaUserId || principal.userId;
  const nextAllowedPersonId =
    account.allowedAlexaPersonId || principal.personId || null;
  if (
    nextAllowedUserId !== account.allowedAlexaUserId ||
    nextAllowedPersonId !== account.allowedAlexaPersonId
  ) {
    resolvedAccount = {
      ...account,
      allowedAlexaUserId: nextAllowedUserId,
      allowedAlexaPersonId: nextAllowedPersonId,
      updatedAt: new Date().toISOString(),
    };
    upsertAlexaLinkedAccount(resolvedAccount);
    logger.info(
      {
        groupFolder: resolvedAccount.groupFolder,
        boundAlexaUserId: Boolean(nextAllowedUserId),
        boundAlexaPersonId: Boolean(nextAllowedPersonId),
      },
      'Bound Alexa linked account to the resolved Alexa principal',
    );
  }

  return {
    ok: true,
    account: resolvedAccount,
    principalKey: getAlexaPrincipalKey(principal),
  };
}
