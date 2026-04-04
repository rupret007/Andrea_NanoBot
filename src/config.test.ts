import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config assistant identity', () => {
  let previousCwd = '';
  let previousEnv: NodeJS.ProcessEnv = {};
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    previousEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-config-'));
    process.chdir(tempDir);
    delete process.env.ASSISTANT_NAME;
  });

  afterEach(() => {
    vi.resetModules();
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('defaults to Andrea when no env source is present', async () => {
    const config = await import('./config.js');

    expect(config.ASSISTANT_NAME).toBe('Andrea');
    expect(config.ASSISTANT_NAME_SOURCE).toBe('default');
    expect(config.DEFAULT_TRIGGER).toBe('@Andrea');
    expect(config.TRIGGER_PATTERN.test('@Andrea hello')).toBe(true);
  });

  it('uses .env assistant identity and marks the source as env', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'ASSISTANT_NAME=Andrea\n',
      'utf8',
    );

    const config = await import('./config.js');

    expect(config.ASSISTANT_NAME).toBe('Andrea');
    expect(config.ASSISTANT_NAME_SOURCE).toBe('env');
    expect(config.DEFAULT_TRIGGER).toBe('@Andrea');
  });

  it('prefers process env over .env when both are present', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'ASSISTANT_NAME=Andrea\n',
      'utf8',
    );
    process.env.ASSISTANT_NAME = 'OperatorAndrea';

    const config = await import('./config.js');

    expect(config.ASSISTANT_NAME).toBe('OperatorAndrea');
    expect(config.ASSISTANT_NAME_SOURCE).toBe('env');
    expect(config.DEFAULT_TRIGGER).toBe('@OperatorAndrea');
  });
});
