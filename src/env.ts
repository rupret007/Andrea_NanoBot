import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

function encodeEnvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function upsertEnvFileValues(
  updates: Record<string, string>,
  cwd = process.cwd(),
): void {
  const envFile = path.join(cwd, '.env');
  const content = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf-8')
    : '';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  const nextUpdates = Object.entries(updates).filter(
    ([key, value]) => key.trim() && typeof value === 'string',
  );

  if (nextUpdates.length === 0) {
    return;
  }

  const handled = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;

    const key = match[1];
    const next = nextUpdates.find(([candidate]) => candidate === key);
    if (!next) return line;

    handled.add(key);
    return `${key}=${encodeEnvValue(next[1])}`;
  });

  for (const [key, value] of nextUpdates) {
    if (handled.has(key)) continue;
    nextLines.push(`${key}=${encodeEnvValue(value)}`);
  }

  const output = nextLines.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(envFile, output, 'utf-8');
}
