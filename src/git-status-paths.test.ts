import { describe, expect, it } from 'vitest';

import { parseGitDirtyPaths, parseGitStatusPath } from './git-status-paths.js';

describe('git status path parsing', () => {
  it('parses a normal modified path', () => {
    expect(parseGitStatusPath(' M src/index.ts')).toBe('src/index.ts');
  });

  it('recovers if the first-line leading space was stripped', () => {
    expect(parseGitStatusPath('M src/andrea-openai-backend.test.ts')).toBe(
      'src/andrea-openai-backend.test.ts',
    );
  });

  it('keeps the destination path for renames', () => {
    expect(parseGitStatusPath('R  old-name.ts -> new-name.ts')).toBe(
      'new-name.ts',
    );
  });

  it('parses multiple dirty paths without dropping the first path prefix', () => {
    expect(
      parseGitDirtyPaths(
        [' M src/first.ts', ' M src/second.ts', '?? src/new-file.ts'].join(
          '\n',
        ),
      ),
    ).toEqual(['src/first.ts', 'src/second.ts', 'src/new-file.ts']);
  });
});
