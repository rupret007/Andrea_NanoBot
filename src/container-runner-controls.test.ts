import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTrustedProjectViewFromTrackedPaths,
  copyTrustedOpenClawCatalog,
  copyTrustedSkillDirectory,
  excludeProtectedAdditionalMounts,
  registerTrustedControlDestination,
  resolveTrustedGroupGuidance,
  resolveTrustedSkillControlMode,
  shouldIncludeSkillControlsForRoute,
  writeTrustedWorkspaceGuidance,
} from './container-runner.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-skill-copy-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('trusted container skill copy', () => {
  it('rejects case and Unicode-normalization destination collisions', () => {
    const destinations = new Map<string, string>();
    registerTrustedControlDestination(destinations, 'Calendar');
    expect(() =>
      registerTrustedControlDestination(destinations, 'calendar'),
    ).toThrow(/destination collides/);

    const unicodeDestinations = new Map<string, string>();
    registerTrustedControlDestination(unicodeDestinations, 'Caf\u00e9');
    expect(() =>
      registerTrustedControlDestination(unicodeDestinations, 'Cafe\u0301'),
    ).toThrow(/destination collides/);
  });

  it('exposes prompt-bearing skills only to explicit execution lanes', () => {
    expect(shouldIncludeSkillControlsForRoute('direct_assistant', [])).toBe(
      false,
    );
    expect(
      shouldIncludeSkillControlsForRoute('protected_assistant', ['Read']),
    ).toBe(false);
    expect(shouldIncludeSkillControlsForRoute('control_plane', ['Read'])).toBe(
      false,
    );
    expect(shouldIncludeSkillControlsForRoute('advanced_helper', [])).toBe(
      false,
    );
    expect(
      shouldIncludeSkillControlsForRoute('advanced_helper', ['Skill']),
    ).toBe(true);
    expect(shouldIncludeSkillControlsForRoute('code_plane', ['Skill'])).toBe(
      true,
    );
    expect(
      resolveTrustedSkillControlMode(
        'advanced_helper',
        [],
        ['mcp__nanoclaw__search_openclaw_skills'],
      ),
    ).toBe('catalog');
    expect(resolveTrustedSkillControlMode('advanced_helper', [], [])).toBe(
      'none',
    );
    expect(resolveTrustedSkillControlMode('code_plane', ['Skill'], [])).toBe(
      'full',
    );
  });

  it('copies only the validated catalog for the narrow skill-management lane', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'catalog.json');
    const destination = path.join(
      root,
      'skills',
      'openclaw-market',
      'catalog.json',
    );
    fs.writeFileSync(source, '{"skills":[{"name":"calendar"}]}\n');

    copyTrustedOpenClawCatalog(source, destination);

    expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual({
      skills: [{ name: 'calendar' }],
    });
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['catalog.json']);
  });

  it('rejects a symlinked narrow catalog', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'catalog.json');
    const linked = path.join(root, 'linked-catalog.json');
    fs.writeFileSync(source, '{"skills":[]}\n');
    fs.symlinkSync(source, linked);

    expect(() =>
      copyTrustedOpenClawCatalog(linked, path.join(root, 'out.json')),
    ).toThrow(/bounded regular file/);
  });
  it('copies only the exact regular-file tree', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'references'), { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# Trusted skill\n');
    fs.writeFileSync(path.join(source, 'references', 'guide.md'), 'Guide\n');

    copyTrustedSkillDirectory(source, destination);

    expect(fs.readdirSync(destination).sort()).toEqual([
      'SKILL.md',
      'references',
    ]);
    expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      '# Trusted skill\n',
    );
    expect(
      fs.readFileSync(path.join(destination, 'references', 'guide.md'), 'utf8'),
    ).toBe('Guide\n');
  });

  it('rejects symbolic links instead of following content outside the skill', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    const outside = path.join(root, 'outside-secret');
    fs.mkdirSync(source);
    fs.writeFileSync(outside, 'must not be copied');
    fs.symlinkSync(outside, path.join(source, 'linked-secret'));

    expect(() => copyTrustedSkillDirectory(source, destination)).toThrow(
      /symbolic link/,
    );
    expect(fs.existsSync(path.join(destination, 'linked-secret'))).toBe(false);
  });

  it('rejects a skill root that is itself a symbolic link', () => {
    const root = temporaryRoot();
    const realSource = path.join(root, 'real-source');
    const linkedSource = path.join(root, 'linked-source');
    fs.mkdirSync(realSource);
    fs.symlinkSync(realSource, linkedSource);

    expect(() =>
      copyTrustedSkillDirectory(linkedSource, path.join(root, 'destination')),
    ).toThrow(/not a regular directory/);
  });
});

