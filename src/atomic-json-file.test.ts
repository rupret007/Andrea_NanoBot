import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeJsonFileAtomic } from './atomic-json-file.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-test-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('atomic JSON file writes', () => {
  it('replaces a state file with complete valid JSON', () => {
    const directory = tempDir();
    const filePath = path.join(directory, 'health.json');
    fs.writeFileSync(filePath, '{"old":true}\n');

    writeJsonFileAtomic(filePath, { healthy: true, count: 2 });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      healthy: true,
      count: 2,
    });
    expect(fs.readdirSync(directory)).toEqual(['health.json']);
  });

  it('preserves the last known-good file when the temporary write hits ENOSPC', () => {
    const directory = tempDir();
    const filePath = path.join(directory, 'health.json');
    const original = '{"healthy":true}\n';
    fs.writeFileSync(filePath, original);

    expect(() =>
      writeJsonFileAtomic(
        filePath,
        { healthy: false },
        {
          mkdirSync: fs.mkdirSync,
          writeFileSync: () => {
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          },
          renameSync: fs.renameSync,
          rmSync: fs.rmSync,
        },
      ),
    ).toThrow(/no space/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
    expect(fs.readdirSync(directory)).toEqual(['health.json']);
  });
});
