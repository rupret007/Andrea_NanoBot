export class WebBobJsonParseError extends Error {
  constructor(message = 'Invalid JSON.') {
    super(message);
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function parseWebBobJsonBody(text: string): Record<string, unknown> {
  const parsed = parseJsonValue(text, 0);
  const index = skipWs(text, parsed.index);
  if (index !== text.length) throw new WebBobJsonParseError();
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WebBobJsonParseError();
  }
  return value as Record<string, unknown>;
}

function parseJsonValue(
  text: string,
  index: number,
): { value: JsonValue; index: number } {
  index = skipWs(text, index);
  if (index >= text.length) throw new WebBobJsonParseError();
  const char = text[index];
  if (char === '{') return parseObject(text, index);
  if (char === '[') return parseArray(text, index);
  if (char === '"') return parseString(text, index);
  if (char === 't') return parseLiteral(text, index, 'true', true);
  if (char === 'f') return parseLiteral(text, index, 'false', false);
  if (char === 'n') return parseLiteral(text, index, 'null', null);
  if (char === '-' || (char >= '0' && char <= '9'))
    return parseNumber(text, index);
  throw new WebBobJsonParseError();
}

function parseObject(
  text: string,
  index: number,
): { value: JsonValue; index: number } {
  index = skipWs(text, index + 1);
  const object: Record<string, JsonValue> = Object.create(null);
  const keys = new Set<string>();
  if (text[index] === '}') return { value: object, index: index + 1 };
  while (true) {
    index = skipWs(text, index);
    const key = parseString(text, index);
    index = key.index;
    if (
      key.value === '__proto__' ||
      key.value === 'constructor' ||
      key.value === 'prototype' ||
      keys.has(key.value)
    ) {
      throw new WebBobJsonParseError();
    }
    keys.add(key.value);
    index = skipWs(text, index);
    if (text[index] !== ':') throw new WebBobJsonParseError();
    const valueStart = skipWs(text, index + 1);
    const value = parseJsonValue(text, valueStart);
    // Validate the wire spelling before Number erases fractions/exponents.
    if (
      key.value === 'revision' &&
      typeof value.value === 'number' &&
      !/^-?(?:0|[1-9][0-9]*)$/.test(text.slice(valueStart, value.index))
    ) {
      throw new WebBobJsonParseError();
    }
    object[key.value] = value.value;
    index = skipWs(text, value.index);
    if (text[index] === '}') return { value: object, index: index + 1 };
    if (text[index] !== ',') throw new WebBobJsonParseError();
    index += 1;
  }
}

function parseArray(
  text: string,
  index: number,
): { value: JsonValue; index: number } {
  index = skipWs(text, index + 1);
  const array: JsonValue[] = [];
  if (text[index] === ']') return { value: array, index: index + 1 };
  while (true) {
    const value = parseJsonValue(text, index);
    array.push(value.value);
    index = skipWs(text, value.index);
    if (text[index] === ']') return { value: array, index: index + 1 };
    if (text[index] !== ',') throw new WebBobJsonParseError();
    index += 1;
  }
}

function parseString(
  text: string,
  index: number,
): { value: string; index: number } {
  if (text[index] !== '"') throw new WebBobJsonParseError();
  let result = '';
  index += 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') return { value: result, index: index + 1 };
    if (char === '\\') {
      index += 1;
      const escaped = text[index];
      if (escaped === '"' || escaped === '\\' || escaped === '/') {
        result += escaped;
      } else if (escaped === 'b') result += '\b';
      else if (escaped === 'f') result += '\f';
      else if (escaped === 'n') result += '\n';
      else if (escaped === 'r') result += '\r';
      else if (escaped === 't') result += '\t';
      else if (escaped === 'u') {
        const hex = text.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new WebBobJsonParseError();
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      } else {
        throw new WebBobJsonParseError();
      }
      index += 1;
      continue;
    }
    if (char < '\u0020') throw new WebBobJsonParseError();
    result += char;
    index += 1;
  }
  throw new WebBobJsonParseError();
}

function parseNumber(
  text: string,
  index: number,
): { value: JsonValue; index: number } {
  const start = index;
  if (text[index] === '-') index += 1;
  if (text[index] === '0') index += 1;
  else {
    if (text[index] < '1' || text[index] > '9') {
      throw new WebBobJsonParseError();
    }
    while (text[index] >= '0' && text[index] <= '9') index += 1;
  }
  if (text[index] === '.') {
    index += 1;
    if (text[index] < '0' || text[index] > '9') {
      throw new WebBobJsonParseError();
    }
    while (text[index] >= '0' && text[index] <= '9') index += 1;
  }
  if (text[index] === 'e' || text[index] === 'E') {
    index += 1;
    if (text[index] === '+' || text[index] === '-') index += 1;
    if (text[index] < '0' || text[index] > '9') {
      throw new WebBobJsonParseError();
    }
    while (text[index] >= '0' && text[index] <= '9') index += 1;
  }
  const value = Number(text.slice(start, index));
  if (!Number.isFinite(value)) throw new WebBobJsonParseError();
  return { value, index };
}

function parseLiteral(
  text: string,
  index: number,
  literal: string,
  value: JsonValue,
): { value: JsonValue; index: number } {
  if (!text.startsWith(literal, index)) {
    throw new WebBobJsonParseError();
  }
  return { value, index: index + literal.length };
}

function skipWs(text: string, index: number): number {
  while (
    text[index] === ' ' ||
    text[index] === '\t' ||
    text[index] === '\r' ||
    text[index] === '\n'
  ) {
    index += 1;
  }
  return index;
}
