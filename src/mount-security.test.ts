import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isDirectoryMountSource,
  isValidContainerPath,
  isValidHostMountPath,
  parseMountAllowlist,
} from './mount-security.js';

describe('additional mount destination validation', () => {
  it('accepts only simple relative POSIX path segments', () => {
    expect(isValidContainerPath('project')).toBe(true);
    expect(isValidContainerPath('projects/repo-1')).toBe(true);
    expect(isValidContainerPath('.hidden')).toBe(true);
    expect(isValidContainerPath('../escape')).toBe(false);
    expect(isValidContainerPath('/absolute')).toBe(false);
    expect(isValidContainerPath('safe,source=/Users')).toBe(false);
    expect(isValidContainerPath('safe=target')).toBe(false);
    expect(isValidContainerPath('safe:rw')).toBe(false);
    expect(isValidContainerPath('safe\\windows')).toBe(false);
    expect(isValidContainerPath('safe\nnext')).toBe(false);
  });
});

describe('additional mount source validation', () => {
  it('rejects Docker/Podman mount-option injection syntax', () => {
    expect(isValidHostMountPath('/Users/owner/My Project')).toBe(true);
    expect(isValidHostMountPath('/allowed,source=/Users/owner/.codex')).toBe(
      false,
    );
    expect(isValidHostMountPath('/allowed\nnext')).toBe(false);
    expect(isValidHostMountPath('/allowed\0next')).toBe(false);
    expect(isValidHostMountPath('')).toBe(false);
  });

  it('accepts directories and rejects regular files or missing paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-mount-type-'));
    const regularFile = path.join(root, 'runtime.sock');
    fs.writeFileSync(regularFile, 'not a directory');
    try {
      expect(isDirectoryMountSource(root)).toBe(true);
      expect(isDirectoryMountSource(regularFile)).toBe(false);
      expect(isDirectoryMountSource(path.join(root, 'missing'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mount allowlist authority validation', () => {
  it('accepts exact typed roots and patterns without coercion', () => {
    expect(
      parseMountAllowlist({
        allowedRoots: [
          {
            path: '/allowed',
            allowReadWrite: false,
            description: 'read-only source',
          },
        ],
        blockedPatterns: ['.env'],
        nonMainReadOnly: true,
      }),
    ).toEqual({
      allowedRoots: [
        {
          path: '/allowed',
          allowReadWrite: false,
          description: 'read-only source',
        },
      ],
      blockedPatterns: ['.env'],
      nonMainReadOnly: true,
    });
  });

  it('rejects string booleans and malformed entries', () => {
    for (const candidate of [
      {
        allowedRoots: [{ path: '/allowed', allowReadWrite: 'false' }],
        blockedPatterns: ['.env'],
        nonMainReadOnly: true,
      },
      {
        allowedRoots: [{ path: '', allowReadWrite: false }],
        blockedPatterns: ['.env'],
        nonMainReadOnly: true,
      },
      {
        allowedRoots: [{ path: '/allowed', allowReadWrite: false }],
        blockedPatterns: [7],
        nonMainReadOnly: true,
      },
      {
        allowedRoots: [{ path: '/allowed', allowReadWrite: false }],
        blockedPatterns: ['.env'],
        nonMainReadOnly: 'true',
      },
    ]) {
      expect(() => parseMountAllowlist(candidate)).toThrow();
    }
  });
});
