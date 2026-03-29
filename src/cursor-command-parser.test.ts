import { describe, expect, it } from 'vitest';

import {
  parseCursorCreateCommand,
  tokenizeCommandArguments,
} from './cursor-command-parser.js';

describe('tokenizeCommandArguments', () => {
  it('preserves quoted segments', () => {
    const tokens = tokenizeCommandArguments(
      '/cursor_create --model cu/default "Fix flaky tests in auth module"',
    );
    expect(tokens).toEqual([
      '/cursor_create',
      '--model',
      'cu/default',
      'Fix flaky tests in auth module',
    ]);
  });
});

describe('parseCursorCreateCommand', () => {
  it('parses prompt and common string flags', () => {
    const parsed = parseCursorCreateCommand(
      '/cursor_create --model cu/default --repo https://github.com/acme/repo --ref main --branch cursor/fix "Fix race condition in queue"',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.promptText).toBe('Fix race condition in queue');
    expect(parsed.model).toBe('cu/default');
    expect(parsed.sourceRepository).toBe('https://github.com/acme/repo');
    expect(parsed.sourceRef).toBe('main');
    expect(parsed.branchName).toBe('cursor/fix');
  });

  it('supports quoted values for option arguments', () => {
    const parsed = parseCursorCreateCommand(
      '/cursor_create --repo "https://github.com/acme/repo with spaces" --branch "cursor/fix branch" "Ship patch"',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.sourceRepository).toBe(
      'https://github.com/acme/repo with spaces',
    );
    expect(parsed.branchName).toBe('cursor/fix branch');
    expect(parsed.promptText).toBe('Ship patch');
  });

  it('parses boolean flags with and without explicit values', () => {
    const parsed = parseCursorCreateCommand(
      '/cursor_create --auto-pr --cursor-github-app=false --skip-reviewer=true add tests for parser',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.autoCreatePr).toBe(true);
    expect(parsed.openAsCursorGithubApp).toBe(false);
    expect(parsed.skipReviewerRequest).toBe(true);
  });

  it('treats implicit boolean flags as true without eating prompt text', () => {
    const parsed = parseCursorCreateCommand(
      '/cursor_create --auto-pr Fix parser edge case',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.autoCreatePr).toBe(true);
    expect(parsed.promptText).toBe('Fix parser edge case');
  });

  it('supports explicit negative boolean flags', () => {
    const parsed = parseCursorCreateCommand(
      '/cursor_create --auto-pr --no-auto-pr --cursor-github-app --no-cursor-github-app --skip-reviewer --no-skip-reviewer Finish release notes',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.autoCreatePr).toBe(false);
    expect(parsed.openAsCursorGithubApp).toBe(false);
    expect(parsed.skipReviewerRequest).toBe(false);
    expect(parsed.promptText).toBe('Finish release notes');
  });

  it('returns helpful errors for unknown options and missing prompt', () => {
    const parsed = parseCursorCreateCommand('/cursor_create --unknown');

    expect(parsed.promptText).toBe('');
    expect(parsed.errors).toContain('Unknown option --unknown.');
    expect(parsed.errors).toContain('Prompt text is required.');
  });
});
