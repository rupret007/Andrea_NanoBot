import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeWebBobActionDigest,
  computeWebBobRequestDigest,
  normalizeWebBobActionScope,
  parseWebBobRequestScope,
  serializeWebBobRequestScope,
  WEB_BOB_OWNER_ACTOR,
} from './web-bob-request-scope.js';

const sample = () => ({
  issuer: 'web-bob',
  audience: 'andrea',
  actor: 'a'.repeat(64),
  conversationId: 'conversation-123',
  epoch: 'epoch-123',
  draftId: 'draft-123',
  revision: 1,
  draftRequestId: 'request-123',
  chatGuid: 'iMessage;-;+12025550102',
  addresses: ['+12025550102'],
  text: 'Exact owner text.\nSecond line.',
});

describe('Web Bob request scope binding', () => {
  it('serializes scope fields in the protocol-2 order with compact JSON', () => {
    const scope = parseWebBobRequestScope(sample());
    const serialized = serializeWebBobRequestScope(scope);
    expect(serialized).toBe(
      '{"issuer":"web-bob","audience":"andrea","actor":"' +
        'a'.repeat(64) +
        '","conversationId":"conversation-123","epoch":"epoch-123","draftId":"draft-123","revision":1,"draftRequestId":"request-123","chatGuid":"iMessage;-;+12025550102","addresses":["+12025550102"],"text":"Exact owner text.\\nSecond line."}',
    );
    expect(computeWebBobRequestDigest(scope)).toBe(
      createHash('sha256').update(serialized, 'utf8').digest('hex'),
    );
  });

  it('keeps request and action digests separate after Andrea normalizes actor and request ID', () => {
    const requestScope = parseWebBobRequestScope(sample());
    const actionScope = normalizeWebBobActionScope(requestScope);
    expect(actionScope.actor).toBe(WEB_BOB_OWNER_ACTOR);
    expect(actionScope.draftRequestId).not.toBe(requestScope.draftRequestId);
    expect(computeWebBobRequestDigest(requestScope)).not.toBe(
      computeWebBobActionDigest(actionScope),
    );
  });
});
