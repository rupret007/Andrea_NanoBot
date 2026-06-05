/*
 * Best-effort JSON parser for LLM council artifacts.
 *
 * Adapted from garrytan/gbrain src/core/eval-shared/json-repair.ts
 * (MIT, commit f3ade6c0c3e5a1d76d0c29d5b13e61286442d923).
 * Copyright (c) 2026 Garry Tan.
 */

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/i;

export type CouncilJsonParseStatus = 'valid' | 'repaired';

export interface CouncilJsonParseResult {
  data: unknown;
  status: CouncilJsonParseStatus;
}

export function parseCouncilJson(raw: string): unknown {
  return parseCouncilJsonWithStatus(raw).data;
}

export function parseCouncilJsonWithStatus(
  raw: string,
): CouncilJsonParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('parseCouncilJson: empty input');
  }

  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct !== null) return { data: direct, status: 'valid' };

  const cleaned = stripFences(trimmed).trim();
  const fenced = tryParse(cleaned);
  if (fenced !== null) return { data: fenced, status: 'repaired' };

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('parseCouncilJson: no object found');
  }

  const objectText = match[0];
  const extracted = tryParse(objectText);
  if (extracted !== null) return { data: extracted, status: 'repaired' };

  const repaired = tryParse(repairJson(objectText));
  if (repaired !== null) return { data: repaired, status: 'repaired' };

  throw new Error('parseCouncilJson: all strategies failed');
}

function stripFences(value: string): string {
  const match = value.match(FENCE_RE);
  return match ? match[1]! : value;
}

function tryParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function repairJson(value: string): string {
  return value
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/(?<=[:{,\[]\s*)'([^']*?)'(?=\s*[,}\]:])/g, '"$1"')
    .replace(/("(?:[^"\\]|\\.)*?)\n((?:[^"\\]|\\.)*?")/g, '$1\\n$2');
}
