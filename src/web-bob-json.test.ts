import { describe, expect, it } from 'vitest';

import { parseWebBobJsonBody, WebBobJsonParseError } from './web-bob-json.js';

describe('Web Bob JSON ingress', () => {
  it('rejects duplicate object keys before schema validation', () => {
    expect(() =>
      parseWebBobJsonBody('{"bridgeDraftId":"a","bridgeDraftId":"b"}'),
    ).toThrow(WebBobJsonParseError);
  });

  it('parses a single object without trailing content', () => {
    expect(parseWebBobJsonBody('{"revision":1}')).toEqual({ revision: 1 });
    expect(() => parseWebBobJsonBody('{"revision":1}x')).toThrow(
      WebBobJsonParseError,
    );
  });
});
