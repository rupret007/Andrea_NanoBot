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

  it('matches Web Bob Python reference digest for the golden scope vector', () => {
    const scope = parseWebBobRequestScope({
      issuer: 'web-bob',
      audience: 'andrea',
      actor: 'a'.repeat(64),
      conversationId: 'conversation-123',
      epoch: 'epoch-123',
      draftId: 'draft-123',
      revision: 7,
      draftRequestId: 'request-123',
      chatGuid: 'iMessage;-;+12025550102',
      addresses: ['+12025550102'],
      text: '  Café 🎸 "quoted" \\ back\ttab\nline\u0001ctl\u2028sep  ',
    });
    expect(computeWebBobRequestDigest(scope)).toBe(
      '8e6a5e561b5fe14760b7127f1e6e16c380994e4d4692d1ef65377e030df4617e',
    );
  });

  it('rejects non-canonical addresses without rewriting them', () => {
    for (const address of ['(202) 555-0102', '+1 202 555 0102']) {
      expect(() =>
        parseWebBobRequestScope({ ...sample(), addresses: [address] }),
      ).toThrow();
    }
    const scope = parseWebBobRequestScope(sample());
    expect(scope.addresses).toEqual(['+12025550102']);
  });

  it('rejects caller-supplied digest keys and lone UTF-16 surrogates', () => {
    expect(() =>
      parseWebBobRequestScope({ ...sample(), requestDigest: 'a'.repeat(64) }),
    ).toThrow();
    expect(() =>
      parseWebBobRequestScope({ ...sample(), text: 'broken \ud800 surrogate' }),
    ).toThrow();
  });
});
