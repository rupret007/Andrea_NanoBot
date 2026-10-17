import { describe, expect, it } from 'vitest';

import { parseWebBobJsonBody, WebBobJsonParseError } from './web-bob-json.js';

describe('Web Bob JSON ingress', () => {
  it('rejects duplicate object keys before schema validation', () => {
    expect(() =>
      parseWebBobJsonBody('{"bridgeDraftId":"a","bridgeDraftId":"b"}'),
    ).toThrow(WebBobJsonParseError);
    expect(() =>
      parseWebBobJsonBody('{"revision":1,"revi\\u0073ion":2}'),
    ).toThrow(WebBobJsonParseError);
  });

  it('parses a single object without trailing content', () => {
    expect(parseWebBobJsonBody('{"revision":1}')).toEqual({ revision: 1 });
    expect(() => parseWebBobJsonBody('{"revision":1}x')).toThrow(
      WebBobJsonParseError,
    );
  });

  it.each([
    '__proto__',
    'constructor',
    'prototype',
    '\\u005f_proto__',
    'constr\\u0075ctor',
    'proto\\u0074ype',
  ])('rejects the decoded dangerous key %s at every nesting level', (key) => {
    for (const body of [
      `{"${key}":{"text":"proto text"}}`,
      `{"nested":{"${key}":{"requestDigest":"injected"}}}`,
      `{"array":[{"${key}":null}]}`,
    ]) {
      expect(() => parseWebBobJsonBody(body)).toThrow(WebBobJsonParseError);
    }
  });

  it('builds every object with no inherited properties', () => {
    const parsed = parseWebBobJsonBody(
      '{"nested":{"value":1},"array":[{"value":2}],"toString":"own value"}',
    );
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.nested)).toBeNull();
    expect(Object.getPrototypeOf((parsed.array as unknown[])[0])).toBeNull();
    expect(Object.hasOwn(parsed, 'toString')).toBe(true);
    expect(parsed.toString).toBe('own value');
    expect('valueOf' in parsed).toBe(false);
  });

  it('accepts only JSON whitespace around tokens', () => {
    expect(
      parseWebBobJsonBody(' \t\r\n{ \t\r\n"revision" \t:\r\n1 \t\r\n} \t\r\n'),
    ).toEqual({ revision: 1 });
  });

  it.each(['\u00a0', '\u2028', '\u2029', '\ufeff', '\v', '\f'])(
    'rejects non-JSON whitespace %j outside strings',
    (whitespace) => {
      for (const body of [
        `${whitespace}{"revision":1}`,
        `{${whitespace}"revision":1}`,
        `{"revision"${whitespace}:1}`,
        `{"revision":${whitespace}1}`,
        `{"revision":1${whitespace}}`,
        `{"revision":1,${whitespace}"text":"valid"}`,
        `{"addresses":[${whitespace}"recipient"]}`,
        `{"addresses":["recipient"${whitespace}]}`,
        `{"revision":1}${whitespace}`,
      ]) {
        expect(() => parseWebBobJsonBody(body)).toThrow(WebBobJsonParseError);
      }
    },
  );

  it('preserves Unicode whitespace and dangerous names inside string values', () => {
    const text = '\u00a0\u2028\u2029\ufeff __proto__ constructor prototype';
    expect(parseWebBobJsonBody(JSON.stringify({ text }))).toEqual({ text });
    expect(
      parseWebBobJsonBody('{"text":"\\u00a0\\u2028\\u2029\\ufeff"}'),
    ).toEqual({ text: '\u00a0\u2028\u2029\ufeff' });
  });

  it.each(['1.0', '1.00', '1e0', '1E0', '1e+0', '1E-0', '10e-1', '0.1e1'])(
    'rejects revision number %s even when it evaluates to an integer',
    (revision) => {
      for (const body of [
        `{"revision":${revision}}`,
        `{"revi\\u0073ion": ${revision}}`,
        `{"requestScope":{"revision":${revision}}}`,
        `{"array":[{"revision":${revision}}]}`,
      ]) {
        expect(() => parseWebBobJsonBody(body)).toThrow(WebBobJsonParseError);
      }
    },
  );

  it.each([1, 2, 10, Number.MAX_SAFE_INTEGER])(
    'accepts integer revision %s',
    (revision) => {
      expect(parseWebBobJsonBody(`{"revision": ${revision} }`)).toEqual({
        revision,
      });
    },
  );

  it('still parses ordinary JSON numbers without revision semantics', () => {
    expect(parseWebBobJsonBody('{"fraction":1.5,"exponent":1e2}')).toEqual({
      fraction: 1.5,
      exponent: 100,
    });
  });

  it.each([
    '-',
    '+1',
    '.1',
    '01',
    '-01',
    '1.',
    '1.e0',
    '1e',
    '1e+',
    '1e-',
    '--1',
    '0x1',
    '1e999',
  ])('rejects malformed or nonfinite number %s', (number) => {
    expect(() => parseWebBobJsonBody(`{"value":${number}}`)).toThrow(
      WebBobJsonParseError,
    );
    expect(() => parseWebBobJsonBody(`{"value":${number}`)).toThrow(
      WebBobJsonParseError,
    );
  });
});
