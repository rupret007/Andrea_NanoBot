import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hasHostCodexAuthMaterial,
  resolveHostCodexHome,
  seedCodexHomeFromHost,
} from './codex-home.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('codex-home', () => {
  it('resolves CODEX_HOME when explicitly configured', () => {
    expect(
      resolveHostCodexHome({
        CODEX_HOME: '/tmp/custom-codex-home',
      } as NodeJS.ProcessEnv),
    ).toBe(path.resolve('/tmp/custom-codex-home'));
  });

  it('detects host Codex auth material', () => {
    const profileDir = makeTempDir('andrea-codex-home-');
    const codexHome = path.join(profileDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"ok":true}');

    expect(
      hasHostCodexAuthMaterial({
        USERPROFILE: profileDir,
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('copies host Codex auth files into a group home', () => {
    const profileDir = makeTempDir('andrea-codex-seed-src-');
    const targetDir = makeTempDir('andrea-codex-seed-dst-');
    const codexHome = path.join(profileDir, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"seed"}');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"');

    const copied = seedCodexHomeFromHost(targetDir, {
      USERPROFILE: profileDir,
    } as NodeJS.ProcessEnv);

    expect(copied).toEqual(['auth.json', 'config.toml']);
    expect(
      fs.readFileSync(path.join(targetDir, 'auth.json'), 'utf-8'),
    ).toContain('"seed"');
    expect(
      fs.readFileSync(path.join(targetDir, 'config.toml'), 'utf-8'),
    ).toContain('gpt-5.4');
  });
});