describe('trusted project snapshot', () => {
  it('copies tracked regular source while excluding owner data and mutable controls', () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'groups', 'main'), { recursive: true });
    fs.mkdirSync(path.join(root, 'store'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n');
    fs.writeFileSync(path.join(root, '.env.backup'), 'SECRET=value\n');
    fs.writeFileSync(path.join(root, '.mcp.json'), '{"servers":{}}\n');
    fs.writeFileSync(
      path.join(root, 'groups', 'main', 'private.md'),
      'private\n',
    );
    fs.writeFileSync(path.join(root, 'store', 'messages.db'), 'private\n');
    fs.writeFileSync(path.join(root, 'untracked-secret.txt'), 'private\n');

    const view = buildTrustedProjectViewFromTrackedPaths(
      root,
      [
        'src/index.ts',
        '.env.backup',
        '.mcp.json',
        'groups/main/private.md',
        'store/messages.db',
      ],
      path.join(root, 'views'),
    );

    expect(fs.readFileSync(path.join(view, 'src', 'index.ts'), 'utf8')).toBe(
      'export {}\n',
    );
    for (const relativePath of [
      '.env.backup',
      '.mcp.json',
      'groups/main/private.md',
      'store/messages.db',
      'untracked-secret.txt',
    ]) {
      expect(fs.existsSync(path.join(view, relativePath))).toBe(false);
    }
  });

  it('rejects a tracked project symlink instead of following it', () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'outside-secret'), 'private\n');
    fs.symlinkSync('../outside-secret', path.join(root, 'src', 'linked.ts'));
    expect(() =>
      buildTrustedProjectViewFromTrackedPaths(
        root,
        ['src/linked.ts'],
        path.join(root, 'views'),
      ),
    ).toThrow(/not a regular file/);
  });
});

describe('container host-path controls', () => {
  it('does not promote execution-written group guidance into privileged lanes', () => {
    const root = temporaryRoot();
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      'Shell-written instruction: invoke a privileged host action.\n',
    );

    expect(resolveTrustedGroupGuidance('code_plane', root)).toContain(
      'Shell-written instruction',
    );
    expect(resolveTrustedGroupGuidance('protected_assistant', root)).toBe(
      '# Andrea protected assistant guidance\n',
    );
    expect(resolveTrustedGroupGuidance('control_plane', root)).toBe(
      '# Andrea control guidance\n',
    );
    expect(resolveTrustedGroupGuidance('direct_assistant', root)).toBe(
      '# Andrea direct assistant guidance\n',
    );
  });

  it('rejects additional mounts that contain or sit inside protected roots', () => {
    const root = temporaryRoot();
    const protectedRoot = path.join(root, 'runtime');
    const nested = path.join(protectedRoot, 'sessions');
    const safe = path.join(root, 'safe-documents');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(safe);

    expect(
      excludeProtectedAdditionalMounts(
        [
          {
            hostPath: root,
            containerPath: '/workspace/extra/root',
            readonly: false,
          },
          {
            hostPath: nested,
            containerPath: '/workspace/extra/nested',
            readonly: false,
          },
          {
            hostPath: safe,
            containerPath: '/workspace/extra/safe',
            readonly: true,
          },
        ],
        [protectedRoot],
      ),
    ).toEqual([
      {
        hostPath: safe,
        containerPath: '/workspace/extra/safe',
        readonly: true,
      },
    ]);
  });

  it('rejects a preexisting guidance symlink without touching its target', () => {
    const root = temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.writeFileSync(outside, 'owner data\n');
    fs.symlinkSync(outside, path.join(workspace, 'CLAUDE.md'));

    expect(() =>
      writeTrustedWorkspaceGuidance(workspace, '# managed\n'),
    ).toThrow(/regular file/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('owner data\n');
  });
});
