import { createHash, randomBytes } from 'node:crypto';

const ISSUER = 'web-bob';
const AUDIENCE = 'andrea';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const WEB_BOB_OWNER_ACTOR = hash('web-bob:owner:jeff');

export interface WebBobRequestScope {
  issuer: string;
  audience: string;
  actor: string;
  conversationId: string;
  epoch: string;
  draftId: string;
  revision: number;
  draftRequestId: string;
  chatGuid: string;
  addresses: string[];
  text: string;
}

export class WebBobRequestScopeError extends Error {
  constructor(message = 'Invalid Web Bob request.') {
    super(message);
  }
}

/** Exact draft body keys accepted on protocol-2 `/draft`. */
export const WEB_BOB_DRAFT_SCOPE_KEYS = [
  'issuer',
  'audience',
  'actor',
  'conversationId',
  'epoch',
  'draftId',
  'revision',
  'draftRequestId',
  'chatGuid',
  'addresses',
  'text',
] as const;

export function assertWebBobDraftInputKeys(
  value: Record<string, unknown>,
): void {
  for (const key of Object.keys(value)) {
    requireScope(
      (WEB_BOB_DRAFT_SCOPE_KEYS as readonly string[]).includes(key),
      'Invalid Web Bob request.',
    );
  }
}

function hasLoneUtf16Surrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireScope(
  ok: unknown,
  message = 'Invalid Web Bob request.',
): asserts ok {
  if (!ok) throw new WebBobRequestScopeError(message);
}

export function canonicalWebBobAddress(value: string): string {
  const clean = value.trim().toLowerCase();
  if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean))
    return clean;
  requireScope(/^\+?[0-9 ().-]+$/.test(clean));
  const digits = clean.replace(/\D/g, '');
  requireScope(digits.length >= 10 && digits.length <= 15);
  return '+' + (digits.length === 10 ? '1' : '') + digits;
}

/** Canonical compact serialization for protocol-2 request binding. */
export function serializeWebBobRequestScope(scope: WebBobRequestScope): string {
  return JSON.stringify({
    issuer: scope.issuer,
    audience: scope.audience,
    actor: scope.actor,
    conversationId: scope.conversationId,
    epoch: scope.epoch,
    draftId: scope.draftId,
    revision: scope.revision,
    draftRequestId: scope.draftRequestId,
    chatGuid: scope.chatGuid,
    addresses: scope.addresses,
    text: scope.text,
  });
}

export function computeWebBobRequestDigest(scope: WebBobRequestScope): string {
  return hash(serializeWebBobRequestScope(scope));
}

export function parseWebBobRequestScope(
  value: Record<string, unknown>,
): WebBobRequestScope {
  assertWebBobDraftInputKeys(value);
  requireScope(value.issuer === ISSUER && value.audience === AUDIENCE);
  for (const key of [
    'actor',
    'conversationId',
    'epoch',
    'draftId',
    'draftRequestId',
  ]) {
    requireScope(
      typeof value[key] === 'string' &&
        /^[a-zA-Z0-9_-]{8,128}$/.test(value[key] as string),
    );
  }
  requireScope(
    Number.isSafeInteger(value.revision) && Number(value.revision) > 0,
  );
  requireScope(
    typeof value.chatGuid === 'string' &&
      /^(iMessage|SMS|RCS);-;[^;\s]{1,320}$/.test(value.chatGuid),
  );
  requireScope(
    typeof value.text === 'string' &&
      value.text.trim() &&
      value.text.length <= 4000 &&
      !hasLoneUtf16Surrogate(value.text),
  );
  requireScope(
    Array.isArray(value.addresses) &&
      value.addresses.length === 1 &&
      typeof value.addresses[0] === 'string',
  );
  const addresses = value.addresses as string[];
  for (const address of addresses) {
    requireScope(canonicalWebBobAddress(address) === address);
  }
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    actor: value.actor as string,
    conversationId: value.conversationId as string,
    epoch: value.epoch as string,
    draftId: value.draftId as string,
    revision: value.revision as number,
    draftRequestId: value.draftRequestId as string,
    chatGuid: value.chatGuid as string,
    addresses,
    text: value.text as string,
  };
}

export function normalizeWebBobActionScope(
  original: WebBobRequestScope,
): WebBobRequestScope {
  return {
    ...original,
    issuer: ISSUER,
    audience: AUDIENCE,
    actor: WEB_BOB_OWNER_ACTOR,
    draftRequestId: randomBytes(24).toString('hex'),
  };
}

export function computeWebBobActionDigest(scope: WebBobRequestScope): string {
  return hash(serializeWebBobRequestScope(scope));
}
