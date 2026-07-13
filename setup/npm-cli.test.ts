import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildNpmRunInvocation, resolveNpmCliPath } from './npm-cli.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-npm-cli-'));
  tempRoots.push(root);
  return root;
}

function regularFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '// npm test fixture\n');
  return filePath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveNpmCliPath', () => {
  it('builds a shell-free argv invocation from a regular npm_execpath file', () => {
    const root = path.join(tempRoot(), 'workspace & echo %PATH%');
    const nodePath = regularFile(path.join(root, 'node'));
    const npmCli = regularFile(path.join(root, 'npm', 'npm-cli.js'));

    expect(
      buildNpmRunInvocation('build', {
        npmExecPath: npmCli,
        nodePath,
        platform: 'linux',
      }),
    ).toEqual({
      command: nodePath,
      args: [npmCli, 'run', 'build'],
      shell: false,
    });
  });

  it.each(['npm.cmd', 'npm.bat'])(
    'rejects %s and uses the pinned Windows npm CLI',
    (wrapperName) => {
      const root = tempRoot();
      const nodePath = regularFile(path.join(root, 'node.exe'));
      const npmCli = regularFile(
        path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      );
      const wrapper = regularFile(path.join(root, wrapperName));

      expect(
        buildNpmRunInvocation('build', {
          npmExecPath: wrapper,
          nodePath,
          platform: 'win32',
        }),
      ).toEqual({
        command: nodePath,
        args: [npmCli, 'run', 'build'],
        shell: false,
      });
    },
  );

  it('fails closed for wrappers, symlinks, and missing CLI files', () => {
    const root = tempRoot();
    const realCli = regularFile(path.join(root, 'real', 'npm-cli.js'));
    const linkedCli = path.join(root, 'linked', 'npm-cli.js');
    fs.mkdirSync(path.dirname(linkedCli), { recursive: true });
    fs.symlinkSync(realCli, linkedCli);

    expect(() =>
      resolveNpmCliPath({
        npmExecPath: linkedCli,
        nodePath: path.join(root, 'missing', 'node.exe'),
        platform: 'win32',
      }),
    ).toThrow(/regular npm-cli\.js/);
  });

  it('rejects script-name metacharacters', () => {
    expect(() => buildNpmRunInvocation('build && whoami')).toThrow(
      /Invalid npm script name/,
    );
  });
});
